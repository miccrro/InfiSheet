#!/usr/bin/env bash
# InfiSheet · Linux / 任何有 bash 的环境启动入口。  chmod +x start.sh 之后 ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "[ERROR] 没找到 python3。装 Python 3.9+ 后重试（apt install python3 / dnf install python3）。" >&2
  exit 1
fi

# 版本要够：server.py 用了 3.9+ 的写法。Ubuntu 20.04 自带的是 3.8，一跑就 SyntaxError，
# 那种报错只有一屏 traceback，看不出是版本问题，所以先在这里拦一句。
PROBE="$("$PY" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>&1)" || {
  echo "[ERROR] python3 跑不起来（$PY）：" >&2
  printf '%s\n' "$PROBE" | head -3 >&2
  exit 1
}
if ! "$PY" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  echo "[ERROR] Python 版本太老（当前 $PROBE，需要 3.9+）。" >&2
  echo "        Debian/Ubuntu：sudo apt install python3.11   或参考 https://www.python.org/downloads/" >&2
  exit 1
fi

echo "============================================"
echo "  InfiSheet  -  local infinite canvas"
echo "  ComfyUI expected at http://127.0.0.1:8188"
echo "============================================"
echo

exec "$PY" server.py "$@"
