/**
 * heart/ppg.js — PPG 心率源（ESP32-C6 + MAX30102, Web Bluetooth）
 *
 * ESP32 固件只发原始 IR/RED 样本(100Hz)；本模块在浏览器里完成：
 *   连接/自动重连 → 包解析 → 去直流 → 峰检测 → RR → 时域 HRV → SpO₂。
 * 算法移植自 xiao-esp32c6-max30102-hrv 项目的 web/index.html（保持参数一致）。
 *
 * 与 ECG 源对齐的关键：每个检测到的心拍都打 `Date.now()` 墙钟时间戳，
 * 保存时转成与 ECG 同构的 RRI 行，复用服务端同一套分题/分相 HRV 分析。
 *
 * 这是一个单例（与 FaceRecorder / SurveyEngine 同风格），通过 HeartHub 调度。
 *
 * 公开接口：
 *   init({onLog})           注入日志回调（可选）
 *   isSupported()           浏览器是否支持 Web Bluetooth
 *   isConnected()           当前是否已连接 GATT
 *   probeGranted()          启动时探测是否有已授权设备（缓存，供 UI 显示“再接続”）
 *   hasGranted()            是否已有已授权设备（同步，读缓存）
 *   connect() / disconnect()  连接/断开（用户手势触发；已授权则免弹框直连）
 *   startTest(ms)           短时信号测试，回调返回 {samples, hr}
 *   begin(startWall)        进入“记录中”（清空会话缓冲，开始累积心拍/原始波形）
 *   stop()                  退出“记录中”（保持连接以便结果页仍可显示）
 *   reset()                 清空全部状态
 *   getLive()               实时聚合值（HR/HRV/SpO₂/在线/手指）
 *   getBeats()              本次会话心拍 [{t:epochMs, rri}]
 *   getRaw()                本次会话原始波形 {idx[], ir[], red[]}
 *   getRawCsv()             原始波形 CSV 文本（客户端下载用）
 *   attachCanvas(cv)/drawWave()  可选：迷你脉波预览
 */
