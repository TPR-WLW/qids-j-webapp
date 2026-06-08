from __future__ import annotations

import argparse
import json
import os
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from mybeat.analysis import (
    autonomic_state,
    beat_intervals,
    frequency_hrv,
    frequency_hrv_from_intervals,
    hrv_metrics,
    load_rows,
    respiration,
    summarize,
)


def _row_epoch_ms(row: dict[str, Any]) -> Optional[float]:
    """Wall-clock epoch ms for an ECG CSV row (host_time_iso has a tz offset)."""
    try:
        return datetime.fromisoformat(row.get("host_time_iso", "")).timestamp() * 1000.0
    except Exception:  # noqa: BLE001
        return None


def per_question_hrv(rows: list[dict[str, Any]], segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Slice ECG rows by each question's wall-clock window and compute HRV.

    segments: [{q, questionNumber, startTs, endTs}] with epoch-ms timestamps
    (same machine clock as the ECG host_time, so no offset needed).
    """
    stamped = [(_row_epoch_ms(r), r) for r in rows]
    stamped = [(t, r) for (t, r) in stamped if t is not None]
    out: list[dict[str, Any]] = []
    for seg in segments:
        a = seg.get("startTs")
        b = seg.get("endTs")
        if a is None:
            continue
        hi = b if b is not None else float("inf")
        sub = [r for (t, r) in stamped if a <= t < hi]
        m = hrv_metrics(sub)
        out.append({
            "q": seg.get("q"),
            "questionNumber": seg.get("questionNumber"),
            "label": seg.get("label"),
            "startTs": a,
            "endTs": b,
            "durationMs": (b - a) if (b is not None) else None,
            "usable_beats": m["usable_intervals"],
            "mean_rri_ms": m["mean_rri_ms"],
            "mean_hr_bpm": m["mean_hr_bpm"],
            "sdnn_ms": m["sdnn_ms"],
            "rmssd_ms": m["rmssd_ms"],
            "pnn50": m["pnn50"],
        })
    return out


def _slice_rows_by_window(rows: list[dict[str, Any]], a: float, b: Optional[float]) -> list[dict[str, Any]]:
    """ECG rows whose wall-clock (host_time) falls in [a, b) epoch-ms."""
    hi = b if b is not None else float("inf")
    return [r for r in rows if (t := _row_epoch_ms(r)) is not None and a <= t < hi]


def phase_metrics(rows: list[dict[str, Any]], a: Optional[float], b: Optional[float], label: str) -> Optional[dict[str, Any]]:
    """Full metric set (time/frequency HRV + respiration + autonomic) for one timeline window.

    The window is a slice of the single continuous ECG stream, bounded by event
    timestamps already on the timeline — no separate per-phase recording.
    """
    if a is None:
        return None
    sub = _slice_rows_by_window(rows, a, b)
    return {
        "label": label,
        "startTs": a,
        "endTs": b,
        "durationMs": (b - a) if (b is not None) else None,
        "samples": len(sub),
        "hrv": hrv_metrics(sub),
        "frequency": frequency_hrv(sub),
        "respiration": respiration(sub),
        "autonomic": autonomic_state(sub),
    }


def build_phases(rows: list[dict[str, Any]], segments: list[dict[str, Any]], rest_segments: list[dict[str, Any]]) -> dict[str, Any]:
    """安静（前）／回答／安静（後）の 3 相を、連続 ECG をタイムラインで切って算出する。"""
    if not rows:
        return {}

    def by_q(segs: list[dict[str, Any]], qval: str) -> Optional[dict[str, Any]]:
        return next((s for s in segs if s.get("q") == qval), None)

    pre = by_q(rest_segments, "pre")
    post = by_q(rest_segments, "post")

    # 回答相: 安静（前）終了 → 安静（後）開始。無ければ設問区間の端で代替。
    task_start = pre.get("endTs") if pre else None
    task_end = post.get("startTs") if post else None
    if task_start is None and segments:
        task_start = segments[0].get("startTs")
    if task_end is None and segments:
        task_end = segments[-1].get("endTs")

    phases: dict[str, Any] = {}
    if pre and pre.get("startTs") is not None:
        phases["rest_pre"] = phase_metrics(rows, pre.get("startTs"), pre.get("endTs"), "安静（前）")
    if task_start is not None:
        phases["task"] = phase_metrics(rows, task_start, task_end, "回答")
    if post and post.get("startTs") is not None:
        phases["rest_post"] = phase_metrics(rows, post.get("startTs"), post.get("endTs"), "安静（後）")
    return phases


from mybeat.records import EcgRecord
from mybeat.storage import CsvSampleWriter
from mybeat.utws import (
    ACC_MODES,
    WHS_ECG_MODES,
    RRD1Receiver,
    UTWSError,
    UTWSLibrary,
    WHS1Device,
    find_utws_dll,
    pe_machine,
    python_machine,
    workspace_root,
)

SERVER_DIR = Path(__file__).resolve().parent          # .../qids-j-webapp/server
QIDS_ROOT = SERVER_DIR.parent                          # .../qids-j-webapp  (the QIDS web app)
ECG_DASH = SERVER_DIR / "ecg_dashboard"               # ECG pairing/monitor dashboard
WEB_DIR = ECG_DASH                                     # back-compat for /static (ecg dashboard assets)

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".csv": "text/csv; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".gz": "application/gzip",
    ".task": "application/octet-stream",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
}


def _safe_under(root: Path, rel: str) -> Optional[Path]:
    """Resolve rel under root, rejecting path traversal. None if outside/missing."""
    try:
        p = (root / rel.lstrip("/")).resolve()
        p.relative_to(root.resolve())
    except (ValueError, OSError):
        return None
    return p


WHS_CONFIG_ECG_LABELS = {1: "waveform", 2: "rri", 3: "rri_acc_1s", 4: "heart_rate"}
WHS_MODE_LABELS = {0: "wireless", 1: "memory"}


def record_to_api(rec: EcgRecord) -> dict[str, Any]:
    return {
        "host_time": rec.host_time.isoformat(timespec="milliseconds"),
        "device_time": rec.device_time.isoformat(timespec="milliseconds") if rec.device_time else None,
        "packet_id": rec.packet_id,
        "sample_index": rec.sample_index,
        "sampling_freq": rec.sampling_freq,
        "ecg_mode": rec.ecg_mode,
        "ecg_mode_label": rec.ecg_mode_label,
        "ecg_raw": rec.ecg_raw,
        "hr_bpm": rec.hr_bpm_estimate,
        "temp_c": rec.temp_c,
        "acc_x": rec.acc_x,
        "acc_y": rec.acc_y,
        "acc_z": rec.acc_z,
        "lowbattery": rec.lowbattery,
    }


def downsample(values: list[Optional[float]], max_points: int) -> list[Optional[float]]:
    if len(values) <= max_points:
        return values
    step = (len(values) + max_points - 1) // max_points
    out: list[Optional[float]] = []
    for i in range(0, len(values), step):
        chunk = [v for v in values[i : i + step] if v is not None]
        out.append(sum(chunk) / len(chunk) if chunk else None)
    return out


def _col(rows: list[dict[str, str]], field: str) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    for row in rows:
        text = row.get(field, "")
        if not text:
            out.append(None)
            continue
        try:
            out.append(float(text))
        except ValueError:
            out.append(None)
    return out


def build_series(rows: list[dict[str, str]], max_points: int) -> dict[str, list]:
    return {
        "ecg": downsample(_col(rows, "ecg_raw"), max_points),
        "hr": downsample(_col(rows, "hr_bpm_estimate"), max_points),
        "temp": downsample(_col(rows, "temp_c"), max_points),
        "accX": downsample(_col(rows, "acc_x"), max_points),
        "accY": downsample(_col(rows, "acc_y"), max_points),
        "accZ": downsample(_col(rows, "acc_z"), max_points),
    }


class AcquisitionManager:
    """Owns the SDK library and a single background acquisition session."""

    LIVE_BUFFER = 8000

    def __init__(self, data_dir: Path, sdk_dll: Optional[str] = None):
        self.data_dir = Path(data_dir)
        self.sdk_dll = sdk_dll
        self._lib: Optional[UTWSLibrary] = None
        self._lib_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._buffer: deque[tuple[int, dict[str, Any]]] = deque()
        self._seq = 0
        self.collecting = False
        self.session_name: Optional[str] = None
        self.session_path: Optional[Path] = None
        self.started_at: Optional[float] = None
        self.total = 0
        self.last_record: Optional[EcgRecord] = None
        self.last_battery = 0
        self.last_address: Optional[str] = None
        self.error: Optional[str] = None
        # monitoring
        self._start_monotonic = time.monotonic()
        self._logs: deque[dict[str, Any]] = deque(maxlen=400)
        self._log_id = 0
        self._log_lock = threading.Lock()

    # -- logging / monitoring -------------------------------------------------
    def log(self, level: str, message: str) -> None:
        with self._log_lock:
            self._log_id += 1
            self._logs.append(
                {
                    "id": self._log_id,
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "level": level,
                    "msg": message,
                }
            )

    def logs_since(self, since: int) -> dict[str, Any]:
        with self._log_lock:
            out = [e for e in self._logs if e["id"] > since]
            return {"next": self._log_id, "logs": out}

    def health(self) -> dict[str, Any]:
        with self._state_lock:
            collecting = self.collecting
            total = self.total
            error = self.error
            last_rec = self.last_record
        thread = self._thread
        last_age = None
        if last_rec is not None:
            last_age = (datetime.now().astimezone() - last_rec.host_time).total_seconds()
        return {
            "server_time": datetime.now().isoformat(timespec="seconds"),
            "uptime_s": time.monotonic() - self._start_monotonic,
            "collecting": collecting,
            "thread_alive": bool(thread and thread.is_alive()),
            "total": total,
            "last_sample_age_s": last_age,
            "last_error": error,
        }

    # -- library / environment ------------------------------------------------
    def _get_lib(self) -> UTWSLibrary:
        if self._lib is None:
            self._lib = UTWSLibrary(self.sdk_dll)
        return self._lib

    def environment(self) -> dict[str, Any]:
        info: dict[str, Any] = {"python_arch": python_machine()}
        try:
            dll = find_utws_dll(self.sdk_dll)
            info["dll_path"] = str(dll)
            info["dll_arch"] = pe_machine(dll)
        except Exception as exc:  # noqa: BLE001
            info["dll_error"] = str(exc)
            return info
        try:
            with self._lib_lock:
                self._get_lib()
            info["dll_loaded"] = True
        except Exception as exc:  # noqa: BLE001
            info["dll_loaded"] = False
            info["dll_load_error"] = str(exc)
        return info

    def probe(self) -> dict[str, Any]:
        with self._state_lock:
            if self.collecting:
                return {"address": self.last_address, "collecting": True}
        with self._lib_lock:
            try:
                lib = self._get_lib()
                rrd = RRD1Receiver(lib)
                rrd.open()
                try:
                    addr = rrd.local_address()
                finally:
                    rrd.close()
                with self._state_lock:
                    self.last_address = addr
                return {"address": addr, "collecting": False}
            except Exception as exc:  # noqa: BLE001
                return {"address": None, "collecting": False, "error": str(exc)}

    # -- pairing --------------------------------------------------------------
    def device_overview(self) -> dict[str, Any]:
        with self._state_lock:
            if self.collecting:
                return {"collecting": True, "rrd_address": self.last_address}
        info: dict[str, Any] = {"collecting": False, "rrd_address": None, "whs_count": 0, "whs": None, "matches": False}
        with self._lib_lock:
            lib = self._get_lib()
            try:
                rrd = RRD1Receiver(lib)
                rrd.open()
                try:
                    info["rrd_address"] = rrd.local_address()
                finally:
                    rrd.close()
                with self._state_lock:
                    self.last_address = info["rrd_address"]
            except Exception as exc:  # noqa: BLE001
                info["rrd_error"] = str(exc)
            try:
                count = WHS1Device.count_connected(lib, 0, 1500)
                info["whs_count"] = count
                if count > 0:
                    with WHS1Device(lib, 0) as whs:
                        cfg = whs.read_config()
                        dest = whs.destination_address()
                        try:
                            ver = whs.version()
                        except Exception:  # noqa: BLE001
                            ver = None
                        info["whs"] = {
                            "ecg_mode": int(cfg.ecg_mode),
                            "ecg_mode_label": WHS_CONFIG_ECG_LABELS.get(int(cfg.ecg_mode), f"unknown_{cfg.ecg_mode}"),
                            "mode": int(cfg.mode),
                            "mode_label": WHS_MODE_LABELS.get(int(cfg.mode), f"unknown_{cfg.mode}"),
                            "destination": dest,
                            "version": ver,
                            "serial_id": int(cfg.set_serial_id),
                            "cpu_id": int(cfg.cpu_id),
                            "temp_id": int(cfg.temp_id),
                        }
                        info["matches"] = bool(info["rrd_address"] and dest == info["rrd_address"])
            except Exception as exc:  # noqa: BLE001
                info["whs_error"] = str(exc)
        return info

    def pair(self, opts: dict[str, Any]) -> dict[str, Any]:
        with self._state_lock:
            if self.collecting:
                raise RuntimeError("采集进行中，无法配对")
        ecg_mode = opts.get("ecg_mode") or None
        if ecg_mode and ecg_mode not in WHS_ECG_MODES:
            raise UTWSError(f"unknown ecg_mode: {ecg_mode}")
        with self._lib_lock:
            lib = self._get_lib()
            rrd = RRD1Receiver(lib)
            rrd.open()
            try:
                addr = rrd.local_address()
            finally:
                rrd.close()
            count = WHS1Device.count_connected(lib, 1, int(opts.get("whs_timeout_ms", 8000)))
            if count <= 0:
                raise UTWSError("未检测到 USB 连接的 WHS-1，请用 USB 线连接传感器")
            with WHS1Device(lib, 0) as whs:
                before = whs.destination_address()
                cfg = whs.configure_wireless(addr, ecg_mode=ecg_mode)
                after = whs.destination_address()
                try:
                    ver = whs.version()
                except Exception:  # noqa: BLE001
                    ver = None
        matches = after == addr
        with self._state_lock:
            self.last_address = addr
        self.log("info", f"配对：传感器目标 {before} → {after}（接收器 {addr}）")
        return {
            "rrd_address": addr,
            "before": before,
            "destination": after,
            "matches": matches,
            "ecg_mode": int(cfg.ecg_mode),
            "ecg_mode_label": WHS_CONFIG_ECG_LABELS.get(int(cfg.ecg_mode), ""),
            "mode": int(cfg.mode),
            "version": ver,
        }

    # -- status / live data ---------------------------------------------------
    def status(self) -> dict[str, Any]:
        with self._state_lock:
            elapsed = None
            if self.collecting and self.started_at is not None:
                elapsed = time.monotonic() - self.started_at
            return {
                "collecting": self.collecting,
                "session": self.session_name,
                "total": self.total,
                "elapsed": elapsed,
                "address": self.last_address,
                "lowbattery": self.last_battery,
                "error": self.error,
                "last": record_to_api(self.last_record) if self.last_record else None,
            }

    def samples_since(self, since: int, limit: int = 4000) -> dict[str, Any]:
        with self._state_lock:
            out = [row for seq, row in self._buffer if seq > since]
            nxt = self._seq
        if len(out) > limit:
            out = out[-limit:]
        return {"next": nxt, "samples": out}

    # -- control --------------------------------------------------------------
    def start(self, opts: dict[str, Any]) -> dict[str, Any]:
        with self._state_lock:
            if self.collecting:
                raise RuntimeError("already collecting")
            self.collecting = True
            self.error = None
            self.total = 0
            self.last_record = None
            self.started_at = time.monotonic()
            self._buffer.clear()
            name = (opts.get("output") or "").strip()
            if not name:
                name = f"mybeat_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            name = Path(name).name
            if not name.endswith(".csv"):
                name += ".csv"
            self.session_name = name
            self.session_path = self.data_dir / name
            self._stop.clear()
        self._thread = threading.Thread(target=self._run, args=(opts,), daemon=True)
        self._thread.start()
        self._write_meta(opts)
        self.log("info", f"开始采集 → {self.session_name} (duration={opts.get('duration') or 0}s)")
        return {"session": self.session_name}

    def _meta_path_for(self, csv_name: str) -> Path:
        return self.data_dir / (Path(csv_name).stem + ".meta.json")

    def _write_meta(self, opts: dict[str, Any]) -> None:
        meta = {
            "session": self.session_name,
            "subject": str(opts.get("subject") or "").strip(),
            "note": str(opts.get("note") or "").strip(),
            "ecg_mode": opts.get("ecg_mode") or "",
            "duration": opts.get("duration") or 0,
            "started": datetime.now().isoformat(timespec="seconds"),
        }
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self._meta_path_for(self.session_name).write_text(
                json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as exc:  # noqa: BLE001
            self.log("error", f"写入元数据失败：{exc}")

    def open_data_dir(self) -> dict[str, Any]:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        os.startfile(str(self.data_dir))  # type: ignore[attr-defined]  # Windows only
        return {"ok": True, "path": str(self.data_dir)}

    def resolve_data_file(self, name: str) -> Path:
        path = self.data_dir / Path(name).name
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(name)
        return path

    def save_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Auto-save the whole measurement: combined session.json (+answers.csv).

        Reads the just-recorded ECG CSV (data/<session>.csv), computes overall and
        per-question HRV, and writes data/<session>.session.json with everything:
        subject info, answers, score, event timeline, segments, per-question HRV,
        camera meta, and the video filename. No visualization — data only.
        """
        session = Path(str(payload.get("session") or "")).name
        if not session:
            raise RuntimeError("missing session name")
        self.data_dir.mkdir(parents=True, exist_ok=True)

        csv_path = self.data_dir / (session + ".csv")
        rows = load_rows(csv_path) if csv_path.exists() else []
        segments = payload.get("segments") or []
        rest_segments = payload.get("rest_segments") or []

        ecg: dict[str, Any] = {"csv": (session + ".csv") if rows else None, "samples": len(rows)}
        if rows:
            ecg["hrv"] = hrv_metrics(rows)
            ecg["frequency"] = frequency_hrv(rows)
            ecg["respiration"] = respiration(rows)
            ecg["autonomic"] = autonomic_state(rows)

        out = {
            "session": session,
            "saved": datetime.now().isoformat(timespec="seconds"),
            "survey": payload.get("survey"),
            "subject": payload.get("subject") or {},
            "answers": payload.get("answers"),
            "result": payload.get("result"),
            "qids_events": payload.get("events") or [],
            "segments": segments,
            "rest_segments": rest_segments,
            "phases": build_phases(rows, segments, rest_segments),
            "per_question_hrv": per_question_hrv(rows, segments) if rows else [],
            "rest_hrv": per_question_hrv(rows, rest_segments) if rows else [],
            "ecg": ecg,
            "video": payload.get("video"),
            "camera": payload.get("camera"),
            "sync": payload.get("sync"),
        }
        (self.data_dir / (session + ".session.json")).write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # answers.csv (Excel-friendly, BOM)
        answers = payload.get("answers") or []
        try:
            lines = ["No,score"]
            for a in answers:
                lines.append(f"{a.get('q', '')},{a.get('score', '')}")
            (self.data_dir / (session + ".answers.csv")).write_text(
                "﻿" + "\r\n".join(lines), encoding="utf-8"
            )
        except Exception:  # noqa: BLE001
            pass

        files = [p.name for p in self.data_dir.glob(session + ".*")]
        self.log("info", f"会话已自动保存：{session}（{len(files)} 个文件，{len(rows)} 条ECG）")
        return {
            "saved": True,
            "session": session,
            "dir": str(self.data_dir),
            "files": files,
            "ecg_samples": len(rows),
            "per_question": len(out["per_question_hrv"]),
        }

    def stop(self) -> dict[str, Any]:
        was = self.collecting
        self._stop.set()
        thread = self._thread
        if thread:
            thread.join(timeout=8)
        if was:
            self.log("info", "手动停止采集")
        return self.status()

    def shutdown(self) -> None:
        self.stop()
        with self._lib_lock:
            if self._lib is not None:
                try:
                    self._lib.close()
                except Exception:  # noqa: BLE001
                    pass
                self._lib = None

    # -- worker ---------------------------------------------------------------
    def _configure_whs(self, lib: UTWSLibrary, rrd_address: str, opts: dict[str, Any]) -> None:
        count = WHS1Device.count_connected(lib, expected=1, timeout_ms=int(opts.get("whs_timeout_ms", 10000)))
        if count <= 0:
            raise UTWSError("No WHS-1 connected over USB for configuration")
        ecg_mode = opts.get("ecg_mode") or None
        acc_mode = opts.get("acc_mode") or None
        if ecg_mode and ecg_mode not in WHS_ECG_MODES:
            raise UTWSError(f"unknown ecg_mode: {ecg_mode}")
        if acc_mode and acc_mode not in ACC_MODES:
            raise UTWSError(f"unknown acc_mode: {acc_mode}")
        with WHS1Device(lib, 0) as whs:
            whs.configure_wireless(rrd_address, ecg_mode=ecg_mode, acc_mode=acc_mode)

    def _ingest(self, records: list[EcgRecord], writer: CsvSampleWriter) -> None:
        with self._state_lock:
            for rec in records:
                writer.write(rec)
                self._seq += 1
                self._buffer.append((self._seq, record_to_api(rec)))
                if len(self._buffer) > self.LIVE_BUFFER:
                    self._buffer.popleft()
                self.total += 1
                self.last_record = rec
                self.last_battery = rec.lowbattery

    def _run(self, opts: dict[str, Any]) -> None:
        duration = float(opts.get("duration") or 0)
        poll_interval = float(opts.get("poll_interval") or 0.01)
        try:
            with self._lib_lock:
                lib = self._get_lib()
                rrd = RRD1Receiver(lib)
                rrd.open()
                addr = rrd.local_address()
                with self._state_lock:
                    self.last_address = addr
                if opts.get("configure_whs"):
                    self._configure_whs(lib, addr, opts)
                    self.log("info", f"已配置 WHS-1 → {addr}")
                deadline = time.monotonic() + duration if duration > 0 else None
                with CsvSampleWriter(self.session_path) as writer:
                    rrd.start()
                    try:
                        while not self._stop.is_set():
                            records = rrd.poll()
                            if records:
                                self._ingest(records, writer)
                            if deadline is not None and time.monotonic() >= deadline:
                                break
                            time.sleep(poll_interval)
                    finally:
                        rrd.stop()
                        rrd.close()
        except Exception as exc:  # noqa: BLE001
            with self._state_lock:
                self.error = str(exc)
            self.log("error", f"采集线程错误：{exc}")
        finally:
            with self._state_lock:
                self.collecting = False
                self.started_at = None
                total = self.total
            self.log("info", f"采集结束，共 {total} 个样本")

    # -- sessions -------------------------------------------------------------
    def list_sessions(self) -> list[dict[str, Any]]:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        items = []
        for path in sorted(self.data_dir.glob("*.csv"), key=lambda p: p.stat().st_mtime, reverse=True):
            st = path.stat()
            subject = ""
            mp = self._meta_path_for(path.name)
            if mp.exists():
                try:
                    subject = str(json.loads(mp.read_text(encoding="utf-8")).get("subject", ""))
                except Exception:  # noqa: BLE001
                    subject = ""
            items.append(
                {
                    "name": path.name,
                    "size": st.st_size,
                    "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                    "subject": subject,
                    "has_video": self._video_for(path).is_file() if self._video_for(path) else False,
                }
            )
        return items

    def _video_for(self, csv_path: Path) -> Optional[Path]:
        for ext in (".webm", ".mp4"):
            vp = self.data_dir / (csv_path.stem + ext)
            if vp.exists():
                return vp
        return self.data_dir / (csv_path.stem + ".webm")

    def session_detail(self, name: str, max_points: int = 2000) -> dict[str, Any]:
        path = self.data_dir / Path(name).name
        if path.suffix != ".csv" or not path.exists():
            raise FileNotFoundError(name)
        rows = load_rows(path)
        meta = {}
        mp = self._meta_path_for(path.name)
        if mp.exists():
            try:
                meta = json.loads(mp.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                meta = {}
        video = None
        for ext in (".webm", ".mp4"):
            vp = self.data_dir / (path.stem + ext)
            if vp.exists():
                video = vp.name
                break
        return {
            "name": path.name,
            "summary": summarize(rows),
            "series": build_series(rows, max_points),
            "freq_hrv": frequency_hrv(rows),
            "respiration": respiration(rows),
            "autonomic": autonomic_state(rows),
            "meta": meta,
            "video": video,
        }

    def _windowed_buffer(self, window_s: int) -> list[dict[str, Any]]:
        with self._state_lock:
            rows = [row for _, row in self._buffer]
        if not rows:
            return []

        def parse(ts: str) -> Optional[datetime]:
            try:
                return datetime.fromisoformat(ts)
            except Exception:  # noqa: BLE001
                return None

        last = parse(rows[-1].get("host_time", ""))
        if last is None:
            return rows
        out = []
        for r in rows:
            ht = parse(r.get("host_time", ""))
            if ht is None or (last - ht).total_seconds() <= window_s:
                out.append(r)
        return out

    def freq_hrv_live(self, window_s: int = 180) -> dict[str, Any]:
        # beat_intervals dedupes the ±accel duplicate rows in 1拍1发 mode
        return frequency_hrv_from_intervals(beat_intervals(self._windowed_buffer(window_s)))

    def analysis_live(self, window_s: int = 180) -> dict[str, Any]:
        rows = self._windowed_buffer(window_s)
        return {
            "freq_hrv": frequency_hrv_from_intervals(beat_intervals(rows)),
            "respiration": respiration(rows),
            "autonomic": autonomic_state(rows),
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def manager(self) -> AcquisitionManager:
        return self.server.manager  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
        return

    # -- response helpers -----------------------------------------------------
    def _send_json(self, obj: Any, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        if not path.is_file():
            self._send_json({"error": "not found"}, 404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_download(self, path: Path) -> None:
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_upload(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        name = Path(query.get("name", [""])[0]).name
        if not name or Path(name).suffix.lower() not in (".webm", ".mp4"):
            self._send_json({"error": "invalid video name"}, 400)
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        dest = self.manager.data_dir / name
        self.manager.data_dir.mkdir(parents=True, exist_ok=True)
        written = 0
        with dest.open("wb") as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                written += len(chunk)
                remaining -= len(chunk)
        self.manager.log("info", f"已保存录像 {name}（{written // 1024} KB）")
        self._send_json({"saved": name, "size": written})

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    # -- routing --------------------------------------------------------------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)
        try:
            if route == "/" or route == "/index.html":
                self._send_file(QIDS_ROOT / "index.html")
            elif route == "/ecg" or route == "/ecg/":
                self._send_file(ECG_DASH / "index.html")
            elif route.startswith("/static/"):
                self._send_file(ECG_DASH / route[len("/static/") :])
            elif route == "/api/status":
                self._send_json(self.manager.status())
            elif route == "/api/environment":
                self._send_json(self.manager.environment())
            elif route == "/api/health":
                self._send_json(self.manager.health())
            elif route == "/api/logs":
                since = int((query.get("since", ["0"])[0]) or 0)
                self._send_json(self.manager.logs_since(since))
            elif route == "/api/probe":
                self._send_json(self.manager.probe())
            elif route == "/api/device-info":
                self._send_json(self.manager.device_overview())
            elif route == "/api/samples":
                since = int((query.get("since", ["0"])[0]) or 0)
                self._send_json(self.manager.samples_since(since))
            elif route == "/api/freq":
                window = int((query.get("window", ["180"])[0]) or 180)
                self._send_json(self.manager.freq_hrv_live(window))
            elif route == "/api/analysis":
                window = int((query.get("window", ["180"])[0]) or 180)
                self._send_json(self.manager.analysis_live(window))
            elif route == "/api/sessions":
                self._send_json({"sessions": self.manager.list_sessions()})
            elif route == "/api/session":
                name = query.get("name", [""])[0]
                self._send_json(self.manager.session_detail(name))
            elif route == "/api/download":
                self._send_download(self.manager.resolve_data_file(query.get("name", [""])[0]))
            elif route == "/api/file":
                self._send_file(self.manager.resolve_data_file(query.get("name", [""])[0]))
            else:
                # static fallback: serve any file from the QIDS web app root
                target = _safe_under(QIDS_ROOT, route)
                if target and target.is_file():
                    self._send_file(target)
                else:
                    self._send_json({"error": "not found"}, 404)
        except FileNotFoundError as exc:
            self._send_json({"error": f"not found: {exc}"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, 500)

    def do_POST(self) -> None:
        route = urlparse(self.path).path
        try:
            if route == "/api/start":
                self._send_json(self.manager.start(self._read_json()))
            elif route == "/api/pair":
                self._send_json(self.manager.pair(self._read_json()))
            elif route == "/api/stop":
                self._send_json(self.manager.stop())
            elif route == "/api/save-session":
                self._send_json(self.manager.save_session(self._read_json()))
            elif route == "/api/open-data-dir":
                self._send_json(self.manager.open_data_dir())
            elif route == "/api/upload-video":
                self._handle_upload()
            elif route == "/api/shutdown":
                self._send_json({"ok": True})
                self.manager.log("info", "收到关闭请求，服务即将停止")
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, 400)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MyBeat ECG local web dashboard.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--sdk-dll", help="Path to UTWS.dll or its sdk directory.")
    parser.add_argument("--data-dir", help="Directory for CSV sessions (default: <workspace>/data).")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser automatically.")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    data_dir = Path(args.data_dir) if args.data_dir else QIDS_ROOT / "data"
    # default to the SDK bundled under server/sdk
    sdk_dll = args.sdk_dll
    if not sdk_dll:
        bundled = SERVER_DIR / "sdk" / "UTWS.dll"
        if bundled.exists():
            sdk_dll = str(bundled)
    manager = AcquisitionManager(data_dir, sdk_dll)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.manager = manager  # type: ignore[attr-defined]

    url = f"http://{args.host}:{args.port}/"
    manager.log("info", f"服务启动 {url}")
    print(f"QIDS-J + ECG: {url}   (ECG dashboard: {url}ecg/)")
    print(f"Sessions directory: {data_dir}")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        manager.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
