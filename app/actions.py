"""Изменения данных. Каждая функция проверяет права и правила ТЗ, пишет версии и журнал аудита.

Ошибки проверки — ApiError (HTTP 400, список сообщений), нет прав — Forbidden (HTTP 403).
"""
import hashlib
import hmac
import math
import re
import secrets

from .logic import (DOC_TYPES, MANUAL_OPS, OP_KINDS, ROLES, RULE_FIELDS, RULE_OPS, add_version, apply_rules, balances, can_edit_wallet,
                    can_enter, cur_code, descendants, doc_snap, facts, has, in_closed, is_active_at, is_admin, line_visible, manual_allowed,
                    match_rule, needs_formalizing, nm, op_complete, op_legs, op_snap, own_wallets, period_error, rate_at, to_usd, wallet_closed_at,
                    diff_text, is_usd, visible_wallets)
from .util import fmt, fmt_d, is_num, now_iso, prev_month_end, r2, today_iso, uid, valid_iso


class ApiError(Exception):
    def __init__(self, errors, status=400):
        super().__init__("; ".join(errors) if isinstance(errors, list) else str(errors))
        self.errors = errors if isinstance(errors, list) else [str(errors)]
        self.status = status


class ApiErrorCommit(ApiError):
    """Ошибка для пользователя, при которой изменения транзакции (запись в журнал) всё равно сохраняются."""
    commit = True


class Forbidden(ApiError):
    def __init__(self, msg="Недостаточно прав"):
        super().__init__([msg], 403)


def s(v, maxlen=500):
    return ("" if v is None else str(v).strip())[:maxlen]


def num(v):
    if isinstance(v, bool) or v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def ref_or_empty(C, coll, v):
    v = s(v)
    if not v:
        return ""
    if v.startswith("?"):
        return v
    return v if C.get(coll, v) else None


def need_admin(u):
    if not is_admin(u):
        raise Forbidden("Действие доступно только администратору")


# ================= пароли =================
PW_ITER = 240_000


def make_pw(p):
    salt = secrets.token_hex(16)
    return {"salt": salt, "hash": "pbkdf2$" + hashlib.pbkdf2_hmac("sha256", p.encode(), salt.encode(), PW_ITER).hex()}


def check_pw(u, p):
    pw = (u or {}).get("pw")
    if not pw or not pw.get("hash"):
        return False
    h = "pbkdf2$" + hashlib.pbkdf2_hmac("sha256", (p or "").encode(), pw["salt"].encode(), PW_ITER).hex()
    return hmac.compare_digest(h, pw["hash"])


# ================= ручные документы (ТР-68, ТР-69) =================
SIDE_KEYS = ("org", "acc", "sum", "wallet", "wsrc", "rule", "dept", "cf", "zone", "cpty", "contract", "purpose")


def ed_editable(C, u, orig):
    if orig["source"] != "manual" or orig.get("excluded") or not can_enter(u):
        return False
    if period_error(C, orig["date"]) or not manual_allowed(C, orig["date"]):
        return False
    if not is_admin(u):
        ws = [orig["from"].get("wallet"), orig["to"].get("wallet")] if orig["type"] == "ПЕР" else [l.get("wallet") for l in orig["lines"]]
        if not any(w and can_edit_wallet(C, u, w) for w in ws) and orig.get("author") != u["id"]:
            return False
        if orig["type"] != "ПЕР" and any(l.get("wallet") and not can_edit_wallet(C, u, l["wallet"]) for l in orig["lines"]):
            return False
    return True


def _clean_side(C, src, errors, title):
    S_ = {}
    for k in SIDE_KEYS:
        S_[k] = src.get(k)
    S_["org"], S_["acc"] = s(S_["org"]), s(S_["acc"])
    S_["sum"] = num(S_["sum"])
    S_["wallet"] = s(S_["wallet"]) or None
    S_["wsrc"] = S_["wsrc"] if S_["wsrc"] in ("rule", "manual") else (None if not S_["wallet"] else "manual")
    S_["rule"] = s(S_["rule"]) or None
    for k, coll in (("dept", "depts"), ("cf", "cfTypes"), ("zone", "zones")):
        v = ref_or_empty(C, coll, S_[k])
        if v is None:
            errors.append(f"{title}: неизвестное значение справочника"); v = ""
        S_[k] = v
    for k in ("cpty", "contract", "purpose"):
        S_[k] = s(S_[k])
    return S_


