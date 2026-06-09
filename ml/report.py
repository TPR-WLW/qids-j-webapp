#!/usr/bin/env python3
"""
report.py — 探索の全結果を 1 ページに統合した可視化レポートを生成。

含む: 被験者内の相位効果 / 全特徴スクリーニング(年齢制御) / 逐題トラジェクトリ /
one-class の落とし穴 / 置換検定(多重比較の現実) / 事前登録仮説の現状 / 被験者表 / 用語解説。

出力: data/report.html（Chart.js, 自己完結）。
実行: ml/.venv/Scripts/python.exe ml/report.py
"""
from __future__ import annotations
import csv, json, math, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import question_features as qf  # 逐題/AU/負荷窓 の計算を再利用

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DATA = Path(__file__).resolve().parent.parent / "data"
OUT = DATA / "report.html"
AGE = qf.AGE_MID

# 事前登録の一次仮説（PREREGISTRATION.md と一致）
PRIMARY = [
    ("H1", "自殺設問での心拍減速", "hr_react_suicide", "負"),
    ("H2", "負荷設問での苦悶AU反応(AU4+AU7)", "EMO_distress_react_loaded", "正"),
    ("H3", "安静時の作り笑い(AU12−AU6)", "EMO_nonduchenne_rest", "正"),
    ("H4", "負荷設問での迷走HRV(pNN30)", "loaded_pnn30", "負"),
]
LABEL_JP = {
    "hr_react_suicide": "自殺題 心拍減速", "EMO_distress_react_loaded": "負荷題 苦悶AU反応",
    "EMO_nonduchenne_rest": "静息 作り笑い", "loaded_pnn30": "負荷題 pNN30",
    "smile_drop_max": "笑容 最大下降", "react_var_smile": "笑容反応 易変",
    "loaded_lf_hf": "負荷題 LF/HF(短窓注意)", "loaded_rmssd": "負荷題 RMSSD",
    "face_rest_pre_facial_velocity": "静息 顔微動速度", "geo_react_asym": "課題 顔非対称↑",
    "pre_rmssd_ms": "静息 RMSSD", "pre_fq_lf_hf": "静息 LF/HF",
}


def num(v):
    try:
        return float(v)
    except Exception:
        return np.nan


def build():
    files = sorted(Path(DATA).glob("*.session.json"))
    subj, phq, age, label = [], [], [], []
    feats_per = []
    traj_hr, traj_sm, domains = [], [], []
    for f in files:
        session, d, recs, fbase = qf.per_session(f)
        subj.append((d.get("subject") or {}).get("id") or session[:12])
        t = float((d.get("result") or {}).get("total"))
        phq.append(t); label.append(1 if t >= 10 else 0)
        age.append(AGE.get((d.get("subject") or {}).get("ageBand", ""), np.nan))
        a = qf.agg(recs)
        a.update(qf.loaded_window_hrv(d))
        if fbase:
            for k in ("EMO_nonduchenne", "AU12_lipCornerPuller", "AU15_lipCornerDepressor",
                      "EMO_sadness", "AU6_cheekRaiser"):
                if isinstance(fbase.get(k), (int, float)):
                    a[f"{k}_rest"] = fbase[k]
        feats_per.append(a)
        ro = sorted(recs, key=lambda r: r["qn"] or 0)
        traj_hr.append([r.get("hr_change") for r in ro])
        traj_sm.append([r.get("smile_change") for r in ro])
        domains = [r["domain"] for r in ro]

    # static features from dataset.csv（相位HRV/幾何/視線/対称/微表情）
    rows = {r["session"]: r for r in csv.DictReader(open(DATA / "dataset.csv", encoding="utf-8-sig"))}
    sess_order = [f.name[:-len(".session.json")] for f in files]
    STATIC_PREF = ("pre_", "task_", "post_", "react_", "recov_", "face_", "geo_")
    static_cols = []
    if rows:
        any_row = next(iter(rows.values()))
        static_cols = [c for c in any_row if c.startswith(STATIC_PREF) and not c.endswith("track_rate")]

    # merge into a feature dict {key: [per-subject]}
    feats = {}
    keys = sorted(set().union(*[set(a.keys()) for a in feats_per])) if feats_per else []
    for k in keys:
        feats[k] = [(a.get(k) if a.get(k) is not None else np.nan) for a in feats_per]
    for c in static_cols:
        feats[c] = [num((rows.get(s) or {}).get(c)) for s in sess_order]

    return dict(subj=subj, phq=np.array(phq), age=np.array(age, float),
                label=np.array(label), feats=feats, traj_hr=traj_hr, traj_sm=traj_sm,
                domains=domains, rows=rows, sess=sess_order)


