/**
 * analyze.mjs — 分析ビューアーのメインロジック
 *
 * ユーザーが QIDS-J webapp で書き出した .json / .json.gz を
 * ドロップすると、ブラウザ内で完全に処理する。
 */
import { createViewer } from './viewer3d.mjs';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const dropZone      = $('dropZone');
const fileInput     = $('fileInput');
const loadError     = $('loadError');
const viewerRoot    = $('viewerRoot');
const dropPanel     = $('dropPanel');
const unloadBtn     = $('unloadBtn');
const metaGrid      = $('metaGrid');
const canvas        = $('viewer3dCanvas');
const playBtn       = $('playBtn');
const seekBar       = $('seekBar');
const timeText      = $('timeText');
const speedSelect   = $('speedSelect');
const poseEl        = $('viewerPose');
const frameNoEl     = $('viewerFrameNo');
const toggleMesh    = $('toggleMesh');
const togglePoints  = $('togglePoints');
const toggleFeatures= $('toggleFeatures');
const toggleBaseline= $('toggleBaseline');
const qTimeline     = $('qTimeline');
const blendTraces   = $('blendTraces');
const heatmapCanvas = $('heatmapCanvas');
const heatmapLabels = $('heatmapLabels');
const headposeTraces= $('headposeTraces');

// ---------- State ----------
let viewer = null;
let doc = null;
let detectFrames = [];   // pts を持つ行だけ抜き出したもの
let totalDurMs = 0;
let currentIdx = 0;
let playing = false;
let playStartWallMs = 0;
let playStartFrameT = 0;
let rafHandle = null;
let speed = 1;

// ---------- File loading ----------
async function handleFile(file) {
  try {
    hideError();
    const doc = await loadLandmarkJson(file);
    if (!doc || !doc.frames) throw new Error('frames が見つかりません。QIDS-J webapp 出力の JSON ですか？');
    await loadDoc(doc);
  } catch (e) {
    console.error(e);
    showError(`読み込み失敗: ${e.message || e}`);
  }
}

async function loadLandmarkJson(file) {
  const buf = await file.arrayBuffer();
  const isGz = /\.gz$/i.test(file.name);
  let text;
  if (isGz) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('お使いのブラウザは gzip 解凍に未対応です（Safari 16.4+ / Chrome 80+ が必要）。');
    }
    const cs = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(cs);
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(buf);
  }
  return JSON.parse(text);
}

async function loadDoc(loadedDoc) {
  doc = loadedDoc;
  detectFrames = (doc.frames || []).filter(f => f.pts);
  if (detectFrames.length < 2) {
    showError('検出フレームが十分にありません（最低 2 フレーム必要）。');
    return;
  }
  totalDurMs = detectFrames[detectFrames.length - 1].t - detectFrames[0].t;

  viewerRoot.hidden = false;
  dropPanel.hidden = true;

  if (!viewer) {
    viewer = await createViewer(canvas);
    viewer.start();
    // visibility toggles
    const sync = () => viewer.setVisibility({
      mesh: toggleMesh.checked,
      points: togglePoints.checked,
      features: toggleFeatures.checked,
      baseline: toggleBaseline.checked
    });
    [toggleMesh, togglePoints, toggleFeatures, toggleBaseline].forEach(el => el.addEventListener('change', sync));
    toggleBaseline.addEventListener('change', () => viewer.setColorizeByBaseline(toggleBaseline.checked));
  }

  // baseline: baseline_start→baseline_end 区間の平均、なければ最初の検出フレーム
  const base = computeBaseline();
  if (base) viewer.setBaseline(base);

  // initial frame
  currentIdx = 0;
  seekBar.min = 0;
  seekBar.max = detectFrames.length - 1;
  seekBar.value = 0;
  renderFrame(currentIdx);

  renderMeta();
  renderQuestionTimeline();
  renderBlendshapeTraces();
  renderHeatmap();
  renderHeadposeTraces();
}

