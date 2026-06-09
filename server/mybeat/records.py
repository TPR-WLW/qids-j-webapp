from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


CSV_FIELDS = [
    "host_time_iso",
    "device_time_iso",
    "packet_id",
    "sample_index",
    "data_count",
    "temp_id",
    "mode",
    "ecg_mode",
    "ecg_mode_label",
    "acc_mode",
    "sampling_freq",
    "lowbattery",
    "ecg_raw",
    "hr_bpm_estimate",
    "temp_c",
    "acc_x",
    "acc_y",
    "acc_z",
]


@dataclass(frozen=True)
class EcgRecord:
    host_time: datetime
    device_time: Optional[datetime]
    packet_id: int
    sample_index: int
    data_count: int
    temp_id: int
    mode: int
    ecg_mode: int
    ecg_mode_label: str
    acc_mode: int
    sampling_freq: int
    lowbattery: int
    ecg_raw: int
    temp_c: float
    acc_x: float
    acc_y: float
    acc_z: float

    @property
    def hr_bpm_estimate(self) -> Optional[float]:
        if self.ecg_raw <= 0:
            return None
        if self.ecg_mode in (1, 2):
            return 60000.0 / float(self.ecg_raw)
        return None

    def to_csv_row(self) -> dict[str, object]:
        return {
            "host_time_iso": self.host_time.isoformat(timespec="milliseconds"),
            "device_time_iso": (
                self.device_time.isoformat(timespec="milliseconds")
                if self.device_time
                else ""
            ),
            "packet_id": self.packet_id,
            "sample_index": self.sample_index,
            "data_count": self.data_count,
            "temp_id": self.temp_id,
            "mode": self.mode,
            "ecg_mode": self.ecg_mode,
            "ecg_mode_label": self.ecg_mode_label,
            "acc_mode": self.acc_mode,
            "sampling_freq": self.sampling_freq,
            "lowbattery": self.lowbattery,
            "ecg_raw": self.ecg_raw,
            "hr_bpm_estimate": (
                f"{self.hr_bpm_estimate:.3f}"
                if self.hr_bpm_estimate is not None
                else ""
            ),
            "temp_c": f"{self.temp_c:.6f}",
            "acc_x": f"{self.acc_x:.6f}",
            "acc_y": f"{self.acc_y:.6f}",
            "acc_z": f"{self.acc_z:.6f}",
        }
