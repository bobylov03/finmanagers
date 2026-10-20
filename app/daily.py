"""Daily Balance — ежедневная сверка банковских и расчётных остатков (раздел 7, ТР-91…ТР-105; v3.1).
v3.1: Кф — фактический расчётный остаток кошельков (СБДС — только исполненные банком), Писх — подтверждённые казначеем
исходящие в пути, Кп = Кф − Писх. Главная сверка: Расхождение = Б − Кф.

Обозначения: D — рабочий день, за утро которого сдаётся отчёт; Б — остаток по банку на утро D (вводит казначей);
П — исходящие в пути: учтённые СБДС с датой ≤ D−1 без даты проведения банком или с датой ≥ D (программа предзаполняет,
казначей подтверждает) = Писх; К = Кф — сумма фактических остатков всех кошельков по позиции на конец D−1, включая «Без кошелька».
Расхождение = Б − Кф; Кп = Кф − Писх. Разные валюты никогда не суммируются; USD в сверке не участвует (ТР-58).
"""
from datetime import date, datetime, timedelta, timezone

from .logic import (acc_curs, cur_code, descendants, doc_movement, has, hidden_allowed, is_admin, nm, own_wallets, pos_facts, rate_at,
                    treasurers_of, in_closed, visible_wallets, doc_eval, FAR)
from .util import fmt, fmt_d, now_iso, r2

OP_NAMES = {"loan": "Выдача займа", "repay": "Погашение займа", "funding": "Финансирование", "dividends": "Дивиденды", "exchange": "Обмен", "closeDiv": "Дивиденды"}

STATUS = {"ok": "Сходится", "diff": "Расхождение", "noreport": "Нет отчёта", "noaccess": "Нет доступа к банку", "explained": "Объяснено"}


# ---------------- время и календарь ----------------
def tz(C):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(C.S["settings"].get("dbTz") or "Europe/Moscow")
    except Exception:  # на Windows без пакета tzdata — Москва, UTC+3 без перехода на летнее время
        return timezone(timedelta(hours=3))


def now_local(C):
    return datetime.now(tz(C))


def today_local(C):
    return now_local(C).date().isoformat()


def is_workday(C, d):
    st = C.S["settings"]
    if d in (st.get("dbHolidays") or []):
        return False
    if d in (st.get("dbWorkdays") or []):
        return True
    return date.fromisoformat(d).isoweekday() not in (st.get("dbWeekends") or [6, 7])


def prev_workday(C, d):
    x = date.fromisoformat(d)
    for _ in range(40):
        x -= timedelta(days=1)
        if is_workday(C, x.isoformat()):
            return x.isoformat()
    return (date.fromisoformat(d) - timedelta(days=1)).isoformat()


def current_day(C):
    """Рабочий день, за который сейчас сдаётся отчёт: сегодня, а в выходной — последний рабочий день."""
    t = today_local(C)
    return t if is_workday(C, t) else prev_workday(C, t)


def deadline(C, d):
    hh, mm = (C.S["settings"].get("dbTime") or "10:30").split(":")
    return datetime(*map(int, d.split("-")), int(hh), int(mm), tzinfo=tz(C))


def is_late(C, d, t=None):
    t = t or now_local(C)
    return t > deadline(C, d)


# ---------------- позиции и доступ (ТР-104) ----------------
def pos_list(C, active_only=True):
    return [p for p in C.S["dbPositions"] if p.get("active") or not active_only]


def pos_get(C, pid):
    return C.get("dbPositions", pid)


def full_access(u):
    """Видят весь Daily Balance: администратор, собственник, фин. контролер."""
    return is_admin(u) or has(u, "owner") or has(u, "finControl")


def visible_positions(C, u):
    if full_access(u):
        return pos_list(C)
    if not has(u, "treasurer"):
        return []
    own = own_wallets(C, u)
    pf = pos_facts(C)
    out = []
    for p in pos_list(C):
        if p.get("owner") == u["id"] or any(f["wallet"] in own for f in pf.get((p["acc"], p["cur"]), [])):
            out.append(p)
    return out


