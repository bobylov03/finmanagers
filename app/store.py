"""Хранилище: SQLite на диске + рабочая копия данных в памяти.

Приложение работает в одном процессе: все чтения идут из памяти (быстро считать отчёты
и права), каждое изменение сразу записывается в SQLite в одной транзакции под общей
блокировкой. Журнал аудита хранится только в базе и защищён триггерами от правки и
удаления (ТР-46); удалять можно лишь записи старше 13 месяцев (ТР-47).
"""
import json
import sqlite3
import threading
from contextlib import contextmanager

from .util import now_iso

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(prefix TEXT PRIMARY KEY, n INTEGER NOT NULL);

-- Справочники 1С (только чтение в интерфейсе, загружаются файлом, ТР-64)
CREATE TABLE IF NOT EXISTS currencies(id TEXT PRIMARY KEY, name TEXT, code TEXT, deactivated TEXT);
CREATE TABLE IF NOT EXISTS rates(cur TEXT NOT NULL, date TEXT NOT NULL, rate REAL NOT NULL, PRIMARY KEY(cur, date));
CREATE TABLE IF NOT EXISTS orgs(id TEXT PRIMARY KEY, name TEXT, deactivated TEXT);
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT, org TEXT, cur TEXT, bank TEXT, acc_type TEXT, deactivated TEXT, curs TEXT);
CREATE TABLE IF NOT EXISTS cashboxes(id TEXT PRIMARY KEY, name TEXT, org TEXT, cur TEXT, deactivated TEXT, curs TEXT);
CREATE TABLE IF NOT EXISTS cf_types(id TEXT PRIMARY KEY, name TEXT, deactivated TEXT);
CREATE TABLE IF NOT EXISTS depts(id TEXT PRIMARY KEY, name TEXT, parent TEXT, deactivated TEXT);
CREATE TABLE IF NOT EXISTS zones(id TEXT PRIMARY KEY, name TEXT, deactivated TEXT);

-- Ведутся в приложении
CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT, head INTEGER, hidden INTEGER,
  access TEXT, closed INTEGER, closed_from TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY, pos INTEGER, name TEXT, conds TEXT, wallet TEXT, active INTEGER);
CREATE TABLE IF NOT EXISTS contracts(id TEXT PRIMARY KEY, name TEXT, lender TEXT, borrower TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT,
  roles TEXT, wallets TEXT, active INTEGER, lang TEXT, pw_salt TEXT, pw_hash TEXT, can_upload INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS login_failures(login TEXT, t TEXT);

-- Документы: из файла 1С и ручной ввод; ПЕР — две стороны в sides
CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, no TEXT, source TEXT, guid TEXT UNIQUE, type TEXT, op TEXT, no1c TEXT, date1c TEXT,
  date TEXT, org TEXT, acc TEXT, cur TEXT, status TEXT, status_raw TEXT, approved INTEGER, bank_done INTEGER, bank_date TEXT,
  excluded INTEGER, deleted INTEGER, author TEXT, created TEXT, loaded TEXT, file_name TEXT, file_sig TEXT, sides TEXT,
  erp_type TEXT, stage TEXT, rate REAL, doc_sum REAL, fixed TEXT, held TEXT, review TEXT, fmt TEXT);
CREATE INDEX IF NOT EXISTS docs_date ON docs(date);
CREATE TABLE IF NOT EXISTS doc_lines(doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  sum REAL, usd REAL, wallet TEXT, wsrc TEXT, rule TEXT, file_wallet TEXT, dept TEXT, cf TEXT, zone TEXT, cpty TEXT,
  contract TEXT, purpose TEXT, fixed TEXT, PRIMARY KEY(doc_id, idx));
CREATE INDEX IF NOT EXISTS doc_lines_wallet ON doc_lines(wallet);
CREATE TABLE IF NOT EXISTS ops(id TEXT PRIMARY KEY, no TEXT, date TEXT, kind TEXT, from_w TEXT, to_w TEXT, contract TEXT, comment TEXT,
  leg1 TEXT, leg2 TEXT, same_cur INTEGER, author TEXT, created TEXT, posted INTEGER, deleted INTEGER, linked_doc TEXT);
CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY AUTOINCREMENT, obj_kind TEXT, obj_id TEXT, t TEXT, u TEXT, source TEXT,
  diff TEXT, before TEXT, after TEXT);
CREATE INDEX IF NOT EXISTS versions_obj ON versions(obj_kind, obj_id);
CREATE TABLE IF NOT EXISTS opening(id TEXT PRIMARY KEY, acc TEXT, wallet TEXT, sum REAL, cur TEXT);
CREATE TABLE IF NOT EXISTS bal1c(date TEXT NOT NULL, acc TEXT NOT NULL, cur TEXT NOT NULL DEFAULT '', sum REAL, PRIMARY KEY(date, acc, cur));
-- Сопоставления названий из файла со справочниками (ТР-109)
CREATE TABLE IF NOT EXISTS mappings(kind TEXT NOT NULL, raw_norm TEXT NOT NULL, raw TEXT, target TEXT, t TEXT, u TEXT, PRIMARY KEY(kind, raw_norm));

-- Daily Balance (раздел 7)
CREATE TABLE IF NOT EXISTS db_positions(id TEXT PRIMARY KEY, acc TEXT NOT NULL, cur TEXT NOT NULL, owner TEXT, active INTEGER, created TEXT);
CREATE TABLE IF NOT EXISTS db_drafts(id TEXT PRIMARY KEY, user_id TEXT, date TEXT, data TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS db_reports(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, date TEXT NOT NULL, user_id TEXT, uname TEXT,
  t TEXT NOT NULL, late INTEGER, rows TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS db_corrections(id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER, pos_id TEXT, date TEXT, field TEXT,
  value REAL, reason TEXT NOT NULL, user_id TEXT, uname TEXT, t TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS db_explained(id INTEGER PRIMARY KEY AUTOINCREMENT, pos_id TEXT, date TEXT, comment TEXT, user_id TEXT, uname TEXT, t TEXT NOT NULL);
-- ТР-96: сданные отчёты, корректировки и «Объяснено» неизменяемы — как журнал аудита
CREATE TRIGGER IF NOT EXISTS db_reports_no_update BEFORE UPDATE ON db_reports BEGIN SELECT RAISE(ABORT, 'daily balance report is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_reports_no_delete BEFORE DELETE ON db_reports BEGIN SELECT RAISE(ABORT, 'daily balance report is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_reports_no_replace BEFORE INSERT ON db_reports WHEN NEW.id IS NOT NULL AND EXISTS(SELECT 1 FROM db_reports WHERE id=NEW.id)
  BEGIN SELECT RAISE(ABORT, 'daily balance report is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_corr_no_update BEFORE UPDATE ON db_corrections BEGIN SELECT RAISE(ABORT, 'daily balance correction is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_corr_no_delete BEFORE DELETE ON db_corrections BEGIN SELECT RAISE(ABORT, 'daily balance correction is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_corr_no_replace BEFORE INSERT ON db_corrections WHEN NEW.id IS NOT NULL AND EXISTS(SELECT 1 FROM db_corrections WHERE id=NEW.id)
  BEGIN SELECT RAISE(ABORT, 'daily balance correction is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_expl_no_update BEFORE UPDATE ON db_explained BEGIN SELECT RAISE(ABORT, 'daily balance record is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_expl_no_delete BEFORE DELETE ON db_explained BEGIN SELECT RAISE(ABORT, 'daily balance record is immutable'); END;
CREATE TRIGGER IF NOT EXISTS db_expl_no_replace BEFORE INSERT ON db_explained WHEN NEW.id IS NOT NULL AND EXISTS(SELECT 1 FROM db_explained WHERE id=NEW.id)
  BEGIN SELECT RAISE(ABORT, 'daily balance record is immutable'); END;
CREATE TABLE IF NOT EXISTS exchange_log(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, u TEXT, kind TEXT, file TEXT,
  added INTEGER, updated INTEGER, excluded INTEGER, errors INTEGER, text TEXT);
-- ДР-05, ДР-06: признаки документов ERP по GUID (согласован, проведён, помечен на удаление, проведено банком)
CREATE TABLE IF NOT EXISTS erp_flags(guid TEXT PRIMARY KEY, flags TEXT, t TEXT, file TEXT);
CREATE TABLE IF NOT EXISTS closed_changes(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, doc_id TEXT, doc_no TEXT, date TEXT, diff TEXT, seen TEXT);

-- Журнал аудита (ТР-44…47)
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, user_id TEXT, uname TEXT,
  action TEXT NOT NULL, object TEXT, details TEXT);
CREATE INDEX IF NOT EXISTS audit_t ON audit(t);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  WHEN old.t >= strftime('%Y-%m-%dT%H:%M:%S', 'now', '-13 months')
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
"""

# Отображение «коллекция в памяти» → таблица: (столбец, ключ, тип). Типы: s — строка, b — 0/1, f — число, i — целое, j — JSON
TABLES = {
    "currencies": ("currencies", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("code", "code", "s"), ("deactivated", "deactivated", "s")]),
    "rates": ("rates", ("cur", "date"), [("cur", "cur", "s"), ("date", "date", "s"), ("rate", "rate", "f")]),
    "orgs": ("orgs", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("deactivated", "deactivated", "s")]),
    "accounts": ("accounts", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("org", "org", "s"), ("cur", "cur", "s"), ("bank", "bank", "s"),
                                      ("acc_type", "accType", "s"), ("deactivated", "deactivated", "s"), ("curs", "curs", "j"), ("number", "number", "s")]),
    "cashboxes": ("cashboxes", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("org", "org", "s"), ("cur", "cur", "s"), ("deactivated", "deactivated", "s"),
                                        ("curs", "curs", "j")]),
    "cfTypes": ("cf_types", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("deactivated", "deactivated", "s")]),
    "depts": ("depts", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("parent", "parent", "s"), ("deactivated", "deactivated", "s")]),
    "zones": ("zones", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("deactivated", "deactivated", "s")]),
    "wallets": ("wallets", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("parent", "parent", "s"), ("head", "head", "b"), ("hidden", "hidden", "b"),
                                    ("access", "access", "j"), ("closed", "closed", "b"), ("closed_from", "closedFrom", "s"), ("created", "created", "s")]),
    "rules": ("rules", ("id",), [("id", "id", "s"), ("pos", "_pos", "i"), ("name", "name", "s"), ("conds", "conds", "j"), ("wallet", "wallet", "s"), ("active", "active", "b")]),
    "contracts": ("contracts", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("lender", "lender", "s"), ("borrower", "borrower", "s"), ("created", "created", "s")]),
    "opening": ("opening", ("id",), [("id", "id", "s"), ("acc", "acc", "s"), ("wallet", "wallet", "s"), ("sum", "sum", "f"), ("cur", "cur", "s")]),
    "bal1c": ("bal1c", ("date", "acc", "cur"), [("date", "date", "s"), ("acc", "acc", "s"), ("cur", "cur", "s"), ("sum", "sum", "f")]),
    "mappings": ("mappings", ("kind", "rawNorm"), [("kind", "kind", "s"), ("raw_norm", "rawNorm", "s"), ("raw", "raw", "s"), ("target", "target", "s"),
                                                   ("t", "t", "s"), ("u", "u", "s")]),
    "dbPositions": ("db_positions", ("id",), [("id", "id", "s"), ("acc", "acc", "s"), ("cur", "cur", "s"), ("owner", "owner", "s"), ("active", "active", "b"),
                                              ("created", "created", "s")]),
    "dbDrafts": ("db_drafts", ("id",), [("id", "id", "s"), ("user_id", "user", "s"), ("date", "date", "s"), ("data", "data", "j"), ("updated", "updated", "s")]),
    "dbReports": ("db_reports", ("id",), [("id", "id", "i"), ("kind", "kind", "s"), ("date", "date", "s"), ("user_id", "user", "s"), ("uname", "uname", "s"),
                                          ("t", "t", "s"), ("late", "late", "b"), ("rows", "rows", "j")]),
    "dbCorr": ("db_corrections", ("id",), [("id", "id", "i"), ("report_id", "report", "i"), ("pos_id", "pos", "s"), ("date", "date", "s"), ("field", "field", "s"),
                                          ("value", "value", "f"), ("reason", "reason", "s"), ("user_id", "user", "s"), ("uname", "uname", "s"), ("t", "t", "s")]),
    "dbExpl": ("db_explained", ("id",), [("id", "id", "i"), ("pos_id", "pos", "s"), ("date", "date", "s"), ("comment", "comment", "s"), ("user_id", "user", "s"),
                                        ("uname", "uname", "s"), ("t", "t", "s")]),
    "ops": ("ops", ("id",), [("id", "id", "s"), ("no", "no", "s"), ("date", "date", "s"), ("kind", "kind", "s"), ("from_w", "from", "s"), ("to_w", "to", "s"),
                            ("contract", "contract", "s"), ("comment", "comment", "s"), ("leg1", "leg1", "j"), ("leg2", "leg2", "j"), ("same_cur", "sameCur", "b"),
                            ("author", "author", "s"), ("created", "created", "s"), ("posted", "posted", "b"), ("deleted", "deleted", "b"), ("linked_doc", "linkedDoc", "s"),
                            ("xrate", "xrate", "f")]),
    "users": ("users", ("id",), [("id", "id", "s"), ("name", "name", "s"), ("login", "login", "s"), ("email", "email", "s"), ("roles", "roles", "j"),
                                ("wallets", "wallets", "j"), ("active", "active", "b"), ("lang", "lang", "s"), ("pw_salt", "_salt", "s"), ("pw_hash", "_hash", "s"),
                                ("can_upload", "canUpload", "b")]),
    "exchangeLog": ("exchange_log", ("id",), [("id", "id", "i"), ("t", "t", "s"), ("u", "u", "s"), ("kind", "kind", "s"), ("file", "file", "s"), ("added", "added", "i"),
                                            ("updated", "updated", "i"), ("excluded", "excluded", "i"), ("errors", "errors", "i"), ("text", "text", "s")]),
    "erpFlags": ("erp_flags", ("guid",), [("guid", "guid", "s"), ("flags", "flags", "j"), ("t", "t", "s"), ("file", "file", "s")]),
    "closedChanges": ("closed_changes", ("id",), [("id", "id", "i"), ("t", "t", "s"), ("doc_id", "docId", "s"), ("doc_no", "docNo", "s"), ("date", "date", "s"),
                                                ("diff", "diff", "s"), ("seen", "seen", "j")]),
}
DOC_COLS = [("id", "id", "s"), ("no", "no", "s"), ("source", "source", "s"), ("guid", "guid", "s"), ("type", "type", "s"), ("op", "op", "s"), ("no1c", "no1c", "s"),
            ("date1c", "date1c", "s"), ("date", "date", "s"), ("org", "org", "s"), ("acc", "acc", "s"), ("cur", "cur", "s"), ("status", "status", "s"),
            ("status_raw", "statusRaw", "s"), ("approved", "approved", "b"), ("bank_done", "bankDone", "b"), ("bank_date", "bankDate", "s"),
            ("excluded", "excluded", "b"), ("deleted", "deleted", "b"), ("author", "author", "s"), ("created", "created", "s"), ("loaded", "loaded", "s"),
            ("file_name", "fileName", "s"), ("file_sig", "fileSig", "s"), ("erp_type", "erpType", "s"), ("stage", "stage", "s"), ("rate", "rate", "f"),
            ("doc_sum", "docSum", "f"), ("fixed", "fixed", "j"), ("held", "held", "j"), ("review", "review", "j"), ("fmt", "fmt", "s"),
            ("bank_name", "bankName", "s"), ("acc_no", "accNo", "s"), ("usd_erp", "usdErp", "f"), ("flags", "flags", "j"), ("dup", "dup", "j")]
LINE_COLS = [("sum", "sum", "f"), ("usd", "usd", "f"), ("wallet", "wallet", "s"), ("wsrc", "wsrc", "s"), ("rule", "rule", "s"), ("file_wallet", "fileWallet", "s"),
             ("dept", "dept", "s"), ("cf", "cf", "s"), ("zone", "zone", "s"), ("cpty", "cpty", "s"), ("contract", "contract", "s"), ("purpose", "purpose", "s"),
             ("fixed", "fixed", "j"), ("split", "split", "j")]

DEFAULT_SETTINGS = {
    "startDate": "", "closedTo": "", "switchDate": "", "autoClose": True,
    "excludedOps": ["Конвертация валюты", "Перечисление на другой счёт", "Оплата в другую организацию группы", "Инкассация"],
    # ТР-106: значения «Текущего этапа» и «Текущего состояния» ERP → смысл (approved | posted | notposted | deleted)
    "stateMap": [],
    # ТР-32, ТР-90: форма котировки поля «Курс» в отчёте ERP: perUsd — единиц валюты за 1 USD; usdPer — USD за 1 единицу
    "rateForm": "perUsd",
    # ТР-41…43: сверка с остатками 1С включается, когда в 1С появятся актуальные остатки
    "recon1c": False,
    # ТР-89: существенные изменения ERP в закрытом периоде держать до проверки (False — принимать сразу, предложение ТЗ)
    "holdClosed": False,
    # Daily Balance (ТР-91): контрольное время по Москве, календарь рабочих дней (ISO: 1 — пн … 7 — вс), допуск по валюте
    "dbTime": "10:30", "dbTz": "Europe/Moscow", "dbWeekends": [6, 7], "dbHolidays": [], "dbWorkdays": [], "dbTol": {},
}
COLLECTIONS = list(TABLES) + ["docs"]
IMMUTABLE = ("dbReports", "dbCorr", "dbExpl")


def _to_db(v, t):
    if t == "b":
        return 1 if v else 0
    if t == "j":
        return json.dumps(v if v is not None else None, ensure_ascii=False)
    if t in ("f", "i"):
        return v
    return v if v not in (None, "") else (None if v is None else "")


def _from_db(v, t):
    if t == "b":
        return bool(v)
    if t == "j":
        return json.loads(v) if v else ([] if v is None else v)
    if t == "s":
        return v if v is not None else ""
    return v


class Store:
    def __init__(self, path):
        self.path = path
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self._migrate_before()
        self.conn.executescript(SCHEMA)
        self._migrate_after()
        self.lock = threading.RLock()
        self.version = 0
        self.cache = {}
        self._idx = {}
        self.load()

    # ---------- миграции существующей базы ----------
    ADD_COLS = [("accounts", "curs", "TEXT"), ("cashboxes", "curs", "TEXT"), ("users", "can_upload", "INTEGER"),
                ("docs", "erp_type", "TEXT"), ("docs", "stage", "TEXT"), ("docs", "rate", "REAL"), ("docs", "doc_sum", "REAL"),
                ("docs", "fixed", "TEXT"), ("docs", "held", "TEXT"), ("docs", "review", "TEXT"), ("docs", "fmt", "TEXT"),
                ("doc_lines", "fixed", "TEXT"), ("opening", "cur", "TEXT"), ("ops", "xrate", "REAL"),
                ("docs", "bank_name", "TEXT"), ("docs", "acc_no", "TEXT"), ("docs", "usd_erp", "REAL"), ("accounts", "number", "TEXT"),
                ("doc_lines", "split", "TEXT"), ("docs", "flags", "TEXT"), ("docs", "dup", "TEXT")]

    def _cols(self, table):
        return {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})").fetchall()}

    def _migrate_before(self):
        """Старая таблица bal1c без валюты: ключ становится дата × счёт × валюта (позиция)."""
        c = self.conn
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bal1c'").fetchone() and "cur" not in self._cols("bal1c"):
            c.executescript("""ALTER TABLE bal1c RENAME TO bal1c_old;
              CREATE TABLE bal1c(date TEXT NOT NULL, acc TEXT NOT NULL, cur TEXT NOT NULL DEFAULT '', sum REAL, PRIMARY KEY(date, acc, cur));
              INSERT INTO bal1c(date, acc, cur, sum) SELECT b.date, b.acc, COALESCE((SELECT cur FROM accounts WHERE id=b.acc),(SELECT cur FROM cashboxes WHERE id=b.acc),''), b.sum FROM bal1c_old b;
              DROP TABLE bal1c_old;""")

    def _migrate_after(self):
        for table, col, typ in self.ADD_COLS:
            if col not in self._cols(table):
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")

    # ---------- транзакции ----------
    @contextmanager
    def tx(self):
        """Одна транзакция на одно действие пользователя; при ошибке — откат и перечитывание из базы."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self
                self.conn.execute("COMMIT")
            except BaseException as e:
                if getattr(e, "commit", False):
                    # ошибка для пользователя, но записи (например, неудачный вход в журнал аудита) сохраняем
                    self.conn.execute("COMMIT")
                    raise
                self.conn.execute("ROLLBACK")
                self.load()
                raise
            finally:
                self.touch()

    def touch(self):
        self.version += 1
        self.cache = {}
        self._idx = {}

    # ---------- загрузка ----------
    def load(self):
        c = self.conn
        S = {}
        for coll, (table, _pk, cols) in TABLES.items():
            order = " ORDER BY pos" if coll == "rules" else (" ORDER BY id" if coll in ("exchangeLog", "closedChanges") + IMMUTABLE else "")
            rows = c.execute(f"SELECT {', '.join(col for col, _, _ in cols)} FROM {table}{order}").fetchall()
            S[coll] = [{key: _from_db(r[col], t) for col, key, t in cols} for r in rows]
        for u in S["users"]:
            u["pw"] = {"salt": u.pop("_salt"), "hash": u.pop("_hash")} if u.get("_hash") else None
            u.pop("_salt", None); u.pop("_hash", None)
        for r in S["rules"]:
            r.pop("_pos", None)
        docs = {}
        for r in c.execute(f"SELECT {', '.join(col for col, _, _ in DOC_COLS)}, sides FROM docs ORDER BY date, id").fetchall():
            d = {key: _from_db(r[col], t) for col, key, t in DOC_COLS}
            d["lines"] = []
            sides = json.loads(r["sides"]) if r["sides"] else None
            if sides:
                d["from"], d["to"] = sides.get("from"), sides.get("to")
            d["versions"] = []
            docs[d["id"]] = d
        for r in c.execute(f"SELECT doc_id, idx, {', '.join(col for col, _, _ in LINE_COLS)} FROM doc_lines ORDER BY doc_id, idx").fetchall():
            d = docs.get(r["doc_id"])
            if d is not None:
                d["lines"].append({key: _from_db(r[col], t) for col, key, t in LINE_COLS})
        ops = {o["id"]: o for o in S["ops"]}
        for o in S["ops"]:
            o["versions"] = []
        for r in c.execute("SELECT obj_kind, obj_id, t, u, source, diff, before, after FROM versions ORDER BY id").fetchall():
            tgt = docs.get(r["obj_id"]) if r["obj_kind"] == "doc" else ops.get(r["obj_id"])
            if tgt is not None:
                tgt["versions"].append({"t": r["t"], "u": r["u"], "source": r["source"], "diff": r["diff"],
                                        "before": json.loads(r["before"] or "null"), "after": json.loads(r["after"] or "null")})
        for d in docs.values():
            for k in ("held", "review", "flags", "dup"):
                if d.get(k) == []:
                    d[k] = None
        for a in S["accounts"] + S["cashboxes"]:
            if not a.get("curs"):
                a["curs"] = [a["cur"]] if a.get("cur") else []
        accs = {a["id"]: a for a in S["accounts"] + S["cashboxes"]}
        for coll in ("opening", "bal1c"):
            for x in S[coll]:
                if not x.get("cur") and accs.get(x["acc"]):
                    x["cur"] = accs[x["acc"]]["cur"]
        for x in S["dbDrafts"]:
            if x.get("data") == []:
                x["data"] = {}
        S["docs"] = list(docs.values())
        st = dict(DEFAULT_SETTINGS)
        for r in c.execute("SELECT key, value FROM settings").fetchall():
            st[r["key"]] = json.loads(r["value"])
        S["settings"] = st
        S["counters"] = {r["prefix"]: r["n"] for r in c.execute("SELECT prefix, n FROM counters").fetchall()}
        self.S = S
        self.touch()

    # ---------- индекс по id ----------
    def get(self, coll, id_):
        if not id_:
            return None
        ix = self._idx.get(coll)
        if ix is None:
            kf = "guid" if coll == "erpFlags" else "id"
            ix = self._idx[coll] = {x.get(kf): x for x in self.S[coll]}
        return ix.get(id_)

    def add(self, coll, obj):
        self.S[coll].append(obj)
        self._idx.pop(coll, None)
        self.save(coll, obj)

    # ---------- запись ----------
    def save(self, coll, obj):
        if coll == "docs":
            return self._save_doc(obj)
        table, pk, cols = TABLES[coll]
        vals = []
        for col, key, t in cols:
            if coll == "users" and key in ("_salt", "_hash"):
                pw = obj.get("pw") or {}
                vals.append(pw.get("salt" if key == "_salt" else "hash"))
            elif coll == "rules" and key == "_pos":
                vals.append(self.S["rules"].index(obj) if obj in self.S["rules"] else 0)
            elif t == "i" and key == "id" and obj.get("id") is None:
                vals.append(None)
            else:
                vals.append(_to_db(obj.get(key), t))
        cur = self.conn.execute(f"INSERT OR REPLACE INTO {table}({', '.join(c for c, _, _ in cols)}) VALUES({', '.join('?' * len(cols))})", vals)
        if coll in ("exchangeLog", "closedChanges") + IMMUTABLE and obj.get("id") is None:
            obj["id"] = cur.lastrowid

    def _save_doc(self, d):
        vals = [_to_db(d.get(key), t) for _, key, t in DOC_COLS]
        if vals[3] == "":  # guid: пустой → NULL, чтобы не мешал UNIQUE
            vals[3] = None
        sides = json.dumps({"from": d.get("from"), "to": d.get("to")}, ensure_ascii=False) if d.get("type") == "ПЕР" else None
        self.conn.execute(f"INSERT OR REPLACE INTO docs({', '.join(c for c, _, _ in DOC_COLS)}, sides) VALUES({', '.join('?' * (len(DOC_COLS) + 1))})", vals + [sides])
        self.conn.execute("DELETE FROM doc_lines WHERE doc_id=?", (d["id"],))
        if d.get("lines"):
            self.conn.executemany(
                f"INSERT INTO doc_lines(doc_id, idx, {', '.join(c for c, _, _ in LINE_COLS)}) VALUES(?, ?, {', '.join('?' * len(LINE_COLS))})",
                [[d["id"], i] + [_to_db(l.get(key), t) for _, key, t in LINE_COLS] for i, l in enumerate(d["lines"])])

    def delete(self, coll, obj):
        table, pk, _ = TABLES[coll]
        js = {"accType": "acc_type"}
        self.conn.execute(f"DELETE FROM {table} WHERE " + " AND ".join(f"{k}=?" for k in pk), [obj[k] for k in pk])
        self.S[coll] = [x for x in self.S[coll] if x is not obj]
        self._idx.pop(coll, None)

    def save_rules_order(self):
        for i, r in enumerate(self.S["rules"]):
            self.conn.execute("UPDATE rules SET pos=? WHERE id=?", (i, r["id"]))

    def set_setting(self, key, value):
        self.S["settings"][key] = value
        self.conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (key, json.dumps(value, ensure_ascii=False)))

    def next_no(self, prefix):
        n = self.S["counters"].get(prefix, 0) + 1
        self.S["counters"][prefix] = n
        self.conn.execute("INSERT OR REPLACE INTO counters(prefix, n) VALUES(?, ?)", (prefix, n))
        return f"{prefix}-{n:06d}"

    def add_version(self, kind, obj, before, after, diff, source, uname):
        v = {"t": now_iso(), "u": uname, "source": source or "", "before": before, "after": after, "diff": diff}
        obj.setdefault("versions", []).append(v)
        self.conn.execute("INSERT INTO versions(obj_kind, obj_id, t, u, source, diff, before, after) VALUES(?,?,?,?,?,?,?,?)",
                          (kind, obj["id"], v["t"], uname, v["source"], diff, json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False)))

    # ---------- журнал аудита ----------
    def audit(self, user, action, obj="", details="", uname=None):
        self.conn.execute("INSERT INTO audit(t, user_id, uname, action, object, details) VALUES(?,?,?,?,?,?)",
                          (now_iso(), user["id"] if user else None, uname or (user["name"] if user else "—"), action, obj or "", details or ""))

    def purge_old_audit(self):
        """ТР-47: записи старше 13 месяцев удаляются; триггер не даст удалить более новые."""
        self.conn.execute("DELETE FROM audit WHERE t < strftime('%Y-%m-%dT%H:%M:%S', 'now', '-13 months')")

    def audit_query(self, user_id="", q="", d_from="", d_to="", limit=1000):
        sql, args = "SELECT t, user_id, uname, action, object, details FROM audit WHERE 1=1", []
        if user_id:
            sql += " AND user_id=?"; args.append(user_id)
        if d_from:
            sql += " AND substr(t,1,10)>=?"; args.append(d_from)
        if d_to:
            sql += " AND substr(t,1,10)<=?"; args.append(d_to)
        if q:
            sql += " AND (action LIKE ? OR object LIKE ? OR details LIKE ?)"; args += [f"%{q}%"] * 3
        sql += " ORDER BY id DESC LIMIT ?"; args.append(limit)
        return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    # ---------- сессии ----------
    def session_user(self, token):
        if not token:
            return None
        r = self.conn.execute("SELECT user_id, last_seen FROM sessions WHERE token=?", (token,)).fetchone()
        return r

    # ---------- полная замена данных (восстановление, очистка) ----------
    def replace_all(self, data, keep_user=None):
        """Заменить все данные, кроме журнала аудита (ТР-46). Вызывается внутри tx()."""
        c = self.conn
        old_immutable = {k: self.S.get(k, []) for k in IMMUTABLE}
        # сданные отчёты Daily Balance, корректировки и «Объяснено» неизменяемы (ТР-96) и, как журнал аудита, не удаляются
        for table in ["doc_lines", "versions", "docs", "ops", "opening", "bal1c", "exchange_log", "closed_changes", "rules", "contracts",
                      "wallets", "rates", "currencies", "orgs", "accounts", "cashboxes", "cf_types", "depts", "zones", "settings", "counters", "users",
                      "mappings", "db_positions", "db_drafts", "erp_flags"]:
            c.execute(f"DELETE FROM {table}")
        # сессия того, кто выполняет действие, сохраняется; остальные пользователи входят заново
        c.execute("DELETE FROM sessions WHERE user_id IS NOT ?", (keep_user["id"] if keep_user else None,))
        self.S = {k: [] for k in COLLECTIONS}
        self.S["settings"] = dict(DEFAULT_SETTINGS)
        self.S["counters"] = {}
        self._idx = {}
        for k, v in (data.get("settings") or {}).items():
            if k in DEFAULT_SETTINGS:
                self.set_setting(k, v)
        for k, n in (data.get("counters") or {}).items():
            self.S["counters"][k] = n
            c.execute("INSERT INTO counters(prefix, n) VALUES(?, ?)", (k, n))
        for k in IMMUTABLE:
            self.S[k] = old_immutable[k]
        for coll in [x for x in TABLES if x != "users" and x not in IMMUTABLE] + ["docs"]:
            for obj in data.get(coll) or []:
                if coll in ("exchangeLog", "closedChanges"):
                    obj = dict(obj); obj["id"] = None
                if coll in ("docs", "ops"):
                    vers = obj.get("versions") or []
                    obj = dict(obj); obj["versions"] = []
                    self.add(coll, obj)
                    for v in vers:
                        self.add_version("doc" if coll == "docs" else "op", obj, v.get("before"), v.get("after"), v.get("diff", ""), v.get("source", ""), v.get("u", ""))
                else:
                    self.add(coll, obj)
        users = data.get("users") or []
        if keep_user and not any(u.get("id") == keep_user["id"] for u in users):
            users = [keep_user] + users
        for u in users:
            self.add("users", u)