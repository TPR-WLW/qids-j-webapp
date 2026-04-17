/**
 * recorder.js
 * カメラ起動・録画 (MediaRecorder) と
 * face-api.js による 68点ランドマーク検出を担当。
 *
 * ブラウザ内で完結する設計 — 映像も特徴点データも外部へ送信しない。
 */

const FaceRecorder = (() => {
  // ---- state ----
  let videoEl, canvasEl, statusEl, timeEl, panelEl;
  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let recordedBlob = null;
  let recordedMime = 'video/webm';

  let startedAt = null;
  let timerId = null;
  let detectionTimerId = null;
  let detectionRunning = false;
  let stopRequested = false;

  let modelsLoaded = false;
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model/';
  const DETECT_INTERVAL_MS = 120;   // 約 8 fps — 録画の滑らかさには影響しない
  const DETECTOR_INPUT_SIZE = 160;  // 小さいほうが CPU 負荷が軽く UI が固まらない

  // 特徴点ログ: { t: ms, q: 現在の質問index, landmarks: [[x,y], ...], expression?: {...} }
  const landmarkLog = [];
  let currentQuestionIndex = 0;

  // ---------------- Public API ----------------

  async function init(ui) {
    videoEl  = ui.video;
    canvasEl = ui.canvas;
    statusEl = ui.status;
    timeEl   = ui.time;
    panelEl  = ui.panel;
  }

  /**
   * カメラ起動＋モデル読み込み＋録画開始
   * @returns {Promise<boolean>} 成功したか
   */
  async function start() {
    try {
      showPanel(true);
      setStatus('カメラへアクセス中…');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      videoEl.srcObject = stream;
      await videoEl.play();

      // Canvas サイズ合わせ
      syncCanvasSize();
      window.addEventListener('resize', syncCanvasSize);

      // MediaRecorder
      recordedMime = pickMime();
      mediaRecorder = new MediaRecorder(stream, { mimeType: recordedMime });
      chunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        recordedBlob = new Blob(chunks, { type: recordedMime });
      };
      mediaRecorder.start(1000); // 1秒ごとに chunk 生成
      startedAt = Date.now();
      startTimer();

      // モデル読み込み（録画は既に開始している — 解析だけ後追い）
      setStatus('解析モデル読み込み中…');
      await loadModels();

      // WebGL シェーダーのコンパイルを先に済ませる（ウォームアップ）。
      // これをしないと、最初の検出フレームで 300〜800ms のブロッキングが発生し
      // 画面遷移直後に UI が固まって見える。
      setStatus('初期化中…');
      await warmup();
      setStatus('録画中・解析中');

      // 解析ループ（requestAnimationFrame ではなく setTimeout で節流し、
      // クリックなど UI イベントが詰まらないようにする）
      stopRequested = false;
      scheduleDetect();
      return true;
    } catch (err) {
      console.error('[FaceRecorder] start error', err);
      setStatus('カメラ利用不可: ' + (err.message || err.name));
      await stop();
      return false;
    }
  }

  async function stop() {
    stopTimer();
    stopRequested = true;
    if (detectionTimerId) { clearTimeout(detectionTimerId); detectionTimerId = null; }
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        await new Promise((resolve) => {
          mediaRecorder.addEventListener('stop', resolve, { once: true });
          mediaRecorder.stop();
        });
      }
    } catch (e) { console.warn(e); }

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
    setStatus('記録停止');
  }

  function setQuestionIndex(i) { currentQuestionIndex = i; }

  function getBlob() { return recordedBlob; }
  function getMime() { return recordedMime; }
  function getLandmarkLog() {
    return {
      meta: {
        startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        videoWidth: videoEl ? videoEl.videoWidth : 0,
        videoHeight: videoEl ? videoEl.videoHeight : 0,
        modelUrl: MODEL_URL,
        points: 68,
        mirrored: true,
        note: 'landmarks are normalized 0-1 within video frame (x,y). q = question index (0-15), t = ms since start.'
      },
      frames: landmarkLog
    };
  }

  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function showPanel(show) {
    if (!panelEl) return;
    panelEl.classList.toggle('hidden', !show);
    panelEl.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  // ---------------- Internal ----------------

  function pickMime() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return 'video/webm';
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  function syncCanvasSize() {
    if (!videoEl || !canvasEl) return;
    const rect = videoEl.getBoundingClientRect();
    canvasEl.width = rect.width * devicePixelRatio;
    canvasEl.height = rect.height * devicePixelRatio;
    canvasEl.style.width = rect.width + 'px';
    canvasEl.style.height = rect.height + 'px';
  }

  function startTimer() {
    stopTimer();
    timerId = setInterval(() => {
      if (!startedAt || !timeEl) return;
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      timeEl.textContent = `${mm}:${ss}`;
    }, 500);
  }
  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  async function loadModels() {
    if (modelsLoaded) return;
    if (typeof faceapi === 'undefined') {
      throw new Error('face-api.js が読み込まれていません');
    }
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL)
    ]);
    modelsLoaded = true;
  }

  // ダミー画像で一度推論を走らせ、WebGL シェーダーを事前コンパイルさせる。
  // これを行わないと、問卷画面に遷移した直後の最初の検出で
  // 数百 ms のブロッキングが発生し、クリックが一瞬固まる原因になる。
  async function warmup() {
    try {
      const dummy = document.createElement('canvas');
      dummy.width = DETECTOR_INPUT_SIZE;
      dummy.height = DETECTOR_INPUT_SIZE;
      const c = dummy.getContext('2d');
      // 適当なグラデを描いておく（真っ黒より shader を通りやすい）
      const g = c.createLinearGradient(0, 0, dummy.width, dummy.height);
      g.addColorStop(0, '#888'); g.addColorStop(1, '#333');
      c.fillStyle = g;
      c.fillRect(0, 0, dummy.width, dummy.height);

      await faceapi
        .detectSingleFace(dummy, new faceapi.TinyFaceDetectorOptions({
          inputSize: DETECTOR_INPUT_SIZE,
          scoreThreshold: 0.5
        }))
        .withFaceLandmarks(true);
    } catch (e) {
      // ウォームアップ失敗は致命ではない — 本番ループが普通に動けば OK
    }
  }

  function scheduleDetect() {
    if (stopRequested) return;
    detectionTimerId = setTimeout(runDetect, DETECT_INTERVAL_MS);
  }

  async function runDetect() {
    if (stopRequested) return;
    // 再入防止 — 前回の検出が終わっていないうちは次を回さない
    if (detectionRunning) { scheduleDetect(); return; }
    if (!modelsLoaded || !videoEl || videoEl.readyState < 2) { scheduleDetect(); return; }

    detectionRunning = true;
    try {
      // 重い推論はアイドル時間があれば使う — クリック応答を優先
      await idle();

      const detection = await faceapi
        .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({
          inputSize: DETECTOR_INPUT_SIZE,
          scoreThreshold: 0.5
        }))
        .withFaceLandmarks(true);

      drawOverlay(detection);

      if (detection && detection.landmarks) {
        const vw = videoEl.videoWidth || 1;
        const vh = videoEl.videoHeight || 1;
        const pts = detection.landmarks.positions.map(p => [
          +(p.x / vw).toFixed(4),
          +(p.y / vh).toFixed(4)
        ]);
        landmarkLog.push({
          t: Date.now() - startedAt,
          q: currentQuestionIndex,
          pts
        });
      }
    } catch (e) {
      // silently skip this frame
    } finally {
      detectionRunning = false;
      scheduleDetect();
    }
  }

  // requestIdleCallback があれば使い、無ければ短い setTimeout で代用
  function idle() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 80 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function drawOverlay(detection) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!detection || !detection.landmarks) return;

    const vw = videoEl.videoWidth || 1;
    const vh = videoEl.videoHeight || 1;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    const sx = cw / vw;
    const sy = ch / vh;

    // canvas は CSS で既にミラー表示されているので、context 側の反転は行わない。
    // face-api はミラーされていない生のフレームから座標を返すため、
    // そのまま描画すれば CSS ミラーによって正しい位置に重なる。
    ctx.fillStyle = '#6cb4a0';
    for (const p of detection.landmarks.positions) {
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 1.6 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(108, 180, 160, 0.55)';
    ctx.lineWidth = 1 * devicePixelRatio;
    drawLine(ctx, detection.landmarks.getJawOutline(), sx, sy);
    drawLine(ctx, detection.landmarks.getLeftEyeBrow(), sx, sy);
    drawLine(ctx, detection.landmarks.getRightEyeBrow(), sx, sy);
    drawLine(ctx, detection.landmarks.getNose(), sx, sy);
    drawLine(ctx, detection.landmarks.getLeftEye(), sx, sy, true);
    drawLine(ctx, detection.landmarks.getRightEye(), sx, sy, true);
    drawLine(ctx, detection.landmarks.getMouth(), sx, sy, true);
  }

  function drawLine(ctx, pts, sx, sy, closed) {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * sx, pts[0].y * sy);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * sx, pts[i].y * sy);
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  return {
    init, start, stop,
    setQuestionIndex,
    getBlob, getMime, getLandmarkLog,
    isSupported, showPanel
  };
})();
