from __future__ import annotations

import ctypes
import os
import platform
import time
from ctypes import wintypes
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

from .records import EcgRecord


UTWS_RRD_1 = 0x00000001
UTWS_WHS_1 = 0x00000002

ECG_MODE_LABELS = {
    0: "waveform",
    1: "rri",
    2: "heart_rate_or_rri",
}

WHS_ECG_MODES = {
    "waveform": 0x01,
    "rri": 0x02,
    "rri_acc_1s": 0x03,
    "heart_rate": 0x04,
}

ACC_MODES = {
    "moving_average": 0,
    "peak_hold": 1,
}


class UTWSError(RuntimeError):
    pass


class RRD1EcgData(ctypes.Structure):
    _fields_ = [
        ("ecg", wintypes.WORD),
        ("temp", ctypes.c_double),
        ("acc_x", ctypes.c_double),
        ("acc_y", ctypes.c_double),
        ("acc_z", ctypes.c_double),
    ]


class RRD1DataEx(ctypes.Structure):
    _fields_ = [
        ("year", wintypes.WORD),
        ("month", wintypes.WORD),
        ("day", wintypes.WORD),
        ("hour", wintypes.WORD),
        ("min", wintypes.WORD),
        ("sec", wintypes.WORD),
        ("msec", wintypes.WORD),
        ("mode", ctypes.c_ubyte),
        ("tempID", ctypes.c_ubyte),
        ("sendedID", ctypes.c_ubyte),
        ("ecg_mode", ctypes.c_ubyte),
        ("acc_mode", ctypes.c_ubyte),
        ("lowbattery", ctypes.c_ubyte),
        ("sampling_freq", ctypes.c_ubyte),
        ("data_count", ctypes.c_ubyte),
        ("data", RRD1EcgData * 10),
        ("reserve", ctypes.c_ubyte * 10),
    ]


class WHS1Config(ctypes.Structure):
    _fields_ = [
        ("ecg_mode", ctypes.c_ubyte),
        ("mode", ctypes.c_ubyte),
        ("flush_right_count", ctypes.c_uint),
        ("acc_mode", ctypes.c_ubyte),
        ("tmp_offset", ctypes.c_char),
        ("cpu_id", ctypes.c_uint),
        ("set_serial_id", ctypes.c_uint),
        ("temp_id", ctypes.c_ubyte),
        ("mem_mode", ctypes.c_ubyte),
    ]


class WHS1MemDataHeader(ctypes.Structure):
    _fields_ = [
        ("ecg_mode", ctypes.c_ubyte),
        ("acc_mode", ctypes.c_ubyte),
        ("temp_id", ctypes.c_ubyte),
        ("data_count", ctypes.c_uint),
    ]


class WHS1EcgData(ctypes.Structure):
    _fields_ = [
        ("year", wintypes.WORD),
        ("month", wintypes.WORD),
        ("day", wintypes.WORD),
        ("hour", wintypes.WORD),
        ("mi", wintypes.WORD),
        ("sec", wintypes.WORD),
        ("msec", wintypes.WORD),
        ("ecg", wintypes.WORD),
        ("temp", ctypes.c_double),
        ("acc_x", ctypes.c_double),
        ("acc_y", ctypes.c_double),
        ("acc_z", ctypes.c_double),
    ]


