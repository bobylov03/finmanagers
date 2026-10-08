"""HTTP API (Flask) и раздача интерфейса."""
import gzip
import io
import json
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, Response, g, jsonify, request, send_from_directory

from . import actions as A
from . import importer as I
from .logic import (Ctx, ROLES, can_edit_wallet, can_enter, facts, has, hidden_allowed, is_admin, line_visible, notifications,
                    own_wallets, recon, reconciled_days, sees_no_wallet, visible_wallets, auto_close_period)
from .mailer import mail_configured, send_notifications
from .store import Store
from .util import now_iso, today_iso

log = logging.getLogger("wallets")
SESSION_COOKIE = "wsid"
SESSION_IDLE = timedelta(hours=int(os.environ.get("SESSION_IDLE_HOURS", "12")))
MAX_FAILS, FAIL_WINDOW_MIN = 5, 15
CLIENT_AUDIT = {"Просмотр отчёта", "Выгрузка в Excel", "Формирование письма с уведомлениями"}


def create_app(db_path=None, start_scheduler=True):
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    db_path = db_path or os.environ.get("WALLETS_DB") or os.path.join(base, "data", "wallets.sqlite3")
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    store = Store(db_path)
    with store.tx():
        if not store.S["users"]:
            store.add("users", {"id": "U_ADMIN", "name": "Администратор", "login": "admin", "email": "", "roles": ["admin"], "wallets": [],
                                "active": True, "lang": "", "pw": None})
        store.purge_old_audit()
        reset_pw = os.environ.get("ADMIN_RESET_PASSWORD", "")
        if reset_pw:
            reset_admin_password(store, reset_pw, "переменная окружения ADMIN_RESET_PASSWORD")
            log.warning("Пароль администратора сброшен из ADMIN_RESET_PASSWORD. Удалите эту переменную после входа.")

    app = Flask(__name__, static_folder=os.path.join(base, "static"), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_MB", "64")) * 1024 * 1024
    app.config["STORE"] = store
    secure_cookie = os.environ.get("COOKIE_SECURE", "0") == "1"

    def C():
        return Ctx(store)

    # ---------------- общие обработчики ----------------
    @app.errorhandler(A.ApiError)
    def api_error(e):
        return jsonify({"ok": False, "errors": e.errors}), e.status

    @app.errorhandler(413)
    def too_big(_e):
        return jsonify({"ok": False, "errors": ["Файл слишком большой"]}), 413

    @app.errorhandler(Exception)
    def unexpected(e):
        if hasattr(e, "code") and getattr(e, "code", 500) < 500:
            return jsonify({"ok": False, "errors": [str(e)]}), e.code
        log.exception("Ошибка сервера")
        return jsonify({"ok": False, "errors": ["Внутренняя ошибка сервера. Подробности — в журнале сервера."]}), 500

    @app.after_request
    def compress(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "same-origin"
        if (resp.direct_passthrough or resp.status_code < 200 or resp.status_code >= 300 or "gzip" not in request.headers.get("Accept-Encoding", "")
                or resp.headers.get("Content-Encoding") or resp.mimetype not in ("application/json", "text/html", "application/javascript", "text/javascript", "text/css")):
            return resp
        data = resp.get_data()
        if len(data) < 2048:
            return resp
        resp.set_data(gzip.compress(data, compresslevel=5))
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Content-Length"] = len(resp.get_data())
        resp.headers["Vary"] = "Accept-Encoding"
        return resp

    def body():
        return request.get_json(silent=True) or {}

    # ---------------- аутентификация ----------------
    def current_user():
        tok = request.cookies.get(SESSION_COOKIE)
        if not tok:
            return None
        with store.lock:
            r = store.conn.execute("SELECT user_id, last_seen FROM sessions WHERE token=?", (tok,)).fetchone()
            if not r:
                return None
            last = datetime.fromisoformat(r["last_seen"].replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            if now - last > SESSION_IDLE:
                store.conn.execute("DELETE FROM sessions WHERE token=?", (tok,))
                return None
            u = store.get("users", r["user_id"])
            if not u or not u.get("active"):
                return None
            if now - last > timedelta(minutes=1):
                store.conn.execute("UPDATE sessions SET last_seen=? WHERE token=?", (now_iso(), tok))
            return u

    @app.before_request
    def guard():
        g.user = None
        if not request.path.startswith("/api/"):
            return None
        if request.method not in ("GET", "HEAD") and request.headers.get("X-Requested-With") != "wallets":
            return jsonify({"ok": False, "errors": ["Запрос отклонён (нет заголовка X-Requested-With)"]}), 400
        if request.path in ("/api/status", "/api/login", "/api/setup", "/api/health"):
            return None
        g.user = current_user()
        if not g.user:
            return jsonify({"ok": False, "errors": ["Требуется вход"], "auth": False}), 401
        return None

    def first_run():
        return not any(u.get("pw") for u in store.S["users"])

    def start_session(u, how):
        tok = secrets.token_urlsafe(32)
        store.conn.execute("INSERT INTO sessions(token, user_id, created, last_seen) VALUES(?,?,?,?)", (tok, u["id"], now_iso(), now_iso()))
        store.audit(u, "Вход", u["name"], how)
        auto_close_period(C())
        resp = jsonify({"ok": True})
        resp.set_cookie(SESSION_COOKIE, tok, httponly=True, samesite="Lax", secure=secure_cookie, max_age=int(SESSION_IDLE.total_seconds()) * 4)
        return resp

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/status")
    def status():
        u = current_user()
        return {"firstRun": first_run(), "adminLogin": next((x["login"] for x in store.S["users"] if is_admin(x) and x.get("active")), "admin"),
                "user": {"id": u["id"], "lang": u.get("lang") or ""} if u else None}

    @app.post("/api/setup")
    def setup():
        p = body()
        with store.tx():
            if not first_run():
                raise A.ApiError(["Пароль администратора уже задан"])
            pw = p.get("password") or ""
            if len(pw) < 8:
                raise A.ApiError(["Пароль — не короче 8 символов"])
            adm = next(x for x in store.S["users"] if is_admin(x) and x.get("active"))
            adm["pw"] = A.make_pw(pw)
            store.save("users", adm)
            store.audit(adm, "Смена пароля пользователя", adm["name"], "первый запуск")
            return start_session(adm, "первый вход")

    @app.post("/api/login")
    def login():
        p = body()
        login_ = (p.get("login") or "").strip()
        pw = p.get("password") or ""
        with store.tx():
            since = (datetime.now(timezone.utc) - timedelta(minutes=FAIL_WINDOW_MIN)).isoformat()
            fails = store.conn.execute("SELECT COUNT(*) FROM login_failures WHERE login=? AND t>=?", (login_.lower(), since)).fetchone()[0]
            if fails >= MAX_FAILS:
                store.audit(None, "Неудачная попытка входа", login_ or "(пустой логин)", "вход заблокирован на 15 минут", uname=login_ or "—")
                raise A.ApiErrorCommit([f"Слишком много неудачных попыток. Попробуйте через {FAIL_WINDOW_MIN} минут."], 429)
            u = next((x for x in store.S["users"] if x["login"].lower() == login_.lower()), None)
            if not u or not u.get("active") or not A.check_pw(u, pw):
                why = "неизвестный логин" if not u else "пользователь отключён" if not u.get("active") else "пароль не задан" if not u.get("pw") else "неверный пароль"
                store.conn.execute("INSERT INTO login_failures(login, t) VALUES(?, ?)", (login_.lower(), datetime.now(timezone.utc).isoformat()))
                store.audit(None, "Неудачная попытка входа", login_ or "(пустой логин)", why, uname=login_ or "—")
                msg = "Пароль не задан — обратитесь к администратору" if u and not u.get("pw") else "Неверный логин или пароль"
                raise A.ApiErrorCommit([msg], 401)
            store.conn.execute("DELETE FROM login_failures WHERE login=?", (login_.lower(),))
            return start_session(u, "логин и пароль")

    @app.post("/api/logout")
    def logout():
        tok = request.cookies.get(SESSION_COOKIE)
        with store.tx():
            store.conn.execute("DELETE FROM sessions WHERE token=?", (tok,))
            store.audit(g.user, "Выход", g.user["name"], "")
        resp = jsonify({"ok": True})
        resp.delete_cookie(SESSION_COOKIE)
        return resp

    # ---------------- данные для интерфейса ----------------
    def state_for(u):
        c = C()
        S = c.S
        adm = is_admin(u)
        V = visible_wallets(c, u)
        nw = sees_no_wallet(u)
        out = {k: S[k] for k in ("orgs", "accounts", "cashboxes", "currencies", "rates", "cfTypes", "depts", "zones")}
        out["settings"] = S["settings"]
        refd = set()
        if adm:
            docs = [dict(d, lines=[dict(l, idx=i) for i, l in enumerate(d["lines"])], hiddenLines=0) for d in S["docs"]]
            ops, opening, contracts = S["ops"], S["opening"], S["contracts"]
        else:
            docs = []
            for d in S["docs"]:
                if d["type"] == "ПЕР":
                    ws = [d["from"].get("wallet"), d["to"].get("wallet")]
                    if any((w in V) if w else nw for w in ws):
                        docs.append(dict(d, hiddenLines=0)); refd.update(w for w in ws if w)
                    continue
                vis = [dict(l, idx=i) for i, l in enumerate(d["lines"]) if line_visible(c, u, l.get("wallet"))]
                if not vis:
                    continue
                hidden = len(d["lines"]) - len(vis)
                docs.append(dict(d, lines=vis, hiddenLines=hidden, versions=d["versions"] if not hidden else [], fileSig=""))
            ops = [o for o in S["ops"] if o.get("from") in V or o.get("to") in V]
            for o in ops:
                refd.update(x for x in (o.get("from"), o.get("to")) if x)
            opening = [x for x in S["opening"] if x.get("wallet") in V]
            contracts = [x for x in S["contracts"] if x["lender"] in V or x["borrower"] in V]
            for x in contracts:
                refd.update((x["lender"], x["borrower"]))
        out.update(docs=docs, ops=ops, opening=opening, contracts=contracts)
        # кошельки: администратор — все; остальные — свои, у казначея ещё названия активных нескрытых (раздел 8), чужие скрытые — замаскированы
        if adm:
            wallets = S["wallets"]
        else:
            named = set(V)
            if has(u, "treasurer"):
                named |= {w["id"] for w in S["wallets"] if hidden_allowed(c, u, w)}
            wallets = []
            for w in S["wallets"]:
                if w["id"] in named:
                    x = dict(w, access=[u["id"]] if u["id"] in (w.get("access") or []) else [])
                    if x.get("parent") and x["parent"] not in named:
                        x["parent"] = None
                    wallets.append(x)
                elif w["id"] in refd:
                    wallets.append({"id": w["id"], "name": "скрытый кошелёк", "parent": None, "head": False, "hidden": True, "access": [],
                                    "closed": False, "closedFrom": "", "masked": True})
        out["wallets"] = wallets
        out["rules"] = S["rules"] if (adm or has(u, "treasurer")) else []
        if adm:
            out["users"] = [{k: v for k, v in x.items() if k != "pw"} | {"hasPw": bool(x.get("pw"))} for x in S["users"]]
        else:
            out["users"] = [{"id": x["id"], "name": x["name"], "roles": x["roles"], "wallets": x.get("wallets") or [], "active": x["active"], "login": "", "email": ""}
                            for x in S["users"]]
        out["bal1c"] = S["bal1c"] if adm else []
        out["exchangeLog"] = S["exchangeLog"] if adm else []
        out["closedChanges"] = S["closedChanges"] if (adm or has(u, "treasurer")) else []
        rows = recon(c)
        if not (adm or has(u, "owner")):
            mine = {f["acc"] for f in facts(c) if f["wallet"] in V}
            rows = [r for r in rows if r["acc"] in mine]
        out["recon"] = rows
        out["reconciledDays"] = sorted(reconciled_days(c))
        out["notifications"] = notifications(c, u)
        if adm:
            out["notificationsByUser"] = {x["id"]: notifications(c, x) for x in S["users"] if x.get("active")}
            out["mailConfigured"] = mail_configured()
        out["me"] = {"id": u["id"], "name": u["name"], "roles": u["roles"], "wallets": u.get("wallets") or [], "lang": u.get("lang") or "", "email": u.get("email") or ""}
        out["perms"] = {"visible": sorted(V), "editable": sorted(w["id"] for w in S["wallets"] if can_edit_wallet(c, u, w["id"])),
                        "admin": adm, "canEnter": can_enter(u), "seesNoWallet": nw}
        out["version"] = store.version
        out["today"] = today_iso()
        return out

    @app.get("/api/state")
    def state():
        with store.lock:
            return Response(json.dumps(state_for(g.user), ensure_ascii=False, separators=(",", ":")), mimetype="application/json")

    @app.get("/api/version")
    def version():
        return {"version": store.version}

    # ---------------- изменения ----------------
    def act(fn, *args):
        with store.tx():
            res = fn(C(), g.user, *args)
        return jsonify({"ok": True, "result": res, "version": store.version})

    @app.post("/api/password")
    def password():
        p = body()
        return act(A.change_password, p.get("old"), p.get("new"))

    @app.post("/api/lang")
    def lang():
        return act(A.set_lang, body().get("lang"))

    @app.post("/api/docs/manual")
    def doc_manual():
        return act(A.save_manual_doc, body())

    @app.post("/api/docs/<doc_id>/delete")
    def doc_delete(doc_id):
        return act(A.toggle_doc_delete, doc_id)

    @app.post("/api/docs/<doc_id>/wallets")
    def doc_wallets(doc_id):
        return act(A.assign_wallets, doc_id, body().get("changes"))

    @app.post("/api/rules/apply-empty")
    def rules_apply():
        return act(A.apply_rules_to_empty)

    @app.post("/api/ops")
    def ops_save():
        return act(A.save_op, body())

    @app.post("/api/ops/<op_id>/delete")
    def ops_delete(op_id):
        return act(A.toggle_op_delete, op_id)

    @app.post("/api/contracts")
    def contracts():
        return act(A.create_contract, body())

    @app.post("/api/opening/<acc_id>")
    def opening(acc_id):
        return act(A.save_opening, acc_id, body().get("rows"))

    @app.post("/api/wallets")
    def wallets():
        return act(A.save_wallet, body().get("wallet") or {})

    @app.post("/api/wallets/<wid>/close")
    def wallet_close(wid):
        p = body()
        return act(A.close_transfer, wid, p.get("target"), p.get("date"))

    @app.post("/api/rules")
    def rules():
        return act(A.save_rule, body().get("rule") or {})

    @app.post("/api/rules/<rid>/toggle")
    def rule_toggle(rid):
        return act(A.toggle_rule, rid, body().get("on"))

    @app.post("/api/rules/order")
    def rules_order():
        return act(A.reorder_rules, body().get("ids") or [])

    @app.post("/api/users")
    def users():
        p = body()
        return act(A.save_user, dict(p.get("user") or {}, password=p.get("password")))

    @app.post("/api/settings")
    def settings():
        p = body()
        return act(A.set_setting, p.get("key"), p.get("value"))

    @app.post("/api/settings/close-month")
    def close_month():
        return act(A.close_month)

    @app.post("/api/closed-changes/seen")
    def cc_seen():
        return act(A.mark_closed_changes_seen)

    # ---------------- загрузка файлов ----------------
    @app.post("/api/import/<kind>/preview")
    def imp_preview(kind):
        p = body()
        with store.tx():
            pv = I.preview(C(), g.user, kind, p)
            if pv.get("errors") and p.get("logReject"):
                I.log_rejected(C(), g.user, kind, (p.get("fileName") or "")[:200], pv)
        return jsonify({"ok": True, "preview": pv})

    @app.post("/api/import/<kind>/apply")
    def imp_apply(kind):
        p = body()
        fn = {"exp": I.apply_exp, "ref": I.apply_ref, "bal": I.apply_bal}.get(kind)
        if not fn:
            raise A.ApiError(["Неизвестный вид загрузки"])
        return act(fn, p, (p.get("fileName") or "файл")[:200])

    # ---------------- журнал аудита ----------------
    @app.post("/api/audit/event")
    def audit_event():
        p = body()
        if p.get("action") not in CLIENT_AUDIT:
            raise A.ApiError(["Это событие пишет сервер"])
        with store.tx():
            store.audit(g.user, p["action"], str(p.get("object") or "")[:300], str(p.get("details") or "")[:2000])
        return {"ok": True}

    @app.get("/api/audit")
    def audit_list():
        A.need_admin(g.user)
        a = request.args
        with store.lock:
            rows = store.audit_query(a.get("user", ""), a.get("q", ""), a.get("from", ""), a.get("to", ""), int(a.get("limit", "1000")))
        return {"ok": True, "rows": rows}

    # ---------------- администрирование ----------------
    @app.get("/api/admin/backup")
    def backup():
        A.need_admin(g.user)
        with store.tx():
            data = {k: v for k, v in store.S.items()}
            data["users"] = [dict(u, pw=u.get("pw")) for u in store.S["users"]]
            store.audit(g.user, "Выгрузка резервной копии", "", "")
            payload = json.dumps({"format": "wallets-mvp", "created": now_iso(), "data": data}, ensure_ascii=False)
        return Response(payload, mimetype="application/json",
                        headers={"Content-Disposition": f"attachment; filename=wallets-backup-{today_iso()}.json"})

    @app.post("/api/admin/restore")
    def restore():
        A.need_admin(g.user)
        p = body()
        data = p.get("data") if p.get("format") == "wallets-mvp" else None
        if not isinstance(data, dict) or not isinstance(data.get("wallets"), list):
            raise A.ApiError(["Файл не похож на резервную копию"])
        me = dict(g.user)
        with store.tx():
            store.replace_all(data, keep_user=me)
            store.audit(me, "Восстановление из резервной копии", p.get("fileName") or "", "данные заменены; журнал аудита сохранён без изменений")
        return {"ok": True}

    @app.post("/api/admin/reset")
    def reset():
        A.need_admin(g.user)
        me = dict(g.user, wallets=[])
        with store.tx():
            store.replace_all({}, keep_user=me)
            store.audit(me, "Удаление всех данных", "", "журнал аудита сохранён")
        return {"ok": True}

    @app.post("/api/mail/send")
    def mail_send():
        A.need_admin(g.user)
        if not mail_configured():
            raise A.ApiError(["Почта не настроена: задайте SMTP_HOST и SMTP_FROM в настройках сервера"])
        with store.tx():
            n = send_notifications(store, C(), only=body().get("userId"), by=g.user)
        return {"ok": True, "sent": n}

    # ---------------- интерфейс ----------------
    @app.get("/")
    def index():
        resp = send_from_directory(app.static_folder, "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    if start_scheduler:
        threading.Thread(target=scheduler, args=(store,), daemon=True).start()
    return app


def reset_admin_password(store, password, how):
    """Восстановление доступа: новый пароль первому активному администратору, снятие блокировки входа.
    Вызывается внутри транзакции."""
    if len(password) < 8:
        raise SystemExit("Пароль — не короче 8 символов")
    adm = next((u for u in store.S["users"] if is_admin(u) and u.get("active")), None)
    if not adm:
        adm = next((u for u in store.S["users"] if is_admin(u)), None) or store.S["users"][0]
        adm["active"] = True
        if "admin" not in adm["roles"]:
            adm["roles"] = adm["roles"] + ["admin"]
    adm["pw"] = A.make_pw(password)
    store.save("users", adm)
    store.conn.execute("DELETE FROM login_failures")
    store.conn.execute("DELETE FROM sessions WHERE user_id=?", (adm["id"],))
    store.audit(None, "Сброс пароля администратора", adm["name"], how, uname="Система")
    return adm


def scheduler(store):
    """Ежедневные задачи: автозакрытие периода 5-го числа (ТР-55), очистка старого аудита (ТР-47),
    рассылка уведомлений в конце дня (ТР-24, ТР-42), если настроена почта."""
    hour = int(os.environ.get("NOTIFY_HOUR", "19"))
    while True:
        try:
            with store.tx():
                C = Ctx(store)
                auto_close_period(C)
                store.purge_old_audit()
                r = store.conn.execute("SELECT value FROM meta WHERE key='last_mail'").fetchone()
                today = today_iso()
                if mail_configured() and datetime.now().hour >= hour and (not r or r["value"] != today):
                    send_notifications(store, C, only=None, by=None)
                    store.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('last_mail', ?)", (today,))
        except Exception:
            log.exception("Ошибка фоновой задачи")
        time.sleep(600)
