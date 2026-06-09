#!/usr/bin/env python3
"""
build_dataset.py — セッション群を ML 用の特徴量テーブルに集約する。

入力: data/*.session.json（サーバが書き出す統合ログ）。生の CSV/動画はそのまま残す。
出力: data/dataset.csv（1 行 = 1 セッション）と標準出力のサマリ。

設計方針（小サンプル・二値分類向け）:
  - ラベル y は「臨床的に有意か否か」。total >= cutoff[survey] を陽性とする（下の CUTOFF）。
    ※ 問診の回答そのものは特徴に使わない（スコアの定義に等しく、リーク/循環になる）。
  - 特徴 X は ECG/HRV（全体 + 相位別 rest_pre/task/rest_post + 相位間差分）と被験者背景。
    顔特徴は抽出済み landmark があれば後段で結合（現状はフラグのみ）。
  - 品質管理(QC)列を必ず出す: ECG サンプル数・拍数・HRV の生理的妥当性・相位/動画/顔の有無。
    → 解析前にダメなセッションを除外できるようにする。
  - 旧フォーマット（phases なし）にも頑健: phases があれば使い、無ければ全体 HRV にフォールバック。

依存: 標準ライブラリのみ（pandas 不要）。
"""
from __future__ import annotations

import csv
import glob
import gzip
import json
import statistics as _st
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

try:  # Windows コンソール(cp932)でも日本語/記号を出せるように
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

# --- ラベルの閾値（研究上の決定。必要に応じて調整）-----------------------------
# 「臨床的に有意」＝中等度以上を陽性とする一般的なスクリーニング閾値。
#   PHQ-9: >=10（moderate+）   QIDS-J: >=11（moderate+）
# 「何らかの抑うつ」を陽性にしたい場合は PHQ-9>=5 / QIDS-J>=6 に変更。
CUTOFF = {"phq-9": 10, "qids-j": 11}

# HRV が生理的に妥当とみなす緩い範囲（伪迹検出用の目安）
RMSSD_PLAUSIBLE = (5.0, 200.0)     # ms
MEAN_HR_PLAUSIBLE = (35.0, 180.0)  # bpm
MIN_USABLE_BEATS = 30              # これ未満は HRV 不安定として QC で警告

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUT_CSV = DATA_DIR / "dataset.csv"


def _scalars(d: Any, prefix: str) -> dict[str, float]:
    """dict 内の数値スカラーだけを prefix 付きで取り出す（配列/真偽値/文字列は除外）。"""
    out: dict[str, float] = {}
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                out[f"{prefix}{k}"] = float(v)
    return out


def _hrv_block(phase: Optional[dict[str, Any]]) -> dict[str, Any]:
    """1 相位（または全体 ecg）の HRV/周波数/自律神経スカラーを平坦化。"""
    if not isinstance(phase, dict):
        return {}
    out: dict[str, Any] = {}
    out.update(_scalars(phase.get("hrv"), ""))
    out.update(_scalars(phase.get("frequency"), "fq_"))
    out.update(_scalars(phase.get("autonomic"), "an_"))
    return out


def _label(survey_id: str, total: Optional[float]) -> Optional[int]:
    if total is None or survey_id not in CUTOFF:
        return None
    return int(total >= CUTOFF[survey_id])


def _faces_path(session: str) -> Optional[Path]:
    for ext in (".landmarks.json.gz", ".landmarks.json"):
        p = DATA_DIR / (session + ext)
        if p.exists():
            return p
    return None


def _iso_ms(iso: Optional[str]) -> Optional[float]:
    try:
        return datetime.fromisoformat(iso).timestamp() * 1000.0
    except Exception:  # noqa: BLE001
        return None


# 抑うつ関連の顔指標（表情の表出減弱・笑顔減少などを意識した最小セット）
FACE_REACT_KEYS = ("expressivity", "blink", "smile", "browDown", "jawOpen", "head_move")