class WHS1EcgDataEx(ctypes.Structure):
    _fields_ = [
        ("year", wintypes.WORD),
        ("month", wintypes.WORD),
        ("day", wintypes.WORD),
        ("hour", wintypes.WORD),
        ("mi", wintypes.WORD),
        ("sec", wintypes.WORD),
        ("msec", wintypes.WORD),
        ("ecg", wintypes.WORD),
        ("temp", ctypes.c_double),
        ("acc_px", ctypes.c_double),
        ("acc_py", ctypes.c_double),
        ("acc_pz", ctypes.c_double),
        ("acc_nx", ctypes.c_double),
        ("acc_ny", ctypes.c_double),
        ("acc_nz", ctypes.c_double),
    ]


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_utws_candidates() -> list[Path]:
    root = workspace_root()
    candidates: list[Path] = []

    env_dll = os.environ.get("MYBEAT_UTWS_DLL")
    if env_dll:
        candidates.append(Path(env_dll))

    env_dir = os.environ.get("MYBEAT_SDK_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / "UTWS.dll")

    candidates.extend(
        [
            root / "mybeat_app" / "sdk" / "UTWS.dll",
            root / "mybeatSDK" / "mybeatSDK" / "x64" / "UTWS.dll",
            root
            / "mybeatSDKpython"
            / "mybeatSDKpython"
            / "Projectgame6.5"
            / "sdk"
            / "UTWS.dll",
        ]
    )
    return candidates


def find_utws_dll(explicit: str | Path | None = None) -> Path:
    if explicit:
        path = Path(explicit)
        if path.is_dir():
            path = path / "UTWS.dll"
        if path.exists():
            return path
        raise FileNotFoundError(f"UTWS.dll not found: {path}")

    for path in default_utws_candidates():
        if path.exists():
            return path

    searched = "\n".join(str(path) for path in default_utws_candidates())
    raise FileNotFoundError(f"UTWS.dll not found. Searched:\n{searched}")


def pe_machine(path: str | Path) -> str:
    data = Path(path).read_bytes()
    pe_offset = int.from_bytes(data[0x3C : 0x40], "little")
    machine = int.from_bytes(data[pe_offset + 4 : pe_offset + 6], "little")
    if machine == 0x014C:
        return "x86"
    if machine == 0x8664:
        return "x64"
    return f"unknown-0x{machine:04X}"


def python_machine() -> str:
    return platform.architecture()[0]


def _decode_ansi(buffer: ctypes.Array[ctypes.c_char]) -> str:
    return buffer.value.decode("mbcs", errors="replace")


def _device_time(data: RRD1DataEx, sample_index: int) -> Optional[datetime]:
    if data.year == 0:
        return None
    _ = sample_index
    try:
        return datetime(
            int(data.year),
            int(data.month),
            int(data.day),
            int(data.hour),
            int(data.min),
            int(data.sec),
            int(data.msec) * 1000,
        )
    except ValueError:
        return None


class UTWSLibrary:
    def __init__(self, dll_path: str | Path | None = None):
        self.dll_path = find_utws_dll(dll_path)
        self.sdk_dir = self.dll_path.parent
        self._dll_dir_handle = None
        if hasattr(os, "add_dll_directory"):
            self._dll_dir_handle = os.add_dll_directory(str(self.sdk_dir))
        self.dll = ctypes.WinDLL(str(self.dll_path))
        self._bind()

    def _bind(self) -> None:
        self.dll.UTWSGetErrorMessage.argtypes = [ctypes.c_char_p, ctypes.c_uint]
        self.dll.UTWSGetErrorMessage.restype = ctypes.c_uint

        self.dll.UTWSOpenDevice.argtypes = [ctypes.c_uint, ctypes.c_uint]
        self.dll.UTWSOpenDevice.restype = wintypes.HANDLE

        self.dll.UTWSCloseDevice.argtypes = [wintypes.HANDLE]
        self.dll.UTWSCloseDevice.restype = wintypes.BOOL

        self.dll.UTWSCloseAll.argtypes = []
        self.dll.UTWSCloseAll.restype = None

        self.dll.UTWSRRD1StartReceiving.argtypes = [
            wintypes.HANDLE,
            wintypes.HANDLE,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        self.dll.UTWSRRD1StartReceiving.restype = wintypes.BOOL

        self.dll.UTWSRRD1StopReceiving.argtypes = [wintypes.HANDLE]
        self.dll.UTWSRRD1StopReceiving.restype = wintypes.BOOL

        self.dll.UTWSRRD1DataCount.argtypes = [wintypes.HANDLE]
        self.dll.UTWSRRD1DataCount.restype = ctypes.c_int

        self.dll.UTWSRRD1GetDataEx.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(RRD1DataEx),
        ]
        self.dll.UTWSRRD1GetDataEx.restype = wintypes.BOOL

        self.dll.UTWSRRD1IsOpen.argtypes = [wintypes.HANDLE]
        self.dll.UTWSRRD1IsOpen.restype = wintypes.BOOL

        self.dll.UTWSRRD1GetLocalAddress.argtypes = [
            wintypes.HANDLE,
            ctypes.c_char_p,
        ]
        self.dll.UTWSRRD1GetLocalAddress.restype = wintypes.BOOL

        self.dll.UTWSRRD1SetLocalAddress.argtypes = [
            wintypes.HANDLE,
            ctypes.c_char_p,
        ]
        self.dll.UTWSRRD1SetLocalAddress.restype = wintypes.BOOL

        self.dll.UTWSWHS1CountConnected.argtypes = [ctypes.c_uint, ctypes.c_uint]
        self.dll.UTWSWHS1CountConnected.restype = ctypes.c_int

        self.dll.UTWSWHS1ReadConfig.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(WHS1Config),
        ]
        self.dll.UTWSWHS1ReadConfig.restype = wintypes.BOOL

        self.dll.UTWSWHS1WriteConfig.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(WHS1Config),
            ctypes.c_ubyte,
            wintypes.WORD,
            wintypes.WORD,
            wintypes.WORD,
            wintypes.WORD,
            wintypes.WORD,
            wintypes.WORD,
        ]
        self.dll.UTWSWHS1WriteConfig.restype = wintypes.BOOL

        self.dll.UTWSWHS1GetDestinationAddress.argtypes = [
            wintypes.HANDLE,
            ctypes.c_char_p,
        ]
        self.dll.UTWSWHS1GetDestinationAddress.restype = wintypes.BOOL

        self.dll.UTWSWHS1SetDestinationAddress.argtypes = [
            wintypes.HANDLE,
            ctypes.c_char_p,
        ]
        self.dll.UTWSWHS1SetDestinationAddress.restype = wintypes.BOOL

        self.dll.UTWSWHS1Version.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ctypes.c_uint),
        ]
        self.dll.UTWSWHS1Version.restype = wintypes.BOOL

    def get_error(self) -> tuple[int, str]:
        buffer = ctypes.create_string_buffer(512)
        err_id = self.dll.UTWSGetErrorMessage(buffer, len(buffer))
        return int(err_id), _decode_ansi(buffer)

    def raise_last_error(self, prefix: str) -> None:
        err_id, message = self.get_error()
        raise UTWSError(f"{prefix}: [{err_id}] {message}")

    def open_device(self, device_id: int, device_no: int = 0) -> wintypes.HANDLE:
        handle = self.dll.UTWSOpenDevice(device_id, device_no)
        if not handle:
            self.raise_last_error("UTWSOpenDevice failed")
        return handle

    def close_device(self, handle: wintypes.HANDLE) -> None:
        if handle and not self.dll.UTWSCloseDevice(handle):
            self.raise_last_error("UTWSCloseDevice failed")

    def close_all(self) -> None:
        self.dll.UTWSCloseAll()

    def close(self) -> None:
        self.close_all()
        if self._dll_dir_handle:
            self._dll_dir_handle.close()
            self._dll_dir_handle = None


