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
import sys  # noqa: E402

if len(sys.argv) > 1 and sys.argv[1] == "reset-admin-password":
    # Восстановление доступа: python run.py reset-admin-password [новый_пароль]
    import getpass
    from app.store import Store
    from app.server import reset_admin_password
    base = os.path.dirname(os.path.abspath(__file__))
    db = os.environ.get("WALLETS_DB") or os.path.join(base, "data", "wallets.sqlite3")
    pw = sys.argv[2] if len(sys.argv) > 2 else getpass.getpass("Новый пароль администратора (не короче 8 символов): ")
    st = Store(db)
    with st.tx():
        adm = reset_admin_password(st, pw, "команда reset-admin-password")
    print(f"Готово. Логин: {adm['login']}. Если сервер запущен, перезапустите его.")
    sys.exit(0)

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
