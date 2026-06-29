/**
 * PuttTracker Worker
 * すべての重いピクセル計算はここで行う。メインスレッドから ImageData を受け取り、
 * 結果（ボール座標）だけをメインスレッドに返す。
 */

let bgModel      = null;  // Uint8Array [R,G,B,...]
let bgAccum      = null;  // Float32Array
let bgFrameCount = 0;
const BG_FRAMES  = 40;    // 40フレームで背景確定（60より速く）

// Params (updated from main thread)
let params = {
    workW: 0, workH: 0,
    diffThreshold: 60,
    GRID_COLS: 10, GRID_ROWS: 6,
    MIN_CELL_PX: 15,
    MAX_GLOBAL_RATIO: 0.25,
    minBallRadius: 15,
    maxBallRadius: 80,
    colorTolerance: 180,
    ignoreShadows: true,
};

self.onmessage = (e) => {
    const { type, data } = e.data;

    if (type === 'params') {
        Object.assign(params, data);
        return;
    }

    if (type === 'reset_bg') {
        bgModel = null; bgAccum = null; bgFrameCount = 0;
        return;
    }

    if (type === 'learn_bg') {
        const { pixels } = data; // Uint8ClampedArray (RGBA)
        const n = params.workW * params.workH;
        if (!bgAccum) bgAccum = new Float32Array(n * 3);

        for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
            bgAccum[j]   += pixels[i];
            bgAccum[j+1] += pixels[i+1];
            bgAccum[j+2] += pixels[i+2];
        }
        bgFrameCount++;

        const pct = bgFrameCount / BG_FRAMES;

        if (bgFrameCount >= BG_FRAMES) {
            bgModel = new Uint8Array(n * 3);
            for (let i = 0; i < n*3; i++) {
                bgModel[i] = Math.round(bgAccum[i] / bgFrameCount);
            }
            bgAccum = null;
            self.postMessage({ type: 'bg_done' });
        } else {
            self.postMessage({ type: 'bg_progress', pct });
        }
        return;
    }

    if (type === 'detect') {
        if (!bgModel) {
            self.postMessage({ type: 'detect_result', result: null });
            return;
        }
        const { pixels, roiCx, roiCy, roiR, targetColor, debugMode, updateBg, isTracking, baselineY, maxX, velX } = data;
        const result = detectFG(pixels, roiCx, roiCy, roiR, targetColor, debugMode, updateBg, isTracking, baselineY, maxX, velX);
        self.postMessage({ type: 'detect_result', result }, debugMode && result.debugPixels ? [result.debugPixels.buffer] : []);
        return;
    }
};