def validate_manual(C, u, d):
    e = []
    pe = period_error(C, d["date"])
    if pe:
        e.append(pe)
    if not manual_allowed(C, d["date"]):
        e.append(f"С {fmt_d(C.S['settings']['switchDate'])} ручной ввод отключён (ТР-72).")
    if d["type"] == "ПЕР":
        for side, t in (("from", "Отправитель"), ("to", "Получатель")):
            S_ = d[side]
            if not S_["org"] or not C.get("orgs", S_["org"]):
                e.append(f"{t}: не выбрана организация")
            a = C.acc(S_["acc"])
            if not a:
                e.append(f"{t}: не выбран счёт или касса")
            elif a["org"] != S_["org"]:
                e.append(f"{t}: счёт не принадлежит организации")
            if not (S_["sum"] and S_["sum"] > 0):
                e.append(f"{t}: сумма должна быть больше нуля")
            if a and not rate_at(C, a["cur"], d["date"]):
                e.append(f"{t}: нет курса {cur_code(C, a['cur'])} на {fmt_d(d['date'])}")
            if S_["wallet"]:
                if not C.get("wallets", S_["wallet"]):
                    e.append(f"{t}: кошелёк недоступен")
                elif wallet_closed_at(C, S_["wallet"], d["date"]):
                    e.append(f"{t}: кошелёк закрыт (ТР-25)")
        if d["from"]["acc"] and d["from"]["acc"] == d["to"]["acc"]:
            e.append("Счёт отправителя и получателя совпадают")
        fa, ta = C.acc(d["from"]["acc"]), C.acc(d["to"]["acc"])
        if fa and ta and d["op"] == "Конвертация валюты" and fa["cur"] == ta["cur"]:
            e.append("Конвертация: валюты счетов должны различаться")
        if fa and ta and d["op"] != "Конвертация валюты" and fa["cur"] != ta["cur"]:
            e.append("Переброска: валюты счетов различаются — выберите «Конвертация валюты»")
        if not is_admin(u) and not any(w and can_edit_wallet(C, u, w) for w in (d["from"]["wallet"], d["to"]["wallet"])):
            e.append("Казначей вводит документы по своим кошелькам: хотя бы одна сторона должна быть вашим кошельком")
    else:
        if not d["org"] or not C.get("orgs", d["org"]):
            e.append("Не выбрана организация")
        a = C.acc(d["acc"])
        cash = DOC_TYPES[d["type"]]["cash"]
        if not a:
            e.append("Не выбрана касса" if cash else "Не выбран банковский счёт")
        else:
            if a["org"] != d["org"]:
                e.append("Счёт не принадлежит организации")
            if (a["kind"] == "Касса") != cash:
                e.append("Поступление в кассу — только по кассе, на счёт — только по банковскому счёту")
            if not rate_at(C, a["cur"], d["date"]):
                e.append(f"Нет курса {cur_code(C, a['cur'])} на {fmt_d(d['date'])} — загрузите курсы из 1С")
        if not d["lines"]:
            e.append("Нет строк расшифровки")
        for i, l in enumerate(d["lines"]):
            if not (l["sum"] and l["sum"] > 0):
                e.append(f"Строка {i+1}: сумма должна быть больше нуля")
            if l["wallet"]:
                if not C.get("wallets", l["wallet"]):
                    e.append(f"Строка {i+1}: неизвестный кошелёк")
                elif wallet_closed_at(C, l["wallet"], d["date"]):
                    e.append(f"Строка {i+1}: кошелёк закрыт (ТР-25)")
                elif not can_edit_wallet(C, u, l["wallet"]):
                    e.append(f"Строка {i+1}: кошелёк «{nm(C.get('wallets', l['wallet']))}» не ваш")
    if d["op"] not in MANUAL_OPS[d["type"]]:
        e.append("Неизвестная хозяйственная операция")
    return e


