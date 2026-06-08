@echo off
title Stop QIDS-J + ECG
echo Stopping QIDS-J + ECG...
echo.
powershell -NoProfile -Command ^
  "$ok=$false;" ^
  "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8770/api/shutdown' -Method POST -UseBasicParsing -TimeoutSec 3 | Out-Null; Write-Host 'Stopped gracefully via API.'; $ok=$true } catch {}" ^
  "if (-not $ok) {" ^
  "  $procs = Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*server.py*' };" ^
  "  if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Killed PID ' + $_.ProcessId) } } else { Write-Host 'No running service found.' }" ^
  "}"
echo.
echo Done. Press any key to close.
pause >nul
