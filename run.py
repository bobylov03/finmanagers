"""Запуск: python run.py  →  http://localhost:8000

Переменные окружения: PORT (8000), HOST (0.0.0.0), WALLETS_DB (data/wallets.sqlite3), COOKIE_SECURE=1 за HTTPS,
SMTP_* для рассылки (см. README). Работает в одном процессе: SQLite и рабочая копия данных в памяти.
"""
import logging
import os


def load_env(path=".env"):
    """Прочитать .env рядом с run.py (KEY=VALUE), не перекрывая уже заданные переменные."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), path)
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if v.strip():
                    os.environ.setdefault(k.strip(), v.strip())


load_env()
from app.server import create_app  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()

if __name__ == "__main__":
    host, port = os.environ.get("HOST", "0.0.0.0"), int(os.environ.get("PORT", "8000"))
    try:
        from waitress import serve
        logging.info("Сервер waitress: http://%s:%s", host, port)
        serve(app, host=host, port=port, threads=8)
    except ImportError:
        logging.warning("waitress не установлен — запускаю встроенный сервер Flask (pip install waitress для боевого режима)")
        app.run(host=host, port=port, threaded=True)
