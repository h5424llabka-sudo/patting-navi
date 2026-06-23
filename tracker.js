class PuttTracker {
    constructor(canvas, onStatusUpdate) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { willReadFrequently: true });
        this.onStatusUpdate = onStatusUpdate;
        
        this.isTracking = false;
        this.frameId = null;
        this.videoElement = null;
        
        // Calibration Constants
        this.BALL_DIAMETER_CM = 4.267; 
        
        // State Machine
        // STATES: INIT -> CALIBRATING -> READY -> TRACKING -> RESULT
        this.state = 'INIT';
        this.stateTimer = 0;
        
        // Tracking Data
        this.pixelsPerCm = 0;
        this.stimpValue = 9.0;
        this.positions = [];
        this.timestamps = [];
        this.stationaryFrames = 0;
        this.lastCenter = null;
        
        // OpenCV Mats
        this.srcMat = null;
        this.hsvMat = null;
        this.maskMat = null;
        this.hierarchy = null;
    }

    init(videoElement, stimpValue = 9.0) {
        this.videoElement = videoElement;
        this.stimpValue = stimpValue;
        
        if (!this.srcMat) {
            this.srcMat = new cv.Mat(this.canvas.height, this.canvas.width, cv.CV_8UC4);
            this.hsvMat = new cv.Mat(this.canvas.height, this.canvas.width, cv.CV_8UC3);
            this.maskMat = new cv.Mat(this.canvas.height, this.canvas.width, cv.CV_8UC1);
            this.hierarchy = new cv.Mat();
        }
        
        this.resetState();
    }

    resetState() {
        this.state = 'CALIBRATING';
        this.positions = [];
        this.timestamps = [];
        this.stationaryFrames = 0;
        this.lastCenter = null;
        this.onStatusUpdate('ボールを探しています...', '--', '--', '#facc15'); // Yellow
    }

    startTracking() {
        if (!this.videoElement || this.isTracking) return;
        this.isTracking = true;
        this.resetState();
        this.processFrame();
    }

    stopTracking() {
        this.isTracking = false;
        if (this.frameId) {
            cancelAnimationFrame(this.frameId);
        }
    }

    processFrame() {
        if (!this.isTracking || this.videoElement.paused || this.videoElement.ended) {
            return;
        }

        // Handle canvas sizing dynamically based on video stream
        if (this.canvas.width !== this.videoElement.videoWidth && this.videoElement.videoWidth > 0) {
            this.canvas.width = this.videoElement.videoWidth;
            this.canvas.height = this.videoElement.videoHeight;
            this.srcMat.delete(); this.hsvMat.delete(); this.maskMat.delete();
            this.srcMat = new cv.Mat(this.canvas.height, this.canvas.width, cv.CV_8UC4);
            this.hsvMat = new cv.Mat(this.canvas.height, this.canvas.width, cv.CV_8UC3);
            this.maskMat = new cv.Mat(this.canvas.height, this.canvas.width, cv.CV_8UC1);
        }

        const width = this.canvas.width;
        const height = this.canvas.height;
        
        if (width === 0 || height === 0) {
            this.frameId = requestAnimationFrame(() => this.processFrame());
            return;
        }

        this.ctx.drawImage(this.videoElement, 0, 0, width, height);
        let imageData = this.ctx.getImageData(0, 0, width, height);
        this.srcMat.data.set(imageData.data);

        this.analyzeFrame();

        this.frameId = requestAnimationFrame(() => this.processFrame());
    }

    analyzeFrame() {
        if (this.state === 'RESULT') {
            // Show result for a few seconds then reset
            cv.imshow(this.canvas.id, this.srcMat);
            if (performance.now() - this.stateTimer > 4000) {
                this.resetState();
            }
            return;
        }

        // Color thresholding for white ball
        cv.cvtColor(this.srcMat, this.hsvMat, cv.COLOR_RGBA2RGB);
        cv.cvtColor(this.hsvMat, this.hsvMat, cv.COLOR_RGB2HSV);

        // Broad white color range to account for lighting
        let low = new cv.Mat(this.hsvMat.rows, this.hsvMat.cols, this.hsvMat.type(), [0, 0, 150, 0]);
        let high = new cv.Mat(this.hsvMat.rows, this.hsvMat.cols, this.hsvMat.type(), [180, 80, 255, 0]);
        cv.inRange(this.hsvMat, low, high, this.maskMat);
        
        // Morphological operations
        let kernel = cv.Mat.ones(5, 5, cv.CV_8U);
        cv.dilate(this.maskMat, this.maskMat, kernel);
        cv.erode(this.maskMat, this.maskMat, kernel);

        let contours = new cv.MatVector();
        cv.findContours(this.maskMat, contours, this.hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let bestContour = null;
        let maxArea = 0;
        let bestCircle = null;

        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let area = cv.contourArea(cnt);
            if (area > 300 && area > maxArea) {
                // In real-time motion blur, it might not be a perfect circle, so we just take the minEnclosingCircle of the largest white blob.
                let circle = cv.minEnclosingCircle(cnt);
                maxArea = area;
                bestContour = cnt;
                bestCircle = circle;
            }
        }

        let currentTime = performance.now();

        if (bestCircle) {
            let center = bestCircle.center;
            let radius = bestCircle.radius;
            
            // Draw tracking info
            cv.circle(this.srcMat, center, radius, [0, 255, 0, 255], 3);
            cv.circle(this.srcMat, center, 2, [255, 0, 0, 255], 3);

            if (this.state === 'CALIBRATING') {
                if (this.lastCenter) {
                    let dx = center.x - this.lastCenter.x;
                    let dy = center.y - this.lastCenter.y;
                    let dist = Math.sqrt(dx*dx + dy*dy);
                    
                    if (dist < 5) { // Stationary
                        this.stationaryFrames++;
                        if (this.stationaryFrames > 15) { // Stationary for ~0.5s at 30fps
                            this.pixelsPerCm = (radius * 2) / this.BALL_DIAMETER_CM;
                            this.state = 'READY';
                            this.onStatusUpdate('準備完了 (パットしてください)', '--', '--', '#22c55e'); // Green
                        }
                    } else {
                        this.stationaryFrames = 0;
                    }
                }
                this.lastCenter = center;
            } 
            else if (this.state === 'READY') {
                let dx = center.x - this.lastCenter.x;
                let dy = center.y - this.lastCenter.y;
                let dist = Math.sqrt(dx*dx + dy*dy);
                
                if (dist > 10) { // Sudden movement detected
                    this.state = 'TRACKING';
                    this.positions = [{x: this.lastCenter.x, y: this.lastCenter.y}];
                    this.timestamps = [currentTime - 16]; // Approx previous frame
                    this.onStatusUpdate('計測中...', '--', '--', '#3b82f6'); // Blue
                }
                this.lastCenter = center;
            }
            
            if (this.state === 'TRACKING') {
                this.positions.push({x: center.x, y: center.y});
                this.timestamps.push(currentTime);
                this.lastCenter = center;
            }

        } else {
            // Ball lost
            if (this.state === 'TRACKING') {
                // Ball went out of frame or stopped moving and was lost. Calculate results.
                this.calculateResults();
            } else if (this.state === 'READY') {
                // Lost ball while ready, go back to calibrating
                this.resetState();
            }
        }

        cv.imshow(this.canvas.id, this.srcMat);

        low.delete(); high.delete(); kernel.delete(); contours.delete();
    }

    calculateResults() {
        this.state = 'RESULT';
        this.stateTimer = performance.now();
        
        if (this.positions.length < 3) {
            this.onStatusUpdate('エラー: データ不足', '--', '--', '#ef4444');
            return;
        }

        // Calculate max velocity (smooth out anomalies by looking at larger frame windows)
        let maxVelocity = 0;
        
        // Window size of 3 frames to smooth out noise
        let windowSize = 3;
        for (let i = windowSize; i < this.positions.length; i++) {
            let p1 = this.positions[i - windowSize];
            let p2 = this.positions[i];
            let t1 = this.timestamps[i - windowSize];
            let t2 = this.timestamps[i];
            
            let dt = (t2 - t1) / 1000; // seconds
            if (dt > 0) {
                let distPixels = Math.sqrt(Math.pow(p2.x-p1.x, 2) + Math.pow(p2.y-p1.y, 2));
                let distCm = distPixels / this.pixelsPerCm;
                let v = (distCm / 100) / dt; // m/s
                
                if (v > maxVelocity) {
                    maxVelocity = v;
                }
            }
        }

        if (maxVelocity < 0.2) {
             this.onStatusUpdate('エラー: 速度が遅すぎます', '--', '--', '#ef4444');
             return;
        }

        // Calculate distance based on Stimp meter
        let stimpMeters = this.stimpValue * 0.3048;
        let deceleration = - (1.83 * 1.83) / (2 * stimpMeters); // m/s^2
        let estimatedDistance = - (maxVelocity * maxVelocity) / (2 * deceleration);

        this.onStatusUpdate('計測完了 (自動リセットします)', maxVelocity.toFixed(2), estimatedDistance.toFixed(2), '#a855f7'); // Purple
    }
}
