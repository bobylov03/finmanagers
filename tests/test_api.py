"""Тесты API: python -m unittest discover -s tests -v"""
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.server import create_app  # noqa: E402

H = {"X-Requested-With": "wallets"}
REF_SHEETS = [
    {"name": "Организации", "rows": [["Идентификатор", "Наименование"], ["o-1", "Норд Марин"], ["o-2", "Стелла"]]},
    {"name": "Валюты", "rows": [["Идентификатор", "Наименование", "Символьный код"], ["USD", "USD", "USD"], ["AED", "AED", "AED"]]},
    {"name": "Курсы к USD", "rows": [["Валюта", "Дата", "Курс"], ["AED", "2026-01-01", 3.6725]]},
    {"name": "Банковские счета", "rows": [["Идентификатор", "Наименование", "Организация", "Валюта"], ["a-1", "Норд USD", "o-1", "USD"],
                                          ["a-2", "Норд AED", "o-1", "AED"], ["a-3", "Стелла USD", "o-2", "USD"]]},
    {"name": "Подразделения", "rows": [["Идентификатор", "Наименование", "Родитель"], ["d-1", "Холдинг", ""], ["d-2", "КТФ", "d-1"]]},
]
EXP_HEAD = ["GUID документа 1С", "Тип", "Хозяйственная операция", "Номер", "Дата", "Организация", "Счёт или касса", "Валюта", "Статус",
            "Проведено банком", "Сумма в валюте", "Сумма в USD", "Подразделение"]


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "t.sqlite3")
        self.app = create_app(self.db, start_scheduler=False)
        self.store = self.app.config["STORE"]
        self.admin = self.app.test_client()
        r = self.admin.post("/api/setup", json={"password": "admin-pass-1"}, headers=H)
        self.assertEqual(r.status_code, 200)
        self.post(self.admin, "/api/import/ref/apply", {"sheets": REF_SHEETS, "fileName": "refs.xlsx"})
        self.post(self.admin, "/api/settings", {"key": "startDate", "value": "2026-09-01"})
        self.post(self.admin, "/api/settings", {"key": "autoClose", "value": False})
        self.w = {}
        for name, head in (("Холдинг", True), ("КТФ", False), ("МТФ", False)):
            r = self.post(self.admin, "/api/wallets", {"wallet": {"name": name, "head": head}})
            self.w[name] = r["result"]["id"]
        self.post(self.admin, "/api/opening/a-1", {"rows": [{"wallet": self.w["КТФ"], "sum": 1000}, {"wallet": self.w["МТФ"], "sum": 500}]})
        self.post(self.admin, "/api/users", {"user": {"name": "Казначей", "login": "t1", "roles": ["treasurer"], "wallets": [self.w["КТФ"]]}, "password": "secret-pass-1"})
        self.tr = self.app.test_client()
        r = self.tr.post("/api/login", json={"login": "t1", "password": "secret-pass-1"}, headers=H)
        self.assertEqual(r.status_code, 200)

    def tearDown(self):
        self.store.conn.close()
        self.tmp.cleanup()

    def post(self, client, path, data, status=200):
        r = client.post(path, json=data, headers=H)
        self.assertEqual(r.status_code, status, r.get_json())
        return r.get_json()

    def exp_sheet(self, rows):
        return [{"name": "Расходы", "rows": [EXP_HEAD] + rows}]

    def test_rate_rounding_on_server(self):
        r = self.post(self.admin, "/api/docs/manual", {"doc": {"type": "ПБДС", "op": "Прочее поступление", "date": "2026-09-10", "org": "o-1", "acc": "a-2",
                                                                 "lines": [{"sum": 50000000, "wallet": self.w["КТФ"]}]}})
        d = self.store.get("docs", r["result"]["id"])
        self.assertEqual(d["lines"][0]["usd"], 13614703.88)

    def test_audit_is_append_only(self):
        c = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.DatabaseError):
            c.execute("UPDATE audit SET action='x'")
        with self.assertRaises(sqlite3.DatabaseError):
            c.execute("DELETE FROM audit")
        c.close()

    def test_requires_csrf_header_and_login(self):
        self.assertEqual(self.admin.post("/api/wallets", json={"wallet": {"name": "X"}}).status_code, 400)
        self.assertEqual(self.app.test_client().get("/api/state").status_code, 401)

    def test_login_lockout_and_failed_attempts_logged(self):
        c = self.app.test_client()
        for _ in range(5):
            self.assertEqual(c.post("/api/login", json={"login": "t1", "password": "bad"}, headers=H).status_code, 401)
        self.assertEqual(c.post("/api/login", json={"login": "t1", "password": "secret-pass-1"}, headers=H).status_code, 429)
        rows = self.store.audit_query(q="Неудачная попытка входа")
        self.assertGreaterEqual(len(rows), 5)

    def test_treasurer_sees_only_own_lines(self):
        sheets = self.exp_sheet([["g-1", "СБДС", "Оплата поставщику", "1", "2026-09-10", "o-1", "a-1", "USD", "Проведён", "Да", 100, 100, "d-2"],
                                 ["g-1", "СБДС", "Оплата поставщику", "1", "2026-09-10", "o-1", "a-1", "USD", "Проведён", "Да", 50, 50, ""]])
        self.post(self.admin, "/api/rules", {"rule": {"name": "КТФ", "conds": [{"field": "dept", "op": "group", "values": ["d-1"]}], "wallet": self.w["КТФ"]}})
        self.post(self.admin, "/api/import/exp/apply", {"sheets": sheets, "fileName": "exp.xlsx"})
        doc = next(d for d in self.store.S["docs"] if d["guid"] == "g-1")
        self.post(self.admin, f"/api/docs/{doc['id']}/wallets", {"changes": [{"where": "1", "wallet": self.w["МТФ"]}]})
        st = self.tr.get("/api/state").get_json()
        d = next(x for x in st["docs"] if x["guid"] == "g-1")
        self.assertEqual(len(d["lines"]), 1)
        self.assertEqual(d["hiddenLines"], 1)
        self.assertEqual(st["perms"]["visible"], [self.w["КТФ"]])
        self.assertEqual(st["bal1c"], [])
        self.assertTrue(all("pw" not in u for u in st["users"]))
        # чужую строку переназначить нельзя
        self.post(self.tr, f"/api/docs/{doc['id']}/wallets", {"changes": [{"where": "1", "wallet": self.w["КТФ"]}]}, 403)

    def test_import_is_idempotent_and_excludes_missing(self):
        rows = [["g-1", "СБДС", "Прочий расход", "1", "2026-09-10", "o-1", "a-1", "USD", "Проведён", "Да", 100, 100, ""],
                ["g-2", "СБДС", "Прочий расход", "2", "2026-09-11", "o-1", "a-1", "USD", "Проведён", "Да", 70, 70, ""],
                ["g-3", "СБДС", "Конвертация валюты", "3", "2026-09-11", "o-1", "a-1", "USD", "Проведён", "Да", 5, 5, ""]]
        r = self.post(self.admin, "/api/import/exp/preview", {"sheets": self.exp_sheet(rows)})["preview"]
        self.assertEqual((len(r["add"]), len(r["skip70"])), (2, 1))
        self.post(self.admin, "/api/import/exp/apply", {"sheets": self.exp_sheet(rows), "fileName": "a.xlsx"})
        r = self.post(self.admin, "/api/import/exp/preview", {"sheets": self.exp_sheet(rows)})["preview"]
        self.assertEqual((len(r["add"]), len(r["upd"]), len(r["exc"]), len(r["same"])), (0, 0, 0, 2))
        sel = {"orgs": ["o-1"], "from": "2026-09-01", "to": "2026-09-30"}  # ТР-62: загрузка заменяет выбранный период
        r = self.post(self.admin, "/api/import/exp/apply", {"sheets": self.exp_sheet(rows[:1]), "sel": sel, "fileName": "b.xlsx"})
        self.assertEqual(r["result"]["excluded"], 1)

    def test_import_with_errors_is_rejected(self):
        rows = [["g-9", "СБДС", "", "9", "2026-09-10", "o-1", "a-3", "USD", "Проведён", "", "", None, ""]]
        r = self.post(self.admin, "/api/import/exp/preview", {"sheets": self.exp_sheet(rows), "logReject": True, "fileName": "bad.xlsx"})["preview"]
        self.assertEqual(len(r["errors"]), 2)
        self.post(self.admin, "/api/import/exp/apply", {"sheets": self.exp_sheet(rows), "fileName": "bad.xlsx"}, 400)
        self.assertEqual(self.store.S["exchangeLog"][-1]["errors"], 2)

    def test_treasurer_rights_on_ops(self):
        op = {"kind": "dividends", "date": "2026-09-15", "from": self.w["МТФ"], "to": self.w["Холдинг"], "leg1": {"acc": "a-1", "sum": 10}}
        r = self.post(self.tr, "/api/ops", {"op": op, "post": True}, 400)
        self.assertTrue(any("своим кошелькам" in e for e in r["errors"]))
        op["from"] = self.w["КТФ"]
        self.post(self.tr, "/api/ops", {"op": op, "post": True})
        self.post(self.tr, "/api/wallets", {"wallet": {"name": "X"}}, 403)

    def test_closed_period_blocks_changes(self):
        op = {"kind": "dividends", "date": "2026-09-15", "from": self.w["КТФ"], "to": self.w["Холдинг"], "leg1": {"acc": "a-1", "sum": 10}}
        oid = self.post(self.tr, "/api/ops", {"op": op, "post": True})["result"]["id"]
        self.post(self.admin, "/api/settings", {"key": "closedTo", "value": "2026-09-30"})
        self.post(self.tr, f"/api/ops/{oid}/delete", {}, 403)
        r = self.post(self.tr, "/api/ops", {"op": dict(op, date="2026-09-20"), "post": True}, 400)
        self.assertTrue(any("закрыт" in e for e in r["errors"]))

    def test_exchange_needs_both_legs(self):
        op = {"kind": "exchange", "date": "2026-09-15", "from": self.w["КТФ"], "to": self.w["МТФ"], "sameCur": True, "leg1": {"acc": "a-1", "sum": 10}}
        self.post(self.admin, "/api/ops", {"op": op, "post": True}, 400)
        r = self.post(self.admin, "/api/ops", {"op": op, "post": False})
        self.assertFalse(self.store.get("ops", r["result"]["id"])["posted"])
        op2 = dict(op, id=r["result"]["id"], leg2={"acc": "a-2", "sum": 36.725})
        r = self.post(self.admin, "/api/ops", {"op": op2, "post": True}, 400)
        self.assertTrue(any("ТР-77" in e for e in r["errors"]))
        op2["leg2"] = {"acc": "a-3", "sum": 10}
        self.post(self.admin, "/api/ops", {"op": op2, "post": True})

    def test_reset_keeps_audit(self):
        n = len(self.store.audit_query(limit=100000))
        self.post(self.admin, "/api/admin/reset", {})
        self.assertEqual(self.store.S["docs"], [])
        self.assertGreater(len(self.store.audit_query(limit=100000)), n)
        self.assertEqual(self.admin.get("/api/state").status_code, 200)

    def test_backup_restore_roundtrip(self):
        self.post(self.admin, "/api/docs/manual", {"doc": {"type": "ПБДС", "op": "Прочее поступление", "date": "2026-09-10", "org": "o-1", "acc": "a-1",
                                                           "lines": [{"sum": 10, "wallet": self.w["КТФ"]}]}})
        data = self.admin.get("/api/admin/backup").get_json()
        self.post(self.admin, "/api/admin/reset", {})
        self.post(self.admin, "/api/admin/restore", data)
        self.assertEqual(len(self.store.S["docs"]), 1)
        self.assertEqual(len(self.store.S["wallets"]), 3)
        # после перезапуска данные читаются из базы
        self.store.load()
        self.assertEqual(self.store.S["docs"][0]["lines"][0]["sum"], 10)


if __name__ == "__main__":
    unittest.main()