def save_manual_doc(C, u, p):
    if not can_enter(u):
        raise Forbidden()
    src = p.get("doc") or {}
    typ = src.get("type")
    if typ not in ("ПБДС", "ПКО", "ПЕР"):
        raise ApiError(["Неизвестный тип документа"])
    orig = C.get("docs", src.get("id")) if src.get("id") else None
    if orig:
        if orig["type"] != typ:
            raise ApiError(["Тип документа менять нельзя"])
        if not ed_editable(C, u, orig):
            raise Forbidden("Документ нельзя изменить: закрытый период, чужие кошельки или ручной ввод отключён")
    errors = []
    d = {"id": orig["id"] if orig else uid("D"), "no": orig["no"] if orig else "", "source": "manual", "guid": "", "type": typ,
         "op": s(src.get("op")), "no1c": s(src.get("no1c"), 60), "date1c": src.get("date1c") if valid_iso(src.get("date1c")) else "",
         "date": src.get("date") if valid_iso(src.get("date")) else "", "status": "Проведён", "statusRaw": "", "approved": True,
         "bankDone": False, "bankDate": "", "excluded": False, "deleted": orig["deleted"] if orig else False,
         "author": orig["author"] if orig else u["id"], "created": orig["created"] if orig else now_iso(), "loaded": "", "fileName": "", "fileSig": "",
         "lines": [], "versions": orig["versions"] if orig else []}
    if typ == "ПЕР":
        d["from"] = _clean_side(C, src.get("from") or {}, errors, "Отправитель")
        d["to"] = _clean_side(C, src.get("to") or {}, errors, "Получатель")
        d["org"], d["acc"] = d["from"]["org"], d["from"]["acc"]
        fa = C.acc(d["acc"]); d["cur"] = fa["cur"] if fa else ""
    else:
        d["org"], d["acc"] = s(src.get("org")), s(src.get("acc"))
        a = C.acc(d["acc"]); d["cur"] = a["cur"] if a else ""
        for l in (src.get("lines") or [])[:500]:
            L = _clean_side(C, l, errors, "Строка")
            d["lines"].append({k: L[k] for k in ("sum", "wallet", "wsrc", "rule", "dept", "cf", "zone", "cpty", "contract", "purpose")} | {"usd": None, "fileWallet": None})
    errors += validate_manual(C, u, d)
    link_op = None
    link = p.get("link") or {}
    if typ == "ПЕР" and link.get("kind") and d["from"]["wallet"] and d["to"]["wallet"] and d["from"]["wallet"] != d["to"]["wallet"] \
            and not any(o.get("linkedDoc") == d["id"] and not o.get("deleted") for o in C.S["ops"]):
        if link["kind"] not in ("loan", "repay", "funding", "dividends"):
            errors.append("Неизвестный вид внутренней операции")
        else:
            a = C.acc(d["to"]["acc"])
            link_op = {"id": uid("O"), "no": "", "date": d["date"], "kind": link["kind"], "from": d["from"]["wallet"], "to": d["to"]["wallet"],
                       "contract": s(link.get("contract")) if link["kind"] in ("loan", "repay") else "", "comment": "",
                       "leg1": {"org": d["to"]["org"], "acc": d["to"]["acc"], "sum": d["to"]["sum"], "rate": rate_at(C, a["cur"], d["date"]) if a else None},
                       "leg2": {"org": "", "acc": "", "sum": None, "rate": None}, "sameCur": True, "author": u["id"], "created": now_iso(),
                       "posted": True, "deleted": False, "linkedDoc": d["id"], "versions": []}
            errors += ["Внутренняя операция: " + x for x in validate_op(C, u, link_op, True)]
    if errors:
        raise ApiError(errors)
    if typ == "ПЕР":
        for side in ("from", "to"):
            a = C.acc(d[side]["acc"])
            d[side]["rate"] = rate_at(C, a["cur"], d["date"])
            d[side]["usd"] = to_usd(C, d[side]["sum"], a["cur"], d["date"])
    else:
        for l in d["lines"]:
            l["usd"] = to_usd(C, l["sum"], d["cur"], d["date"])
    if not orig:
        d["no"] = C.st.next_no({"ПБДС": "ПБ", "ПКО": "ПК", "ПЕР": "ПР"}[typ])
        C.st.add("docs", d)
        C.st.audit(u, "Создание ручного документа", f"{typ} {d['no']}", diff_text({}, doc_snap(C, d)))
    else:
        before, after = doc_snap(C, orig), doc_snap(C, d)
        idx = C.S["docs"].index(orig)
        C.S["docs"][idx] = d
        C.st._idx.pop("docs", None)
        C.st.save("docs", d)
        add_version(C, "doc", d, before, after, "ручная правка", u)
        C.st.audit(u, "Изменение ручного документа", f"{typ} {d['no']}", diff_text(before, after) or "без изменений ключевых полей")
    if link_op:
        link_op["no"] = C.st.next_no("ВО")
        link_op["comment"] = f"Оформляет {d['op'].lower()} {d['no']}"
        C.st.add("ops", link_op)
        C.st.audit(u, "Создание внутренней операции", f"{OP_KINDS[link_op['kind']]['name']} {link_op['no']}", f"привязана к {d['no']}; " + diff_text({}, op_snap(C, link_op)))
    return {"id": d["id"], "no": d["no"]}


def toggle_doc_delete(C, u, doc_id):
    d = C.get("docs", doc_id)
    if not d:
        raise ApiError(["Документ не найден"], 404)
    if d["source"] != "manual":
        raise ApiError(["Документы из файла нельзя пометить на удаление — их исключает повторная загрузка (ТР-74)."])
    if not ed_editable(C, u, d):
        raise Forbidden(period_error(C, d["date"]) or "Недостаточно прав")
    before = doc_snap(C, d)
    d["deleted"] = not d.get("deleted")
    C.st.save("docs", d)
    add_version(C, "doc", d, before, doc_snap(C, d), "пометка на удаление" if d["deleted"] else "снятие пометки", u)
    C.st.audit(u, "Пометка на удаление" if d["deleted"] else "Снятие пометки удаления", f"{d['type']} {d['no']}", "")


