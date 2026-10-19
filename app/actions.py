"""Изменения данных. Каждая функция проверяет права и правила ТЗ, пишет версии и журнал аудита.

Ошибки проверки — ApiError (HTTP 400, список сообщений), нет прав — Forbidden (HTTP 403).
"""
import hashlib
import hmac
import math
import re
import secrets

from .logic import (DOC_TYPES, MANUAL_OPS, OP_KINDS, ROLES, RULE_FIELDS, RULE_OPS, acc_curs, add_version, apply_rules, balances, can_edit_wallet, can_review,
                    movement_snap, doc_counts,
                    can_enter, cur_code, descendants, doc_snap, facts, has, in_closed, is_active_at, is_admin, line_visible, manual_allowed,
                    match_rule, needs_formalizing, nm, op_complete, op_legs, op_snap, own_wallets, period_error, rate_at, to_usd, wallet_closed_at,
                    diff_text, is_usd, visible_wallets, line_parts)
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
SIDE_KEYS = ("org", "acc", "cur", "sum", "wallet", "wsrc", "rule", "dept", "cf", "zone", "cpty", "contract", "purpose")


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
    a = C.acc(S_["acc"])
    S_["cur"] = s(S_["cur"]) or (acc_curs(a)[0] if a and len(acc_curs(a)) == 1 else "")
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


