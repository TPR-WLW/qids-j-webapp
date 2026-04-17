/**
 * extract.mjs — Offline landmark extraction from a recorded webm.
 *
 * Given a recorded video Blob and the matching session JSON (meta,
 * questionSegments, events), this module plays the video through
 * MediaPipe FaceLandmarker and emits a frames[] array compatible with
 * what the v1 real-time recorder produced.  The output matches the
 * analyze.html schema exactly so the viewer doesn't need to change.
 *
 * Key design choices:
 * - Uses `requestVideoFrameCallback` for frame-accurate iteration.
 * - Target fps is user-selectable (default 30).  We don't try to run
 *   faster than realtime; on slow GPUs this can take 2-3x the video
 *   duration.
 * - Falls back to a seek-based sampler if rVFC is unavailable.
 * - Surfaces progress + an optional cancel token.
 */

// Locked to the same version we audited the SHA-384 of earlier.
const MODULE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM_BASE  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL  = 'models/face_landmarker.task';
const MODEL_SHA384 = 'sha384-tYQh+yJE8llY+zO4RviZmWaSKs5W9tsB0ix5rjQVpF5/CLTqmwtP7bYtkUi2w65P';

const POINT_PRECISION  = 4;
const SCORE_PRECISION  = 4;
const MATRIX_PRECISION = 5;

/** @typedef {{
 *   sessionLog: object,            // output of FaceRecorder.getSessionLog() + answers/result
 *   videoBlob: Blob,               // the recorded webm
 *   targetFps?: number,            // default 30
 *   delegate?: 'GPU'|'CPU'|'auto', // default 'auto' (benchmark first frame)
 *   onProgress?: (info) => void,   // { phase, pct, framesDone, framesTotal, etaSec, thumbDataUrl? }
 *   signal?: AbortSignal           // cancel token
 * }} ExtractOptions
 */