def assign_wallets(C, u, doc_id, changes):
    """Назначение кошелька в строках документа (ТР-23, ТР-54) — из «Без кошелька» и из карточки документа."""
    d = C.get("docs", doc_id)
    if not d:
        raise ApiError(["Документ не найден"], 404)
    if not can_enter(u):
        raise Forbidden()
    if d.get("excluded"):
        raise ApiError(["Документ исключён из расчёта"])
    pe = period_error(C, d["date"])
    if pe:
        raise ApiError([pe])
    before = doc_snap(C, d)
    log = []
    for ch in changes or []:
        where, wid = str(ch.get("where")), s(ch.get("wallet")) or None
        if where in ("from", "to"):
            if d["type"] != "ПЕР":
                raise ApiError(["Неверная строка"])
            tgt = d[where]
        else:
            try:
                tgt = d["lines"][int(where)]
            except (ValueError, IndexError):
                raise ApiError(["Неверная строка"])
        cur = tgt.get("wallet")
        if not line_visible(C, u, cur) or (cur and not can_edit_wallet(C, u, cur)):
            raise Forbidden("Строка относится к чужому кошельку")
        if wid:
            if not C.get("wallets", wid):
                raise ApiError(["Неизвестный кошелёк"])
            if not can_edit_wallet(C, u, wid):
                raise Forbidden("Кошелёк не ваш")
            if wallet_closed_at(C, wid, d["date"]):
                raise ApiError(["Кошелёк закрыт (ТР-25)"])
        if cur != wid:
            log.append(f"{'строка ' + str(int(where)+1) if where.isdigit() else where}: {nm(C.get('wallets', cur)) if cur else 'без кошелька'} → {nm(C.get('wallets', wid)) if wid else 'без кошелька'}")
            tgt["wallet"], tgt["wsrc"], tgt["rule"] = wid, ("manual" if wid else None), None
    if log:
        C.st.save("docs", d)
        add_version(C, "doc", d, before, doc_snap(C, d), "назначение кошелька", u)
        C.st.audit(u, "Назначение кошелька", f"{d['type']} {d.get('no1c') or d['no']}", "; ".join(log))
    return len(log)


def apply_rules_to_empty(C, u):
    need_admin(u)
    n = 0
    for d in C.S["docs"]:
        if d.get("excluded") or period_error(C, d["date"]):
            continue
        changed = 0
        before = doc_snap(C, d)
        if d["type"] == "ПЕР":
            for side in ("from", "to"):
                S_ = d[side]
                if S_.get("wallet"):
                    continue
                r = match_rule(C, {"org": S_.get("org"), "acc": S_.get("acc"), "dept": S_.get("dept"), "cf": S_.get("cf"), "zone": S_.get("zone"), "cpty": S_.get("cpty")}, d["date"])
                if r:
                    S_["wallet"], S_["wsrc"], S_["rule"] = r["wallet"], "rule", r["id"]; changed += 1
        else:
            changed = apply_rules(C, d)
        if changed:
            n += changed
            C.st.save("docs", d)
            add_version(C, "doc", d, before, doc_snap(C, d), "правила автозаполнения", u)
    C.st.audit(u, "Применение правил к строкам без кошелька", "", f"заполнено строк: {n}")
    return n


# ================= внутренние операции (раздел 6) =================
def validate_op(C, u, o, post):
    e = []
    K = OP_KINDS[o["kind"]]
    pe = period_error(C, o["date"])
    if pe:
        e.append(pe)
    for key, label in (("from", K["from"]), ("to", K["to"])):
        if not o.get(key) or not C.get("wallets", o[key]):
            e.append(f"Не выбран {label.lower()}")
    if o.get("from") and o["from"] == o.get("to"):
        e.append("Отправитель и получатель совпадают")
    if o.get("from") and wallet_closed_at(C, o["from"], o["date"]) and o["kind"] != "closeDiv":
        e.append(f"Кошелёк «{nm(C.get('wallets', o['from']))}» закрыт (ТР-25)")
    if o.get("to") and wallet_closed_at(C, o["to"], o["date"]):
        e.append(f"Кошелёк «{nm(C.get('wallets', o['to']))}» закрыт (ТР-25)")
    fw, tw = C.get("wallets", o.get("from")), C.get("wallets", o.get("to"))
    if o["kind"] == "funding" and fw and not fw.get("head"):
        e.append("Безвозмездное финансирование выдаёт только головной кошелёк")
    if o["kind"] == "dividends" and tw and not tw.get("head"):
        e.append("Дивиденды получает только головной кошелёк")
    if o["kind"] in ("loan", "repay"):
        c = C.get("contracts", o.get("contract"))
        if not c:
            e.append("Не выбран договор займа")
        else:
            lender, borrower = (o["from"], o["to"]) if o["kind"] == "loan" else (o["to"], o["from"])
            if c["lender"] != lender or c["borrower"] != borrower:
                e.append("Договор займа не соответствует кошелькам операции")
    if not is_admin(u) and not any(x and can_edit_wallet(C, u, x) for x in (o.get("from"), o.get("to"))):
        e.append("Казначей вводит операции по своим кошелькам: одна из сторон должна быть вашим кошельком")

    def chk(G, t):
        if not G.get("acc") or not C.acc(G["acc"]):
            e.append(f"{t}: не выбран счёт или касса")
        if not (is_num(G.get("sum")) and G["sum"] > 0):
            e.append(f"{t}: сумма должна быть больше нуля")
        if not (is_num(G.get("rate")) and G["rate"] > 0):
            e.append(f"{t}: не указан курс к USD")
    if post or o["kind"] != "exchange":
        chk(o["leg1"], "Нога 1" if o["kind"] == "exchange" else "Счёт")
    if o["kind"] == "exchange" and post:
        chk(o["leg2"], "Нога 2 (документ не проводится без второй ноги)")
    if o["kind"] == "exchange":
        a, b = C.acc(o["leg1"].get("acc")), C.acc(o["leg2"].get("acc"))
        if a and b and a["id"] == b["id"]:
            e.append("Ноги обмена должны быть на разных счетах")
        if a and b and o.get("sameCur") and a["cur"] != b["cur"]:
            e.append("Обмен в одной валюте: валюта счёта Б должна совпадать с валютой счёта А (ТР-77)")
    return e