def side_rules(C, d):
    """ТР-111 (МД-25): правила сторон по виду операции."""
    e = []
    F, T = d["from"], d["to"]
    fa, ta = C.acc(F["acc"]), C.acc(T["acc"])
    op = d["op"]
    same_pos = F["acc"] and F["acc"] == T["acc"] and F.get("cur") == T.get("cur")
    if op == "Конвертация валюты":
        if F["org"] and T["org"] and F["org"] != T["org"]: e.append("Конвертация валюты — внутри одной организации: получатель той же организации")
        if F.get("cur") and T.get("cur") and F["cur"] == T["cur"]: e.append("Конвертация валюты: валюты сторон должны различаться")
        if same_pos: e.append("Конвертация валюты: позиции сторон должны различаться")
    elif op == "Перечисление на другой счёт":
        if F["org"] and T["org"] and F["org"] != T["org"]: e.append("Перечисление на другой счёт — внутри одной организации")
        if F.get("cur") and T.get("cur") and F["cur"] != T["cur"]: e.append("Перечисление на другой счёт — в одной валюте; для разных валют выберите «Конвертация валюты»")
        if F["acc"] and F["acc"] == T["acc"]: e.append("Перечисление на другой счёт: счета сторон должны различаться")
    elif op == "Инкассация":
        if F["org"] and T["org"] and F["org"] != T["org"]: e.append("Инкассация — внутри одной организации")
        if F.get("cur") and T.get("cur") and F["cur"] != T["cur"]: e.append("Инкассация — в одной валюте")
        if fa and ta and (fa["kind"] == "Касса") == (ta["kind"] == "Касса"): e.append("Инкассация — между кассой и банковским счётом")
    elif op == "Оплата в другую организацию группы":
        if F["org"] and T["org"] and F["org"] == T["org"]: e.append("Оплата в другую организацию группы — организации сторон должны различаться")
    if same_pos and op != "Конвертация валюты":
        e.append("Счёт отправителя и получателя совпадают")
    return e


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
            elif S_.get("cur") not in acc_curs(a):
                e.append(f"{t}: не выбрана валюта счёта")
            if not (S_["sum"] and S_["sum"] > 0):
                e.append(f"{t}: сумма должна быть больше нуля")
            if a and S_.get("cur") and not rate_at(C, S_["cur"], d["date"]):
                e.append(f"{t}: нет курса {cur_code(C, S_['cur'])} на {fmt_d(d['date'])}")
            if S_["wallet"]:
                if not C.get("wallets", S_["wallet"]):
                    e.append(f"{t}: кошелёк недоступен")
                elif wallet_closed_at(C, S_["wallet"], d["date"]):
                    e.append(f"{t}: кошелёк закрыт (ТР-25)")
        e += side_rules(C, d)
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
            if d.get("cur") not in acc_curs(a):
                e.append("Не выбрана валюта счёта")
            elif not rate_at(C, d["cur"], d["date"]):
                e.append(f"Нет курса {cur_code(C, d['cur'])} на {fmt_d(d['date'])} — загрузите курсы из 1С")
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
        if d["op"] == "Конвертация валюты" and d["from"]["org"]:
            d["to"]["org"] = d["from"]["org"]        # ТР-111: получатель подставляется
        d["org"], d["acc"], d["cur"] = d["from"]["org"], d["from"]["acc"], d["from"].get("cur") or ""
    else:
        d["org"], d["acc"] = s(src.get("org")), s(src.get("acc"))
        a = C.acc(d["acc"]); cs = acc_curs(a)
        d["cur"] = s(src.get("cur")) if s(src.get("cur")) in cs else (cs[0] if len(cs) == 1 else "")
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
            c = d[side]["cur"]
            d[side]["rate"] = rate_at(C, c, d["date"])
            d[side]["usd"] = to_usd(C, d[side]["sum"], c, d["date"])
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
        if ch.get("split") is not None and where.isdigit():
            # ТР-54: распределение строки между кошельками — сумма частей равна сумме строки ERP с точностью до копейки
            try:
                tgt = d["lines"][int(where)]
            except IndexError:
                raise ApiError(["Неверная строка"])
            if not all(line_visible(C, u, p_["wallet"]) and (not p_["wallet"] or can_edit_wallet(C, u, p_["wallet"])) for p_ in line_parts(tgt)):
                raise Forbidden("Строка относится к чужому кошельку")
            parts = []
            for p_ in ch.get("split") or []:
                sm, w_ = num(p_.get("sum")), s(p_.get("wallet")) or None
                if sm is None or sm <= 0:
                    raise ApiError([f"Строка {int(where)+1}: сумма каждой части должна быть больше нуля"])
                if w_:
                    if not C.get("wallets", w_):
                        raise ApiError(["Неизвестный кошелёк"])
                    if not can_edit_wallet(C, u, w_):
                        raise Forbidden("Кошелёк не ваш")
                    if wallet_closed_at(C, w_, d["date"]):
                        raise ApiError(["Кошелёк закрыт (ТР-25)"])
                parts.append({"sum": r2(sm), "wallet": w_})
            if len(parts) == 1:
                parts = []
                wid = parts and parts[0]["wallet"] or (s((ch.get("split") or [{}])[0].get("wallet")) or None)
            if parts:
                diff = r2(sum(p_["sum"] for p_ in parts) - (tgt.get("sum") or 0))
                if abs(diff) >= 0.005:
                    raise ApiError([f"Строка {int(where)+1}: сумма частей {fmt(r2(sum(p_['sum'] for p_ in parts)))} не равна сумме строки {fmt(tgt.get('sum'))} {cur_code(C, d.get('cur'))} — расхождение {fmt(diff)} {cur_code(C, d.get('cur'))} (ТР-54)"])
                old = "; ".join(f"{nm(C.get('wallets', p_['wallet'])) if p_['wallet'] else 'без кошелька'} {fmt(p_['sum'])}" for p_ in line_parts(tgt))
                tgt["split"], tgt["wallet"], tgt["wsrc"], tgt["rule"] = parts, None, "split", None
                log.append(f"строка {int(where)+1}: {old} → " + "; ".join(f"{nm(C.get('wallets', p_['wallet'])) if p_['wallet'] else 'без кошелька'} {fmt(p_['sum'])}" for p_ in parts))
                continue
            if tgt.get("split"):
                tgt["split"] = []
                log.append(f"строка {int(where)+1}: распределение по кошелькам снято")
            ch = {"where": where, "wallet": wid}
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
    if K.get("legacy"):
        e.append("Вид «Дивиденды односторонние» убран (МД-24): перенос остатка при закрытии — обычными «Дивидендами» в головной кошелёк")
    pe = period_error(C, o["date"])
    if pe:
        e.append(pe)
    for key, label in (("from", K["from"]), ("to", K["to"])):
        if not o.get(key) or not C.get("wallets", o[key]):
            e.append(f"Не выбран {label.lower()}")
    if o.get("from") and o["from"] == o.get("to"):
        e.append("Операция внутри одного кошелька не имеет смысла: выберите разные кошельки отправителя и получателя")
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
        chk(o["leg1"], "Операция 1" if o["kind"] == "exchange" else "Счёт")
    if o["kind"] == "exchange" and post:
        chk(o["leg2"], "Операция 2 (документ не проводится без второй операции)")
    for L in ("leg1", "leg2") if o["kind"] == "exchange" else ("leg1",):
        a = C.acc(o[L].get("acc"))
        if a and o[L].get("cur") not in acc_curs(a):
            e.append(f"{'Операция 1' if L == 'leg1' else 'Операция 2'}: не выбрана валюта счёта")
    if o["kind"] == "exchange":
        a, b = o["leg1"], o["leg2"]
        if a.get("acc") and b.get("acc") and a["acc"] == b["acc"] and a.get("cur") == b.get("cur"):
            e.append("Операции обмена должны быть на разных позициях")
        if o.get("sameCur") and a.get("cur") and b.get("cur") and a["cur"] != b["cur"]:
            e.append("Обмен в одной валюте: валюта операции 2 должна совпадать с валютой операции 1 (ТР-77)")
        if not o.get("sameCur") and a.get("cur") and b.get("cur") and a["cur"] == b["cur"]:
            e.append("Обмен в разной валюте: счёт операции 2 должен быть в другой валюте")
        if o.get("sameCur") and is_num(a.get("sum")) and is_num(b.get("sum")) and abs(a["sum"] - b["sum"]) >= 0.005:
            e.append("Обмен в одной валюте: сумма операции 2 равна сумме операции 1 (ТР-77)")
    return e


