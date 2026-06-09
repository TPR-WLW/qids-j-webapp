from __future__ import annotations

import csv
import math
from collections import Counter
from pathlib import Path
from statistics import mean, pstdev
from typing import Iterable


def load_rows(path: str | Path) -> list[dict[str, str]]:
    with Path(path).open("r", newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def _float_values(rows: Iterable[dict[str, str]], field: str) -> list[float]:
    values: list[float] = []
    for row in rows:
        text = row.get(field, "")
        if not text:
            continue
        try:
            value = float(text)
        except ValueError:
            continue
        if math.isfinite(value):
            values.append(value)
    return values


def _stats(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "max": None, "mean": None, "std": None}
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "mean": mean(values),
        "std": pstdev(values) if len(values) > 1 else 0.0,
    }


def _opt_float(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def beat_series(rows: Iterable[dict[str, object]]) -> list[dict[str, object]]:
    """One entry per heartbeat: {t, rri, ax, ay, az}.

    ``t`` is cumulative seconds (beat timing). Handles both transmission rates
    via the device's ``sampling_freq`` flag:
      - sampling_freq == 1 (3 beats per packet): each row is a distinct beat.
      - sampling_freq == 0 (1 beat per packet, low-latency / ±accel variant):
        every row in a packet is the SAME beat (identical RRI, only +/- peak
        acceleration differs), so collapse to one beat per packet_id.
    Keyed on packet_id (consecutive), never on value equality, because two real
    beats can share an RRI in normal mode, and packet_id is a wrapping byte.
    Only physiologically plausible beats (30-200 bpm) are kept.
    """
    out: list[dict[str, object]] = []
    last_pkt: object = object()
    clock = 0.0
    for row in rows:
        if row.get("ecg_mode_label", "") not in ("rri", "heart_rate_or_rri", "heart_rate"):
            continue
        rri = _opt_float(row.get("ecg_raw", ""))
        if rri is None or not (300.0 <= rri <= 2000.0):
            continue
        sf_raw = row.get("sampling_freq", 1)
        try:
            # NB: not `sf_raw or 1` — integer 0 is falsy and would disable dedup.
            sampling_freq = 1 if sf_raw is None or sf_raw == "" else int(sf_raw)
        except (TypeError, ValueError):
            sampling_freq = 1
        pkt = row.get("packet_id")
        if sampling_freq == 0 and pkt == last_pkt:
            continue  # same beat, extra ±accel row
        last_pkt = pkt
        clock += rri / 1000.0
        out.append({
            "t": clock,
            "rri": rri,
            "ax": _opt_float(row.get("acc_x")),
            "ay": _opt_float(row.get("acc_y")),
            "az": _opt_float(row.get("acc_z")),
        })
    return out


def beat_intervals(rows: Iterable[dict[str, object]]) -> list[float]:
    """One RRI (ms) per heartbeat, usable for HRV (see beat_series)."""
    return [float(b["rri"]) for b in beat_series(rows)]


# Backwards-compatible alias
_rri_intervals = beat_intervals


def _pnn_percentages(abs_diffs: list[float]) -> dict[str, float | None]:
    if not abs_diffs:
        return {f"pnn{t}": None for t in (10, 20, 30, 40, 50)}
    n = len(abs_diffs)
    return {f"pnn{t}": 100.0 * sum(1 for d in abs_diffs if d > t) / n for t in (10, 20, 30, 40, 50)}


def hrv_metrics(rows: list[dict[str, object]]) -> dict[str, float | int | None]:
    intervals = beat_intervals(rows)
    count = len(intervals)
    if count < 2:
        return {
            "usable_intervals": count,
            "mean_rri_ms": None,
            "mean_hr_bpm": None,
            "sdnn_ms": None,
            "rmssd_ms": None,
            **{f"pnn{t}": None for t in (10, 20, 30, 40, 50)},
        }
    mean_rri = mean(intervals)
    abs_diffs = [abs(intervals[i + 1] - intervals[i]) for i in range(count - 1)]
    rmssd = math.sqrt(mean(d * d for d in abs_diffs))
    return {
        "usable_intervals": count,
        "mean_rri_ms": mean_rri,
        "mean_hr_bpm": 60000.0 / mean_rri,
        "sdnn_ms": pstdev(intervals),
        "rmssd_ms": rmssd,
        **_pnn_percentages(abs_diffs),
    }


def _lomb_scargle(t: list[float], y: list[float], freqs: list[float]) -> list[float]:
    """Classic Lomb-Scargle periodogram power for unevenly-sampled (t, y)."""
    out: list[float] = []
    for f in freqs:
        w = 2.0 * math.pi * f
        s2 = sum(math.sin(2.0 * w * ti) for ti in t)
        c2 = sum(math.cos(2.0 * w * ti) for ti in t)
        tau = math.atan2(s2, c2) / (2.0 * w) if w else 0.0
        yc = ys = sum_cos2 = sum_sin2 = 0.0
        for ti, yi in zip(t, y):
            arg = w * (ti - tau)
            c = math.cos(arg)
            s = math.sin(arg)
            yc += yi * c
            ys += yi * s
            sum_cos2 += c * c
            sum_sin2 += s * s
        p = 0.0
        if sum_cos2 > 0:
            p += (yc * yc) / sum_cos2
        if sum_sin2 > 0:
            p += (ys * ys) / sum_sin2
        out.append(0.5 * p)
    return out


def frequency_hrv_from_intervals(intervals: list[float]) -> dict[str, object]:
    """Frequency-domain HRV (LF/HF) from RRI intervals (ms).

    Uses Lomb-Scargle so no resampling is needed. Band powers are in relative
    units; LF/HF ratio and normalized units (n.u.) are scale-independent and are
    the robust outputs. Needs a longer clean recording (>=60s) to be reliable.
    """
    intervals = [v for v in intervals if 300.0 <= v <= 2000.0]
    n = len(intervals)
    if n < 20:
        return {"ok": False, "note": "数据不足（需 ≥20 个有效心拍）", "freqs": [], "power": []}

    t: list[float] = []
    acc = 0.0
    for r in intervals:
        acc += r / 1000.0
        t.append(acc)
    duration = t[-1] - t[0] if n > 1 else 0.0
    avg = mean(intervals)
    y = [v - avg for v in intervals]

    freqs: list[float] = []
    f, f_hi, step = 0.0033, 0.40, 0.004
    while f <= f_hi + 1e-9:
        freqs.append(round(f, 5))
        f += step
    power = _lomb_scargle(t, y, freqs)

    def band(lo: float, hi: float) -> float:
        return sum(power[i] for i, fr in enumerate(freqs) if lo <= fr < hi) * step

    vlf = band(0.0033, 0.04)
    lf = band(0.04, 0.15)
    hf = band(0.15, 0.40)
    lf_hf_sum = lf + hf
    return {
        "ok": True,
        "n": n,
        "duration_s": duration,
        "reliable": duration >= 60.0,
        "freqs": freqs,
        "power": power,
        "vlf": vlf,
        "lf": lf,
        "hf": hf,
        "lf_hf": (lf / hf) if hf > 0 else None,
        "lf_nu": (lf / lf_hf_sum * 100.0) if lf_hf_sum > 0 else None,
        "hf_nu": (hf / lf_hf_sum * 100.0) if lf_hf_sum > 0 else None,
    }


def frequency_hrv(rows: list[dict[str, str]]) -> dict[str, object]:
    return frequency_hrv_from_intervals(_rri_intervals(rows))


def _freqgrid(lo: float, hi: float, step: float) -> list[float]:
    grid: list[float] = []
    f = lo
    while f <= hi + 1e-9:
        grid.append(round(f, 5))
        f += step
    return grid


def _argmax(values: list[float]) -> int:
    return max(range(len(values)), key=lambda i: values[i]) if values else -1


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def respiration(rows: list[dict[str, object]]) -> dict[str, object]:
    """Estimate breathing rate two independent ways and cross-check.

    - RSA: peak of the RRI spectrum in the HF band (0.12-0.40 Hz) — breathing
      modulates heart rate (respiratory sinus arrhythmia).
    - Accel: peak of the chest accelerometer spectrum (0.10-0.50 Hz) on the axis
      with the strongest respiratory oscillation.
    Best when the subject is fairly still; motion corrupts the accel estimate.
    """
    bs = beat_series(rows)
    n = len(bs)
    if n < 20:
        return {"ok": False, "note": "数据不足（需 ≥20 个心拍）"}
    t = [float(b["t"]) for b in bs]
    duration = t[-1] - t[0]

    rri = [float(b["rri"]) for b in bs]
    mr = mean(rri)
    hf = _freqgrid(0.12, 0.40, 0.005)
    p_rri = _lomb_scargle(t, [v - mr for v in rri], hf)
    resp_rsa = hf[_argmax(p_rri)] * 60.0 if p_rri else None

    acc_band = _freqgrid(0.10, 0.50, 0.005)
    best_axis = None
    best_f = None
    best_power = -1.0
    wave: list[float] = []
    for axis in ("ax", "ay", "az"):
        raw = [b[axis] for b in bs]
        present = [v for v in raw if v is not None]
        if len(present) < n * 0.5:
            continue
        m = mean(present)
        y = [(float(v) if v is not None else m) - m for v in raw]
        p = _lomb_scargle(t, y, acc_band)
        j = _argmax(p)
        if j >= 0 and p[j] > best_power:
            best_power, best_axis, best_f, wave = p[j], axis, acc_band[j], y
    resp_accel = best_f * 60.0 if best_f else None

    cands = [c for c in (resp_rsa, resp_accel) if c]
    resp = mean(cands) if cands else None
    agree = bool(resp_rsa and resp_accel and abs(resp_rsa - resp_accel) <= 3.0)

    # downsample waveform for plotting
    step = max(1, n // 600)
    return {
        "ok": True,
        "n": n,
        "duration_s": duration,
        "reliable": duration >= 30.0,
        "resp_bpm": resp,
        "resp_rsa_bpm": resp_rsa,
        "resp_accel_bpm": resp_accel,
        "accel_axis": best_axis,
        "agree": agree,
        "wave_t": t[::step],
        "wave_v": wave[::step] if wave else [],
    }


def _stress_index(rri: list[float]) -> float | None:
    """Baevsky stress index (SI) from RRI histogram (50 ms bins).

    SI = AMo / (2 * Mo * MxDMn). Higher SI => more sympathetic / stress.
    Typical rest ~50-150; >150-200 suggests stress.
    """
    if len(rri) < 5:
        return None
    bins: dict[int, int] = {}
    for v in rri:
        b = int(round(v / 50.0)) * 50
        bins[b] = bins.get(b, 0) + 1
    mo_bin = max(bins, key=lambda k: bins[k])
    amo = 100.0 * bins[mo_bin] / len(rri)
    mo = mo_bin / 1000.0
    mxdmn = (max(rri) - min(rri)) / 1000.0
    if mo <= 0 or mxdmn <= 0:
        return None
    return amo / (2.0 * mo * mxdmn)


def autonomic_state(rows: list[dict[str, object]]) -> dict[str, object]:
    """Stress<->relaxation autonomic state from HRV.

    Reflects autonomic balance (sympathetic arousal vs parasympathetic
    relaxation). NOT a validated emotion/valence detector; for reference only,
    not clinical use.
    """
    rri = beat_intervals(rows)
    n = len(rri)
    if n < 10:
        return {"ok": False, "note": "数据不足（需 ≥10 个心拍）"}
    hv = hrv_metrics(rows)
    rmssd = hv["rmssd_ms"]
    pnn50 = hv["pnn50"]
    si = _stress_index(rri)
    freq = frequency_hrv(rows)
    lf_hf = freq.get("lf_hf") if freq.get("ok") else None

    # Heuristic 0-100 scores (population-rough, uncalibrated):
    #   relaxation grows with RMSSD (≈80 ms -> 100)
    #   arousal grows with Baevsky SI on a log scale (SI 20 -> 0, 300 -> 100)
    relax = _clamp(100.0 * (rmssd or 0.0) / 80.0)
    if si and si > 0:
        arousal = _clamp(100.0 * (math.log(si) - math.log(20.0)) / (math.log(300.0) - math.log(20.0)))
    else:
        arousal = None

    state_code = "unknown"
    if arousal is not None:
        if relax >= 55 and arousal < 50:
            state_code = "relaxed"
        elif arousal >= 60 and relax < 45:
            state_code = "stressed"
        elif relax >= 55 and arousal >= 60:
            state_code = "active"
        else:
            state_code = "balanced"
    state_cn = {"relaxed": "放松 / 恢复", "stressed": "压力 / 紧张", "active": "活跃 / 高唤醒",
                "balanced": "平衡", "unknown": "未知"}[state_code]

    return {
        "ok": True,
        "n": n,
        "rmssd_ms": rmssd,
        "pnn50": pnn50,
        "lf_hf": lf_hf,
        "stress_index": si,
        "relax_score": relax,
        "arousal_score": arousal,
        "state_code": state_code,
        "state": state_cn,
        "mean_hr_bpm": hv["mean_hr_bpm"],
    }


def summarize(rows: list[dict[str, str]]) -> dict[str, object]:
    ecg_modes = Counter(row.get("ecg_mode_label", "") for row in rows)
    low_battery = sum(1 for row in rows if row.get("lowbattery") not in ("", "0"))

    return {
        "samples": len(rows),
        "first_host_time": rows[0].get("host_time_iso") if rows else None,
        "last_host_time": rows[-1].get("host_time_iso") if rows else None,
        "ecg_modes": dict(ecg_modes),
        "low_battery_samples": low_battery,
        "ecg_raw": _stats(_float_values(rows, "ecg_raw")),
        "hr_bpm_estimate": _stats(_float_values(rows, "hr_bpm_estimate")),
        "temperature_c": _stats(_float_values(rows, "temp_c")),
        "acc_x": _stats(_float_values(rows, "acc_x")),
        "acc_y": _stats(_float_values(rows, "acc_y")),
        "acc_z": _stats(_float_values(rows, "acc_z")),
        "hrv": hrv_metrics(rows),
    }
