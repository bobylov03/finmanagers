"""Общие утилиты: округление, числа, даты, нормализация строк."""
import math
import re
import secrets
import time
from datetime import date, datetime, timedelta, timezone


def uid(prefix="id"):
    return f"{prefix}_{int(time.time()*1000):x}{secrets.token_hex(3)}"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def today_iso():
    return date.today().isoformat()


def r2(x):
    """Округление до центов — только итоговых сумм (ТР-32). Как Math.round в JS, без банковского округления."""
    if x is None or not math.isfinite(x):
        return x
    s = -1 if x < 0 else 1
    return s * math.floor(abs(x) * 100 + 1e-7 + 0.5) / 100


def fmt(n, dec=2):
    """13 614 703,88 — для текстов версий и журнала."""
    if n is None or (isinstance(n, float) and not math.isfinite(n)):
        return "—"
    v = r2(n) if dec == 2 else n
    neg = v < 0
    s = f"{abs(v):,.{dec}f}".replace(",", " ").replace(".", ",")
    return ("−" if neg and abs(v) > 0 else "") + s


def fmt_d(iso):
    if not iso:
        return "—"
    p = str(iso)[:10].split("-")
    return f"{p[2]}.{p[1]}.{p[0]}" if len(p) == 3 else str(iso)


def parse_num(v):
    if isinstance(v, bool):
        return float("nan")
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        return float("nan")
    s = re.sub(r"[\s  ']", "", str(v).strip()).replace("−", "-")
    if not s:
        return float("nan")
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".", 1)
        else:
            s = s.replace(",", "")
    else:
        s = s.replace(",", ".", 1)
    if not re.fullmatch(r"-?\d*\.?\d+", s) and not re.fullmatch(r"-?\d+\.?", s):
        return float("nan")
    return float(s)


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def parse_date(v):
    """Дата из файла: ISO, дд.мм.гггг, серийный номер Excel."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if 20000 < v < 80000:
            return (date(1899, 12, 30) + timedelta(days=round(v))).isoformat()
        return None
    s = str(v).strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        y, mo, d = m.groups()
    else:
        m = re.match(r"^(\d{1,2})[./](\d{1,2})[./](\d{2,4})", s)
        if not m:
            n = parse_num(s)
            return parse_date(n) if math.isfinite(n) else None
        d, mo, y = m.groups()
        if len(y) == 2:
            y = "20" + y
    try:
        return date(int(y), int(mo), int(d)).isoformat()
    except ValueError:
        return None


def valid_iso(s):
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return False
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def add_days(iso, n):
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def prev_month_end(iso):
    d = date.fromisoformat(iso[:7] + "-01")
    return (d - timedelta(days=1)).isoformat()


_NORM_RE = re.compile(r"[\s_\-.,«»\"()/]")


def norm(s):
    return _NORM_RE.sub("", str(s if s is not None else "").lower().replace("ё", "е"))


def txt(v):
    return "" if v is None else str(v).strip()
