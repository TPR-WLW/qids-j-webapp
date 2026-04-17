/**
 * recorder.js (v2: recording-only, no MediaPipe)
 *
 * - Captures webcam video with MediaRecorder
 * - Logs question / answer / baseline events with performance.now() timestamps
 * - Produces a small session JSON (metadata + events + questionSegments)
 *
 * All facial landmark extraction happens AFTER the quiz, offline, via js/extract.mjs.
 * This keeps the quiz UI perfectly responsive on any hardware.
 */

const FaceRecorder = (() => {
  // ---- DOM ----
  let videoEl, statusEl, timeEl, panelEl;

  // ---- Media ----
  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let recordedBlob = null;
  let recordedMime = 'video/webm';
  let recorderFirstDataMs = null;

  // ---- Timing ----
  let sessionStartIso = null;
  let perfStartMs = 0;
  let timerId = null;
  let stopRequested = false;

  // ---- Session log ----
  const events = [];
  let currentQuestionIndex = 0;

  // ============================================================
  //                     Public API
  // ============================================================

  async function init(ui) {
    videoEl  = ui.video;
    statusEl = ui.status;
    timeEl   = ui.time;
    panelEl  = ui.panel;
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

      recordedMime = pickMime();
      mediaRecorder = new MediaRecorder(stream, { mimeType: recordedMime });
      chunks = [];
      recorderFirstDataMs = null;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          if (recorderFirstDataMs === null) {
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
      setStatus('録画中');
      stopRequested = false;
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

    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        await new Promise((resolve) => {
          mediaRecorder.addEventListener('stop', resolve, { once: true });
          mediaRecorder.stop();
        });
      }
    } catch (e) { console.warn(e); }

    // Snapshot camera metadata *before* we tear the stream down
    const cameraMeta = captureCameraMeta();

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
    setStatus('記録停止');

    // Stash for inclusion in the final session JSON
    _finalCameraMeta = cameraMeta;
  }

  function setQuestionIndex(i) {
    currentQuestionIndex = i;
    logEvent('question_enter');
  }

  function logEvent(type, extra) {
    const rec = {
      event: type,
      t: +(performance.now() - perfStartMs).toFixed(2),
      q: currentQuestionIndex
    };
    if (extra) Object.assign(rec, extra);
    events.push(rec);
  }

  function getBlob() { return recordedBlob; }
  function getMime() { return recordedMime; }

  /** The recording session log — video-less metadata + events only.
   *  Offline extraction (js/extract.mjs) fills in the frames[] later. */
  function getSessionLog() {
    return {
      meta: {
        sessionStart: sessionStartIso,
        runtime: 'recording-only (v2); extraction deferred',
        targetFps: null,       // filled in by extraction
        mirrored: true,        // CSS-mirrored preview; stored pts will be in raw video coords
        pointCount: null,      // filled in by extraction
        blendshapeCount: null, // filled in by extraction
        ptsFormat: null,
        matFormat: null,
        timeBase: 'performance.now() ms relative to recording start',
        recorderFirstDataOffsetMs: recorderFirstDataMs,
        recordedMime,
        eventTypes: ['question_enter', 'answer_selected', 'question_finalize',
                     'baseline_start', 'baseline_end',
                     'crisis_modal_shown', 'crisis_modal_closed'],
        device: collectDeviceMeta(),
        notes: [
          'This session was recorded with the v2 pipeline (MediaRecorder only).',
          'Landmarks, blendshapes, and head-pose data are not present here — extract them ' +
            'post-hoc from the webm via js/extract.mjs or the analyze.html drop zone.'
        ]
      },
      questionSegments: computeQuestionSegments(),
      events
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

  let _finalCameraMeta = null;

  function captureCameraMeta() {
    try {
      if (!stream) return null;
      const track = stream.getVideoTracks()[0];
      if (!track || !track.getSettings) return null;
      const s = track.getSettings();
      return {
        width: s.width, height: s.height, frameRate: s.frameRate,
        facingMode: s.facingMode, deviceId: s.deviceId ? 'present' : null
      };
    } catch (e) { return null; }
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
    if (_finalCameraMeta) meta.camera = _finalCameraMeta;
    return meta;
  }

  function computeQuestionSegments() {
    const segs = Object.create(null);
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

    let currentQ = null, currentEnter = null, lastT = 0;
    for (const f of events) {
      if (typeof f.t === 'number' && f.t > lastT) lastT = f.t;
      if (f.event === 'question_enter') {
        if (currentQ !== null && currentEnter !== null) {
          getSeg(currentQ).activeTimeRanges.push([currentEnter, f.t]);
        }
        getSeg(f.q).enterTimes.push(f.t);
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
    if (currentQ !== null && currentEnter !== null) {
      getSeg(currentQ).activeTimeRanges.push([currentEnter, lastT]);
    }

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

  return {
    init, start, stop,
    setQuestionIndex, logEvent,
    getBlob, getMime,
    getSessionLog,
    isSupported, showPanel
  };
})();
