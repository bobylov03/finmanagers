"""Бизнес-логика: права, расчёт остатков, сверка, правила автозаполнения, проверки.

Совпадает с расчётами в интерфейсе (static/js/core.js); сервер — главный: все изменения
проверяются здесь, интерфейс проверяет то же самое только для удобства.
"""
import json
import math

from .util import fmt, fmt_d, is_num, norm, prev_month_end, r2, today_iso

ROLES = {"owner": "Собственник", "fcHead": "Руководитель финцентра", "treasurer": "Казначей",
         "deptHead": "Руководитель отдела", "admin": "Администратор"}
OP_KINDS = {
    "loan": {"name": "Выдача займа", "from": "Кошелёк-займодавец", "to": "Кошелёк-заёмщик"},
    "repay": {"name": "Погашение займа", "from": "Кошелёк-заёмщик", "to": "Кошелёк-займодавец"},
    "funding": {"name": "Безвозмездное финансирование", "from": "Головной кошелёк", "to": "Кошелёк"},
    "dividends": {"name": "Дивиденды", "from": "Кошелёк", "to": "Головной кошелёк"},
    "closeDiv": {"name": "Дивиденды односторонние (перенос остатка при закрытии)", "from": "Закрываемый кошелёк", "to": "Выбранный кошелёк"},
    "exchange": {"name": "Обмен между кошельками на двух счетах", "from": "Кошелёк X", "to": "Кошелёк Y"},
}
DOC_TYPES = {
    "СБДС": {"name": "Списание безналичных ДС", "sign": -1, "cash": False},
    "РКО": {"name": "Расходный кассовый ордер", "sign": -1, "cash": True},
    "ПБДС": {"name": "Поступление на счёт", "sign": 1, "cash": False},
    "ПКО": {"name": "Поступление в кассу", "sign": 1, "cash": True},
    "ПЕР": {"name": "Конвертация / переброска", "sign": 0, "cash": None},
}
MANUAL_OPS = {
    "ПБДС": ["Прочее поступление", "Оплата от клиента", "Возврат от поставщика", "Поступление по кредитам и займам", "Возврат депозита"],
    "ПКО": ["Прочее поступление", "Оплата от клиента", "Поступление наличных из банка", "Возврат от подотчётника"],
    "ПЕР": ["Конвертация валюты", "Перечисление на другой счёт", "Оплата в другую организацию группы", "Инкассация"],
}
RULE_FIELDS = {"org": "Организация", "acc": "Счёт или касса", "dept": "Подразделение", "cf": "Тип расхода CF", "zone": "Зона ответственности", "cpty": "Контрагент"}
RULE_OPS = {"eq": "Равно", "ne": "Не равно", "in": "В списке", "group": "В группе"}


class Ctx:
    """Удобный доступ к данным хранилища и кэшам расчёта."""

    def __init__(self, store):
        self.st = store
        self.S = store.S

    def get(self, coll, id_):
        return self.st.get(coll, id_)

    def acc(self, id_):
        a = self.st.get("accounts", id_)
        if a:
            return dict(a, kind="Счёт")
        k = self.st.get("cashboxes", id_)
        return dict(k, kind="Касса") if k else None

    def cache(self, key, fn):
        c = self.st.cache
        if key not in c:
            c[key] = fn()
        return c[key]


def nm(x):
    return x["name"] if x else "—"


def cur_code(C, cid):
    c = C.get("currencies", cid)
    return (c.get("code") or c.get("name") or c["id"]) if c else (cid or "")


def is_usd(C, cid):
    return str(cur_code(C, cid)).upper() == "USD" or str(cid).upper() == "USD"


def is_active_at(x, d):
    return not (x and x.get("deactivated") and d and d >= x["deactivated"])


# ---------------- курсы (ТР-32) ----------------
def rate_index(C):
    def build():
        ix = {}
        for r in C.S["rates"]:
            ix.setdefault(r["cur"], []).append(r)
        for a in ix.values():
            a.sort(key=lambda x: x["date"])
        return ix
    return C.cache("rates", build)


def rate_at(C, cid, d):
    if is_usd(C, cid):
        return 1.0
    best = None
    for x in rate_index(C).get(cid, []):
        if x["date"] <= d:
            best = x
        else:
            break
    return best["rate"] if best else None


