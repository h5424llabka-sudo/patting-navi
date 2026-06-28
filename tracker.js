/**
 * PuttTracker v4 - Web Worker Architecture
 *
 * メインスレッド担当: カメラ取得・描画のみ
 * Worker担当: 背景差分・グリッド探索（重いピクセル計算）
 */
class PuttTracker {
    constructor(canvas, onStatusUpdate) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.onStatusUpdate = onStatusUpdate;

        // Physics
        this.BALL_DIAMETER_CM = 4.267;
        this.stimpValue  = 9.0;
        this.pixelsPerCm = 10;

        // Work canvas – much smaller for getImageData speed
        this.WORK_W = 240;  // fixed width (will scale height proportionally)
        this.WORK_H = 135;
        this.workScale = 1; // actual canvas→work scale factor (set on first frame)
        this.offCanvas = document.createElement('canvas');
        this.offCanvas.width  = this.WORK_W;
        this.offCanvas.height = this.WORK_H;
        this.offCtx = this.offCanvas.getContext('2d', { willReadFrequently: true });

        // Web Worker
        this.worker = new Worker('tracker-worker.js');
        this.workerBusy = false;
        this.worker.onmessage = (e) => this._onWorkerMessage(e.data);

        // User tunable parameters
        this.diffThreshold    = 60;
        this.minBallRadius    = 15;
        this.maxBallRadius    = 80;
        this.colorTolerance   = 180;
        this.maxTrackTime     = 1500;
        this.motionMultiplier = 1.5;
        this.ignoreShadows    = true;

        // Debug
        this.debugCtx    = null;
        this.debugCanvas = null;
        this.fpsHistory  = [];
        this.lastFpsTime = 0;
        this.currentFps  = 0;

        // State
        this.state      = 'IDLE';
        this.stateTimer = 0;
        this.isTracking = false;
        this.frameId    = null;
        this.videoElement = null;

        // Ball
        this.ballCenter      = null;
        this.ballRadius      = 15;
        this.ballColor       = null;
        this.stationaryFrames = 0;
        this.noisyFrames     = 0;
        this.prevCenter      = null;
        this.searchRadius    = 0;
        this.motionThreshold = 0;

        // Tracking
        this.positions     = [];
        this.timestamps    = [];
        this.lostFrames    = 0;
        this.trackStartTime = 0;
        this.MAX_LOST      = 8;

        // Velocity prediction (pixels/ms)
        this.velX      = 0;
        this.velY      = 0;
        this.lastTickTime = 0;

        // Frame capture for visualization
        this.capturedFrames = []; // { canvas, bx, by, br, speed, frameIdx }
        this.THUMB_W = 160;
        this.THUMB_H = 90;

