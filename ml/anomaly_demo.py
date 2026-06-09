#!/usr/bin/env python3
"""
anomaly_demo.py — 顔（表情 blendshape + 478点 幾何）に絞った探索スクリーニング。

方針（ユーザ指示）:
  - 性別は定数(全員男性)なので除外。年齢は交絡として「偏相関」で除去。
  - 動画由来の顔特徴（face_* / geo_*）に焦点を当て、PHQ との関係を見る。
  - one-class（陰性で正常を学習→外れたら陽性）も顔特徴で実演（落とし穴の確認）。

出力: data/ml_report.html（Chart.js）+ コンソール要約。
実行: ml/.venv/Scripts/python.exe ml/anomaly_demo.py
"""
from __future__ import annotations
import csv, json, math, sys
from pathlib import Path
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DATA = Path(__file__).resolve().parent.parent / "data"
CSV = DATA / "dataset.csv"
OUT = DATA / "ml_report.html"
AGE_MID = {"10代": 15, "20代": 25, "30代": 35, "40代": 45, "50代": 55, "60代": 65, "70代以上": 75}

# 顔のスクリーニング対象: 安静前(trait)と反応性Δ の blendshape + 幾何
SCREEN_PREFIXES = ("face_rest_pre_", "face_react_", "geo_rest_pre_", "geo_react_")
DROP = ("track_rate",)  # 特徴でない列は除外

JP = {  # 表示名（無いものはキーをそのまま）
    "face_rest_pre_expressivity": "表出量 前", "face_react_expressivity": "表出量 反応",
    "face_rest_pre_smile": "笑顔 前", "face_react_smile": "笑顔 反応",
    "face_rest_pre_blink": "瞬目 前", "face_react_blink": "瞬目 反応",
    "face_rest_pre_browInnerUp": "内眉上げ 前", "face_react_browInnerUp": "内眉上げ 反応",
    "face_rest_pre_browDown": "眉下げ 前", "face_react_browDown": "眉下げ 反応",
    "face_rest_pre_jawOpen": "開口 前", "face_react_jawOpen": "開口 反応",
    "face_rest_pre_mouthFrown": "口への字 前", "face_react_mouthFrown": "口への字 反応",
    "face_rest_pre_head_move": "頭部運動 前", "face_react_head_move": "頭部運動 反応",
    "geo_rest_pre_ear": "目の開き EAR 前", "geo_react_ear": "目の開き EAR 反応",
    "geo_rest_pre_mar": "口の開き MAR 前", "geo_react_mar": "口の開き MAR 反応",
    "geo_rest_pre_smilecurve": "口角弧(笑) 前", "geo_react_smilecurve": "口角弧 反応",
    "geo_rest_pre_browraise": "眉高 前", "geo_react_browraise": "眉高 反応",
    "geo_rest_pre_browgap": "眉間 前", "geo_react_browgap": "眉間 反応",
}


def num(v):
    try:
        return float(v)
    except Exception:
        return float("nan")


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


def partial_spearman(f, p, a):
    """f と p の偏相関（a を制御）。Spearman r の partial 公式。"""
    rfp, rfa, rpa = spearman(f, p), spearman(f, a), spearman(p, a)
    if any(math.isnan(x) for x in (rfp, rfa, rpa)):
        return float("nan")
    den = math.sqrt(max(1e-9, (1 - rfa ** 2) * (1 - rpa ** 2)))
    return (rfp - rfa * rpa) / den