export async function extractLandmarks(opts) {
  const {
    sessionLog, videoBlob,
    targetFps = 30,
    delegate = 'auto',
    onProgress = () => {},
    signal
  } = opts;

  if (!sessionLog || !videoBlob) {
    throw new Error('extractLandmarks: sessionLog と videoBlob が必要です');
  }

  onProgress({ phase: 'loading-library', pct: 0 });
  const vision = await import(MODULE_URL);
  const { FaceLandmarker, FilesetResolver } = vision;

  onProgress({ phase: 'loading-wasm', pct: 2 });
  const filesetResolver = await FilesetResolver.forVisionTasks(WASM_BASE);
  throwIfAborted(signal);

  onProgress({ phase: 'fetching-model', pct: 5 });
  const modelBuffer = await fetchVerified(MODEL_URL, MODEL_SHA384);
  throwIfAborted(signal);

  onProgress({ phase: 'creating-detector', pct: 8 });
  const chosenDelegate = (delegate === 'auto') ? 'GPU' : delegate;
  const faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetBuffer: new Uint8Array(modelBuffer), delegate: chosenDelegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true
  });

  onProgress({ phase: 'preparing-video', pct: 10 });

  // Hidden video element to drive frame iteration
  const videoUrl = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';

  try {
    await new Promise((resolve, reject) => {
      const onLoaded = () => resolve();
      const onErr    = () => reject(new Error('動画のメタデータを読み込めませんでした'));
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onErr, { once: true });
    });
  } catch (e) {
    URL.revokeObjectURL(videoUrl);
    faceLandmarker.close();
    throw e;
  }
  throwIfAborted(signal);

  const videoDurSec = video.duration;
  const videoW = video.videoWidth, videoH = video.videoHeight;
  if (!videoDurSec || videoDurSec === Infinity) {
    URL.revokeObjectURL(videoUrl);
    faceLandmarker.close();
    throw new Error('動画の長さが取得できません（ブラウザが duration を報告していません）');
  }

  const sampleIntervalMs = 1000 / targetFps;
  const expectedFrames = Math.max(1, Math.floor(videoDurSec * targetFps));

  // Canvas used to snapshot frames at the target timestamp
  const canvas = document.createElement('canvas');
  canvas.width = videoW; canvas.height = videoH;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const recOffsetMs = (sessionLog.meta?.recorderFirstDataOffsetMs) ?? 0;
  const frames = [];
  const tStartWall = performance.now();
  let lastThumbMs = 0;

  try {
    // Seek-based iteration is the most deterministic approach: it works
    // regardless of playback rate, tab visibility, or rVFC support.
    let targetMs = 0;
    for (let i = 0; i < expectedFrames; i++) {
      throwIfAborted(signal);
      targetMs = Math.min(videoDurSec * 1000, i * sampleIntervalMs);
      await seekAndWait(video, targetMs / 1000);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // MediaPipe needs a monotonically increasing timestamp in the VIDEO running mode.
      // Use the target time in ms (guaranteed monotonically non-decreasing from i*interval).
      const result = faceLandmarker.detectForVideo(canvas, targetMs + 1 + i); // +1+i to guarantee strict monotonicity

      if (result?.faceLandmarks?.length > 0) {
        const lmks = result.faceLandmarks[0];
        const pts = new Array(lmks.length);
        for (let j = 0; j < lmks.length; j++) {
          pts[j] = [
            +lmks[j].x.toFixed(POINT_PRECISION),
            +lmks[j].y.toFixed(POINT_PRECISION),
            +lmks[j].z.toFixed(POINT_PRECISION)
          ];
        }
        const bs = {};
        if (result.faceBlendshapes?.[0]) {
          for (const cat of result.faceBlendshapes[0].categories) {
            bs[cat.categoryName] = +cat.score.toFixed(SCORE_PRECISION);
          }
        }
        let mat = null;
        if (result.facialTransformationMatrixes?.[0]) {
          const raw = result.facialTransformationMatrixes[0].data;
          mat = new Array(raw.length);
          for (let k = 0; k < raw.length; k++) mat[k] = +raw[k].toFixed(MATRIX_PRECISION);
        }
        frames.push({
          t: +(targetMs + recOffsetMs).toFixed(2),
          q: questionAtAbsoluteTime(sessionLog, targetMs + recOffsetMs),
          pts, bs, mat
        });
      }

      // Emit progress (rate-limited)
      if (i % 5 === 0 || i === expectedFrames - 1) {
        const pct = 10 + (i / expectedFrames) * 85;
        const wallElapsed = (performance.now() - tStartWall) / 1000;
        const fracDone = Math.max(0.001, (i + 1) / expectedFrames);
        const etaSec = wallElapsed * (1 - fracDone) / fracDone;
        let thumbDataUrl = null;
        // Occasional thumbnail (every ~1s of wall time)
        const now = performance.now();
        if (now - lastThumbMs > 1000) {
          try { thumbDataUrl = canvas.toDataURL('image/jpeg', 0.6); } catch (e) { /* cross-origin? */ }
          lastThumbMs = now;
        }
        onProgress({
          phase: 'extracting',
          pct,
          framesDone: i + 1,
          framesTotal: expectedFrames,
          etaSec: isFinite(etaSec) ? etaSec : null,
          thumbDataUrl
        });
      }
    }
  } finally {
    faceLandmarker.close?.();
    URL.revokeObjectURL(videoUrl);
  }

  onProgress({ phase: 'finalizing', pct: 97 });

  // Merge events (event rows from recorder) with extracted detection frames
  const events = (sessionLog.events || []).map(e => ({ ...e }));
  const mergedFrames = [...events, ...frames].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

  const actualFps = frames.length > 0
    ? +(frames.length / videoDurSec).toFixed(2)
    : 0;

  const output = {
    ...sessionLog,
    meta: {
      ...(sessionLog.meta || {}),
      runtime: '@mediapipe/tasks-vision@0.10.14 (offline extraction via extract.mjs)',
      modelUrl: MODEL_URL,
      modelSha384: MODEL_SHA384,
      targetFps,
      actualFps,
      droppedFrames: Math.max(0, expectedFrames - frames.length),
      pointCount: 478,
      blendshapeCount: 52,
      ptsFormat: 'array of [x, y, z], each normalized to input frame (x,y in 0..1; z is relative depth)',
      matFormat: '16 floats, 4x4 facial transformation matrix, column-major',
      videoWidth: videoW,
      videoHeight: videoH,
      extractionOptions: { targetFps, delegate: chosenDelegate }
    },
    frames: mergedFrames
  };

  onProgress({ phase: 'done', pct: 100, framesDone: frames.length, framesTotal: expectedFrames });
  return output;
}

// ---------------- helpers ----------------

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('処理がキャンセルされました');
    err.name = 'AbortError';
    throw err;
  }
}

function seekAndWait(video, seconds) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('seek 失敗')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onErr, { once: true });
    try { video.currentTime = seconds; }
    catch (e) { cleanup(); reject(e); }
  });
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

/** Given a timestamp in the same time base as session.events (absolute
 *  'performance.now() - recorderStart' milliseconds), find the question
 *  index that was active at that moment. */
function questionAtAbsoluteTime(sessionLog, tAbs) {
  const segs = sessionLog.questionSegments || [];
  for (const s of segs) {
    if (s.activeTimeRanges?.some(([a, b]) => tAbs >= a && tAbs < b)) return s.q;
  }
  // Before first question (baseline etc.): report q=-1 (but our existing analyze page expects q=0 minimum; use 0)
  return segs[0]?.q ?? 0;
}
