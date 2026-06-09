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


def extract_one(session: str, target_fps: float, max_seconds: float | None) -> dict | None:
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
    step = max(1, round(src_fps / target_fps))

    landmarker = make_landmarker()
    frames: list[dict] = []
    bs_names: list[str] | None = None
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
            else:
                frames.append({"t": t_ms, "face": 0})
        idx += 1
    cap.release()
    landmarker.close()

    dur = idx / src_fps if src_fps else 0
    track_rate = round(face_frames / len(frames), 4) if frames else 0.0
    elapsed = time.monotonic() - t0
    print(f"  {session}: {len(frames)} sampled / {total} src frames | face {face_frames} ({track_rate:.0%}) | {elapsed:.0f}s")
    return {
        "meta": {
            "session": session,
            "video": vid.name,
            "src_fps": round(src_fps, 2),
            "target_fps": target_fps,
            "step": step,
            "duration_s": round(dur, 2),
            "frames": len(frames),
            "face_frames": face_frames,
            "track_rate": track_rate,
            "blendshape_names": bs_names,
            "model": MODEL.name,
            "time_base": "frame_index / src_fps (ms); add session sync.recorderStartIso for wall-clock",
        },
        "frames": frames,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Batch face-landmark extraction (Stage B).")
    ap.add_argument("--fps", type=float, default=15.0, help="sampling fps (default 15)")
    ap.add_argument("--sessions", nargs="*", help="specific session names (default: all with video)")
    ap.add_argument("--max-seconds", type=float, default=None, help="cap per video (testing)")
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

    print(f"[extract_faces] {len(todo)} session(s) to process, fps={args.fps}"
          + (f", max {args.max_seconds}s" if args.max_seconds else ""))
    done = 0
    for s in todo:
        doc = extract_one(s, args.fps, args.max_seconds)
        if doc is None:
            continue
        out = DATA / (s + ".landmarks.json.gz")
        with gzip.open(out, "wt", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        done += 1
        print(f"  -> wrote {out.name} ({out.stat().st_size//1024} KB)")
    print(f"[extract_faces] done: {done}/{len(todo)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