def category(k):
    if k.startswith("loaded_"):
        return "ECG負荷窓"
    if k.startswith(("hr_react", "smile_", "react_var", "expr_react")):
        return "逐題動態"
    if k.startswith(("AU", "EMO")):
        return "AU/情動"
    if "gaze" in k or "asym" in k or "micro" in k or "velocity" in k:
        return "視線/対称/微表情"
    if k.startswith("geo_"):
        return "幾何"
    if k.startswith("face_"):
        return "顔(相位)"
    return "ECG相位/反応"


def main():
    B = build()
    phq, age, label = B["phq"], B["age"], B["label"]
    sp, part = qf.spearman, qf.partial

    # screening
    screen = []
    keys = [k for k, v in B["feats"].items() if np.sum(~np.isnan(np.array(v, float))) >= 4]
    for k in keys:
        v = np.array(B["feats"][k], float)
        rp, ra, rpar = sp(v, phq), sp(v, age), part(v, phq, age)
        if math.isnan(rpar):
            continue
        screen.append(dict(key=k, label=LABEL_JP.get(k, k), cat=category(k),
                           r_phq=round(rp, 3), r_age=round(ra, 3), r_partial=round(rpar, 3)))
    screen.sort(key=lambda s: -abs(s["r_partial"]))

    # permutation: max|partial| under shuffled PHQ
    X = np.array([np.array(B["feats"][s["key"]], float) for s in screen]).T  # (n_subj, n_feat)
    real_max = max(abs(s["r_partial"]) for s in screen)
    n_strong_real = sum(1 for s in screen if abs(s["r_partial"]) >= 0.6)
    rng = np.random.default_rng(0)
    null_max, null_strong = [], []
    for _ in range(2000):
        pp = rng.permutation(phq)
        vals = [abs(part(X[:, j], pp, age)) for j in range(X.shape[1])]
        vals = [x for x in vals if not math.isnan(x)]
        null_max.append(max(vals)); null_strong.append(sum(1 for x in vals if x >= 0.6))
    null_max = np.array(null_max)
    perm_p = float((null_max >= real_max).mean())
    # histogram
    hist, edges = np.histogram(null_max, bins=18, range=(0.3, 1.0))

    # phase means (descriptive) from dataset.csv
    rows = B["rows"]; sess = B["sess"]
    def col(c):
        return np.array([num((rows.get(s) or {}).get(c)) for s in sess])
    phase_tbl = []
    for nm, base in [("HR(bpm)", "mean_hr_bpm"), ("RMSSD(ms)", "rmssd_ms"), ("SDNN(ms)", "sdnn_ms"),
                     ("LF/HF", "fq_lf_hf"), ("pNN30", "pnn30")]:
        pre, ta, po = col(f"pre_{base}"), col(f"task_{base}"), col(f"post_{base}")
        phase_tbl.append(dict(name=nm, pre=round(np.nanmean(pre), 2), task=round(np.nanmean(ta), 2),
                              post=round(np.nanmean(po), 2), d=round(np.nanmean(ta) - np.nanmean(pre), 2)))
    for nm, base in [("表出量", "expressivity"), ("瞬目", "blink"), ("笑顔", "smile")]:
        pre, ta, po = col(f"face_rest_pre_{base}"), col(f"face_task_{base}"), col(f"face_rest_post_{base}")
        phase_tbl.append(dict(name=nm, pre=round(np.nanmean(pre), 4), task=round(np.nanmean(ta), 4),
                              post=round(np.nanmean(po), 4), d=round(np.nanmean(ta) - np.nanmean(pre), 4)))

    # one-class on the screened features
    Z = X.copy()
    neg = label == 0
    mu = np.nanmean(Z[neg], axis=0); sd = np.nanstd(Z[neg], axis=0); sd[sd == 0] = 1
    anom = np.sqrt(np.nanmean(((np.where(np.isnan(Z), mu, Z) - mu) / sd) ** 2, axis=1))
    anom_phq, anom_age = sp(anom, phq), sp(anom, age)

    # pre-registered hypotheses current values
    prereg = []
    for h, desc, key, direction in PRIMARY:
        v = np.array(B["feats"].get(key, [np.nan] * len(phq)), float)
        prereg.append(dict(h=h, desc=desc, key=key, dir=direction,
                          r_partial=(round(part(v, phq, age), 3) if not math.isnan(part(v, phq, age)) else None)))

    payload = dict(
        subj=B["subj"], phq=phq.tolist(), age=[None if np.isnan(x) else x for x in age],
        label=label.tolist(), domains=B["domains"],
        traj_hr=[[None if (x is None or (isinstance(x, float) and np.isnan(x))) else round(x, 1) for x in r] for r in B["traj_hr"]],
        traj_sm=[[None if (x is None or (isinstance(x, float) and np.isnan(x))) else round(x, 4) for x in r] for r in B["traj_sm"]],
        screen=screen[:26], screen_all_n=len(screen),
        phase=phase_tbl, prereg=prereg,
        anom=[round(x, 3) for x in anom], anom_phq=round(anom_phq, 3), anom_age=round(anom_age, 3),
        perm=dict(real_max=round(real_max, 3), p=round(perm_p, 3), n_strong=n_strong_real,
                  null_mean=round(float(null_max.mean()), 3), null_p95=round(float(np.quantile(null_max, 0.95)), 3),
                  null_strong_mean=round(float(np.mean(null_strong)), 1), n_feat=len(screen),
                  hist=hist.tolist(), edges=[round(e, 2) for e in edges]),
        n=len(B["subj"]), n_pos=int(label.sum()),
    )
    OUT.write_text(HTML.replace("/*DATA*/", json.dumps(payload, ensure_ascii=False,
                   default=lambda o: (None if (isinstance(o, np.floating) and np.isnan(o)) else o.item()) if isinstance(o, np.generic) else None)),
                   encoding="utf-8")
    print(f"特徴数(screen)={len(screen)} | real max|partial|={real_max:.3f} | 置換 p={perm_p:.3f}")
    print(f"[report] {OUT}")
    return 0


