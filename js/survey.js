/**
 * survey.js — 量表エンジン（複数の質問票を JSON で定義し、共通ロジックで採点）
 *
 * JSON フォーマット（surveys/*.json）:
 *  - questions[]: { id, domain, title, options:[...]|"optionSetKey", crisis?:{minScore} }
 *  - optionSets:  共通選択肢（複数設問で使い回す。例: PHQ-9 の「全くない/数日/…」）
 *  - scoring:     { method:"sum" } または { method:"grouped", groups:[{key,items,reduce}] }
 *                 reduce は "max"（組内最大）/ "sum"（組内合計）。group の合計が総得点。
 *  - severity[]:  { max, key, label, color, advice }（max は「この値以下」で区間判定）
 *  - intro / source / domainLabels: 画面表示用メタ情報
 *
 * 読み込みは fetch を優先し、失敗時は surveys/bank.js のインライン版にフォールバックする
 * （file:// でダブルクリック起動すると fetch が同一オリジン制約で失敗するため。
 *   bank.js は node tools/gen-survey-bank.mjs で surveys/*.json から自動生成）。
 */
const SurveyEngine = (() => {
  const BASE = 'surveys/';

  // file:// フォールバック（surveys/bank.js が定義する window.SURVEY_BANK）
  const bank = () => (typeof window !== 'undefined' && window.SURVEY_BANK) || null;

  async function loadManifest() {
    try {
      const res = await fetch(BASE + 'manifest.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('manifest fetch failed: ' + res.status);
      const data = await res.json();
      return Array.isArray(data.surveys) ? data.surveys : [];
    } catch (e) {
      const b = bank();
      if (b && Array.isArray(b.manifest)) return b.manifest;
      throw e;
    }
  }

  async function load(file) {
    try {
      const res = await fetch(BASE + file, { cache: 'no-cache' });
      if (!res.ok) throw new Error('survey fetch failed: ' + res.status + ' (' + file + ')');
      return normalize(await res.json());
    } catch (e) {
      const b = bank();
      if (b && b.files && b.files[file]) return normalize(b.files[file]);
      throw e;
    }
  }

  function normalize(raw) {
    const optionSets = raw.optionSets || {};
    const questions = (raw.questions || []).map((q, i) => {
      let options = q.options;
      if (typeof options === 'string') options = optionSets[options];
      if (!Array.isArray(options)) options = [];
      return {
        id: q.id != null ? q.id : (i + 1),
        index: i,
        domain: q.domain || '',
        title: q.title || '',
        options: options.slice(),
        crisis: q.crisis || null
      };
    });
    const scoring = raw.scoring || { method: 'sum' };
    if (!scoring.maxScore) scoring.maxScore = maxPossible(questions);
    return {
      id: raw.id,
      name: raw.name || raw.id,
      shortName: raw.shortName || raw.name || raw.id,
      source: raw.source || null,
      intro: raw.intro || {},
      domainLabels: raw.domainLabels || {},
      questions,
      scoring,
      severity: Array.isArray(raw.severity) ? raw.severity : []
    };
  }

  // 各設問の最大得点（選択肢数 - 1）の総和
  function maxPossible(questions) {
    return questions.reduce((s, q) => s + Math.max(0, q.options.length - 1), 0);
  }

  function reduceItems(values, mode) {
    if (!values.length) return 0;
    if (mode === 'sum') return values.reduce((a, b) => a + b, 0);
    return Math.max(...values);  // 既定: max
  }

  // 区間判定: severity を昇順に走査し、total <= band.max の最初の区間を返す
  function pickBand(severity, total) {
    for (const b of severity) {
      if (total <= b.max) return b;
    }
    return severity.length ? severity[severity.length - 1] : null;
  }

  /**
   * 採点。
   * @param {object} survey  normalize 済みの量表
   * @param {Array<number|null>} answers  設問順（0始まり）の回答スコア
   * @returns {{total,maxScore,severity,severityKey,advice,color,breakdown}}
   */
  function score(survey, answers) {
    const sc = survey.scoring || { method: 'sum' };
    const at = (idx0) => answers[idx0] != null ? answers[idx0] : 0;  // 0始まりインデックス
    const idxById = new Map(survey.questions.map((q, i) => [q.id, i]));

    let total = 0;
    const breakdown = {};

    if (sc.method === 'grouped' && Array.isArray(sc.groups)) {
      for (const g of sc.groups) {
        const idxs = (g.items || [])
          .map(id => idxById.has(id) ? idxById.get(id) : null)
          .filter(i => i != null);
        const v = reduceItems(idxs.map(at), g.reduce === 'sum' ? 'sum' : 'max');
        total += v;
        breakdown[g.key] = v;
      }
    } else {
      total = survey.questions.reduce((s, q, i) => s + at(i), 0);
    }

    const band = pickBand(survey.severity, total);
    return {
      total,
      maxScore: sc.maxScore || maxPossible(survey.questions),
      severity: band ? band.label : '—',
      severityKey: band ? band.key : '',
      advice: band ? (band.advice || '') : '',
      color: band ? (band.color || '') : '',
      breakdown
    };
  }

  // severity 区間から表示用の数値レンジを作る（例: 0–5, 6–10, …）
  function bandRanges(severity) {
    const out = [];
    let lo = 0;
    for (const b of severity) {
      out.push({ ...b, lo, hi: b.max });
      lo = b.max + 1;
    }
    return out;
  }

  return { loadManifest, load, normalize, score, bandRanges, maxPossible };
})();