def to_usd(C, s, cid, d, rate=None):
    k = rate or rate_at(C, cid, d)
    if not k:
        return None
    return r2(s / k)


# ---------------- кошельки ----------------
def descendants(C, wid):
    out = {wid}
    grow = True
    while grow:
        grow = False
        for w in C.S["wallets"]:
            if w.get("parent") in out and w["id"] not in out:
                out.add(w["id"]); grow = True
    return out


def ancestors(C, wid):
    out, w = [], C.get("wallets", wid)
    while w and len(out) < 10:
        out.append(w); w = C.get("wallets", w.get("parent"))
    return out


def wallet_closed_at(C, w, d):
    if isinstance(w, str):
        w = C.get("wallets", w)
    return bool(w and w.get("closed") and w.get("closedFrom") and d and d >= w["closedFrom"])


# ---------------- роли и права (раздел 8) ----------------
def has(u, r):
    return bool(u and r in (u.get("roles") or []))


def is_admin(u):
    return has(u, "admin")


def own_wallets(C, u):
    s = set()
    for wid in u.get("wallets") or []:
        if C.get("wallets", wid):
            s |= descendants(C, wid)
    return s


def hidden_allowed(C, u, w):
    return all((not a.get("hidden")) or u["id"] in (a.get("access") or []) for a in ancestors(C, w["id"]))


def visible_wallets(C, u):
    def build():
        if is_admin(u):
            return {w["id"] for w in C.S["wallets"]}
        base = {w["id"] for w in C.S["wallets"]} if has(u, "owner") else own_wallets(C, u)
        return {wid for wid in base if C.get("wallets", wid) and hidden_allowed(C, u, C.get("wallets", wid))}
    return C.cache(("vis", u["id"]), build)


def sees_no_wallet(u):
    return is_admin(u) or has(u, "owner") or has(u, "treasurer")


def can_edit_wallet(C, u, wid):
    return is_admin(u) or (has(u, "treasurer") and wid in own_wallets(C, u))


def can_enter(u):
    return is_admin(u) or has(u, "treasurer")


def line_visible(C, u, wid):
    if is_admin(u):
        return True
    return (wid in visible_wallets(C, u)) if wid else sees_no_wallet(u)


# ---------------- период (ТР-55) ----------------
def in_closed(C, d):
    ct = C.S["settings"].get("closedTo")
    return bool(ct and d and d <= ct)


def period_error(C, d):
    st = C.S["settings"]
    if not d:
        return "Не указана дата"
    if in_closed(C, d):
        return f"Период по {fmt_d(st['closedTo'])} закрыт (ТР-55). Исправления вносятся новой операцией в открытом периоде."
    if d in reconciled_days(C):
        return f"За {fmt_d(d)} сверка с 1С прошла без расхождений — правка операций этого дня запрещена (ТР-55)."
    if st.get("startDate") and d < st["startDate"]:
        return f"Дата раньше начала учёта по кошелькам ({fmt_d(st['startDate'])})."
    return None


def manual_allowed(C, d):
    sw = C.S["settings"].get("switchDate")
    return not (sw and d >= sw)


# ---------------- правила автозаполнения (ТР-73) ----------------
def dept_in_group(C, d, gid):
    x, n = C.get("depts", d), 0
    while x and n < 20:
        if x["id"] == gid:
            return True
        x = C.get("depts", x.get("parent")); n += 1
    return False


def cond_result(C, c, ctx):
    field, vals = c.get("field"), c.get("values") or []
    v = ctx.get(field) or ""
    text = field == "cpty"
    eq = (lambda a, b: norm(a) == norm(b)) if text else (lambda a, b: a == b)
    in_list = any(eq(v, x) for x in vals)
    op = c.get("op")
    if op == "eq":
        return len(vals) > 0 and in_list
    if op == "ne":
        return not in_list
    if op == "in":
        return in_list
    if op == "group":
        return any(dept_in_group(C, v, g) for g in vals) if field == "dept" else in_list
    return False