def _clean_leg(C, L):
    L = L or {}
    a = C.acc(s(L.get("acc")))
    rate = num(L.get("rate"))
    if a and is_usd(C, a["cur"]):
        rate = 1.0
    return {"org": a["org"] if a else "", "acc": a["id"] if a else "", "sum": num(L.get("sum")), "rate": rate}


def op_editable(C, u, orig):
    if not can_enter(u) or period_error(C, orig["date"]):
        return False
    return is_admin(u) or can_edit_wallet(C, u, orig.get("from")) or can_edit_wallet(C, u, orig.get("to"))


def save_op(C, u, p):
    if not can_enter(u):
        raise Forbidden()
    src = p.get("op") or {}
    post = bool(p.get("post"))
    kind = src.get("kind")
    if kind not in OP_KINDS:
        raise ApiError(["Неизвестный вид операции"])
    orig = C.get("ops", src.get("id")) if src.get("id") else None
    if orig and not op_editable(C, u, orig):
        raise Forbidden("Операцию нельзя изменить: закрытый период или чужие кошельки")
    if orig and orig.get("deleted"):
        raise ApiError(["Операция помечена на удаление"])
    o = {"id": orig["id"] if orig else uid("O"), "no": orig["no"] if orig else "", "date": src.get("date") if valid_iso(src.get("date")) else "",
         "kind": kind, "from": s(src.get("from")) or None, "to": s(src.get("to")) or None, "contract": s(src.get("contract")) if kind in ("loan", "repay") else "",
         "comment": s(src.get("comment")), "leg1": _clean_leg(C, src.get("leg1")),
         "leg2": _clean_leg(C, src.get("leg2")) if kind == "exchange" else {"org": "", "acc": "", "sum": None, "rate": None},
         "sameCur": bool(src.get("sameCur", True)), "author": orig["author"] if orig else u["id"], "created": orig["created"] if orig else now_iso(),
         "posted": False, "deleted": False, "linkedDoc": orig.get("linkedDoc") if orig else None, "versions": orig["versions"] if orig else []}
    errors = []
    ld = s(src.get("linkedDoc")) if not orig else None
    if ld:
        d = C.get("docs", ld)
        if not d or d not in needs_formalizing(C):
            errors.append("Платёж не требует оформления или уже оформлен")
        elif d["from"]["wallet"] != o["from"] or d["to"]["wallet"] != o["to"] or kind not in ("loan", "repay", "funding", "dividends"):
            errors.append("Операция должна повторять кошельки платежа")
        else:
            o["linkedDoc"] = ld
    errors += validate_op(C, u, o, post)
    if errors:
        raise ApiError(errors)
    o["posted"] = post or kind != "exchange"
    if not orig:
        o["no"] = C.st.next_no("ВО")
        C.st.add("ops", o)
        C.st.audit(u, "Создание внутренней операции", f"{OP_KINDS[kind]['name']} {o['no']}", diff_text({}, op_snap(C, o)))
    else:
        before, after = op_snap(C, orig), op_snap(C, o)
        C.S["ops"][C.S["ops"].index(orig)] = o
        C.st._idx.pop("ops", None)
        C.st.save("ops", o)
        add_version(C, "op", o, before, after, "правка", u)
        C.st.audit(u, "Изменение внутренней операции", f"{OP_KINDS[kind]['name']} {o['no']}", diff_text(before, after) or "без изменений ключевых полей")
    return {"id": o["id"], "no": o["no"]}


def toggle_op_delete(C, u, op_id):
    o = C.get("ops", op_id)
    if not o:
        raise ApiError(["Операция не найдена"], 404)
    if not op_editable(C, u, o):
        raise Forbidden(period_error(C, o["date"]) or "Недостаточно прав")
    before = op_snap(C, o)
    o["deleted"] = not o.get("deleted")
    C.st.save("ops", o)
    add_version(C, "op", o, before, op_snap(C, o), "пометка на удаление" if o["deleted"] else "снятие пометки", u)
    C.st.audit(u, "Пометка на удаление" if o["deleted"] else "Снятие пометки удаления", f"{OP_KINDS[o['kind']]['name']} {o['no']}", "")