def main() -> int:
    rows = list(csv.DictReader(open(CSV, encoding="utf-8-sig")))
    cols = list(rows[0].keys())
    face_cols = [c for c in cols if c.startswith(SCREEN_PREFIXES) and not any(c.endswith(d) for d in DROP)]

    subj = [r["subject_id"] or r["session"][:12] for r in rows]
    phq = np.array([num(r["total"]) for r in rows])
    age = np.array([AGE_MID.get(r.get("age_band", ""), np.nan) for r in rows])
    label = np.array([1 if r["label_clinically_significant"] == "1" else 0 for r in rows])

    # --- 特徴スクリーニング: raw vs 年齢制御(partial) ---
    screen = []
    for c in face_cols:
        col = np.array([num(r.get(c)) for r in rows])
        if np.isnan(col).sum() > len(col) - 4:
            continue
        screen.append({
            "key": c, "label": JP.get(c, c),
            "r_phq": round(spearman(col, phq), 3),
            "r_age": round(spearman(col, age), 3),
            "r_partial": round(partial_spearman(col, phq, age), 3),
        })
    screen = [s for s in screen if not math.isnan(s["r_partial"])]
    screen.sort(key=lambda s: -abs(s["r_partial"]))

    # --- one-class（顔特徴のみ）: 陰性で正常を学習→異常スコア ---
    X = np.array([[num(r.get(c)) for c in face_cols] for r in rows])
    neg = label == 0
    mu = np.nanmean(X[neg], axis=0); sd = np.nanstd(X[neg], axis=0); sd[sd == 0] = 1
    Z = (np.where(np.isnan(X), mu, X) - mu) / sd
    anomaly = np.sqrt(np.nanmean(Z ** 2, axis=1))
    r_anom_phq, r_anom_age = spearman(anomaly, phq), spearman(anomaly, age)

    # ---- console ----
    print("=" * 74)
    print("【顔特徴スクリーニング】 年齢を偏相関で制御。|partial| 降順 上位:")
    print(f"  {'特徴':<16}{'r_PHQ(raw)':>11}{'r_age':>8}{'r_PHQ|age':>11}")
    for s in screen[:12]:
        mark = "  ★" if abs(s["r_partial"]) >= 0.5 else ""
        print(f"  {s['label']:<16}{s['r_phq']:>11}{s['r_age']:>8}{s['r_partial']:>11}{mark}")
    print(f"\n【one-class(顔)】 異常スコア vs PHQ r={r_anom_phq:+.3f} / vs 年齢 r={r_anom_age:+.3f}")

    payload = {
        "subjects": subj, "phq": [None if np.isnan(v) else v for v in phq],
        "age": [None if np.isnan(v) else v for v in age], "label": label.tolist(),
        "anomaly": [round(v, 3) for v in anomaly],
        "anom_phq_r": round(r_anom_phq, 3), "anom_age_r": round(r_anom_age, 3),
        "screen": screen, "n": len(rows), "n_pos": int(label.sum()),
        "top": screen[0] if screen else None,
        "top_vals": [num(r.get(screen[0]["key"])) if screen else None for r in rows] if screen else [],
    }
    OUT.write_text(HTML.replace("/*DATA*/", json.dumps(payload, ensure_ascii=False, default=lambda o: None)),
                   encoding="utf-8")
    print(f"\n[report] {OUT}")
    return 0


