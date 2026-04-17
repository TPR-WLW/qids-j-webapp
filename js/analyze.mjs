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
const qStatsTable   = $('qStatsTable');
const blendTraces   = $('blendTraces');
const traceBaselineDeltaToggle = $('traceBaselineDelta');
const blinkTimelineTrack = $('blinkTimelineTrack');
const headposeSummary = $('headposeSummary');
const trackingWarning = $('trackingWarning');
const toggleViewer3d  = $('toggleViewer3d');
const decisionSnapshots = $('decisionSnapshots');
const heatmapCanvas    = $('heatmapCanvas');
const heatmapLabels    = $('heatmapLabels');
const heatmapNormalize = $('heatmapNormalize');
const heatmapTooltip   = $('heatmapTooltip');
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
let cachedBaseline = null;  // { bsName: mean } — computed once per doc

// ---------- File loading ----------
let pendingWebmBlob = null;
let pendingSessionLog = null;

async function handleFiles(fileList) {
  try {
    hideError();
    const files = [...fileList];
    const videos   = files.filter(f => /\.(webm|mp4|mov)$/i.test(f.name) || /^video\//.test(f.type));
    const jsons    = files.filter(f => /\.(json|json\.gz)$/i.test(f.name) || /\.gz$/i.test(f.name));

    if (videos.length > 0) {
      // webm flow — hold the video (+ optional session log) until user clicks "抽出開始"
      pendingWebmBlob = videos[0];
      pendingSessionLog = null;
      for (const jf of jsons) {
        const parsed = await loadLandmarkJson(jf);
        if (parsed && parsed.events && !parsed.frames) {
          pendingSessionLog = parsed;
          break;
        }
      }
      showWebmOptions(videos[0], pendingSessionLog);
      return;
    }

    // No video: treat single json as fully-extracted landmarks
    if (jsons.length === 0) throw new Error('対応する形式ではありません（webm または json を指定してください）');
    const doc = await loadLandmarkJson(jsons[0]);
    if (!doc || (!doc.frames && !doc.events)) {
      throw new Error('frames または events が見つかりません');
    }
    if (doc.frames && doc.frames.some(f => f.pts)) {
      await loadDoc(doc);
    } else {
      // session-only JSON without a webm — can't visualize landmarks
      throw new Error('セッションログ（json）単独では特徴点がありません。対応する webm 録画も一緒にドロップしてください。');
    }
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

// ---------- webm extraction flow in analyze page ----------
const webmOptions    = $('webmOptions');
const webmFileLabel  = $('webmFileLabel');
const webmStartBtn   = $('webmStartBtn');
const webmCancelBtn  = $('webmCancelBtn');
const analyzeExtractFps = $('analyzeExtractFps');
const analyzeExtractSmoothing = $('analyzeExtractSmoothing');
const extractModal   = $('extractModal');
const extractPhase   = $('extractPhase');
const extractFill    = $('extractFill');
const extractPct     = $('extractPct');
const extractFrames  = $('extractFrames');
const extractEta     = $('extractEta');
const extractThumb   = $('extractThumb');
const extractThumbPh = $('extractThumbPlaceholder');
const extractCancel  = $('extractCancel');
let abortCtl = null;

const PHASE_LABELS = {
  'loading-library':    'MediaPipe 読み込み中…',
  'loading-wasm':       'WASM ランタイム準備中…',
  'fetching-model':     'モデル取得 + SHA-384 検証中…',
  'creating-detector':  '検出器を初期化中…',
  'benchmarking':       'GPU/CPU 性能測定中…',
  'preparing-video':    '録画ファイルを解析中…',
  'extracting':         'フレーム抽出中…',
  'finalizing':         '仕上げ中…',
  'done':               '完了'
};

function showWebmOptions(video, session) {
  webmOptions.hidden = false;
  const sizeMB = (video.size / 1024 / 1024).toFixed(1);
  const sessionHint = session ? ' · セッションログあり（問題区間を復元）' : ' · セッションログなし（質問の区間情報は推測できません）';
  webmFileLabel.textContent = `📹 ${video.name} (${sizeMB} MB)${sessionHint}`;
}
function hideWebmOptions() {
  webmOptions.hidden = true;
  pendingWebmBlob = null;
  pendingSessionLog = null;
}

webmCancelBtn?.addEventListener('click', hideWebmOptions);
webmStartBtn?.addEventListener('click', async () => {
  if (!pendingWebmBlob) return;
  const targetFps = parseInt(analyzeExtractFps?.value || '30', 10);
  const sessionLog = pendingSessionLog || {
    meta: { sessionStart: new Date().toISOString(),
            mediaRecorderFirstChunkDelayMs: null,
            device: { userAgent: navigator.userAgent } },
    questionSegments: [],
    events: []
  };

  showExtractModal();
  abortCtl = new AbortController();
  try {
    const mod = await import('./extract.mjs?v=' + Date.now());
    const alpha = parseFloat(analyzeExtractSmoothing?.value || '0');
    const smoothing = alpha > 0 && alpha < 1 ? { alpha } : null;
    const doc = await mod.extractLandmarks({
      sessionLog,
      videoBlob: pendingWebmBlob,
      targetFps,
      delegate: 'auto',
      smoothing,
      signal: abortCtl.signal,
      onProgress: handleProgress
    });
    hideExtractModal();
    hideWebmOptions();
    await loadDoc(doc);
  } catch (e) {
    hideExtractModal();
    if (e?.name === 'AbortError') return;
    console.error('Extraction failed', e);
    showError('抽出に失敗しました: ' + (e?.message || String(e)));
  } finally {
    abortCtl = null;
  }
});

extractCancel?.addEventListener('click', () => {
  if (abortCtl) abortCtl.abort();
  hideExtractModal();
});

function handleProgress(info) {
  extractPhase.textContent = PHASE_LABELS[info.phase] || info.phase;
  extractFill.style.width = `${Math.max(0, Math.min(100, info.pct ?? 0)).toFixed(1)}%`;
  extractPct.textContent  = `${(info.pct ?? 0).toFixed(0)}%`;
  if (info.framesTotal) extractFrames.textContent = `${info.framesDone ?? 0} / ${info.framesTotal} フレーム`;
  if (info.etaSec != null) extractEta.textContent = `残り ${formatEta(info.etaSec)}`;
  if (info.thumbDataUrl) {
    extractThumb.src = info.thumbDataUrl;
    extractThumb.hidden = false;
    extractThumbPh.hidden = true;
  }
}
function formatEta(sec) {
  if (sec < 60) return `${Math.round(sec)}秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${s}秒`;
}
function showExtractModal() {
  extractModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  extractFill.style.width = '0%';
  extractPct.textContent = '0%';
  extractFrames.textContent = '— / — フレーム';
  extractEta.textContent = '残り —';
  extractThumb.hidden = true;
  extractThumbPh.hidden = false;
}
function hideExtractModal() {
  extractModal.classList.add('hidden');
  document.body.style.overflow = '';
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

  cachedBaseline = computeBaselineBlendshapes();

  renderTrackingWarning();
  renderMeta();
  renderQuestionTimeline();
  renderQuestionStats();
  renderDecisionSnapshots();
  renderBlendshapeTraces();
  renderBlinkTimeline();
  renderHeatmap();
  setupHeatmapTooltip();
  renderHeadposeSummary();
  renderHeadposeTraces();
}

// ---------- Tracking quality banner ----------
function renderTrackingWarning() {
  if (!trackingWarning) return;
  const m = doc.meta || {};
  const dropped = typeof m.droppedFrames === 'number' ? m.droppedFrames : 0;
  const total = dropped + detectFrames.length;
  if (total <= 0 || dropped / total <= 0.05) { trackingWarning.hidden = true; return; }
  const pct = ((dropped / total) * 100).toFixed(1);
  trackingWarning.hidden = false;
  trackingWarning.innerHTML = `<strong>⚠ 追跡精度が低い可能性があります。</strong> ${dropped} フレーム脱落（全体の ${pct}%）。計算値や色による強調は解釈に注意してください。`;
}

// ---------- Viewer collapse ----------
toggleViewer3d?.addEventListener('click', () => {
  const card = toggleViewer3d.closest('.viewer-card');
  if (!card) return;
  const collapsed = card.classList.toggle('collapsed');
  toggleViewer3d.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggleViewer3d.textContent = collapsed ? '展開する ▸' : '折りたたむ ▾';
  // resize if opening (Three.js needs a nudge when its canvas was display:none)
  if (!collapsed && viewer) setTimeout(() => viewer.resize?.(), 60);
});

// ---------- Decision-moment snapshots ----------
function renderDecisionSnapshots() {
  if (!decisionSnapshots) return;
  if (!viewer || typeof viewer.captureFrame !== 'function') {
    decisionSnapshots.innerHTML = '<p class="muted tiny">3D プレビューが初期化されていないため、スナップショットを生成できません。</p>';
    return;
  }
  try {
    decisionSnapshots.innerHTML = '';
    const segs = (doc.questionSegments || []).filter(s => s.firstAnswerTime != null);
    if (segs.length === 0) {
      decisionSnapshots.innerHTML = '<p class="muted tiny">回答イベントが記録されていないため、スナップショットは表示されません。</p>';
      return;
    }
    const savedIdx = currentIdx;

    for (const s of segs) {
      // find closest detection frame to firstAnswerTime
      let idx = 0;
      while (idx < detectFrames.length - 1 && detectFrames[idx].t < s.firstAnswerTime) idx++;
      const f = detectFrames[idx];
      // Synchronous capture — independent of rAF, so it works even
      // when the preview / tab is in the background.
      const imgUrl = viewer.captureFrame(f.pts);
      const card = document.createElement('div');
      card.className = 'decision-card';
      card.dataset.t = String(s.firstAnswerTime);
      card.innerHTML = `
        ${imgUrl ? `<img src="${imgUrl}" alt="Q${s.questionNumber} スナップショット">` : '<div style="aspect-ratio:4/3;background:#0d1b24"></div>'}
        <div class="dc-caption">
          <span class="dc-q">Q${s.questionNumber}</span>
          ${s.title ? `<span class="dc-title"> ${escapeHtml(s.title)}</span>` : ''}
          <span class="dc-ans"> · 答え=${s.finalAnswer ?? '—'}</span>
        </div>
      `;
      card.addEventListener('click', () => seekToTime(s.firstAnswerTime));
      decisionSnapshots.appendChild(card);
    }

    // Restore playback position (the render loop will pick this up on its next tick)
    renderFrame(savedIdx);
  } catch (e) {
    console.error('renderDecisionSnapshots failed', e);
    decisionSnapshots.innerHTML = `<p class="muted tiny">スナップショット生成でエラー: ${escapeHtml(e.message || String(e))}</p>`;
  }
}

// ---------- Per-question stats ----------
// Baseline blendshape values (one scalar per bs name)
function computeBaselineBlendshapes() {
  const starts = (doc.frames || []).filter(f => f.event === 'baseline_start');
  const ends   = (doc.frames || []).filter(f => f.event === 'baseline_end');
  let sample;
  if (starts.length && ends.length && ends[0].t > starts[0].t) {
    const s = starts[0].t, e = ends[0].t;
    sample = detectFrames.filter(f => f.t >= s && f.t < e);
  }
  if (!sample || sample.length === 0) sample = detectFrames.slice(0, 30);
  const sums = {}; const counts = {};
  for (const f of sample) {
    if (!f.bs) continue;
    for (const [k, v] of Object.entries(f.bs)) {
      sums[k]   = (sums[k]   || 0) + v;
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  const mean = {};
  for (const k of Object.keys(sums)) mean[k] = sums[k] / counts[k];
  return mean;
}

// Detect blink events (rising edges of avg blink > 0.5)
function detectBlinks(frames) {
  const out = [];
  let armed = true;  // true means we can fire on next rising above threshold
  for (const f of frames) {
    const v = averageBs(f.bs, ['eyeBlinkLeft', 'eyeBlinkRight']);
    if (v > 0.5 && armed) { out.push({ t: f.t, v }); armed = false; }
    else if (v < 0.3) { armed = true; }
  }
  return out;
}

function computeQuestionStats() {
  const baseline = computeBaselineBlendshapes();
  const allBlinks = detectBlinks(detectFrames);
  const segs = doc.questionSegments || [];
  return segs.map(seg => {
    if (!seg.activeTimeRanges?.length) return null;
    const qFrames = detectFrames.filter(f => seg.activeTimeRanges.some(([a, b]) => f.t >= a && f.t < b));
    const qBlinks = allBlinks.filter(b => seg.activeTimeRanges.some(([a, bb]) => b.t >= a && b.t < bb));
    const dwellSec = seg.activeDurationMs / 1000;

    const peakDelta = (keys) => {
      let max = 0;
      for (const f of qFrames) {
        const v = averageBs(f.bs, keys);
        if (v > max) max = v;
      }
      // subtract baseline mean for the same average
      let base = 0, n = 0;
      for (const k of keys) { if (baseline[k] != null) { base += baseline[k]; n++; } }
      base = n ? base / n : 0;
      return max - base;
    };

    // yaw std
    let yawSum = 0, yawSq = 0, yawN = 0;
    for (const f of qFrames) {
      if (!f.mat || f.mat.length < 16) continue;
      const y = extractPose(f.mat, 'yaw');
      yawSum += y; yawSq += y * y; yawN++;
    }
    const yawMean = yawN ? yawSum / yawN : 0;
    const yawStd  = yawN ? Math.sqrt(Math.max(0, yawSq / yawN - yawMean * yawMean)) : 0;

    const hesitation = (seg.firstAnswerTime != null && seg.enterTimes[0] != null)
      ? (seg.firstAnswerTime - seg.enterTimes[0]) / 1000
      : null;

    return {
      seg,
      q: seg.q,
      qNum: seg.questionNumber,
      title: seg.title || '',
      dwellSec,
      hesitation,
      answer: seg.finalAnswer,
      changes: Math.max(0, (seg.answerEventCount || 0) - 1),
      smilePeak:       peakDelta(['mouthSmileLeft', 'mouthSmileRight']),
      frownPeak:       peakDelta(['mouthFrownLeft', 'mouthFrownRight']),
      browInnerUpPeak: peakDelta(['browInnerUp']),
      blinkRate:       dwellSec > 0 ? (qBlinks.length / dwellSec) * 60 : 0,
      yawStd
    };
  }).filter(Boolean);
}

function renderQuestionStats() {
  if (!qStatsTable) return;
  const rows = computeQuestionStats();
  if (rows.length === 0) { qStatsTable.innerHTML = ''; return; }

  const cols = [
    { key: 'qNum',            label: 'Q',             klass: 'col-q',    fmt: (v) => `Q${v}` },
    { key: 'title',           label: 'タイトル',       klass: 'col-text', fmt: (v) => escapeHtml(v) },
    { key: 'dwellSec',        label: '滞在 (s)',       klass: 'col-num',  fmt: (v) => v.toFixed(1) },
    { key: 'hesitation',      label: '迷い (s)',       klass: 'col-num',  fmt: (v) => v == null ? '—' : v.toFixed(1) },
    { key: 'answer',          label: '答え',           klass: 'col-num',  fmt: (v) => v == null ? '—' : String(v) },
    { key: 'changes',         label: '変更',           klass: 'col-num',  fmt: (v) => String(v) },
    { key: 'smilePeak',       label: 'Smile Δpeak',    klass: 'col-num',  fmt: (v) => signed3(v), heat: true, dir: 'up-good' },
    { key: 'frownPeak',       label: 'Frown Δpeak',    klass: 'col-num',  fmt: (v) => signed3(v), heat: true, dir: 'up-bad' },
    { key: 'browInnerUpPeak', label: 'BrowInUp Δpeak', klass: 'col-num',  fmt: (v) => signed3(v), heat: true, dir: 'up-bad' },
    { key: 'blinkRate',       label: 'Blink /分',      klass: 'col-num',  fmt: (v) => v.toFixed(1), heat: true, dir: 'up-bad' },
    { key: 'yawStd',          label: 'Yaw σ (°)',      klass: 'col-num',  fmt: (v) => v.toFixed(1), heat: true, dir: 'up-bad' },
  ];

  // Column stats for coloring
  const colStats = {};
  for (const c of cols) {
    if (!c.heat) continue;
    const vals = rows.map(r => r[c.key]).filter(v => typeof v === 'number' && isFinite(v));
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    const std  = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 1e-9;
    colStats[c.key] = { mean, std };
  }

  let sortKey = null, sortDir = 1;
  function build() {
    let sorted = rows.slice();
    if (sortKey) {
      sorted.sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number') return (va - vb) * sortDir;
        return String(va).localeCompare(String(vb)) * sortDir;
      });
    }
    const thead = `<thead><tr>${cols.map(c => {
      const sortCls = sortKey === c.key ? (sortDir === 1 ? 'sorted-asc' : 'sorted-desc') : '';
      return `<th class="${c.klass} ${sortCls}" data-key="${c.key}">${escapeHtml(c.label)}</th>`;
    }).join('')}</tr></thead>`;
    const tbody = `<tbody>${sorted.map(r => {
      return `<tr data-t="${r.seg.activeTimeRanges[0][0]}">${cols.map(c => {
        const v = r[c.key];
        const content = v == null ? '—' : c.fmt(v);
        let style = '';
        if (c.heat && colStats[c.key] && typeof v === 'number' && isFinite(v)) {
          const { mean, std } = colStats[c.key];
          const z = (v - mean) / std;
          style = ` style="${heatmapBg(z, c.dir)}"`;
        }
        return `<td class="${c.klass}"${style}>${content}</td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody>`;
    qStatsTable.innerHTML = thead + tbody;
    qStatsTable.querySelectorAll('thead th').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.key;
        if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
        build();
      });
    });
    qStatsTable.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => seekToTime(parseFloat(tr.dataset.t)));
    });
  }
  build();
}

