document.addEventListener('DOMContentLoaded', () => {
    const greenSpeedSlider   = document.getElementById('green-speed');
    const speedValueDisplay  = document.getElementById('speed-value');
    const sensitivitySlider  = document.getElementById('sensitivity');
    const sensitivityDisplay = document.getElementById('sensitivity-value');

    const minBallSizeSlider  = document.getElementById('min-ball-size');
    const minBallSizeDisplay = document.getElementById('min-ball-size-value');
    
    const maxBallSizeSlider  = document.getElementById('max-ball-size');
    const maxBallSizeDisplay = document.getElementById('max-ball-size-value');
    
    const colorToleranceSlider  = document.getElementById('color-tolerance');
    const colorToleranceDisplay = document.getElementById('color-tolerance-value');
    
    const maxTrackTimeSlider  = document.getElementById('max-track-time');
    const maxTrackTimeDisplay = document.getElementById('max-track-time-value');

    const motionMultSlider  = document.getElementById('motion-multiplier');
    const motionMultDisplay = document.getElementById('motion-multiplier-value');

    const ignoreShadowsToggle = document.getElementById('ignore-shadows-toggle');
    const debugModeToggle     = document.getElementById('debug-mode-toggle');
    const debugContainer      = document.getElementById('debug-container');
    const debugCanvas         = document.getElementById('debug-canvas');

    const videoPlayer  = document.getElementById('video-player');
    const outputCanvas = document.getElementById('output-canvas');

    const btnStart       = document.getElementById('btn-start');
    const btnStop        = document.getElementById('btn-stop');
    const btnRecalibrate = document.getElementById('btn-recalibrate');

    const resStatus   = document.getElementById('res-status');
    const resVelocity = document.getElementById('res-velocity');
    const resDistance = document.getElementById('res-distance');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText    = document.getElementById('loading-text');

    // Modals
    const settingsModal    = document.getElementById('settings-modal');
    const infoModal        = document.getElementById('info-modal');
    const btnSettings      = document.getElementById('btn-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const btnInfo          = document.getElementById('btn-info');
    const btnCloseInfo     = document.getElementById('btn-close-info');
    const btnFullscreen    = document.getElementById('btn-fullscreen');

    // Film strip
    const filmStripPanel  = document.getElementById('film-strip-panel');
    const filmStrip       = document.getElementById('film-strip');
    const filmFrameCount  = document.getElementById('film-frame-count');

    // Lightbox
    const frameLightbox   = document.getElementById('frame-lightbox');
    const lightboxCanvas  = document.getElementById('lightbox-canvas');
    const lightboxInfo    = document.getElementById('lightbox-info');
    const lightboxClose   = document.getElementById('lightbox-close');

    let stream = null;
    const tracker = new PuttTracker(outputCanvas, updateResultsUI);

    // ── Settings ──────────────────────────────────────────────
    greenSpeedSlider.addEventListener('input', e => {
        speedValueDisplay.textContent = `${e.target.value} ft`;
        tracker.stimpValue = parseFloat(e.target.value);
    });

    sensitivitySlider.addEventListener('input', e => {
        const val = parseInt(e.target.value);
        sensitivityDisplay.textContent = val;
        tracker.diffThreshold = 140 - val;
    });

    minBallSizeSlider.addEventListener('input', e => {
        const val = parseInt(e.target.value);
        minBallSizeDisplay.textContent = `${val} px`;
        tracker.minBallRadius = val;
    });

    maxBallSizeSlider.addEventListener('input', e => {
        const val = parseInt(e.target.value);
        maxBallSizeDisplay.textContent = `${val} px`;
        tracker.maxBallRadius = val;
    });

    colorToleranceSlider.addEventListener('input', e => {
        const val = parseInt(e.target.value);
        colorToleranceDisplay.textContent = val;
        tracker.colorTolerance = val;
    });

    maxTrackTimeSlider.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        maxTrackTimeDisplay.textContent = `${val.toFixed(1)} s`;
        tracker.maxTrackTime = val * 1000; // ms
    });

    motionMultSlider.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        motionMultDisplay.textContent = `${val.toFixed(1)} x`;
        tracker.motionMultiplier = val;
    });

    ignoreShadowsToggle.addEventListener('change', e => {
        tracker.ignoreShadows = e.target.checked;
    });

    debugModeToggle.addEventListener('change', e => {
        const isDebug = e.target.checked;
        if (isDebug) {
            debugContainer.classList.remove('hidden');
            tracker.debugCtx = debugCanvas.getContext('2d');
            tracker.debugCanvas = debugCanvas;
        } else {
            debugContainer.classList.add('hidden');
            tracker.debugCtx = null;
            tracker.debugCanvas = null;
        }
    });

    // ── Controls & Modals ──────────────────────────────────────
    btnSettings.addEventListener('click', () => settingsModal.classList.remove('hidden'));
    btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
    
    btnInfo.addEventListener('click', () => infoModal.classList.remove('hidden'));
    btnCloseInfo.addEventListener('click', () => infoModal.classList.add('hidden'));

    btnFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.warn(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    });

    // Close modals when clicking outside
    [settingsModal, infoModal].forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });

    // Lightbox close
    lightboxClose.addEventListener('click', () => frameLightbox.classList.add('hidden'));
    frameLightbox.addEventListener('click', (e) => {
        if (e.target === frameLightbox) frameLightbox.classList.add('hidden');
    });

    btnStart.addEventListener('click', async () => {
        // Try to go fullscreen automatically on start (if user gesture allows)
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            try { await document.documentElement.requestFullscreen(); } catch (e) {}
        }
        await startApp();
    });
    btnStop.addEventListener('click', () => stopApp());
    btnRecalibrate.addEventListener('click', () => {
        tracker.resetToLearning();
    });

    async function startApp() {
        btnStart.classList.add('hidden');
        loadingOverlay.classList.remove('hidden');
        loadingText.textContent = 'カメラを起動中...';
        loadingText.style.color = '';

        if (!navigator.mediaDevices?.getUserMedia) {
            alert('このブラウザはカメラをサポートしていません。');
            resetUI();
            return;
        }

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width:  { ideal: 1920, min: 1280 },
                    height: { ideal: 1080, min: 720 },
                    frameRate: { ideal: 60, min: 30 },
                },
                audio: false
            });
            videoPlayer.srcObject = stream;

            await new Promise(resolve => {
                videoPlayer.onloadedmetadata = () => { videoPlayer.play(); resolve(); };
            });

            loadingOverlay.classList.add('hidden');
            btnStop.classList.remove('hidden');
            btnRecalibrate.classList.remove('hidden');

            // Apply all initial slider values to tracker
            tracker.diffThreshold = 140 - parseInt(sensitivitySlider.value);
            tracker.minBallRadius = parseInt(minBallSizeSlider.value);
            tracker.maxBallRadius = parseInt(maxBallSizeSlider.value);
            tracker.colorTolerance = parseInt(colorToleranceSlider.value);
            tracker.maxTrackTime = parseFloat(maxTrackTimeSlider.value) * 1000;
            tracker.motionMultiplier = parseFloat(motionMultSlider.value);
            tracker.ignoreShadows = ignoreShadowsToggle.checked;
            
            if (debugModeToggle.checked) {
                tracker.debugCtx = debugCanvas.getContext('2d');
                tracker.debugCanvas = debugCanvas;
            }
            
            tracker.init(videoPlayer, parseFloat(greenSpeedSlider.value));
            tracker.startTracking();

        } catch (err) {
            console.error(err);
            alert('カメラの起動に失敗しました: ' + err.message);
            resetUI();
        }
    }

    function stopApp() {
        tracker.stopTracking();
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
            videoPlayer.srcObject = null;
        }
        resetUI();
    }

    function updateResultsUI(status, velocityStr, distanceStr, stateColor = 'white') {
        resStatus.textContent  = status;
        resStatus.style.color  = stateColor;
        if (velocityStr && velocityStr !== '--') {
            resVelocity.textContent = velocityStr;
        }
        if (distanceStr && distanceStr !== '--') {
            resDistance.textContent = distanceStr;
        }
        // 計測完了時にフィルムストリップを表示
        if (stateColor === '#22c55e' && distanceStr && distanceStr !== '--') {
            renderFilmStrip(tracker.capturedFrames);
        }
    }

    function renderFilmStrip(frames) {
        if (!frames || frames.length === 0) {
            filmStripPanel.classList.add('hidden');
            return;
        }

        filmStrip.innerHTML = '';
        filmFrameCount.textContent = `${frames.length}コマ`;

        // Normalise speed for badge colouring (max speed among all frames)
        const maxSpeed = Math.max(...frames.map(f => f.speed), 0.01);

        frames.forEach((frame, i) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'film-frame';

            // Thumbnail canvas (clone from captured canvas)
            const thumbClone = document.createElement('canvas');
            thumbClone.width  = frame.canvas.width;
            thumbClone.height = frame.canvas.height;
            const tc = thumbClone.getContext('2d');
            tc.drawImage(frame.canvas, 0, 0);
            wrapper.appendChild(thumbClone);

            // Frame number
            const numBadge = document.createElement('span');
            numBadge.className = 'film-frame-num';
            numBadge.textContent = `F${frame.frameIdx}`;
            wrapper.appendChild(numBadge);

            // Speed badge with hue gradient (blue=slow, red=fast)
            if (frame.speed > 0) {
                const ratio = Math.min(frame.speed / maxSpeed, 1);
                const hue   = Math.round(240 - ratio * 240);
                const speedBadge = document.createElement('span');
                speedBadge.className = 'film-speed-badge';
                speedBadge.textContent = `${frame.speed.toFixed(1)}m/s`;
                speedBadge.style.background = `hsla(${hue},100%,40%,0.85)`;
                speedBadge.style.color = '#fff';
                wrapper.appendChild(speedBadge);
            }

            // Click → lightbox
            wrapper.addEventListener('click', () => openLightbox(frame, i));

            filmStrip.appendChild(wrapper);
        });

        filmStripPanel.classList.remove('hidden');
    }

    function openLightbox(frame, index) {
        // Draw a 2× scaled version onto the lightbox canvas
        const scale = 2;
        lightboxCanvas.width  = frame.canvas.width  * scale;
        lightboxCanvas.height = frame.canvas.height * scale;
        const lctx = lightboxCanvas.getContext('2d');
        lctx.imageSmoothingEnabled = false;
        lctx.drawImage(frame.canvas, 0, 0, lightboxCanvas.width, lightboxCanvas.height);

        lightboxInfo.innerHTML =
            `<strong style="color:#3b82f6">フレーム #${frame.frameIdx}</strong> &nbsp;|&nbsp; ` +
            (frame.speed > 0 ? `速度: <strong style="color:#facc15">${frame.speed.toFixed(2)} m/s</strong>` : '初回検出') +
            `<br><span style="font-size:0.75rem;">青円 = ボール検出位置　赤点 = 重心</span>`;

        frameLightbox.classList.remove('hidden');
    }

    function resetUI() {
        btnStart.classList.remove('hidden');
        btnStop.classList.add('hidden');
        btnRecalibrate.classList.add('hidden');
        loadingOverlay.classList.add('hidden');
        resStatus.textContent  = '待機中';
        resStatus.style.color  = 'white';
        resDistance.textContent = '--';
        resVelocity.textContent = '--';
        filmStripPanel.classList.add('hidden');
        filmStrip.innerHTML = '';
    }
});

