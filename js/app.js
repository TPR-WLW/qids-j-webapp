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
      // 被験者が違えば絶対に復元しない（別人の回答を引き継ぐ事故＝クロス被験者汚染の防止）。
      // 旧フォーマット（subjectId 無し）も安全側に倒して破棄する。
      const curId = (state.subject && state.subject.id) ? sanitizeId(state.subject.id) : null;
      if (!obj.subjectId || !curId || obj.subjectId !== curId) { localStorage.removeItem(PERSIST_KEY); return null; }
      // カメラ有りセッションの途中回答は、映像・基線が対応しないため復元対象にしない。
      if (obj.useCamera) { localStorage.removeItem(PERSIST_KEY); return null; }
      return obj;
    } catch (e) { return null; }
  }

  function persist() {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        savedAt: Date.now(),
        surveyId: state.survey ? state.survey.id : null,
        subjectId: (state.subject && state.subject.id) ? sanitizeId(state.subject.id) : null,   // 復元は同一被験者のみ
        useCamera: !!state.useCamera,
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
  PpgSource.init({ onLog: (lv, m) => console.info('[PPG]', m), onData: () => schedulePpgDraw() });
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
    // ミリ秒まで含めてセッション名を一意にする（同一 ID を同じ秒内に開始しても
    // 別人/別回のファイルを黙って上書きしないように — ECG CSV は開始時にこの名前で
    // 書かれるため、生成時点で一意にするのが安全）。
    const ms = String(new Date().getMilliseconds()).padStart(3, '0');
    return id + '_' + sid + '_' + timestamp() + ms;
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

  // ---------- 被験者情報の記憶（身分情報のみ：ID・年齢層・性別。当日の状態は毎回入力） ----------
  const SUBJECT_KEY = 'qids-j-subject-v1';
  const subjRememberEl   = $('subjRemember');
  const subjClearSavedEl = $('subjClearSaved');
  function readSavedSubject() {
    try { return JSON.parse(localStorage.getItem(SUBJECT_KEY) || 'null'); } catch (e) { return null; }
  }
  // 保存済みの身分情報をフォームへ復元（あれば記憶チェック ON・消去ボタン表示）
  function loadSavedSubject() {
    const saved = readSavedSubject();
    if (saved) {
      if (saved.id      != null) $('subjId').value  = saved.id;
      if (saved.ageBand != null) $('subjAge').value = saved.ageBand;
      if (saved.sex     != null) $('subjSex').value = saved.sex;
      if (subjRememberEl) subjRememberEl.checked = true;
    }
    if (subjClearSavedEl) subjClearSavedEl.style.display = saved ? '' : 'none';
    $('subjId')?.dispatchEvent(new Event('input'));   // ローマ字ヒントを再評価
  }
  // 記憶チェックが ON なら身分情報のみ保存、OFF なら削除
  function persistSubjectPref(subj) {
    const on = !!(subjRememberEl && subjRememberEl.checked);
    try {
      if (on) localStorage.setItem(SUBJECT_KEY, JSON.stringify({ id: subj.id, ageBand: subj.ageBand, sex: subj.sex }));
      else    localStorage.removeItem(SUBJECT_KEY);
    } catch (e) {}
    if (subjClearSavedEl) subjClearSavedEl.style.display = on ? '' : 'none';
  }
  subjClearSavedEl?.addEventListener('click', () => {
    try { localStorage.removeItem(SUBJECT_KEY); } catch (e) {}
    if (subjRememberEl) subjRememberEl.checked = false;
    ['subjId', 'subjAge', 'subjSex'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    subjClearSavedEl.style.display = 'none';
    $('subjId')?.dispatchEvent(new Event('input'));
    $('subjId')?.focus();
  });

  $('subjectNext')?.addEventListener('click', async () => {
    const subj = collectSubject();
    if (!subj.id) { alert('氏名 / ID を入力してください（必須）。'); $('subjId').focus(); return; }
    if (!state.survey) {
      await loadSelectedSurvey();
      if (!state.survey) { alert('量表を読み込めませんでした。ローカルサーバ経由で開いているかご確認ください。'); return; }
    }
    state.subject = subj;
    persistSubjectPref(subj);   // 記憶 ON なら身分情報のみ localStorage に保存
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
  const ppgDot        = $('ppgDot');
  const ppgMetrics    = $('ppgMetrics');
  const ppgHr         = $('ppgHr');
  const ppgSpo2       = $('ppgSpo2');
  const ppgSps        = $('ppgSps');
  const ppgFinger     = $('ppgFinger');
  const ppgWarn       = $('ppgWarn');
  let ppgWaveTimer = null;
  let ppgConnectedAt = 0, ppgEverOnline = false, ppgLastOnlineAt = 0;   // 占有/受信途絶 検出用
  let ppgAutoRecovered = false, ppgRecovering = false;   // ゾンビ接続の自動リカバリ（1回だけ）
  let ppgFlashMsg = '', ppgFlashUntil = 0;         // 信号テスト結果を数秒間だけ状態行に表示
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
    // 既授権デバイスの有無を探ってボタン表示を「再接続」に切替（選択ダイアログ無しで繋げる）
    if (sel.ppg && PpgSource.isSupported()) PpgSource.probeGranted().then(updatePpgStatus).catch(() => {});
    updatePairWidgetVisibility();
  }
  function setPpgDot(kind) { if (ppgDot) ppgDot.className = 'ppg-dot ' + kind; }
  function setPpgStatusText(t) {
    // 信号テスト結果があれば数秒間はそれを優先表示（ドット色は実状態のまま）
    if (Date.now() < ppgFlashUntil) { ppgStatus.textContent = ppgFlashMsg; return; }
    ppgStatus.textContent = t;
  }
  function updatePpgStatus() {
    if (!ppgStatus) return;
    const knownLabel = PpgSource.hasGranted() ? 'PPG 再接続' : 'PPG 接続';

    if (!PpgSource.isSupported()) {
      setPpgDot('off'); setPpgStatusText('Web Bluetooth 非対応（Chrome / Edge を）');
      if (ppgMetrics) ppgMetrics.style.display = 'none';
      if (ppgWarn) ppgWarn.style.display = 'none';
      return;
    }
    const live = PpgSource.getLive();
    if (ppgConnectBtn) ppgConnectBtn.textContent = live.connected ? '切断' : knownLabel;

    if (!live.connected) {
      setPpgDot('off');
      setPpgStatusText(PpgSource.hasGranted() ? '未接続（1タップで再接続できます）' : '未接続');
      if (ppgMetrics) ppgMetrics.style.display = 'none';
      if (ppgWarn) ppgWarn.style.display = 'none';
      return;
    }

    // 接続済み：メトリクス表示 + 状態判定
    if (ppgMetrics) ppgMetrics.style.display = '';
    if (live.online) ppgEverOnline = true;
    const sps = PpgSource.getSps ? PpgSource.getSps() : null;
    const hrShow = live.hrInst != null ? live.hrInst : live.hr;   // ライブは瞬時 HR 優先
    if (ppgHr)     ppgHr.textContent     = hrShow != null ? hrShow : '–';
    if (ppgSpo2)   ppgSpo2.textContent   = live.spo2 != null ? live.spo2 : '–';
    if (ppgSps)    ppgSps.textContent    = live.online && sps != null ? (Math.round(sps / 5) * 5) : '0';   // 5 刻みで表示 → ちらつき解消
    if (ppgFinger) ppgFinger.textContent = live.online ? (live.finger ? '✓' : '✗') : '–';

    const now = Date.now();
    const sinceConnect = ppgConnectedAt ? (now - ppgConnectedAt) : 0;
    if (live.online) {
      setPpgDot('ok');
      const devName = (PpgSource.getDeviceInfo && PpgSource.getDeviceInfo() || {}).name || '';
      setPpgStatusText((live.finger ? '受信中' : '受信中（指先を光窓に当ててください）') + (devName ? ' — ' + devName : ''));
      if (ppgWarn) ppgWarn.style.display = 'none';
      ppgLastOnlineAt = now;
      ppgAutoRecovered = false;   // 復帰したので次のゾンビにも自動リカバリ可
    } else if (ppgRecovering) {
      setPpgDot('wait'); setPpgStatusText('受信途絶 → 自動再接続中…');
      if (ppgWarn) ppgWarn.style.display = 'none';
    } else {
      // 未 online。受信が途絶えている時間を測る：一度でも受信していれば最後の受信時刻から、
      // 未受信なら接続時刻から。「一度受信 → その後途絶」（=データ流通後の半開）も拾えるようにする。
      const stallMs = ppgEverOnline ? (now - ppgLastOnlineAt) : sinceConnect;
      if (stallMs > 3000) {
        // 3秒以上データなし＝半開/ゾンビ/占有。まず自動で1回だけ切断→再接続（既授権のみ・ダイアログ無し）。
        if (!ppgAutoRecovered && PpgSource.hasGranted()) {
          setPpgDot('wait'); setPpgStatusText('受信途絶 → 自動再接続中…');
          if (ppgWarn) ppgWarn.style.display = 'none';
          ppgAutoRecover();
        } else {
          setPpgDot('err');
          setPpgStatusText('受信なし（復帰せず）');
          if (ppgWarn) {
            ppgWarn.className = 'ppg-warn';
            ppgWarn.style.display = '';
            ppgWarn.innerHTML = '⚠️ <strong>3秒以上データが届いていません</strong>（自動再接続でも復帰せず）。'
              + 'ESP32 は接続断（conn=0）と認識しているのに Chrome 側が接続を掴んだままの<strong>半開／ゾンビ接続</strong>の可能性が高いです。<br>'
              + '対処：① <strong>ESP32 を電源入れ直し</strong>（最も確実）　② OS の Bluetooth 設定でこの機器を「切断／削除」（<strong>ペアリングしない</strong>）　③「切断」→ もう一度「接続」。';
          }
        }
      } else {
        setPpgDot('wait');
        setPpgStatusText(ppgEverOnline ? '受信が一時中断…' : '受信待ち…');
        if (ppgWarn) ppgWarn.style.display = 'none';
      }
    }
  }
  // 波形描画はパケット到着（onData）から rAF で駆動 → 250ms タイマ待ちのレイテンシを排除。
  // 複数パケットが 1 フレーム内に来ても 1 回に合流（coalesce）。
  let ppgDrawPending = false;
  function schedulePpgDraw() {
    if (ppgDrawPending) return;
    ppgDrawPending = true;
    requestAnimationFrame(() => { ppgDrawPending = false; try { PpgSource.drawWave(); } catch (e) {} });
  }
  // ゾンビ/半開接続の自動リカバリ：切断 → 少し待って再接続（既授権デバイスなのでダイアログ無し）。
  async function ppgAutoRecover() {
    ppgRecovering = true; ppgAutoRecovered = true;
    try {
      PpgSource.disconnect();
      await new Promise(r => setTimeout(r, 900));   // BlueZ が ACL を落とす猶予
      // 1 回きりだと「デバイス再起動中で 1 回目が失敗 → 以後 PPG 死亡」になるため、
      // バックオフ付きで最大 5 回再試行。ジェスチャ無し文脈なので noPrompt
      // （選択ダイアログへのフォールバックは必ず失敗するのでスキップ）。
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await PpgSource.connect({ noPrompt: true });
          ppgConnectedAt = Date.now(); ppgEverOnline = false;   // 占有検出タイマーを再スタート
          return;
        } catch (e) {
          console.info(`[PPG] auto-recover attempt ${attempt}/5 failed:`, e && (e.message || e));
          if (attempt < 5) await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    } finally { ppgRecovering = false; }
  }
  [devEcg, devPpg].forEach(el => el && el.addEventListener('change', applyDeviceSelection));
  ppgConnectBtn?.addEventListener('click', async () => {
    if (ppgRecovering) { updatePpgStatus(); return; }   // 自動リカバリ中の手動操作は無視（connect 競合の防止）
    if (PpgSource.isConnected()) {
      PpgSource.disconnect();
      ppgConnectedAt = 0; ppgEverOnline = false; ppgFlashUntil = 0; ppgAutoRecovered = false;
      setTimeout(updatePpgStatus, 200); return;
    }
    if (!PpgSource.isSupported()) { alert('このブラウザは Web Bluetooth に対応していません。Chrome または Edge をご利用ください。'); return; }
    ppgConnectBtn.disabled = true; setPpgDot('wait'); ppgStatus.textContent = PpgSource.hasGranted() ? '再接続中…' : 'デバイス選択中…';
    try {
      await PpgSource.connect();
      ppgConnectedAt = Date.now(); ppgEverOnline = false; ppgAutoRecovered = false;   // 占有検出タイマーの起点
      // 状態更新＋兜底の波形描画を 250ms 周期で（データ到着時は onData→rAF が低遅延で先に描く）。
      // 兜底があるので、データが来ない間も「受信待ち…」基線が表示され、真っ黒で固まらない。
      if (!ppgWaveTimer) ppgWaveTimer = setInterval(() => { updatePpgStatus(); PpgSource.drawWave(); }, 250);
    } catch (e) {
      setPpgDot('err'); ppgStatus.textContent = '接続失敗: ' + (e.message || e);
    } finally { ppgConnectBtn.disabled = false; updatePpgStatus(); }
  });
  ppgTestBtn?.addEventListener('click', async () => {
    if (!PpgSource.isConnected()) { ppgFlashMsg = '先に「PPG 接続」を押してください'; ppgFlashUntil = Date.now() + 4000; updatePpgStatus(); return; }
    ppgFlashMsg = '信号テスト中…（約4秒）'; ppgFlashUntil = Date.now() + 5000; updatePpgStatus();
    const r = await PpgSource.startTest(4000);
    ppgFlashMsg = r.samples > 0
      ? ('受信 OK ✓ ' + r.samples + ' サンプル' + (r.hr != null ? ' · HR ' + r.hr : '') + (r.finger ? '' : '（指先を当ててください）'))
      : '受信なし。占有・電源・装着をご確認ください';
    ppgFlashUntil = Date.now() + 4000; updatePpgStatus();
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
      baseline_segment: HeartHub.buildBaselineSegment(),
      interaction: HeartHub.buildInteraction(),   // 設問ごとの反応時間/滞在時間/回答変更履歴
      video: null,
      camera,
      sync: { hubStartWall: HeartHub.startWall, ecgStartWall: EcgSource.startWall, recorderStartIso },
      sentAt: Date.now()   // サーバが自時計と比較して clock_skew_ms を記録（ECG↔ブラウザ時計の同一性検証用）
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
    let videoUploadFailed = false;
    if (blob && session) {
      const ext = FaceRecorder.getMime().includes('mp4') ? 'mp4' : 'webm';
      const videoName = session + '.' + ext;
      try {
        const vres = await fetch('/api/upload-video?name=' + encodeURIComponent(videoName), { method: 'POST', body: blob });
        // HTTP エラー（500/413 等）でも fetch は resolve する。res.ok を確認しないと
        // 実在しない動画ファイル名が session.json に記録される。
        if (vres.ok) payload.video = videoName;
        else { videoUploadFailed = true; console.warn('video upload failed: HTTP', vres.status); }
      } catch (e) { videoUploadFailed = true; console.warn('video upload failed', e); }
    }

    // 2) 統合 session.json + answers.csv +（ECG/PPG）設問別 HRV をサーバ側で算出
    // サーバがページ読込後に落ちた場合（ecgServerUp は最大 5 秒前の状態）、ここで失敗すると
    // PPG データの保存先が消える → クライアントDLにフォールバックして絶対にデータを失わない。
    const fallbackToClient = (msg) => {
      if (HeartHub.isEnabled('ppg')) {
        downloadClientSession(payload);
        setS(msg + ' PPG セッションをファイルでダウンロードしました。録画は「手動エクスポート」から保存してください。', false);
      } else {
        setS(msg + ' 下の「手動エクスポート」から保存してください。', false);
      }
    };
    try {
      const res = await fetch('/api/save-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('application/json')) {
        fallbackToClient('サーバ保存に失敗しました（ローカルサーバに接続できません）。');
        return;
      }
      const r = await res.json();
      if (r.error) { fallbackToClient('サーバ保存に失敗しました: ' + r.error + '。'); return; }
      const videoNote = videoUploadFailed ? '\n⚠ 録画のアップロードに失敗しました — 「手動エクスポート」から動画を保存してください。' : '';
      setS(`✓ 保存しました（${r.files?.length || 0} ファイル・ECG ${r.ecg_samples || 0}・PPG ${r.ppg_beats || 0} 拍・設問別HRV ${r.per_question || 0}）\n保存先: ${r.dir}${videoNote}`, videoUploadFailed ? false : true);
    } catch (e) { fallbackToClient('サーバ保存に失敗しました: ' + (e.message || e) + '。'); }
  }

  // PPG-only（サーバ無し）用：セッション JSON と PPG 生波形 CSV をブラウザから直接DL
  function downloadClientSession(payload) {
    try {
      const out = { ...payload };
      out.schema = 'qids-session-client-v1';   // クライアント直DL版：生入力のみ（HRV/phases はサーバ未算出。beats/segments から再計算可）
      // サーバ保存の session.json とスキーマを揃える：
      // ・イベント配列のキーは qids_events（サーバ/手動エクスポートと同一）
      // ・ppg.beats は常に配列、件数は beats_count（サーバは beats_count + csv ポインタ）
      out.qids_events = out.events; delete out.events;
      if (out.ppg && out.ppg.raw) {
        out.ppg = {
          device: out.ppg.device || null,
          beats: out.ppg.beats,
          beats_count: out.ppg.beats_count != null ? out.ppg.beats_count : (out.ppg.beats || []).length,
          rawAnchors: out.ppg.rawAnchors || [],
          raw_samples: (out.ppg.raw.idx || []).length
        };
      }
      downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), (payload.session || 'session') + '.session.json');
      const raw = PpgSource.getRawCsv();
      if (raw && raw.length > 12) downloadBlob(new Blob([raw], { type: 'text/csv' }), (payload.session || 'session') + '.ppg_raw.csv');
    } catch (e) { console.warn('client session download failed', e); }
  }

  // ---------- Intro screen ----------
  function updateStartButtonsDisabled() {
    if (sessionStarting) return;   // 開始処理中は相互ロックを優先（同意チェック操作でロックが外れないように）
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
  loadSavedSubject();   // 記憶済みの被験者身分情報（ID・年齢層・性別）を初期表示に復元

  // ---------- 安静時間の設定（前/後・秒。既定 180s=3分。0 で省略） ----------
  const REST_SETTINGS_KEY = 'qids-j-rest-settings-v1';
  const DEFAULT_REST_SEC = 20;
  const restPreEl = $('restPreSec'), restPostEl = $('restPostSec');
  function clampRestSec(v) {
    v = Math.round(Number(v));
    if (!isFinite(v) || v < 0) v = DEFAULT_REST_SEC;
    return Math.min(900, Math.max(0, v));   // 0〜900 秒（15分）
  }
  function loadRestSettings() {
    try {
      const o = JSON.parse(localStorage.getItem(REST_SETTINGS_KEY) || '{}');
      if (restPreEl  && o.preSec  != null) restPreEl.value  = clampRestSec(o.preSec);
      if (restPostEl && o.postSec != null) restPostEl.value = clampRestSec(o.postSec);
    } catch (e) {}
  }
  function saveRestSettings() {
    if (restPreEl)  restPreEl.value  = clampRestSec(restPreEl.value);   // 入力を正規化
    if (restPostEl) restPostEl.value = clampRestSec(restPostEl.value);
    try {
      localStorage.setItem(REST_SETTINGS_KEY, JSON.stringify({
        preSec:  clampRestSec(restPreEl?.value ?? DEFAULT_REST_SEC),
        postSec: clampRestSec(restPostEl?.value ?? DEFAULT_REST_SEC)
      }));
    } catch (e) {}
  }
  function getRestDurationMs(phase) {
    const el = phase === 'pre' ? restPreEl : restPostEl;
    return clampRestSec(el ? el.value : DEFAULT_REST_SEC) * 1000;
  }
  [restPreEl, restPostEl].forEach(el => el?.addEventListener('change', saveRestSettings));
  loadRestSettings();

  // セッション開始の相互ロック：カメラ許可ダイアログが開いている間に
  // もう一方の開始ボタンを押すと 2 つの開始フローが交錯し、2 回目の beginSession が
  // 進行中の回答・時間線を破壊する。開始処理中は両ボタンを無効化する。
  let sessionStarting = false;
  function lockStartButtons(lock) {
    sessionStarting = lock;
    if (startCamBtn) startCamBtn.disabled = lock;
    if (startNoBtn) startNoBtn.disabled = lock;
  }

  startCamBtn.addEventListener('click', async () => {
    if (sessionStarting) return;
    if (!FaceRecorder.isSupported()) {
      alert('お使いのブラウザはカメラ録画に対応していません。\n「カメラを使わずに開始」でお進みください。');
      return;
    }
    lockStartButtons(true);
    startCamBtn.innerHTML = '起動中…';
    const res = RESOLUTIONS[camResSel?.value] || RESOLUTIONS['720'];
    const fps = parseInt(camFpsSel?.value || '30', 10);
    const vbps = res.height >= 1080 ? 16_000_000 : (res.height >= 720 ? 10_000_000 : 6_000_000);
    const ok = await FaceRecorder.start({ width: res.width, height: res.height, frameRate: fps, videoBitsPerSecond: vbps });
    if (ok) {
      state.useCamera = true;
      await beginSession();        // ECG 採集を開始（ベースラインも記録）
      await runBaselineCapture();  // 表情ベースライン撮影
      await runRestMeasurement('pre');  // 安静時測定（前）
      goQuiz();
    } else {
      lockStartButtons(false);
      startCamBtn.innerHTML = '<span class="ic">●</span> カメラを使って開始';
      alert('カメラを起動できませんでした。ブラウザのカメラ許可設定をご確認いただくか、「カメラを使わずに開始」をお選びください。');
    }
  });

  // ---------- Baseline capture ----------
  async function runBaselineCapture() {
    switchScreen('baseline');
    const DURATION_MS = 3000;
    // 前の被験者の「完了」表示・リングの残留をクリア
    baselineCountdown.textContent = '3';
    baselineHint.textContent = '画面を正面から見て、リラックスしてお待ちください。';
    baselineRing.style.setProperty('--baseline-angle', '0deg');
    let skipped = false;
    const onSkip = () => { skipped = true; };
    baselineSkip.addEventListener('click', onSkip, { once: true });
    HeartHub.logEvent('baseline_start', -1);   // 統一時間線（墙钟）にも記録 → segments と同一基準
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
    const baselineDurationMs = +(performance.now() - start).toFixed(2);
    HeartHub.logEvent('baseline_end', -1, { skipped, durationMs: baselineDurationMs });
    FaceRecorder.logEvent('baseline_end', { skipped, durationMs: baselineDurationMs });
  }

  // ---------- 安静時測定（前/後・長さは「測定設定」で可変。既定 180s、0 で省略） ----------
  // 全画面の注視十字のみ表示（被験者の認知負荷を最小化）。
  // タイマー／スキップは操作者向けに隅へ控えめに表示。浮動 UI（カメラ/心拍/サーバ）は
  // 全画面の rest スクリーン自体が覆い隠す。
  function fmtMMSS(ms) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  async function runRestMeasurement(phase) {   // phase: 'pre' | 'post'
    const durationMs = getRestDurationMs(phase);
    if (durationMs <= 0) return;   // 0 秒設定 → このフェーズを丸ごと省略（rest 画面もイベントも出さない）

    const phaseLabel = $('restPhaseLabel'), cd = $('restCountdown'), restSkip = $('restSkip');
    if (phaseLabel) phaseLabel.textContent = phase === 'pre' ? '安静（前）' : '安静（後）';
    if (cd) cd.textContent = fmtMMSS(durationMs);

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
        const remaining = Math.max(0, durationMs - elapsed);
        if (cd) cd.textContent = fmtMMSS(remaining);
        if (elapsed >= durationMs) { clearInterval(timer); resolve(); }
      }, 200);
    });

    restSkip?.removeEventListener('click', onSkip);
    document.body.style.overflow = '';   // スクロール抑止を解除
    HeartHub.logEvent('rest_' + phase + '_end', -1, { skipped, plannedMs: durationMs });   // スキップ有無と予定長を保存データに残す
    if (state.useCamera) FaceRecorder.logEvent('rest_' + phase + '_end', { skipped });
  }

  startNoBtn.addEventListener('click', async () => {
    if (sessionStarting) return;
    lockStartButtons(true);
    state.useCamera = false;
    FaceRecorder.showPanel(false);
    await beginSession();   // ECG 採集を開始（カメラ無しでも心電は記録）
    await runRestMeasurement('pre');  // 安静時測定（前）
    goQuiz();
  });

  // ---------- Navigation ----------
  function switchScreen(key) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[key].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (typeof updatePairWidgetVisibility === 'function') updatePairWidgetVisibility();
    if (key === 'intro') updateIntroSensorGuide();
  }

  // 説明画面のセンサー装着ガイドを、前画面で選んだ計測デバイスに合わせて出し分ける。
  // 例: myBeat 未選択なら胸部電極の装着図・説明を出さない（PPG も同様）。
  function updateIntroSensorGuide() {
    const ecgLi = $('introEcgGuide'), ppgLi = $('introPpgGuide');
    if (ecgLi) ecgLi.style.display = HeartHub.isEnabled('ecg') ? '' : 'none';
    if (ppgLi) ppgLi.style.display = HeartHub.isEnabled('ppg') ? '' : 'none';

    // 実験の流れの「安静時間」表示を設定値に合わせる（0 秒ならそのステップを隠す）
    const fmtDur = sec => sec <= 0 ? 'なし' : (sec % 60 === 0 ? `約${sec / 60}分` : `約${sec}秒`);
    const preSec = getRestDurationMs('pre') / 1000, postSec = getRestDurationMs('post') / 1000;
    const preDur = $('expRestPreDur'), postDur = $('expRestPostDur');
    const preStep = $('expStepRestPre'), postStep = $('expStepRestPost');
    if (preDur) preDur.textContent = fmtDur(preSec);
    if (postDur) postDur.textContent = fmtDur(postSec);
    if (preStep) preStep.style.display = preSec <= 0 ? 'none' : '';
    if (postStep) postStep.style.display = postSec <= 0 ? 'none' : '';
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
          // 再開セッションであることを時間線と保存データに明示（interaction[] の
          // enterCount=0/finalAnswer=null が「記録故障」ではなく「別の座りで回答済み」と分かるように）
          HeartHub.logEvent('session_resumed', -1, {
            restoredCount: filled, resumeAt: state.current,
            savedAt: persisted.savedAt, restoredAnswers: persisted.answers.slice()
          });
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
    const unchanged = state.answers[state.current] === idx;   // 同値の再選択（選択肢クリック→Enter 等）
    state.answers[state.current] = idx;
    // UI
    [...optionsList.children].forEach((el, j) => {
      const sel = j === idx;
      el.classList.toggle('selected', sel);
      el.setAttribute('aria-checked', sel ? 'true' : 'false');
      el.setAttribute('tabindex', sel ? '0' : '-1');
    });
    nextBtn.disabled = false;
    if (unchanged) return;   // 値が変わらない再選択はイベント・危機トリガー・保存を発火しない（changes 指標の水増し防止）
    if (state.useCamera) FaceRecorder.logEvent('answer_selected', { a: idx });
    HeartHub.logEvent('answer_selected', state.current, { a: idx });   // 選択値を時間線に記録（変更履歴・反応時間の算出用）
    persist();

    // 自殺念慮の設問でしきい値以上 → 危機介入モーダルを即時表示（量表 JSON の crisis 定義で駆動）
    const cq = state.survey.questions[state.current];
    if (cq.crisis && idx >= (cq.crisis.minScore != null ? cq.crisis.minScore : 1)) {
      HeartHub.logEvent('crisis_triggered', state.current, { score: idx, minScore: (cq.crisis.minScore != null ? cq.crisis.minScore : 1) });
      showCrisisModal();
    }
  }

  function showCrisisModal() {
    if (!crisisModal) return;
    if (state.crisisShownForSession) return;  // 1 セッションに 1 度だけ
    state.crisisShownForSession = true;
    crisisModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    HeartHub.logEvent('crisis_modal_shown', state.current);
    if (state.useCamera) FaceRecorder.logEvent('crisis_modal_shown');
    // フォーカスを Continue ボタンに移す（視覚的インパクトを和らげる）
    setTimeout(() => crisisContinue?.focus(), 100);
  }
  function hideCrisisModal() {
    if (!crisisModal) return;
    crisisModal.classList.add('hidden');
    document.body.style.overflow = '';
    HeartHub.logEvent('crisis_modal_closed', state.current);
    if (state.useCamera) FaceRecorder.logEvent('crisis_modal_closed');
  }
  crisisContinue?.addEventListener('click', hideCrisisModal);
  crisisModal?.addEventListener('click', (e) => { if (e.target === crisisModal) hideCrisisModal(); });
  document.addEventListener('keydown', (e) => {
    if (!crisisModal || crisisModal.classList.contains('hidden')) return;
    if (e.key === 'Escape') { hideCrisisModal(); return; }
    // フォーカストラップ：モーダル表示中は Tab が背後の（非表示の）クイズへ抜けないように、
    // モーダル内のフォーカス可能要素（電話リンク・続行ボタン）だけを循環させる。
    if (e.key === 'Tab') {
      const f = crisisModal.querySelectorAll('a[href], button:not([disabled])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !crisisModal.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !crisisModal.contains(active))) { e.preventDefault(); first.focus(); }
    }
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
    // 危機介入モーダル表示中はクイズ操作を完全に遮断する。
    // （Enter がモーダルを閉じると同時に「次へ/結果を見る」を発火し、数字キーが
    //  モーダルの裏で回答を書き換えてしまう事故の防止 — 危機設問は最後の設問であることが多い）
    if (crisisModal && !crisisModal.classList.contains('hidden')) return;
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
  let finishing = false;   // 再入ガード（安静後=0秒設定時、次へボタンの連打で finish が二重実行され得る）
  async function finish() {
    if (finishing) return;
    finishing = true;
    const result = SurveyEngine.score(state.survey, state.answers);
    state.result = result;

    await runRestMeasurement('post');  // 安静時測定（後）— ECG/録画は継続中

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
    // セッション名で保存（サーバ保存と同じ <session>.<ext>）— 固定プレフィックス+DL時刻だと
    // session.json と名前が食い違い、後から対応付けできなくなる。
    const name = state.sessionName ? `${state.sessionName}.${ext}` : `qids-j_recording_${timestamp()}.${ext}`;
    downloadBlob(blob, name);
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
      schema: 'qids-session-manual-v1',   // 手動エクスポート版：レコーダーログ + HeartHub 時系列（HRV 未算出）
      survey: { id: survey.id, name: survey.name },
      result: state.result,
      answers: state.answers.map((a, i) => ({ q: i + 1, title: survey.questions[i].title, score: a })),
      // 自動保存（サーバ/クライアントDL）と同じ心拍・時間線データを手動エクスポートにも含める。
      // 以前はレコーダーログのみで、events/segments/interaction/ppg が全て欠けていた。
      qids_events: HeartHub.getEvents(),
      segments: HeartHub.buildSegments(),
      rest_segments: HeartHub.buildRestSegments(),
      baseline_segment: HeartHub.buildBaselineSegment(),
      interaction: HeartHub.buildInteraction(),
      sources: HeartHub.getEnabled(),
      ppg: HeartHub.isEnabled('ppg') ? {
        device: (PpgSource.getDeviceInfo && PpgSource.getDeviceInfo()) || null,
        beats: PpgSource.getBeats(),
        beats_count: PpgSource.getBeats().length,
        rawAnchors: (PpgSource.getRawAnchors && PpgSource.getRawAnchors()) || [],
        raw_samples: (PpgSource.getRaw().idx || []).length   // 生波形は ppg_raw.csv 側で保存
      } : null,
      sync: { hubStartWall: HeartHub.startWall, ecgStartWall: EcgSource.startWall, recorderStartIso: data.meta?.sessionStart || null },
      // 1 ファイルに 2 つの時間基準が同居するため、変換規則をデータ自体に明記：
      timebase_note: 'events[].t / questionSegments[].activeTimeRanges はレコーダー相対 ms（ゼロ点 = sync.recorderStartIso）。qids_events[].ts / segments[].startTs / ppg.beats[].t は epoch ms（墙钟）。変換: wallMs = Date.parse(sync.recorderStartIso) + t'
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
  function showExtractDone(handoffId, doc, persistResult) {
    extractProgress.hidden = true;
    extractDoneBox.hidden  = false;
    extractTitle.textContent = '抽出完了';

    // 保存状態の明示（サーバ保存 or 自動DL のどちらが効いたかを操作者に見せる）
    const note = $('extractPersistNote');
    if (note && persistResult) {
      note.textContent = persistResult.uploaded
        ? `✓ 特徴データをサーバに保存しました（${persistResult.name}）。自動ダウンロードも実行済みです。`
        : `特徴データの自動ダウンロードを実行しました（${persistResult.name}）。ブロックされた場合は下の「特徴データを保存」を押してください。`;
    }
    // ジェスチャ付きの確実なDL経路
    const dlBtn = $('extractDownloadBtn');
    if (dlBtn) {
      dlBtn.onclick = () => {
        try {
          downloadBlob(new Blob([JSON.stringify(doc)], { type: 'application/json' }),
            (persistResult && persistResult.name) || ((state.sessionName || ('qids-j_' + timestamp())) + '.landmarks.json'));
        } catch (e) { alert('保存に失敗しました: ' + (e.message || e)); }
      };
    }

    if (handoffId) {
      const url = `analyze.html?handoff=${encodeURIComponent(handoffId)}`;
      extractOpenBtn.href = url;
      extractOpenBtn.onclick = () => {
        // Close the modal after the user's click opens the new tab.
        setTimeout(() => hideExtractModal(), 50);
      };
      extractOpenSameTab.onclick = () => {
        location.href = url;
      };
    } else {
      // handoff（IndexedDB）失敗時：ビューアーはダウンロード済み JSON のドロップで開ける
      extractOpenBtn.removeAttribute('href');
      extractOpenBtn.onclick = (e) => { e.preventDefault(); alert('ブラウザ内の受け渡しに失敗しました。analyze.html を開き、ダウンロード済みの landmarks JSON をドロップしてください。'); };
      extractOpenSameTab.onclick = () => { location.href = 'analyze.html'; };
    }
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
      // 恒久保存を先に（IndexedDB の quota 失敗で抽出結果ごと失わないよう、handoff より前）。
      const persistResult = await persistLandmarks(doc);
      let id = null;
      try { id = await saveHandoff(doc); }
      catch (e) { console.warn('handoff save failed (analyze via downloaded json instead):', e); }
      showExtractDone(id, doc, persistResult);
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

  // 抽出した顔特徴（478点/52 blendshape/変換行列）を確実に残す。
  // IndexedDB の handoff は TTL で消えるため、①サーバ稼働時は /api/upload-landmarks に保存、
  // ②常にクライアント側へ自動ダウンロード（ジェスチャ無しでブロックされても ①と IndexedDB が保険）。
  async function persistLandmarks(doc) {
    const base = (state.sessionName || ('qids-j_' + timestamp())) + '.landmarks.json';
    const result = { name: base, uploaded: false, downloadTried: false };
    let json;
    try { json = JSON.stringify(doc); } catch (e) { console.warn('landmarks stringify failed', e); return result; }
    if (ecgServerUp) {
      try {
        const res = await fetch('/api/upload-landmarks?name=' + encodeURIComponent(base),
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
        result.uploaded = res.ok;   // HTTP エラーも失敗として扱う
        if (!res.ok) console.warn('landmark upload failed: HTTP', res.status);
      } catch (e) { console.warn('landmark upload failed', e); }
    }
    // ジェスチャ無しの自動DLはブラウザにブロックされ得る（検知不能）。
    // 確実な保存経路として、完了ボックスに手動DLボタンも用意する（showExtractDone）。
    try { downloadBlob(new Blob([json], { type: 'application/json' }), base); result.downloadTried = true; } catch (e) {}
    return result;
  }

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
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;   // 24h（旧値 1h だと抽出結果が早々に消えていた）
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
    // 記憶がある場合は身分情報（ID・年齢層・性別）のみ復元（当日の状態はクリアのまま）
    loadSavedSubject();
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
    FaceRecorder.reset();   // 前の被験者のイベントログ・録画 Blob・カメラメタを破棄（跨被験者汚染とメモリ滞留の防止）
    FaceRecorder.showPanel(false);
    clearSubjectForm();   // ← 前の被験者の入力をクリア（量表選択とカメラ設定は維持）
    [consentMedical, consentAge, consentData, consentCamera].forEach(el => { el.checked = false; });
    lockStartButtons(false);   // 開始ボタンの相互ロックを解除
    finishing = false;         // finish 再入ガードも解除（次のセッションのため）
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
    let s = String(v ?? '');
    // CSV 数式インジェクション対策：= + - @ 等で始まるセルは Excel が数式として実行し得るので
    // 先頭に ' を付けて無害化（自由記述等が将来 CSV に載っても安全なように）。
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
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

  // ページ離脱時は BLE を明示的に切断し、BlueZ 側の“ゾンビ接続”残留を防ぐ
  // （ゾンビ接続は次回の通知受信不可＝「受信なし」の主因）。
  // pagehide のみ使用：beforeunload は「離脱確認ダイアログでキャンセルして残留」した場合にも
  // 発火してしまい、クイズ継続中に PPG を切断して以降のデータを失う事故になる。
  const _disconnectBle = () => { try { PpgSource.disconnect(); } catch (e) {} };
  window.addEventListener('pagehide', _disconnectBle);
})();