def match_rule(C, ctx, d):
    for r in C.S["rules"]:
        if not r.get("active"):
            continue
        w = C.get("wallets", r.get("wallet"))
        if not w or wallet_closed_at(C, w, d):
            continue
        if all(cond_result(C, c, ctx) for c in r.get("conds") or []):
            return r
    return None


def line_ctx(doc, l):
    return {"org": doc.get("org"), "acc": doc.get("acc"), "dept": l.get("dept"), "cf": l.get("cf"), "zone": l.get("zone"), "cpty": l.get("cpty")}


def apply_rules(C, doc, force=False):
    n = 0
    for l in doc.get("lines") or []:
        if l.get("wallet") and l.get("wsrc") != "rule" and not force:
            continue
        r = match_rule(C, line_ctx(doc, l), doc["date"])
        if r:
            if l.get("wallet") != r["wallet"]:
                n += 1
            l["wallet"], l["wsrc"], l["rule"] = r["wallet"], "rule", r["id"]
        elif l.get("wsrc") == "rule":
            l["wallet"], l["wsrc"], l["rule"] = None, None, None; n += 1
    return n


# ---------------- расчёт фактов ----------------
def doc_counts(C, d):
    st = C.S["settings"]
    if d.get("excluded") or d.get("deleted") or d.get("status") != "Проведён":
        return False
    if d.get("type") == "СБДС" and d.get("approved") is False:
        return False
    if st.get("startDate") and d["date"] < st["startDate"]:
        return False
    if d.get("source") == "manual" and st.get("switchDate") and d["date"] >= st["switchDate"]:
        return False
    return True


def op_legs(C, o):
    legs = []

    def mk(L, frm, to, n):
        L = L or {}
        a = C.acc(L.get("acc"))
        if not a or not is_num(L.get("sum")) or L["sum"] <= 0 or not is_num(L.get("rate")) or L["rate"] <= 0:
            return None
        return {"n": n, "acc": L["acc"], "org": a["org"], "cur": a["cur"], "sum": L["sum"], "rate": L["rate"], "usd": r2(L["sum"] / L["rate"]), "from": frm, "to": to}
    if o.get("kind") == "exchange":
        a, b = mk(o.get("leg1"), o.get("from"), o.get("to"), 1), mk(o.get("leg2"), o.get("to"), o.get("from"), 2)
        legs += [x for x in (a, b) if x]
    else:
        a = mk(o.get("leg1"), o.get("from"), o.get("to"), 1)
        if a:
            legs.append(a)
    return legs


def op_complete(C, o):
    n = len(op_legs(C, o))
    return n == 2 if o.get("kind") == "exchange" else n == 1


def op_counts(C, o):
    sd = C.S["settings"].get("startDate")
    return bool(o.get("posted") and not o.get("deleted") and not o.get("linkedDoc") and op_complete(C, o) and not (sd and o["date"] < sd))


def facts(C):
    def build():
        out = []
        d0 = C.S["settings"].get("startDate")
        if d0:
            for x in C.S["opening"]:
                a = C.acc(x["acc"])
                if a:
                    out.append({"date": d0, "acc": x["acc"], "cur": a["cur"], "wallet": x.get("wallet") or None, "sum": x["sum"], "cat": "opening"})
        for d in C.S["docs"]:
            if not doc_counts(C, d):
                continue
            if d["type"] == "ПЕР":
                for side, sg in (("from", -1), ("to", 1)):
                    S_ = d.get(side) or {}
                    a = C.acc(S_.get("acc"))
                    if a:
                        out.append({"date": d["date"], "acc": S_["acc"], "cur": a["cur"], "wallet": S_.get("wallet") or None, "sum": sg * (S_.get("sum") or 0), "cat": "transfer", "doc": d["id"]})
                continue
            sg = DOC_TYPES[d["type"]]["sign"]
            for l in d["lines"]:
                out.append({"date": d["date"], "acc": d["acc"], "cur": d["cur"], "wallet": l.get("wallet") or None, "sum": sg * (l.get("sum") or 0),
                            "cat": "in" if sg > 0 else "out", "doc": d["id"]})
        for o in C.S["ops"]:
            if not op_counts(C, o):
                continue
            for L in op_legs(C, o):
                out.append({"date": o["date"], "acc": L["acc"], "cur": L["cur"], "wallet": L["from"], "sum": -L["sum"], "cat": "internal", "op": o["id"]})
                out.append({"date": o["date"], "acc": L["acc"], "cur": L["cur"], "wallet": L["to"], "sum": L["sum"], "cat": "internal", "op": o["id"]})
        return out
    return C.cache("facts", build)


