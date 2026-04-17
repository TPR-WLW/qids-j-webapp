/**
 * decode.mjs — QIDS-J webapp の landmark JSON を Node.js で読み込む最小サンプル。
 *
 * Usage:
 *   node utils/decode.mjs qids-j_landmarks_YYYYMMDD_HHMMSS.json.gz
 *
 * Node >= 18 を想定（zlib, fs/promises のみ）。
 */
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);

async function loadLandmarkJson(path) {
  const buf = await fs.readFile(path);
  const isGz = path.endsWith('.gz');
  const raw = isGz ? await gunzip(buf) : buf;
  return JSON.parse(raw.toString('utf8'));
}

function summarize(doc) {
  const meta = doc.meta || {};
  const frames = doc.frames || [];

  console.log('--- meta ---');
  for (const [k, v] of Object.entries(meta)) console.log(`  ${k}:`, v);

  const detect = frames.filter(f => f.pts);
  const events = frames.filter(f => f.event);

  console.log('\n--- frames ---');
  console.log(`  total entries : ${frames.length}`);
  console.log(`  detection     : ${detect.length}`);
  console.log(`  event markers : ${events.length}`);
  if (detect.length >= 2) {
    const durS = (detect[detect.length - 1].t - detect[0].t) / 1000;
    const fps  = detect.length / durS;
    console.log(`  duration      : ${durS.toFixed(1)}s`);
    console.log(`  average fps   : ${fps.toFixed(1)}`);
  }

  if (events.length) {
    console.log('\n--- question boundaries ---');
    for (const ev of events.slice(0, 20)) {
      console.log(`  t=${ev.t.toFixed(1).padStart(9)} ms  q=${ev.q}  event=${ev.event}`);
    }
    if (events.length > 20) console.log(`  ... and ${events.length - 20} more`);
  }

  if (doc.result && doc.answers) {
    console.log('\n--- questionnaire ---');
    console.log(`  total score : ${doc.result.total} / 27`);
    console.log(`  severity    : ${doc.result.severity}`);
  }

  const segs = doc.questionSegments || [];
  if (segs.length) {
    console.log('\n--- per-question timing ---');
    for (const s of segs) {
      const enter0 = s.enterTimes[0];
      const hesitation = (s.firstAnswerTime !== null && enter0 !== undefined)
        ? (s.firstAnswerTime - enter0) / 1000
        : null;
      const h = hesitation !== null ? `  hesitation=${hesitation.toFixed(1).padStart(4)}s` : '';
      console.log(
        `  Q${String(s.questionNumber).padStart(2)} ${(s.title || '').padEnd(10)} ` +
        `dur=${(s.activeDurationMs/1000).toFixed(1).padStart(5)}s  ` +
        `visits=${s.enterTimes.length}  changes=${s.answerEventCount}  ` +
        `answer=${s.finalAnswer}${h}`
      );
    }
  }
}

/**
 * 任意の質問（0-indexed）中の検出フレームを抜き出す。
 */
export function framesOfQuestion(doc, qIndex) {
  const seg = (doc.questionSegments || []).find(s => s.q === qIndex);
  if (!seg) return [];
  const ranges = seg.activeTimeRanges;
  return (doc.frames || []).filter(f =>
    f.pts && ranges.some(([a, b]) => f.t >= a && f.t < b)
  );
}

/**
 * 任意のフレームから blendshape の時系列を取り出す。
 * @param {object} doc
 * @param {string} name  例: "mouthSmileLeft", "browInnerUp", "jawOpen"
 */
export function blendshapeSeries(doc, name) {
  const out = [];
  for (const fr of doc.frames || []) {
    if (fr.bs && name in fr.bs) out.push([fr.t, fr.bs[name]]);
  }
  return out;
}

const path = process.argv[2];
if (!path) {
  console.error('Usage: node utils/decode.mjs <qids-j_landmarks.json[.gz]>');
  process.exit(1);
}
const doc = await loadLandmarkJson(path);
summarize(doc);