def create_contract(C, u, p):
    if not can_enter(u):
        raise Forbidden()
    name, L, B = s(p.get("name"), 200), s(p.get("lender")), s(p.get("borrower"))
    if not name or not C.get("wallets", L) or not C.get("wallets", B) or L == B:
        raise ApiError(["Заполните наименование и два разных кошелька"])
    if not is_admin(u) and not (can_edit_wallet(C, u, L) or can_edit_wallet(C, u, B)):
        raise Forbidden("Одна из сторон договора должна быть вашим кошельком")
    c = {"id": uid("C"), "name": name, "lender": L, "borrower": B, "created": now_iso()}
    C.st.add("contracts", c)
    C.st.audit(u, "Создание договора займа", name, f"{nm(C.get('wallets', L))} → {nm(C.get('wallets', B))}")
    return {"id": c["id"]}


# ================= входящие остатки (ТР-21, ТР-22) =================
def save_opening(C, u, acc_id, rows):
    need_admin(u)
    d0 = C.S["settings"].get("startDate")
    if not d0:
        raise ApiError(["Сначала задайте дату начала учёта по кошелькам (ТР-20)."])
    if in_closed(C, d0):
        raise ApiError(["Период закрыт"])
    a = C.acc(acc_id)
    if not a:
        raise ApiError(["Счёт не найден"], 404)
    clean, seen = [], set()
    for r in rows or []:
        w, sm = s(r.get("wallet")), num(r.get("sum"))
        if not w and sm is None:
            continue
        if not C.get("wallets", w) or sm is None:
            raise ApiError(["В каждой строке нужны кошелёк и сумма"])
        if w in seen:
            raise ApiError(["Кошелёк указан дважды"])
        seen.add(w)
        clean.append({"id": s(r.get("id")) or uid("OB"), "acc": acc_id, "wallet": w, "sum": r2(sm)})
    before = "; ".join(f"{nm(C.get('wallets', x['wallet']))}: {fmt(x['sum'])}" for x in C.S["opening"] if x["acc"] == acc_id)
    for x in [x for x in C.S["opening"] if x["acc"] == acc_id]:
        C.st.delete("opening", x)
    for x in clean:
        C.st.add("opening", x)
    C.st.audit(u, "Ввод входящих остатков", a["name"], f"было: {before or '—'}; стало: " + ("; ".join(f"{nm(C.get('wallets', x['wallet']))}: {fmt(x['sum'])}" for x in clean) or "—"))


# ================= кошельки =================
def save_wallet(C, u, p):
    need_admin(u)
    exist = C.get("wallets", s(p.get("id"))) if p.get("id") else None
    w = {"id": exist["id"] if exist else uid("W"), "name": s(p.get("name"), 200), "parent": s(p.get("parent")) or None,
         "head": bool(p.get("head")), "hidden": bool(p.get("hidden")),
         "access": [x for x in (p.get("access") or []) if C.get("users", x)], "closed": bool(p.get("closed")),
         "closedFrom": p.get("closedFrom") if valid_iso(p.get("closedFrom")) else "", "created": exist["created"] if exist else now_iso()}
    if not w["name"]:
        raise ApiError(["Укажите наименование"])
    if w["parent"] and not C.get("wallets", w["parent"]):
        raise ApiError(["Родитель не найден"])
    if exist and w["parent"] and w["parent"] in descendants(C, w["id"]):
        raise ApiError(["Кошелёк не может быть подчинён самому себе или своему потомку"])
    depth, pw = 0, C.get("wallets", w["parent"])
    while pw and depth < 10:
        depth += 1; pw = C.get("wallets", pw.get("parent"))
    height = 0
    if exist:
        for wid in descendants(C, w["id"]):
            d, x = 0, C.get("wallets", wid)
            while x and x["id"] != w["id"]:
                d += 1; x = C.get("wallets", x.get("parent"))
            height = max(height, d)
    if depth + height > 3:
        raise ApiError(["Иерархия кошельков — не более 4 уровней"])
    if w["closed"] and not w["closedFrom"]:
        raise ApiError(["Укажите дату закрытия"])
    if not w["closed"]:
        w["closedFrom"] = ""
    snap = lambda x: {"name": x["name"], "parent": nm(C.get("wallets", x.get("parent"))), "head": x["head"], "hidden": x["hidden"],
                      "access": [nm(C.get("users", i)) for i in x.get("access") or []], "closed": x["closed"], "closedFrom": x["closedFrom"]}
    if not exist:
        C.st.add("wallets", w)
        C.st.audit(u, "Создание кошелька", w["name"], diff_text({}, snap(w)))
    else:
        before = snap(exist)
        exist.update(w)
        C.st.save("wallets", exist)
        C.st.audit(u, "Изменение кошелька", w["name"], diff_text(before, snap(exist)))
    return {"id": w["id"]}