def acc_facts(C):
    def build():
        m = {}
        for f in facts(C):
            m.setdefault(f["acc"], []).append(f)
        return m
    return C.cache("accFacts", build)


def balances(C, d, flist):
    m = {}
    for f in flist:
        if f["date"] > d:
            continue
        k = (f["wallet"], f["acc"], f["cur"])
        m[k] = m.get(k, 0) + f["sum"]
    return {k: r2(v) for k, v in m.items()}


# ---------------- сверка с 1С (ТР-41…43) ----------------
def recon(C):
    def build():
        by_acc = {}
        for b in C.S["bal1c"]:
            by_acc.setdefault(b["acc"], []).append(b)
        af = acc_facts(C)
        rows = []
        for aid, lst in by_acc.items():
            lst.sort(key=lambda x: x["date"])
            fl = af.get(aid, [])
            hist = []
            for b in lst:
                w = r2(sum(f["sum"] for f in fl if f["date"] <= b["date"]))
                hist.append({"date": b["date"], "c1": b["sum"], "w": w, "diff": r2(w - b["sum"])})
            last = hist[-1]
            since = None
            for h in reversed(hist):
                if abs(h["diff"]) >= 0.005:
                    since = h["date"]
                else:
                    break
            a = C.acc(aid)
            rows.append({"acc": aid, "org": a and a["org"], "cur": a and a["cur"], **last, "since": since, "hist": hist})
        return rows
    return C.cache("recon", build)


def reconciled_days(C):
    def build():
        by_date = {}
        for r in recon(C):
            for h in r["hist"]:
                by_date.setdefault(h["date"], []).append(abs(h["diff"]) < 0.005)
        return {d for d, oks in by_date.items() if all(oks)}
    return C.cache("reconDays", build)


def bad_accs(C):
    return {r["acc"] for r in recon(C) if abs(r["diff"]) >= 0.005}


# ---------------- уведомления ----------------
def treasurers_of(C, wid):
    return [u["id"] for u in C.S["users"] if u.get("active") and has(u, "treasurer") and wid in own_wallets(C, u)]


def needs_formalizing(C):
    linked = {o.get("linkedDoc") for o in C.S["ops"] if o.get("linkedDoc") and not o.get("deleted")}
    return [d for d in C.S["docs"] if d["type"] == "ПЕР" and doc_counts(C, d) and d["from"].get("wallet") and d["to"].get("wallet")
            and d["from"]["wallet"] != d["to"]["wallet"] and d["id"] not in linked]


def notifications(C, u, d=None):
    d = d or today_iso()
    out, A = [], is_admin(u)
    for (w, aid, cur), s in C.cache(("bal", d), lambda: balances(C, d, facts(C))).items():
        if not w or s >= -0.005:
            continue
        if A or u["id"] in treasurers_of(C, w):
            out.append({"lvl": "err", "text": f"Отрицательный остаток: {nm(C.get('wallets', w))} · {nm(C.acc(aid))} · {fmt(s)} {cur_code(C, cur)}", "tr": "ТР-24", "go": "rep37"})
    af = acc_facts(C)
    for r in recon(C):
        if abs(r["diff"]) < 0.005:
            continue
        ws = {f["wallet"] for f in af.get(r["acc"], []) if f["wallet"]}
        if A or any(u["id"] in treasurers_of(C, w) for w in ws):
            out.append({"lvl": "err", "text": f"Расхождение со сверкой 1С: {nm(C.acc(r['acc']))} на {fmt_d(r['date'])} — {'+' if r['diff'] > 0 else ''}{fmt(r['diff'])} {cur_code(C, r['cur'])}", "tr": "ТР-42", "go": "recon"})
    for doc in needs_formalizing(C):
        if A or u["id"] in treasurers_of(C, doc["from"]["wallet"]) or u["id"] in treasurers_of(C, doc["to"]["wallet"]):
            out.append({"lvl": "warn", "text": f"Требует оформления: {doc['no']} от {fmt_d(doc['date'])} — {nm(C.get('wallets', doc['from']['wallet']))} → {nm(C.get('wallets', doc['to']['wallet']))}", "tr": "ТР-57", "go": "formalize"})
    no_w = sum(1 for f in facts(C) if not f["wallet"] and f.get("doc"))
    if no_w and (A or has(u, "treasurer")):
        out.append({"lvl": "warn", "text": f"Строк без кошелька: {no_w}", "tr": "ТР-23", "go": "nowallet"})
    unseen = [c for c in C.S["closedChanges"] if u["id"] not in (c.get("seen") or [])]
    if unseen and (A or has(u, "treasurer")):
        out.append({"lvl": "warn", "text": f"Изменения 1С в закрытом периоде: {len(unseen)}", "tr": "ТР-56", "go": "closedch"})
    if A:
        kinds = {}
        for e in C.S["exchangeLog"]:
            kinds.setdefault(e["kind"], []).append(e)
        for k, lst in kinds.items():
            l2 = lst[-2:]
            if len(l2) == 2 and all(e["errors"] > 0 for e in l2):
                out.append({"lvl": "err", "text": f"Два неудачных обмена подряд: {k}", "tr": "ТР-18", "go": "xlog"})
    return out