def _clean_leg(C, L):
    L = L or {}
    a = C.acc(s(L.get("acc")))
    cs = acc_curs(a)
    cur = s(L.get("cur")) if s(L.get("cur")) in cs else (cs[0] if len(cs) == 1 else "")
    rate = num(L.get("rate"))
    if cur and is_usd(C, cur):
        rate = 1.0
    sm = num(L.get("sum"))
    return {"org": a["org"] if a else "", "acc": a["id"] if a else "", "cur": cur, "sum": r2(sm) if sm is not None else None, "rate": rate}


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
         "leg2": _clean_leg(C, src.get("leg2")) if kind == "exchange" else {"org": "", "acc": "", "cur": "", "sum": None, "rate": None},
         "sameCur": bool(src.get("sameCur", True)), "author": orig["author"] if orig else u["id"], "created": orig["created"] if orig else now_iso(),
         "posted": False, "deleted": False, "linkedDoc": orig.get("linkedDoc") if orig else None, "versions": orig["versions"] if orig else []}
    if kind == "exchange":
        if o["sameCur"] and o["leg1"]["sum"] is not None:
            o["leg2"]["sum"] = o["leg1"]["sum"]          # ТР-77: сумма операции 2 = сумме операции 1, не редактируется
            if is_num(o["leg1"].get("rate")):
                o["leg2"]["rate"] = o["leg1"]["rate"]    # один курс на обе операции
        elif is_num(o["leg1"]["sum"]) and is_num(o["leg2"]["sum"]) and o["leg1"]["sum"] > 0:
            # ТР-112: курс обмена хранится с 6 знаками; введённый пользователем курс сохраняется как есть,
            # если суммы с ним согласованы (округляются только суммы до центов), иначе считается из сумм
            # котировка: xdir «21» — единиц валюты 2 за 1 единицу валюты 1, «12» — наоборот (84 RUB за 1 USD)
            x, xdir = num(src.get("xrate")), ("12" if src.get("xdir") == "12" else "21")
            s1, s2 = o["leg1"]["sum"], o["leg2"]["sum"]
            k = (1 / x if xdir == "12" else x) if x and x > 0 else None
            if k and abs(r2(s1 * k) - s2) <= max(0.011, s2 * 1e-7):
                o["xrate"] = round(x, 6)
            else:
                o["xrate"] = round(s1 / s2 if xdir == "12" else s2 / s1, 6)
            o["leg2"]["xrate"], o["leg2"]["xdir"] = o["xrate"], xdir
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
def save_opening(C, u, acc_id, rows, cur=None):
    need_admin(u)
    d0 = C.S["settings"].get("startDate")
    if not d0:
        raise ApiError(["Сначала задайте дату начала учёта по кошелькам (ТР-20)."])
    if in_closed(C, d0):
        raise ApiError(["Период закрыт"])
    a = C.acc(acc_id)
    if not a:
        raise ApiError(["Счёт не найден"], 404)
    cur = cur or (acc_curs(a)[0] if len(acc_curs(a)) == 1 else None)
    if cur not in acc_curs(a):
        raise ApiError(["Укажите валюту позиции"])
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
        clean.append({"id": s(r.get("id")) or uid("OB"), "acc": acc_id, "cur": cur, "wallet": w, "sum": r2(sm)})
    mine = [x for x in C.S["opening"] if x["acc"] == acc_id and (x.get("cur") or a["cur"]) == cur]
    before = "; ".join(f"{nm(C.get('wallets', x['wallet']))}: {fmt(x['sum'])}" for x in mine)
    for x in mine:
        C.st.delete("opening", x)
    for x in clean:
        C.st.add("opening", x)
    C.st.audit(u, "Ввод входящих остатков", f"{a['name']} · {cur_code(C, cur)}", f"было: {before or '—'}; стало: " + ("; ".join(f"{nm(C.get('wallets', x['wallet']))}: {fmt(x['sum'])}" for x in clean) or "—"))


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
    closing = w["closed"] and not (exist and exist.get("closed"))
    close_plan = close_plan_for(C, w, w["closedFrom"]) if closing and exist else None
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
        if close_plan:
            n = close_with_dividends(C, u, exist, close_plan)
            return {"id": w["id"], "created": n}
    return {"id": w["id"]}