def wallet_label_map(C, u):
    """Кошельки, которые пользователь видит по имени; остальные сворачиваются в «прочие кошельки» (ТР-104, ТР-35)."""
    if is_admin(u):
        return None
    if has(u, "owner") or has(u, "finControl"):
        return {w["id"] for w in C.S["wallets"] if hidden_allowed(C, u, w)}
    return {w for w in own_wallets(C, u) if C.get("wallets", w) and hidden_allowed(C, u, C.get("wallets", w))}


# ---------------- расчёт К и П ----------------
def k_on(C, pos, d):
    """Кф: фактические остатки кошельков по позиции на конец D−1 (все кошельки и «Без кошелька»; СБДС — исполненные банком)."""
    lim = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
    by = {}
    for f in pos_facts(C).get((pos["acc"], pos["cur"]), []):
        if f["date"] <= lim:
            by[f["wallet"] or ""] = by.get(f["wallet"] or "", 0) + f["sum"]
    by = {k: r2(v) for k, v in by.items() if abs(v) >= 0.005}
    return r2(sum(by.values())), by


def k_split(C, u, by):
    """Разбивка К по кошелькам с учётом доступа: чужие — одной строкой «прочие кошельки»."""
    allowed = wallet_label_map(C, u)
    out, other = [], 0
    for w, v in sorted(by.items(), key=lambda x: -abs(x[1])):
        if allowed is None or w == "" and (has(u, "treasurer") or has(u, "owner") or has(u, "finControl")) or w in (allowed or set()):
            out.append({"wallet": w, "name": nm(C.get("wallets", w)) if w else "Без кошелька", "sum": v})
        else:
            other += v
    if abs(other) >= 0.005:
        out.append({"wallet": "*", "name": "прочие кошельки", "sum": r2(other)})
    return out


def k_movements(C, u, pos, d):
    """ТР-101: клик по К — движения позиции до конца D−1. Доступ — как у разбивки К (ТР-104):
    свои кошельки и «Без кошелька» построчно, чужие — одной строкой «прочие кошельки»."""
    lim = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
    allowed = wallet_label_map(C, u)
    rows, other, other_n = [], 0.0, 0
    for f in sorted(pos_facts(C).get((pos["acc"], pos["cur"]), []), key=lambda x: x["date"]):
        if f["date"] > lim:
            continue
        w = f.get("wallet") or ""
        if not (allowed is None or w == "" or w in allowed):
            other += f["sum"]; other_n += 1
            continue
        title, ref = "", None
        if f.get("doc"):
            doc = C.get("docs", f["doc"])
            title = f"{doc['type']} {doc.get('no1c') or doc.get('no') or ''}".strip() if doc else ""
            ref = {"k": "doc", "id": f["doc"]}
        elif f.get("op"):
            o = C.get("ops", f["op"])
            title = f"{o.get('no') or ''} {OP_NAMES.get(o['kind'], '')}".strip() if o else ""
            ref = {"k": "op", "id": f["op"]}
        else:
            title = "Входящий остаток"
        rows.append({"date": f["date"], "title": title, "ref": ref, "wallet": w, "walletName": nm(C.get("wallets", w)) if w else "Без кошелька",
                     "sum": r2(f["sum"]), "cat": f.get("cat")})
    if other_n:
        rows.append({"date": lim, "title": f"{other_n} движений", "ref": None, "wallet": "*", "walletName": "прочие кошельки", "sum": r2(other), "cat": "other"})
    return {"rows": rows, "total": r2(sum(x["sum"] for x in rows)), "lim": lim}