function signed3(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(3);
}

// Return inline style for a z-score on a column:
// dir='up-bad'  → positive z tints red (concerning), negative z tints green
// dir='up-good' → positive z tints green, negative z tints red
// Magnitude |z| in [0,2.5] maps to opacity 0..0.55
function heatmapBg(z, dir) {
  const mag = Math.min(2.5, Math.abs(z)) / 2.5;
  if (mag < 0.1) return '';
  const positive = z >= 0;
  const isRed = (dir === 'up-bad') ? positive : !positive;
  const alpha = (mag * 0.55).toFixed(2);
  const color = isRed ? `255,80,80` : `70,170,120`;
  return `background: rgba(${color}, ${alpha});`;
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
const HEATMAP_GROUPS = [
  { name: 'brow',    label: 'Brow',    match: (k) => /^brow/i.test(k) },
  { name: 'eye',     label: 'Eye',    match: (k) => /^eye/i.test(k) },
  { name: 'cheek',   label: 'Cheek',  match: (k) => /^cheek/i.test(k) },
  { name: 'nose',    label: 'Nose',   match: (k) => /^nose/i.test(k) },
  { name: 'jaw',     label: 'Jaw',    match: (k) => /^jaw/i.test(k) },
  { name: 'mouth',   label: 'Mouth',  match: (k) => /^mouth/i.test(k) },
  { name: 'other',   label: 'Other',  match: () => true },  // catch-all (includes _neutral)
];
const HEATMAP_ROW_PX = 10;  // row height in rendered px
const HEATMAP_GAP_PX = 2;   // gap between groups

/** Ordered rows: [{ key, group, max }, ...] grouped first, desc-sorted by max within group. */
let heatmapRowOrder = [];
/** Rows promoted into the focused traces area by clicking their labels */
let userExtraTraceKeys = [];  // array of single-key strings

function collectBlendshapeKeys() {
  const set = new Set();
  for (const f of detectFrames) if (f.bs) for (const k of Object.keys(f.bs)) set.add(k);
  return [...set];
}

function computeRowMaxes(keys) {
  const max = Object.fromEntries(keys.map(k => [k, 0]));
  for (const f of detectFrames) {
    if (!f.bs) continue;
    for (const k of keys) {
      const v = f.bs[k];
      if (typeof v === 'number' && v > max[k]) max[k] = v;
    }
  }
  return max;
}

function buildHeatmapOrder() {
  const keys = collectBlendshapeKeys();
  const maxes = computeRowMaxes(keys);
  const used = new Set();
  const rows = [];
  for (const grp of HEATMAP_GROUPS) {
    const groupKeys = keys.filter(k => !used.has(k) && grp.match(k));
    groupKeys.forEach(k => used.add(k));
    groupKeys.sort((a, b) => maxes[b] - maxes[a]);
    if (groupKeys.length > 0) {
      rows.push({ type: 'header', group: grp.name, label: grp.label });
      for (const k of groupKeys) rows.push({ type: 'row', key: k, group: grp.name, max: maxes[k] });
    }
  }
  heatmapRowOrder = rows;
  return rows;
}

function renderHeatmap() {
  const rows = buildHeatmapOrder();
  const dataRows = rows.filter(r => r.type === 'row');
  const W = Math.min(1200, Math.max(400, detectFrames.length));
  const rowPx = HEATMAP_ROW_PX;
  const gapPx = HEATMAP_GAP_PX;

  // Labels (HTML, aligned with rows)
  heatmapLabels.innerHTML = rows.map(r => {
    if (r.type === 'header') return `<div class="hm-group-head">${escapeHtml(r.label)}</div>`;
    const isActive = userExtraTraceKeys.includes(r.key);
    const maxStr = r.max != null ? ` <span class="hm-max">${r.max.toFixed(2)}</span>` : '';
    return `<div class="hm-row ${isActive ? 'active' : ''}" data-key="${escapeHtml(r.key)}" title="${escapeHtml(r.key)}（クリックで主要トレースに追加／解除）">${escapeHtml(r.key)}${maxStr}</div>`;
  }).join('');

  // Canvas: total height = rows * rowPx + group gaps
  const groupGaps = rows.filter(r => r.type === 'header').length - 1;  // gaps BETWEEN groups
  const totalHeight = dataRows.length * rowPx + Math.max(0, groupGaps) * gapPx
                      + rows.filter(r => r.type === 'header').length * rowPx;
  heatmapCanvas.width = W;
  heatmapCanvas.height = totalHeight;

  const ctx = heatmapCanvas.getContext('2d');
  ctx.fillStyle = '#0d1b24';
  ctx.fillRect(0, 0, W, totalHeight);

  const normalize = heatmapNormalize?.checked;
  const stride = Math.max(1, detectFrames.length / W);

  // Walk rows and draw one row at a time (simple; H is small enough)
  let yCursor = 0;
  for (const r of rows) {
    if (r.type === 'header') {
      // group header — soft band
      ctx.fillStyle = '#1a3040';
      ctx.fillRect(0, yCursor, W, rowPx);
      yCursor += rowPx;
      continue;
    }
    const denom = normalize ? Math.max(1e-6, r.max) : 1;
    for (let x = 0; x < W; x++) {
      const fi = Math.min(detectFrames.length - 1, Math.floor(x * stride));
      const v0 = detectFrames[fi].bs?.[r.key] ?? 0;
      const v = Math.max(0, Math.min(1, v0 / denom));
      let red, grn, blu;
      if (v < 0.5) { red = Math.round(46 + v*2 * (224-46)); grn = 143 + v*2 * 20; blu = 92 - v*2*90; }
      else          { red = 224; grn = Math.round(163 - (v-0.5)*2*130); blu = Math.round(20 - (v-0.5)*2*20); }
      ctx.fillStyle = `rgb(${red},${grn},${blu})`;
      ctx.fillRect(x, yCursor, 1, rowPx);
    }
    yCursor += rowPx;
    // Detect group change; add gap
    // (done by checking next row; cleaner: just add gap after last row of group)
  }
  // Group separator bands — draw over the gaps
  // Actually we already wrote rows tightly. Instead, re-walk and insert gaps visually:
  // The simpler approach is: rebuild the rendering with explicit gap between groups.
  // Since we've already painted tightly, let's re-draw with proper gap handling.

  ctx.clearRect(0, 0, W, totalHeight);
  ctx.fillStyle = '#0d1b24';
  ctx.fillRect(0, 0, W, totalHeight);
  let y = 0;
  let lastGroup = null;
  for (const r of rows) {
    if (r.type === 'header') {
      if (lastGroup !== null) { y += gapPx; }
      lastGroup = r.group;
      ctx.fillStyle = '#1a3040';
      ctx.fillRect(0, y, W, rowPx);
      y += rowPx;
      continue;
    }
    const denom = normalize ? Math.max(1e-6, r.max) : 1;
    for (let x = 0; x < W; x++) {
      const fi = Math.min(detectFrames.length - 1, Math.floor(x * stride));
      const v0 = detectFrames[fi].bs?.[r.key] ?? 0;
      const v = Math.max(0, Math.min(1, v0 / denom));
      let red, grn, blu;
      if (v < 0.5) { red = Math.round(46 + v*2 * (224-46)); grn = 143 + v*2 * 20; blu = 92 - v*2*90; }
      else          { red = 224; grn = Math.round(163 - (v-0.5)*2*130); blu = Math.round(20 - (v-0.5)*2*20); }
      ctx.fillStyle = `rgb(${red},${grn},${blu})`;
      ctx.fillRect(x, y, 1, rowPx);
    }
    y += rowPx;
  }

  // (re)wire click on labels
  heatmapLabels.querySelectorAll('.hm-row').forEach(el => {
    el.addEventListener('click', () => toggleExtraTrace(el.dataset.key));
  });
}

function toggleExtraTrace(key) {
  const i = userExtraTraceKeys.indexOf(key);
  if (i >= 0) userExtraTraceKeys.splice(i, 1);
  else userExtraTraceKeys.push(key);
  renderBlendshapeTraces();
  renderHeatmap();  // to refresh "active" label styling
}

// Tooltip on heatmap canvas
function setupHeatmapTooltip() {
  if (!heatmapCanvas || !heatmapTooltip) return;
  heatmapCanvas.addEventListener('mousemove', (e) => {
    const rect = heatmapCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const W = heatmapCanvas.width;
    const scaleX = W / rect.width;
    const pxY = Math.floor(y * (heatmapCanvas.height / rect.height));
    const fi = Math.min(detectFrames.length - 1, Math.floor((x * scaleX) / W * detectFrames.length));
    // walk row order to find which row we're on
    const rowPx = HEATMAP_ROW_PX, gapPx = HEATMAP_GAP_PX;
    let yc = 0, lastGroup = null, hitKey = null;
    for (const r of heatmapRowOrder) {
      if (r.type === 'header') {
        if (lastGroup !== null) yc += gapPx;
        lastGroup = r.group;
        yc += rowPx; continue;
      }
      if (pxY >= yc && pxY < yc + rowPx) { hitKey = r.key; break; }
      yc += rowPx;
    }
    if (!hitKey) { heatmapTooltip.hidden = true; return; }
    const f = detectFrames[fi];
    const v = f.bs?.[hitKey] ?? 0;
    const tSec = ((f.t - detectFrames[0].t) / 1000).toFixed(1);
    heatmapTooltip.textContent = `${hitKey}: ${v.toFixed(3)} @ ${tSec}s`;
    heatmapTooltip.hidden = false;
    const wrapRect = heatmapCanvas.parentElement.getBoundingClientRect();
    heatmapTooltip.style.left = `${e.clientX - wrapRect.left}px`;
    heatmapTooltip.style.top  = `${e.clientY - wrapRect.top}px`;
  });
  heatmapCanvas.addEventListener('mouseleave', () => { heatmapTooltip.hidden = true; });
}

// Normalize toggle rewires
heatmapNormalize?.addEventListener('change', () => renderHeatmap());
traceBaselineDeltaToggle?.addEventListener('change', () => renderBlendshapeTraces());

// ---------- Blink timeline track ----------
function renderBlinkTimeline() {
  if (!blinkTimelineTrack) return;
  blinkTimelineTrack.innerHTML = '';
  const blinks = detectBlinks(detectFrames);
  const t0 = detectFrames[0].t;
  const tEnd = detectFrames[detectFrames.length-1].t;
  const dur = tEnd - t0;
  if (!blinks.length) {
    blinkTimelineTrack.innerHTML = '<div class="muted tiny" style="padding:4px 8px">眨眼イベントは検出されませんでした。</div>';
    return;
  }
  for (const b of blinks) {
    const el = document.createElement('div');
    el.className = 'blink-tick';
    el.title = `blink @ ${((b.t - t0) / 1000).toFixed(2)}s`;
    el.style.left = `${((b.t - t0) / dur) * 100}%`;
    blinkTimelineTrack.appendChild(el);
  }
  // Playhead line
  const ph = document.createElement('div');
  ph.className = 'bt-playhead';
  ph.id = 'blinkTrackPlayhead';
  blinkTimelineTrack.appendChild(ph);
}

// ---------- Head pose summary ----------
function renderHeadposeSummary() {
  if (!headposeSummary) return;
  const metrics = {};
  for (const key of ['yaw', 'pitch', 'roll']) {
    const values = [];
    const t0 = detectFrames[0].t;
    let maxAbs = 0, maxAbsT = null;
    for (const f of detectFrames) {
      if (!f.mat || f.mat.length < 16) continue;
      const v = extractPose(f.mat, key);
      if (!isFinite(v)) continue;
      values.push(v);
      if (Math.abs(v) > Math.abs(maxAbs)) { maxAbs = v; maxAbsT = f.t; }
    }
    const mean = values.reduce((a, x) => a + x, 0) / values.length || 0;
    const std = values.length
      ? Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / values.length)
      : 0;
    metrics[key] = {
      mean, std, maxAbs,
      tAt: maxAbsT != null ? ((maxAbsT - t0) / 1000).toFixed(1) : '—',
      qAt: maxAbsT != null ? questionAt(maxAbsT) : '—'
    };
  }
  const labelMap = { yaw: 'Yaw (左右)', pitch: 'Pitch (上下)', roll: 'Roll (傾き)' };
  headposeSummary.innerHTML = `
    <div class="ps-head">指標</div>
    <div class="ps-head">平均</div>
    <div class="ps-head">標準偏差 σ</div>
    <div class="ps-head">最大偏転（時刻・Q）</div>
    ${['yaw', 'pitch', 'roll'].map(k => {
      const m = metrics[k];
      return `
        <div class="ps-row">${labelMap[k]}</div>
        <div class="ps-cell">${m.mean.toFixed(1)}°</div>
        <div class="ps-cell ps-strong">±${m.std.toFixed(1)}°</div>
        <div class="ps-cell">${m.maxAbs.toFixed(0)}° @ ${m.tAt}s（${m.qAt}）</div>
      `;
    }).join('')}
  `;
}

