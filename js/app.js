/**
 * app.js
 * 画面遷移・1問ずつ表示・採点・結果表示・ダウンロード
 */

(() => {
  // ---------- State ----------
  const state = {
    current: 0,
    answers: new Array(QUESTIONS.length).fill(null),
    useCamera: false,
    result: null
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const screens = {
    intro:  $('introScreen'),
    quiz:   $('quizScreen'),
    result: $('resultScreen')
  };
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
  const downloadVideo  = $('downloadVideo');
  const downloadLm     = $('downloadLandmarks');
  const downloadLmRaw  = $('downloadLandmarksRaw');
  const downloadCsv    = $('downloadAnswers');
  const restartBtn     = $('restartBtn');

  // ---------- Init ----------
  FaceRecorder.init({
    video:  $('cameraVideo'),
    canvas: $('overlayCanvas'),
    status: $('cameraStatus'),
    time:   $('recTime'),
    panel:  $('cameraPanel'),
    pose:   $('poseBadge')
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

  startCamBtn.addEventListener('click', async () => {
    if (!FaceRecorder.isSupported()) {
      alert('お使いのブラウザはカメラ録画に対応していません。\n「カメラを使わずに開始」でお進みください。');
      return;
    }
    startCamBtn.disabled = true;
    startCamBtn.innerHTML = '起動中…';
    const ok = await FaceRecorder.start();
    if (ok) {
      state.useCamera = true;
      goQuiz();
    } else {
      startCamBtn.disabled = false;
      startCamBtn.innerHTML = '<span class="ic">●</span> カメラを使って開始';
      alert('カメラを起動できませんでした。ブラウザのカメラ許可設定をご確認いただくか、「カメラを使わずに開始」をお選びください。');
    }
  });

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
    state.current = 0;
    state.answers.fill(null);
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

    // Downloads
    if (state.useCamera && FaceRecorder.getBlob()) {
      downloadVideo.disabled   = false;
      downloadLm.disabled      = false;
      downloadLmRaw.disabled   = false;
    } else {
      downloadVideo.disabled   = true;
      downloadLm.disabled      = true;
      downloadLmRaw.disabled   = true;
    }
  }

  // ---------- Downloads ----------
  downloadVideo.addEventListener('click', () => {
    const blob = FaceRecorder.getBlob();
    if (!blob) return;
    const mime = FaceRecorder.getMime();
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(blob, `qids-j_recording_${timestamp()}.${ext}`);
  });

  // ---------- Landmark downloads ----------
  function buildLandmarkOut() {
    const data = FaceRecorder.getLandmarkLog();
    // 問題タイトル・ドメインを questionSegments に注入
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

  downloadLm.addEventListener('click', async () => {
    const out = buildLandmarkOut();
    const json = JSON.stringify(out);
    downloadLm.disabled = true;
    const prevLabel = downloadLm.textContent;
    downloadLm.textContent = '圧縮中…';
    try {
      const blob = await gzipJson(json);
      downloadBlob(blob, `qids-j_landmarks_${timestamp()}.json.gz`);
    } catch (e) {
      console.warn('gzip failed, falling back to raw json', e);
      const blob = new Blob([json], { type: 'application/json' });
      downloadBlob(blob, `qids-j_landmarks_${timestamp()}.json`);
      alert('お使いのブラウザは gzip 圧縮に未対応のため、非圧縮 JSON を保存しました。');
    } finally {
      downloadLm.disabled = false;
      downloadLm.textContent = prevLabel;
    }
  });

  downloadLmRaw.addEventListener('click', () => {
    const out = buildLandmarkOut();
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    downloadBlob(blob, `qids-j_landmarks_${timestamp()}.json`);
  });

  // CompressionStream('gzip') は Chrome 80+, Edge 80+, Firefox 113+, Safari 16.4+
  async function gzipJson(jsonStr) {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('CompressionStream not supported');
    }
    const enc = new TextEncoder().encode(jsonStr);
    const cs = new CompressionStream('gzip');
    const stream = new Blob([enc]).stream().pipeThrough(cs);
    return await new Response(stream).blob();
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