def p_candidates(C, pos, d):
    """П по программе: учтённые СБДС позиции с датой ≤ D−1 без даты проведения банком или с датой ≥ D."""
    lim = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
    out = []
    for doc in C.S["docs"]:
        if doc["type"] != "СБДС":
            continue
        mv, counted = doc_movement(C, doc)
        if not counted or mv.get("acc") != pos["acc"] or (mv.get("cur") or "") != pos["cur"] or mv["date"] > lim:
            continue
        kf = doc_eval(C, doc)["kf"]   # ДР-09: исполненный банком (признак «Да» и дата) до D — уже в Кф, не в Писх
        if kf != FAR and kf < d:
            continue
        out.append({"doc": doc["id"], "no": doc.get("no1c") or doc.get("no"), "date": mv["date"], "sum": r2(sum(l.get("sum") or 0 for l in mv["lines"])),
                    "cpty": ", ".join(dict.fromkeys(l.get("cpty") for l in doc.get("lines") or [] if l.get("cpty")))})
    out.sort(key=lambda x: (x["date"], x["no"] or ""))
    return out


def rate_usd(C, cur, d):
    return rate_at(C, cur, d)


# ---------------- отчёты ----------------
def reports_of(C, d=None, user=None, kind=None):
    return [r for r in C.S["dbReports"] if (d is None or r["date"] == d) and (user is None or r["user"] == user) and (kind is None or r["kind"] == kind)]


def morning_row(C, pid, d):
    """Строка утреннего отчёта по позиции за D (последний утренний отчёт, где есть позиция)."""
    for r in reversed(reports_of(C, d, kind="morning")):
        for row in r["rows"]:
            if row["pos"] == pid:
                return r, row
    return None, None


def corrections(C, pid, d):
    return [c for c in C.S["dbCorr"] if c["pos"] == pid and c["date"] == d]


def effective(C, row, pid, d):
    """ТР-98: скорректированные Б и П; исходное значение остаётся рядом."""
    b, p = row.get("b"), row.get("p")
    cb = cp = None
    for c in corrections(C, pid, d):
        if c["field"] == "b":
            b, cb = c["value"], c
        elif c["field"] == "p":
            p, cp = c["value"], c
    return b, p, cb, cp


def last_balance(C, pid, before):
    """Последний сданный фактический остаток Б по позиции до даты (с датой и временем): утренний или обновление."""
    best = None
    for r in C.S["dbReports"]:
        if r["date"] >= before:
            continue
        for row in r["rows"]:
            if row["pos"] == pid and not row.get("noAccess") and row.get("b") is not None:
                b = row["b"]
                if r["kind"] == "morning":
                    b = effective(C, row, pid, r["date"])[0]
                key = (r["date"], r["t"])
                if not best or key > best["key"]:
                    best = {"key": key, "b": b, "date": r["date"], "t": r["t"], "kind": r["kind"]}
    if best:
        best.pop("key")
    return best


def latest_on(C, pid, d):
    """Последнее значение Б за день D: обновление днём (ТР-97) или утренний отчёт."""
    best = None
    for r in reports_of(C, d):
        for row in r["rows"]:
            if row["pos"] == pid and row.get("b") is not None and not row.get("noAccess"):
                b = effective(C, row, pid, d)[0] if r["kind"] == "morning" else row["b"]
                if not best or (r["t"], r["id"] or 0) > (best["t"], best["id"]):
                    best = {"b": b, "t": r["t"], "kind": r["kind"], "date": d, "id": r["id"] or 0, "rate": row.get("rate")}
    return best


def tol(C, cur):
    return float((C.S["settings"].get("dbTol") or {}).get(cur_code(C, cur), 0) or 0)


def explained(C, pid, d):
    lst = [e for e in C.S["dbExpl"] if e["pos"] == pid and e["date"] == d]
    return lst[-1] if lst else None


