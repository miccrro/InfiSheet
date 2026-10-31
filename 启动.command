#!/bin/bash
# InfiSheet · macOS 启动入口。Finder 里双击即可。
# 首次双击若提示「无法打开，因为无法验证开发者」：右键 → 打开 → 打开。
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] 没找到 python3。装 Python 3.9+ 后重试： https://www.python.org/downloads/"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "============================================"
echo "  InfiSheet  -  local infinite canvas"
echo "  ComfyUI expected at http://127.0.0.1:8188"
echo "============================================"
echo

exec python3 server.py "$@"
