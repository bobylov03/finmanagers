"""Загрузка файлов из 1С (ТР-60…67, ТР-70, ТР-72): документы, справочники и курсы, остатки для сверки.

Браузер читает .xlsx/.csv и присылает листы как таблицы значений; смысл строк, проверки,
сопоставление по GUID и запись делает сервер. Повторная загрузка того же файла ничего не меняет.
"""
import json

from .actions import ApiError, need_admin
from .logic import DOC_TYPES, add_version, apply_rules, cur_code, doc_snap, in_closed, is_usd, nm, recon, to_usd
from .util import fmt, fmt_d, norm, now_iso, parse_date, parse_num, r2, txt, valid_iso
import math

EXP_SPEC = {
    "guid": ["GUID документа 1С", "GUID документа", "GUID", "Идентификатор документа"],
    "type": ["Тип", "Тип документа", "Вид документа"],
    "op": ["Хозяйственная операция", "Хоз. операция", "Хоз операция", "Операция"],
    "no": ["Номер", "Номер документа"],
    "date": ["Дата", "Дата документа", "Дата создания"],
    "org": ["Организация"],
    "acc": ["Счёт или касса", "Счет или касса", "Банковский счёт", "Банковский счет", "Счёт", "Счет", "Касса"],
    "cur": ["Валюта"],
    "status": ["Статус"],
    "approved": ["Согласован", "Прошёл согласование", "Согласование"],
    "bank": ["Проведено банком", "Признак проведено банком"],
    "bankDate": ["Дата проведения банком"],
    "sum": ["Сумма в валюте", "Сумма"],
    "usd": ["Сумма в USD", "Сумма USD"],
    "wallet": ["Кошелёк", "Кошелек"],
    "dept": ["Подразделение"],
    "cf": ["Тип расхода CF", "Тип расхода", "Статья ДДС"],
    "zone": ["Зона ответственности", "Зона"],
    "cpty": ["Контрагент"],
    "contract": ["Договор"],
    "purpose": ["Назначение платежа", "Назначение"],
}
EXP_REQ = ["guid", "type", "date", "org", "acc", "sum", "status"]
ID_AL = ["Идентификатор", "GUID", "ID", "Ид", "Код"]
REF_KINDS = {
    "currencies": {"name": "Валюты", "spec": {"id": ["Идентификатор", "GUID", "ID", "Код"], "name": ["Наименование"], "code": ["Символьный код", "Буквенный код", "Код ISO"]}, "req": ["id"]},
    "rates": {"name": "Курсы к USD", "spec": {"cur": ["Валюта"], "date": ["Дата"], "rate": ["Курс", "Курс к USD", "Единиц валюты за 1 USD"]}, "req": ["cur", "date", "rate"]},
    "orgs": {"name": "Организации", "spec": {"id": ID_AL, "name": ["Наименование"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
    "accounts": {"name": "Банковские счета", "spec": {"id": ID_AL, "name": ["Наименование"], "org": ["Организация"], "cur": ["Валюта"], "bank": ["Банк"],
                                                     "accType": ["Вид счёта", "Вид счета", "Вид"], "deact": ["Дата деактивации"]}, "req": ["id", "name", "org", "cur"]},
    "cashboxes": {"name": "Кассы", "spec": {"id": ID_AL, "name": ["Наименование"], "org": ["Организация"], "cur": ["Валюта"], "deact": ["Дата деактивации"]}, "req": ["id", "name", "org", "cur"]},
    "cfTypes": {"name": "Типы расхода CF", "spec": {"id": ID_AL, "name": ["Наименование"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
    "depts": {"name": "Подразделения", "spec": {"id": ID_AL, "name": ["Наименование"], "parent": ["Родитель", "Вышестоящее подразделение"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
    "zones": {"name": "Зоны ответственности", "spec": {"id": ID_AL, "name": ["Наименование"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
}
REF_ORDER = ["currencies", "rates", "orgs", "accounts", "cashboxes", "cfTypes", "depts", "zones"]
BAL_SPEC = {"date": ["Дата"], "acc": ["Счёт или касса", "Счет или касса", "Счёт", "Счет", "Касса", "Банковский счёт"], "cur": ["Валюта"],
            "sum": ["Остаток", "Остаток в валюте", "Сумма"]}
KIND_NAMES = {"exp": "Документы 1С", "ref": "Справочники и курсы", "bal": "Остатки 1С"}


def map_header(rows, spec):
    hi = next((i for i, r in enumerate(rows) if r and any(txt(c) for c in r)), -1)
    if hi < 0:
        return -1, {}, list(spec)
    head = [norm(c) for c in rows[hi]]
    m = {}
    for k, al in spec.items():
        for i, h in enumerate(head):
            if any(norm(a) == h for a in al):
                m[k] = i
                break
    return hi, m, [k for k in spec if k not in m]


def cell(row, m, k):
    i = m.get(k)
    return row[i] if i is not None and i < len(row) else None


def find_ref(lst, v):
    if v is None or txt(v) == "":
        return None
    s = txt(v)
    for x in lst:
        if x.get("id") == s:
            return x
    for x in lst:
        if norm(x.get("name")) == norm(s):
            return x
    for x in lst:
        if x.get("code") and norm(x["code"]) == norm(s):
            return x
    return None


def norm_type(v):
    s = norm(v)
    if s == "сбдс" or "списаниебезнал" in s: return "СБДС"
    if s == "рко" or "расходныйкасс" in s: return "РКО"
    if s == "пбдс" or "поступлениебезнал" in s: return "ПБДС"
    if s == "пко" or "приходныйкасс" in s: return "ПКО"
    return None


def norm_status(v):
    s = norm(v)
    if "удален" in s: return "Помечен на удаление"
    if "распровед" in s or "непровед" in s: return "Не проведён"
    if "согласован" in s and "провед" not in s: return "На согласовании"
    if "провед" in s: return "Проведён"
    return "Не проведён"


def norm_bool(v):
    return v is True or norm(v) in ("да", "1", "true", "истина", "x", "yes", "проведено")


def doc_sig(d):
    return json.dumps([d["type"], d["op"], d["no1c"], d["date"], d["org"], d["acc"], d["cur"], d["status"], d.get("approved") is not False, d["bankDone"],
                       d.get("bankDate") or "", [[l["sum"], l["usd"], l.get("fileWallet") or "", l["dept"], l["cf"], l["zone"], l["cpty"], l["contract"], l["purpose"]]
                                                 for l in d["lines"]]], ensure_ascii=False)


def line_sig(l):
    return json.dumps([l.get("sum"), l.get("usd"), l.get("dept"), l.get("cf"), l.get("zone"), l.get("cpty"), l.get("contract"), l.get("purpose")], ensure_ascii=False)


def _sheets(p):
    sh = p.get("sheets")
    if not isinstance(sh, list) or not sh:
        raise ApiError(["Файл пуст или не прочитан"])
    out = []
    for x in sh[:30]:
        rows = x.get("rows") if isinstance(x, dict) else None
        if not isinstance(rows, list):
            continue
        out.append({"name": txt(x.get("name"))[:100], "rows": [r if isinstance(r, list) else [] for r in rows[:200000]]})
    return out


# ======================= документы 1С =======================
def preview_exp(C, p):
    sheets = _sheets(p)
    sh = next((s_ for s_ in sheets if not [k for k in map_header(s_["rows"], EXP_SPEC)[2] if k in EXP_REQ]), sheets[0])
    hi, m, missing = map_header(sh["rows"], EXP_SPEC)
    errors, warns, skip70, skip_out = [], [], [], []
    miss = [k for k in missing if k in EXP_REQ]
    empty = {"errors": errors, "warns": warns, "skip70": skip70, "skipOut": skip_out, "add": [], "upd": [], "same": [], "exc": [], "closed": [],
             "allOrgs": [], "rows": 0, "sel": p.get("sel")}
    if miss:
        errors.append({"row": hi + 1, "msg": "Нет обязательных колонок: " + ", ".join(EXP_SPEC[k][0] for k in miss)})
        return empty, None
    S = C.S
    accs = S["accounts"] + S["cashboxes"]
    excl = {norm(x) for x in S["settings"].get("excludedOps") or []}
    rows = []
    for i, r in enumerate(sh["rows"][hi + 1:]):
        if not r or not any(txt(c) for c in r):
            continue
        n = hi + 2 + i
        g = lambda k: cell(r, m, k)
        R = {"n": n, "guid": txt(g("guid")), "type": norm_type(g("type")), "typeRaw": txt(g("type")), "op": txt(g("op")), "no": txt(g("no")),
             "date": parse_date(g("date")), "orgR": find_ref(S["orgs"], g("org")), "orgRaw": txt(g("org")), "accR": find_ref(accs, g("acc")),
             "accRaw": txt(g("acc")), "curRaw": txt(g("cur")), "statusRaw": txt(g("status")), "status": norm_status(g("status")),
             "approved": True if txt(g("approved")) == "" else norm_bool(g("approved")), "bank": norm_bool(g("bank")),
             "bankDate": parse_date(g("bankDate")), "sum": parse_num(g("sum")), "usdRaw": g("usd"), "walletRaw": txt(g("wallet")),
             "dept": txt(g("dept")), "cf": txt(g("cf")), "zone": txt(g("zone")), "cpty": txt(g("cpty")), "contract": txt(g("contract")),
             "purpose": txt(g("purpose")), "errs": []}

        def E(msg, R=R, n=n):
            R["errs"].append(msg); errors.append({"row": n, "msg": msg})
        if not R["guid"]: E("пустой GUID документа")
        if not R["type"]: E(f"неизвестный тип «{R['typeRaw']}» — ожидается СБДС, РКО, ПБДС или ПКО")
        if not R["date"]: E("неверная дата")
        if not R["orgR"]: E(f"неизвестная организация «{R['orgRaw']}»")
        if not R["accR"]: E(f"неизвестный счёт или касса «{R['accRaw']}»")
        if R["accR"] and R["orgR"] and R["accR"]["org"] != R["orgR"]["id"]:
            E(f"счёт «{R['accR']['name']}» не принадлежит организации «{R['orgR']['name']}»")
        if R["accR"] and R["type"]:
            is_cash = any(c["id"] == R["accR"]["id"] for c in S["cashboxes"])
            if DOC_TYPES[R["type"]]["cash"] and not is_cash: E(f"{R['type']} должен быть по кассе")
            if not DOC_TYPES[R["type"]]["cash"] and is_cash: E(f"{R['type']} должен быть по банковскому счёту")
        if R["curRaw"]:
            c = find_ref(S["currencies"], R["curRaw"])
            if not c: E(f"неизвестная валюта «{R['curRaw']}»")
            elif R["accR"] and c["id"] != R["accR"]["cur"]: E(f"валюта {R['curRaw']} не совпадает с валютой счёта ({cur_code(C, R['accR']['cur'])})")
        if not math.isfinite(R["sum"]): E("пустая или неверная сумма")
        elif R["sum"] <= 0: E("сумма должна быть больше нуля")
        R["usd"] = None
        if txt(R["usdRaw"]) != "":
            R["usd"] = parse_num(R["usdRaw"])
            if not math.isfinite(R["usd"]): E("неверная сумма в USD")
        elif R["accR"] and R["date"] and math.isfinite(R["sum"]):
            R["usd"] = to_usd(C, R["sum"], R["accR"]["cur"], R["date"])
            if R["usd"] is None: E(f"нет суммы в USD и нет курса {cur_code(C, R['accR']['cur'])} на {fmt_d(R['date'])}")
        R["wallet"] = None
        if R["walletRaw"]:
            w = find_ref(S["wallets"], R["walletRaw"])
            if not w: E(f"неизвестный кошелёк «{R['walletRaw']}»")
            else: R["wallet"] = w["id"]
        for k, lst, t in (("dept", S["depts"], "подразделение"), ("cf", S["cfTypes"], "тип расхода CF"), ("zone", S["zones"], "зона ответственности")):
            if not R[k]:
                continue
            x = find_ref(lst, R[k])
            if x:
                R[k] = x["id"]
            else:
                warns.append({"row": n, "msg": f"{t} «{R[k]}» нет в справочнике — строка загрузится, ссылка подтянется после загрузки справочника (ТР-17)"})
                R[k] = "?" + R[k]
        rows.append(R)
    by_g = {}
    for R in rows:
        if R["guid"]:
            by_g.setdefault(R["guid"], []).append(R)
    for g, lst in by_g.items():
        h = lambda R: (R["type"], R["no"], R["date"], R["orgR"] and R["orgR"]["id"], R["accR"] and R["accR"]["id"], R["status"], R["approved"], R["bank"], R["op"])
        if len({h(R) for R in lst}) > 1:
            for R in lst:
                R["errs"].append("дубль GUID")
                errors.append({"row": R["n"], "msg": f"дубль GUID «{g}»: строки одного документа с разными реквизитами"})
    all_orgs = list(dict.fromkeys(R["orgR"]["id"] for R in rows if R["orgR"]))
    dates = sorted(R["date"] for R in rows if R["date"])
    sel = p.get("sel") or {}
    sel = {"orgs": [o for o in sel.get("orgs", all_orgs) if o in all_orgs] if p.get("sel") else list(all_orgs),
           "from": sel.get("from") if valid_iso(sel.get("from")) else (dates[0] if dates and not p.get("sel") else ""),
           "to": sel.get("to") if valid_iso(sel.get("to")) else (dates[-1] if dates and not p.get("sel") else "")}
    sel_orgs = set(sel["orgs"])
    st = S["settings"]
    docs = {}
    for R in rows:
        if R["errs"]:
            continue
        if R["orgR"]["id"] not in sel_orgs or (sel["from"] and R["date"] < sel["from"]) or (sel["to"] and R["date"] > sel["to"]):
            skip_out.append({"row": R["n"], "guid": R["guid"], "why": "вне выбранных организаций или дат"}); continue
        if st.get("startDate") and R["date"] < st["startDate"]:
            skip_out.append({"row": R["n"], "guid": R["guid"], "why": f"раньше начала учёта {fmt_d(st['startDate'])} (ТР-21)"}); continue
        sw = st.get("switchDate")
        before_switch = not sw or R["date"] < sw
        if R["type"] in ("ПБДС", "ПКО") and before_switch:
            skip_out.append({"row": R["n"], "guid": R["guid"], "why": "поступления до даты перехода на автообмен вводятся вручную"}); continue
        if R["op"] and norm(R["op"]) in excl and before_switch:
            skip70.append({"row": R["n"], "guid": R["guid"], "op": R["op"], "sum": R["sum"], "cur": R["accR"]["cur"], "org": R["orgR"]["id"]}); continue
        d = docs.get(R["guid"])
        if not d:
            d = {"guid": R["guid"], "source": "file", "type": R["type"], "op": R["op"], "no1c": R["no"], "date": R["date"], "date1c": "", "org": R["orgR"]["id"],
                 "acc": R["accR"]["id"], "cur": R["accR"]["cur"], "status": R["status"], "statusRaw": R["statusRaw"],
                 "approved": R["approved"] if R["type"] == "СБДС" else True, "bankDone": R["bank"] if R["type"] == "СБДС" else False,
                 "bankDate": (R["bankDate"] or "") if R["type"] == "СБДС" and R["bank"] else "", "lines": []}
            docs[R["guid"]] = d
        d["lines"].append({"sum": r2(R["sum"]), "usd": r2(R["usd"]), "fileWallet": R["wallet"], "wallet": R["wallet"], "wsrc": "file" if R["wallet"] else None, "rule": None,
                           "dept": R["dept"], "cf": R["cf"], "zone": R["zone"], "cpty": R["cpty"], "contract": R["contract"], "purpose": R["purpose"]})
    add, upd, same, exc, closed = [], [], [], [], []
    existing = {d["guid"]: d for d in S["docs"] if d["source"] == "file"}
    for d in docs.values():
        e = existing.get(d["guid"])
        d["sig"] = doc_sig(d)
        if not e:
            add.append(d)
            if in_closed(C, d["date"]): closed.append(d["guid"])
        elif e.get("fileSig") == d["sig"] and not e.get("excluded"):
            same.append(d)
        else:
            upd.append((d, e))
            if in_closed(C, e["date"]) or in_closed(C, d["date"]): closed.append(d["guid"])
    for e in existing.values():
        if e.get("excluded") or e["guid"] in docs:
            continue
        if e["org"] in sel_orgs and (not sel["from"] or e["date"] >= sel["from"]) and (not sel["to"] or e["date"] <= sel["to"]):
            exc.append(e)
            if in_closed(C, e["date"]): closed.append(e["guid"])
    pv = {"errors": errors, "warns": warns, "skip70": skip70, "skipOut": skip_out, "add": [d["guid"] for d in add], "upd": [d["guid"] for d, _ in upd],
          "same": [d["guid"] for d in same], "closed": closed, "allOrgs": all_orgs, "rows": len(rows), "sel": sel,
          "exc": [{"date": e["date"], "type": e["type"], "no1c": e["no1c"], "guid": e["guid"], "cur": e["cur"], "total": r2(sum(l["sum"] for l in e["lines"]))} for e in exc]}
    return pv, {"add": add, "upd": upd, "exc": exc, "same": same, "sel": sel}


def apply_exp(C, u, p, file_name):
    need_admin(u)
    pv, work = preview_exp(C, p)
    if pv["errors"]:
        raise ApiError(["Файл с ошибками целиком не загружается (ТР-63)."])
    now = now_iso()
    src = f"файл {file_name}"

    def closed_note(d, diff):
        if in_closed(C, d["date"]):
            C.st.add("closedChanges", {"id": None, "t": now, "docId": d["id"], "docNo": f"{d['type']} {d['no1c']} ({d['guid']})", "date": d["date"], "diff": diff, "seen": []})
    from .util import uid
    for n in work["add"]:
        d = dict(n, id=uid("D"), no="", excluded=False, deleted=False, versions=[], loaded=now, fileName=file_name, fileSig=n["sig"], author="", created=now)
        d.pop("sig", None)
        apply_rules(C, d)
        C.st.add("docs", d)
        closed_note(d, "новый документ")
    for n, e in work["upd"]:
        before = doc_snap(C, e)
        keep = len(e["lines"]) == len(n["lines"])
        lines = []
        for i, l in enumerate(n["lines"]):
            o = e["lines"][i] if i < len(e["lines"]) else None
            if not l.get("fileWallet") and keep and o and line_sig(o) == line_sig(l) and o.get("wallet") and o.get("wsrc") != "rule":
                lines.append(dict(l, wallet=o["wallet"], wsrc=o["wsrc"], rule=o.get("rule")))
            else:
                lines.append(dict(l))
        for k in ("type", "op", "no1c", "date", "org", "acc", "cur", "status", "statusRaw", "approved", "bankDone", "bankDate"):
            e[k] = n[k]
        e.update(lines=lines, excluded=False, loaded=now, fileName=file_name, fileSig=n["sig"])
        apply_rules(C, e)
        C.st.save("docs", e)
        after = doc_snap(C, e)
        from .logic import diff_text
        add_version(C, "doc", e, before, after, src, u)
        closed_note(e, diff_text(before, after))
    for e in work["exc"]:
        before = doc_snap(C, e)
        e["excluded"] = True
        C.st.save("docs", e)
        add_version(C, "doc", e, before, doc_snap(C, e), src + " — нет в файле", u)
        closed_note(e, "исключён: нет в загрузке")
    sel = work["sel"]
    C.st.add("exchangeLog", {"id": None, "t": now, "u": u["id"], "kind": KIND_NAMES["exp"], "file": file_name, "added": len(work["add"]), "updated": len(work["upd"]),
                             "excluded": len(work["exc"]), "errors": 0,
                             "text": f"Организации: {', '.join(nm(C.get('orgs', o)) for o in sel['orgs'])}; период {fmt_d(sel['from'])}–{fmt_d(sel['to'])}; "
                                     f"без изменений: {len(work['same'])}; пропущено по ТР-70: {len(pv['skip70'])}" + (f"; предупреждений: {len(pv['warns'])}" if pv["warns"] else "")})
    C.st.audit(u, "Загрузка файла", file_name, f"документы: добавлено {len(work['add'])}, изменено {len(work['upd'])}, исключено {len(work['exc'])}, без изменений {len(work['same'])}")
    return {"added": len(work["add"]), "updated": len(work["upd"]), "excluded": len(work["exc"])}


# ======================= справочники и курсы =======================
def ref_kind_by_sheet(name):
    s = norm(name)
    if "курс" in s: return "rates"
    if "валют" in s: return "currencies"
    if "касс" in s: return "cashboxes"
    if "счет" in s: return "accounts"
    if "подразд" in s: return "depts"
    if "зон" in s: return "zones"
    if "организац" in s: return "orgs"
    if "тип" in s or "cf" in s or "стат" in s: return "cfTypes"
    return ""


def preview_ref(C, p):
    sheets = _sheets(p)
    errors, warns, stats = [], [], {}
    T = {k: json.loads(json.dumps(C.S[k])) for k in REF_ORDER}
    marked = [(s_, (p.get("refKind") or ref_kind_by_sheet(s_["name"])) if len(sheets) == 1 else ref_kind_by_sheet(s_["name"])) for s_ in sheets]
    for kind in REF_ORDER:
        for s_, k in marked:
            if k != kind:
                continue
            K = REF_KINDS[kind]
            hi, m, missing = map_header(s_["rows"], K["spec"])
            st = stats.setdefault(kind, {"name": K["name"], "add": 0, "upd": 0, "same": 0, "sheet": s_["name"]})
            miss = [x for x in missing if x in K["req"]]
            if miss:
                errors.append({"row": hi + 1, "msg": f"Лист «{s_['name']}»: нет колонок {', '.join(K['spec'][x][0] for x in miss)}"}); continue
            for i, r in enumerate(s_["rows"][hi + 1:]):
                if not r or not any(txt(c) for c in r):
                    continue
                n = hi + 2 + i
                g = lambda key: cell(r, m, key)

                def E(msg, n=n, s_=s_):
                    errors.append({"row": n, "msg": f"«{s_['name']}»: {msg}"})
                if kind == "rates":
                    c, d, rate = find_ref(T["currencies"], g("cur")), parse_date(g("date")), parse_num(g("rate"))
                    if not c: E(f"неизвестная валюта «{txt(g('cur'))}»"); continue
                    if not d: E("неверная дата"); continue
                    if not (math.isfinite(rate) and rate > 0): E("курс должен быть больше нуля"); continue
                    ex = next((x for x in T["rates"] if x["cur"] == c["id"] and x["date"] == d), None)
                    if not ex: T["rates"].append({"cur": c["id"], "date": d, "rate": rate}); st["add"] += 1
                    elif ex["rate"] != rate: ex["rate"] = rate; st["upd"] += 1
                    else: st["same"] += 1
                    continue
                id_ = txt(g("id"))
                if not id_: E("пустой идентификатор"); continue
                item = {"id": id_, "name": txt(g("name")) or id_}
                if kind == "currencies":
                    code = txt(g("code"))
                    item["code"] = code or (item["name"].upper() if len(item["name"]) == 3 and item["name"].isascii() and item["name"].isalpha()
                                            else id_.upper() if len(id_) == 3 and id_.isascii() and id_.isalpha() else "")
                if kind in ("accounts", "cashboxes"):
                    o, c = find_ref(T["orgs"], g("org")), find_ref(T["currencies"], g("cur"))
                    if not o: E(f"неизвестная организация «{txt(g('org'))}»"); continue
                    if not c: E(f"неизвестная валюта «{txt(g('cur'))}»"); continue
                    item["org"], item["cur"] = o["id"], c["id"]
                    if kind == "accounts":
                        item["bank"] = txt(g("bank"))
                        item["accType"] = "Депозитный" if "депоз" in txt(g("accType")).lower() else "Расчётный"
                if kind == "depts":
                    par = txt(g("parent"))
                    item["parent"] = ((find_ref(T["depts"], par) or {"id": par})["id"]) if par else ""
                dd = g("deact")
                if txt(dd):
                    d = parse_date(dd)
                    if not d: E("неверная дата деактивации"); continue
                    item["deactivated"] = d
                lst = T[kind]
                ex = next((x for x in lst if x["id"] == id_), None)
                if not ex:
                    full = {"deactivated": ""} | item
                    lst.append(full); st["add"] += 1
                elif any(ex.get(k2) != v for k2, v in item.items()):
                    ex.update(item); st["upd"] += 1
                else:
                    st["same"] += 1
    unknown = [s_["name"] for s_, k in marked if not k]
    if unknown:
        warns.append({"row": "—", "msg": f"Листы не распознаны и пропущены: {', '.join(unknown)}. Назовите лист по справочнику (Организации, Счета, Кассы, Валюты, Курсы, Типы расхода CF, Подразделения, Зоны)."})
    return {"errors": errors, "warns": warns, "stats": stats}, T


def apply_ref(C, u, p, file_name):
    need_admin(u)
    pv, T = preview_ref(C, p)
    if pv["errors"]:
        raise ApiError(["Файл с ошибками целиком не загружается (ТР-63)."])
    for kind in REF_ORDER:
        old = {(x["cur"], x["date"]) if kind == "rates" else x["id"]: x for x in C.S[kind]}
        for x in T[kind]:
            key = (x["cur"], x["date"]) if kind == "rates" else x["id"]
            if old.get(key) != x:
                if key in old:
                    old[key].clear(); old[key].update(x); C.st.save(kind, old[key])
                else:
                    C.st.add(kind, x)
    C.st.touch()
    fixed = 0
    for d in C.S["docs"]:
        changed = False
        for l in d.get("lines") or []:
            for k, coll in (("dept", "depts"), ("cf", "cfTypes"), ("zone", "zones")):
                v = l.get(k)
                if isinstance(v, str) and v.startswith("?"):
                    x = find_ref(C.S[coll], v[1:])
                    if x:
                        l[k] = x["id"]; fixed += 1; changed = True
        if d["source"] == "file" and not d.get("excluded"):
            if apply_rules(C, d):
                changed = True
        if changed:
            C.st.save("docs", d)
    st = list(pv["stats"].values())
    C.st.add("exchangeLog", {"id": None, "t": now_iso(), "u": u["id"], "kind": KIND_NAMES["ref"], "file": file_name, "added": sum(x["add"] for x in st),
                             "updated": sum(x["upd"] for x in st), "excluded": 0, "errors": 0,
                             "text": "; ".join(f"{x['name']}: +{x['add']}, изм. {x['upd']}" for x in st) + (f"; подтянуто ссылок в документах: {fixed}" if fixed else "")})
    C.st.audit(u, "Загрузка файла", file_name, "справочники: " + "; ".join(f"{x['name']} +{x['add']}/изм.{x['upd']}" for x in st))
    return {"stats": pv["stats"]}


# ======================= остатки 1С для сверки (ТР-65) =======================
def preview_bal(C, p):
    sh = _sheets(p)[0]
    hi, m, missing = map_header(sh["rows"], BAL_SPEC)
    errors, items = [], []
    miss = [k for k in missing if k != "cur"]
    if miss:
        return {"errors": [{"row": hi + 1, "msg": "Нет колонок: " + ", ".join(BAL_SPEC[k][0] for k in miss)}], "warns": [], "items": 0, "dates": []}, []
    accs = C.S["accounts"] + C.S["cashboxes"]
    for i, r in enumerate(sh["rows"][hi + 1:]):
        if not r or not any(txt(c) for c in r):
            continue
        n = hi + 2 + i
        g = lambda k: cell(r, m, k)
        a, d, sm = find_ref(accs, g("acc")), parse_date(g("date")), parse_num(g("sum"))
        if not a: errors.append({"row": n, "msg": f"неизвестный счёт или касса «{txt(g('acc'))}»"}); continue
        if not d: errors.append({"row": n, "msg": "неверная дата"}); continue
        if not math.isfinite(sm): errors.append({"row": n, "msg": "пустой или неверный остаток"}); continue
        if txt(g("cur")):
            c = find_ref(C.S["currencies"], g("cur"))
            if not c or c["id"] != a["cur"]:
                errors.append({"row": n, "msg": f"валюта «{txt(g('cur'))}» не совпадает с валютой счёта"}); continue
        items.append({"date": d, "acc": a["id"], "sum": r2(sm)})
    dates = sorted({x["date"] for x in items})
    return {"errors": errors, "warns": [], "items": len(items), "dates": dates}, items


def apply_bal(C, u, p, file_name):
    need_admin(u)
    pv, items = preview_bal(C, p)
    if pv["errors"]:
        raise ApiError(["Файл с ошибками целиком не загружается (ТР-63)."])
    add = upd = 0
    ix = {(b["date"], b["acc"]): b for b in C.S["bal1c"]}
    for it in items:
        ex = ix.get((it["date"], it["acc"]))
        if ex:
            if ex["sum"] != it["sum"]:
                ex["sum"] = it["sum"]; C.st.save("bal1c", ex); upd += 1
        else:
            C.st.add("bal1c", it); ix[(it["date"], it["acc"])] = it; add += 1
    C.st.touch()
    bad = sum(1 for r in recon(C) if r["date"] in pv["dates"] and abs(r["diff"]) >= 0.005)
    C.st.add("exchangeLog", {"id": None, "t": now_iso(), "u": u["id"], "kind": KIND_NAMES["bal"], "file": file_name, "added": add, "updated": upd, "excluded": 0,
                             "errors": 0, "text": f"Даты: {', '.join(fmt_d(d) for d in pv['dates'])}; счетов с расхождением: {bad}"})
    C.st.audit(u, "Загрузка файла", file_name, f"остатки 1С: добавлено {add}, изменено {upd}; расхождений {bad}")
    return {"added": add, "updated": upd, "bad": bad}


def preview(C, u, kind, p):
    need_admin(u)
    if kind == "exp":
        pv, _ = preview_exp(C, p)
    elif kind == "ref":
        pv, _ = preview_ref(C, p)
    elif kind == "bal":
        pv, _ = preview_bal(C, p)
    else:
        raise ApiError(["Неизвестный вид загрузки"])
    return pv


def log_rejected(C, u, kind, file_name, pv):
    """ТР-18: отклонённый файл тоже фиксируется — два подряд дают уведомление администратору."""
    errs = pv.get("errors") or []
    C.st.add("exchangeLog", {"id": None, "t": now_iso(), "u": u["id"], "kind": KIND_NAMES[kind], "file": file_name, "added": 0, "updated": 0, "excluded": 0,
                             "errors": len(errs), "text": "Файл отклонён: " + "; ".join(f"стр. {e['row']}: {e['msg']}" for e in errs[:20])})
    C.st.audit(u, "Загрузка файла отклонена", file_name, f"ошибок: {len(errs)}")
