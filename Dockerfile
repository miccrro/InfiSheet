FROM python:3.12-slim

# 无第三方依赖：只要标准库，所以不装任何 pip 包。
WORKDIR /app
COPY . .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    INFISHEET_DATA=/data

# 画布快照 + 工作流库都落在 /data，必须挂卷，否则重建容器就丢。
VOLUME ["/data"]
EXPOSE 8788

# 容器里没有浏览器，也没有可信来源：令牌交给 compose 的 INFISHEET_TOKEN，
# 没设令牌时靠 --yes-i-know 明确表示「我知道它监听在 0.0.0.0」。
CMD ["python", "-X", "utf8", "server.py", "--host", "0.0.0.0", "--no-browser", "--yes-i-know"]
