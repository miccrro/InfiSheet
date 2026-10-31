#!/usr/bin/env bash
# InfiSheet · Linux / 任何有 bash 的环境启动入口。  chmod +x start.sh 之后 ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "[ERROR] 没找到 python3。装 Python 3.9+ 后重试（apt install python3 / dnf install python3）。" >&2
  exit 1
fi

echo "============================================"
echo "  InfiSheet  -  local infinite canvas"
echo "  ComfyUI expected at http://127.0.0.1:8188"
echo "============================================"
echo

exec "$PY" server.py "$@"