def facial_features(d: dict[str, Any], faces_path: Path) -> dict[str, Any]:
    """landmark を相位窓（壁時計）に対応づけ、相位別の顔特徴 + 反応性差分を返す。

    フレーム t（動画 ms）+ sync.recorderStartIso = 壁時計 → phases の窓に割当てる。
    """
    try:
        with gzip.open(faces_path, "rt", encoding="utf-8") as f:
            doc = json.load(f)
    except Exception:  # noqa: BLE001
        return {"has_faces": 1}
    meta = doc.get("meta") or {}
    names = meta.get("blendshape_names") or []
    nidx = {n: i for i, n in enumerate(names)}
    base = _iso_ms((d.get("sync") or {}).get("recorderStartIso"))
    phases = d.get("phases") or {}

    out: dict[str, Any] = {"has_faces": 1, "face_track_rate_overall": meta.get("track_rate")}
    if not names or base is None or not phases:
        return out

    buckets: dict[str, list] = {"rest_pre": [], "task": [], "rest_post": []}
    for fr in doc.get("frames", []):
        wall = base + fr.get("t", 0)
        for k in buckets:
            p = phases.get(k) or {}
            a, b = p.get("startTs"), p.get("endTs")
            if a is not None and a <= wall < (b if b is not None else float("inf")):
                buckets[k].append(fr)
                break

    def mean_of(face_frames, *bs_names):
        vals = []
        for fr in face_frames:
            bs = fr.get("bs")
            if not bs:
                continue
            xs = [bs[nidx[n]] for n in bs_names if n in nidx]
            if xs:
                vals.append(sum(xs) / len(xs))
        return round(_st.mean(vals), 5) if vals else None

    def phase_feats(frames):
        face = [fr for fr in frames if fr.get("face") and fr.get("bs")]
        if not face:
            return {}
        # 表出量: 各 blendshape の時間方向 std の平均（顔の動きの大きさ）
        stds = []
        for i in range(len(names)):
            col = [fr["bs"][i] for fr in face if fr.get("bs")]
            if len(col) > 1:
                stds.append(_st.pstdev(col))
        feats = {
            "track_rate": round(len(face) / len(frames), 4) if frames else None,
            "expressivity": round(sum(stds) / len(stds), 5) if stds else None,
            "blink": mean_of(face, "eyeBlinkLeft", "eyeBlinkRight"),
            "smile": mean_of(face, "mouthSmileLeft", "mouthSmileRight"),
            "browInnerUp": mean_of(face, "browInnerUp"),
            "browDown": mean_of(face, "browDownLeft", "browDownRight"),
            "jawOpen": mean_of(face, "jawOpen"),
            "mouthFrown": mean_of(face, "mouthFrownLeft", "mouthFrownRight"),
        }
        poses = [fr["pose"] for fr in face if fr.get("pose")]
        if len(poses) > 1:
            feats["head_move"] = round(sum(_st.pstdev([p[j] for p in poses]) for j in range(3)), 3)
        return feats

    pf = {k: phase_feats(buckets[k]) for k in buckets}
    for k, fv in pf.items():
        for name, v in fv.items():
            out[f"face_{k}_{name}"] = v
    # reactivity = task - rest_pre
    for fk in FACE_REACT_KEYS:
        a, b = pf["task"].get(fk), pf["rest_pre"].get(fk)
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            out[f"face_react_{fk}"] = round(a - b, 5)
    return out


def _delta(a: dict[str, Any], b: dict[str, Any], keys: tuple[str, ...]) -> dict[str, float]:
    """相位間差分（reactivity / recovery）。両相位に存在する指標のみ。"""
    out: dict[str, float] = {}
    for k in keys:
        if k in a and k in b and isinstance(a[k], (int, float)) and isinstance(b[k], (int, float)):
            out[k] = float(a[k]) - float(b[k])
    return out


DELTA_KEYS = ("mean_hr_bpm", "sdnn_ms", "rmssd_ms", "pnn50", "mean_rri_ms")