def recon_row(C, u, pos, d, state="submit"):
    """ТР-100, ТР-102: две проверки по позиции на D; «на момент сдачи» или «сейчас»."""
    rep, row = morning_row(C, pos["id"], d)
    a = C.acc(pos["acc"])
    base = {"pos": pos["id"], "acc": pos["acc"], "org": a and a["org"], "cur": pos["cur"], "owner": pos.get("owner"), "date": d}
    if not row:
        k, by = k_on(C, pos, d)
        return dict(base, status="noreport", k=k, kSplit=k_split(C, u, by))
    b, p, cb, cp = effective(C, row, pos["id"], d)
    if state == "now":
        k, by = k_on(C, pos, d)
    else:
        k, by = row.get("k"), row.get("kBy") or {}
    out = dict(base, report=rep["id"], t=rep["t"], late=rep.get("late"), b=b, bOrig=row.get("b"), p=p, pOrig=row.get("p"), bCorr=cb, pCorr=cp,
               k=k, kSplit=k_split(C, u, by), noAccess=row.get("noAccess"), last=row.get("last"), comment=row.get("comment"), incoming=row.get("incoming"))
    if row.get("noAccess"):
        out["status"] = "noaccess"
        return out
    # Daily Balance v3.1: главная сверка Б − Кф; Писх проверяется отдельно, Кп = Кф − Писх
    diff = r2(b - k)
    out["diff"] = diff
    out["kp"] = r2(k - (p or 0))
    # проверка 2: П казначея против списка неисполненных СБДС программы
    # «на момент сдачи» — список программы, сохранённый при сдаче (ТР-96, ТР-102); «сейчас» — пересчитанный
    prog = row["pCand"] if state != "now" and row.get("pCand") is not None else p_candidates(C, pos, d)
    prog_sum = r2(sum(x["sum"] for x in prog))
    checked = set(row.get("pDocs") or [])
    out["p2"] = {"treasurer": p, "program": prog_sum, "diff": r2(p - prog_sum),
                 "missing": [x for x in prog if x["doc"] not in checked], "extra": [x for x in (row.get("pItems") or []) if x["doc"] not in {y["doc"] for y in prog}],
                 "manual": row.get("pManual") or []}
    ex = explained(C, pos["id"], d)
    if abs(diff) <= tol(C, pos["cur"]) + 0.004:
        out["status"] = "ok"
    elif ex:
        out["status"], out["explained"] = "explained", ex
    else:
        out["status"] = "diff"
    return out


def hints(C, pos, d, diff):
    """ТР-101: документы с такой же суммой, дата последнего документа, строки без кошелька, документы «Требует проверки»."""
    fl = pos_facts(C).get((pos["acc"], pos["cur"]), [])
    same, seen = [], set()
    if diff:
        for f in fl:
            if f.get("doc") and abs(abs(f["sum"]) - abs(diff)) < 0.005 and f["doc"] not in seen:
                seen.add(f["doc"]); doc = C.get("docs", f["doc"])
                same.append({"doc": f["doc"], "no": doc and (doc.get("no1c") or doc.get("no")), "date": f["date"], "sum": f["sum"]})
        for doc in C.S["docs"]:  # документы, которые в расчёт не вошли, тоже подсказка
            if doc["id"] in seen or doc.get("acc") != pos["acc"] or (doc.get("cur") or "") != pos["cur"]:
                continue
            tot = r2(sum(l.get("sum") or 0 for l in doc.get("lines") or []))
            if abs(tot - abs(diff)) < 0.005:
                seen.add(doc["id"]); same.append({"doc": doc["id"], "no": doc.get("no1c") or doc.get("no"), "date": doc["date"], "sum": tot, "notCounted": True})
    docs_dates = [f.get("docDate", f["date"]) for f in fl if f.get("doc") or f.get("op")]
    no_w = sum(1 for f in fl if not f["wallet"] and f.get("doc"))
    review = [{"doc": x["id"], "no": x.get("no1c") or x.get("no")} for x in C.S["docs"] if x.get("review") and x.get("acc") == pos["acc"] and (x.get("cur") or "") == pos["cur"]]
    return {"same": same[:10], "lastDoc": max(docs_dates) if docs_dates else None, "noWallet": no_w, "review": review}