const PpgSource = (() => {
  // ---- BLE 常量（与固件一致）----
  const SVC = '12345678-1234-5678-1234-56789abcdef0';
  const CHR = '12345678-1234-5678-1234-56789abcdef1';
  const NAME_PREFIX = 'XIAO';
  const FS = 100;                 // 有效采样率(Hz)，与固件一致
  const FINGER_TH = 50000;        // IR 阈值：判断是否有手指
  const WIN = 60;                 // HRV 显示用滑窗心拍数

  // ---- 检测参数（与 ESP32 web/index.html 的 P 一致，可调）----
  const P = { dcAlpha: 0.005, lpAlpha: 0.4, envDecay: 0.995, thrFrac: 0.55, ampFloor: 200, refractoryMs: 300 };

  let onLog = () => {};
  let onData = () => {};          // パケット到着ごとに呼ぶ（UI 側で rAF 描画をトリガ）

  // ---- 连接状态 ----
  let device = null, characteristic = null;
  let wantConnected = false, reconnecting = false;
  let knownDevice = null;         // getDevices() で見つかった既授権デバイス（1タップ再接続用）
  let lastTs = 0;                 // 最近一次收到包的 Date.now()
  let spsCount = 0;               // 每秒样本计数

  // ---- 检测/缓冲状态（实时显示用）----
  let nextIdx = null;
  let dcEMA = null, acLP = 0, acP2 = 0, acP1 = 0;
  let envPos = 0, envNeg = 0, lastPeakIdx = null;
  let rrSeries = [];             // {idx, rr} 显示用（截断）
  let wave = [];                 // {idx, v, beat, finger} 显示用（截断）
  let spIR = [], spRED = [];     // SpO₂ 环形缓冲
  let lastIRv = 0, lastFinger = false, curSpo2 = null;

  // ---- 会话记录（begin..stop 之间累积，用于保存）----
  let recording = false;
  let startWall = null;
  let beats = [];                // {t:epochMs, rri:ms}
  let rawIdx = [], rawIr = [], rawRed = [];

  // ---- 迷你波形画布（可选）----
  let waveCanvas = null;

  // ============================================================
  //                     连接
  // ============================================================
  function isSupported() { return !!(navigator.bluetooth); }
  function isConnected() { return !!(device && device.gatt && device.gatt.connected && characteristic); }

  async function _gattConnect() {
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    characteristic = await svc.getCharacteristic(CHR);
    await characteristic.startNotifications();
    characteristic.removeEventListener('characteristicvaluechanged', onPacket);
    characteristic.addEventListener('characteristicvaluechanged', onPacket);
  }

  // 以前このオリジンに許可された XIAO デバイスを（選択ダイアログ無しで）探す。
  // 対応していない／未許可なら null。permission は永続化されるため次回以降も返る。
  async function _findGranted() {
    if (!navigator.bluetooth.getDevices) return null;   // 旧 Chrome / new-permissions-backend 無効時
    try {
      const devs = await navigator.bluetooth.getDevices();
      return devs.find(d => (d.name || '').startsWith(NAME_PREFIX)) || null;
    } catch (e) { return null; }
  }

  // 起動時に一度呼ぶ：既授権デバイスの有無をキャッシュ（UI が「再接続」表示に使う）。
  async function probeGranted() { knownDevice = await _findGranted(); return !!knownDevice; }
  function hasGranted() { return !!knownDevice; }

  function _bindDevice(dev) {
    device = dev;
    device.removeEventListener('gattserverdisconnected', _onDisconnect);
    device.addEventListener('gattserverdisconnected', _onDisconnect);
  }

  async function connect() {
    if (!isSupported()) throw new Error('このブラウザは Web Bluetooth 非対応です（Chrome / Edge をご利用ください）。');
    // ① 既授権デバイスがあれば選択ダイアログ無しで再接続（1タップ）
    const granted = knownDevice || await _findGranted();
    if (granted) {
      try {
        _bindDevice(granted);
        wantConnected = true;
        await _gattConnect();
        knownDevice = device;
        onLog('info', 'PPG 再接続（既知デバイス）: ' + (device.name || NAME_PREFIX));
        resetDetect();
        return true;
      } catch (e) {
        // 既知デバイスが圏外／電源オフ等 → 選択ダイアログにフォールバック
        onLog('warn', '既知デバイスへの接続に失敗、選択に切替: ' + (e.message || e));
        wantConnected = false; device = null;
      }
    }
    // ② 初回 or フォールバック：選択ダイアログで許可を得る
    _bindDevice(await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }],
      optionalServices: [SVC]
    }));
    wantConnected = true;
    await _gattConnect();
    knownDevice = device;
    onLog('info', 'PPG 接続済み: ' + (device.name || NAME_PREFIX));
    resetDetect();
    return true;
  }

  function disconnect() {
    wantConnected = false;
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
  }

  function _onDisconnect() {
    characteristic = null;
    if (wantConnected && device) { onLog('warn', 'PPG 切断 → 再接続中…'); _reconnectLoop(); }
    else { onLog('info', 'PPG 切断'); device = null; }
  }

  async function _reconnectLoop() {
    if (reconnecting) return;
    reconnecting = true;
    while (wantConnected && device) {
      try { await _gattConnect(); onLog('info', 'PPG 再接続成功'); reconnecting = false; return; }
      catch (e) { await new Promise(r => setTimeout(r, 1500)); }
    }
    reconnecting = false;
  }

  // ============================================================
  //                     包解析 / 检测
  // ============================================================
  // 二进制小端: [u32 firstIdx][u8 n][n×(u32 ir, u32 red)]
  function onPacket(e) {
    const dv = e.target.value;
    lastTs = Date.now();
    if (dv.byteLength < 5) return;
    const first = dv.getUint32(0, true), n = dv.getUint8(4);
    // 连续性判定を 2 段階に：小さな前向きギャップ（<=3s 丢包）は dcEMA/包络を温存し RR 計時だけ断つ
    // （full reset だと dcEMA が ~2s 再収敛して波形・HR が固まる）。大ギャップ/再起動時のみ整器复位。
    if (nextIdx !== null && first !== nextIdx) {
      const gap = first - nextIdx;
      if (gap > 0 && gap <= 300) breakRRContinuity();   // 前向き小丢包：跨ギャップの RR のみ無効化
      else resetContinuity();                            // 大ギャップ or index 再起動：整器复位
    }
    for (let i = 0; i < n; i++) {
      const off = 5 + i * 8;
      if (off + 8 > dv.byteLength) break;
      const ir = dv.getUint32(off, true), red = dv.getUint32(off + 4, true);
      processSample(first + i, ir, red);
      spsCount++;
      if (recording) { rawIdx.push(first + i); rawIr.push(ir); rawRed.push(red); }
    }
    nextIdx = first + n;
    onData();   // 到着ごとに UI へ通知 → rAF 描画で 250ms タイマ待ちのレイテンシを除去
  }

  function processSample(idx, ir, red) {
    const finger = ir > FINGER_TH;
    lastIRv = ir; lastFinger = finger;

    spIR.push(ir); spRED.push(red);
    if (spIR.length > 400) { spIR.shift(); spRED.shift(); }

    if (!finger) { resetContinuity(); pushWave(idx, 0, false, false); return; }

    if (dcEMA === null) dcEMA = ir;
    dcEMA += (ir - dcEMA) * P.dcAlpha;
    const ac = ir - dcEMA;
    acLP += (ac - acLP) * P.lpAlpha;
    envPos *= P.envDecay; if (acLP > envPos) envPos = acLP;
    envNeg *= P.envDecay; if (acLP < envNeg) envNeg = acLP;
    const amp = envPos - envNeg;
    const thr = envNeg + P.thrFrac * amp;

    let isBeat = false;
    if (amp > P.ampFloor && acP1 > thr && acP1 > acP2 && acP1 >= acLP) {
      const denom = acP2 - 2 * acP1 + acLP;
      let off = denom !== 0 ? 0.5 * (acP2 - acLP) / denom : 0;
      off = Math.max(-1, Math.min(1, off));
      const peakIdx = (idx - 1) + off;
      if (lastPeakIdx !== null) {
        const rr = (peakIdx - lastPeakIdx) / FS * 1000;
        if (rr >= P.refractoryMs && rr <= 2000) { recordBeat(idx, peakIdx, rr); lastPeakIdx = peakIdx; isBeat = true; }
        else if (rr > 2000) { lastPeakIdx = peakIdx; }
      } else { lastPeakIdx = peakIdx; }
    }
    acP2 = acP1; acP1 = acLP;
    pushWave(idx, acLP, isBeat, true);
  }

  function recordBeat(idx, peakIdx, rr) {
    if (!acceptRR(rr)) return;
    rrSeries.push({ idx, rr }); if (rrSeries.length > 600) rrSeries.shift();
    if (recording) {
      // 峰相对当前样本的微小偏移换算成墙钟（一般 < 200ms，可忽略，但顺手修正）
      const lagMs = (idx - peakIdx) / FS * 1000;
      beats.push({ t: Date.now() - lagMs, rri: rr });
    }
  }

  function acceptRR(rr) {
    if (rr < 300 || rr > 2000) return false;
    if (rrSeries.length >= 5) {
      const recent = rrSeries.slice(-11).map(x => x.rr).sort((a, b) => a - b);
      const med = recent[Math.floor(recent.length / 2)];
      if (Math.abs(rr - med) > 0.3 * med) return false;
    }
    return true;
  }

  function pushWave(idx, v, beat, finger) { wave.push({ idx, v, beat, finger }); if (wave.length > 500) wave.shift(); }

  function breakRRContinuity() { lastPeakIdx = null; }   // RR 計時だけ断つ（自适应滤波器 dcEMA/包络は温存）
  function resetContinuity() { dcEMA = null; acLP = acP2 = acP1 = 0; envPos = envNeg = 0; lastPeakIdx = null; }
  function resetDetect() { nextIdx = null; resetContinuity(); rrSeries = []; wave = []; spIR = []; spRED = []; curSpo2 = null; }

  // ============================================================
  //                     SpO₂ / HRV
  // ============================================================
  function computeSpo2() {
    if (spIR.length < 150) return null;
    const ir = spIR.slice(-300), red = spRED.slice(-300);
    const dcIr = mean(ir), dcRed = mean(red);
    if (dcIr < FINGER_TH) return null;
    const acIr = rms(ir, dcIr), acRed = rms(red, dcRed);
    if (acIr < 20 || acRed < 20) return null;
    const R = (acRed / dcRed) / (acIr / dcIr);
    return Math.max(70, Math.min(100, Math.round(110 - 25 * R)));
  }
  function mean(a) { let s = 0; for (const x of a) s += x; return s / a.length; }
  function rms(a, m) { let s = 0; for (const x of a) s += (x - m) * (x - m); return Math.sqrt(s / a.length); }

  function computeHRV(rr) {
    const n = rr.length; if (n < 2) return null;
    const mn = rr.reduce((a, b) => a + b, 0) / n;
    const sdnn = Math.sqrt(rr.reduce((a, b) => a + (b - mn) ** 2, 0) / n);
    const diffs = []; for (let i = 1; i < n; i++) diffs.push(rr[i] - rr[i - 1]);
    let nn50 = 0; for (const d of diffs) if (Math.abs(d) > 50) nn50++;
    const rmssd = Math.sqrt(diffs.reduce((a, b) => a + b * b, 0) / diffs.length);
    const pnn50 = 100 * nn50 / diffs.length;
    return { n, mean: mn, sdnn, rmssd, pnn50, hr: 60000 / mn };
  }

  // ============================================================
  //                     会话控制 / 取数
  // ============================================================
  function begin(wall) {
    startWall = wall || Date.now();
    beats = []; rawIdx = []; rawIr = []; rawRed = [];
    resetDetect();
    recording = true;
    onLog('info', 'PPG 記録開始');
  }
  function stop() {
    recording = false;
    onLog('info', `PPG 記録停止（心拍 ${beats.length}・サンプル ${rawIdx.length}）`);
  }
  function reset() {
    recording = false; startWall = null;
    beats = []; rawIdx = []; rawIr = []; rawRed = [];
    resetDetect();
    lastIRv = 0; lastFinger = false; curSpo2 = null; lastTs = 0;
  }

  function online() { return !!lastTs && (Date.now() - lastTs < 2000); }

  // 受信レート（samples/sec）概算：UI の“受信できているか”表示用。
  // 呼ぶたびに累積 spsCount の差分から算出（正常時 ≈100）。
  let _spsMark = -1, _spsMarkTs = 0, _spsLast = 0;
  function getSps() {
    const now = Date.now();
    if (_spsMark < 0 || !online()) { _spsMark = spsCount; _spsMarkTs = now; if (!online()) _spsLast = 0; return _spsLast; }
    const dt = (now - _spsMarkTs) / 1000;
    if (dt >= 1.0) {                                   // 1s 窗口：抹平 160ms 突发的量化抖动（±<=1 包）
      const inst = Math.max(0, (spsCount - _spsMark) / dt);
      _spsLast = _spsLast > 0 ? _spsLast + 0.5 * (inst - _spsLast) : inst;   // + EMA 平滑
      _spsMark = spsCount; _spsMarkTs = now;
    }
    return Math.round(_spsLast);
  }

  function getLive() {
    curSpo2 = computeSpo2();
    const arr = rrSeries.slice(-WIN).map(x => x.rr);
    const h = arr.length >= 2 ? computeHRV(arr) : null;
    // ライブ表示用の瞬時 HR：直近 4 拍の中央値ベース（60 拍平均の h.hr より即応）
    const recent = rrSeries.slice(-4).map(x => x.rr);
    const hrInst = recent.length >= 2
      ? Math.round(60000 / (recent.slice().sort((a, b) => a - b)[Math.floor(recent.length / 2)]))
      : null;
    const conn = isConnected();
    const on = online();
    return {
      connected: conn,
      online: on,
      finger: lastFinger,
      ir: lastIRv,
      spo2: (lastFinger && curSpo2 != null) ? curSpo2 : null,
      hr: (lastFinger && h) ? Math.round(h.hr) : null,
      hrInst: (lastFinger && hrInst != null) ? hrInst : null,
      rmssd: (arr.length >= 5 && h) ? h.rmssd : null,
      sdnn: (arr.length >= 5 && h) ? h.sdnn : null,
      pnn50: (arr.length >= 5 && h) ? h.pnn50 : null,
      meanrr: (arr.length >= 5 && h) ? h.mean : null,
      quality: !conn ? '未接続' : (!on ? '受信なし' : (!lastFinger ? '指なし' : '受信中'))
    };
  }

  function getBeats() { return beats.map(b => ({ t: b.t, rri: b.rri })); }
  function getRaw() { return { idx: rawIdx.slice(), ir: rawIr.slice(), red: rawRed.slice() }; }
  function getRawCsv() {
    const lines = ['idx,ir,red'];
    for (let i = 0; i < rawIdx.length; i++) lines.push(rawIdx[i] + ',' + rawIr[i] + ',' + rawRed[i]);
    return lines.join('\n');
  }

  // ---- 短时信号测试（装着確認用）。返回测试窗口内收到的样本数 + 当前 HR ----
  async function startTest(ms) {
    const s0 = spsCount;
    await new Promise(r => setTimeout(r, ms || 4000));
    const live = getLive();
    return { samples: spsCount - s0, hr: live.hr, finger: live.finger, online: online() };
  }

  // ============================================================
  //                     迷你波形预览（可选）
  // ============================================================
  function attachCanvas(cv) { waveCanvas = cv; }
  function drawWave() {
    const cv = waveCanvas; if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 6;
    ctx.clearRect(0, 0, W, H);
    if (wave.length < 2) {
      // データ未着：真っ黒だと「壊れている」ように見えるので、薄い基線＋待機表示を描く
      ctx.strokeStyle = 'rgba(120,140,160,.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad, H / 2); ctx.lineTo(W - pad, H / 2); ctx.stroke();
      ctx.fillStyle = 'rgba(150,170,190,.75)'; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText('受信待ち…', pad + 4, H / 2 - 8);
      return;
    }
    const vs = wave.map(p => p.v); const lo = Math.min(...vs), hi = Math.max(...vs), rng = Math.max(200, hi - lo);
    ctx.strokeStyle = '#46c2ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    wave.forEach((p, i) => {
      const x = pad + i / (wave.length - 1) * (W - 2 * pad);
      const y = H - pad - ((p.v - lo) / rng) * (H - 2 * pad);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = '#3ddc84';
    wave.forEach((p, i) => {
      if (!p.beat) return;
      const x = pad + i / (wave.length - 1) * (W - 2 * pad);
      const y = H - pad - ((p.v - lo) / rng) * (H - 2 * pad);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    });
  }

  function init(opts) { if (opts && typeof opts.onLog === 'function') onLog = opts.onLog; }

  return {
    init, isSupported, isConnected, connect, disconnect, startTest,
    probeGranted, hasGranted, getSps,
    begin, stop, reset, getLive, getBeats, getRaw, getRawCsv,
    attachCanvas, drawWave
  };
})();