def close_plan_for(C, w, closed_from):
    """ТР-25: при закрытии остаток по каждой позиции уходит «Дивидендами» в головной кошелёк; с минусом закрывать нельзя."""
    pe = period_error(C, closed_from)
    if pe:
        raise ApiError([pe])
    wf = [f for f in facts(C) if f["wallet"] == w["id"]]
    pend = [f for f in wf if f.get("sbds") and f["docDate"] <= closed_from and f["date"] > closed_from]
    if pend:
        raise ApiError([f"У кошелька есть платежи СБДС, ещё не исполненные банком ({len(pend)}): закрыть можно после их исполнения — иначе фактический остаток после закрытия уйдёт в минус (ТР-07, ТР-25)"])
    bal = [(k, v) for k, v in balances(C, closed_from, wf).items() if abs(v) >= 0.005]
    neg = [(k, v) for k, v in bal if v < 0]
    if neg:
        raise ApiError(["Закрытие с отрицательным остатком запрещено, пока минус не покрыт финансированием (ТР-25): "
                        + "; ".join(f"{nm(C.acc(aid))} {fmt(v)} {cur_code(C, cur)}" for (_w, aid, cur), v in neg)])
    if not bal:
        return []
    heads = [x for x in C.S["wallets"] if x.get("head") and x["id"] != w["id"] and not wallet_closed_at(C, x, closed_from)]
    if not heads:
        raise ApiError(["Нет действующего головного кошелька — остаток некуда перенести (ТР-25)"])
    # ближайший головной кошелёк среди предков, иначе первый головной
    anc = {a["id"] for a in []}
    p_ = C.get("wallets", w.get("parent"))
    head = None
    while p_ and not head:
        if p_.get("head") and p_ in heads:
            head = p_
        p_ = C.get("wallets", p_.get("parent"))
    head = head or heads[0]
    return [{"acc": aid, "cur": cur, "sum": v, "head": head["id"]} for (_w, aid, cur), v in bal]


def close_with_dividends(C, u, w, plan):
    n = 0
    for x in plan:
        a = C.acc(x["acc"])
        rate = rate_at(C, x["cur"], w["closedFrom"]) or 1.0
        o = {"id": uid("O"), "no": C.st.next_no("ВО"), "date": w["closedFrom"], "kind": "dividends", "from": w["id"], "to": x["head"],
             "contract": "", "comment": f"Перенос остатка при закрытии «{w['name']}» (ТР-25)",
             "leg1": {"org": a["org"], "acc": x["acc"], "cur": x["cur"], "sum": r2(x["sum"]), "rate": rate}, "leg2": {"org": "", "acc": "", "cur": "", "sum": None, "rate": None},
             "sameCur": True, "author": u["id"], "created": now_iso(), "posted": True, "deleted": False, "linkedDoc": None, "versions": []}
        C.st.add("ops", o)
        C.st.audit(u, "Создание внутренней операции", f"{OP_KINDS['dividends']['name']} {o['no']}", diff_text({}, op_snap(C, o)))
        n += 1
    C.st.audit(u, "Закрытие кошелька", w["name"], f"с {fmt_d(w['closedFrom'])}; перенесено «Дивидендами» в головной кошелёк «{nm(C.get('wallets', plan[0]['head']))}» операций: {n}" if plan else f"с {fmt_d(w['closedFrom'])}; остатка нет")
    return n


def close_transfer(C, u, wid, target, closed_from):
    """МД-24: «Дивиденды односторонние» убраны; закрытие — через сохранение кошелька с отметкой «Закрыт» (ТР-25)."""
    raise ApiError(["Перенос остатка выполняется автоматически при закрытии кошелька: «Дивиденды» в головной кошелёк (ТР-25)"])


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
    if C.get("wallets", r["wallet"]).get("closed") and r["active"] and (not ex or ex.get("wallet") != r["wallet"] or not ex.get("active")):
        raise ApiError(["Кошелёк закрыт — его нельзя выбрать в правиле (ТР-25)"])
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
            "кошельки": [nm(C.get("wallets", w)) for w in x.get("wallets") or []], "активен": x["active"], "право загрузки": bool(x.get("canUpload"))}


