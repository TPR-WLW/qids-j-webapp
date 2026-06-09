#!/usr/bin/env python3
"""
question_features.py — 「回答中の逐題ダイナミクス」を特徴化する。

粗い相位平均ではなく、各設問への即時反応を見る:
  - 心拍: 設問ごとの mean HR と、安静前(rest_pre)基線からの変化(心拍反応)。
  - 表情: 各設問窓の表情平均と、基線からの変化(笑顔/内眉/表出量)。
  - 情緒負荷の高い設問（mood/self/suicide）への反応を特に集約。
そのうえで PHQ との関係を年齢制御(偏相関)で screen し、逐題トラジェクトリを可視化する。

出力: data/question_report.html + コンソール。
実行: ml/.venv/Scripts/python.exe ml/question_features.py
"""
from __future__ import annotations
import csv, glob, gzip, json, math, sys
from datetime import datetime
from pathlib import Path
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))   # au_map（同ディレクトリ）
from au_map import au_features

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))   # mybeat の HRV 実装を再利用
try:
    from mybeat.analysis import load_rows, hrv_metrics, frequency_hrv
    _HAS_MYBEAT = True
except Exception:  # noqa: BLE001
    _HAS_MYBEAT = False

DATA = ROOT / "data"
OUT = DATA / "question_report.html"
AGE_MID = {"10代": 15, "20代": 25, "30代": 35, "40代": 45, "50代": 55, "60代": 65, "70代以上": 75}
LOADED = {"mood", "self", "suicide"}   # 情緒負荷の高い領域


def iso_ms(s):
    try:
        return datetime.fromisoformat(s).timestamp() * 1000.0
    except Exception:
        return None


def rank(a):
    return np.argsort(np.argsort(a, kind="mergesort"), kind="mergesort").astype(float)