function detectFG(pixels, roiCx, roiCy, roiR, targetColor, debugMode, updateBg, isTracking, baselineY, maxX, velX) {
    const d   = pixels;
    const bg  = bgModel;
    const W   = params.workW, H = params.workH;
    const thr = params.diffThreshold;
    const GC  = params.GRID_COLS, GR = params.GRID_ROWS;
    const cellW = W / GC, cellH = H / GR;
    const useROI = roiR > 0;
    const roiR2  = roiR * roiR;

    const gridCnt = new Int32Array(GC * GR);
    const gridSX  = new Float32Array(GC * GR);
    const gridSY  = new Float32Array(GC * GR);
    let globalFg  = 0;

    // Debug buffer
    let dbg = debugMode ? new Uint8ClampedArray(W * H * 4) : null;
    if (dbg) { for (let i=3; i<dbg.length; i+=4) dbg[i] = 255; } // alpha=255

    for (let y = 0; y < H; y++) {
        // Y-Axis Lock: トラッキング中は、baselineY の周辺以外は完全に無視する
        if (isTracking && baselineY >= 0) {
            if (Math.abs(y - baselineY) > roiR * 1.5) continue;
        }

        for (let x = 0; x < W; x++) {
            // Forward Only: トラッキング中は、maxX より右側（パター側）は完全に無視する
            if (isTracking && maxX >= 0) {
                if (x > maxX) continue;
            }

            if (useROI && !isTracking) { // トラッキング中は上の条件でROIの代わりとする
                const dx = x - roiCx, dy = y - roiCy;
                if (dx*dx + dy*dy > roiR2) continue;
            }
            const p = y * W + x;
            const i = p * 4, j = p * 3;
            const dr = d[i]  - bg[j];
            const dg = d[i+1]- bg[j+1];
            const db = d[i+2]- bg[j+2];
            const diff = (dr < 0 ? -dr : dr) + (dg < 0 ? -dg : dg) + (db < 0 ? -db : db);

            if (diff <= thr) {
                // Background pixel - update relatively fast if requested
                if (updateBg) {
                    bg[j]   = (bg[j]*19 + d[i])/20;   // alpha = 0.05
                    bg[j+1] = (bg[j+1]*19 + d[i+1])/20;
                    bg[j+2] = (bg[j+2]*19 + d[i+2])/20;
                }
                continue;
            }

            // Foreground pixel - update very slowly to adapt to camera shifts, but not absorb balls instantly
            if (updateBg) {
                bg[j]   = (bg[j]*99 + d[i])/100; // alpha = 0.01
                bg[j+1] = (bg[j+1]*99 + d[i+1])/100;
                bg[j+2] = (bg[j+2]*99 + d[i+2])/100;
            }

            // Shadow filter
            if (params.ignoreShadows) {
                if ((d[i]+d[i+1]+d[i+2]) < (bg[j]+bg[j+1]+bg[j+2]) - 30) {
                    if (dbg) { dbg[i]=0; dbg[i+1]=100; dbg[i+2]=0; }
                    continue;
                }
            }

            // Color filter
            let isTarget = true;
            if (targetColor) {
                const dc = (d[i]-targetColor.r < 0 ? -(d[i]-targetColor.r) : (d[i]-targetColor.r))
                         + (d[i+1]-targetColor.g < 0 ? -(d[i+1]-targetColor.g) : (d[i+1]-targetColor.g))
                         + (d[i+2]-targetColor.b < 0 ? -(d[i+2]-targetColor.b) : (d[i+2]-targetColor.b));
                if (dc > params.colorTolerance) isTarget = false;
            }

            if (dbg) {
                if (isTarget) {
                    dbg[i]   = targetColor ? 255 : 255;
                    dbg[i+1] = targetColor ? 50  : 255;
                    dbg[i+2] = targetColor ? 50  : 255;
                } else {
                    dbg[i]=100; dbg[i+1]=100; dbg[i+2]=100;
                }
            }

            if (!isTarget) continue;

            const gc = Math.min((x / cellW) | 0, GC - 1);
            const gr = Math.min((y / cellH) | 0, GR - 1);
            const gi = gr * GC + gc;
            gridCnt[gi]++;
            gridSX[gi] += x;
            gridSY[gi] += y;
            globalFg++;
        }
    }

    const maxAllowed = (useROI || isTracking) ? 999999 : Math.floor(W * H * params.MAX_GLOBAL_RATIO);
    if (globalFg > maxAllowed) {
        return { tooNoisy: true, globalCnt: globalFg, blobCnt: 0, blobCx: -1, blobCy: -1, debugPixels: dbg };
    }

    // 進行方向の最前線（Leading Edge）を探す
    let bestCell = -1;
    let bestEdgeX = (velX !== undefined && velX > 0) ? -999999 : 999999;
    let bestCount = 0;

    for (let i = 0; i < GC * GR; i++) {
        if (gridCnt[i] < params.MIN_CELL_PX) continue;

        const cx = gridSX[i] / gridCnt[i];
        // トラッキング中なら進行方向の先端を優先
        if (isTracking && velX !== undefined && Math.abs(velX) > 0.01) {
            if (velX > 0) {
                // 右に移動している場合は、最も右（Xが大きい）ものを優先
                if (cx > bestEdgeX) {
                    bestEdgeX = cx;
                    bestCell = i;
                    bestCount = gridCnt[i];
                }
            } else {
                // 左に移動している場合は、最も左（Xが小さい）ものを優先
                if (cx < bestEdgeX) {
                    bestEdgeX = cx;
                    bestCell = i;
                    bestCount = gridCnt[i];
                }
            }
        } else {
            // 待機中（ボール認識前）や速度不明時は一番大きい塊を探す
            if (gridCnt[i] > bestCount) {
                bestCount = gridCnt[i];
                bestCell = i;
            }
        }
    }

    if (bestCell === -1) {
        return { tooNoisy: false, globalCnt: globalFg, blobCnt: 0, blobCx: -1, blobCy: -1, debugPixels: dbg };
    }

    const mc = bestCell % GC, mr = (bestCell / GC) | 0;
    let blobCnt = 0, blobSX = 0, blobSY = 0;
    for (let dr2 = -1; dr2 <= 1; dr2++) {
        for (let dc2 = -1; dc2 <= 1; dc2++) {
            const nc = mc + dc2, nr = mr + dr2;
            if (nc < 0 || nc >= GC || nr < 0 || nr >= GR) continue;
            const ni = nr * GC + nc;
            blobCnt += gridCnt[ni];
            blobSX  += gridSX[ni];
            blobSY  += gridSY[ni];
        }
    }

    return {
        tooNoisy: false,
        globalCnt: globalFg,
        blobCnt,
        blobCx: blobCnt > 0 ? blobSX / blobCnt : -1,
        blobCy: blobCnt > 0 ? blobSY / blobCnt : -1,
        debugPixels: dbg
    };
}
