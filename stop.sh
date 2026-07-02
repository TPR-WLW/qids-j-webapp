#!/usr/bin/env bash
# =====================================================================
#  QIDS-J / PHQ-9 — ローカルサーバ停止（Linux / macOS）
#  start.sh で起動したサーバを止めます。
# =====================================================================
set -u

PORT=8765
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="/tmp/qids-j-server-${PORT}.pid"

stopped=0

# --- PID ファイルから停止 ---
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && echo "[OK] 停止しました（PID $PID）" && stopped=1
  fi
  rm -f "$PIDFILE"
fi

# --- フォールバック: このディレクトリを配信している http.server を探して停止 ---
if [ "$stopped" -eq 0 ]; then
  PIDS="$(pgrep -f "http.server ${PORT}.*${DIR}" 2>/dev/null || pgrep -f "http.server ${PORT}" 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null && echo "[OK] 停止しました（PID $PIDS）"
  else
    echo "[INFO] 起動中のサーバは見つかりませんでした。"
  fi
fi
