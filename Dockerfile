FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000 WALLETS_DB=/app/data/wallets.sqlite3
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY static ./static
COPY run.py .
RUN useradd -r -u 10001 wallets && mkdir -p /app/data && chown wallets /app/data
USER wallets
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1
CMD ["python", "run.py"]