def age_days(C, u, pos, d):
    """Возраст незакрытого расхождения: сколько рабочих дней подряд (до D включительно) позиция не сходится."""
    n, x = 0, d
    for _ in range(60):
        r = recon_row(C, u, pos, x, "now")
        if r["status"] != "diff":
            break
        n += 1
        x = prev_workday(C, x)
    return n


def recon_view(C, u, d, state="submit"):
    rows = []
    for pos in visible_positions(C, u):
        r = recon_row(C, u, pos, d, state)
        if r["status"] == "diff":
            r["age"] = age_days(C, u, pos, d)
        r["hints"] = hints(C, pos, d, r.get("diff"))
        rows.append(r)
    cnt = {k: sum(1 for r in rows if r["status"] == k) for k in STATUS}
    return {"date": d, "state": state, "workday": is_workday(C, d), "rows": rows, "summary": dict(cnt, total=len(rows))}


# ---------------- окно казначея ----------------
def my_positions(C, u):
    return [p for p in pos_list(C) if p.get("owner") == u["id"]]


def draft_get(C, u, d):
    return C.get("dbDrafts", f"{u['id']}|{d}")


def my_view(C, u, d):
    mine = my_positions(C, u)
    rep = next((r for r in reversed(reports_of(C, d, u["id"], "morning"))), None)
    dr = draft_get(C, u, d)
    rows = []
    for pos in mine:
        a = C.acc(pos["acc"])
        prev = last_balance(C, pos["id"], d)
        k, by = k_on(C, pos, d)
        rows.append({"pos": pos["id"], "acc": pos["acc"], "org": a and a["org"], "cur": pos["cur"], "prev": prev, "pCand": p_candidates(C, pos, d),
                     "rate": rate_usd(C, pos["cur"], d), "k": k, "kSplit": k_split(C, u, by),
                     "updates": [dict(row, t=r["t"]) for r in reports_of(C, d, u["id"], "update") for row in r["rows"] if row["pos"] == pos["id"]]})
    status = "submitted" if rep else ("overdue" if is_workday(C, d) and is_late(C, d) else "draft")
    return {"date": d, "workday": is_workday(C, d), "deadline": deadline(C, d).isoformat(), "status": status, "late": bool(rep and rep.get("late")),
            "report": rep, "draft": (dr or {}).get("data") or {}, "draftSaved": (dr or {}).get("updated"), "rows": rows, "today": today_local(C),
            "current": current_day(C)}


def build_row(C, u, pos, d, data):
    """Снимок строки отчёта при сдаче (ТР-96): Б, П, входящие, курс, USD, К по каждому кошельку, расхождение."""
    a = C.acc(pos["acc"])
    no_access = bool(data.get("noAccess"))
    cand = {x["doc"]: x for x in p_candidates(C, pos, d)}
    p_docs = [x for x in (data.get("pDocs") or []) if x in cand]
    p_manual = [{"sum": r2(float(m.get("sum") or 0)), "comment": str(m.get("comment") or "")[:300]} for m in (data.get("pManual") or []) if m.get("sum") not in (None, "")]
    p = r2(sum(cand[x]["sum"] for x in p_docs) + sum(m["sum"] for m in p_manual))
    k, by = k_on(C, pos, d)
    rate = rate_usd(C, pos["cur"], d)
    row = {"pos": pos["id"], "acc": pos["acc"], "org": a and a["org"], "cur": pos["cur"], "noAccess": no_access,
           "pDocs": p_docs, "pItems": [cand[x] for x in p_docs], "pManual": p_manual, "p": p, "pCand": list(cand.values()),
           "incoming": r2(float(data.get("incoming") or 0)) if data.get("incoming") not in (None, "") else None,
           "incomingComment": str(data.get("incomingComment") or "")[:300], "comment": str(data.get("comment") or "")[:500],
           "rate": rate, "k": k, "kBy": by}
    if no_access:
        last = last_balance(C, pos["id"], d)
        row["last"] = last          # ТР-95: подставляется последний доступный остаток с датой; фактическим на D не считается
        row["b"] = last["b"] if last else None
        row["diff"] = None
    else:
        row["b"] = r2(float(data["b"]))
        row["diff"] = r2(row["b"] - k)          # v3.1: Расхождение = Б − Кф
    row["kp"] = r2(k - p)                       # Кп = Кф − Писх
    row["bp"] = r2(row["b"] - p) if row["b"] is not None else None
    row["usd"] = r2(row["b"] / rate) if rate and row["b"] is not None else None   # USD остатка банка
    return row