def save_user(C, u, p):
    need_admin(u)
    ex = C.get("users", s(p.get("id"))) if p.get("id") else None
    nu = {"id": ex["id"] if ex else uid("U"), "name": s(p.get("name"), 200), "login": s(p.get("login"), 100), "email": s(p.get("email"), 200),
          "roles": [r for r in p.get("roles") or [] if r in ROLES], "wallets": [w for w in p.get("wallets") or [] if C.get("wallets", w)],
          "active": bool(p.get("active", True)), "lang": ex.get("lang") if ex else "", "pw": ex.get("pw") if ex else None,
          "canUpload": bool(p.get("canUpload"))}
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
                  "autoClose": "Автозакрытие периода", "excludedOps": "Изменение списка исключаемых операций",
                  "stateMap": "Таблица соответствия состояний ERP (ТР-106)", "rateForm": "Форма котировки курса в отчёте ERP",
                  "recon1c": "Сверка с остатками 1С", "holdClosed": "Удержание изменений ERP в закрытом периоде",
                  "dbTime": "Daily Balance: контрольное время", "dbWeekends": "Daily Balance: выходные дни недели",
                  "dbHolidays": "Daily Balance: праздничные дни", "dbWorkdays": "Daily Balance: рабочие выходные", "dbTol": "Daily Balance: допуск расхождения"}
MEANINGS = ("pending", "approved", "posted", "notposted", "deleted")


def set_setting(C, u, key, value):
    need_admin(u)
    if key not in SETTING_LABELS:
        raise ApiError(["Неизвестная настройка"])
    if key in ("startDate", "closedTo", "switchDate"):
        value = value if valid_iso(value) else ""
    elif key in ("autoClose", "recon1c", "holdClosed"):
        value = bool(value)
    elif key in ("excludedOps",):
        value = [s(x, 200) for x in (value or []) if s(x)]
    elif key == "stateMap":
        value = [{"value": s(x.get("value"), 200), "meaning": x.get("meaning")} for x in (value or []) if s(x.get("value")) and x.get("meaning") in MEANINGS]
    elif key == "rateForm":
        if value not in ("perUsd", "usdPer"):
            raise ApiError(["Неизвестная форма котировки"])
    elif key == "dbTime":
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(value or "")):
            raise ApiError(["Время в формате ЧЧ:ММ"])
    elif key == "dbWeekends":
        value = sorted({int(x) for x in (value or []) if str(x).isdigit() and 1 <= int(x) <= 7})
    elif key in ("dbHolidays", "dbWorkdays"):
        value = sorted({x for x in (value or []) if valid_iso(x)})
    elif key == "dbTol":
        value = {s(k, 10): abs(num(v) or 0) for k, v in (value or {}).items() if s(k)}
    before = C.S["settings"].get(key)
    if before == value:
        return
    C.st.set_setting(key, value)
    def show(v):
        if isinstance(v, list):
            return ", ".join(f"{x['value']} → {x['meaning']}" if isinstance(x, dict) else str(x) for x in v) or "—"
        if isinstance(v, dict):
            return ", ".join(f"{k}: {x}" for k, x in v.items()) or "—"
        if v is True or v is False:
            return "вкл" if v else "выкл"
        return (fmt_d(v) if valid_iso(v) else str(v)) if v else "—"
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


# ================= проверка существенных изменений (ТР-85…88) =================
def confirm_review(C, u, doc_id):
    d = C.get("docs", doc_id)
    if not d or not d.get("review"):
        raise ApiError(["Документ не требует проверки"])
    if not can_review(C, u, d):
        raise Forbidden("Проверяет казначей кошелька из строк документа; документ без кошелька — фин. контролер или администратор (ТР-85)")
    held = d.get("held") or {}
    before = {"движение": "прежнее (до проверки)", "сумма": fmt(r2(sum(l.get("sum") or 0 for l in held.get("lines") or []))), "в расчёте": bool(held.get("counted"))}
    d["held"], rv = None, d.get("review") or {}
    d["review"] = None
    C.st.save("docs", d)
    after = {"движение": "новое из ERP", "сумма": fmt(r2(sum(l.get("sum") or 0 for l in d["lines"]))), "в расчёте": doc_counts(C, d)}
    add_version(C, "doc", d, before, after, "проверка изменений", u)
    C.st.audit(u, "Проверка изменений документа", f"{d['type']} {d.get('no1c') or d['no']}",
               "; ".join(f"{x.get('f')}{(' стр.' + str(x['line'])) if x.get('line') else ''}: {x.get('before')} → {x.get('after')}" for x in rv.get("diff") or []) or "подтверждено")