def close_transfer(C, u, wid, target, closed_from):
    """Закрытие кошелька: остаток обнуляется операциями «Дивиденды односторонние» (ТР-25)."""
    need_admin(u)
    w, t = C.get("wallets", wid), C.get("wallets", target)
    if not w or not t or w["id"] == t["id"]:
        raise ApiError(["Выберите кошелёк, куда перенести остаток"])
    if not valid_iso(closed_from):
        raise ApiError(["Укажите дату закрытия"])
    pe = period_error(C, closed_from)
    if pe:
        raise ApiError([pe])
    if wallet_closed_at(C, t, closed_from):
        raise ApiError(["Кошелёк закрыт (ТР-25)"])
    w["closed"], w["closedFrom"] = True, closed_from
    C.st.save("wallets", w)
    bal = [(k, v) for k, v in balances(C, closed_from, [f for f in facts(C) if f["wallet"] == wid]).items() if abs(v) >= 0.005]
    n = 0
    for (_w, aid, cur), sm in bal:
        a = C.acc(aid)
        rate = rate_at(C, cur, closed_from) or 1.0
        neg = sm < 0
        o = {"id": uid("O"), "no": C.st.next_no("ВО"), "date": closed_from, "kind": "closeDiv", "from": t["id"] if neg else wid, "to": wid if neg else t["id"],
             "contract": "", "comment": (f"Покрытие минуса при закрытии «{w['name']}»" if neg else f"Перенос остатка при закрытии «{w['name']}»"),
             "leg1": {"org": a["org"], "acc": aid, "sum": abs(sm), "rate": rate}, "leg2": {"org": "", "acc": "", "sum": None, "rate": None}, "sameCur": True,
             "author": u["id"], "created": now_iso(), "posted": True, "deleted": False, "linkedDoc": None, "versions": []}
        C.st.add("ops", o)
        C.st.audit(u, "Создание внутренней операции", f"{OP_KINDS['closeDiv']['name']} {o['no']}", diff_text({}, op_snap(C, o)))
        n += 1
    C.st.audit(u, "Закрытие кошелька", w["name"], f"с {fmt_d(closed_from)}; перенесено в «{t['name']}» операций: {n}")
    return {"created": n}


# ================= правила автозаполнения (ТР-73) =================
def cond_text(C, c):
    f = c.get("field")
    lists = {"org": "orgs", "dept": "depts", "cf": "cfTypes", "zone": "zones"}
    if f == "cpty":
        vals = "; ".join(c.get("values") or [])
    else:
        vals = ", ".join(nm(C.get(lists[f], v) if f in lists else C.acc(v)) for v in c.get("values") or [])
    return f"{RULE_FIELDS.get(f, '?')} {RULE_OPS.get(c.get('op'), '?').lower()} {vals or '—'}"


def save_rule(C, u, p):
    need_admin(u)
    ex = C.get("rules", s(p.get("id"))) if p.get("id") else None
    conds = []
    for c in p.get("conds") or []:
        f, op = c.get("field"), c.get("op")
        if f not in RULE_FIELDS or op not in RULE_OPS or (op == "group" and f != "dept"):
            raise ApiError(["Неверное условие"])
        vals = [s(v, 200) for v in c.get("values") or [] if s(v)]
        if not vals:
            raise ApiError(["В каждом условии нужно выбрать значение"])
        conds.append({"field": f, "op": op, "values": vals})
    r = {"id": ex["id"] if ex else uid("R"), "name": s(p.get("name"), 200), "conds": conds, "wallet": s(p.get("wallet")), "active": bool(p.get("active", True))}
    if not r["name"]:
        raise ApiError(["Укажите описание"])
    if not C.get("wallets", r["wallet"]):
        raise ApiError(["Выберите целевой кошелёк"])
    snap = lambda x: {"описание": x["name"], "условия": [cond_text(C, c) for c in x["conds"]], "кошелёк": nm(C.get("wallets", x["wallet"])), "вкл": x["active"]}
    if ex:
        before = snap(ex); ex.update(r); C.st.save("rules", ex)
        C.st.audit(u, "Изменение правила", r["name"], diff_text(before, snap(ex)))
    else:
        C.st.add("rules", r)
        C.st.audit(u, "Создание правила", r["name"], "; ".join(cond_text(C, c) for c in conds) + " → " + nm(C.get("wallets", r["wallet"])))
    return {"id": r["id"]}


def toggle_rule(C, u, rid, on):
    need_admin(u)
    r = C.get("rules", rid)
    if not r:
        raise ApiError(["Правило не найдено"], 404)
    r["active"] = bool(on); C.st.save("rules", r)
    C.st.audit(u, "Изменение правила", r["name"], "включено" if on else "выключено")


def reorder_rules(C, u, ids):
    need_admin(u)
    cur = C.S["rules"]
    if sorted(ids) != sorted(r["id"] for r in cur):
        raise ApiError(["Список правил изменился — обновите страницу"])
    before = [r["name"] for r in cur]
    C.S["rules"] = [C.get("rules", i) for i in ids]
    C.st._idx.pop("rules", None)
    C.st.save_rules_order()
    C.st.audit(u, "Изменение порядка правил", "", " → ".join(r["name"] for r in C.S["rules"]) if before != [r["name"] for r in C.S["rules"]] else "")


# ================= пользователи (раздел 8) =================
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def user_snap(C, x):
    return {"ФИО": x["name"], "логин": x["login"], "email": x.get("email") or "", "роли": [ROLES.get(r, r) for r in x["roles"]],
            "кошельки": [nm(C.get("wallets", w)) for w in x.get("wallets") or []], "активен": x["active"]}


