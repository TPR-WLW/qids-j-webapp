"""
decode.py — QIDS-J webapp で書き出した landmark JSON を読み込む最小サンプル。

Usage:
    python utils/decode.py qids-j_landmarks_20260417_142530.json.gz

出力:
    - 各フレームのタイムスタンプ、問題 index、主要 blendshape の可視化
    - pandas DataFrame（478×3 の flatten 列 + blendshape 列）も簡易生成

依存:
    python >= 3.8
    pandas  (任意)  pip install pandas
    numpy   (任意)  pip install numpy
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path


def load_landmark_json(path: str | Path) -> dict:
    """`.json` または `.json.gz` を自動判別して読み込む"""
    path = Path(path)
    if path.suffix == ".gz" or str(path).endswith(".json.gz"):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def summarize(doc: dict) -> None:
    meta = doc.get("meta", {})
    frames = doc.get("frames", [])
    print(f"--- meta ---")
    for k, v in meta.items():
        print(f"  {k}: {v}")

    detect = [fr for fr in frames if "pts" in fr]
    events = [fr for fr in frames if fr.get("event")]
    print(f"\n--- frames ---")
    print(f"  total entries : {len(frames)}")
    print(f"  detection     : {len(detect)}")
    print(f"  event markers : {len(events)}")
    if detect:
        duration_s = (detect[-1]["t"] - detect[0]["t"]) / 1000.0
        fps = len(detect) / duration_s if duration_s > 0 else float("nan")
        print(f"  duration      : {duration_s:.1f}s")
        print(f"  average fps   : {fps:.1f}")

    if events:
        print(f"\n--- question boundaries ---")
        for ev in events[:20]:
            print(f"  t={ev['t']:>9.1f} ms  q={ev.get('q')}  event={ev['event']}")
        if len(events) > 20:
            print(f"  ... and {len(events) - 20} more")

    ans = doc.get("answers")
    res = doc.get("result")
    if ans and res:
        print(f"\n--- questionnaire ---")
        print(f"  total score  : {res['total']} / 27")
        print(f"  severity     : {res['severity']}")

    segs = doc.get("questionSegments") or []
    if segs:
        print(f"\n--- per-question timing ---")
        for s in segs:
            hesitation = (
                (s["firstAnswerTime"] - s["enterTimes"][0]) / 1000
                if s.get("firstAnswerTime") is not None and s.get("enterTimes")
                else None
            )
            print(
                f"  Q{s['questionNumber']:>2} {s.get('title',''):<10}"
                f"  dur={s['activeDurationMs']/1000:>5.1f}s"
                f"  visits={len(s['enterTimes']):>1}"
                f"  changes={s['answerEventCount']:>1}"
                f"  answer={s.get('finalAnswer')}"
                + (f"  hesitation={hesitation:>4.1f}s" if hesitation is not None else "")
            )


def frames_of_question(doc, q_index):
    """Q(q_index+1) に滞在していた間の検出フレーム（pts を持つ行）を返す。"""
    seg = next((s for s in doc.get("questionSegments", []) if s["q"] == q_index), None)
    if not seg:
        return []
    ranges = seg["activeTimeRanges"]
    return [
        f for f in doc.get("frames", [])
        if "pts" in f and any(a <= f["t"] < b for (a, b) in ranges)
    ]


def baseline_frames(doc):
    """baseline_start から baseline_end までの検出フレームを返す。
    ベースライン未撮影 / スキップされた場合は空リスト。"""
    frames = doc.get("frames", [])
    start = next((f["t"] for f in frames if f.get("event") == "baseline_start"), None)
    end   = next((f["t"] for f in frames if f.get("event") == "baseline_end"), None)
    if start is None or end is None or end <= start:
        return []
    return [f for f in frames if "pts" in f and start <= f["t"] < end]


def to_dataframe(doc: dict):
    """
    detection フレームのみを pandas DataFrame に変換する。
    列構成:
      t, q,
      pt0_x, pt0_y, pt0_z, pt1_x, ..., pt477_z,
      bs_<categoryName> ...,
      mat0 ... mat15
    """
    import numpy as np           # type: ignore
    import pandas as pd          # type: ignore

    frames = [f for f in doc.get("frames", []) if "pts" in f]
    if not frames:
        return pd.DataFrame()

    n_pts = len(frames[0]["pts"])
    pt_cols = [f"pt{i}_{axis}" for i in range(n_pts) for axis in ("x", "y", "z")]
    bs_keys = sorted(frames[0].get("bs", {}).keys())
    bs_cols = [f"bs_{k}" for k in bs_keys]
    mat_cols = [f"mat{i}" for i in range(16)]

    rows = []
    for fr in frames:
        pts = np.asarray(fr["pts"], dtype=np.float32).reshape(-1)
        bs = [fr["bs"].get(k, np.nan) for k in bs_keys] if fr.get("bs") else [np.nan] * len(bs_keys)
        mat = fr.get("mat") or [np.nan] * 16
        rows.append([fr["t"], fr["q"], *pts.tolist(), *bs, *mat])

    cols = ["t", "q", *pt_cols, *bs_cols, *mat_cols]
    return pd.DataFrame(rows, columns=cols)


def main():
    if len(sys.argv) < 2:
        print("Usage: python utils/decode.py <qids-j_landmarks.json[.gz]>")
        sys.exit(1)
    path = sys.argv[1]
    doc = load_landmark_json(path)
    summarize(doc)

    try:
        df = to_dataframe(doc)
        print(f"\n--- DataFrame shape ---")
        print(f"  {df.shape}  (rows × cols)")
        print(f"  columns (head) : {list(df.columns[:8])} ...")
    except ImportError:
        print("\n(pandas/numpy 未インストールのため DataFrame 変換はスキップ)")


if __name__ == "__main__":
    main()