function computeBaseline() {
  const starts = (doc.frames || []).filter(f => f.event === 'baseline_start');
  const ends   = (doc.frames || []).filter(f => f.event === 'baseline_end');
  if (starts.length && ends.length && ends[0].t > starts[0].t) {
    const s = starts[0].t, e = ends[0].t;
    const range = detectFrames.filter(f => f.t >= s && f.t < e);
    if (range.length > 0) return averagePts(range);
  }
  // fallback: first detection frame
  return flattenPts(detectFrames[0].pts);
}

function averagePts(frames) {
  const n = 478;
  const sum = new Float32Array(n * 3);
  for (const f of frames) {
    for (let i = 0; i < n; i++) {
      sum[i*3]     += (f.pts[i][0] - 0.5) * 2.0;
      sum[i*3 + 1] += -(f.pts[i][1] - 0.5) * 2.0;
      sum[i*3 + 2] += -f.pts[i][2] * 2.0;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= frames.length;
  return sum;
}
function flattenPts(pts) {
  const flat = new Float32Array(478 * 3);
  for (let i = 0; i < pts.length; i++) {
    flat[i*3]     = (pts[i][0] - 0.5) * 2.0;
    flat[i*3 + 1] = -(pts[i][1] - 0.5) * 2.0;
    flat[i*3 + 2] = -pts[i][2] * 2.0;
  }
  return flat;
}

// ---------- Rendering: per-frame ----------
function renderFrame(idx) {
  if (idx < 0 || idx >= detectFrames.length) return;
  currentIdx = idx;
  const f = detectFrames[idx];
  viewer.setFrame(f.pts);
  updatePoseReadout(f.mat);
  frameNoEl.textContent = `frame ${idx+1}/${detectFrames.length}`;
  const tSec = (f.t - detectFrames[0].t) / 1000;
  const durSec = totalDurMs / 1000;
  timeText.textContent = `${tSec.toFixed(1)} / ${durSec.toFixed(1)} s`;
  seekBar.value = String(idx);

  // Update playheads on timeline/traces
  updatePlayheads(f.t);
}

function updatePoseReadout(mat) {
  if (!mat || mat.length < 16) { poseEl.textContent = 'Y-- P-- R--°'; return; }
  const r00 = mat[0], r02 = mat[8];
  const r12 = mat[9], r11 = mat[5];
  const r20 = mat[2], r22 = mat[10];
  const yaw   = Math.atan2(r02, r22) * 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12))) * 180 / Math.PI;
  const roll  = Math.atan2(r20, r11) * 180 / Math.PI;
  poseEl.textContent = `Y${yaw.toFixed(0).padStart(3,' ')}° P${pitch.toFixed(0).padStart(3,' ')}° R${roll.toFixed(0).padStart(3,' ')}°`;
}

