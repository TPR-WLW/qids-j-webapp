/**
 * heart/hub.js — HeartHub：心率源管理器
 *
 * 把原本散在 app.js `ECG` 对象里的“与源无关”的部分（事件时间线、设问/安静区间
 * 构建、实时叠加层）上提到这里，并按 enabled 把 start/stop/save 分发给已启用的
 * 心率源（EcgSource 走服务端、PpgSource 走 Web Bluetooth）。两者可同时启用。
 *
 * 时间线统一：所有事件用 Date.now() 打点，与 ECG 的 host_time / PPG 的心拍墙钟一致，
 * 因此 buildSegments()/buildRestSegments() 的区间可被服务端对两种源同样地切片算 HRV。
 *
 * 依赖通过 init() 注入，避免与 app.js 的内部状态硬耦合。
 */
const HeartHub = (() => {
  const STATE_LABEL_JA = { relaxed: 'リラックス', stressed: 'ストレス', balanced: 'バランス', active: '活動的', unknown: '—' };

  let enabled = { ecg: false, ppg: false };
  let events = [];
  let startWall = null;

  let overlayEl = null;
  let tickTimer = null;
  let surveyRef = () => null;     // () => state.survey
  let currentRef = () => 0;       // () => state.current
  let onLog = () => {};

  function init(deps) {
    overlayEl = deps.overlay || null;
    if (typeof deps.survey === 'function') surveyRef = deps.survey;
    if (typeof deps.current === 'function') currentRef = deps.current;
    if (typeof deps.onLog === 'function') onLog = deps.onLog;
  }

  // ---- 启用的源 ----
  function setEnabled(e) { enabled = { ecg: !!(e && e.ecg), ppg: !!(e && e.ppg) }; }
  function getEnabled() { return { ...enabled }; }
  function isEnabled(k) { return !!enabled[k]; }
  function anyEnabled() { return enabled.ecg || enabled.ppg; }

  // ---- 共享事件时间线（Date.now()）----
  // extra: 可选の付加フィールド（例: answer_selected は {a: 選択肢index}、crisis は {score,minScore}）
  function logEvent(type, q, extra) {
    const ev = { q: (q == null ? currentRef() : q), type, ts: Date.now() };
    if (extra && typeof extra === 'object') Object.assign(ev, extra);
    events.push(ev);
  }
  function getEvents() { return events.slice(); }

  // 设问区间：相邻 question_enter 之间为一题的窗口。
  // 「前へ」で同じ設問に戻ると同じ q の窓が複数生成される（重複ではなく再訪＝実データ）。
  // 各窓に visit（その q の何回目の訪問か）を付与し、下流で集計/識別できるようにする。
  function buildSegments() {
    const survey = surveyRef();
    const enters = events.filter(e => e.type === 'question_enter');
    const visitCount = {};
    const segs = [];
    for (let i = 0; i < enters.length; i++) {
      const e = enters[i];
      let end;
      if (i + 1 < enters.length) {
        end = enters[i + 1].ts;
      } else {
        // 最終設問：次の question_enter が無い。保存時刻まで延ばすと post-rest を巻き込み
        // dwell/HRV が水増しになる → その設問の question_finalize、無ければ rest_post_start で終端。
        const fin = events.find(ev => ev.type === 'question_finalize' && ev.q === e.q && ev.ts >= e.ts);
        const restPost = events.find(ev => ev.type === 'rest_post_start' && ev.ts >= e.ts);
        end = (fin && fin.ts) || (restPost && restPost.ts) || Date.now();
      }
      visitCount[e.q] = (visitCount[e.q] || 0) + 1;
      segs.push({
        q: e.q,
        questionNumber: (e.q ?? 0) + 1,
        visit: visitCount[e.q],
        label: (survey && survey.questions[e.q] && survey.questions[e.q].title) || null,
        startTs: e.ts, endTs: end
      });
    }
    return segs;
  }

  // baseline（安静キャリブレーション）区間：baseline_start/end イベントから
  function buildBaselineSegment() {
    const s = events.find(e => e.type === 'baseline_start');
    if (!s) return null;
    const e = events.find(e => e.type === 'baseline_end');
    return { q: 'baseline', questionNumber: null, label: 'ベースライン', startTs: s.ts, endTs: e ? e.ts : null };
  }

  // 設問ごとの回答インタラクション指標（イベント時間線から算出）:
  //   reactionMs   最初の question_enter → 最初の answer_selected（反応時間）
  //   dwellMs      その設問に滞在した合計時間（再訪の窓を合算 = buildSegments の該当窓の和）
  //   changes      回答を変更した回数（answer_selected 回数 - 1）
  //   answerHistory 各 answer_selected の {a:選択index, ts}
  //   finalAnswer  最後に選ばれた選択肢 index
  function buildInteraction() {
    const survey = surveyRef();
    const n = survey && survey.questions ? survey.questions.length : 0;
    const segs = buildSegments();
    const out = [];
    for (let qi = 0; qi < n; qi++) {
      const enters = events.filter(e => e.type === 'question_enter' && e.q === qi);
      const picks = events.filter(e => e.type === 'answer_selected' && e.q === qi);
      const firstEnter = enters.length ? enters[0].ts : null;
      const firstPick = picks.length ? picks[0].ts : null;
      const dwellMs = segs.filter(s => s.q === qi).reduce((sum, s) => sum + Math.max(0, s.endTs - s.startTs), 0);
      const history = picks.map(p => ({ a: (p.a != null ? p.a : null), ts: p.ts }));
      out.push({
        q: qi,
        questionNumber: qi + 1,
        enterCount: enters.length,
        reactionMs: (firstEnter != null && firstPick != null) ? (firstPick - firstEnter) : null,
        dwellMs: enters.length ? dwellMs : null,
        changes: Math.max(0, picks.length - 1),
        answerHistory: history,
        finalAnswer: history.length ? history[history.length - 1].a : null
      });
    }
    return out;
  }

  // 安静时测定（前/后）区间：rest_*_start/end 事件
  function buildRestSegments() {
    const find = (t) => events.find(e => e.type === t);
    const out = [];
    const mk = (phase, label) => {
      const s = find('rest_' + phase + '_start');
      if (!s) return;
      const e = find('rest_' + phase + '_end');
      out.push({ q: phase, questionNumber: null, label, startTs: s.ts, endTs: e ? e.ts : null });
    };
    mk('pre', '安静（前）');
    mk('post', '安静（後）');
    return out;
  }

  // ---- 会话生命周期 ----
  async function begin(sessionName) {
    startWall = Date.now();
    events = [];
    logEvent('session_start', -1);
    const tasks = [];
    if (enabled.ecg) tasks.push(EcgSource.start(sessionName));   // 服务端采集 + UTWS
    if (enabled.ppg) PpgSource.begin(startWall);                 // 已连接则开始累积
    await Promise.allSettled(tasks);   // 即使某个源未就绪也继续（与原 ECG 行为一致）
    if (anyEnabled()) { showOverlay(true); _startTick(); }
  }

  async function stop() {
    _stopTick();
    const tasks = [];
    if (enabled.ecg) tasks.push(EcgSource.stop());
    if (enabled.ppg) PpgSource.stop();
    await Promise.allSettled(tasks);
    showOverlay(false);
  }

  function reset() {
    _stopTick();
    events = []; startWall = null;
    if (enabled.ppg) PpgSource.reset();
    showOverlay(false);
  }

  // ---- 实时叠加层（聚合各启用源）----
  function showOverlay(show) {
    if (!overlayEl) return;
    overlayEl.classList.toggle('hidden', !show);
    overlayEl.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function _startTick() { _renderOverlay(); _stopTick(); tickTimer = setInterval(_renderOverlay, 1000); }
  function _stopTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

  function _sourceBlock(live) {
    const dotBad = !live.online ? ' bad' : '';
    const hr = live.hr != null ? live.hr : '—';
    const hrvBits = [];
    if (live.rmssd != null) hrvBits.push('RMSSD ' + Math.round(live.rmssd));
    if (live.sdnn != null) hrvBits.push('SDNN ' + Math.round(live.sdnn));
    if (live.state) hrvBits.push(STATE_LABEL_JA[live.state] || live.state);
    const spo2 = live.spo2 != null ? ('<span class="ecg-ov-unit">SpO₂</span> ' + live.spo2 + '%') : '';
    return (
      '<div class="ecg-ov-src">' +
        '<div class="ecg-ov-row"><span class="ecg-ov-dot' + dotBad + '"></span>' +
          '<span class="ecg-ov-label">' + live.label + '</span>' +
          '<span class="ecg-ov-val">' + hr + '</span><span class="ecg-ov-unit">bpm</span>' +
          (spo2 ? '<span style="margin-left:8px">' + spo2 + '</span>' : '') +
        '</div>' +
        '<div class="ecg-ov-row small"><span>' + (live.quality || '—') + '</span></div>' +
        (hrvBits.length ? '<div class="ecg-ov-row small"><span>' + hrvBits.join(' · ') + '</span></div>' : '') +
      '</div>'
    );
  }

  function _renderOverlay() {
    if (!overlayEl) return;
    const blocks = [];
    if (enabled.ecg) blocks.push(_sourceBlock(normalize('ECG', EcgSource.getLive())));
    if (enabled.ppg) blocks.push(_sourceBlock(normalize('PPG', PpgSource.getLive())));
    overlayEl.innerHTML = blocks.join('<div class="ecg-ov-sep"></div>') || '<div class="ecg-ov-row small">—</div>';
  }

  // 把各源的 live 归一成统一形状
  function normalize(label, live) {
    return {
      label,
      online: !!(live && (live.online)),
      hr: live ? live.hr : null,
      rmssd: live ? live.rmssd : null,
      sdnn: live ? (live.sdnn ?? null) : null,
      pnn50: live ? (live.pnn50 ?? null) : null,
      spo2: live ? (live.spo2 ?? null) : null,
      state: live ? (live.state ?? null) : null,
      quality: live ? live.quality : '—'
    };
  }

  // ---- 保存：把 PPG 数据并入通用 payload（ECG 由服务端从自身 CSV 切片，无需回传）----
  function attachSavePayload(payload) {
    payload.sources = { ecg: enabled.ecg, ppg: enabled.ppg };
    if (enabled.ppg) {
      payload.ppg = { beats: PpgSource.getBeats(), raw: PpgSource.getRaw() };
    }
    return payload;
  }

  return {
    init, setEnabled, getEnabled, isEnabled, anyEnabled,
    logEvent, getEvents, buildSegments, buildRestSegments, buildBaselineSegment, buildInteraction,
    begin, stop, reset, showOverlay, attachSavePayload,
    get startWall() { return startWall; }
  };
})();
