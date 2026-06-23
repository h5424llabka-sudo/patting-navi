document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const greenSpeedSlider = document.getElementById('green-speed');
    const speedValueDisplay = document.getElementById('speed-value');
    
    const videoPlayer = document.getElementById('video-player');
    const outputCanvas = document.getElementById('output-canvas');
    
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    
    const resStatus = document.getElementById('res-status');
    const resVelocity = document.getElementById('res-velocity');
    const resDistance = document.getElementById('res-distance');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');

    let stream = null;
    let tracker = null;
    let cvReady = false;

    // --- OpenCV Ready Callback ---
    window.onOpenCvReady = function() {
        console.log('OpenCV.js is ready.');
        cvReady = true;
        loadingOverlay.classList.add('hidden');
        tracker = new PuttTracker(outputCanvas, updateResultsUI);
    };

    if (window.cv && window.cv.Mat) {
        window.onOpenCvReady();
    }

    // --- Settings ---
    greenSpeedSlider.addEventListener('input', (e) => {
        speedValueDisplay.textContent = `${e.target.value} ft`;
        if (tracker) {
            tracker.stimpValue = parseFloat(e.target.value);
        }
    });

    // --- Camera Handling & Flow ---
    btnStart.addEventListener('click', async () => {
        if (!cvReady || !tracker) {
            alert('OpenCV.jsがまだロードされていません。');
            return;
        }
        await startAppFlow();
    });

    btnStop.addEventListener('click', () => {
        stopAppFlow();
    });

    async function startAppFlow() {
        btnStart.classList.add('hidden');
        loadingOverlay.classList.remove('hidden');
        loadingText.textContent = 'カメラを起動中...';

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('カメラがサポートされていません。');
            resetUI();
            return;
        }

        try {
            // Request highest possible frame rate for rear camera
            stream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    facingMode: 'environment',
                    frameRate: { ideal: 60, max: 120 },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
            videoPlayer.srcObject = stream;
            
            // Wait for video to start playing
            await new Promise(resolve => {
                videoPlayer.onloadedmetadata = () => {
                    videoPlayer.play();
                    resolve();
                };
            });

            loadingOverlay.classList.add('hidden');
            btnStop.classList.remove('hidden');
            
            let stimp = parseFloat(greenSpeedSlider.value);
            tracker.init(videoPlayer, stimp);
            tracker.startTracking();

        } catch (err) {
            console.error('Camera error:', err);
            alert('カメラの起動に失敗しました: ' + err.message);
            resetUI();
        }
    }

    function stopAppFlow() {
        if (tracker) {
            tracker.stopTracking();
        }
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            videoPlayer.srcObject = null;
        }
        resetUI();
    }

    function updateResultsUI(status, velocityStr, distanceStr, stateColor = 'white') {
        resStatus.textContent = status;
        resStatus.style.color = stateColor;
        
        if (velocityStr !== null && velocityStr !== '--') {
            resVelocity.textContent = `${velocityStr} m/s`;
        }
        if (distanceStr !== null && distanceStr !== '--') {
            resDistance.textContent = distanceStr;
        }
    }

    function resetUI() {
        btnStart.classList.remove('hidden');
        btnStop.classList.add('hidden');
        loadingOverlay.classList.add('hidden');
        resStatus.textContent = '待機中';
        resStatus.style.color = 'white';
        resDistance.textContent = '--';
        resVelocity.textContent = '-- m/s';
    }
});