class RRD1Receiver:
    def __init__(self, lib: UTWSLibrary, device_no: int = 0):
        self.lib = lib
        self.device_no = device_no
        self.handle: wintypes.HANDLE | None = None
        self.receiving = False

    def __enter__(self) -> "RRD1Receiver":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def open(self) -> None:
        if self.handle:
            return
        self.handle = self.lib.open_device(UTWS_RRD_1, self.device_no)
        if not self.lib.dll.UTWSRRD1IsOpen(self.handle):
            self.lib.raise_last_error("RRD-1 did not report open")

    def close(self) -> None:
        if self.receiving:
            self.stop()
        if self.handle:
            self.lib.close_device(self.handle)
            self.handle = None

    def local_address(self) -> str:
        if not self.handle:
            raise RuntimeError("RRD-1 is not open")
        buffer = ctypes.create_string_buffer(32)
        if not self.lib.dll.UTWSRRD1GetLocalAddress(self.handle, buffer):
            self.lib.raise_last_error("UTWSRRD1GetLocalAddress failed")
        return _decode_ansi(buffer)

    def start(self) -> None:
        if not self.handle:
            raise RuntimeError("RRD-1 is not open")
        if self.receiving:
            return
        if not self.lib.dll.UTWSRRD1StartReceiving(self.handle, None, None, None):
            self.lib.raise_last_error("UTWSRRD1StartReceiving failed")
        self.receiving = True

    def stop(self) -> None:
        if self.handle and self.receiving:
            if not self.lib.dll.UTWSRRD1StopReceiving(self.handle):
                self.lib.raise_last_error("UTWSRRD1StopReceiving failed")
        self.receiving = False

    def data_count(self) -> int:
        if not self.handle:
            raise RuntimeError("RRD-1 is not open")
        count = int(self.lib.dll.UTWSRRD1DataCount(self.handle))
        if count < 0:
            self.lib.raise_last_error("UTWSRRD1DataCount failed")
        return count

    def poll(self) -> list[EcgRecord]:
        if not self.handle:
            raise RuntimeError("RRD-1 is not open")
        records: list[EcgRecord] = []
        while self.data_count() > 0:
            data = RRD1DataEx()
            if not self.lib.dll.UTWSRRD1GetDataEx(
                self.handle,
                ctypes.byref(data),
            ):
                err_id, _ = self.lib.get_error()
                if err_id == 0x00000007:
                    break
                self.lib.raise_last_error("UTWSRRD1GetDataEx failed")
            records.extend(rrd_packet_to_records(data))
        return records

    def iter_records(self, poll_interval: float = 0.01) -> Iterable[EcgRecord]:
        self.start()
        while True:
            records = self.poll()
            if records:
                yield from records
            else:
                time.sleep(poll_interval)