HTML = r"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>顔特徴 探索レポート（N=10・年齢制御）</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
 body{font:14px/1.6 "Segoe UI",system-ui,sans-serif;color:#20303f;max-width:1000px;margin:24px auto;padding:0 16px;background:#fbfcfd}
 h1{font-size:22px} h2{font-size:17px;margin-top:28px;border-bottom:2px solid #e2e8ec;padding-bottom:4px}
 .warn{background:#fdf3e7;border:1px solid #f3d9b5;border-radius:8px;padding:10px 14px;color:#8a5a12}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:720px){.grid{grid-template-columns:1fr}}
 .card{background:#fff;border:1px solid #e2e8ec;border-radius:10px;padding:14px}
 .big{font-size:24px;font-weight:700}.muted{color:#6b7b88}
 table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e2e8ec;padding:5px 8px;text-align:right}
 th:first-child,td:first-child{text-align:left}.pos{background:#fdecec}
 canvas{max-height:340px}
</style></head><body>
<h1>顔（表情＋特徴点）スクリーニング — 探索レポート</h1>
<div class="warn"><b>⚠ 探索的（N=<span id="n"></span>, 陽性=<span id="np"></span>）。</b>
性別は除外（全員男性）。年齢は<b>偏相関で制御</b>。検定・予測モデルではなく方向の手がかり。</div>

<h2>① 顔特徴 × PHQ（年齢を制御した偏相関）</h2>
<p><b>青=年齢制御後</b>の |相関|、<b>灰=生</b>の |相関|。青が大きく残る特徴＝年齢では説明できない PHQ 関連候補。</p>
<div class="card"><canvas id="c_feat"></canvas></div>

<h2>② 最有力特徴 × PHQ（点の色＝年齢）</h2>
<div class="grid">
 <div class="card"><b id="topname"></b> <span class="muted">r(PHQ|age)=<span id="topr" class="big"></span></span><canvas id="c_top"></canvas></div>
 <div class="card"><b>one-class 異常スコア</b><br><span class="muted">vs PHQ r=<span class="big" id="rphq"></span> / vs 年齢 r=<span id="rage"></span></span><canvas id="c_anom"></canvas></div>
</div>

<h2>③ 被験者一覧</h2>
<table id="tbl"><thead><tr><th>被験者</th><th>年齢</th><th>PHQ</th><th>陽性</th><th>最有力特徴</th><th>異常スコア</th></tr></thead><tbody></tbody></table>

<script>
const D=/*DATA*/;
n.textContent=D.n;np.textContent=D.n_pos;rphq.textContent=D.anom_phq_r;rage.textContent=D.anom_age_r;
const S=D.screen.slice(0,12);
new Chart(c_feat,{type:'bar',data:{labels:S.map(s=>s.label),datasets:[
 {label:'|r PHQ| 年齢制御後',data:S.map(s=>Math.abs(s.r_partial)),backgroundColor:'#3a7bd5'},
 {label:'|r PHQ| 生',data:S.map(s=>Math.abs(s.r_phq)),backgroundColor:'#cfd8df'}]},
 options:{indexAxis:'y',scales:{x:{max:1,title:{display:true,text:'|Spearman r|'}}}}});
// top feature scatter
if(D.top){topname.textContent=D.top.label+' × PHQ';topr.textContent=D.top.r_partial;
 const pts=D.subjects.map((s,i)=>({x:D.phq[i],y:D.top_vals[i],a:D.age[i],l:s}));
 const ac=a=>`hsl(${210-(a-20)*3},70%,50%)`;
 new Chart(c_top,{type:'scatter',data:{datasets:[{data:pts,pointRadius:7,pointBackgroundColor:pts.map(p=>ac(p.a))}]},
  options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.raw.l}: PHQ=${c.raw.x}, ${D.top.label}=${(c.raw.y||0).toFixed?c.raw.y.toFixed(3):c.raw.y}, 年齢=${c.raw.a}`}}},
   scales:{x:{title:{display:true,text:'PHQ'}},y:{title:{display:true,text:D.top.label}}}}});}
// anomaly vs phq
new Chart(c_anom,{type:'scatter',data:{datasets:[{data:D.subjects.map((s,i)=>({x:D.phq[i],y:D.anomaly[i],l:s,pos:D.label[i]})),
 pointRadius:6,pointBackgroundColor:D.label.map(l=>l?'#d6453f':'#3a7bd5')}]},
 options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.raw.l}: PHQ=${c.raw.x}, anom=${c.raw.y}`}}},
  scales:{x:{title:{display:true,text:'PHQ'}},y:{title:{display:true,text:'異常スコア'}}}}});
const tb=document.querySelector('#tbl tbody');
D.subjects.map((s,i)=>({s,a:D.age[i],p:D.phq[i],l:D.label[i],t:D.top_vals[i],an:D.anomaly[i]}))
 .sort((x,y)=>y.p-x.p).forEach(r=>{const tr=document.createElement('tr');if(r.l)tr.className='pos';
 tr.innerHTML=`<td>${r.s}</td><td>${r.a??''}</td><td>${r.p??''}</td><td>${r.l?'●':''}</td><td>${r.t==null?'':(+r.t).toFixed(3)}</td><td>${r.an}</td>`;tb.appendChild(tr);});
</script></body></html>"""

if __name__ == "__main__":
    raise SystemExit(main())
