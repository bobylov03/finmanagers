"""Загрузка файлов из 1С (ТР-60…67, ТР-70, ТР-72): документы, справочники и курсы, остатки для сверки.

Браузер читает .xlsx/.csv и присылает листы как таблицы значений; смысл строк, проверки,
сопоставление по GUID и запись делает сервер. Повторная загрузка того же файла ничего не меняет.
"""
import json

from .actions import ApiError, need_admin
from .logic import DOC_TYPES, acc_curs, add_version, apply_rules, cur_code, doc_snap, in_closed, is_usd, nm, recon, to_usd
from .util import fmt, fmt_d, norm, now_iso, parse_date, parse_num, r2, txt, valid_iso
import math

# Прежние форматы — только чтобы распознать и отклонить файл (ДР-03-21.10)
OLD_TR61_SPEC = {
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
OLD_TR61_REQ = ["guid", "type", "date", "org", "acc", "sum", "status"]
ID_AL = ["Идентификатор", "GUID", "ID", "Ид", "Код"]
REF_KINDS = {
    "currencies": {"name": "Валюты", "spec": {"id": ["Идентификатор", "GUID", "ID", "Код"], "name": ["Наименование"], "code": ["Символьный код", "Буквенный код", "Код ISO"]}, "req": ["id"]},
    "rates": {"name": "Курсы к USD", "spec": {"cur": ["Валюта"], "date": ["Дата"], "rate": ["Курс", "Курс к USD", "Единиц валюты за 1 USD"]}, "req": ["cur", "date", "rate"]},
    "orgs": {"name": "Организации", "spec": {"id": ID_AL, "name": ["Наименование"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
    "accounts": {"name": "Банковские счета", "spec": {"id": ID_AL, "name": ["Наименование"], "org": ["Организация"], "cur": ["Валюта"], "bank": ["Банк"],
                                                     "number": ["Номер счёта", "Номер счета", "Р/сч", "Р/с", "Расчётный счёт", "Расчетный счет"],
                                                     "accType": ["Вид счёта", "Вид счета", "Вид"], "deact": ["Дата деактивации"]}, "req": ["id", "name", "org", "cur"]},
    "cashboxes": {"name": "Кассы", "spec": {"id": ID_AL, "name": ["Наименование"], "org": ["Организация"], "cur": ["Валюта"], "deact": ["Дата деактивации"]}, "req": ["id", "name", "org", "cur"]},
    "cfTypes": {"name": "Типы расхода CF", "spec": {"id": ID_AL, "name": ["Наименование"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
    "depts": {"name": "Подразделения", "spec": {"id": ID_AL, "name": ["Наименование"], "parent": ["Родитель", "Вышестоящее подразделение"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
    "zones": {"name": "Зоны ответственности", "spec": {"id": ID_AL, "name": ["Наименование"], "deact": ["Дата деактивации"]}, "req": ["id", "name"]},
}
REF_ORDER = ["currencies", "rates", "orgs", "accounts", "cashboxes", "cfTypes", "depts", "zones"]
BAL_SPEC = {"date": ["Дата"], "acc": ["Счёт или касса", "Счет или касса", "Счёт", "Счет", "Касса", "Банковский счёт"], "cur": ["Валюта"],
            "sum": ["Остаток", "Остаток в валюте", "Сумма"]}
KIND_NAMES = {"exp": "Документы 1С", "ref": "Справочники и курсы", "bal": "Остатки 1С", "flags": "Признаки документов ERP"}


def _match(row, spec):
    head = [norm(c) for c in row]
    m = {}
    for k, al in spec.items():
        for i, h in enumerate(head):
            if h and any(norm(a) == h for a in al):
                m[k] = i
                break
    return m


def map_header(rows, spec):
    """Строка заголовков — первая непустая или, если в начале листа есть заголовок отчёта и строка номеров колонок
    (выгрузка ERP), та из первых 20 строк, где совпало больше всего колонок."""
    first = next((i for i, r in enumerate(rows) if r and any(txt(c) for c in r)), -1)
    if first < 0:
        return -1, {}, list(spec)
    hi, m = first, _match(rows[first], spec)
    for i in range(first + 1, min(len(rows), first + 20)):
        mi = _match(rows[i] or [], spec)
        if len(mi) > len(m):
            hi, m = i, mi
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


def norm_bool(v):
    return v is True or norm(v) in ("да", "1", "true", "истина", "x", "yes", "проведено")


# ДР-03-21.10: значения признаков — только из закрытого списка; по ключевым словам и «по смыслу» не определяются
TRUE_W = {"да", "1", "true", "истина", "yes"}
FALSE_W = {"нет", "0", "false", "ложь", "no"}


def tri(v):
    """Признак ERP: True / False / None (пусто — «Нет данных», ДР-05). Неизвестное значение — ValueError."""
    if v is True or v is False:
        return v
    if v is None or txt(v) == "" or norm(v) in ("нетданных", "—", "-"):
        return None
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    k = norm(v)
    if k in TRUE_W:
        return True
    if k in FALSE_W:
        return False
    raise ValueError(txt(v))


def status_flags(v):
    """«Проведён» ERP → (проведён, помечен на удаление): Да / Нет / Проведён / Не проведён / Распроведён / Помечен на удаление — точным значением.
    Распроведённый — «Не проведён» (ДР-04)."""
    if v is None or txt(v) == "":
        return None, None
    k = norm(v).replace("ё", "е")
    if k == "помеченнаудаление":
        return False, True
    if k in ("непроведен", "распроведен") or k in FALSE_W:
        return False, False
    if k == "проведен" or k in TRUE_W:
        return True, False
    raise ValueError(txt(v))


def flags_fill(C, guid, f):
    """Признаки из файла дополняются последними признаками ERP, полученными отдельно по GUID (ДР-05, ДР-06)."""
    x = C.get("erpFlags", guid) if guid else None
    base = (x or {}).get("flags") or {}
    return {k: (f.get(k) if f.get(k) is not None else base.get(k)) for k in ("posted", "approved", "deleted", "bank")}


def doc_sig(d):
    fl = d.get("flagsFile") or {}   # признаки из самого файла; полученные отдельной загрузкой не делают файл «изменённым»
    return json.dumps([d["type"], d["op"], d["no1c"], d["date"], d["org"], d["acc"], d["cur"], d["status"] if d.get("fmt") != "erp17" else "", [fl.get(k) for k in ("posted", "approved", "deleted", "bank")],
                       d.get("bankDate") or "", d.get("stage") or "", d.get("erpType") or "", d.get("docSum"), d.get("rate"),
                       d.get("bankName") or "", d.get("accNo") or "",
                       [[l["sum"], l["usd"], l.get("fileWallet") or "", l["dept"], l["cf"], l["zone"], l["cpty"], l["contract"], l["purpose"]]
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
# ТР-90: отчёт ERP «История согласования» — 19 полей отчёта + 20-е «Тип расхода CF». Основной формат файла расходов.
OLD_HIST_SPEC = {
    "sum": ["Сумма"], "type": ["Тип"], "dept": ["Подразделение"], "purpose": ["Заметки"], "cpty": ["Получатель"], "org": ["Организация"],
    "acc": ["Банк"], "cur": ["Валюта"], "docSum": ["Сумма документа"], "rate": ["Курс"], "zone": ["Зона ответственности"],
    "stage": ["Текущий этап"], "state": ["Текущее состояние"], "no": ["Номер ERP"], "guid": ["GUID ERP"], "erpType": ["Тип документа ERP"],
    "date": ["Дата документа ERP"], "bankDate": ["Дата проведения банком"], "op": ["Хозяйственная операция"], "cf": ["Тип расхода CF"],
}
OLD_HIST_REQ = ["sum", "type", "org", "acc", "cur", "docSum", "stage", "state", "guid", "date"]
HIST_HEAD = ["Сумма", "Тип", "Подразделение", "Заметки", "Получатель", "Организация", "Банк", "Валюта", "Сумма документа", "Курс",
             "Зона ответственности", "Текущий этап", "Текущее состояние", "Номер ERP", "GUID ERP", "Тип документа ERP", "Дата документа ERP",
             "Дата проведения банком", "Хозяйственная операция", "Тип расхода CF"]
# ТР-90 (v1.5.1): готовый отчёт ERP «История согласования» — 17 полей в утверждённом порядке. Этапа и состояния в отчёте нет:
# признаки согласования, проведения и пометки на удаление приходят отдельно (ТР-91); «Банк» — банк, «Р/сч» — номер счёта.
HIST17_SPEC = {
    "guid": ["GUID документа (ERP)", "GUID документа ERP"], "no": ["Номер документа (ERP)", "Номер документа ERP"], "date": ["Дата документа (ERP)", "Дата документа ERP"],
    "usd": ["Сумма (USD)", "Сумма USD"], "cf": ["Тип расхода CF"], "dept": ["Подразделение"], "purpose": ["Заметки"], "cpty": ["Получатель"],
    "org": ["Организация"], "bank": ["Банк"], "accNo": ["Р/сч", "Р/с", "Расчётный счёт", "Расчетный счет", "Номер счёта"], "cur": ["Валюта"],
    "docSum": ["Сумма в валюте документа"], "rate": ["Курс"], "bankDate": ["Дата проведения банком"], "op": ["Хозяйственная операция"],
    "erpType": ["Тип документа ERP"],
}
# ДР-05…07: отдельная загрузка признаков документов ERP по GUID (до интеграции с ERP — файлом)
FLAGS_SPEC = {"guid": ["GUID документа (ERP)", "GUID документа ERP", "GUID ERP", "GUID документа", "GUID"],
              "posted": ["Проведён", "Проведен", "Статус", "Состояние проведения"], "approved": ["Согласован"],
              "deleted": ["Помечен на удаление", "Пометка удаления"], "bank": ["Проведено банком", "Признак проведено банком", "Исполнен банком"]}
FLAGS_HEAD = ["GUID документа (ERP)", "Проведён", "Согласован", "Помечен на удаление", "Проведено банком"]
HIST17_REQ = ["guid", "no", "date", "org", "accNo", "cur", "docSum"]
HIST17_HEAD = ["GUID документа (ERP)", "Номер документа (ERP)", "Дата документа (ERP)", "Сумма (USD)", "Тип расхода CF", "Подразделение", "Заметки",
               "Получатель", "Организация", "Банк", "Р/сч", "Валюта", "Сумма в валюте документа", "Курс", "Дата проведения банком",
               "Хозяйственная операция", "Тип документа ERP"]
FIELD_NAMES = {"guid": "GUID", "accNo": "Р/сч", "bank": "банк", "type": "тип", "op": "хоз. операция", "no": "номер ERP", "date": "дата", "org": "организация", "acc": "счёт",
               "cur": "валюта", "status": "состояние", "stage": "этап", "state": "состояние ERP", "approved": "согласование", "bankDate": "дата проведения банком",
               "sum": "сумма", "usd": "сумма USD", "docSum": "сумма документа", "rate": "курс", "dept": "подразделение", "cf": "тип расхода CF",
               "zone": "зона", "cpty": "получатель", "contract": "договор", "purpose": "назначение", "erpType": "тип документа ERP", "wallet": "кошелёк"}
REF_FIELDS = {"org": "orgs", "acc": "accs", "cur": "currencies", "dept": "depts", "cf": "cfTypes", "zone": "zones"}
NO_FIX = ("bankDate", "status", "approved", "deletedMark", "bankDone", "bank")   # ДР-05: признаки ERP и дата проведения банком — только из ERP
SIGNIFICANT = ("counted", "date", "org", "acc", "cur", "sum", "dept", "cf", "zone", "cpty")   # ТР-85: влияют на движение и распределение


def mapped(C, kind, v):
    """ТР-109: запомненное сопоставление названия из файла со справочником."""
    if v is None or txt(v) == "":
        return None
    m = C.get_map(kind, norm(v)) if hasattr(C, "get_map") else next((x for x in C.S["mappings"] if x["kind"] == kind and x["rawNorm"] == norm(v)), None)
    return m["target"] if m else None


def _digits(v):
    return "".join(ch for ch in txt(v) if ch.isdigit())


def acc_by_number(accs, no, org=None):
    """ТР-90: счёт по «Р/сч» — номер счёта из справочника; если номера в справочнике нет — однозначное вхождение номера в наименование."""
    d = _digits(no)
    if len(d) < 4:
        return None
    pool = [a for a in accs if not org or a.get("org") == org["id"]] or accs
    exact = [a for a in pool if _digits(a.get("number")) == d]
    if len(exact) == 1:
        return exact[0]
    inname = [a for a in pool if d in _digits(a.get("name")) or (len(d) >= 8 and _digits(a.get("name")) and _digits(a.get("name")).endswith(d[-8:]))]
    return inname[0] if len(inname) == 1 else None


def name_matches(lst, v):
    return [x for x in lst if norm(x.get("name")) == norm(v)] if txt(v) else []


def ref_lookup(C, kind, lst, v, hit=None):
    """Идентификатор → запомненное сопоставление (ТР-109) → однозначное совпадение по названию (ТР-90, поле 7) → код."""
    if v is None or txt(v) == "":
        return None
    s_ = txt(v)
    x = next((y for y in lst if y.get("id") == s_), None)
    if x:
        return x
    t = mapped(C, kind, v)
    if t:
        x = next((y for y in lst if y["id"] == t), None)
        if x:
            if hit is not None:
                hit.append(kind)
            return x
    by_name = name_matches(lst, v)
    if len(by_name) == 1:
        return by_name[0]
    if len(by_name) > 1:
        return None   # неоднозначно — ошибка в реестре, выбрать из справочника
    return next((y for y in lst if y.get("code") and norm(y["code"]) == norm(s_)), None)


def _num(v):
    return parse_num(v) if txt(v) != "" else float("nan")


def preview_exp(C, p):
    sheets = _sheets(p)
    fixes = p.get("fixes") or {}
    # лист с данными ищется по заголовкам: в книге могут быть листы-пояснения
    ok_ = lambda s_, spec, req: not [k for k in map_header(s_["rows"], spec)[2] if k in req]
    # ДР-03-21.10: принимается только утверждённый отчёт из 17 столбцов (ТР-90); прежние форматы отклоняются без изменения данных
    fmt_ = "erp17"
    SPEC, REQ = HIST17_SPEC, HIST17_REQ
    sh = next((s_ for s_ in sheets if ok_(s_, SPEC, REQ)), None)
    errors, warns, skip70, skip_out, registry = [], [], [], [], []
    empty = {"format": fmt_, "errors": errors, "warns": warns, "skip70": skip70, "skipOut": skip_out, "add": [], "upd": [], "same": [], "exc": [], "closed": [],
             "allOrgs": [], "rows": 0, "sel": p.get("sel"), "registry": [], "unmapped": [], "significant": [], "dup": []}
    if not sh:
        old = next((s_ for s_ in sheets if ok_(s_, OLD_HIST_SPEC, OLD_HIST_REQ) or ok_(s_, OLD_TR61_SPEC, OLD_TR61_REQ)), None)
        if old:
            empty["format"] = "unsupported"
            errors.append({"row": "—", "msg": "Формат файла не поддерживается: это прежний формат «Истории согласования» (с полями «Текущий этап» и «Текущее состояние») "
                                               "или формат ТР-61. Загрузите отчёт ERP «История согласования» из 17 столбцов (ТР-90). Ранее загруженные данные не изменены."})
            return empty, None
        sh = sheets[0]
    hi, m, missing = map_header(sh["rows"], SPEC)
    miss = [k for k in missing if k in REQ]
    if miss:
        errors.append({"row": hi + 1, "msg": "Нет обязательных колонок отчёта из 17 столбцов (ТР-90): " + ", ".join(SPEC[k][0] for k in miss)})
        return empty, None
    S = C.S
    accs = S["accounts"] + S["cashboxes"]
    excl = {norm(x) for x in S["settings"].get("excludedOps") or []}
    rate_form = S["settings"].get("rateForm") or "perUsd"
    rows = []
    for i, r in enumerate(sh["rows"][hi + 1:]):
        if not r or not any(txt(c) for c in r):
            continue
        first_txt = next((norm(c) for c in r if txt(c)), "")
        if first_txt.startswith("итого") or first_txt.startswith("всего"):
            continue   # строка итогов отчёта ERP
        n = hi + 2 + i
        fx = {k: v for k, v in (fixes.get(str(n)) or {}).items() if k not in NO_FIX}   # ДР-05: признаки и дата банка ERP не правятся
        raw = {k: (fx[k] if k in fx else cell(r, m, k)) for k in SPEC}
        g = lambda k: raw.get(k)
        R = {"n": n, "fmt": fmt_, "fixed": sorted(k for k in fx if k in SPEC), "raw": {k: ("" if v is None else str(v)) for k, v in raw.items()},
             "orig": {k: ("" if cell(r, m, k) is None else str(cell(r, m, k))) for k in fx if k in SPEC},
             "guid": txt(g("guid")), "type": norm_type(g("type")), "typeRaw": txt(g("type")), "op": txt(g("op")), "no": txt(g("no")),
             "date": parse_date(g("date")), "orgRaw": txt(g("org")), "accRaw": txt(g("acc")), "curRaw": txt(g("cur")),
             "bankDate": parse_date(g("bankDate")), "sum": parse_num(g("sum")), "wallet": None, "walletRaw": txt(g("wallet")),
             "dept": txt(g("dept")), "cf": txt(g("cf")), "zone": txt(g("zone")), "cpty": txt(g("cpty")), "contract": txt(g("contract")),
             "purpose": txt(g("purpose")), "erpType": txt(g("erpType")), "stage": "", "stateRaw": "",
             "errs": [], "warns": [], "bankName": txt(g("bank")), "accNo": txt(g("accNo"))}
        R["mapped"] = []
        R["orgR"] = ref_lookup(C, "org", S["orgs"], g("org"), R["mapped"])
        # счёт — по «Р/сч» (номер счёта из справочника), затем по запомненному сопоставлению, затем по названию
        R["accRaw"] = R["accNo"] or R["bankName"]
        R["accR"] = acc_by_number(accs, R["accNo"], R["orgR"]) or ref_lookup(C, "acc", accs, R["accRaw"], R["mapped"])
        R["type"] = norm_type(g("erpType")) or (("РКО" if any(c["id"] == R["accR"]["id"] for c in S["cashboxes"]) else "СБДС") if R["accR"] else "СБДС")
        R["typeRaw"] = txt(g("erpType"))
        R["sum"] = _num(g("docSum"))   # временно; строки одного документа делятся по «Сумма (USD)» ниже (ТР-54)

        def E(msg, f=None, R=R, n=n):
            R["errs"].append({"f": f, "msg": msg}); errors.append({"row": n, "msg": msg})
        if not R["guid"]: E("пустой GUID документа", "guid")
        if not R["type"]: E(f"неизвестный тип «{R['typeRaw']}» — ожидается СБДС или РКО", "type")
        if not R["date"]: E("неверная дата", "date")
        if not R["orgR"]:
            amb = name_matches(S["orgs"], g("org"))
            E(f"организация «{R['orgRaw']}» неоднозначна: {len(amb)} совпадения в справочнике — выберите" if len(amb) > 1 else f"неизвестная организация «{R['orgRaw']}»", "org")
        if not R["accR"]:
            amb = name_matches(accs, R["accRaw"])
            E(f"счёт «{R['accRaw']}» неоднозначен: {len(amb)} счёта с таким названием — выберите из справочника (ТР-90)" if len(amb) > 1 else f"неизвестный счёт или касса «{R['accRaw']}»", "acc")
        if R["accR"] and R["orgR"] and R["accR"]["org"] != R["orgR"]["id"]:
            E(f"счёт «{R['accR']['name']}» не принадлежит организации «{R['orgR']['name']}»", "acc")
        if R["accR"] and R["type"]:
            is_cash = any(c["id"] == R["accR"]["id"] for c in S["cashboxes"])
            if DOC_TYPES[R["type"]]["cash"] and not is_cash: E(f"{R['type']} должен быть по кассе", "acc")
            if not DOC_TYPES[R["type"]]["cash"] and is_cash: E(f"{R['type']} должен быть по банковскому счёту", "acc")
        R["cur"] = None
        if R["curRaw"]:
            c = ref_lookup(C, "cur", S["currencies"], R["curRaw"], R["mapped"])
            if not c: E(f"неизвестная валюта «{R['curRaw']}»", "cur")
            elif R["accR"] and c["id"] not in acc_curs(R["accR"]): E(f"валюты {R['curRaw']} нет у счёта «{R['accR']['name']}» ({', '.join(cur_code(C, x) for x in acc_curs(R['accR']))})", "cur")
            else: R["cur"] = c["id"]
        elif R["accR"]:
            if len(acc_curs(R["accR"])) == 1: R["cur"] = acc_curs(R["accR"])[0]
            else: E("не указана валюта мультивалютного счёта", "cur")
        if math.isfinite(R["sum"]) and R["sum"] <= 0: E("сумма должна быть больше нуля", "docSum")
        # ДР-03-21.10, ДР-06, ДР-07: в 17 столбцах признаков нет — состояние по тексту или по наличию в отчёте не определяется;
        # признаки «Проведён», «Согласован», «Помечен на удаление», «Проведено банком» — только из отдельной загрузки по GUID
        R["flagsFile"] = {}
        R["docSum"] = _num(g("docSum"))
        if not math.isfinite(R["docSum"]): E("пустая или неверная сумма в валюте документа", "docSum")
        rr = _num(g("rate"))
        R["rate"] = None
        if math.isfinite(rr) and rr > 0:
            R["rate"] = rr if rate_form == "perUsd" else 1 / rr
        elif txt(g("rate")) != "":
            E("неверный курс", "rate")
        R["usdRaw"] = g("usd")
        R["flags"] = flags_fill(C, R["guid"], {})
        f_ = R["flags"]
        R["status"] = "Помечен на удаление" if f_["deleted"] else "Проведён" if f_["posted"] else "Не проведён" if f_["posted"] is False else ""
        R["approved"] = f_["approved"]
        R["usd"] = None
        if R.get("usdRaw") not in (None, "") and txt(R["usdRaw"]) != "":
            R["usd"] = parse_num(R["usdRaw"])
            if not math.isfinite(R["usd"]): E("неверная сумма в USD", "usd")
        elif R["cur"] and R["date"] and math.isfinite(R["sum"]):
            R["usd"] = to_usd(C, R["sum"], R["cur"], R["date"], R.get("rate"))
            if R["usd"] is None: E(f"нет курса в файле и нет курса ERP {cur_code(C, R['cur'])} на {fmt_d(R['date'])}", "rate")
        if R["walletRaw"]:
            w = find_ref(S["wallets"], R["walletRaw"])
            if not w: E(f"неизвестный кошелёк «{R['walletRaw']}»", "wallet")
            else: R["wallet"] = w["id"]
        for k, kind, lst, t in (("dept", "dept", S["depts"], "подразделение"), ("cf", "cf", S["cfTypes"], "тип расхода CF"), ("zone", "zone", S["zones"], "зона ответственности")):
            if not R[k]:
                continue
            x = ref_lookup(C, kind, lst, R[k], R["mapped"])
            if x:
                R[k] = x["id"]
            else:
                warns.append({"row": n, "msg": f"{t} «{R[k]}» нет в справочнике — строка загрузится, ссылка подтянется после загрузки справочника (ТР-17)"})
                R["warns"].append({"f": k, "msg": f"{t} «{R[k]}» нет в справочнике"})
                R[k] = "?" + R[k]
        rows.append(R)
    # дубли GUID и контроль «сумма строк = сумме документа» (ТР-90, поле 9)
    by_g = {}
    for R in rows:
        if R["guid"]:
            by_g.setdefault(R["guid"], []).append(R)
    for g_, lst in by_g.items():
        h = lambda R: (R["type"], R["no"], R["date"], R["orgR"] and R["orgR"]["id"], R["accR"] and R["accR"]["id"], R["cur"], R["status"],
                       json.dumps(R.get("flags"), sort_keys=True), R["op"],
                       R["bankDate"], None if not math.isfinite(R.get("docSum", float("nan"))) else R["docSum"])
        if len({h(R) for R in lst}) > 1:
            for R in lst:
                R["errs"].append({"f": "guid", "msg": "дубль GUID: строки одного документа с разными реквизитами"})
                errors.append({"row": R["n"], "msg": f"дубль GUID «{g_}»: строки одного документа с разными реквизитами"})
        if lst[0]["fmt"] == "erp17" and not any(R["errs"] for R in lst):
            # ТР-54: строки одного документа — суммы строк в валюте документа; в отчёте ERP сумма в валюте одна на документ,
            # поэтому при нескольких строках она делится пропорционально «Сумма (USD)» строк, остаток копеек — в последнюю строку
            ds = r2(lst[0]["docSum"])
            if len(lst) == 1:
                lst[0]["sum"] = ds
            else:
                us = [R["usd"] for R in lst]
                if all(u is not None and math.isfinite(u) and u > 0 for u in us):
                    tot_u, acc_ = sum(us), 0.0
                    for j, R in enumerate(lst):
                        R["sum"] = r2(ds - acc_) if j == len(lst) - 1 else r2(ds * us[j] / tot_u)
                        acc_ += R["sum"]
                        R["warns"].append({"f": "sum", "msg": f"сумма строки {fmt(R['sum'])} — доля документа {fmt(ds)} по «Сумма (USD)» (ТР-54)"})
                else:
                    for R in lst:
                        R["errs"].append({"f": "usd", "msg": "несколько строк одного документа: для распределения суммы нужна «Сумма (USD)» в каждой строке (ТР-54)"})
                        errors.append({"row": R["n"], "msg": f"GUID «{g_}»: нет «Сумма (USD)» для распределения по строкам"})
            continue
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
        R["st"] = "error" if R["errs"] else None
        if R["errs"]:
            continue
        if R["orgR"]["id"] not in sel_orgs or (sel["from"] and R["date"] < sel["from"]) or (sel["to"] and R["date"] > sel["to"]):
            R["st"], R["why"] = "skipped", "вне выбранных организаций или дат"
            skip_out.append({"row": R["n"], "guid": R["guid"], "why": R["why"]}); continue
        if st.get("startDate") and R["date"] < st["startDate"]:
            R["st"], R["why"] = "skipped", f"раньше начала учёта {fmt_d(st['startDate'])} (ТР-21)"
            skip_out.append({"row": R["n"], "guid": R["guid"], "why": R["why"]}); continue
        sw = st.get("switchDate")
        before_switch = not sw or R["date"] < sw
        if R["type"] in ("ПБДС", "ПКО") and before_switch:
            R["st"], R["why"] = "skipped", "поступления до даты перехода на автообмен вводятся вручную (ТР-72)"
            skip_out.append({"row": R["n"], "guid": R["guid"], "why": R["why"]}); continue
        # ДР-01: вид хоз. операции — повод проверить двойной учёт, а не основание пропустить документ
        R["ctl"] = bool(R["op"] and norm(R["op"]) in excl and before_switch)
        d = docs.get(R["guid"])
        if not d:
            d = {"guid": R["guid"], "source": "file", "fmt": R["fmt"], "type": R["type"], "op": R["op"], "no1c": R["no"], "date": R["date"], "date1c": "",
                 "org": R["orgR"]["id"], "acc": R["accR"]["id"], "cur": R["cur"], "status": R["status"], "statusRaw": R["stateRaw"], "stage": R["stage"],
                 "erpType": R["erpType"], "approved": R["flags"]["approved"] is True if R["type"] == "СБДС" else True,
                 "flags": dict(R["flags"], v=1) if R["type"] == "СБДС" else dict(R["flags"], v=1, bank=None),   # ДР-05: «Проведено банком» — только у СБДС
                 "bankDone": R["flags"]["bank"] is True if R["type"] == "СБДС" else False,   # ДР-05: отдельный признак, не по дате
                 "bankDate": (R["bankDate"] or "") if R["type"] == "СБДС" else "",
                 "docSum": r2(R["docSum"]) if math.isfinite(R.get("docSum", float("nan"))) else None, "rate": R.get("rate"), "lines": [], "_rows": [], "fixed": [],
                 "bankName": R.get("bankName") or "", "accNo": R.get("accNo") or "", "flagsFile": R.get("flagsFile") or {}}
            docs[R["guid"]] = d
        d["_rows"].append(R)
        d["fixed"] += [f for f in R["fixed"] if f in ("type", "op", "no", "date", "org", "acc", "cur", "stage", "state", "status", "bankDate", "docSum", "rate", "erpType", "guid")]
        d["lines"].append({"sum": r2(R["sum"]), "usd": r2(R["usd"]), "fileWallet": R["wallet"], "wallet": R["wallet"], "wsrc": "file" if R["wallet"] else None, "rule": None,
                           "dept": R["dept"], "cf": R["cf"], "zone": R["zone"], "cpty": R["cpty"], "contract": R["contract"], "purpose": R["purpose"],
                           "fixed": [f for f in R["fixed"] if f in ("sum", "dept", "cf", "zone", "cpty", "purpose", "contract", "usd", "wallet")]})
    add, upd, same, exc, closed, signif = [], [], [], [], [], []
    existing = {d["guid"]: d for d in S["docs"] if d["source"] == "file"}
    # ДР-01: сопоставление документов с контролируемыми хоз. операциями с ручными операциями
    taken = {(e.get("dup") or {}).get("manual"): g_ for g_, e in existing.items() if (e.get("dup") or {}).get("manual")}
    for d in sorted(docs.values(), key=lambda x: (x["date"], x["guid"])):
        if any(R.get("ctl") for R in d["_rows"]):
            d["dup"] = dup_result(C, d, existing.get(d["guid"]), {k for k, v in taken.items() if v != d["guid"]})
            if d["dup"].get("manual"):
                taken[d["dup"]["manual"]] = d["guid"]
            skip70.append(dup_row(C, d))
            for R in d["_rows"]:
                R["dup"] = d["dup"]
        else:
            d["dup"] = None
    for d in docs.values():
        d["fixed"] = sorted(set(d["fixed"]))
        e = existing.get(d["guid"])
        d["sig"] = doc_sig(d)
        if not e:
            add.append(d)
            for R in d["_rows"]: R["st"] = "new"
            if in_closed(C, d["date"]): closed.append(d["guid"])
        elif e.get("fileSig") == d["sig"] and not e.get("excluded") and json.dumps(e.get("dup") or None, sort_keys=True) == json.dumps(d["dup"], sort_keys=True):
            same.append(d)
            for R in d["_rows"]: R["st"] = "same"
        else:
            upd.append((d, e))
            ch_doc = doc_changes(C, e, d)
            if json.dumps(e.get("dup") or None, sort_keys=True) != json.dumps(d["dup"], sort_keys=True):
                ch_doc.append({"f": "dup", "before": DUP_NAMES.get((e.get("dup") or {}).get("st"), "—"), "after": DUP_NAMES.get((d["dup"] or {}).get("st"), "—")})
            for i, R in enumerate(d["_rows"]):
                R["st"] = "changed"
                R["changes"] = (ch_doc if i == 0 else []) + line_changes(C, e["lines"][i] if i < len(e["lines"]) else None, d["lines"][i], i)
            if len(e["lines"]) > len(d["lines"]):
                d["_rows"][0]["changes"].append({"f": "lines", "before": str(len(e["lines"])), "after": str(len(d["lines"]))})
            if is_significant(C, e, d) and would_count(C, d):
                signif.append(d["guid"])
            if in_closed(C, e["date"]) or in_closed(C, d["date"]): closed.append(d["guid"])
    for e in existing.values():
        if e.get("excluded") or e["guid"] in docs:
            continue
        if e["org"] in sel_orgs and (not sel["from"] or e["date"] >= sel["from"]) and (not sel["to"] or e["date"] <= sel["to"]):
            exc.append(e)
            if in_closed(C, e["date"]): closed.append(e["guid"])
    for R in rows:
        registry.append(reg_row(C, R))
    for e in exc:   # «Исключится» — построчно (ТР-62)
        for i, l in enumerate(e["lines"]):
            registry.append({"n": None, "st": "excluded", "guid": e["guid"], "no": e.get("no1c"), "type": e["type"], "date": e["date"], "org": e["org"], "acc": e["acc"],
                             "cur": e["cur"], "sum": l.get("sum"), "dept": l.get("dept"), "cf": l.get("cf"), "cpty": l.get("cpty"), "purpose": l.get("purpose"),
                             "state": e.get("status"), "why": "документа нет в файле за выбранный период", "errs": [], "warns": [], "fixed": [], "raw": {}})
    pv = {"format": fmt_, "errors": errors, "warns": warns, "skip70": [], "dup": skip70, "skipOut": skip_out, "add": [d["guid"] for d in add], "upd": [d["guid"] for d, _ in upd],
          "same": [d["guid"] for d in same], "closed": closed, "allOrgs": all_orgs, "rows": len(rows), "sel": sel, "registry": registry,
          "unmapped": [], "significant": signif,
          "exc": [{"date": e["date"], "type": e["type"], "no1c": e["no1c"], "guid": e["guid"], "cur": e["cur"], "total": r2(sum(l["sum"] for l in e["lines"]))} for e in exc]}
    return pv, {"add": add, "upd": upd, "exc": exc, "same": same, "sel": sel, "rows": rows}


DUP_DAYS = 3   # ДР-01: окно дат при сопоставлении с ручной операцией
DUP_NAMES = {"matched": "Соответствие подтверждено — повторное движение не создаётся", "nomatch": "Ручной операции нет — на проверку казначею",
             "ambiguous": "Соответствие неоднозначно — нужно подтверждение казначея", "accepted": "Казначей подтвердил: движение по документу",
             "lost": "Сопоставленная ручная операция удалена — на проверку казначею"}


def dup_candidates(C, d, taken):
    """Ручные ПЕР с той же стороной списания: счёт, валюта, сумма и дата в пределах DUP_DAYS (ДР-01)."""
    from datetime import date as _d
    from .logic import doc_counts_manual
    total = r2(sum(l.get("sum") or 0 for l in d["lines"]))
    a = C.acc(d["acc"])
    out = []
    for m in C.S["docs"]:
        if m.get("source") != "manual" or m["type"] != "ПЕР" or m["id"] in taken or not doc_counts_manual(C, m):
            continue
        fr = m.get("from") or {}
        if fr.get("acc") != d["acc"] or (fr.get("cur") or (a or {}).get("cur")) != d["cur"] or not isinstance(fr.get("sum"), (int, float)):
            continue
        if abs(fr["sum"] - total) >= 0.005 or abs((_d.fromisoformat(m["date"]) - _d.fromisoformat(d["date"])).days) > DUP_DAYS:
            continue
        out.append(m)
    return out


def dup_result(C, d, e, taken):
    """ДР-01: решение казначея сохраняется; иначе — по номеру документа ERP, затем по счёту, валюте, сумме и дате."""
    prev = (e or {}).get("dup") or {}
    if prev.get("by") == "treasurer":
        return dict(prev)
    from .logic import doc_counts_manual
    no = norm(d.get("no1c"))
    byid = [m for m in C.S["docs"] if no and m.get("source") == "manual" and m["type"] == "ПЕР" and norm(m.get("no1c")) == no
            and m["id"] not in taken and doc_counts_manual(C, m)]
    if len(byid) == 1:
        return {"st": "matched", "manual": byid[0]["id"], "by": "id"}
    c = dup_candidates(C, d, taken)
    if len(c) == 1:
        return {"st": "matched", "manual": c[0]["id"], "by": "auto"}
    if not c:
        return {"st": "nomatch"}
    return {"st": "ambiguous", "cands": [m["id"] for m in c]}


def dup_row(C, d):
    x = d.get("dup") or {}
    ids = [x["manual"]] if x.get("manual") else x.get("cands") or []
    cands = []
    for i in ids:
        m = C.get("docs", i)
        if m:
            cands.append({"id": i, "no": m.get("no"), "no1c": m.get("no1c"), "date": m["date"], "sum": (m.get("from") or {}).get("sum"),
                          "to": nm(C.acc((m.get("to") or {}).get("acc")))})
    return {"guid": d["guid"], "no": d.get("no1c"), "type": d["type"], "date": d["date"], "op": d["op"], "acc": d["acc"], "cur": d["cur"],
            "sum": r2(sum(l.get("sum") or 0 for l in d["lines"])), "st": x.get("st"), "by": x.get("by"), "res": DUP_NAMES.get(x.get("st"), ""), "cands": cands,
            "row": d["_rows"][0]["n"] if d.get("_rows") else None}


def reg_row(C, R):
    """Строка реестра предпросмотра (ТР-108): исходные значения для правки, найденные ссылки, ошибки, изменения."""
    return {"n": R["n"], "st": R.get("st") or "error", "why": R.get("why", ""), "guid": R["guid"], "no": R["no"], "type": R["type"] or R["typeRaw"],
            "date": R["date"], "org": R["orgR"] and R["orgR"]["id"], "acc": R["accR"] and R["accR"]["id"], "cur": R["cur"], "sum": R["sum"] if math.isfinite(R["sum"]) else None,
            "docSum": R["docSum"] if math.isfinite(R.get("docSum", float("nan"))) else None, "rate": R.get("rate"), "state": R.get("status"), "stage": R.get("stage"),
            "stateRaw": R.get("stateRaw"), "bankDate": R.get("bankDate"), "op": R["op"], "dept": R["dept"], "cf": R["cf"], "zone": R["zone"], "cpty": R["cpty"],
            "purpose": R["purpose"], "erpType": R.get("erpType"), "errs": R["errs"], "warns": R["warns"], "fixed": R["fixed"], "raw": R["raw"],
            "changes": R.get("changes", []), "fmt": R["fmt"], "orig": R.get("orig", {}), "mapped": R.get("mapped", []),
            "bankName": R.get("bankName", ""), "accNo": R.get("accNo", ""), "usd": R.get("usd"), "flags": R.get("flags"), "dup": R.get("dup")}


def _show(C, f, v):
    if v in (None, ""):
        return "—"
    if f in ("date", "bankDate"):
        return fmt_d(v)
    if f in ("sum", "usd", "docSum"):
        return fmt(v)
    if f == "org":
        return nm(C.get("orgs", v))
    if f == "acc":
        return nm(C.acc(v))
    if f == "cur":
        return cur_code(C, v)
    if f in ("dept", "cf", "zone"):
        coll = {"dept": "depts", "cf": "cfTypes", "zone": "zones"}[f]
        x = C.get(coll, v)
        return x["name"] if x else str(v).lstrip("?")
    return str(v)


def doc_changes(C, e, d):
    out = []
    from .logic import doc_flags, tri_text
    for f, k in (("type", "type"), ("op", "op"), ("no", "no1c"), ("date", "date"), ("org", "org"), ("acc", "acc"), ("cur", "cur"), ("state", "status"),
                 ("bankDate", "bankDate"), ("erpType", "erpType"), ("stage", "stage"), ("docSum", "docSum"), ("rate", "rate")):
        a, b = e.get(k), d.get(k)
        if (a or None) != (b or None) and not (isinstance(a, float) and isinstance(b, float) and abs(a - b) < 1e-9):
            out.append({"f": f, "before": _show(C, k, a), "after": _show(C, k, b)})
    fa, fb = doc_flags(e), doc_flags(d)
    for k in ("posted", "approved", "deleted", "bank"):
        if fa.get(k) != fb.get(k) and not (k == "bank" and d.get("type") != "СБДС"):
            out.append({"f": "f_" + k, "before": tri_text(fa.get(k)), "after": tri_text(fb.get(k))})
    return out


def line_changes(C, o, l, i):
    if o is None:
        return [{"f": "line", "before": "—", "after": f"новая строка {i + 1}"}]
    out = []
    for f in ("sum", "usd", "dept", "cf", "zone", "cpty", "purpose", "contract"):
        a, b = o.get(f), l.get(f)
        if (a or None) != (b or None) and not (isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(a - b) < 0.005):
            out.append({"f": f, "before": _show(C, f, a), "after": _show(C, f, b)})
    return out


def move_of(C, d, counted):
    return {"counted": counted, "date": d["date"], "org": d["org"], "acc": d["acc"], "cur": d.get("cur"),
            "sum": [r2(l.get("sum") or 0) for l in d["lines"]], "dept": [l.get("dept") for l in d["lines"]], "cf": [l.get("cf") for l in d["lines"]],
            "zone": [l.get("zone") for l in d["lines"]], "cpty": [norm(l.get("cpty")) for l in d["lines"]]}


def would_count(C, d):
    from .logic import doc_counts
    return doc_counts(C, dict(d, excluded=False, deleted=False))


def is_significant(C, e, d):
    """ТР-85: отмена в ERP или изменение реквизитов, влияющих на движение и распределение по кошелькам."""
    from .logic import doc_counts
    if not (doc_counts(C, e) or e.get("held")):
        return False
    base = dict(e, **e["held"]) if e.get("held") else e
    a, b = move_of(C, base, True), move_of(C, d, would_count(C, d))
    return any(a[k] != b[k] for k in SIGNIFICANT)


def significant_diff(C, before, after):
    out = []
    for f in ("date", "org", "acc", "cur", "status", "approved"):
        if (before.get(f) or None) != (after.get(f) or None):
            out.append({"f": f, "before": _show(C, f, before.get(f)), "after": _show(C, f, after.get(f))})
    bl, al = before.get("lines") or [], after.get("lines") or []
    for i in range(max(len(bl), len(al))):
        o, l = (bl[i] if i < len(bl) else {}), (al[i] if i < len(al) else {})
        for f in ("sum", "dept", "cf", "zone", "cpty"):
            if (o.get(f) or None) != (l.get(f) or None) and not (f == "sum" and o.get(f) is not None and l.get(f) is not None and abs(o[f] - l[f]) < 0.005):
                out.append({"f": f, "line": i + 1, "before": _show(C, f, o.get(f)), "after": _show(C, f, l.get(f))})
    return out


def apply_exp(C, u, p, file_name):
    need_upload(u)
    pv, work = preview_exp(C, p)
    if pv["errors"]:
        raise ApiError(["Реестр с ошибками не загружается: исправьте ошибки в реестре — частичная загрузка запрещена (ТР-108, ТР-110)."])
    from .logic import doc_counts, movement_snap, diff_text
    now = now_iso()
    src = f"файл {file_name}"
    st = C.S["settings"]

    def closed_note(d, diff):
        if in_closed(C, d["date"]):
            C.st.add("closedChanges", {"id": None, "t": now, "docId": d["id"], "docNo": f"{d['type']} {d['no1c']} ({d['guid']})", "date": d["date"], "diff": diff, "seen": []})

    def audit_fixes(d):
        # ТР-109: исправленные в реестре ячейки — в журнал аудита (было/стало)
        for R in d.get("_rows", []):
            for f in R["fixed"]:
                C.st.audit(u, "Исправление в реестре загрузки", f"{d['type']} {d['no1c']} ({d['guid']}), строка файла {R['n']}",
                           f"{FIELD_NAMES.get(f, f)}: «{R['orig'].get(f, '')}» → «{R['raw'].get(f, '')}»")
    from .util import uid
    held_n = 0
    for n in work["add"]:
        d = dict(n, id=uid("D"), no="", excluded=False, deleted=False, versions=[], loaded=now, fileName=file_name, fileSig=n["sig"], author="", created=now,
                 held=None, review=None)
        d.pop("sig", None); d.pop("flagsFile", None); rows_ = d.pop("_rows", [])
        apply_rules(C, d)
        C.st.add("docs", d)
        closed_note(d, "новый документ")
        audit_fixes(dict(d, _rows=rows_))
    for n, e in work["upd"]:
        before = doc_snap(C, e)
        was_counted = doc_counts(C, e)
        prev_move = e.get("held") or (movement_snap(C, e) if was_counted else None)
        significant = is_significant(C, e, n)
        keep = len(e["lines"]) == len(n["lines"])
        lines = []
        for i, l in enumerate(n["lines"]):
            o = e["lines"][i] if i < len(e["lines"]) else None
            if not l.get("fileWallet") and keep and o and line_sig(o) == line_sig(l) and (o.get("wallet") or o.get("split")) and o.get("wsrc") != "rule":
                lines.append(dict(l, wallet=o.get("wallet"), wsrc=o["wsrc"], rule=o.get("rule"), split=o.get("split")))
            else:
                lines.append(dict(l))
        for k in ("type", "op", "no1c", "date", "org", "acc", "cur", "status", "statusRaw", "approved", "bankDone", "bankDate", "stage", "erpType", "docSum", "rate", "fmt",
                  "bankName", "accNo", "flags", "dup"):
            e[k] = n.get(k)
        e.update(lines=lines, excluded=False, loaded=now, fileName=file_name, fileSig=n["sig"], fixed=n.get("fixed") or [])
        apply_rules(C, e)
        closed_doc = in_closed(C, e["date"]) or (prev_move and in_closed(C, prev_move["date"]))
        # ТР-85: существенное изменение уже учтённого документа — до проверки казначеем в расчёте остаётся прежнее движение.
        # ТР-89: в закрытом периоде изменения ERP принимаются сразу (если в настройках не включено удержание).
        # v1.5.1: отменённый, распроведённый или помеченный на удаление в ERP документ выходит из расчёта сразу, без удержания
        if significant and would_count(C, e) and prev_move and prev_move.get("counted") and (not closed_doc or st.get("holdClosed")):
            e["held"] = prev_move
            e["review"] = {"t": now, "file": file_name, "diff": significant_diff(C, prev_move, movement_snap(C, e))}
            held_n += 1
        elif not significant and e.get("held"):
            e["review"] = dict(e.get("review") or {}, t=now, file=file_name, diff=significant_diff(C, e["held"], movement_snap(C, e)))
        if e.get("held") and not would_count(C, e):
            # ДР-07, ТР-85: отменённый, распроведённый или помеченный на удаление в ERP документ выходит из расчёта сразу — удержанное движение снимается
            e["held"], e["review"] = None, None
        C.st.save("docs", e)
        after = doc_snap(C, e)
        add_version(C, "doc", e, before, after, src, u)
        closed_note(e, diff_text(before, after))
        audit_fixes(n)
    for n in work["same"]:
        audit_fixes(n)
    for e in work["exc"]:
        before = doc_snap(C, e)
        e["excluded"] = True
        C.st.save("docs", e)
        add_version(C, "doc", e, before, doc_snap(C, e), src + " — нет в файле", u)
        closed_note(e, "исключён: нет в загрузке")
    sel = work["sel"]
    C.st.add("exchangeLog", {"id": None, "t": now, "u": u["id"], "kind": KIND_NAMES["exp"] + " (История согласования, 17 столбцов)", "file": file_name,
                             "added": len(work["add"]), "updated": len(work["upd"]), "excluded": len(work["exc"]), "errors": 0,
                             "text": f"Организации: {', '.join(nm(C.get('orgs', o)) for o in sel['orgs'])}; период {fmt_d(sel['from'])}–{fmt_d(sel['to'])}; "
                                     f"без изменений: {len(work['same'])}; проверено на двойной учёт (ТР-70): {len(pv['dup'])}, "
                                     f"из них ждут казначея: {sum(1 for x in pv['dup'] if x['st'] in ('nomatch', 'ambiguous'))}; на проверку казначею (ТР-85): {held_n}"
                                     + (f"; предупреждений: {len(pv['warns'])}" if pv["warns"] else "")})
    C.st.audit(u, "Загрузка файла", file_name, f"документы: добавлено {len(work['add'])}, изменено {len(work['upd'])}, исключено {len(work['exc'])}, без изменений {len(work['same'])}, на проверку {held_n}")
    return {"added": len(work["add"]), "updated": len(work["upd"]), "excluded": len(work["exc"]), "held": held_n}


def need_upload(u):
    """ТР-60: загружает администратор или казначей с правом загрузки."""
    from .logic import is_admin, has
    if not (is_admin(u) or (has(u, "treasurer") and u.get("canUpload"))):
        from .actions import Forbidden
        raise Forbidden("Загрузка файлов доступна администратору и казначею с правом загрузки")


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
                    o = find_ref(T["orgs"], g("org"))
                    if not o: E(f"неизвестная организация «{txt(g('org'))}»"); continue
                    # мультивалютный счёт: валюты через запятую или точку с запятой — каждая валюта отдельная позиция
                    parts = [x.strip() for x in txt(g("cur")).replace(";", ",").replace("/", ",").split(",") if x.strip()]
                    cs = [find_ref(T["currencies"], x) for x in parts]
                    if not parts or not all(cs): E(f"неизвестная валюта «{txt(g('cur'))}»"); continue
                    item["org"], item["cur"], item["curs"] = o["id"], cs[0]["id"], list(dict.fromkeys(c["id"] for c in cs))
                    if kind == "accounts":
                        item["bank"] = txt(g("bank"))
                        item["number"] = txt(g("number"))
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
    # ДР-02-23.10: полнота курсов — рабочие дни без курса в периоде загруженного файла
    file_rates = {}
    for s_, k in marked:
        if k != "rates":
            continue
        hi_, m_, _ = map_header(s_["rows"], REF_KINDS["rates"]["spec"])
        for r in s_["rows"][hi_ + 1:]:
            c, d_ = find_ref(T["currencies"], cell(r or [], m_, "cur")), parse_date(cell(r or [], m_, "date"))
            if c and d_:
                file_rates.setdefault(c["id"], []).append(d_)
    if file_rates:
        from datetime import date as _d, timedelta as _td
        from .daily import is_workday
        have = {}
        for x in T["rates"]:
            have.setdefault(x["cur"], set()).add(x["date"])
        for c, ds in file_rates.items():
            a_, b_ = _d.fromisoformat(min(ds)), _d.fromisoformat(max(ds))
            gaps, x = [], a_
            while x <= b_:
                if is_workday(C, x.isoformat()) and x.isoformat() not in have.get(c, set()):
                    gaps.append(x.isoformat())
                x += _td(days=1)
            code = next((y.get("code") or y.get("name") for y in T["currencies"] if y["id"] == c), c)
            if gaps:
                warns.append({"row": "—", "msg": f"Курсы {code}: нет курса за рабочие дни {', '.join(fmt_d(g) for g in gaps[:10])}{' и ещё ' + str(len(gaps) - 10) if len(gaps) > 10 else ''} — "
                                                 f"на эти даты USD-показатели будут предварительными; запросите курсы при следующем обмене (ДР-02-23.10)"})
            stats.setdefault("rates", {"name": REF_KINDS["rates"]["name"], "add": 0, "upd": 0, "same": 0, "sheet": ""})["period"] = f"{fmt_d(min(ds))}–{fmt_d(max(ds))}"
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
    shs = _sheets(p)
    sh = next((s_ for s_ in shs if not [k for k in map_header(s_["rows"], BAL_SPEC)[2] if k != "cur"]), shs[0])
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
        cur_id = a["cur"]
        if txt(g("cur")):
            c = find_ref(C.S["currencies"], g("cur"))
            if not c or c["id"] not in acc_curs(a):
                errors.append({"row": n, "msg": f"валюты «{txt(g('cur'))}» нет у счёта"}); continue
            cur_id = c["id"]
        elif len(acc_curs(a)) > 1:
            errors.append({"row": n, "msg": "у мультивалютного счёта укажите валюту"}); continue
        items.append({"date": d, "acc": a["id"], "cur": cur_id, "sum": r2(sm)})
    dates = sorted({x["date"] for x in items})
    return {"errors": errors, "warns": [], "items": len(items), "dates": dates}, items


def apply_bal(C, u, p, file_name):
    need_admin(u)
    pv, items = preview_bal(C, p)
    if pv["errors"]:
        raise ApiError(["Файл с ошибками целиком не загружается (ТР-63)."])
    add = upd = 0
    ix = {(b["date"], b["acc"], b.get("cur")): b for b in C.S["bal1c"]}
    for it in items:
        ex = ix.get((it["date"], it["acc"], it["cur"]))
        if ex:
            if ex["sum"] != it["sum"]:
                ex["sum"] = it["sum"]; C.st.save("bal1c", ex); upd += 1
        else:
            C.st.add("bal1c", it); ix[(it["date"], it["acc"], it["cur"])] = it; add += 1
    C.st.touch()
    bad = sum(1 for r in recon(C) if r["date"] in pv["dates"] and abs(r["diff"]) >= 0.005)
    C.st.add("exchangeLog", {"id": None, "t": now_iso(), "u": u["id"], "kind": KIND_NAMES["bal"], "file": file_name, "added": add, "updated": upd, "excluded": 0,
                             "errors": 0, "text": f"Даты: {', '.join(fmt_d(d) for d in pv['dates'])}; счетов с расхождением: {bad}"})
    C.st.audit(u, "Загрузка файла", file_name, f"остатки 1С: добавлено {add}, изменено {upd}; расхождений {bad}")
    return {"added": add, "updated": upd, "bad": bad}


# ======================= признаки документов ERP по GUID (ДР-05…07) =======================
def preview_flags(C, p):
    """Файл признаков: GUID и любые из колонок «Проведён», «Согласован», «Помечен на удаление», «Проведено банком».
    Пустая ячейка — «Нет данных», отсутствующая колонка — признак не меняется. Документа ещё нет — признаки применятся при его загрузке."""
    from .logic import doc_eval, tri_text
    shs = _sheets(p)
    ok_ = lambda s_: "guid" in map_header(s_["rows"], FLAGS_SPEC)[1] and len(map_header(s_["rows"], FLAGS_SPEC)[1]) > 1
    sh = next((s_ for s_ in shs if ok_(s_)), shs[0])
    hi, m, missing = map_header(sh["rows"], FLAGS_SPEC)
    errors, warns, items = [], [], []
    if "guid" not in m or len(m) < 2:
        errors.append({"row": hi + 1, "msg": "Нужны колонка «GUID документа (ERP)» и хотя бы одна из колонок: Проведён, Согласован, Помечен на удаление, Проведено банком"})
        return {"errors": errors, "warns": warns, "items": [], "cols": []}, []
    cols = [k for k in ("posted", "approved", "deleted", "bank") if k in m]
    seen = set()
    for i, r in enumerate(sh["rows"][hi + 1:]):
        if not r or not any(txt(c) for c in r):
            continue
        n = hi + 2 + i
        g_ = txt(cell(r, m, "guid"))
        if not g_:
            errors.append({"row": n, "msg": "пустой GUID"}); continue
        if g_ in seen:
            errors.append({"row": n, "msg": f"GUID «{g_}» повторяется в файле"}); continue
        seen.add(g_)
        f, bad = {}, False
        for k in cols:
            v = cell(r, m, k)
            try:
                if k == "posted":
                    f["posted"], dm = status_flags(v)
                    if dm:
                        f["deleted"] = True
                else:
                    f[k] = tri(v) if not (k == "deleted" and f.get("deleted")) else True
            except ValueError as ex:
                errors.append({"row": n, "msg": f"«{FLAGS_SPEC[k][0]}»: неизвестное значение «{ex}» — ожидается Да / Нет или пусто"}); bad = True
        if bad:
            continue
        doc = next((d for d in C.S["docs"] if d.get("guid") == g_ and d["source"] == "file"), None)
        old = dict(((C.get("erpFlags", g_) or {}).get("flags") or {}))
        new = dict(old, **f)
        it = {"row": n, "guid": g_, "flags": {k: new.get(k) for k in ("posted", "approved", "deleted", "bank")}, "doc": doc["id"] if doc else None,
              "no": doc.get("no1c") if doc else "", "type": doc["type"] if doc else "", "changes": []}
        if doc:
            before = doc_eval(C, doc)
            nd = dict(doc, flags=dict(it["flags"], v=1, bank=it["flags"]["bank"] if doc["type"] == "СБДС" else None))
            after = doc_eval(C, nd)
            for k in ("posted", "approved", "deleted", "bank"):
                if k == "bank" and doc["type"] != "СБДС":
                    continue
                if before["flags"].get(k) != after["flags"].get(k):
                    it["changes"].append({"f": k, "before": tri_text(before["flags"].get(k)), "after": tri_text(after["flags"].get(k))})
            it["countsBefore"], it["countsAfter"] = before["counts"], after["counts"]
            it["conflict"] = after["conflict"]
        else:
            it["changes"] = [{"f": k, "before": tri_text(old.get(k)), "after": tri_text(new.get(k))} for k in cols if old.get(k) != new.get(k)]
        it["st"] = ("changed" if it["changes"] else "same") if doc else "nodoc"
        items.append(it)
    if any(x["st"] == "nodoc" for x in items):
        warns.append({"row": "—", "msg": f"Документов с этими GUID ещё нет: {sum(1 for x in items if x['st'] == 'nodoc')} — признаки сохранятся и применятся при загрузке отчёта «История согласования»"})
    return {"errors": errors, "warns": warns, "items": items, "cols": cols}, items


def apply_flags(C, u, p, file_name):
    """ДР-05…08: признаки ERP обновляют документ по GUID без дублей. Отмена — сразу вне расчёта; исполнение банком — сразу в Кф (ТР-85)."""
    need_upload(u)
    pv, items = preview_flags(C, p)
    if pv["errors"]:
        raise ApiError(["Файл с ошибками целиком не загружается (ТР-63)."])
    from .logic import doc_flags, movement_snap
    now = now_iso()
    ch = 0
    for it in items:
        rec = C.get("erpFlags", it["guid"])
        if rec:
            if rec.get("flags") != it["flags"]:
                rec.update(flags=it["flags"], t=now, file=file_name); C.st.save("erpFlags", rec)
        else:
            C.st.add("erpFlags", {"guid": it["guid"], "flags": it["flags"], "t": now, "file": file_name})
        d = C.get("docs", it["doc"]) if it["doc"] else None
        if not d or not it["changes"]:
            continue
        before = doc_snap(C, d)
        nf = dict(it["flags"], v=1)
        if d["type"] != "СБДС":
            nf["bank"] = None
        d["flags"] = nf
        d["approved"] = nf["approved"] is True if d["type"] == "СБДС" else True
        d["bankDone"] = nf["bank"] is True
        d["status"] = "Помечен на удаление" if nf["deleted"] else "Проведён" if nf["posted"] else "Не проведён" if nf["posted"] is False else ""
        if d.get("held") and not would_count(C, d):
            d["held"], d["review"] = None, None   # ДР-07: отмена — вне расчёта сразу
        C.st.save("docs", d)
        ch += 1
        after = doc_snap(C, d)
        add_version(C, "doc", d, before, after, f"признаки ERP, файл {file_name}", u)
        if in_closed(C, d["date"]):
            C.st.add("closedChanges", {"id": None, "t": now, "docId": d["id"], "docNo": f"{d['type']} {d['no1c']} ({d['guid']})", "date": d["date"],
                                       "diff": "; ".join(f"{FLAG_TXT[x['f']]}: {x['before']} → {x['after']}" for x in it["changes"]), "seen": []})
    nodoc = sum(1 for x in items if x["st"] == "nodoc")
    C.st.add("exchangeLog", {"id": None, "t": now, "u": u["id"], "kind": KIND_NAMES["flags"], "file": file_name, "added": nodoc, "updated": ch, "excluded": 0,
                             "errors": 0, "text": f"GUID в файле: {len(items)}; изменены признаки документов: {ch}; без изменений: {sum(1 for x in items if x['st'] == 'same')}; "
                                                  f"документов ещё нет: {nodoc}"})
    C.st.audit(u, "Загрузка файла", file_name, f"признаки ERP: GUID {len(items)}, изменено документов {ch}")
    return {"updated": ch, "nodoc": nodoc, "items": len(items)}


FLAG_TXT = {"posted": "Проведён", "approved": "Согласован", "deleted": "Помечен на удаление", "bank": "Проведено банком"}


def preview(C, u, kind, p):
    if kind in ("exp", "flags"):
        need_upload(u)
    else:
        need_admin(u)
    if kind == "flags":
        pv, _ = preview_flags(C, p)
    elif kind == "exp":
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