// ---------- Meta summary ----------
function renderMeta() {
  const m = doc.meta || {};
  const rows = [
    ['セッション開始', fmtDate(m.sessionStart)],
    ['録画時間',       `${(totalDurMs/1000).toFixed(1)} 秒`],
    ['検出フレーム数', `${detectFrames.length}`],
    ['目標 fps',       m.targetFps ?? '—'],
    ['実測 fps',       m.actualFps ?? '—'],
    ['脱落フレーム',   m.droppedFrames ?? '—'],
    ['ランタイム',     m.runtime ?? '—'],
    ['カメラ解像度',   `${m.videoWidth}×${m.videoHeight}`],
    ['ブラウザ',       m.device?.userAgent ? shortUa(m.device.userAgent) : '—'],
    ['GPU',            m.device?.webglRenderer ?? '—'],
    ['タイムゾーン',   m.device?.timezone ?? '—'],
    ['QIDS-J 合計',    doc.result ? `${doc.result.total} / 27（${doc.result.severity}）` : '—'],
  ];
  metaGrid.innerHTML = rows
    .map(([k, v]) => `<div><div class="m-label">${escapeHtml(k)}</div><div class="m-value">${escapeHtml(String(v))}</div></div>`)
    .join('');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function shortUa(ua) {
  const m = ua.match(/Chrome\/[\d.]+|Firefox\/[\d.]+|Safari\/[\d.]+|Edg\/[\d.]+/);
  return (m ? m[0] : ua).slice(0, 40);
}

// ---------- Question timeline ----------
function renderQuestionTimeline() {
  const segs = doc.questionSegments || [];
  const t0 = detectFrames[0].t;
  const totalEnd = detectFrames[detectFrames.length - 1].t;
  const total = totalEnd - t0;

  qTimeline.innerHTML = '';
  for (const s of segs) {
    if (!s.activeTimeRanges?.length) continue;
    const row = document.createElement('div');
    row.className = 'q-row';
    row.innerHTML = `
      <div class="q-label">Q${s.questionNumber}</div>
      <div class="q-bar-wrap" data-t="${s.activeTimeRanges[0][0]}">
        ${s.activeTimeRanges.map(([a, b]) => {
          const left = ((a - t0) / total) * 100;
          const width = ((b - a) / total) * 100;
          return `<div class="q-bar" style="left:${left}%; width:${width}%"></div>`;
        }).join('')}
        ${s.firstAnswerTime !== null ? (() => {
          const left = ((s.firstAnswerTime - t0) / total) * 100;
          return `<div class="q-bar-answer" style="left:${left}%"></div>`;
        })() : ''}
        <div class="q-bar-label">${s.title || ''} · ${(s.activeDurationMs/1000).toFixed(1)}s · 答え=${s.finalAnswer ?? '—'}</div>
      </div>
    `;
    row.querySelector('.q-bar-wrap').addEventListener('click', () => {
      seekToTime(s.activeTimeRanges[0][0]);
    });
    qTimeline.appendChild(row);
  }
}

// ---------- Heatmap ----------
function renderHeatmap() {
  const bsKeys = collectBlendshapeKeys();
  heatmapLabels.innerHTML = bsKeys.map(k => `<span title="${escapeHtml(k)}">${escapeHtml(k)}</span>`).join('');

  const W = Math.min(1200, detectFrames.length);
  const H = bsKeys.length;
  heatmapCanvas.width = W;
  heatmapCanvas.height = H * 8;   // 8 px tall rows

  const ctx = heatmapCanvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const stride = Math.max(1, detectFrames.length / W);
  for (let x = 0; x < W; x++) {
    const fi = Math.min(detectFrames.length - 1, Math.floor(x * stride));
    const bs = detectFrames[fi].bs || {};
    for (let y = 0; y < H; y++) {
      const v = bs[bsKeys[y]] ?? 0;
      // green→yellow→red gradient
      let r, g, b;
      if (v < 0.5) { r = Math.round(46 + v*2 * (224-46)); g = 143 + v*2 * 20; b = 92 - v*2*90; }
      else          { r = 224; g = Math.round(163 - (v-0.5)*2*130); b = Math.round(20 - (v-0.5)*2*20); }
      const idx = (y * W + x) * 4;
      img.data[idx]   = r;
      img.data[idx+1] = g;
      img.data[idx+2] = b;
      img.data[idx+3] = 255;
    }
  }
  // paint row by row with scaling to H*8
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, W, H * 8);
}

function collectBlendshapeKeys() {
  const set = new Set();
  for (const f of detectFrames) if (f.bs) for (const k of Object.keys(f.bs)) set.add(k);
  return [...set].sort();
}

// ---------- Blendshape traces ----------
const KEY_BS = [
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight',
  'browInnerUp', 'browDownLeft',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'jawOpen',
  'mouthPucker',
  'eyeSquintLeft', 'eyeSquintRight'
];

function renderBlendshapeTraces() {
  blendTraces.innerHTML = '';
  for (const key of KEY_BS) {
    const box = document.createElement('div');
    box.className = 'trace';
    box.dataset.bsKey = key;
    box.innerHTML = `
      <div class="trace-label"><strong>${escapeHtml(key)}</strong><span data-role="val">—</span></div>
      <canvas></canvas>
    `;
    blendTraces.appendChild(box);
    drawTrace(box.querySelector('canvas'), key, 0, 1);
  }
}

