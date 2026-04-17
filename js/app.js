/**
 * app.js
 * 画面遷移・1問ずつ表示・採点・結果表示・ダウンロード
 */

(() => {
  // ---------- Persistence ----------
  // 回答の進捗のみ localStorage に保存する（録画/特徴点データはメモリ上のみ）
  const PERSIST_KEY = 'qids-j-progress-v1';
  const PERSIST_TTL_MS = 24 * 60 * 60 * 1000;  // 24時間で自動破棄

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || Date.now() - obj.savedAt > PERSIST_TTL_MS) {
        localStorage.removeItem(PERSIST_KEY);
        return null;
      }
      if (!Array.isArray(obj.answers) || obj.answers.length !== QUESTIONS.length) return null;
      return obj;
    } catch (e) { return null; }
  }

  function persist() {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        savedAt: Date.now(),
        current: state.current,
        answers: state.answers
      }));
    } catch (e) { /* quota/private mode — ignore */ }
  }

  function clearPersist() {
    try { localStorage.removeItem(PERSIST_KEY); } catch (e) {}
  }

  // ---------- State ----------
  const state = {
    current: 0,
    answers: new Array(QUESTIONS.length).fill(null),
    useCamera: false,
    result: null,
    crisisShownForSession: false
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const screens = {
    intro:    $('introScreen'),
    baseline: $('baselineScreen'),
    quiz:     $('quizScreen'),
    result:   $('resultScreen')
  };
  const baselineRing      = $('baselineRing');
  const baselineCountdown = $('baselineCountdown');
  const baselineHint      = $('baselineHint');
  const baselineSkip      = $('baselineSkip');
  const consentMedical = $('consentMedical');
  const consentAge     = $('consentAge');
  const consentData    = $('consentData');
  const consentCamera  = $('consentCamera');
  const startCamBtn    = $('startWithCam');
  const startNoBtn     = $('startNoCam');
  const crisisModal    = $('crisisModal');
  const crisisContinue = $('crisisContinueBtn');

  const progressText   = $('progressText');
  const progressDomain = $('progressDomain');
  const progressFill   = $('progressFill');
  const qNum           = $('qNum');
  const qTitle         = $('qTitle');
  const optionsList    = $('optionsList');
  const prevBtn        = $('prevBtn');
  const nextBtn        = $('nextBtn');

  const scoreNum       = $('scoreNum');
  const severityText   = $('severityText');
  const scoreRing      = $('scoreRing');
  const sevItems       = document.querySelectorAll('.sev-item');
  const resultAdvice   = $('resultAdvice');
  const downloadVideo    = $('downloadVideo');
  const downloadSession  = $('downloadSession');
  const downloadCsv      = $('downloadAnswers');
  const openAnalyzerBtn  = $('openAnalyzerBtn');
  const restartBtn     = $('restartBtn');

  // ---------- Init ----------
  FaceRecorder.init({
    video:  $('cameraVideo'),
    status: $('cameraStatus'),
    time:   $('recTime'),
    panel:  $('cameraPanel')
  });

  // ---------- Intro screen ----------
  function updateStartButtonsDisabled() {
    const baseOk = consentMedical.checked && consentAge.checked && consentData.checked;
    startNoBtn.disabled  = !baseOk;
    startCamBtn.disabled = !(baseOk && consentCamera.checked);
  }
  [consentMedical, consentAge, consentData, consentCamera].forEach(el => {
    el.addEventListener('change', updateStartButtonsDisabled);
  });

  // ---------- Camera settings (persisted to localStorage) ----------
  const CAM_SETTINGS_KEY = 'qids-j-cam-settings-v1';
  const RESOLUTIONS = {
    '480':  { width: 640,  height: 480  },
    '720':  { width: 1280, height: 720  },
    '1080': { width: 1920, height: 1080 }
  };
  const camResSel = $('camResolution');
  const camFpsSel = $('camFramerate');
  function loadCamSettings() {
    try {
      const obj = JSON.parse(localStorage.getItem(CAM_SETTINGS_KEY) || '{}');
      if (obj.resolution && camResSel) camResSel.value = obj.resolution;
      if (obj.frameRate  && camFpsSel) camFpsSel.value = obj.frameRate;
    } catch (e) {}
  }
  function saveCamSettings() {
    try {
      localStorage.setItem(CAM_SETTINGS_KEY, JSON.stringify({
        resolution: camResSel?.value ?? '720',
        frameRate:  camFpsSel?.value ?? '30'
      }));
    } catch (e) {}
  }
  [camResSel, camFpsSel].forEach(el => el?.addEventListener('change', saveCamSettings));
  loadCamSettings();

  startCamBtn.addEventListener('click', async () => {
    if (!FaceRecorder.isSupported()) {
      alert('お使いのブラウザはカメラ録画に対応していません。\n「カメラを使わずに開始」でお進みください。');
      return;
    }
    startCamBtn.disabled = true;
    startCamBtn.innerHTML = '起動中…';
    const res = RESOLUTIONS[camResSel?.value] || RESOLUTIONS['720'];
    const fps = parseInt(camFpsSel?.value || '30', 10);
    const ok = await FaceRecorder.start({ width: res.width, height: res.height, frameRate: fps });
    if (ok) {
      state.useCamera = true;
      await runBaselineCapture();  // 3秒のベースライン撮影を挟む
      goQuiz();
    } else {
      startCamBtn.disabled = false;
      startCamBtn.innerHTML = '<span class="ic">●</span> カメラを使って開始';
      alert('カメラを起動できませんでした。ブラウザのカメラ許可設定をご確認いただくか、「カメラを使わずに開始」をお選びください。');
    }
  });

  // ---------- Baseline capture ----------
  async function runBaselineCapture() {
    switchScreen('baseline');
    const DURATION_MS = 3000;
    let skipped = false;
    const onSkip = () => { skipped = true; };
    baselineSkip.addEventListener('click', onSkip, { once: true });
    FaceRecorder.logEvent('baseline_start');
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        if (skipped) { resolve(); return; }
        const elapsed = performance.now() - start;
        const remaining = Math.max(0, DURATION_MS - elapsed);
        const angle = Math.min(360, (elapsed / DURATION_MS) * 360);
        baselineRing.style.setProperty('--baseline-angle', `${angle}deg`);
        baselineCountdown.textContent = Math.ceil(remaining / 1000);
        if (elapsed >= DURATION_MS) {
          baselineCountdown.textContent = '✓';
          baselineHint.textContent = '完了 — 質問に進みます。';
          setTimeout(resolve, 400);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
    baselineSkip.removeEventListener('click', onSkip);
    FaceRecorder.logEvent('baseline_end', { skipped, durationMs: +(performance.now() - start).toFixed(2) });
  }

  startNoBtn.addEventListener('click', () => {
    state.useCamera = false;
    FaceRecorder.showPanel(false);
    goQuiz();
  });

  // ---------- Navigation ----------
  function switchScreen(key) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[key].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goQuiz() {
    // 前回の未完了セッションがあれば再開するかを尋ねる（カメラなしフロー限定）
    const persisted = loadPersisted();
    if (persisted && !state.useCamera) {
      const filled = persisted.answers.filter(a => a !== null).length;
      if (filled > 0) {
        const resume = confirm(
          `前回の途中までの回答が残っています（${filled}/${QUESTIONS.length} 問回答済み）。続きから再開しますか？\n\n「キャンセル」を押すと最初からやり直します。`
        );
        if (resume) {
          state.current = Math.min(persisted.current, QUESTIONS.length - 1);
          state.answers = [...persisted.answers];
          renderQuestion();
          switchScreen('quiz');
          return;
        }
      }
      clearPersist();
    }
    state.current = 0;
    state.answers.fill(null);
    clearPersist();
    renderQuestion();
    switchScreen('quiz');
  }

  // ---------- Quiz rendering ----------
  const DOMAIN_LABEL = {
    sleep:'睡眠', mood:'気分', appetite:'食欲・体重',
    concentration:'集中力', self:'自己評価', suicide:'死・自殺',
    interest:'興味', energy:'エネルギー', psychomotor:'精神運動'
  };

  function renderQuestion() {
    const i = state.current;
    const q = QUESTIONS[i];

    progressText.textContent = `${i + 1} / ${QUESTIONS.length}`;
    progressDomain.textContent = DOMAIN_LABEL[q.domain] || '';
    progressFill.style.width = `${((i + 1) / QUESTIONS.length) * 100}%`;

    qNum.textContent = `Q${q.id}`;
    qTitle.textContent = q.title;

    optionsList.innerHTML = '';
    q.options.forEach((text, idx) => {
      const li = document.createElement('div');
      li.className = 'option';
      li.setAttribute('role', 'radio');
      li.setAttribute('tabindex', state.answers[i] === idx ? '0' : '-1');
      li.setAttribute('aria-checked', state.answers[i] === idx ? 'true' : 'false');
      li.setAttribute('aria-label', `${idx} 点: ${text}`);
      if (state.answers[i] === idx) li.classList.add('selected');
      li.innerHTML = `
        <div class="option-score" aria-hidden="true">${idx}</div>
        <div class="option-text">${escapeHtml(text)}</div>
      `;
      const choose = () => selectAnswer(idx);
      li.addEventListener('click', choose);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); }
      });
      optionsList.appendChild(li);
    });

    prevBtn.disabled = i === 0;
    nextBtn.disabled = state.answers[i] === null;
    nextBtn.textContent = i === QUESTIONS.length - 1 ? '結果を見る' : '次へ';

    if (state.useCamera) FaceRecorder.setQuestionIndex(i);
  }

  function selectAnswer(idx) {
    state.answers[state.current] = idx;
    // UI
    [...optionsList.children].forEach((el, j) => {
      const sel = j === idx;
      el.classList.toggle('selected', sel);
      el.setAttribute('aria-checked', sel ? 'true' : 'false');
      el.setAttribute('tabindex', sel ? '0' : '-1');
    });
    nextBtn.disabled = false;
    if (state.useCamera) FaceRecorder.logEvent('answer_selected', { a: idx });
    persist();

    // Q12（index 11, 自殺念慮）で 2 以上 → 危機介入モーダルを即時表示
    if (state.current === 11 && idx >= 2) {
      showCrisisModal();
    }
  }

  function showCrisisModal() {
    if (!crisisModal) return;
    if (state.crisisShownForSession) return;  // 1 セッションに 1 度だけ
    state.crisisShownForSession = true;
    crisisModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (state.useCamera) FaceRecorder.logEvent('crisis_modal_shown');
    // フォーカスを Continue ボタンに移す（視覚的インパクトを和らげる）
    setTimeout(() => crisisContinue?.focus(), 100);
  }
  function hideCrisisModal() {
    if (!crisisModal) return;
    crisisModal.classList.add('hidden');
    document.body.style.overflow = '';
    if (state.useCamera) FaceRecorder.logEvent('crisis_modal_closed');
  }
  crisisContinue?.addEventListener('click', hideCrisisModal);
  crisisModal?.addEventListener('click', (e) => { if (e.target === crisisModal) hideCrisisModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !crisisModal.classList.contains('hidden')) hideCrisisModal();
  });

  prevBtn.addEventListener('click', () => {
    if (state.current > 0) {
      state.current--;
      renderQuestion();
    }
  });

  nextBtn.addEventListener('click', async () => {
    if (state.answers[state.current] === null) return;
    if (state.useCamera) {
      FaceRecorder.logEvent('question_finalize', { a: state.answers[state.current] });
    }
    if (state.current < QUESTIONS.length - 1) {
      state.current++;
      renderQuestion();
    } else {
      await finish();
    }
  });

  // keyboard: 0/1/2/3 to answer, Enter to advance
  document.addEventListener('keydown', (e) => {
    if (!screens.quiz.classList.contains('active')) return;
    if (['0','1','2','3'].includes(e.key)) {
      const idx = parseInt(e.key, 10);
      const q = QUESTIONS[state.current];
      if (idx < q.options.length) selectAnswer(idx);
    } else if (e.key === 'Enter' && !nextBtn.disabled) {
      nextBtn.click();
    } else if (e.key === 'ArrowLeft' && !prevBtn.disabled) {
      prevBtn.click();
    }
  });

  // ---------- Finish ----------
  async function finish() {
    const result = calculateScore(state.answers);
    state.result = result;

    if (state.useCamera) {
      nextBtn.disabled = true;
      nextBtn.textContent = '記録停止中…';
      await FaceRecorder.stop();
    }

    clearPersist();  // 完了したら進捗を破棄
    renderResult(result);
    switchScreen('result');
  }

  function renderResult(result) {
    scoreNum.textContent = result.total;
    severityText.textContent = result.severity;

    const sevColors = {
      normal:   'var(--c-normal)',
      mild:     'var(--c-mild)',
      moderate: 'var(--c-moderate)',
      severe:   'var(--c-severe)',
      extreme:  'var(--c-extreme)'
    };
    const color = sevColors[result.severityKey] || 'var(--c-primary)';
    scoreRing.style.setProperty('--sev-color', color);
    scoreRing.style.setProperty('--sev-angle', `${(result.total / 27) * 360}deg`);
    severityText.style.setProperty('--sev-color', color);

    sevItems.forEach(el => {
      el.classList.toggle('active', el.dataset.sev === result.severityKey);
      if (el.dataset.sev === result.severityKey) {
        el.style.setProperty('--sev-color', color);
      }
    });

    const advice = {
      normal:   '現時点では問題となるうつ症状は認められません。今後もご自身の心身の変化に気を配って過ごしてください。',
      mild:     '軽度のうつ症状が疑われます。十分な休養・睡眠・運動を心がけ、症状が2週間以上続く場合は専門機関へのご相談をおすすめします。',
      moderate: '中等度のうつ症状が疑われます。早めに心療内科・精神科などの医療機関にご相談ください。',
      severe:   '重度のうつ症状が疑われます。できるだけ早く医療機関を受診してください。',
      extreme:  'きわめて重度のうつ症状が疑われます。至急、医療機関への受診をお願いいたします。身近な方のサポートも得てください。'
    };
    resultAdvice.textContent = advice[result.severityKey];

    // Downloads / analyze
    const haveRecording = state.useCamera && FaceRecorder.getBlob();
    downloadVideo.disabled    = !haveRecording;
    downloadSession.disabled  = !haveRecording;
    openAnalyzerBtn.disabled  = !haveRecording;
  }

  // ---------- Downloads ----------
  downloadVideo.addEventListener('click', () => {
    const blob = FaceRecorder.getBlob();
    if (!blob) return;
    const mime = FaceRecorder.getMime();
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(blob, `qids-j_recording_${timestamp()}.${ext}`);
  });

  // ---------- Downloads: video + session log ----------
  // 録画中は MediaPipe を動かさないため、ここでは小さなセッション JSON
  // （メタ情報 + events + questionSegments + 回答）のみを書き出す。
  // 特徴点（frames）は Phase 2 で追加される extract.mjs が後から埋める。
  function buildSessionOut() {
    const data = FaceRecorder.getSessionLog();
    if (Array.isArray(data.questionSegments)) {
      data.questionSegments = data.questionSegments.map(s => ({
        ...s,
        title:  QUESTIONS[s.q]?.title  ?? null,
        domain: QUESTIONS[s.q]?.domain ?? null
      }));
    }
    return {
      ...data,
      result: state.result,
      answers: state.answers.map((a, i) => ({ q: i + 1, title: QUESTIONS[i].title, score: a }))
    };
  }

  downloadSession?.addEventListener('click', () => {
    const out = buildSessionOut();
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `qids-j_session_${timestamp()}.json`);
  });

  // ---------- Offline extraction flow (Phase 2) ----------
  const extractModal    = $('extractModal');
  const extractProgress = $('extractProgressBox');
  const extractDoneBox  = $('extractDoneBox');
  const extractPhase    = $('extractPhase');
  const extractFill     = $('extractFill');
  const extractPct      = $('extractPct');
  const extractFrames   = $('extractFrames');
  const extractEta      = $('extractEta');
  const extractThumb    = $('extractThumb');
  const extractThumbPh  = $('extractThumbPlaceholder');
  const extractCancel   = $('extractCancel');
  const extractOpenBtn  = $('extractOpenBtn');
  const extractOpenSameTab = $('extractOpenSameTabBtn');
  const extractCloseBtn = $('extractCloseBtn');
  const extractTitle    = $('extractTitle');
  const extractFpsSel   = $('extractFps');
  const extractSmSel    = $('extractSmoothing');
  let extractAbort = null;

  const PHASE_LABELS = {
    'loading-library':    'MediaPipe 読み込み中…',
    'loading-wasm':       'WASM ランタイム準備中…',
    'fetching-model':     'モデルダウンロード + SHA-384 検証中…',
    'creating-detector':  '検出器を初期化中…',
    'benchmarking':       'GPU/CPU 性能測定中…',
    'preparing-video':    '録画ファイルを解析中…',
    'extracting':         'フレーム抽出中…',
    'finalizing':         '仕上げ中…',
    'done':               '完了',
  };

  function showExtractModal() {
    extractModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    extractProgress.hidden = false;
    extractDoneBox.hidden  = true;
    extractTitle.textContent = '特徴点を抽出中…';
    extractFill.style.width = '0%';
    extractPct.textContent = '0%';
    extractFrames.textContent = '— / — フレーム';
    extractEta.textContent = '残り —';
    extractThumb.hidden = true;
    extractThumbPh.hidden = false;
    extractPhase.textContent = PHASE_LABELS['loading-library'];
  }
  function showExtractDone(handoffId) {
    extractProgress.hidden = true;
    extractDoneBox.hidden  = false;
    extractTitle.textContent = '抽出完了';
    const url = `analyze.html?handoff=${encodeURIComponent(handoffId)}`;
    extractOpenBtn.href = url;
    extractOpenBtn.onclick = () => {
      // Close the modal after the user's click opens the new tab.
      setTimeout(() => hideExtractModal(), 50);
    };
    extractOpenSameTab.onclick = () => {
      location.href = url;
    };
    extractCloseBtn.onclick = () => hideExtractModal();
  }
  function hideExtractModal() {
    extractModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  extractCancel?.addEventListener('click', () => {
    if (extractAbort) extractAbort.abort();
    hideExtractModal();
  });

  openAnalyzerBtn?.addEventListener('click', async () => {
    const videoBlob = FaceRecorder.getBlob();
    if (!videoBlob) return;
    if (extractAbort) return;  // extraction already in progress — ignore extra clicks
    openAnalyzerBtn.disabled = true;

    showExtractModal();
    extractAbort = new AbortController();
    const sessionLog = buildSessionOut();
    const targetFps = parseInt(extractFpsSel?.value || '30', 10);

    try {
      // lazy import the module (loads MediaPipe on demand)
      const mod = await import('./extract.mjs?v=' + Date.now());
      const alpha = parseFloat(extractSmSel?.value || '0');
      const smoothing = alpha > 0 && alpha < 1 ? { alpha } : null;
      const doc = await mod.extractLandmarks({
        sessionLog, videoBlob, targetFps,
        delegate: 'auto',
        smoothing,
        signal: extractAbort.signal,
        onProgress: (info) => {
          const label = PHASE_LABELS[info.phase] || info.phase;
          extractPhase.textContent = label;
          extractFill.style.width = `${Math.max(0, Math.min(100, info.pct ?? 0)).toFixed(1)}%`;
          extractPct.textContent  = `${(info.pct ?? 0).toFixed(0)}%`;
          if (info.framesTotal) {
            extractFrames.textContent = `${info.framesDone ?? 0} / ${info.framesTotal} フレーム`;
          }
          if (info.etaSec != null) {
            extractEta.textContent = `残り ${formatEta(info.etaSec)}`;
          }
          if (info.thumbDataUrl) {
            extractThumb.src = info.thumbDataUrl;
            extractThumb.hidden = false;
            extractThumbPh.hidden = true;
          }
        }
      });

      // Handoff to the analyze page — but don't auto-open a new tab here,
      // because browsers block window.open() that isn't attached to an
      // active user gesture (we've been awaiting extract for minutes).
      // Instead, transform the modal into a "done" state with an explicit
      // button the user clicks → window.open runs inside that gesture →
      // no popup blocker.
      const id = await saveHandoff(doc);
      showExtractDone(id);
    } catch (e) {
      hideExtractModal();
      if (e?.name === 'AbortError') {
        console.info('Extraction cancelled by user');
      } else {
        console.error('Extraction failed', e);
        alert('抽出に失敗しました: ' + (e?.message || String(e)));
      }
    } finally {
      extractAbort = null;
      // Re-enable only if a recording is still present
      openAnalyzerBtn.disabled = !(state.useCamera && FaceRecorder.getBlob());
    }
  });

  function formatEta(sec) {
    if (sec < 60) return `${Math.round(sec)}秒`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}分${s}秒`;
  }

  // ---------- IndexedDB handoff (shared with analyze page) ----------
  const HANDOFF_DB = 'qids-j-handoff';
  const HANDOFF_STORE = 'handoffs';
  function openHandoffDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HANDOFF_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDOFF_STORE)) {
          db.createObjectStore(HANDOFF_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async function saveHandoff(data) {
    const db = await openHandoffDb();
    const id = 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDOFF_STORE, 'readwrite');
      const store = tx.objectStore(HANDOFF_STORE);
      store.put({ id, data, createdAt: Date.now() });
      const cutoff = Date.now() - 60 * 60 * 1000;
      store.openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) {
          if (cur.value.createdAt < cutoff && cur.value.id !== id) cur.delete();
          cur.continue();
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return id;
  }

  downloadCsv.addEventListener('click', () => {
    const rows = [['No', '項目', 'スコア(0-3)', '領域']];
    state.answers.forEach((a, i) => {
      rows.push([QUESTIONS[i].id, QUESTIONS[i].title, a ?? '', DOMAIN_LABEL[QUESTIONS[i].domain] || '']);
    });
    rows.push([]);
    rows.push(['合計点', state.result.total]);
    rows.push(['重症度', state.result.severity]);
    const csv = '\uFEFF' + rows.map(r => r.map(escapeCsv).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `qids-j_answers_${timestamp()}.csv`);
  });

  restartBtn.addEventListener('click', () => {
    if (state.useCamera) {
      const confirmed = confirm('記録したデータと映像は失われます。やり直しますか？');
      if (!confirmed) return;
    }
    clearPersist();
    state.current = 0;
    state.answers.fill(null);
    state.result = null;
    state.useCamera = false;
    state.crisisShownForSession = false;
    FaceRecorder.showPanel(false);
    [consentMedical, consentAge, consentData, consentCamera].forEach(el => { el.checked = false; });
    updateStartButtonsDisabled();
    startCamBtn.innerHTML = '<span class="ic">●</span> カメラを使って開始';
    switchScreen('intro');
  });

  // ---------- Utils ----------
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function timestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }
  function escapeCsv(v) {
    const s = String(v ?? '');
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  // Warn before page unload if answers in progress
  window.addEventListener('beforeunload', (e) => {
    if (screens.quiz.classList.contains('active') && state.answers.some(a => a !== null)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
