#!/usr/bin/env python3
"""
extract_faces.py — Stage B: 録画動画から顔特徴をバッチ抽出する。

各 data/<session>.mp4 を MediaPipe FaceLandmarker に通し、フレームごとに
52 ブレンドシェイプ + 頭部姿勢(yaw/pitch/roll)を取り出して
data/<session>.landmarks.json.gz に保存する。後段 build_dataset.py が相位別に集約。

時間軸: フレーム t = フレーム番号 / 元fps（= 動画 currentTime, ms）。session.json の
sync.recorderStartIso と足せば壁時計になり、ECG の相位窓に対応づけられる。

実行（mediapipe は Python 3.12 venv 内）:
    ml/.venv/Scripts/python.exe ml/extract_faces.py                 # 全セッション
    ml/.venv/Scripts/python.exe ml/extract_faces.py --fps 15 --force
    ml/.venv/Scripts/python.exe ml/extract_faces.py --sessions imai_... --max-seconds 20   # テスト

依存（venv 内）: mediapipe, opencv-python, numpy。
"""
from __future__ import annotations

import argparse
import glob
import gzip
import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODEL = ROOT / "models" / "face_landmarker.task"


def euler_deg(mat) -> list[float]:
    """4x4 facial transformation 行列の回転部から yaw/pitch/roll(度)を取り出す。"""
    R = np.asarray(mat, dtype=float)[:3, :3]
    sy = math.hypot(R[0, 0], R[1, 0])
    if sy > 1e-6:
        roll = math.atan2(R[2, 1], R[2, 2])
        pitch = math.atan2(-R[2, 0], sy)
        yaw = math.atan2(R[1, 0], R[0, 0])
    else:
        roll = math.atan2(-R[1, 2], R[1, 1])
        pitch = math.atan2(-R[2, 0], sy)
        yaw = 0.0
    return [round(math.degrees(yaw), 3), round(math.degrees(pitch), 3), round(math.degrees(roll), 3)]


def make_landmarker():
    opts = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.VIDEO,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        num_faces=1,
    )
    return vision.FaceLandmarker.create_from_options(opts)


def video_for(session: str) -> Path | None:
    for ext in (".mp4", ".webm"):
        p = DATA / (session + ext)
        if p.exists():
            return p
    return None


def extract_one(session: str, target_fps: float, max_seconds: float | None,
                store_landmarks: bool = False) -> dict | None:
    vid = video_for(session)
    if vid is None:
        print(f"  [skip] no video for {session}")
        return None
    cap = cv2.VideoCapture(str(vid))
    if not cap.isOpened():
        print(f"  [skip] cannot open {vid.name} (codec?)")
        return None
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # target_fps <= 0 → ネイティブ（全フレーム）。微表情/瞬目を保つ満血モード。
    step = 1 if target_fps <= 0 else max(1, round(src_fps / target_fps))
    eff_fps = round(src_fps, 2) if step == 1 else round(src_fps / step, 2)

    landmarker = make_landmarker()
    frames: list[dict] = []
    bs_names: list[str] | None = None
    pts_list: list = []   # 478x3 per face frame（--landmarks 時）
    pts_t: list[int] = []
    idx = 0
    face_frames = 0
    last_ts = -1
    t0 = time.monotonic()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            t_ms = int(idx / src_fps * 1000)
            if t_ms <= last_ts:
                t_ms = last_ts + 1
            last_ts = t_ms
            if max_seconds is not None and t_ms / 1000.0 > max_seconds:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            res = landmarker.detect_for_video(mp_img, t_ms)
            if res.face_blendshapes:
                cats = res.face_blendshapes[0]
                if bs_names is None:
                    bs_names = [c.category_name for c in cats]
                bs = [round(float(c.score), 5) for c in cats]
                pose = euler_deg(res.facial_transformation_matrixes[0]) if res.facial_transformation_matrixes else None
                frames.append({"t": t_ms, "face": 1, "bs": bs, "pose": pose})
                face_frames += 1
                if store_landmarks and res.face_landmarks:
                    lm = res.face_landmarks[0]
                    pts_list.append(np.fromiter((c for p in lm for c in (p.x, p.y, p.z)),
                                                dtype=np.float32, count=len(lm) * 3).reshape(len(lm), 3))
                    pts_t.append(t_ms)
            else:
                frames.append({"t": t_ms, "face": 0})
        idx += 1
    cap.release()
    landmarker.close()

    dur = idx / src_fps if src_fps else 0
    track_rate = round(face_frames / len(frames), 4) if frames else 0.0
    elapsed = time.monotonic() - t0

    npz_kb = None
    if store_landmarks and pts_list:
        npz = DATA / (session + ".points.npz")
        # 正規化座標は float16 で十分（誤差 ~1e-3）。体積を半減。
        np.savez_compressed(npz, t=np.asarray(pts_t, dtype=np.int32),
                            points=np.stack(pts_list).astype(np.float16))
        npz_kb = npz.stat().st_size // 1024

    print(f"  {session}: {len(frames)} frames @~{eff_fps}fps / {total} src | face {face_frames} ({track_rate:.0%}) | {elapsed:.0f}s"
          + (f" | points.npz {npz_kb} KB" if npz_kb is not None else ""))
    return {
        "meta": {
            "session": session,
            "video": vid.name,
            "src_fps": round(src_fps, 2),
            "target_fps": "native" if target_fps <= 0 else target_fps,
            "effective_fps": eff_fps,
            "step": step,
            "duration_s": round(dur, 2),
            "frames": len(frames),
            "face_frames": face_frames,
            "track_rate": track_rate,
            "landmarks_npz": (session + ".points.npz") if npz_kb is not None else None,
            "blendshape_names": bs_names,
            "model": MODEL.name,
            "time_base": "frame_index / src_fps (ms); add session sync.recorderStartIso for wall-clock",
        },
        "frames": frames,
    }