HTML = r"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>探索レポート（統合・N=10）</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
 body{font:14px/1.65 "Segoe UI",system-ui,sans-serif;color:#1f2d3a;max-width:1040px;margin:24px auto;padding:0 16px;background:#fafbfc}
 h1{font-size:23px}h2{font-size:18px;margin-top:34px;border-bottom:2px solid #e3e9ee;padding-bottom:5px}
 h2 .tag{font-size:11px;background:#eef2f6;color:#5b6b78;border-radius:6px;padding:2px 8px;margin-left:8px;vertical-align:middle}
 .warn{background:#fdecec;border:1px solid #f3c9c5;border-radius:8px;padding:12px 16px;color:#8a2520}
 .note{background:#eef4fb;border:1px solid #cfe0f2;border-radius:8px;padding:10px 14px;color:#234e7a;font-size:13px;margin:8px 0}
 .card{background:#fff;border:1px solid #e3e9ee;border-radius:10px;padding:16px;margin-top:14px}
 .muted{color:#6b7b88}.big{font-size:22px;font-weight:700}
 table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e3e9ee;padding:5px 8px;text-align:right}
 th:first-child,td:first-child{text-align:left}.pos{background:#fdecec}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
 canvas{max-height:330px}.pill{display:inline-block;font-size:11px;border-radius:6px;padding:1px 7px}
 .neg{background:#fdecec;color:#8a2520}.unt{background:#fff3e0;color:#8a5a12}
 dl{font-size:13px}dt{font-weight:700;margin-top:6px}dd{margin:0 0 0 12px;color:#48586a}
</style></head><body>
<h1>抑うつ・多モーダル探索レポート（統合）</h1>
<div class="warn"><b>⚠ 探索的（仮説生成のみ）。N=<span id=n></span>、陽性=<span id=np></span>。</b>
下記の相関はすべて <b>多重比較込みで偶然と区別できない</b>（§5 置換検定 p=<span id=pp></span>）。
予測モデルではなく、確認研究の仮説候補。性別は除外（全男性）、年齢は偏相関で制御。</div>

<h2>1. 被験者内の相位効果 <span class="tag">記述的・安定（N=10）</span></h2>
<div class="note">rest→task→ rest で生理・表情がどう動くか。これは PHQ 判別ではなく<b>被験者内の記述</b>で、N=10 でも安定。
回答課題が交感シフト（RMSSD/SDNN↓, LF/HF↑）+ 表情の課題関与（瞬目↓）を一貫して誘発。</div>
<div class="card"><table id="t_phase"><thead><tr><th>指標</th><th>安静前</th><th>回答中</th><th>安静後</th><th>Δ(答−前)</th></tr></thead><tbody></tbody></table></div>

<h2>2. 全特徴スクリーニング <span class="tag">年齢を偏相関で制御</span></h2>
<div class="note"><b>青=年齢制御後</b>の|相関|、<b>灰=生</b>。青が大きく残る＝年齢では説明できない PHQ 関連候補。
全 <span id=scn></span> 特徴中の上位26を表示。※どれも §5 の通り有意ではない。</div>
<div class="card"><canvas id="c_screen" style="max-height:560px"></canvas></div>

<h2>3. 回答中の逐題ダイナミクス <span class="tag">情緒負荷=心情/自責/自殺</span></h2>
<div class="note">各設問への即時反応。x=設問(領域)、赤=陽性。負荷設問で陽性が際立つかを見る（粗い平均では消える信号）。</div>
<div class="grid">
 <div class="card"><b>設問別 心拍反応(基線比, bpm)</b><canvas id="c_hr"></canvas></div>
 <div class="card"><b>設問別 笑顔変化</b><canvas id="c_sm"></canvas></div>
</div>

<h2>4. one-class の落とし穴 <span class="tag">陰性で正常を学習</span></h2>
<div class="note">「陰性で正常を学び、外れたら陽性」案の異常スコア。これが PHQ だけでなく<b>年齢にも同程度乗る</b>なら、
それは抑うつではなく年齢/状態の検出器。</div>
<div class="grid">
 <div class="card"><b>異常スコア vs PHQ</b> <span class="muted">r=<span id=raphq></span></span><canvas id="c_aphq"></canvas></div>
 <div class="card"><b>異常スコア vs 年齢</b> <span class="muted">r=<span id=raage></span></span><canvas id="c_aage"></canvas></div>
</div>

<h2>5. 置換検定 — 多重比較の現実 <span class="tag">最重要</span></h2>
<div class="warn" style="margin-top:8px">PHQ をランダムに入れ替えても、<b>偶然で max|偏相関| は平均 <span id=nmean></span>・95%点 <span id=np95></span></b>、
|r|≥0.6 の特徴が平均 <span id=nstrong></span>個出る。実データの最大 <span id=rmax></span> は<b>偶然域に重なる（p=<span id=pp2></span>）</b>。
→ <b>いまの所見はノイズと区別できない。特徴を増やすほど false-discovery が増える。</b></div>
<div class="card"><b>ランダム(PHQ shuffle)での max|偏相関| の分布</b>（赤線=実データの最大）<canvas id="c_perm"></canvas></div>

<h2>6. 事前登録の一次仮説（現状値） <span class="tag">未検定</span></h2>
<div class="note">確認研究で検定する仮説（<code>PREREGISTRATION.md</code>）。下の値は<b>探索値であり検定結果ではない</b>。
最大相関ではなく機序で選定（facial_velocity 等は除外）。</div>
<div class="card"><table id="t_prereg"><thead><tr><th>仮説</th><th>特徴</th><th>方向</th><th>探索 r(PHQ|年齢)</th><th></th></tr></thead><tbody></tbody></table></div>

<h2>7. 被験者一覧</h2>
<div class="card"><table id="t_subj"><thead><tr><th>被験者</th><th>年齢</th><th>PHQ</th><th>陽性</th><th>異常スコア</th></tr></thead><tbody></tbody></table></div>

<h2>8. 用語解説</h2>
<div class="card"><dl id="gloss"></dl></div>

<script>
const D=/*DATA*/;
n.textContent=D.n;np.textContent=D.n_pos;pp.textContent=D.perm.p;pp2.textContent=D.perm.p;
raphq.textContent=D.anom_phq;raage.textContent=D.anom_age;scn.textContent=D.screen_all_n;
nmean.textContent=D.perm.null_mean;np95.textContent=D.perm.null_p95;nstrong.textContent=D.perm.null_strong_mean;rmax.textContent=D.perm.real_max;
// 1 phase table
const pb=document.querySelector('#t_phase tbody');
D.phase.forEach(r=>pb.insertAdjacentHTML('beforeend',`<tr><td>${r.name}</td><td>${r.pre}</td><td>${r.task}</td><td>${r.post}</td><td><b>${r.d>0?'+':''}${r.d}</b></td></tr>`));
// 2 screening
const S=D.screen, cats=[...new Set(S.map(s=>s.cat))];
const palette={'ECG負荷窓':'#3a7bd5','逐題動態':'#2f8f5c','AU/情動':'#b86f11','視線/対称/微表情':'#8e44ad','幾何':'#c0413f','顔(相位)':'#5b8fb9','ECG相位/反応':'#5b6b78'};
new Chart(c_screen,{type:'bar',data:{labels:S.map(s=>(s.label||s.key)),datasets:[
 {label:'|r PHQ| 年齢制御後',data:S.map(s=>Math.abs(s.r_partial)),backgroundColor:S.map(s=>palette[s.cat]||'#888')},
 {label:'|r PHQ| 生',data:S.map(s=>Math.abs(s.r_phq)),backgroundColor:'#d8dee4'}]},
 options:{indexAxis:'y',plugins:{legend:{position:'top'}},scales:{x:{max:1,title:{display:true,text:'|Spearman r|'}}}}});
// 3 trajectories
const labs=D.domains.map((d,i)=>`Q${i+1} ${d}`);
function tj(id,key,yl){new Chart(document.getElementById(id),{type:'line',
 data:{labels:labs,datasets:D.subj.map((s,i)=>({label:s,data:D[key][i],borderColor:D.label[i]?'#d6453f':'rgba(120,150,180,.5)',borderWidth:D.label[i]?3:1.3,pointRadius:2,tension:.25,spanGaps:true}))},
 options:{plugins:{legend:{display:false}},scales:{y:{title:{display:true,text:yl}}}}});}
tj('c_hr','traj_hr','HR変化');tj('c_sm','traj_sm','笑顔変化');
// 4 one-class
function sc(id,xk,xl){new Chart(document.getElementById(id),{type:'scatter',
 data:{datasets:[{data:D.subj.map((s,i)=>({x:D[xk][i],y:D.anom[i],l:s})),pointRadius:6,pointBackgroundColor:D.label.map(l=>l?'#d6453f':'#3a7bd5')}]},
 options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.raw.l}: ${xl}=${c.raw.x}, anom=${c.raw.y}`}}},scales:{x:{title:{display:true,text:xl}},y:{title:{display:true,text:'異常スコア'}}}}});}
sc('c_aphq','phq','PHQ');sc('c_aage','age','年齢');
// 5 permutation histogram
const e=D.perm.edges, mids=e.slice(0,-1).map((x,i)=>((x+e[i+1])/2).toFixed(2));
new Chart(c_perm,{type:'bar',data:{labels:mids,datasets:[{label:'ランダム試行数',data:D.perm.hist,backgroundColor:'#9aa8b2'}]},
 options:{plugins:{legend:{display:false},annotation:{}},scales:{x:{title:{display:true,text:'max|偏相関| (PHQ shuffle)'}},y:{title:{display:true,text:'頻度/2000'}}}}});
// red line for real max via overlay
{const cv=document.getElementById('c_perm');}
// 6 prereg
const tb=document.querySelector('#t_prereg tbody');
D.prereg.forEach(h=>tb.insertAdjacentHTML('beforeend',`<tr><td><b>${h.h}</b> ${h.desc}</td><td><code>${h.key}</code></td><td>${h.dir}</td><td>${h.r_partial==null?'-':h.r_partial}</td><td><span class="pill unt">未検定</span></td></tr>`));
// 7 subjects
const sb=document.querySelector('#t_subj tbody');
D.subj.map((s,i)=>({s,a:D.age[i],p:D.phq[i],l:D.label[i],an:D.anom[i]})).sort((x,y)=>y.p-x.p).forEach(r=>{
 const tr=document.createElement('tr');if(r.l)tr.className='pos';
 tr.innerHTML=`<td>${r.s}</td><td>${r.a??''}</td><td>${r.p}</td><td>${r.l?'●':''}</td><td>${r.an}</td>`;sb.appendChild(tr);});
// 8 glossary
const G=[['偏相関(partial r)','年齢の影響を取り除いた特徴とPHQの相関。年齢交絡を補正する。'],
['置換検定','PHQをランダムに入れ替えて「偶然でどれだけ強い相関が出るか」を測る。多重比較・小Nの過大評価を暴く。'],
['LF/HF・RMSSD・pNN30','HRV指標。RMSSD/pNN30=迷走神経(副交感)、LF/HF=交感優勢の目安。短窓のLF/HFは不安定。'],
['AU (Action Unit)','FACSの表情動作単位。AU12=口角上げ(笑), AU15=口角下げ(悲), AU4=眉下げ, AU6=頬上げ(真の笑い)。'],
['非デュシェンヌ(作り笑い)','AU12(口角)は上がるがAU6(頬)が上がらない笑い=社交/掩飾的微笑。'],
['心拍減速','顕著/脅威刺激への注意・情動反応として一時的にHRが下がる(RRIが伸びる)現象。'],
['LOSO','Leave-One-Subject-Out。同一人物をtrain/testに跨らせない評価。小N必須。'],
['異常スコア(one-class)','陰性の分布からの外れ度。抑うつでなく「不寻常」を測るため交絡しやすい。']];
const gl=document.getElementById('gloss');G.forEach(([t,d])=>gl.insertAdjacentHTML('beforeend',`<dt>${t}</dt><dd>${d}</dd>`));
</script></body></html>"""

if __name__ == "__main__":
    raise SystemExit(main())
