# Bundled myBeat SDK runtime (minimal)

Only the files needed to **run** the app are included here — the full vendor SDK
(2+ GB, mostly Visual Studio build artifacts: `.vs/`, `*.ipch`, `*.pch`,
Debug/Release outputs, sample apps) is intentionally excluded and can be
re-obtained from Union Tool.

Source: Union Tool WHS-1 SDK v1.2.0.43 (`UTWS.dll` version 1.2.0.43).

## Contents

| File | Purpose |
|------|---------|
| `UTWS.dll` | x64 runtime DLL the Python app loads via ctypes (primary path `mybeat_app/sdk/UTWS.dll`, searched first by `mybeat/utws.py`) |
| `x64/UTWS.dll`, `x64/UTWS.lib` | x64 DLL + import lib (for C/C++ linking) |
| `x86/UTWS.dll` | 32-bit DLL (only if using 32-bit Python) |
| `include/*.h` | API headers (`utwsapi.h`, `utwsstruct.h`, `utwserrdef.h`) for reference |
| `driver/CDM21218_Setup.exe` | FTDI/CDM driver installer — run once to install the device driver |

## Required driver (not a file in this repo's load path)

`UTWS.dll` depends on **`FTD2XX.dll`**, which is installed by the FTDI/CDM
driver. Run `driver/CDM21218_Setup.exe` once; it places `FTD2XX.dll` in
`C:\Windows\System32`. Without it, `UTWS.dll` fails to load.

## Setup from a fresh clone

1. Run `sdk/driver/CDM21218_Setup.exe` (installs FTDI driver / FTD2XX.dll).
2. Install 64-bit Python 3.11+.
3. Plug in the RRD-1 receiver, double-click `start_dashboard.bat`.

The app finds `UTWS.dll` here automatically; no path config needed.