# ================= таблица соответствия состояний из реестра загрузки (ТР-106, ТР-109) =================
def save_state_values(C, u, items):
    """Несколько значений за раз — одним действием из реестра загрузки."""
    items = [x for x in (items or []) if isinstance(x, dict) and x.get("meaning")]
    if not items:
        raise ApiError(["Выберите, что означает хотя бы одно значение"])
    for x in items:
        save_state_value(C, u, x.get("value"), x.get("meaning"))
    return len(items)


def save_state_value(C, u, value, meaning):
    """Загружающий задаёт значение этапа/состояния ERP прямо в реестре; попадает в таблицу ТР-106 и журнал аудита."""
    from .importer import need_upload
    need_upload(u)
    value = s(value, 200)
    if not value or meaning not in MEANINGS:
        raise ApiError(["Выберите, что означает значение"])
    from .util import norm
    before = list(C.S["settings"].get("stateMap") or [])
    after = [x for x in before if norm(x.get("value")) != norm(value)] + [{"value": value, "meaning": meaning}]
    C.st.set_setting("stateMap", after)
    old = next((x["meaning"] for x in before if norm(x.get("value")) == norm(value)), None)
    C.st.audit(u, SETTING_LABELS["stateMap"], value, f"{old or '—'} → {meaning}")


# ================= сопоставления (ТР-109) =================
MAP_KINDS = {"org": "orgs", "acc": "accs", "cur": "currencies", "dept": "depts", "cf": "cfTypes", "zone": "zones"}


def save_mapping(C, u, kind, raw, target):
    from .importer import need_upload
    need_upload(u)
    if kind not in MAP_KINDS:
        raise ApiError(["Неизвестный вид сопоставления"])
    raw = s(raw, 300)
    if not raw:
        raise ApiError(["Пустое значение"])
    if target:
        ok = C.acc(target) if kind == "acc" else C.get(MAP_KINDS[kind], target)
        if not ok:
            raise ApiError(["Элемент справочника не найден"])
    from .util import norm
    ex = next((x for x in C.S["mappings"] if x["kind"] == kind and x["rawNorm"] == norm(raw)), None)
    before = ex["target"] if ex else ""
    if ex and not target:
        C.st.conn.execute("DELETE FROM mappings WHERE kind=? AND raw_norm=?", (kind, norm(raw)))
        C.S["mappings"] = [x for x in C.S["mappings"] if x is not ex]
    elif ex:
        ex.update(target=target, t=now_iso(), u=u["name"]); C.st.save("mappings", ex)
    elif target:
        C.st.add("mappings", {"kind": kind, "rawNorm": norm(raw), "raw": raw, "target": target, "t": now_iso(), "u": u["name"]})
    name = lambda t: nm(C.acc(t)) if kind == "acc" else nm(C.get(MAP_KINDS[kind], t)) if t else "—"
    C.st.audit(u, "Сопоставление названия из файла", f"{kind}: «{raw}»", f"{name(before) if before else '—'} → {name(target)}")


# ================= Daily Balance (раздел 7) =================
def _db():
    from . import daily
    return daily


def db_save_position(C, u, p):
    need_admin(u)
    D = _db()
    ex = C.get("dbPositions", s(p.get("id"))) if p.get("id") else None
    a = C.acc(s(p.get("acc")))
    cur = s(p.get("cur"))
    if not ex and (not a or cur not in acc_curs(a)):
        raise ApiError(["Выберите счёт или кассу и валюту"])
    owner = s(p.get("owner"))
    if owner:
        ou = C.get("users", owner)
        if not ou or not ou.get("active") or not has(ou, "treasurer"):
            raise ApiError(["Ответственный — активный казначей"])
    if not ex:
        if any(x["acc"] == a["id"] and x["cur"] == cur for x in C.S["dbPositions"]):
            raise ApiError(["Позиция уже есть в модуле"])
        x = {"id": uid("P"), "acc": a["id"], "cur": cur, "owner": owner, "active": bool(p.get("active", True)), "created": now_iso()}
        C.st.add("dbPositions", x)
        C.st.audit(u, "Daily Balance: позиция добавлена", f"{nm(a)} · {cur_code(C, cur)}", f"ответственный: {nm(C.get('users', owner)) if owner else '—'}")
        return {"id": x["id"]}
    before_owner, before_active = ex.get("owner"), ex.get("active")
    ex["owner"], ex["active"] = owner, bool(p.get("active", True))
    C.st.save("dbPositions", ex)
    pa = C.acc(ex["acc"])
    if before_owner != owner:
        C.st.audit(u, "Daily Balance: смена ответственного", f"{nm(pa)} · {cur_code(C, ex['cur'])}",
                   f"{nm(C.get('users', before_owner)) if before_owner else '—'} → {nm(C.get('users', owner)) if owner else '—'}")
    if before_active != ex["active"]:
        C.st.audit(u, "Daily Balance: позиция " + ("включена" if ex["active"] else "выключена"), f"{nm(pa)} · {cur_code(C, ex['cur'])}", "")
    return {"id": ex["id"]}


