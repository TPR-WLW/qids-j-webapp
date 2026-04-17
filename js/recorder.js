/**
 * recorder.js  (MediaPipe FaceLandmarker 版)
 *
 * - カメラ映像を MediaRecorder で webm 保存
 * - MediaPipe FaceLandmarker で 478 点 3D ランドマーク + 52 blendshape
 *   + 4×4 頭部変換行列 を 30 fps で記録
 * - 時間基準は performance.now()（単調増加）
 * - 取得データはブラウザ内だけで保持し、download 時のみ gzip 圧縮して書き出す
 *
 * 外部 CDN:
 *  - ESM: https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs
 *  - WASM: https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm
 *  - Model: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
 */

const FaceRecorder = (() => {
  // ---- DOM ----
  let videoEl, canvasEl, statusEl, timeEl, panelEl, poseEl;

  // ---- Media ----
  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let recordedBlob = null;
  let recordedMime = 'video/webm';
  let recorderFirstDataMs = null;  // MediaRecorder 最初の data-available との時間基オフセット

  // ---- Timing ----
  let sessionStartIso = null;   // 人間可読な開始日時
  let perfStartMs = 0;          // performance.now() のゼロ点
  let timerId = null;
  let detectionTimerId = null;
  let detectionRunning = false;
  let stopRequested = false;

  // ---- MediaPipe ----
  let vision = null;            // dynamic import の結果
  let FaceLandmarkerCls = null; // class
  let DrawingUtilsCls = null;
  let faceLandmarker = null;
  let modelsLoaded = false;

  const MODULE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
  const WASM_BASE  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
  // 同一オリジンで自ホストした決定論的モデル
  const MODEL_URL  = 'models/face_landmarker.task';
  // このハッシュは models/face_landmarker.task を更新するときに書き換える
  const MODEL_SHA384 = 'sha384-tYQh+yJE8llY+zO4RviZmWaSKs5W9tsB0ix5rjQVpF5/CLTqmwtP7bYtkUi2w65P';

  // ---- Detection config ----
  const TARGET_FPS = 30;
  const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
  const POINT_PRECISION = 4;   // toFixed digits for landmarks
  const SCORE_PRECISION = 4;   // toFixed digits for blendshape scores
  const MATRIX_PRECISION = 5;  // toFixed digits for transformation matrix

  // ---- Data ----
  const frames = [];            // push-only log
  let currentQuestionIndex = 0;
  let lastFaceSeenAt = -Infinity;
  let faceLostNoticeShown = false;

  // ============================================================
  //                     Public API
  // ============================================================

  async function init(ui) {
    videoEl  = ui.video;
    canvasEl = ui.canvas;
    statusEl = ui.status;
    timeEl   = ui.time;
    panelEl  = ui.panel;
    poseEl   = ui.pose;
  }

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

      syncCanvasSize();
      window.addEventListener('resize', syncCanvasSize);

      recordedMime = pickMime();
      mediaRecorder = new MediaRecorder(stream, { mimeType: recordedMime });
      chunks = [];
      recorderFirstDataMs = null;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          if (recorderFirstDataMs === null) {
            // 最初のチャンク（この時点で録画はすでに開始直後。perfStart との差は通常 ~1秒）
            recorderFirstDataMs = +(performance.now() - perfStartMs).toFixed(2);
          }
          chunks.push(e.data);
        }
      };
      mediaRecorder.onstop = () => { recordedBlob = new Blob(chunks, { type: recordedMime }); };
      mediaRecorder.start(1000);

      sessionStartIso = new Date().toISOString();
      perfStartMs = performance.now();
      startTimer();

      setStatus('解析モデル読み込み中…');
      await loadModels();

      setStatus('初期化中…');
      await warmup();
      setStatus('録画中・解析中');

      stopRequested = false;
      scheduleDetect();
      return true;
    } catch (err) {
      console.error('[FaceRecorder] start error', err);
      setStatus('カメラ利用不可: ' + (err.message || err.name || 'error'));
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

  function setQuestionIndex(i) {
    currentQuestionIndex = i;
    logEvent('question_enter');
  }

  /**
   * 任意のイベントを frames 列に記録する。
   * 例: logEvent('answer_selected', { a: 2 })
   *     logEvent('question_finalize', { a: 2 })
   */
  function logEvent(type, extra) {
    const rec = {
      event: type,
      t: +(performance.now() - perfStartMs).toFixed(2),
      q: currentQuestionIndex
    };
    if (extra) Object.assign(rec, extra);
    frames.push(rec);
  }

  function getBlob()  { return recordedBlob; }
  function getMime()  { return recordedMime; }

  function getLandmarkLog() {
    // 検出フレーム統計
    const detectFrames = frames.filter(f => f.pts);
    let actualFps = null;
    let droppedFrames = null;
    if (detectFrames.length >= 2) {
      const durSec = (detectFrames[detectFrames.length - 1].t - detectFrames[0].t) / 1000;
      actualFps = +(detectFrames.length / durSec).toFixed(2);
      // 期待フレーム数は durSec * TARGET_FPS；失われた分
      droppedFrames = Math.max(0, Math.round(durSec * TARGET_FPS) - detectFrames.length);
    }

    return {
      meta: {
        sessionStart: sessionStartIso,
        videoWidth: videoEl ? videoEl.videoWidth : 0,
        videoHeight: videoEl ? videoEl.videoHeight : 0,
        runtime: '@mediapipe/tasks-vision@0.10.14',
        modelUrl: MODEL_URL,
        modelSha384: MODEL_SHA384,
        targetFps: TARGET_FPS,
        actualFps,
        droppedFrames,
        mirrored: true,
        pointCount: 478,
        blendshapeCount: 52,
        ptsFormat: 'array of [x, y, z], each normalized to input frame (x,y in 0..1; z is relative depth)',
        matFormat: '16 floats, 4x4 facial transformation matrix, column-major',
        timeBase: 'performance.now() ms relative to recording start',
        recorderFirstDataOffsetMs: recorderFirstDataMs,  // MediaRecorder の時間基と landmark の時間基のオフセット
        recordedMime,
        eventTypes: ['question_enter', 'answer_selected', 'question_finalize',
                     'face_lost', 'face_found', 'crisis_modal_shown', 'crisis_modal_closed'],
        device: collectDeviceMeta(),
        notes: [
          'frames include event markers interleaved with 30fps detection rows.',
          'questionSegments summarizes per-question timing & activity; use activeTimeRanges to slice frames.',
          'mirrored=true means the visual overlay is flipped; stored pts are in raw (non-mirrored) frame coordinates.',
          'recorderFirstDataOffsetMs: subtract this from landmark t to align with webm playback time.'
        ]
      },
      questionSegments: computeQuestionSegments(),
      frames
    };
  }

  function collectDeviceMeta() {
    const meta = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemoryGB: navigator.deviceMemory || null,
      devicePixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    // WebGL renderer 情報（GPU 推定に使用）
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          meta.webglVendor   = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
          meta.webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        } else {
          meta.webglVendor   = gl.getParameter(gl.VENDOR);
          meta.webglRenderer = gl.getParameter(gl.RENDERER);
        }
      }
    } catch (e) { /* best effort */ }
    // カメラ track settings
    try {
      if (stream) {
        const track = stream.getVideoTracks()[0];
        if (track && track.getSettings) {
          const s = track.getSettings();
          meta.camera = {
            width: s.width, height: s.height, frameRate: s.frameRate,
            facingMode: s.facingMode, deviceId: s.deviceId ? 'present' : null
          };
        }
      }
    } catch (e) { /* best effort */ }
    return meta;
  }

  /**
   * events を走査し、問題ごとの入退出時刻・活動範囲・回答イベントをまとめる。
   * frames には event 行と検出行が混在しているが、この関数は event 行のみを使う。
   */
  function computeQuestionSegments() {
    const segs = Object.create(null);  // q -> segment
    const getSeg = (q) => {
      if (!segs[q]) {
        segs[q] = {
          q,
          questionNumber: q + 1,
          enterTimes: [],
          firstAnswerTime: null,
          lastAnswerTime: null,
          finalAnswer: null,
          finalizeTime: null,
          answerEventCount: 0,
          activeTimeRanges: [],
          activeDurationMs: 0
        };
      }
      return segs[q];
    };

    let currentQ = null;
    let currentEnter = null;
    let lastFrameT = 0;

    for (const f of frames) {
      if (typeof f.t === 'number' && f.t > lastFrameT) lastFrameT = f.t;

      if (f.event === 'question_enter') {
        // 前の active range を閉じる
        if (currentQ !== null && currentEnter !== null) {
          getSeg(currentQ).activeTimeRanges.push([currentEnter, f.t]);
        }
        const s = getSeg(f.q);
        s.enterTimes.push(f.t);
        currentQ = f.q;
        currentEnter = f.t;
      } else if (f.event === 'answer_selected') {
        const s = getSeg(f.q);
        if (s.firstAnswerTime === null) s.firstAnswerTime = f.t;
        s.lastAnswerTime = f.t;
        if (typeof f.a === 'number') s.finalAnswer = f.a;
        s.answerEventCount++;
      } else if (f.event === 'question_finalize') {
        const s = getSeg(f.q);
        s.finalizeTime = f.t;
        if (typeof f.a === 'number') s.finalAnswer = f.a;
      }
    }

    // 最後の open な range を閉じる（最終フレームの時刻で）
    if (currentQ !== null && currentEnter !== null) {
      getSeg(currentQ).activeTimeRanges.push([currentEnter, lastFrameT]);
    }

    // 合計時間を計算
    const result = [];
    const keys = Object.keys(segs).map(k => +k).sort((a, b) => a - b);
    for (const q of keys) {
      const s = segs[q];
      s.activeDurationMs = +s.activeTimeRanges
        .reduce((acc, [a, b]) => acc + Math.max(0, b - a), 0)
        .toFixed(2);
      result.push(s);
    }
    return result;
  }

  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function showPanel(show) {
    if (!panelEl) return;
    panelEl.classList.toggle('hidden', !show);
    panelEl.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  // ============================================================
  //                     Internal
  // ============================================================

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
    if (!rect.width || !rect.height) return;
    canvasEl.width  = Math.floor(rect.width  * devicePixelRatio);
    canvasEl.height = Math.floor(rect.height * devicePixelRatio);
    canvasEl.style.width  = rect.width + 'px';
    canvasEl.style.height = rect.height + 'px';
  }

  function startTimer() {
    stopTimer();
    timerId = setInterval(() => {
      if (!perfStartMs || !timeEl) return;
      const s = Math.floor((performance.now() - perfStartMs) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      timeEl.textContent = `${mm}:${ss}`;
    }, 500);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  async function loadModels() {
    if (modelsLoaded) return;
    // Dynamic import keeps this file as a classic script (no <script type="module"> required).
    vision = await import(MODULE_URL);
    FaceLandmarkerCls = vision.FaceLandmarker;
    DrawingUtilsCls   = vision.DrawingUtils;
    const filesetResolver = await vision.FilesetResolver.forVisionTasks(WASM_BASE);

    // モデルは自ホストし、ロード時に SHA-384 を検証する（サプライチェーン防御）
    const modelBuffer = await fetchVerified(MODEL_URL, MODEL_SHA384);

    faceLandmarker = await FaceLandmarkerCls.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetBuffer: new Uint8Array(modelBuffer),
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true
    });

    modelsLoaded = true;
  }

  async function fetchVerified(url, expectedHashB64) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`fetch failed: ${url} -> HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (expectedHashB64 && crypto.subtle && crypto.subtle.digest) {
      const digest = await crypto.subtle.digest('SHA-384', buf);
      const got = 'sha384-' + btoa(String.fromCharCode(...new Uint8Array(digest)));
      if (got !== expectedHashB64) {
        throw new Error(`integrity mismatch for ${url}: expected ${expectedHashB64}, got ${got}`);
      }
    }
    return buf;
  }

  // ダミー推論で GPU パイプラインを事前に温めておく
  async function warmup() {
    try {
      const dummy = document.createElement('canvas');
      dummy.width = 320; dummy.height = 240;
      const c = dummy.getContext('2d');
      const g = c.createLinearGradient(0, 0, dummy.width, dummy.height);
      g.addColorStop(0, '#888'); g.addColorStop(1, '#333');
      c.fillStyle = g;
      c.fillRect(0, 0, dummy.width, dummy.height);
      // detectForVideo はタイムスタンプが単調増加していれば OK
      faceLandmarker.detectForVideo(dummy, 0);
    } catch (e) {
      // 失敗しても致命的ではない
    }
  }

  function scheduleDetect() {
    if (stopRequested) return;
    detectionTimerId = setTimeout(runDetect, FRAME_INTERVAL_MS);
  }

  function runDetect() {
    if (stopRequested) return;
    if (detectionRunning) { scheduleDetect(); return; }
    if (!modelsLoaded || !videoEl || videoEl.readyState < 2) { scheduleDetect(); return; }

    detectionRunning = true;
    const t = performance.now();
    const tRel = t - perfStartMs;

    try {
      const result = faceLandmarker.detectForVideo(videoEl, t);
      drawOverlay(result);

      if (result && result.faceLandmarks && result.faceLandmarks.length > 0) {
        const wasLost = faceLostNoticeShown;
        lastFaceSeenAt = t;
        if (wasLost) {
          faceLostNoticeShown = false;
          setStatus('録画中・解析中');
          logEvent('face_found');
        }

        const lmks = result.faceLandmarks[0]; // NormalizedLandmark[]
        const pts = new Array(lmks.length);
        for (let i = 0; i < lmks.length; i++) {
          pts[i] = [
            +lmks[i].x.toFixed(POINT_PRECISION),
            +lmks[i].y.toFixed(POINT_PRECISION),
            +lmks[i].z.toFixed(POINT_PRECISION)
          ];
        }

        const bs = {};
        if (result.faceBlendshapes && result.faceBlendshapes[0]) {
          for (const cat of result.faceBlendshapes[0].categories) {
            bs[cat.categoryName] = +cat.score.toFixed(SCORE_PRECISION);
          }
        }

        let mat = null;
        if (result.facialTransformationMatrixes && result.facialTransformationMatrixes[0]) {
          const raw = result.facialTransformationMatrixes[0].data;
          mat = new Array(raw.length);
          for (let i = 0; i < raw.length; i++) mat[i] = +raw[i].toFixed(MATRIX_PRECISION);
        }

        frames.push({
          t: +tRel.toFixed(2),
          q: currentQuestionIndex,
          pts, bs, mat
        });

        updatePoseReadout(mat);
      } else {
        // 顔が検出されていない
        if (!faceLostNoticeShown && (t - lastFaceSeenAt) > 1500) {
          setStatus('顔を枠内に…');
          faceLostNoticeShown = true;
          if (poseEl) poseEl.textContent = '';
          logEvent('face_lost');
        }
      }
    } catch (e) {
      console.warn('[FaceRecorder] detect error', e);
    } finally {
      detectionRunning = false;
      scheduleDetect();
    }
  }

  // ------------------------------------------------------------
  // Overlay drawing
  //   - canvas は CSS 側で水平反転されているので、ctx 側の反転は不要
  //   - MediaPipe DrawingUtils.drawConnectors は、正規化座標 × canvas サイズ
  //     で描画してくれる
  // ------------------------------------------------------------
  function drawOverlay(result) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) return;
    if (!DrawingUtilsCls || !FaceLandmarkerCls) return;

    const du = new DrawingUtilsCls(ctx);
    const lmks = result.faceLandmarks[0];

    const lw = Math.max(1, 1 * devicePixelRatio);
    const meshColor = 'rgba(108, 180, 160, 0.55)';
    const lineColor = 'rgba(108, 180, 160, 0.9)';
    const irisColor = 'rgba(91, 143, 185, 0.95)';

    // Light tesselation for the face mesh (opacity low)
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_TESSELATION,
      { color: meshColor, lineWidth: lw * 0.5 });

    // Key landmark groups
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_FACE_OVAL,      { color: lineColor, lineWidth: lw });
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_LIPS,           { color: lineColor, lineWidth: lw });
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_LEFT_EYE,       { color: lineColor, lineWidth: lw });
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_RIGHT_EYE,      { color: lineColor, lineWidth: lw });
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_LEFT_EYEBROW,   { color: lineColor, lineWidth: lw });
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_RIGHT_EYEBROW,  { color: lineColor, lineWidth: lw });
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_LEFT_IRIS,      { color: irisColor, lineWidth: lw });
    du.drawConnectors(lmks, FaceLandmarkerCls.FACE_LANDMARKS_RIGHT_IRIS,     { color: irisColor, lineWidth: lw });
  }

  // 4x4 column-major → approximate yaw/pitch/roll (deg)
  function updatePoseReadout(mat) {
    if (!poseEl || !mat) return;
    // m[col*4+row]
    // Rotation part:
    //   r00 = m[0], r10 = m[1], r20 = m[2]
    //   r01 = m[4], r11 = m[5], r21 = m[6]
    //   r02 = m[8], r12 = m[9], r22 = m[10]
    const r00 = mat[0],  r10 = mat[1],  r20 = mat[2];
    const r01 = mat[4],  r11 = mat[5],  r21 = mat[6];
    const r02 = mat[8],  r12 = mat[9],  r22 = mat[10];
    void r10; void r01;

    const yawRad   = Math.atan2(r02, r22);            // Y rotation
    const pitchRad = Math.asin(Math.max(-1, Math.min(1, -r12)));  // X rotation
    const rollRad  = Math.atan2(r20, r11);            // Z rotation (近似)

    const deg = (r) => (r * 180 / Math.PI).toFixed(0);
    poseEl.textContent = `Y${deg(yawRad)}° P${deg(pitchRad)}° R${deg(rollRad)}°`;
  }

  return {
    init, start, stop,
    setQuestionIndex, logEvent,
    getBlob, getMime, getLandmarkLog,
    isSupported, showPanel
  };
})();