function questionAt(tAbs) {
  const segs = doc.questionSegments || [];
  for (const s of segs) {
    if (s.activeTimeRanges?.some(([a, b]) => tAbs >= a && tAbs < b)) return `Q${s.questionNumber}`;
  }
  return '—';
}

// ---------- Blendshape traces (L/R averaged) ----------
const TRACE_DEFS = [
  { label: 'Smile',         keys: ['mouthSmileLeft', 'mouthSmileRight'] },
  { label: 'Frown',         keys: ['mouthFrownLeft', 'mouthFrownRight'] },
  { label: 'Brow inner up', keys: ['browInnerUp'] },
  { label: 'Brow down',     keys: ['browDownLeft', 'browDownRight'] },
  { label: 'Blink',         keys: ['eyeBlinkLeft', 'eyeBlinkRight'] },
  { label: 'Jaw open',      keys: ['jawOpen'] },
];

/** 复数キーの frame 内平均（単キーならそのまま） */
function averageBs(bs, keys) {
  if (!bs) return 0;
  let sum = 0, n = 0;
  for (const k of keys) {
    const v = bs[k];
    if (typeof v === 'number') { sum += v; n++; }
  }
  return n ? sum / n : 0;
}

function renderBlendshapeTraces() {
  blendTraces.innerHTML = '';
  const builtins = TRACE_DEFS.map(d => ({ label: d.label, keys: d.keys, removable: false }));
  const extras   = userExtraTraceKeys.map(k => ({ label: k, keys: [k], removable: true }));
  const all = [...builtins, ...extras];
  for (const def of all) {
    const box = document.createElement('div');
    box.className = 'trace';
    box.dataset.bsKeys = def.keys.join(',');
    const lrHint = def.keys.length > 1 ? '<span class="muted tiny" style="margin-left:6px">L/R 平均</span>' : '';
    const removeBtn = def.removable
      ? `<button class="trace-remove" data-key="${escapeHtml(def.keys[0])}" aria-label="削除">×</button>`
      : '';
    box.innerHTML = `
      <div class="trace-label"><strong>${escapeHtml(def.label)}</strong>${lrHint}${removeBtn}<span data-role="val">—</span></div>
      <canvas></canvas>
    `;
    blendTraces.appendChild(box);
    drawTrace(box.querySelector('canvas'), def.keys, 0, 1);
    box.querySelector('.trace-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExtraTrace(e.currentTarget.dataset.key);
    });
  }
}