def spearman(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = ~(np.isnan(a) | np.isnan(b))
    if m.sum() < 3:
        return float("nan")
    ra, rb = rank(a[m]), rank(b[m])
    if np.std(ra) == 0 or np.std(rb) == 0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def partial(f, p, a):
    rfp, rfa, rpa = spearman(f, p), spearman(f, a), spearman(p, a)
    if any(math.isnan(x) for x in (rfp, rfa, rpa)):
        return float("nan")
    return (rfp - rfa * rpa) / math.sqrt(max(1e-9, (1 - rfa ** 2) * (1 - rpa ** 2)))


def load_faces(session):
    p = DATA / (session + ".landmarks.json.gz")
    if not p.exists():
        return None
    with gzip.open(p, "rt", encoding="utf-8") as f:
        doc = json.load(f)
    names = doc["meta"].get("blendshape_names") or []
    nidx = {n: i for i, n in enumerate(names)}
    frames = [(fr["t"], fr["bs"]) for fr in doc.get("frames", []) if fr.get("face") and fr.get("bs")]
    return nidx, frames


def face_window(nidx, frames, base_ms, a, b):
    """窓 [a,b)（壁時計 ms）内の表情平均: smile/brow/expressivity + AU + 情動コンポジット。"""
    sel = [bs for (t, bs) in frames if a <= base_ms + t < b]
    if not sel:
        return None
    arr = np.array(sel, float)  # (n,52)
    def col(name):
        i = nidx.get(name)
        return float(arr[:, i].mean()) if i is not None else None
    out = {
        "smile": np.nanmean([col("mouthSmileLeft") or np.nan, col("mouthSmileRight") or np.nan]),
        "brow": col("browInnerUp"),
        "expr": float(arr.std(axis=0).mean()),   # 各blendshapeの時間std平均=表出量
    }
    out.update(au_features(col))   # AU1..AU45 + EMO_sadness/duchenne/distress/nonduchenne
    return out


def loaded_window_hrv(d):
    """情緒負荷の高い3設問(mood/self/suicide)を合併した窓で、安定した HRV を算出。
    単題(~13拍)では不安定な pNN30/周波数を、合併(~30–50拍)で出す。基線比も。"""
    if not _HAS_MYBEAT:
        return {}
    csvp = DATA / (d["session"] + ".csv")
    if not csvp.exists():
        return {}
    rows = load_rows(str(csvp))
    if not rows:
        return {}
    ans = {a.get("q"): a for a in (d.get("answers") or [])}   # answers は q(1始まり)で索引
    wins = []
    for s in (d.get("segments") or []):
        dom = (ans.get(s.get("questionNumber")) or {}).get("domain")
        if dom in LOADED and s.get("startTs") is not None:
            wins.append((s["startTs"], s.get("endTs", math.inf)))
    if not wins:
        return {}
    sub = []
    for r in rows:
        t = iso_ms(r.get("host_time_iso", ""))
        if t is not None and any(a <= t < b for a, b in wins):
            sub.append(r)
    if len(sub) < 5:
        return {}
    m = hrv_metrics(sub)
    fq = frequency_hrv(sub)
    rp = (d.get("phases") or {}).get("rest_pre") or {}
    bh, bf = rp.get("hrv") or {}, rp.get("frequency") or {}

    def diff(a, b):
        return (a - b) if (isinstance(a, (int, float)) and isinstance(b, (int, float))) else None
    lf_hf = fq.get("lf_hf") if fq.get("ok") else None
    out = {
        "loaded_beats": m.get("usable_intervals"),
        "loaded_pnn30": m.get("pnn30"),
        "loaded_pnn20": m.get("pnn20"),
        "loaded_rmssd": m.get("rmssd_ms"),
        "loaded_sdnn": m.get("sdnn_ms"),
        "loaded_mean_hr": m.get("mean_hr_bpm"),
        "loaded_lf_hf": lf_hf,
        "loaded_pnn30_react": diff(m.get("pnn30"), bh.get("pnn30")),
        "loaded_rmssd_react": diff(m.get("rmssd_ms"), bh.get("rmssd_ms")),
        "loaded_sdnn_react": diff(m.get("sdnn_ms"), bh.get("sdnn_ms")),
        "loaded_lfhf_react": diff(lf_hf, bf.get("lf_hf")),
    }
    return out


def per_session(path):
    d = json.load(open(path, encoding="utf-8"))
    session = d["session"]
    base_ms = iso_ms((d.get("sync") or {}).get("recorderStartIso"))
    phases = d.get("phases") or {}
    seg = d.get("segments") or []
    pqh = {p.get("q"): p for p in (d.get("per_question_hrv") or [])}
    ans = {a.get("q"): a for a in (d.get("answers") or [])}   # q は 1始まり
    faces = load_faces(session)
    rest = phases.get("rest_pre") or {}
    base_hr = (rest.get("hrv") or {}).get("mean_hr_bpm")

    # 基線(rest_pre)の表情
    fbase = None
    if faces and base_ms is not None and rest.get("startTs") is not None:
        fbase = face_window(*faces, base_ms, rest["startTs"], rest.get("endTs", math.inf))

    recs = []
    for s in seg:
        q = s.get("q")              # 0始まり
        qn = s.get("questionNumber")
        dom = (ans.get(qn) or {}).get("domain")
        hr = (pqh.get(q) or {}).get("mean_hr_bpm")
        hr_ch = (hr - base_hr) if (hr is not None and base_hr is not None) else None
        fwin = face_window(*faces, base_ms, s["startTs"], s.get("endTs", math.inf)) if (faces and base_ms is not None) else None
        rec = {"q": q, "qn": qn, "domain": dom, "loaded": dom in LOADED,
               "hr": hr, "hr_change": hr_ch}
        if fwin and fbase:
            for k in fwin:
                a_, b_ = fwin.get(k), fbase.get(k)
                ok = isinstance(a_, (int, float)) and isinstance(b_, (int, float))
                if ok and not (isinstance(a_, float) and np.isnan(a_)) and not (isinstance(b_, float) and np.isnan(b_)):
                    rec[f"{k}_change"] = a_ - b_
        recs.append(rec)
    return session, d, recs, fbase


def agg(recs):
    """逐題レコード → セッション集約特徴。"""
    def vals(key, loaded=None):
        return [r[key] for r in recs if r.get(key) is not None and (loaded is None or r["loaded"] == loaded)]
    def mean(xs):
        return float(np.mean(xs)) if xs else np.nan
    suicide = next((r for r in recs if r["domain"] == "suicide"), {})
    out = {
        "hr_react_all": mean(vals("hr_change")),
        "hr_react_loaded": mean(vals("hr_change", True)),
        "hr_react_suicide": suicide.get("hr_change", np.nan),
        "smile_react_all": mean(vals("smile_change")),
        "smile_react_loaded": mean(vals("smile_change", True)),
        "smile_drop_max": (min(vals("smile_change")) if vals("smile_change") else np.nan),
        "brow_react_loaded": mean(vals("brow_change", True)),
        "expr_react_max": (max(vals("expr_change"), key=abs) if vals("expr_change") else np.nan),
        "react_var_smile": (float(np.std(vals("smile_change"))) if len(vals("smile_change")) > 1 else np.nan),
    }
    # AU/情動の 負荷設問への反応性（Δ vs 基線）
    AU_REACT = ["AU12_lipCornerPuller", "AU15_lipCornerDepressor", "AU6_cheekRaiser",
                "AU4_browLowerer", "AU1_innerBrowRaiser", "AU7_lidTightener",
                "EMO_sadness", "EMO_distress", "EMO_nonduchenne"]
    for k in AU_REACT:
        out[f"{k}_react_loaded"] = mean(vals(f"{k}_change", True))
    return out


def main():
    files = sorted(glob.glob(str(DATA / "*.session.json")))
    subjects, phq, age, label = [], [], [], []
    all_feats = []
    traj = {"hr_change": [], "smile_change": []}   # per-subject 9-length trajectories
    domains = []
    for f in files:
        session, d, recs, fbase = per_session(Path(f))
        sid = (d.get("subject") or {}).get("id") or session[:12]
        subjects.append(sid)
        phq.append(float((d.get("result") or {}).get("total")))
        age.append(AGE_MID.get((d.get("subject") or {}).get("ageBand", ""), np.nan))
        label.append(1 if float((d.get("result") or {}).get("total")) >= 10 else 0)
        a = agg(recs)
        a.update(loaded_window_hrv(d))   # 負荷3設問 合併窓の pNN30/RMSSD/LF-HF（+基線比）
        # 安静時(trait)の AU: 作り笑い指数・笑(AU12)・悲(AU15/sadness)・頬(AU6)
        if fbase:
            for k in ("EMO_nonduchenne", "AU12_lipCornerPuller", "AU15_lipCornerDepressor",
                      "EMO_sadness", "AU6_cheekRaiser"):
                if isinstance(fbase.get(k), (int, float)) and not (isinstance(fbase.get(k), float) and np.isnan(fbase[k])):
                    a[f"{k}_rest"] = fbase[k]
        all_feats.append(a)
        recs_o = sorted(recs, key=lambda r: r["qn"] or 0)
        traj["hr_change"].append([r.get("hr_change") for r in recs_o])
        traj["smile_change"].append([r.get("smile_change") for r in recs_o])
        domains = [r["domain"] for r in recs_o]
    # union of keys → 欠損は nan（セッション間で列を揃える）
    keys = sorted(set().union(*[set(a.keys()) for a in all_feats])) if all_feats else []
    feats = {k: [(af.get(k) if af.get(k) is not None else np.nan) for af in all_feats] for k in keys}

    phq = np.array(phq); age = np.array(age); label = np.array(label)
    # screen
    screen = []
    for k, v in feats.items():
        v = np.array(v, float)
        screen.append({"key": k, "r_phq": round(spearman(v, phq), 3),
                       "r_age": round(spearman(v, age), 3), "r_partial": round(partial(v, phq, age), 3)})
    screen = [s for s in screen if not math.isnan(s["r_partial"])]
    screen.sort(key=lambda s: -abs(s["r_partial"]))

    print("=" * 78)
    print("【逐題ダイナミクス特徴 × PHQ（年齢制御 偏相関, |partial|降順）】")
    print(f"  {'特徴':<22}{'r_PHQ':>8}{'r_age':>8}{'r_PHQ|age':>11}")
    for s in screen:
        mark = "  ★" if abs(s["r_partial"]) >= 0.5 else ""
        print(f"  {s['key']:<22}{s['r_phq']:>8}{s['r_age']:>8}{s['r_partial']:>11}{mark}")

    payload = {
        "subjects": subjects, "phq": phq.tolist(), "age": [None if np.isnan(x) else x for x in age],
        "label": label.tolist(), "screen": screen, "domains": domains,
        "traj_hr": [[None if (x is None or (isinstance(x,float) and np.isnan(x))) else round(x,1) for x in row] for row in traj["hr_change"]],
        "traj_smile": [[None if (x is None or (isinstance(x,float) and np.isnan(x))) else round(x,4) for x in row] for row in traj["smile_change"]],
        "n": len(subjects), "n_pos": int(label.sum()),
    }
    def _jd(o):
        if isinstance(o, np.generic):
            return None if (isinstance(o, np.floating) and np.isnan(o)) else o.item()
        return None
    OUT.write_text(HTML.replace("/*DATA*/", json.dumps(payload, ensure_ascii=False, default=_jd)), encoding="utf-8")
    print(f"\n[report] {OUT}")
    return 0


HTML = r"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>逐題ダイナミクス（N=10）</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
 body{font:14px/1.6 "Segoe UI",system-ui,sans-serif;color:#20303f;max-width:1000px;margin:24px auto;padding:0 16px;background:#fbfcfd}
 h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:2px solid #e2e8ec;padding-bottom:4px}
 .warn{background:#fdf3e7;border:1px solid #f3d9b5;border-radius:8px;padding:10px 14px;color:#8a5a12}
 .card{background:#fff;border:1px solid #e2e8ec;border-radius:10px;padding:14px;margin-top:14px}
 .muted{color:#6b7b88}.big{font-size:22px;font-weight:700} canvas{max-height:340px}
</style></head><body>
<h1>回答中の逐題ダイナミクス — 探索（年齢制御）</h1>
<div class="warn"><b>⚠ 探索的（N=<span id=n></span>, 陽性=<span id=np></span>）。</b> 性別除外・年齢は偏相関で制御。各設問への即時反応。情緒負荷=心情/自責/自殺。</div>

<h2>① 設問別 心拍反応の軌跡（基線比, bpm）</h2>
<p class="muted">x=設問(領域), y=安静前からの HR 変化。赤=陽性。負荷設問(mood/self/suicide)で陽性が際立つか?</p>
<div class="card"><canvas id="c_hr"></canvas></div>
<h2>② 設問別 笑顔変化の軌跡</h2>
<div class="card"><canvas id="c_sm"></canvas></div>
<h2>③ 集約特徴 × PHQ（年齢制御後 |r|）</h2>
<div class="card"><canvas id="c_sc"></canvas></div>
<script>
const D=/*DATA*/; n.textContent=D.n; np.textContent=D.n_pos;
const labels=D.domains.map((d,i)=>`Q${i+1}\n${d}`);
function traj(id,key,ylabel){
 new Chart(document.getElementById(id),{type:'line',
  data:{labels:labels,datasets:D.subjects.map((s,i)=>({label:s,data:D[key][i],borderColor:D.label[i]?'#d6453f':'rgba(120,150,180,.55)',
   borderWidth:D.label[i]?3:1.5,pointRadius:2,tension:.25,spanGaps:true}))},
  options:{plugins:{legend:{display:false}},scales:{y:{title:{display:true,text:ylabel}}}}});
}
traj('c_hr','traj_hr','HR変化(bpm)'); traj('c_sm','traj_smile','笑顔変化');
const S=D.screen;
new Chart(c_sc,{type:'bar',data:{labels:S.map(s=>s.key),datasets:[
 {label:'|r PHQ| 年齢制御後',data:S.map(s=>Math.abs(s.r_partial)),backgroundColor:'#3a7bd5'},
 {label:'|r PHQ| 生',data:S.map(s=>Math.abs(s.r_phq)),backgroundColor:'#cfd8df'}]},
 options:{indexAxis:'y',scales:{x:{max:1,title:{display:true,text:'|Spearman r|'}}}}});
</script></body></html>"""

if __name__ == "__main__":
    raise SystemExit(main())
