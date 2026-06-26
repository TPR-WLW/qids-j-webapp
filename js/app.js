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
      const n = state.survey ? state.survey.questions.length : 0;
      if (!Array.isArray(obj.answers) || obj.answers.length !== n) return null;
      if (state.survey && obj.surveyId && obj.surveyId !== state.survey.id) return null;
      return obj;
    } catch (e) { return null; }
  }

  function persist() {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        savedAt: Date.now(),
        surveyId: state.survey ? state.survey.id : null,
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
    survey: null,                 // アクティブな量表（surveys/*.json から読み込み）
    answers: [],                  // 量表確定時に長さを確保
    useCamera: false,
    result: null,
    crisisShownForSession: false,
    subject: null,
    sessionName: null
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const screens = {
    subject:  $('subjectScreen'),
    intro:    $('introScreen'),
    baseline: $('baselineScreen'),
    rest:     $('restScreen'),
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
  const scoreMax       = $('scoreMax');
  const severityText   = $('severityText');
  const scoreRing      = $('scoreRing');
  const severityScale  = $('severityScale');
  const resultAdvice   = $('resultAdvice');
  const downloadVideo    = $('downloadVideo');
  const downloadSession  = $('downloadSession');
  const downloadCsv      = $('downloadAnswers');
  const openAnalyzerBtn  = $('openAnalyzerBtn');
  const restartBtn     = $('restartBtn');
  const finishBtn      = $('finishBtn');

  // 量表セレクタ / イントロ動的テキスト
  const surveySelect  = $('surveySelect');
  const introBrand    = $('introBrand');
  const introTitle    = $('introTitle');
  const introSubtitle = $('introSubtitle');
  const introAbout    = $('introAbout');
  const introCaution  = $('introCaution');
  const footerSource  = $('footerSource');

  // ---------- Init ----------
  FaceRecorder.init({
    video:  $('cameraVideo'),
    status: $('cameraStatus'),
    time:   $('recTime'),
    panel:  $('cameraPanel')
  });

  // ============================================================
  //   心率源（ECG=server / PPG=Web Bluetooth）— HeartHub が調停
  //   ・EcgSource: 既存の /api/* 経路（myBeat / WHS-1）
  //   ・PpgSource: Web Bluetooth（XIAO-HR / MAX30102）
  //   ・HeartHub:  有効な源へ start/stop/保存を分配・共有イベント時間線・叠加層
  // ============================================================
  EcgSource.init({ onLog: (lv, m) => console.info('[ECG]', m) });
  PpgSource.init({ onLog: (lv, m) => console.info('[PPG]', m) });
  HeartHub.init({
    overlay:  $('ecgOverlay'),
    survey:  () => state.survey,
    current: () => state.current
  });

  // 被験者 ID をファイル名に使える安全な文字列へ。日本語名など Unicode の文字/数字は
  // 残し（読みやすさのため）、ファイル名に使えない記号・空白のみ '_' に置換する。
  function sanitizeId(raw) {
    const s = (raw || '').normalize('NFC')
      .replace(/[^\p{L}\p{N}_-]+/gu, '_')  // 文字・数字・_・- 以外を _
      .replace(/_+/g, '_')                  // 連続 _ を 1 つに
      .replace(/^_+|_+$/g, '')              // 前後の _ を除去
      .slice(0, 40);
    return s || 'subj';
  }

  function makeSessionName() {
    const id = sanitizeId(state.subject?.id);
    const sid = state.survey ? state.survey.id : 'survey';
    return id + '_' + sid + '_' + timestamp();
  }

  // Start ECG + reset the session timeline. Called when leaving the intro.
  async function beginSession() {
    state.sessionName = makeSessionName();
    await HeartHub.begin(state.sessionName);  // 有効な心率源を起動（未接続でも続行）
  }

  // ============================================================
  //   Survey (量表) selection + loading
  // ============================================================
  let manifestEntries = [];

  async function initSurveys() {
    try {
      manifestEntries = await SurveyEngine.loadManifest();
    } catch (e) {
      console.warn('[survey] manifest load failed', e);
      manifestEntries = [];
    }
    if (surveySelect) {
      surveySelect.innerHTML = '';
      manifestEntries.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.file;
        opt.textContent = m.name;
        opt.dataset.id = m.id;
        if (m.default) opt.selected = true;
        surveySelect.appendChild(opt);
      });
      surveySelect.addEventListener('change', () => loadSelectedSurvey().catch(e => console.warn(e)));
    }
    if (!manifestEntries.length) {
      console.warn('[survey] no surveys in manifest; serve via local server');
      return;
    }
    await loadSelectedSurvey();
  }

  async function loadSelectedSurvey() {
    const file = surveySelect?.value || (manifestEntries[0] && manifestEntries[0].file);
    if (!file) return;
    try {
      setActiveSurvey(await SurveyEngine.load(file));
    } catch (e) {
      console.error('[survey] load failed', e);
    }
  }

  // アクティブ量表を適用：回答配列の確保 + イントロ/結果画面のテキスト・スケール更新
  function setActiveSurvey(survey) {
    state.survey = survey;
    state.answers = new Array(survey.questions.length).fill(null);
    state.current = 0;

    const intro = survey.intro || {};
    if (introBrand)    introBrand.textContent    = intro.brand || survey.shortName || '';
    if (introTitle)    introTitle.textContent    = intro.title || survey.name || '';
    if (introSubtitle) introSubtitle.textContent = intro.subtitle || '';
    if (introAbout && intro.about)     introAbout.innerHTML   = intro.about;
    if (introCaution && intro.caution) introCaution.innerHTML = intro.caution;

    document.title = survey.shortName + ' + ECG | 抑うつ症状チェック';
    if (footerSource && survey.source) {
      const src = survey.source;
      if (src.url) footerSource.innerHTML = '出典：<a href="' + encodeURI(src.url) + '" target="_blank" rel="noopener">' + escapeHtml(src.label || src.url) + '</a>';
      else if (src.label) footerSource.textContent = '出典：' + src.label;
    }

    if (scoreMax) scoreMax.textContent = survey.scoring.maxScore;
    buildSeverityScale(survey);
  }

  function buildSeverityScale(survey) {
    if (!severityScale) return;
    severityScale.innerHTML = '';
    SurveyEngine.bandRanges(survey.severity).forEach(b => {
      const div = document.createElement('div');
      div.className = 'sev-item';
      div.dataset.sev = b.key;
      if (b.color) div.style.setProperty('--sev-color', b.color);
      div.innerHTML = '<span>' + b.lo + ' – ' + b.hi + '</span>' + escapeHtml(b.label);
      severityScale.appendChild(div);
    });
  }

  // ---------- Subject info screen ----------
  function collectSubject() {
    return {
      id:        ($('subjId').value || '').trim(),
      ageBand:   $('subjAge').value || '',
      sex:       $('subjSex').value || '',
      sleep:     $('subjSleep').value || '',
      caffeine:  $('subjCaffeine').value || '',
      exercise:  $('subjExercise').value || '',
      medication:$('subjMed').value || '',
      note:      ($('subjNote').value || '').trim()
    };
  }
  // 氏名/ID に非 ASCII（漢字・かな等）が含まれたらローマ字推奨のヒントを表示（非強制）
  $('subjId')?.addEventListener('input', (e) => {
    const hint = $('subjIdHint');
    if (hint) hint.style.display = /[^\x00-\x7F]/.test(e.target.value) ? '' : 'none';
  });

  $('subjectNext')?.addEventListener('click', async () => {
    const subj = collectSubject();
    if (!subj.id) { alert('氏名 / ID を入力してください（必須）。'); $('subjId').focus(); return; }
    if (!state.survey) {
      await loadSelectedSurvey();
      if (!state.survey) { alert('量表を読み込めませんでした。ローカルサーバ経由で開いているかご確認ください。'); return; }
    }
    state.subject = subj;
    switchScreen('intro');
  });

  // ---------- ECG pairing widget (top-right, setup screens only) ----------
  const pwPanel = $('ecgPairPanel');
  $('ecgPairPill')?.addEventListener('click', () => {
    const opened = pwPanel.classList.toggle('hidden') === false;
    $('ecgPairPill').setAttribute('aria-expanded', opened ? 'true' : 'false');
    if (opened) refreshEcgWidget();
  });
  function pwMsg(t, cls) { const e = $('pwMsg'); if (!e) return; e.textContent = t || ''; e.className = 'pw-msg tiny' + (cls ? (' ' + cls) : ''); }

  const PAIRED_KEY = 'qids_paired_rrd';
  let ecgServerUp = false;   // /api が応答するか（= ECG バックエンド server.py が稼働中か）

  // 左上のサーバ稼働状態インジケータを更新（全画面・常時）
  function setServerBadge(up) {
    ecgServerUp = up;
    const el = $('serverStatus');
    if (el) {
      el.classList.toggle('down', !up);
      const txt = $('srvText'); if (txt) txt.textContent = up ? 'サーバ接続中' : 'サーバ未接続';
    }
  }
  async function pingServer() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const ct = res.headers.get('content-type') || '';
      return res.ok && ct.includes('application/json');
    } catch (e) { return false; }
  }
  async function pollServerBadge() { setServerBadge(await pingServer()); }

  async function refreshEcgWidget() {
    const info = await EcgSource.deviceInfo();
    setServerBadge(!info.error);
    // ECG バックエンドが無い静的配信（GitHub Pages / http.server）では、
    // /ecg/ も /api/* も存在しないため ECG 関連 UI を丸ごと隠す（404 リンク回避）。
    const notice = $('ecgNotice');
    if (notice) notice.style.display = ecgServerUp ? '' : 'none';
    updatePairWidgetVisibility();
    const dot = $('pwDot'), st = $('pwStatus'), inf = $('pwInfo'), devLine = $('ecgDevStatus');
    let ok = false, label, devText;
    if (info.error) {
      label = 'サーバ未接続'; devText = 'サーバ未接続';
    } else if (info.collecting) {
      ok = true; label = '計測中'; devText = '計測中';
    } else if (info.whs && info.rrd_address) {
      // USB sensor present → authoritative match; remember it
      ok = !!info.matches;
      if (ok) { try { localStorage.setItem(PAIRED_KEY, info.rrd_address); } catch (e) {} }
      else    { try { localStorage.removeItem(PAIRED_KEY); } catch (e) {} }
      label = ok ? 'ペア済み ✓' : '未ペア';
      devText = ok ? '受信機 OK · ペア済み（USB）' : '受信機 OK · 未ペア（ペアリングを押す）';
    } else if (info.rrd_address && _pairedRrd() === info.rrd_address) {
      // USB removed but previously paired to this receiver → wireless ready
      ok = true; label = 'ペア済み（無線）'; devText = '受信機 OK · ペア済み（USB 抜去・装着OK）';
    } else if (info.rrd_address) {
      label = '未ペア'; devText = '受信機 OK · 未ペア';
    } else {
      label = '受信機なし'; devText = '受信機が見つかりません';
    }
    if (st)  st.textContent = 'ECG: ' + label;
    if (dot) dot.classList.toggle('bad', !ok);
    if (devLine) { devLine.textContent = devText; devLine.style.color = ok ? '#1f7a4d' : '#b54708'; }
    if (inf) {
      if (info.error) inf.textContent = info.error;
      else {
        const w = info.whs;
        inf.textContent =
          '受信機: ' + (info.rrd_address || '—') + '\n' +
          'USB センサー: ' + (info.whs_count ?? 0) + ' 台' +
          (info.whs_count ? '' : '（装着時は 0 で正常）') + '\n' +
          (w ? ('目標: ' + (w.destination || '—') + '\n') : '') +
          '状態: ' + label;
      }
    }
    return info;
  }
  function _pairedRrd() { try { return localStorage.getItem(PAIRED_KEY); } catch (e) { return null; } }

  // 無線受信テスト：短時間だけ受信して、装着中のセンサーから本当にデータが来るか確認
  async function wirelessTest() {
    pwMsg('無線受信テスト中…（約4秒）');
    try {
      const s1 = await (await fetch('/api/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output: '_wireless_test', duration: 0 })
      })).json();
      if (s1.error) { pwMsg('開始失敗: ' + s1.error, 'err'); return; }
      let got = 0, hr = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        await new Promise(r => setTimeout(r, 600));
        const stt = await (await fetch('/api/status')).json();
        if ((stt.total || 0) > got) { got = stt.total; if (stt.last && stt.last.hr_bpm != null) hr = stt.last.hr_bpm; }
      }
      try { await fetch('/api/stop', { method: 'POST' }); } catch (e) {}
      if (got > 0) {
        // 無線受信できた = ペアリング有効 → 記憶してラベルを更新
        try { const di = await EcgSource.deviceInfo(); if (di.rrd_address) localStorage.setItem(PAIRED_KEY, di.rrd_address); } catch (e) {}
        await refreshEcgWidget();
        pwMsg('無線受信 OK ✓ ' + (hr != null ? ('HR ' + Math.round(hr) + ' bpm') : '') + '（' + got + ' サンプル）'
          + (hr != null && (hr < 40 || hr > 150) ? ' ※電極の接触をご確認ください' : ''), 'ok');
      } else {
        pwMsg('受信なし。センサーの装着・電源 ON・電池・距離をご確認ください。', 'err');
      }
    } catch (e) { pwMsg('テスト失敗: ' + e, 'err'); }
  }

  $('pwRead')?.addEventListener('click', async () => { pwMsg('読み取り中…'); await refreshEcgWidget(); pwMsg(''); });
  $('pwPair')?.addEventListener('click', async () => {
    pwMsg('ペアリング中（USB 接続を確認）…');
    const r = await EcgSource.pair($('pwEcgMode')?.value || '');
    if (r.error) { pwMsg('失敗: ' + r.error, 'err'); return; }
    await refreshEcgWidget();
    pwMsg(r.matches ? 'ペアリング成功 ✓ USB を抜いて装着 → 無線受信テストで確認できます。'
                    : 'ペアリング後も不一致。もう一度お試しください。', r.matches ? 'ok' : 'err');
  });
  $('pwWifi')?.addEventListener('click', wirelessTest);

  function updatePairWidgetVisibility() {
    const w = $('ecgPairWidget'); if (!w) return;
    const setup = screens.subject.classList.contains('active') || screens.intro.classList.contains('active');
    const show = setup && ecgServerUp && HeartHub.isEnabled('ecg');   // ECG 無効 or バックエンド無し → 隠す
    w.classList.toggle('hidden', !show);
    if (!show && pwPanel) pwPanel.classList.add('hidden');  // collapse when hidden
  }

  // ---------- 心拍デバイス選択（PPG / myBeat / 両方・複数可）----------
  const DEVICE_KEY = 'qids-j-heart-devices-v1';
  const devEcg = $('devEcg');
  const devPpg = $('devPpg');
  const ppgControls   = $('ppgControls');
  const ppgConnectBtn = $('ppgConnectBtn');
  const ppgTestBtn    = $('ppgTestBtn');
  const ppgStatus     = $('ppgStatus');
  const ppgWave       = $('ppgWave');
  let ppgWaveTimer = null;
  if (ppgWave) PpgSource.attachCanvas(ppgWave);

  function loadDeviceSelection() {
    let sel = { ecg: false, ppg: false };
    try { sel = { ...sel, ...JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}') }; } catch (e) {}
    if (devEcg) devEcg.checked = !!sel.ecg;
    if (devPpg) devPpg.checked = !!sel.ppg;
  }
  function applyDeviceSelection() {
    const sel = { ecg: !!(devEcg && devEcg.checked), ppg: !!(devPpg && devPpg.checked) };
    HeartHub.setEnabled(sel);
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(sel)); } catch (e) {}
    if (ppgControls) ppgControls.style.display = sel.ppg ? '' : 'none';
    updatePpgStatus();
    updatePairWidgetVisibility();
  }
  function updatePpgStatus() {
    if (!ppgStatus) return;
    if (!PpgSource.isSupported()) { ppgStatus.textContent = 'Web Bluetooth 非対応（Chrome / Edge をご利用ください）'; return; }
    const live = PpgSource.getLive();
    if (ppgConnectBtn) ppgConnectBtn.textContent = live.connected ? '切断' : 'PPG 接続';
    if (!live.connected) { ppgStatus.textContent = '未接続'; return; }
    const bits = [live.online ? '受信中' : '受信なし'];
    if (live.hr != null) bits.push('HR ' + live.hr);
    if (live.spo2 != null) bits.push('SpO₂ ' + live.spo2 + '%');
    if (!live.finger) bits.push('指なし');
    ppgStatus.textContent = bits.join(' · ');
  }
  [devEcg, devPpg].forEach(el => el && el.addEventListener('change', applyDeviceSelection));
  ppgConnectBtn?.addEventListener('click', async () => {
    if (PpgSource.isConnected()) { PpgSource.disconnect(); setTimeout(updatePpgStatus, 200); return; }
    if (!PpgSource.isSupported()) { alert('このブラウザは Web Bluetooth に対応していません。Chrome または Edge をご利用ください。'); return; }
    ppgConnectBtn.disabled = true; if (ppgStatus) ppgStatus.textContent = 'デバイス選択中…';
    try {
      await PpgSource.connect();
      if (!ppgWaveTimer) ppgWaveTimer = setInterval(() => { PpgSource.drawWave(); updatePpgStatus(); }, 250);
    } catch (e) {
      if (ppgStatus) ppgStatus.textContent = '接続失敗: ' + (e.message || e);
    } finally { ppgConnectBtn.disabled = false; updatePpgStatus(); }
  });
  ppgTestBtn?.addEventListener('click', async () => {
    if (!PpgSource.isConnected()) { if (ppgStatus) ppgStatus.textContent = '先に「PPG 接続」を押してください'; return; }
    if (ppgStatus) ppgStatus.textContent = '信号テスト中…（約4秒）';
    const r = await PpgSource.startTest(4000);
    if (ppgStatus) ppgStatus.textContent = r.samples > 0
      ? ('受信 OK ✓ ' + r.samples + ' サンプル' + (r.hr != null ? ' · HR ' + r.hr : '') + (r.finger ? '' : '（指先を光窓に当ててください）'))
      : '受信なし。センサーの電源 ON・距離・装着をご確認ください。';
  });
  loadDeviceSelection();
  applyDeviceSelection();

  updatePairWidgetVisibility();
  refreshEcgWidget();
  initSurveys();   // 量表リストを読み込み、既定の量表を適用
  pollServerBadge();                       // 左上サーバ状態を即時更新
  setInterval(pollServerBadge, 5000);      // 全画面で常時ポーリング
  setInterval(() => {
    if (screens.subject.classList.contains('active') || screens.intro.classList.contains('active')) refreshEcgWidget();
  }, 3000);

  // ---------- Auto-save (no manual export needed) ----------
  async function autoSave() {
    const status = $('autosaveStatus');
    const setS = (t, ok) => {
      if (!status) return;
      status.textContent = t;
      let bg = '#e8f5ee', fg = '#1f7a4d', bd = '#bfe6d0';                          // ok（緑）
      if (ok === false)       { bg = '#fdeceb'; fg = '#b42318'; bd = '#f5c9c5'; }  // エラー（赤）
      else if (ok === 'info') { bg = '#eef4fb'; fg = '#1f5b8f'; bd = '#cfe0f2'; }  // 情報（青）
      status.style.background = bg; status.style.color = fg; status.style.borderColor = bd;
    };

    const session = state.sessionName;

    // camera meta（両経路で使う）
    let camera = null, recorderStartIso = null;
    try { const sl = FaceRecorder.getSessionLog(); camera = sl.meta?.device?.camera || null; recorderStartIso = sl.meta?.sessionStart || null; } catch (e) {}

    // 共通 payload（video はサーバ保存時に付与）
    const payload = {
      session,
      survey: { id: state.survey.id, name: state.survey.name },
      subject: state.subject,
      answers: state.answers.map((a, i) => ({ q: i + 1, title: state.survey.questions[i].title, domain: state.survey.questions[i].domain, score: a })),
      result: state.result,
      events: HeartHub.getEvents(),
      segments: HeartHub.buildSegments(),
      rest_segments: HeartHub.buildRestSegments(),
      video: null,
      camera,
      sync: { hubStartWall: HeartHub.startWall, ecgStartWall: EcgSource.startWall, recorderStartIso }
    };
    HeartHub.attachSavePayload(payload);   // sources フラグ +（PPG 有効時）ppg:{beats, raw}

    // 保存バックエンド（server.py）が無い静的配信では /api/* が無く JSON parse に失敗する。
    // PPG（ブラウザ完結）が有効ならクライアント側のファイル保存にフォールバックする。
    if (!ecgServerUp) {
      if (HeartHub.isEnabled('ppg')) {
        downloadClientSession(payload);
        setS('ローカル保存サーバが無いため、PPG セッションをファイルでダウンロードしました（録画は「手動エクスポート」から）。', 'info');
      } else {
        setS('ローカル保存サーバが無いため、自動保存はスキップされました。必要に応じて下の「手動エクスポート」から保存してください。', 'info');
      }
      return;
    }

    setS('全データを保存中…');

    // 1) 録画アップロード（カメラ使用時）
    const blob = state.useCamera ? FaceRecorder.getBlob() : null;
    if (blob && session) {
      const ext = FaceRecorder.getMime().includes('mp4') ? 'mp4' : 'webm';
      const videoName = session + '.' + ext;
      try { await fetch('/api/upload-video?name=' + encodeURIComponent(videoName), { method: 'POST', body: blob }); payload.video = videoName; }
      catch (e) { console.warn('video upload failed', e); }
    }

    // 2) 統合 session.json + answers.csv +（ECG/PPG）設問別 HRV をサーバ側で算出
    try {
      const res = await fetch('/api/save-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('application/json')) {
        setS('保存に失敗しました（ローカルサーバに接続できません）。start.bat で起動するか、下の「手動エクスポート」をご利用ください。', false);
        return;
      }
      const r = await res.json();
      if (r.error) { setS('保存に失敗しました: ' + r.error, false); return; }
      setS(`✓ 保存しました（${r.files?.length || 0} ファイル・ECG ${r.ecg_samples || 0}・PPG ${r.ppg_beats || 0} 拍・設問別HRV ${r.per_question || 0}）\n保存先: ${r.dir}`, true);
    } catch (e) { setS('保存に失敗しました: ' + e, false); }
  }

  // PPG-only（サーバ無し）用：セッション JSON と PPG 生波形 CSV をブラウザから直接DL
  function downloadClientSession(payload) {
    try {
      const out = { ...payload };
      if (out.ppg && out.ppg.raw) out.ppg = { beats: out.ppg.beats, raw_samples: (out.ppg.raw.idx || []).length };
      downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), (payload.session || 'session') + '.session.json');
      const raw = PpgSource.getRawCsv();
      if (raw && raw.length > 12) downloadBlob(new Blob([raw], { type: 'text/csv' }), (payload.session || 'session') + '.ppg_raw.csv');
    } catch (e) { console.warn('client session download failed', e); }
  }

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
    const vbps = res.height >= 1080 ? 16_000_000 : (res.height >= 720 ? 10_000_000 : 6_000_000);
    const ok = await FaceRecorder.start({ width: res.width, height: res.height, frameRate: fps, videoBitsPerSecond: vbps });
    if (ok) {
      state.useCamera = true;
      await beginSession();        // ECG 採集を開始（ベースラインも記録）
      await runBaselineCapture();  // 3秒の表情ベースライン撮影
      await runRestMeasurement('pre');  // 安静時測定（前・3分）
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

  // ---------- 安静時測定（前/後・3分） ----------
  const REST_DURATION_MS = 3 * 60 * 1000;
  // 全画面の注視十字のみ表示（被験者の認知負荷を最小化）。
  // タイマー／スキップは操作者向けに隅へ控えめに表示。浮動 UI（カメラ/心拍/サーバ）は
  // 全画面の rest スクリーン自体が覆い隠す。
  async function runRestMeasurement(phase) {   // phase: 'pre' | 'post'
    const phaseLabel = $('restPhaseLabel'), cd = $('restCountdown'), restSkip = $('restSkip');
    if (phaseLabel) phaseLabel.textContent = phase === 'pre' ? '安静（前）' : '安静（後）';
    if (cd) cd.textContent = '3:00';

    switchScreen('rest');
    document.body.style.overflow = 'hidden';   // スクロール抑止 → 全画面で浮動 UI を完全に覆う
    HeartHub.logEvent('rest_' + phase + '_start', -1);
    if (state.useCamera) FaceRecorder.logEvent('rest_' + phase + '_start');

    let skipped = false;
    const onSkip = () => { skipped = true; };
    restSkip?.addEventListener('click', onSkip, { once: true });

    const start = performance.now();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (skipped) { clearInterval(timer); resolve(); return; }
        const elapsed = performance.now() - start;
        const remaining = Math.max(0, REST_DURATION_MS - elapsed);
        const s = Math.ceil(remaining / 1000);
        if (cd) cd.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (elapsed >= REST_DURATION_MS) { clearInterval(timer); resolve(); }
      }, 200);
    });

    restSkip?.removeEventListener('click', onSkip);
    document.body.style.overflow = '';   // スクロール抑止を解除
    HeartHub.logEvent('rest_' + phase + '_end', -1);
    if (state.useCamera) FaceRecorder.logEvent('rest_' + phase + '_end', { skipped });
  }

  startNoBtn.addEventListener('click', async () => {
    state.useCamera = false;
    FaceRecorder.showPanel(false);
    await beginSession();   // ECG 採集を開始（カメラ無しでも心電は記録）
    await runRestMeasurement('pre');  // 安静時測定（前・3分）
    goQuiz();
  });

  // ---------- Navigation ----------
  function switchScreen(key) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[key].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (typeof updatePairWidgetVisibility === 'function') updatePairWidgetVisibility();
  }

  function goQuiz() {
    const total = state.survey.questions.length;
    // 前回の未完了セッションがあれば再開するかを尋ねる（カメラなしフロー限定）
    const persisted = loadPersisted();
    if (persisted && !state.useCamera) {
      const filled = persisted.answers.filter(a => a !== null).length;
      if (filled > 0) {
        const resume = confirm(
          `前回の途中までの回答が残っています（${filled}/${total} 問回答済み）。続きから再開しますか？\n\n「キャンセル」を押すと最初からやり直します。`
        );
        if (resume) {
          state.current = Math.min(persisted.current, total - 1);
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
  function renderQuestion() {
    const survey = state.survey;
    const i = state.current;
    const q = survey.questions[i];

    progressText.textContent = `${i + 1} / ${survey.questions.length}`;
    progressDomain.textContent = (survey.domainLabels && survey.domainLabels[q.domain]) || '';
    progressFill.style.width = `${((i + 1) / survey.questions.length) * 100}%`;

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
    nextBtn.textContent = i === survey.questions.length - 1 ? '結果を見る' : '次へ';

    if (state.useCamera) FaceRecorder.setQuestionIndex(i);
    HeartHub.logEvent('question_enter', i);
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
    HeartHub.logEvent('answer_selected', state.current);
    persist();

    // 自殺念慮の設問でしきい値以上 → 危機介入モーダルを即時表示（量表 JSON の crisis 定義で駆動）
    const cq = state.survey.questions[state.current];
    if (cq.crisis && idx >= (cq.crisis.minScore != null ? cq.crisis.minScore : 1)) {
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
    HeartHub.logEvent('question_finalize', state.current);
    if (state.current < state.survey.questions.length - 1) {
      state.current++;
      renderQuestion();
    } else {
      await finish();
    }
  });

  // keyboard: 0/1/2/3 to answer, Enter to advance
  document.addEventListener('keydown', (e) => {
    if (!screens.quiz.classList.contains('active')) return;
    if (/^[0-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10);
      const q = state.survey.questions[state.current];
      if (idx < q.options.length) selectAnswer(idx);
    } else if (e.key === 'Enter' && !nextBtn.disabled) {
      nextBtn.click();
    } else if (e.key === 'ArrowLeft' && !prevBtn.disabled) {
      prevBtn.click();
    }
  });

  // ---------- Finish ----------
  async function finish() {
    const result = SurveyEngine.score(state.survey, state.answers);
    state.result = result;

    await runRestMeasurement('post');  // 安静時測定（後・3分）— ECG/録画は継続中

    if (state.useCamera) {
      nextBtn.disabled = true;
      nextBtn.textContent = '記録停止中…';
      await FaceRecorder.stop();
    }
    await HeartHub.stop();   // 全心率源を停止（叠加層も閉じる）

    clearPersist();  // 完了したら進捗を破棄
    renderResult(result);
    switchScreen('result');
    autoSave().catch(e => console.error('autoSave failed', e));  // 全データを自動保存
  }

  function renderResult(result) {
    scoreNum.textContent = result.total;
    severityText.textContent = result.severity;
    if (scoreMax) scoreMax.textContent = result.maxScore;

    const color = result.color || 'var(--c-primary)';
    const max = result.maxScore || 27;
    scoreRing.style.setProperty('--sev-color', color);
    scoreRing.style.setProperty('--sev-angle', `${(result.total / max) * 360}deg`);
    severityText.style.setProperty('--sev-color', color);

    document.querySelectorAll('#severityScale .sev-item').forEach(el => {
      const active = el.dataset.sev === result.severityKey;
      el.classList.toggle('active', active);
      if (active) {
        el.style.setProperty('--sev-color', color);
        el.style.color = color;   // PHQ-9 等の区間キーは CSS に無いため明示指定
      } else {
        el.style.removeProperty('color');
      }
    });

    resultAdvice.textContent = result.advice || '';

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
    const survey = state.survey;
    const data = FaceRecorder.getSessionLog();
    if (Array.isArray(data.questionSegments)) {
      data.questionSegments = data.questionSegments.map(s => ({
        ...s,
        title:  survey.questions[s.q]?.title  ?? null,
        domain: survey.questions[s.q]?.domain ?? null
      }));
    }
    return {
      ...data,
      survey: { id: survey.id, name: survey.name },
      result: state.result,
      answers: state.answers.map((a, i) => ({ q: i + 1, title: survey.questions[i].title, score: a }))
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
    const survey = state.survey;
    const labels = survey.domainLabels || {};
    const rows = [['No', '項目', 'スコア', '領域']];
    state.answers.forEach((a, i) => {
      const q = survey.questions[i];
      rows.push([q.id, q.title, a ?? '', labels[q.domain] || q.domain || '']);
    });
    rows.push([]);
    rows.push(['合計点', state.result.total]);
    rows.push(['重症度', state.result.severity]);
    const csv = '\uFEFF' + rows.map(r => r.map(escapeCsv).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `${survey.id}_answers_${timestamp()}.csv`);
  });

  // セッションを破棄して被験者情報画面へ戻る（「完了」「もう一度チェックする」共通）
  // 被験者フォームを初期化（次の被験者のため・前の人の情報を残さない）
  function clearSubjectForm() {
    state.subject = null;
    ['subjId', 'subjAge', 'subjSex', 'subjSleep', 'subjCaffeine', 'subjExercise', 'subjMed', 'subjNote']
      .forEach(id => { const el = $(id); if (el) el.value = ''; });
  }

  function resetToStart() {
    clearPersist();
    state.current = 0;
    state.answers = state.survey ? new Array(state.survey.questions.length).fill(null) : [];
    state.result = null;
    state.useCamera = false;
    state.crisisShownForSession = false;
    state.sessionName = null;
    HeartHub.reset();
    FaceRecorder.showPanel(false);
    clearSubjectForm();   // ← 前の被験者の入力をクリア（量表選択とカメラ設定は維持）
    [consentMedical, consentAge, consentData, consentCamera].forEach(el => { el.checked = false; });
    updateStartButtonsDisabled();
    startCamBtn.innerHTML = '<span class="ic">●</span> カメラを使って開始';
    switchScreen('subject');   // 新しい計測 → 被験者情報から
  }

  // 「完了」：そのまま被験者情報画面へ（自動保存済み前提のため確認なし）
  finishBtn?.addEventListener('click', () => resetToStart());

  // 「もう一度チェックする」：未保存の映像がある場合のみ確認してからリセット
  restartBtn.addEventListener('click', () => {
    if (state.useCamera) {
      const confirmed = confirm('記録したデータと映像は失われます。やり直しますか？');
      if (!confirmed) return;
    }
    resetToStart();
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