        // Pending detect result from worker
        this._pendingResult = null;
    }

    // ─── Public API ────────────────────────────────────────────
    init(videoElement, stimpValue) {
        this.videoElement = videoElement;
        this.stimpValue   = stimpValue;
        this.resetToLearning();
    }

    resetToLearning() {
        this.state            = 'LEARNING_BG';
        this.ballCenter       = null;
        this.prevCenter       = null;
        this.stationaryFrames = 0;
        this.noisyFrames      = 0;
        this.positions        = [];
        this.timestamps       = [];
        this.lostFrames       = 0;
        this.capturedFrames   = [];
        this.velX             = 0;
        this.velY             = 0;
        this.worker.postMessage({ type: 'reset_bg' });
        this.onStatusUpdate('背景を記録中... カメラを固定してください', '--', '--', '#facc15');
    }

    resetToWaitingBall() {
        this.state            = 'WAITING_BALL';
        this.ballCenter       = null;
        this.prevCenter       = null;
        this.stationaryFrames = 0;
        this.noisyFrames      = 0;
        this.positions        = [];
        this.timestamps       = [];
        this.capturedFrames   = [];
        this.lostFrames       = 0;
        this.trackStartTime   = 0;
        this._pendingResult   = null;
        this.velX             = 0;
        this.velY             = 0;
        this.onStatusUpdate('次のボールをカメラの前に置いてください', '--', '--', '#facc15');
    }

    startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;
        this.resetToLearning();
        this._tick();
    }

    stopTracking() {
        this.isTracking = false;
        if (this.frameId) cancelAnimationFrame(this.frameId);
        this.worker.terminate();
    }

    _syncWorkerParams() {
        this.worker.postMessage({
            type: 'params',
            data: {
                workW: this.WORK_W,
                workH: this.WORK_H,
                diffThreshold:   this.diffThreshold,
                GRID_COLS: 10, GRID_ROWS: 6,
                MIN_CELL_PX:     15,
                MAX_GLOBAL_RATIO: 0.25,
                minBallRadius:   this.minBallRadius,
                maxBallRadius:   this.maxBallRadius,
                colorTolerance:  this.colorTolerance,
                ignoreShadows:   this.ignoreShadows,
            }
        });
    }

    // ─── Worker Message Handler ─────────────────────────────────
    _onWorkerMessage(msg) {
        this.workerBusy = false;

        if (msg.type === 'bg_progress') {
            this._bgPct = msg.pct;
            return;
        }

        if (msg.type === 'bg_done') {
            this.state      = 'STABILIZING';
            this.stateTimer = performance.now();
            this.onStatusUpdate('カメラが安定するまで待機中...', '--', '--', '#facc15');
            return;
        }

        if (msg.type === 'detect_result') {
            this._pendingResult = msg.result;

            // If debug mode, render debug pixels
            if (this.debugCtx && msg.result?.debugPixels) {
                const W = this.WORK_W, H = this.WORK_H;
                if (this.debugCanvas.width !== W) {
                    this.debugCanvas.width = W;
                    this.debugCanvas.height = H;
                }
                const img = new ImageData(msg.result.debugPixels, W, H);
                this.debugCtx.putImageData(img, 0, 0);
            }
        }
    }

    // ─── Main Loop ─────────────────────────────────────────────
    _tick() {
        if (!this.isTracking) return;

        const now = performance.now();
        if (this.lastFpsTime) {
            const dt = now - this.lastFpsTime;
            if (dt > 0) {
                this.fpsHistory.push(1000 / dt);
                if (this.fpsHistory.length > 60) this.fpsHistory.shift();
                this.currentFps = this.fpsHistory.reduce((a, b) => a + b) / this.fpsHistory.length;
            }
        }
        this.lastFpsTime = now;

        if (this.videoElement?.videoWidth > 0) {
            // Resize canvas to match video once
            if (this.canvas.width !== this.videoElement.videoWidth) {
                this.canvas.width  = this.videoElement.videoWidth;
                this.canvas.height = this.videoElement.videoHeight;
                // Adjust work height to preserve aspect ratio
                this.WORK_H = Math.round(this.WORK_W * this.canvas.height / this.canvas.width);
                this.offCanvas.height = this.WORK_H;
                this.workScale = this.WORK_W / this.canvas.width;
                this._syncWorkerParams();
                this.worker.postMessage({ type: 'reset_bg' });
            }

            // Draw full-res video to display canvas
            this.ctx.drawImage(this.videoElement, 0, 0, this.canvas.width, this.canvas.height);

            // Dispatch heavy work to worker (only if worker is free)
            if (!this.workerBusy) {
                this.offCtx.drawImage(this.videoElement, 0, 0, this.WORK_W, this.WORK_H);
                const frame = this.offCtx.getImageData(0, 0, this.WORK_W, this.WORK_H);
                this._dispatchToWorker(frame.data);
            }

            // Draw / state machine runs every frame using cached worker result
            this._update(now);
        }

        this.frameId = requestAnimationFrame(() => this._tick());
    }

    _dispatchToWorker(pixels) {
        this.workerBusy = true;
        const state = this.state;

        if (state === 'LEARNING_BG') {
            this.worker.postMessage({ type: 'learn_bg', data: { pixels } }, [pixels.buffer]);
            return;
        }

        if (state === 'WAITING_BALL') {
            this.worker.postMessage({
                type: 'detect',
                data: { pixels, roiCx: -1, roiCy: -1, roiR: -1, targetColor: null, debugMode: !!this.debugCtx, updateBg: true }
            }, [pixels.buffer]);
            return;
        }

        if (state === 'READY' || state === 'TRACKING') {
            // 速度予測：「現在位置 + 速度 × 経過時間」で次フレームのボール位置を予測
            // Workerは非同期なので、結果が戻るころにはボールは先に進んでいる。予測位置をROI中心にする
            const sinceLastDetect = this.positions.length >= 2
                ? (performance.now() - this.timestamps[this.timestamps.length - 1])
                : 0;
            const predX = this.ballCenter.x + this.velX * sinceLastDetect;
            const predY = this.ballCenter.y + this.velY * sinceLastDetect;

            const wpx = predX * this.workScale;
            const wpy = predY * this.workScale;

            // TRACKING中は予測位置を中心に、パターを包含しない突っ込んだROI
            // READY中はボールを囲む小さいROI
            const roiMult = state === 'TRACKING' ? 4.0 : 1.2;
            const wR = this.ballRadius * this.workScale * roiMult;

            // Y軸ロック: 予測位置を中心に紭わせる（予測位置もROIの中に入る）
            const baselineY = state === 'TRACKING' && this.baselineY != null
                ? predY * this.workScale  // 予測位置のYを使う
                : -1;

            this.worker.postMessage({
                type: 'detect',
                data: {
                    pixels, roiCx: wpx, roiCy: wpy, roiR: wR,
                    targetColor: this.ballColor,
                    debugMode: !!this.debugCtx,
                    isTracking: state === 'TRACKING',
                    baselineY,
                    maxX: -1  // maxX制約は廃止。予測位置中心のROIでパターを自然に除外
                }
            }, [pixels.buffer]);
            return;
        }

        this.workerBusy = false;
    }

    // ─── State Machine (runs every rAF, uses cached worker result) ─
    _update(now) {
        switch (this.state) {
            case 'LEARNING_BG':   this._drawBGProgress(); break;
            case 'STABILIZING':   this._stepStabilize(now); break;
            case 'WAITING_BALL':  this._stepWaitBall(now); break;
            case 'READY':         this._stepWaitPutt(now); break;
            case 'TRACKING':      this._stepTrack(now);    break;
            case 'RESULT':
                // 結果表示中も軌跡を描画し続ける
                this._drawTrail();
                this._drawHUD(`完了 | ${this.positions.length}コマ記録`);
                if (now - this.stateTimer > 5000) this.resetToWaitingBall();
                break;
        }
    }

    // ─── Phase 1: Background Learning ──────────────────────────
    _drawBGProgress() {
        const pct = this._bgPct || 0;
        const cw = this.canvas.width, ch = this.canvas.height;
        const bw = cw * 0.6, bh = Math.max(12, ch * 0.015);
        const bx = (cw - bw) / 2, by = ch * 0.88;
        this.ctx.fillStyle = 'rgba(0,0,0,0.5)';
        this.ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        this.ctx.fillStyle = '#10b981';
        this.ctx.fillRect(bx, by, bw * pct, bh);
        this._drawHUD(`背景学習中 ${Math.floor(pct*100)}%`);
        this.onStatusUpdate(`背景を記録中... ${Math.floor(pct*100)}%`, '--', '--', '#facc15');
    }

    // ─── Phase 1.5: Camera Stabilization ───────────────────────
    _stepStabilize(now) {
        if (now - this.stateTimer > 1200) {
            this.state = 'WAITING_BALL';
            this._syncWorkerParams();
            this.onStatusUpdate('ボールをカメラの前に置いてください', '--', '--', '#facc15');
        }
    }

    // ─── Phase 2: Detect Placed Ball ───────────────────────────
    _stepWaitBall(now) {
        const res = this._pendingResult;
        if (!res) return;

        const S = 1 / this.workScale;
        this._drawHUD(`FG: ${res.globalCnt} | thr: ${this.diffThreshold} | noisy: ${res.tooNoisy}`);

        if (res.tooNoisy) {
            this.stationaryFrames = 0;
            this.noisyFrames++;
            this.onStatusUpdate('ノイズ過多 / カメラ調整中...', '--', '--', '#ef4444');
            if (this.noisyFrames > 30) this.resetToLearning(); // 120 -> 30に短縮してすぐ復帰させる
            return;
        }
        this.noisyFrames = 0;

        if (res.blobCnt > 0 && res.blobCx >= 0) {
            const gx = res.blobCx * S, gy = res.blobCy * S;
            const rGlobal = Math.max(Math.sqrt(res.blobCnt / Math.PI) * S, 8);

            if (rGlobal < this.minBallRadius) {
                this.stationaryFrames = Math.max(0, this.stationaryFrames - 1);
                this.onStatusUpdate(`小さすぎます (${Math.round(rGlobal)}px)`, '--', '--', '#facc15');
                return;
            }
            if (rGlobal > this.maxBallRadius) {
                this.stationaryFrames = Math.max(0, this.stationaryFrames - 1);
                this.onStatusUpdate(`大きすぎます (${Math.round(rGlobal)}px) 手をどけて`, '--', '--', '#ef4444');
                return;
            }

            this.drawTarget(gx, gy, rGlobal, '#facc15');

            if (this.prevCenter) {
                const moved = Math.hypot(gx - this.prevCenter.x, gy - this.prevCenter.y);
                if (moved < rGlobal * 0.8) this.stationaryFrames++;
                else this.stationaryFrames = Math.max(0, this.stationaryFrames - 2);
            }
            this.prevCenter = { x: gx, y: gy };
            this.ballRadius = rGlobal;

            const NEEDED = 20; // 20フレーム静止でOK（30→20に短縮）
            if (this.stationaryFrames >= NEEDED) {
                this.ballCenter      = { x: gx, y: gy };
                this.baselineY       = gy; // パット中のY軸ロック用
                this.pixelsPerCm     = (rGlobal * 2) / this.BALL_DIAMETER_CM;
                this.searchRadius    = Math.max(rGlobal * 7, 60);
                this.motionThreshold = Math.max(rGlobal * this.motionMultiplier, 8);
                this.ballColor       = this._sampleColor(res.blobCx, res.blobCy);
                this.state = 'READY';
                this._pendingResult = null;
                this.onStatusUpdate('✅ ボール認識！ パットしてください', '--', '--', '#22c55e');
            } else {
                const pct = Math.floor((this.stationaryFrames / NEEDED) * 100);
                this.onStatusUpdate(`ボールを確認中... ${pct}%`, '--', '--', '#facc15');
            }
        } else {
            this.stationaryFrames = Math.max(0, this.stationaryFrames - 1);
            this.onStatusUpdate('ボールをカメラの前に置いてください', '--', '--', '#facc15');
        }
    }

    _sampleColor(blobCxWork, blobCyWork) {
        // Sample the ball color from the small work canvas
        const sx = Math.max(0, Math.floor(blobCxWork - 2));
        const ex = Math.min(this.WORK_W - 1, Math.floor(blobCxWork + 2));
        const sy = Math.max(0, Math.floor(blobCyWork - 2));
        const ey = Math.min(this.WORK_H - 1, Math.floor(blobCyWork + 2));
        const imgData = this.offCtx.getImageData(sx, sy, ex-sx+1, ey-sy+1);
        const d = imgData.data;
        let r=0,g=0,b=0,n=0;
        for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];n++;}
        return n>0 ? {r:r/n, g:g/n, b:b/n} : null;
    }

    // ─── Phase 3: Wait for Putt ────────────────────────────────
    _stepWaitPutt(now) {
        if (!this.ballCenter) { this.state = 'WAITING_BALL'; return; }

        this.drawTarget(this.ballCenter.x, this.ballCenter.y, this.ballRadius, '#22c55e');
        this._drawHUD(`READY | thr: ${this.motionThreshold.toFixed(0)} | R: ${Math.round(this.searchRadius)}px`);

        const res = this._pendingResult;
        if (!res || res.blobCx < 0) return;

        const S = 1 / this.workScale;
        const gx = res.blobCx * S, gy = res.blobCy * S;
        const moved = Math.hypot(gx - this.ballCenter.x, gy - this.ballCenter.y);

        if (moved > this.motionThreshold) {
            this.state = 'TRACKING';
            this.positions   = [{ ...this.ballCenter }];
            this.timestamps  = [now];
            this.trackStartTime = now;
            this.lostFrames  = 0;
            this._pendingResult = null;
            this.onStatusUpdate('⚡ 計測中...', '--', '--', '#3b82f6');
        }
    }

    // ─── Phase 4: Track Rolling Ball ───────────────────────────
    _stepTrack(now) {
        if (!this.ballCenter) { this._finalizeResult(); return; }

        this._drawHUD(`TRACKING | ${((now - this.trackStartTime)/1000).toFixed(2)}s`);

        // Draw all recorded positions as a trail
        this._drawTrail();

        const res = this._pendingResult;
        if (res && res.blobCx >= 0) {
            this._pendingResult = null;
            const S = 1 / this.workScale;
            const gx = res.blobCx * S, gy = res.blobCy * S;
            const rGlobal = Math.sqrt(res.blobCnt / Math.PI) * S;
            const maxExpectedR = this.ballRadius * 2.5;

            if (rGlobal >= this.minBallRadius && rGlobal < maxExpectedR) {
                // --- Velocity update (exponential moving average) ---
                const prevLen = this.positions.length;
                let frameSpeed = 0;
                if (prevLen >= 1) {
                    const pp  = this.positions[prevLen - 1];
                    const dt  = (now - this.timestamps[prevLen - 1]) / 1000;
                    if (dt > 0 && dt < 0.2) { // ignore stale results
                        const rawVx = (gx - pp.x) / (dt * 1000); // px/ms
                        const rawVy = (gy - pp.y) / (dt * 1000);
                        // EMA: blend toward new measurement
                        const alpha = 0.6;
                        this.velX = this.velX * (1 - alpha) + rawVx * alpha;
                        this.velY = this.velY * (1 - alpha) + rawVy * alpha;
                        frameSpeed = (Math.hypot(gx - pp.x, gy - pp.y) / this.pixelsPerCm / 100) / dt;
                    }
                }

                this.ballCenter = { x: gx, y: gy };
                this.positions.push({ x: gx, y: gy });
                this.timestamps.push(now);
                this.lostFrames = 0;
                this.searchRadius = Math.max(this.searchRadius, rGlobal * 6);

                // Capture thumbnail of this frame (max 12 frames total)
                if (this.capturedFrames.length < 12) {
                    this._captureThumb(gx, gy, rGlobal, frameSpeed, this.positions.length - 1);
                }
            } else {
                this.lostFrames++;
            }

            this.drawTarget(gx, gy, this.ballRadius, '#3b82f6');

            const m = 30;
            const oob = gx < m || gy < m ||
                        gx > this.canvas.width - m || gy > this.canvas.height - m;
            if (oob) { this._finalizeResult(); return; }
        } else if (res) {
            this._pendingResult = null;
            this.lostFrames++;
        }

        if (this.lostFrames > this.MAX_LOST || now - this.trackStartTime > this.maxTrackTime) {
            this._finalizeResult();
        }
    }

    // ─── Capture Thumbnail ─────────────────────────────────────
    _captureThumb(bx, by, br, speed, frameIdx) {
        // Create a small canvas snapshot of the current full-res canvas
        const TW = this.THUMB_W, TH = this.THUMB_H;
        const thumb = document.createElement('canvas');
        thumb.width  = TW;
        thumb.height = TH;
        const tc = thumb.getContext('2d');

        // Crop around the ball with padding, then scale to thumbnail size
        const pad  = Math.max(br * 4, 80);
        const srcX = Math.max(0, bx - pad);
        const srcY = Math.max(0, by - pad);
        const srcW = Math.min(this.canvas.width  - srcX, pad * 2);
        const srcH = Math.min(this.canvas.height - srcY, pad * 2);

        tc.drawImage(this.canvas, srcX, srcY, srcW, srcH, 0, 0, TW, TH);

        // Scale factor from source crop to thumbnail
        const sx = TW / srcW;
        const sy = TH / srcH;
        const tx = (bx - srcX) * sx;
        const ty = (by - srcY) * sy;
        const tr = br * Math.min(sx, sy);

        // Draw detection circle on thumbnail
        tc.beginPath();
        tc.arc(tx, ty, Math.max(tr, 4), 0, 2 * Math.PI);
        tc.strokeStyle = '#3b82f6';
        tc.lineWidth   = 2;
        tc.stroke();
        // Center dot
        tc.beginPath();
        tc.arc(tx, ty, 3, 0, 2 * Math.PI);
        tc.fillStyle = '#ef4444';
        tc.fill();

        this.capturedFrames.push({ canvas: thumb, speed, frameIdx });
    }

    // 軌跡描画：速度に応じたグラデーションカラーと滑らかな線
    _drawTrail() {
        if (this.positions.length < 2) return;
        const ctx = this.ctx;
        const r   = Math.max(4, this.canvas.height * 0.005);
        const lw  = Math.max(3, this.canvas.height * 0.004);

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = lw;

        // セグメントごとに速度を計算し、色を変えて描画
        for (let i = 1; i < this.positions.length; i++) {
            const p1 = this.positions[i - 1];
            const p2 = this.positions[i];
            const dt = (this.timestamps[i] - this.timestamps[i - 1]) / 1000;
            let speed = 0;
            if (dt > 0) {
                const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                speed = (pxDist / this.pixelsPerCm / 100) / dt; // m/s
            }

            // 速度(0 ~ 2.0 m/s)を色相(240=青 ~ 0=赤)にマッピング
            const clampedSpeed = Math.min(Math.max(speed, 0), 2.0);
            const hue = 240 - (clampedSpeed / 2.0) * 240; 
            ctx.strokeStyle = `hsla(${hue}, 100%, 50%, 0.8)`;

            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }

        // 各点（キーフレーム）を小さく描画
        for (let i = 0; i < this.positions.length; i++) {
            const p = this.positions[i];
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = i === 0 ? '#22c55e' : (i === this.positions.length - 1 ? '#ef4444' : '#ffffff');
            ctx.fill();
        }
        ctx.restore();
    }

    // ─── Drawing ───────────────────────────────────────────────
    drawTarget(x, y, radius, color) {
        const r = Math.max(radius, 8);
        const lw = Math.max(this.canvas.height * 0.005, 3);
        this.ctx.beginPath();
        this.ctx.arc(x, y, r, 0, 2 * Math.PI);
        this.ctx.lineWidth = lw;
        this.ctx.strokeStyle = color;
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.arc(x, y, lw, 0, 2 * Math.PI);
        this.ctx.fillStyle = '#ef4444';
        this.ctx.fill();
    }

    _drawHUD(text) {
        const fSize = Math.max(Math.floor(this.canvas.height * 0.028), 14);
        const pad   = Math.floor(fSize * 0.5);
        this.ctx.save();
        this.ctx.font = `bold ${fSize}px monospace`;
        const fullText = text + `  FPS:${Math.round(this.currentFps)}`;
        const bgW = this.ctx.measureText(fullText).width + pad * 2;
        this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
        this.ctx.fillRect(pad, pad, Math.min(bgW, this.canvas.width - pad*2), fSize + pad * 2);
        this.ctx.fillStyle = '#facc15';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText(fullText, pad * 2, pad * 1.5);
        this.ctx.restore();
    }

    // ─── Calculate Result ───────────────────────────────────────
    _finalizeResult() {
        this.state      = 'RESULT';
        this.stateTimer = performance.now();

        if (this.positions.length < 2) {
            this.onStatusUpdate(`エラー: データ不足 (${this.positions.length}コマ) FPS:${Math.round(this.currentFps)}`, '--', '--', '#ef4444');
            return;
        }

        let maxV = 0;
        const win = Math.max(1, Math.min(3, Math.floor(this.positions.length / 2)));
        for (let i = win; i < this.positions.length; i++) {
            const p1 = this.positions[i - win], p2 = this.positions[i];
            const dt = (this.timestamps[i] - this.timestamps[i - win]) / 1000;
            if (dt > 0) {
                const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const v  = (px / this.pixelsPerCm / 100) / dt;
                if (v > maxV) maxV = v;
            }
        }

        if (maxV < 0.05) {
            this.onStatusUpdate(`エラー: 速度が低すぎます (${maxV.toFixed(3)}m/s)`, '--', '--', '#ef4444');
            return;
        }

        const stimpM = this.stimpValue * 0.3048;
        const decel  = -(1.83 * 1.83) / (2 * stimpM);
        const dist   = -(maxV * maxV) / (2 * decel);
        // 小数点以下切り捨て、単位なしで渡す（app.jsのHTML側で単位を表示）
        this.onStatusUpdate(
            `完了 (初速:${maxV.toFixed(2)}m/s | ${this.positions.length}コマ)`,
            maxV.toFixed(2),           // 単位なし（app.jsで"m/s"を追加）
            dist.toFixed(2),           // 単位なし（HTML側の<span>"m"で表示）
            '#22c55e'
        );
    }
}