function drawTrace(canvas, key, vmin, vmax) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth  || 300;
  const h = 80;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const t0 = detectFrames[0].t;
  const tEnd = detectFrames[detectFrames.length-1].t;
  const dur = tEnd - t0;

  // question boundary lines
  ctx.strokeStyle = '#cfd9de';
  ctx.lineWidth = 1;
  for (const f of doc.frames || []) {
    if (f.event === 'question_enter') {
      const x = ((f.t - t0) / dur) * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  // baseline regions (soft highlight)
  const bsStart = (doc.frames || []).find(f => f.event === 'baseline_start');
  const bsEnd   = (doc.frames || []).find(f => f.event === 'baseline_end');
  if (bsStart && bsEnd) {
    const x1 = ((bsStart.t - t0) / dur) * w;
    const x2 = ((bsEnd.t   - t0) / dur) * w;
    ctx.fillStyle = 'rgba(108, 180, 160, 0.10)';
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // trace line
  ctx.strokeStyle = '#3d6b8f';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let first = true;
  for (let i = 0; i < detectFrames.length; i++) {
    const f = detectFrames[i];
    const v = f.bs?.[key] ?? 0;
    const x = ((f.t - t0) / dur) * w;
    const y = h - ((v - vmin) / (vmax - vmin)) * (h - 4) - 2;
    if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
  }
  ctx.stroke();
}

function renderHeadposeTraces() {
  headposeTraces.innerHTML = '';
  const keys = [
    ['yaw',   'Yaw (左右°)'],
    ['pitch', 'Pitch (上下°)'],
    ['roll',  'Roll (傾き°)']
  ];
  for (const [k, label] of keys) {
    const box = document.createElement('div');
    box.className = 'trace';
    box.dataset.poseKey = k;
    box.innerHTML = `
      <div class="trace-label"><strong>${escapeHtml(label)}</strong><span data-role="val">—</span></div>
      <canvas></canvas>
    `;
    headposeTraces.appendChild(box);
    drawPoseTrace(box.querySelector('canvas'), k);
  }
}

function drawPoseTrace(canvas, key) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = 80;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const t0 = detectFrames[0].t;
  const tEnd = detectFrames[detectFrames.length-1].t;
  const dur = tEnd - t0;

  // Grid lines at ±45°, 0°
  ctx.strokeStyle = '#e6eef3';
  ctx.lineWidth = 1;
  for (const v of [-45, 0, 45]) {
    const y = h/2 - (v / 90) * (h/2 - 2);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(90, 110, 120, 0.6)';
  ctx.font = '9px system-ui';
  ctx.fillText('0°', 2, h/2 - 2);

  ctx.strokeStyle = key === 'yaw' ? '#3d6b8f' : (key === 'pitch' ? '#6cb4a0' : '#b86f11');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let first = true;
  for (const f of detectFrames) {
    if (!f.mat || f.mat.length < 16) continue;
    const angle = extractPose(f.mat, key);
    const x = ((f.t - t0) / dur) * w;
    const y = h/2 - (clamp(angle, -90, 90) / 90) * (h/2 - 2);
    if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
  }
  ctx.stroke();
}

function extractPose(mat, key) {
  const r00 = mat[0], r02 = mat[8], r11 = mat[5], r12 = mat[9], r20 = mat[2], r22 = mat[10];
  if (key === 'yaw')   return Math.atan2(r02, r22) * 180 / Math.PI;
  if (key === 'pitch') return Math.asin(clamp(-r12, -1, 1)) * 180 / Math.PI;
  if (key === 'roll')  return Math.atan2(r20, r11) * 180 / Math.PI;
  return 0;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- Playheads ----------
function updatePlayheads(t) {
  const t0 = detectFrames[0].t;
  const tEnd = detectFrames[detectFrames.length-1].t;
  const dur = tEnd - t0;
  const pct = ((t - t0) / dur) * 100;

  // Blendshape value readouts
  const f = detectFrames[currentIdx];
  if (f?.bs) {
    for (const trace of blendTraces.children) {
      const k = trace.dataset.bsKey;
      const val = f.bs[k];
      if (val != null) trace.querySelector('[data-role="val"]').textContent = val.toFixed(3);
    }
  }
  if (f?.mat) {
    for (const trace of headposeTraces.children) {
      const k = trace.dataset.poseKey;
      trace.querySelector('[data-role="val"]').textContent = extractPose(f.mat, k).toFixed(0) + '°';
    }
  }

  // Question-timeline playhead: draw a single red line across
  for (const row of qTimeline.children) {
    const wrap = row.querySelector('.q-bar-wrap');
    if (!wrap) continue;
    let line = wrap.querySelector('.q-playhead-line');
    if (!line) {
      line = document.createElement('div');
      line.className = 'q-playhead-line';
      wrap.appendChild(line);
    }
    line.style.left = `${pct}%`;
  }
}

// ---------- Playback ----------
function togglePlay() {
  playing = !playing;
  playBtn.textContent = playing ? '⏸' : '▶';
  if (playing) {
    playStartWallMs = performance.now();
    playStartFrameT = detectFrames[currentIdx].t;
    loopPlayback();
  } else {
    cancelAnimationFrame(rafHandle);
  }
}

function loopPlayback() {
  if (!playing) return;
  const wallElapsed = (performance.now() - playStartWallMs) * speed;
  const targetT = playStartFrameT + wallElapsed;
  // find frame closest to targetT
  let lo = currentIdx, hi = detectFrames.length - 1;
  // linear scan is fine — frames are sorted
  while (lo < hi && detectFrames[lo].t < targetT) lo++;
  if (lo >= detectFrames.length - 1 && targetT >= detectFrames[detectFrames.length-1].t) {
    renderFrame(detectFrames.length - 1);
    togglePlay();
    return;
  }
  renderFrame(lo);
  rafHandle = requestAnimationFrame(loopPlayback);
}

function seekToTime(tAbs) {
  let idx = 0;
  while (idx < detectFrames.length - 1 && detectFrames[idx].t < tAbs) idx++;
  renderFrame(idx);
  if (playing) {
    playStartWallMs = performance.now();
    playStartFrameT = detectFrames[idx].t;
  }
}

// ---------- Events ----------
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drop-active'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop-active'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drop-active');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});
unloadBtn.addEventListener('click', () => {
  viewerRoot.hidden = true;
  dropPanel.hidden = false;
  hideError();
});

playBtn.addEventListener('click', togglePlay);
seekBar.addEventListener('input', () => {
  renderFrame(parseInt(seekBar.value, 10));
  if (playing) {
    playStartWallMs = performance.now();
    playStartFrameT = detectFrames[currentIdx].t;
  }
});
speedSelect.addEventListener('change', () => {
  speed = parseFloat(speedSelect.value);
  if (playing) {
    playStartWallMs = performance.now();
    playStartFrameT = detectFrames[currentIdx].t;
  }
});

document.addEventListener('keydown', (e) => {
  if (viewerRoot.hidden) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft')  renderFrame(Math.max(0, currentIdx - 1));
  else if (e.key === 'ArrowRight') renderFrame(Math.min(detectFrames.length-1, currentIdx + 1));
});

// ---------- Utils ----------
function showError(msg) {
  loadError.hidden = false;
  loadError.innerHTML = `<strong>⚠ エラー</strong><br>${escapeHtml(msg)}`;
}
function hideError() { loadError.hidden = true; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Handoff from main quiz page (via IndexedDB) ----------
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

async function consumeHandoff(id) {
  const db = await openHandoffDb();
  const data = await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDOFF_STORE, 'readwrite');
    const store = tx.objectStore(HANDOFF_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) { resolve(null); return; }
      store.delete(id);          // 一度使ったら削除
      resolve(rec.data);
    };
    getReq.onerror = () => reject(getReq.error);
  });
  db.close();
  return data;
}

// Autoload sample / handoff if query string says so
const params = new URLSearchParams(location.search);
const handoffId = params.get('handoff');
if (handoffId) {
  (async () => {
    try {
      const data = await consumeHandoff(handoffId);
      if (!data) {
        showError('受け渡しデータが見つかりませんでした。タブを開き直した場合は、ダウンロードしたファイルをここにドロップしてください。');
        return;
      }
      await loadDoc(data);
      // URL から handoff パラメータを消す（リロードでエラーにならないように）
      history.replaceState({}, '', location.pathname);
    } catch (e) {
      console.error(e);
      showError('受け渡しデータの読み取りに失敗しました: ' + (e?.message || e));
    }
  })();
}