def db_notifications(C, u, d=None):
    """ТР-103: просрочка сдачи и незакрытые расхождения — в «Требует внимания» и ежедневные письма."""
    if not C.S["dbPositions"]:
        return []
    key = ("dbn", u["id"])
    if key in C.st.cache:
        return C.st.cache[key]
    out = []
    D = current_day(C)
    if is_workday(C, today_local(C)) and my_positions(C, u) and not reports_of(C, D, u["id"], "morning"):
        if is_late(C, D):
            out.append({"lvl": "err", "text": f"Daily Balance за {fmt_d(D)} не сдан — просрочен (контрольное время {C.S['settings'].get('dbTime')} МСК)", "tr": "ТР-94", "go": "dbmy"})
        else:
            out.append({"lvl": "warn", "text": f"Сдайте Daily Balance за {fmt_d(D)} до {C.S['settings'].get('dbTime')} МСК", "tr": "ТР-94", "go": "dbmy"})
    if has(u, "finControl") or is_admin(u):
        owners = {p.get("owner") for p in pos_list(C) if p.get("owner")}
        missing = [o for o in owners if not reports_of(C, D, o, "morning")]
        if missing and is_late(C, D) and is_workday(C, today_local(C)):
            out.append({"lvl": "warn", "text": f"Daily Balance за {fmt_d(D)} не сдали: {', '.join(nm(C.get('users', o)) for o in missing)}", "tr": "ТР-94", "go": "dbmorning"})
    # расхождения: казначеям кошельков на позиции, ответственному за позицию и фин. контролеру
    pf = pos_facts(C)
    for pos in pos_list(C):
        rr = recon_row(C, u, pos, D, "now")
        if rr["status"] != "diff":
            continue
        ws = {f["wallet"] for f in pf.get((pos["acc"], pos["cur"]), []) if f["wallet"]}
        tres = set()
        for w in ws:
            tres |= set(treasurers_of(C, w))
        if pos.get("owner") == u["id"] or u["id"] in tres or has(u, "finControl"):
            a = C.acc(pos["acc"])
            out.append({"lvl": "err", "text": f"Daily Balance: расхождение {'+' if rr['diff'] > 0 else ''}{fmt(rr['diff'])} {cur_code(C, pos['cur'])} — {nm(a)} на {fmt_d(D)}",
                        "tr": "ТР-100", "go": "dbrecon"})
    C.st.cache[key] = out
    return out