def build_row(path: Path) -> dict[str, Any]:
    d = json.load(open(path, encoding="utf-8"))
    survey = (d.get("survey") or {})
    sid = survey.get("id") or ""
    res = d.get("result") or {}
    subj = d.get("subject") or {}
    ecg = d.get("ecg") or {}
    phases = d.get("phases") or {}

    total = res.get("total")
    row: dict[str, Any] = {
        "session": d.get("session"),
        "survey": sid,
        # --- 被験者背景（混杂因素にもなる: 睡眠/カフェイン/服薬は HRV に影響）---
        "subject_id": subj.get("id"),
        "age_band": subj.get("ageBand"),
        "sex": subj.get("sex"),
        "sleep": subj.get("sleep"),
        "caffeine": subj.get("caffeine"),
        "exercise": subj.get("exercise"),
        "medication": subj.get("medication"),
        # --- ラベル ---
        "total": total,
        "severity": res.get("severityKey"),
        "label_clinically_significant": _label(sid, total),
        # --- QC ---
        "ecg_samples": ecg.get("samples"),
        "has_phases": int(bool(phases)),
        "has_video": int(bool(d.get("video"))),
        "has_camera_meta": int(bool(d.get("camera"))),
        "has_faces": int(_faces_path(d.get("session", "")) is not None),
        "n_question_hrv": len(d.get("per_question_hrv") or []),
    }

    # --- 全体 HRV（後方互換: phases が無くてもここは出る）---
    overall = _hrv_block(ecg)
    for k, v in overall.items():
        row[f"all_{k}"] = v

    # --- 相位別 HRV + 差分（新フォーマットのみ）---
    if phases:
        pre = _hrv_block(phases.get("rest_pre"))
        task = _hrv_block(phases.get("task"))
        post = _hrv_block(phases.get("rest_post"))
        for k, v in pre.items():
            row[f"pre_{k}"] = v
        for k, v in task.items():
            row[f"task_{k}"] = v
        for k, v in post.items():
            row[f"post_{k}"] = v
        # reactivity = task - rest_pre, recovery = rest_post - rest_pre（抑郁では鈍化しやすい）
        for k, v in _delta(task, pre, DELTA_KEYS).items():
            row[f"react_{k}"] = v
        for k, v in _delta(post, pre, DELTA_KEYS).items():
            row[f"recov_{k}"] = v

    # --- 顔特徴（landmark があれば相位別に結合）---
    fp = _faces_path(d.get("session", ""))
    if fp is not None:
        row.update(facial_features(d, fp))

    # --- QC 判定 ---
    rmssd = row.get("all_rmssd_ms")
    hr = row.get("all_mean_hr_bpm")
    usable = row.get("all_usable_intervals")
    plausible = (
        rmssd is not None and RMSSD_PLAUSIBLE[0] <= rmssd <= RMSSD_PLAUSIBLE[1]
        and hr is not None and MEAN_HR_PLAUSIBLE[0] <= hr <= MEAN_HR_PLAUSIBLE[1]
    )
    enough = usable is not None and usable >= MIN_USABLE_BEATS
    row["qc_hrv_plausible"] = int(bool(plausible))
    row["qc_enough_beats"] = int(bool(enough))
    # 解析に使ってよいか（ECG が妥当 & 拍数十分）
    row["usable_for_ecg_ml"] = int(bool(plausible and enough))
    return row


def main() -> int:
    files = sorted(glob.glob(str(DATA_DIR / "*.session.json")))
    if not files:
        print(f"[build_dataset] no *.session.json under {DATA_DIR}")
        return 1

    rows = [build_row(Path(f)) for f in files]

    # 列順: 固定の先頭列 → 残りの特徴列（アルファベット順）
    lead = [
        "session", "survey", "subject_id", "age_band", "sex", "sleep", "caffeine",
        "exercise", "medication", "total", "severity", "label_clinically_significant",
        "ecg_samples", "has_phases", "has_video", "has_camera_meta", "has_faces",
        "n_question_hrv", "qc_hrv_plausible", "qc_enough_beats", "usable_for_ecg_ml",
    ]
    all_keys = set()
    for r in rows:
        all_keys.update(r.keys())
    feature_cols = sorted(k for k in all_keys if k not in lead)
    cols = lead + feature_cols

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)

    # --- サマリ ---
    n = len(rows)
    pos = sum(1 for r in rows if r.get("label_clinically_significant") == 1)
    neg = sum(1 for r in rows if r.get("label_clinically_significant") == 0)
    unlab = n - pos - neg
    usable = sum(1 for r in rows if r.get("usable_for_ecg_ml") == 1)
    faces = sum(1 for r in rows if r.get("has_faces") == 1)
    subjects = len({r.get("subject_id") for r in rows if r.get("subject_id")})

    print(f"[build_dataset] wrote {OUT_CSV}  ({n} sessions, {len(cols)} columns)")
    print(f"  unique subjects : {subjects}")
    print(f"  labels          : positive={pos}  negative={neg}  unlabeled={unlab}")
    print(f"  ECG-usable      : {usable}/{n}   faces-extracted: {faces}/{n}")

    warn_lines: list[str] = []
    if pos == 0 or neg == 0:
        warn_lines.append(f"only one class present (pos={pos}, neg={neg}) — "
                          "二値分類は学習不可。陽性/陰性の両方を集めるまで訓練は保留。")
    if usable < n:
        warn_lines.append(f"{n - usable} sessions have unusable ECG (伪迹/サンプル不足) — 除外推奨。")
    if faces < n:
        warn_lines.append(f"{n - faces} sessions lack facial features — landmark 抽出が未実施（Stage B）。")
    if subjects < n:
        warn_lines.append("同一被験者の複数セッションあり → 評価は必ず被験者単位で分割(LOSO/GroupKFold)。")
    for wl in warn_lines:
        print("  [!] " + wl)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
