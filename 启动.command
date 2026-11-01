#!/bin/bash
# InfiSheet · macOS 启动入口。Finder 里双击即可。
#
# 第一次跑可能被系统拦下，两种提示对应两种处理：
#   · 「无法打开，因为无法验证开发者」→ 右键 → 打开（只需一次），或先执行
#       xattr -d com.apple.quarantine 启动.command
#   · 「permission denied」→ 压缩包解压时丢了执行位，执行一次
#       chmod +x 启动.command
cd "$(dirname "$0")" || exit 1

# 出错时把窗口留住。Finder 双击出来的终端窗口会在脚本结束时立刻关掉，
# 只闪一下等于「双击没反应」，所以任何一步失败都要停下来等人看清。
die() {
  echo
  echo "[错误] $1"
  shift
  for line in "$@"; do echo "       $line"; done
  echo
  printf "按任意键关闭这个窗口…"
  read -n 1 -s -r
  echo
  exit 1
}

# 1) 有没有 python3。macOS 12.3 起系统不再自带 Python 3。
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  die "没找到 python3。" \
    "macOS 12.3 之后系统不再自带 Python 3，先装一个：" \
    "  ① 官方安装包：https://www.python.org/downloads/" \
    "  ② 或者只装命令行工具：xcode-select --install"
fi

# 2) 有 python3 不代表能跑。没装命令行工具的机器上 /usr/bin/python3 只是个壳，
#    一执行就报 command line tools are required，而且退出码有时还是 0，
#    所以不看退出码，直接看它到底吐出什么。
PROBE="$("$PY" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>&1)"
case "$PROBE" in
  3.*) : ;;
  *)
    die "python3 跑不起来（$PY）。" "它的输出是：" \
      "$(printf '%s' "$PROBE" | head -3)" \
      "如果提到 command line tools，执行：xcode-select --install"
    ;;
esac

# 3) 版本：server.py 用了 3.9+ 的语法
if ! "$PY" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  die "Python 版本太老（当前 $PROBE，需要 3.9+）。" \
    "装新版：https://www.python.org/downloads/"
fi

echo "============================================"
echo "  InfiSheet  -  local infinite canvas"
echo "  ComfyUI expected at http://127.0.0.1:8188"
echo "============================================"
echo

"$PY" server.py "$@"
code=$?

# 正常退出（Ctrl+C / 设置里关服务）不拦，异常退出才解释原因。
# 130 = 被 SIGINT 打断，也当正常。
if [ "$code" -ne 0 ] && [ "$code" -ne 130 ]; then
  echo
  echo "[错误] 服务退出，退出码 $code。"
  echo "       端口被占用是最常见的原因（8788 上是不是已经有一个在跑？）："
  echo "         bash 启动.command --port 8789"
  echo "       其他原因见上面几行输出。"
  printf "按任意键关闭这个窗口…"
  read -n 1 -s -r
  echo
fi
exit "$code"
