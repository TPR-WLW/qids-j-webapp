#!/usr/bin/env bash
# =====================================================================
#  QIDS-J / PHQ-9 セルフチェック — ローカルサーバ起動（Linux / macOS）
#  静的配信（問卷 + PPG/Web Bluetooth）。myBeat/ECG は Windows の start.bat を使用。
#  使い方: ターミナルで  ./start.sh   （またはファイルマネージャでダブルクリック）
#  停止:  ./stop.sh
# =====================================================================
set -u

PORT=8765
DIR="$(cd "$(dirname "$0")" && pwd)"          # このスクリプトのあるディレクトリ = 配信ルート
PIDFILE="/tmp/qids-j-server-${PORT}.pid"
LOGFILE="/tmp/qids-j-server-${PORT}.log"
URL="http://localhost:${PORT}/"

# --- Python を探す ---
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "[ERROR] python3 が見つかりません。'sudo apt install python3' 等でインストールしてください。"
  read -rp "Enter キーで閉じる..." _ 2>/dev/null || true
  exit 1
fi

is_up() { curl -fs -o /dev/null "$URL" 2>/dev/null; }

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v open   >/dev/null 2>&1; then open   "$URL" >/dev/null 2>&1 &
  else echo "ブラウザで開いてください → $URL"; fi
}

# --- 既に起動中なら、ブラウザを開くだけ ---
if { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; } || is_up; then
  echo "[INFO] 既にサーバが起動しています（$URL）。ブラウザを開きます。"
  open_browser
  exit 0
fi

# --- 起動 ---
echo "[INFO] サーバ起動中… 配信ルート: $DIR"
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" >"$LOGFILE" 2>&1 &
SRV_PID=$!
echo "$SRV_PID" > "$PIDFILE"

# --- 起動待ち（最大 ~4 秒）---
for _ in $(seq 1 20); do is_up && break; sleep 0.2; done

if is_up; then
  echo "[OK] 起動しました（PID $SRV_PID）→ $URL"
  echo "     停止するには ./stop.sh を実行してください。"
  open_browser
else
  echo "[ERROR] 起動に失敗しました。ログ（末尾）:"
  tail -n 5 "$LOGFILE" 2>/dev/null
  rm -f "$PIDFILE"
  exit 1
fi