# ---------------- окно «Остатки на утро» (ТР-99) ----------------
def morning_view(C, u, d, mode="morning"):
    rows = []
    vis = visible_positions(C, u)
    for pos in vis:
        a = C.acc(pos["acc"])
        rate = rate_usd(C, pos["cur"], d)
        rep, row = morning_row(C, pos["id"], d)
        it = {"pos": pos["id"], "acc": pos["acc"], "org": a and a["org"], "cur": pos["cur"], "owner": pos.get("owner"), "rate": rate,
              "bank": (a or {}).get("bank") or "", "cash": bool(a and a.get("kind") == "Касса")}   # ДР-12: фильтр по банку
        if row and not row.get("noAccess"):
            b, p, cb, cp = effective(C, row, pos["id"], d)
            # ТР-96: USD — по курсу, зафиксированному в снимке при сдаче; поздние правки курсов его не меняют
            it.update(b=b, src="morning", t=rep["t"], corrected=bool(cb), bOrig=row.get("b"), corr=cb, late=rep.get("late"), rate=row.get("rate") or rate)
            if mode == "latest":
                lt = latest_on(C, pos["id"], d)
                if lt and lt["id"] > (rep["id"] or 0):
                    it.update(b=lt["b"], src=lt["kind"], t=lt["t"], rate=lt.get("rate") or it["rate"])
        else:
            last = (row or {}).get("last") if row else last_balance(C, pos["id"], d)
            it.update(b=last and last["b"], stale=True, staleDate=last and last["date"], noAccess=bool(row and row.get("noAccess")), noReport=not row)
        it["usd"] = r2(it["b"] / it["rate"]) if it.get("rate") and it.get("b") is not None else None
        rows.append(it)
    owners = sorted({p.get("owner") for p in vis if p.get("owner")})
    sub = [o for o in owners if reports_of(C, d, o, "morning")]
    late = [o for o in sub if any(r.get("late") for r in reports_of(C, d, o, "morning"))]
    wd = is_workday(C, d)
    overdue = [o for o in owners if o not in sub and wd and is_late(C, d)]
    pending = [o for o in owners if o not in sub and o not in overdue]
    name = lambda o: nm(C.get("users", o))
    return {"date": d, "mode": mode, "workday": wd, "rows": rows,
            "header": {"total": len(owners), "submitted": len(sub), "late": [name(o) for o in late], "overdue": [name(o) for o in overdue],
                       "pending": [name(o) for o in pending], "deadline": deadline(C, d).isoformat(),
                       # ДР-12: идентификаторы — чтобы при фильтре по банку и казначею пересчитать статусы сдачи по отобранным позициям
                       "ids": {"owners": owners, "sub": sub, "late": late, "overdue": overdue, "pending": pending}}}


def history(C, u, pid):
    """История позиции: утренние отчёты, обновления днём, корректировки, «Объяснено»."""
    out = []
    for r in C.S["dbReports"]:
        for row in r["rows"]:
            if row["pos"] == pid:
                out.append({"kind": r["kind"], "date": r["date"], "t": r["t"], "uname": r["uname"], "late": r.get("late"), "b": row.get("b"), "p": row.get("p"),
                            "k": row.get("k"), "diff": row.get("diff"), "noAccess": row.get("noAccess"), "comment": row.get("comment"), "report": r["id"]})
    for c in C.S["dbCorr"]:
        if c["pos"] == pid:
            out.append({"kind": "correction", "date": c["date"], "t": c["t"], "uname": c["uname"], "field": c["field"], "value": c["value"], "reason": c["reason"], "report": c["report"]})
    for e in C.S["dbExpl"]:
        if e["pos"] == pid:
            out.append({"kind": "explained", "date": e["date"], "t": e["t"], "uname": e["uname"], "comment": e["comment"]})
    out.sort(key=lambda x: (x["date"], x["t"]), reverse=True)
    return out


def opening_control(C):
    """ТР-22: банковский остаток Daily Balance на утро даты начала за минусом исходящих в пути — по позициям."""
    d0 = C.S["settings"].get("startDate")
    out = {}
    if not d0:
        return out
    for pos in C.S["dbPositions"]:
        rep, row = morning_row(C, pos["id"], d0)
        if row and not row.get("noAccess"):
            b, p, _, _ = effective(C, row, pos["id"], d0)
            out[f"{pos['acc']}|{pos['cur']}"] = {"b": b, "p": p, "bp": r2(b - p), "date": d0}
    return out