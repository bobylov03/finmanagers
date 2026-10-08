"""Рассылка уведомлений по e-mail (ТР-18, ТР-24, ТР-42, ТР-56, ТР-57).

Включается переменными окружения: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD,
SMTP_FROM, SMTP_SECURITY (starttls | ssl | none). Без SMTP_HOST рассылка выключена,
а в интерфейсе администратор может скачать письмо (.eml) вручную.
"""
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage

from .logic import notifications
from .util import fmt_d, today_iso

log = logging.getLogger("wallets.mail")


def mail_configured():
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_FROM"))


def _send(msgs):
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    sec = os.environ.get("SMTP_SECURITY", "ssl" if port == 465 else "starttls").lower()
    user, pw = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASSWORD")
    ctx = ssl.create_default_context()
    smtp = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) if sec == "ssl" else smtplib.SMTP(host, port, timeout=30)
    try:
        if sec == "starttls":
            smtp.starttls(context=ctx)
        if user:
            smtp.login(user, pw or "")
        for m in msgs:
            smtp.send_message(m)
    finally:
        smtp.quit()


def send_notifications(store, C, only=None, by=None):
    msgs, names = [], []
    for u in C.S["users"]:
        if not u.get("active") or not u.get("email") or (only and u["id"] != only):
            continue
        nf = notifications(C, u)
        if not nf:
            continue
        m = EmailMessage()
        m["From"] = os.environ["SMTP_FROM"]
        m["To"] = u["email"]
        m["Subject"] = f"Остатки по кошелькам: уведомления на {fmt_d(today_iso())}"
        m.set_content(f"Здравствуйте, {u['name']}!\n\nУведомления системы «Остатки по кошелькам» на {fmt_d(today_iso())}:\n\n"
                      + "\n".join(f"• {n['text']} ({n['tr']})" for n in nf) + "\n")
        msgs.append(m)
        names.append(u["name"])
    if msgs:
        _send(msgs)
    store.audit(by, "Рассылка уведомлений", ", ".join(names) or "—", f"писем: {len(msgs)}", uname=None if by else "Система")
    return len(msgs)