def save_user(C, u, p):
    need_admin(u)
    ex = C.get("users", s(p.get("id"))) if p.get("id") else None
    nu = {"id": ex["id"] if ex else uid("U"), "name": s(p.get("name"), 200), "login": s(p.get("login"), 100), "email": s(p.get("email"), 200),
          "roles": [r for r in p.get("roles") or [] if r in ROLES], "wallets": [w for w in p.get("wallets") or [] if C.get("wallets", w)],
          "active": bool(p.get("active", True)), "lang": ex.get("lang") if ex else "", "pw": ex.get("pw") if ex else None}
    pw = p.get("password") or ""
    if not nu["name"] or not nu["login"]:
        raise ApiError(["Укажите ФИО и логин"])
    if any(x["id"] != nu["id"] and x["login"].lower() == nu["login"].lower() for x in C.S["users"]):
        raise ApiError(["Такой логин уже есть"])
    if not nu["roles"]:
        raise ApiError(["Назначьте хотя бы одну роль"])
    if nu["email"] and not EMAIL_RE.match(nu["email"]):
        raise ApiError(["Неверный e-mail"])
    if not nu["pw"] and not pw:
        raise ApiError(["Задайте пароль"])
    if pw and len(pw) < 8:
        raise ApiError(["Пароль — не короче 8 символов"])
    others = [x for x in C.S["users"] if x["id"] != nu["id"] and x.get("active") and is_admin(x)]
    if not others and not (nu["active"] and "admin" in nu["roles"]):
        raise ApiError(["Должен остаться хотя бы один активный администратор"])
    if pw:
        nu["pw"] = make_pw(pw)
    if ex:
        before = user_snap(C, ex)
        ex.update(nu); C.st.save("users", ex)
        if pw:
            C.st.audit(u, "Смена пароля пользователя", ex["name"], "пароль задан администратором")
            C.st.conn.execute("DELETE FROM sessions WHERE user_id=? ", (ex["id"],)) if ex["id"] != u["id"] else None
        if not ex["active"]:
            C.st.conn.execute("DELETE FROM sessions WHERE user_id=?", (ex["id"],))
        C.st.audit(u, "Изменение пользователя", ex["name"], diff_text(before, user_snap(C, ex)))
    else:
        C.st.add("users", nu)
        C.st.audit(u, "Создание пользователя", nu["name"], diff_text({}, user_snap(C, nu)))
    return {"id": nu["id"]}


def change_password(C, u, old, new):
    if not check_pw(u, old):
        C.st.audit(u, "Неудачная смена пароля", u["name"], "")
        raise ApiErrorCommit(["Текущий пароль неверный"])
    if not new or len(new) < 8:
        raise ApiError(["Новый пароль — не короче 8 символов"])
    u["pw"] = make_pw(new); C.st.save("users", u)
    C.st.audit(u, "Смена пароля пользователя", u["name"], "сам пользователь")


def set_lang(C, u, lang):
    if lang not in ("ru", "en"):
        raise ApiError(["Неизвестный язык"])
    u["lang"] = lang; C.st.save("users", u)
    C.st.audit(u, "Смена языка интерфейса", u["name"], lang.upper())


# ================= период и настройки =================
SETTING_LABELS = {"startDate": "Дата начала учёта", "closedTo": "Закрытие периода", "switchDate": "Дата перехода на автообмен",
                  "autoClose": "Автозакрытие периода", "excludedOps": "Изменение списка исключаемых операций"}


def set_setting(C, u, key, value):
    need_admin(u)
    if key not in SETTING_LABELS:
        raise ApiError(["Неизвестная настройка"])
    if key in ("startDate", "closedTo", "switchDate"):
        value = value if valid_iso(value) else ""
    elif key == "autoClose":
        value = bool(value)
    elif key == "excludedOps":
        value = [s(x, 200) for x in (value or []) if s(x)]
    before = C.S["settings"].get(key)
    if before == value:
        return
    C.st.set_setting(key, value)
    show = lambda v: (", ".join(v) if isinstance(v, list) else ("вкл" if v is True else "выкл" if v is False else (fmt_d(v) if v else "—")))
    C.st.audit(u, SETTING_LABELS[key], "", f"{show(before)} → {show(value)}")


def close_month(C, u):
    need_admin(u)
    end = prev_month_end(today_iso())
    ct = C.S["settings"].get("closedTo")
    if ct and ct >= end:
        raise ApiError([f"Период по {fmt_d(ct)} уже закрыт"])
    C.st.set_setting("closedTo", end)
    C.st.audit(u, "Закрытие периода", "", f"{fmt_d(ct) if ct else '—'} → {fmt_d(end)}")


def mark_closed_changes_seen(C, u):
    for c in C.S["closedChanges"]:
        seen = c.get("seen") or []
        if u["id"] not in seen:
            c["seen"] = seen + [u["id"]]
            C.st.save("closedChanges", c)