class WHS1Device:
    def __init__(self, lib: UTWSLibrary, device_no: int = 0):
        self.lib = lib
        self.device_no = device_no
        self.handle: wintypes.HANDLE | None = None

    def __enter__(self) -> "WHS1Device":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    @staticmethod
    def count_connected(lib: UTWSLibrary, expected: int = 0, timeout_ms: int = 5000) -> int:
        count = int(lib.dll.UTWSWHS1CountConnected(expected, timeout_ms))
        if count < 0:
            lib.raise_last_error("UTWSWHS1CountConnected failed")
        return count

    def open(self) -> None:
        if self.handle:
            return
        self.handle = self.lib.open_device(UTWS_WHS_1, self.device_no)

    def close(self) -> None:
        if self.handle:
            self.lib.close_device(self.handle)
            self.handle = None

    def read_config(self) -> WHS1Config:
        if not self.handle:
            raise RuntimeError("WHS-1 is not open")
        config = WHS1Config()
        if not self.lib.dll.UTWSWHS1ReadConfig(self.handle, ctypes.byref(config)):
            self.lib.raise_last_error("UTWSWHS1ReadConfig failed")
        return config

    def write_config(self, config: WHS1Config, mem_mode: Optional[int] = None) -> None:
        if not self.handle:
            raise RuntimeError("WHS-1 is not open")
        now = datetime.now()
        mem_mode_value = int(config.mem_mode if mem_mode is None else mem_mode)
        if not self.lib.dll.UTWSWHS1WriteConfig(
            self.handle,
            ctypes.byref(config),
            mem_mode_value,
            now.year,
            now.month,
            now.day,
            now.hour,
            now.minute,
            now.second,
        ):
            self.lib.raise_last_error("UTWSWHS1WriteConfig failed")

    def destination_address(self) -> str:
        if not self.handle:
            raise RuntimeError("WHS-1 is not open")
        buffer = ctypes.create_string_buffer(32)
        if not self.lib.dll.UTWSWHS1GetDestinationAddress(self.handle, buffer):
            self.lib.raise_last_error("UTWSWHS1GetDestinationAddress failed")
        return _decode_ansi(buffer)

    def set_destination_address(self, address: str) -> None:
        if not self.handle:
            raise RuntimeError("WHS-1 is not open")
        encoded = address.encode("mbcs")
        if not self.lib.dll.UTWSWHS1SetDestinationAddress(self.handle, encoded):
            self.lib.raise_last_error("UTWSWHS1SetDestinationAddress failed")

    def version(self) -> int:
        if not self.handle:
            raise RuntimeError("WHS-1 is not open")
        version = ctypes.c_uint()
        if not self.lib.dll.UTWSWHS1Version(self.handle, ctypes.byref(version)):
            self.lib.raise_last_error("UTWSWHS1Version failed")
        return int(version.value)

    def configure_wireless(
        self,
        destination_address: str,
        ecg_mode: Optional[str] = None,
        acc_mode: Optional[str] = None,
        temp_id: Optional[int] = None,
    ) -> WHS1Config:
        config = self.read_config()
        config.mode = 0
        if ecg_mode is not None:
            config.ecg_mode = WHS_ECG_MODES[ecg_mode]
        if acc_mode is not None:
            config.acc_mode = ACC_MODES[acc_mode]
        if temp_id is not None:
            if not 0 <= temp_id <= 255:
                raise ValueError("temp_id must be between 0 and 255")
            config.temp_id = temp_id
        self.set_destination_address(destination_address)
        self.write_config(config)
        return self.read_config()


def rrd_packet_to_records(data: RRD1DataEx) -> list[EcgRecord]:
    host_time = datetime.now().astimezone()
    mode_label = ECG_MODE_LABELS.get(int(data.ecg_mode), f"unknown_{data.ecg_mode}")
    count = min(int(data.data_count), 10)
    records: list[EcgRecord] = []
    for index in range(count):
        item = data.data[index]
        records.append(
            EcgRecord(
                host_time=host_time,
                device_time=_device_time(data, index),
                packet_id=int(data.sendedID),
                sample_index=index,
                data_count=count,
                temp_id=int(data.tempID),
                mode=int(data.mode),
                ecg_mode=int(data.ecg_mode),
                ecg_mode_label=mode_label,
                acc_mode=int(data.acc_mode),
                sampling_freq=int(data.sampling_freq),
                lowbattery=int(data.lowbattery),
                ecg_raw=int(item.ecg),
                temp_c=float(item.temp),
                acc_x=float(item.acc_x),
                acc_y=float(item.acc_y),
                acc_z=float(item.acc_z),
            )
        )
    return records