def db_add_all_positions(C, u):
    need_admin(u)
    have = {(x["acc"], x["cur"]) for x in C.S["dbPositions"]}
    n = 0
    for a in C.S["accounts"] + C.S["cashboxes"]:
        if a.get("deactivated"):
            continue
        for c in acc_curs(a):
            if (a["id"], c) not in have:
                C.st.add("dbPositions", {"id": uid("P"), "acc": a["id"], "cur": c, "owner": "", "active": True, "created": now_iso()})
                n += 1
    C.st.audit(u, "Daily Balance: позиции добавлены", "", f"добавлено позиций: {n}")
    return n


def _db_data_clean(data):
    out = {}
    for pid, r in (data or {}).items():
        if not isinstance(r, dict):
            continue
        b = r.get("b")
        bnum = num(b) if b not in (None, "") else None
        out[s(pid, 60)] = {"b": bnum, "noAccess": bool(r.get("noAccess")), "pDocs": [s(x, 60) for x in r.get("pDocs") or []],
                           "pManual": [{"sum": num(m.get("sum")), "comment": s(m.get("comment"), 300)} for m in r.get("pManual") or [] if isinstance(m, dict)],
                           "incoming": num(r.get("incoming")) if r.get("incoming") not in (None, "") else None, "incomingComment": s(r.get("incomingComment"), 300),
                           "comment": s(r.get("comment"), 500), "pTouched": bool(r.get("pTouched"))}
    return out


def db_save_draft(C, u, d, data):
    """ТР-93: черновик сохраняется на сервере."""
    if not valid_iso(d):
        raise ApiError(["Неверная дата"])
    D = _db()
    if not D.my_positions(C, u):
        raise Forbidden("Вы не ответственный ни за одну позицию Daily Balance")
    key = f"{u['id']}|{d}"
    ex = C.get("dbDrafts", key)
    rec = {"id": key, "user": u["id"], "date": d, "data": _db_data_clean(data), "updated": now_iso()}
    if ex:
        ex.update(rec); C.st.save("dbDrafts", ex)
    else:
        C.st.add("dbDrafts", rec)
    return {"updated": rec["updated"]}


def db_submit(C, u, d, data):
    """ТР-93…96: сдача = фиксация; один утренний отчёт на казначея в день."""
    D = _db()
    if not valid_iso(d):
        raise ApiError(["Неверная дата"])
    if not D.is_workday(C, d):
        raise ApiError(["Отчёт сдаётся только в рабочие дни (ТР-94)"])
    if d > D.today_local(C):
        raise ApiError(["Нельзя сдать отчёт за будущий день"])
    mine = D.my_positions(C, u)
    if not mine:
        raise Forbidden("Вы не ответственный ни за одну позицию Daily Balance")
    if D.reports_of(C, d, u["id"], "morning"):
        raise ApiError([f"Утренний отчёт за {fmt_d(d)} уже сдан. Обновить остаток по позиции можно кнопкой «Обновить остаток» (ТР-97)"])
    data = _db_data_clean(data)
    errs = []
    rows = []
    for pos in mine:
        r = data.get(pos["id"]) or {}
        a = C.acc(pos["acc"])
        if not r.get("noAccess") and r.get("b") is None:
            errs.append(f"{nm(a)} · {cur_code(C, pos['cur'])}: введите остаток по банку (ноль — явно) или отметьте «Нет доступа к банку»")
            continue
        rows.append(D.build_row(C, u, pos, d, r))
    if errs:
        raise ApiError(errs)
    t = D.now_local(C)
    rep = {"id": None, "kind": "morning", "date": d, "user": u["id"], "uname": u["name"], "t": t.isoformat(timespec="seconds"), "late": D.is_late(C, d, t), "rows": rows}
    C.st.add("dbReports", rep)
    dr = C.get("dbDrafts", f"{u['id']}|{d}")
    if dr:
        C.st.conn.execute("DELETE FROM db_drafts WHERE id=?", (dr["id"],))
        C.S["dbDrafts"] = [x for x in C.S["dbDrafts"] if x is not dr]
    C.st.audit(u, "Daily Balance: сдача отчёта", f"за {fmt_d(d)}" + (" (с опозданием)" if rep["late"] else ""),
               "; ".join(f"{nm(C.acc(r['acc']))} {cur_code(C, r['cur'])}: Б {'нет доступа' if r['noAccess'] else fmt(r['b'])}, П {fmt(r['p'])}, К {fmt(r['k'])}"
                         + (f", расхождение {fmt(r['diff'])}" if r.get("diff") is not None else "") for r in rows))
    return {"id": rep["id"], "late": rep["late"]}


