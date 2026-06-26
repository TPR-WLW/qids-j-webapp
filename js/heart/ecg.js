/**
 * heart/ecg.js — ECG 心率源（myBeat / WHS-1, 经本地 server.py 的 /api/*）
 *
 * 把原本写在 app.js 里的 ECG 采集/实时逻辑抽出为一个“心率源”，与 PpgSource 对齐。
 * 仅负责设备/采集/实时数据；共享事件时间线、设备配对 UI、保存编排都在外层
 * （HeartHub / app.js）。服务端会自行把采集到的 ECG CSV 按时间窗切片算 HRV，
 * 因此本源在保存时不需要把波形发回（与 PpgSource 不同）。
 *
 * 公开接口：
 *   init({onLog})
 *   isActive()
 *   deviceInfo()            GET /api/device-info（配对 widget 用）
 *   pair(ecgMode)           POST /api/pair
 *   start(sessionName)      POST /api/start + 开始内部轮询（返回是否成功）
 *   stop()                  POST /api/stop + 停止轮询
 *   getLive()              归一化实时值 {label, online, hr, rmssd, sdnn, pnn50, spo2, state, quality}
 *   startWall               采集开始的墙钟（与 ECG host_time 对齐用）
 */
const EcgSource = (() => {
  let onLog = () => {};

  const self = {
    label: 'ECG',
    active: false,
    session: null,
    startWall: null,
    _hrTimer: null,
    _hrvTimer: null,
    _live: { label: 'ECG', online: false, hr: null, rmssd: null, sdnn: null, pnn50: null, spo2: null, state: null, quality: '—' }
  };

  async function deviceInfo() {
    try { return await (await fetch('/api/device-info')).json(); }
    catch (e) { return { error: String(e) }; }
  }

  async function pair(ecgMode) {
    try {
      return await (await fetch('/api/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ecg_mode: ecgMode || '' })
      })).json();
    } catch (e) { return { error: String(e) }; }
  }

  async function start(sessionName) {
    self.session = sessionName;
    try {
      const r = await (await fetch('/api/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output: sessionName, duration: 0 })
      })).json();
      if (r.error) { onLog('warn', 'ECG start 失敗: ' + r.error); self.active = false; return false; }
      self.startWall = Date.now();
      self.active = true;
      _startPolling();
      return true;
    } catch (e) { onLog('warn', 'ECG start エラー: ' + e); self.active = false; return false; }
  }

  async function stop() {
    _stopPolling();
    if (self.active) { try { await fetch('/api/stop', { method: 'POST' }); } catch (e) {} }
    self.active = false;
  }

  function _startPolling() {
    _stopPolling();
    self._hrTimer = setInterval(_pollHr, 1000);
    self._hrvTimer = setInterval(_pollHrv, 5000);
    _pollHr(); _pollHrv();
  }
  function _stopPolling() {
    if (self._hrTimer) clearInterval(self._hrTimer); self._hrTimer = null;
    if (self._hrvTimer) clearInterval(self._hrvTimer); self._hrvTimer = null;
  }

  async function _pollHr() {
    try {
      const s = await (await fetch('/api/status')).json();
      const hr = (s.last && s.last.hr_bpm != null) ? Math.round(s.last.hr_bpm) : null;
      const ageOk = s.last != null;
      self._live.hr = hr;
      self._live.online = ageOk;
      self._live.quality = s.lowbattery ? '低電池 ⚠' : (ageOk ? '受信中' : '受信なし');
    } catch (e) { /* transient */ }
  }
  async function _pollHrv() {
    try {
      const r = await (await fetch('/api/analysis?window=120')).json();
      const au = r.autonomic || {};
      if (au.ok) {
        self._live.rmssd = au.rmssd_ms != null ? au.rmssd_ms : null;
        self._live.state = au.state_code || null;
      } else {
        self._live.rmssd = null; self._live.state = null;
      }
    } catch (e) { /* ignore */ }
  }

  function getLive() { return self._live; }
  function isActive() { return self.active; }
  function init(opts) { if (opts && typeof opts.onLog === 'function') onLog = opts.onLog; }

  return {
    init, isActive, deviceInfo, pair, start, stop, getLive,
    get startWall() { return self.startWall; }
  };
})();