function drawTrace(canvas, keys, vmin, vmax) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth  || 300;
  const h = 80;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const deltaMode = !!traceBaselineDeltaToggle?.checked;
  let baselineVal = 0;
  if (deltaMode && cachedBaseline) {
    baselineVal = averageBs(cachedBaseline, keys);
    // Center axis on 0; use symmetric range based on observed peak distance from baseline
    let maxDev = 0;
    for (const f of detectFrames) {
      const v = averageBs(f.bs, keys) - baselineVal;
      if (Math.abs(v) > maxDev) maxDev = Math.abs(v);
    }
    maxDev = Math.max(0.05, maxDev);  // floor
    vmin = -maxDev;
    vmax = +maxDev;
  }

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

  // zero line (delta mode)
  if (deltaMode) {
    const yZero = h - ((0 - vmin) / (vmax - vmin)) * (h - 4) - 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(61, 107, 143, 0.55)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yZero); ctx.lineTo(w, yZero); ctx.stroke();
    ctx.restore();
  }

  // trace line — per-frame mean of the given keys
  ctx.strokeStyle = '#3d6b8f';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let first = true;
  for (let i = 0; i < detectFrames.length; i++) {
    const f = detectFrames[i];
    let v = averageBs(f.bs, keys);
    if (deltaMode) v = v - baselineVal;
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

  // Blendshape value readouts (per-frame mean of each trace's keys)
  const f = detectFrames[currentIdx];
  if (f?.bs) {
    for (const trace of blendTraces.children) {
      const keys = (trace.dataset.bsKeys || '').split(',').filter(Boolean);
      if (!keys.length) continue;
      const val = averageBs(f.bs, keys);
      trace.querySelector('[data-role="val"]').textContent = val.toFixed(3);
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

  // Blink timeline playhead
  const bph = document.getElementById('blinkTrackPlayhead');
  if (bph) bph.style.left = `${pct}%`;
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
  const files = e.dataTransfer?.files;
  if (files && files.length) handleFiles(files);
});
fileInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (files && files.length) handleFiles(files);
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