def db_update(C, u, pid, data):
    """ТР-97: обновление днём — новая неизменяемая запись со временем; утренний отчёт не меняется."""
    D = _db()
    pos = D.pos_get(C, s(pid))
    if not pos or pos.get("owner") != u["id"]:
        raise Forbidden("Обновлять остаток может ответственный за позицию")
    d = D.today_local(C)
    if not D.reports_of(C, d, u["id"], "morning"):
        raise ApiError(["Сначала сдайте утренний отчёт за сегодня (ТР-97)"])
    r = _db_data_clean({pos["id"]: data}).get(pos["id"]) or {}
    if r.get("b") is None:
        raise ApiError(["Введите остаток по банку"])
    r["noAccess"] = False
    row = D.build_row(C, u, pos, d, r)
    t = D.now_local(C)
    rep = {"id": None, "kind": "update", "date": d, "user": u["id"], "uname": u["name"], "t": t.isoformat(timespec="seconds"), "late": False, "rows": [row]}
    C.st.add("dbReports", rep)
    C.st.audit(u, "Daily Balance: обновление остатка", f"{nm(C.acc(pos['acc']))} · {cur_code(C, pos['cur'])}", f"{fmt_d(d)} {t.strftime('%H:%M')}: Б {fmt(row['b'])}")
    return {"id": rep["id"]}


def db_correct(C, u, report_id, pid, field, value, reason):
    """ТР-98: корректировка — исходное остаётся, новое рядом с причиной; фин. контролер и администратор; только открытый период."""
    D = _db()
    if not (is_admin(u) or has(u, "finControl")):
        raise Forbidden("Корректировка — фин. контролер и администратор (ТР-98)")
    rep = next((r for r in C.S["dbReports"] if r["id"] == report_id), None)
    if not rep or not any(x["pos"] == pid for x in rep["rows"]):
        raise ApiError(["Строка отчёта не найдена"])
    if in_closed(C, rep["date"]):
        raise ApiError([f"Период по {fmt_d(C.S['settings']['closedTo'])} закрыт — корректировать Daily Balance нельзя (ТР-55)"])
    if field not in ("b", "p"):
        raise ApiError(["Корректируется остаток по банку или исходящие в пути"])
    v = num(value)
    if v is None:
        raise ApiError(["Введите число"])
    reason = s(reason, 500)
    if not reason:
        raise ApiError(["Укажите причину корректировки"])
    row = next(x for x in rep["rows"] if x["pos"] == pid)
    prev = D.effective(C, row, pid, rep["date"])[0 if field == "b" else 1]
    C.st.add("dbCorr", {"id": None, "report": report_id, "pos": pid, "date": rep["date"], "field": field, "value": r2(v), "reason": reason,
                        "user": u["id"], "uname": u["name"], "t": now_iso()})
    C.st.audit(u, "Daily Balance: корректировка", f"{nm(C.acc(row['acc']))} · {cur_code(C, row['cur'])} за {fmt_d(rep['date'])}",
               f"{'Б' if field == 'b' else 'П'}: {fmt(prev)} → {fmt(v)}; причина: {reason}")


def db_explain(C, u, pid, d, comment):
    """ТР-100: статус «Объяснено» ставит фин. контролер (и администратор)."""
    D = _db()
    if not (is_admin(u) or has(u, "finControl")):
        raise Forbidden("«Объяснено» ставит фин. контролер (ТР-100)")
    pos = D.pos_get(C, s(pid))
    if not pos or not valid_iso(d):
        raise ApiError(["Позиция не найдена"])
    comment = s(comment, 500)
    if not comment:
        raise ApiError(["Опишите причину расхождения"])
    C.st.add("dbExpl", {"id": None, "pos": pos["id"], "date": d, "comment": comment, "user": u["id"], "uname": u["name"], "t": now_iso()})
    C.st.audit(u, "Daily Balance: «Объяснено»", f"{nm(C.acc(pos['acc']))} · {cur_code(C, pos['cur'])} за {fmt_d(d)}", comment)