# ---------------- версии и аудит ----------------
def diff_text(before, after):
    keys = list(dict.fromkeys(list((before or {}).keys()) + list((after or {}).keys())))
    out = []
    for k in keys:
        a = json.dumps((before or {}).get(k), ensure_ascii=False)
        b = json.dumps((after or {}).get(k), ensure_ascii=False)
        if a != b:
            out.append(f"{k}: {a} → {b}")
    return "; ".join(out)


def fmt_in(n):
    return fmt(n) if is_num(n) else ""


def doc_snap(C, d):
    wn = lambda w: nm(C.get("wallets", w)) if w else "без кошелька"
    if d["type"] == "ПЕР":
        return {"дата": d["date"], "сумма": f"{fmt_in(d['from'].get('sum'))} → {fmt_in(d['to'].get('sum'))}",
                "кошелёк": f"{wn(d['from'].get('wallet'))} → {wn(d['to'].get('wallet'))}", "статус": "помечен" if d.get("deleted") else d["status"]}
    st = "исключён" if d.get("excluded") else "помечен на удаление" if d.get("deleted") else d["status"] + (", не согласован" if d["type"] == "СБДС" and d.get("approved") is False else "")
    return {"дата": d["date"], "сумма": fmt_in(r2(sum(l.get("sum") or 0 for l in d["lines"]))),
            "кошелёк": ", ".join(dict.fromkeys(wn(l.get("wallet")) for l in d["lines"])), "статус": st}


def op_snap(C, o):
    L = op_legs(C, o)
    return {"дата": o["date"], "вид": OP_KINDS[o["kind"]]["name"], "сумма": " / ".join(f"{fmt_in(l['sum'])} {cur_code(C, l['cur'])}" for l in L),
            "кошелёк": f"{nm(C.get('wallets', o.get('from')))} → {nm(C.get('wallets', o.get('to')))}",
            "статус": "помечена на удаление" if o.get("deleted") else "проведена" if o.get("posted") else "черновик"}


def add_version(C, kind, obj, before, after, source, u):
    d = diff_text(before, after)
    if not d:
        return False
    C.st.add_version(kind, obj, before, after, d, source, u["name"] if u else "Система")
    return True


# ---------------- автозакрытие периода (ТР-55) ----------------
def auto_close_period(C):
    st = C.S["settings"]
    if not st.get("autoClose") or not C.S["opening"]:
        return False
    t = today_iso()
    if int(t[8:10]) < 5:
        return False
    pe = prev_month_end(t)
    if st.get("startDate") and pe < st["startDate"]:
        return False
    if st.get("closedTo") and st["closedTo"] >= pe:
        return False
    before = st.get("closedTo")
    C.st.set_setting("closedTo", pe)
    C.st.audit(None, "Закрытие периода", "", f"{fmt_d(before) if before else '—'} → {fmt_d(pe)} (автоматически, 5-е число)", uname="Система")
    return True