def extract_and_write(args_tuple) -> tuple[str, bool]:
    """1 セッションを抽出して保存（並列ワーカー兼用なのでモジュール関数）。"""
    session, target_fps, max_seconds, store_landmarks = args_tuple
    doc = extract_one(session, target_fps, max_seconds, store_landmarks)
    if doc is None:
        return (session, False)
    out = DATA / (session + ".landmarks.json.gz")
    with gzip.open(out, "wt", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    print(f"  -> wrote {out.name} ({out.stat().st_size // 1024} KB)")
    return (session, True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Batch face-landmark extraction (Stage B).")
    ap.add_argument("--fps", type=float, default=15.0, help="sampling fps; 0 = native/all frames (満血)")
    ap.add_argument("--sessions", nargs="*", help="specific session names (default: all with video)")
    ap.add_argument("--max-seconds", type=float, default=None, help="cap per video (testing)")
    ap.add_argument("--landmarks", action="store_true", help="also save raw 478x3 landmarks to <session>.points.npz")
    ap.add_argument("--workers", type=int, default=1, help="parallel processes over sessions (8コアなら4推奨)")
    ap.add_argument("--force", action="store_true", help="re-extract even if output exists")
    args = ap.parse_args()

    if not MODEL.exists():
        print(f"[error] model not found: {MODEL}")
        return 1

    if args.sessions:
        sessions = args.sessions
    else:
        sessions = [Path(f).name[:-len(".session.json")] for f in sorted(glob.glob(str(DATA / "*.session.json")))]

    todo = []
    for s in sessions:
        out = DATA / (s + ".landmarks.json.gz")
        if out.exists() and not args.force:
            print(f"  [have] {s} (use --force to redo)")
            continue
        if video_for(s) is None:
            continue
        todo.append(s)

    workers = max(1, args.workers)
    print(f"[extract_faces] {len(todo)} session(s), fps={'native' if args.fps <= 0 else args.fps}"
          + (", +landmarks(npz)" if args.landmarks else "")
          + (f", max {args.max_seconds}s" if args.max_seconds else "")
          + (f", workers={workers}" if workers > 1 else ""))
    jobs = [(s, args.fps, args.max_seconds, args.landmarks) for s in todo]
    done = 0
    if workers > 1 and len(jobs) > 1:
        from concurrent.futures import ProcessPoolExecutor, as_completed
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for fut in as_completed([ex.submit(extract_and_write, j) for j in jobs]):
                if fut.result()[1]:
                    done += 1
    else:
        for j in jobs:
            if extract_and_write(j)[1]:
                done += 1
    print(f"[extract_faces] done: {done}/{len(todo)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
