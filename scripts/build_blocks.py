"""Generate site/data/blocks.json: block geometry + parsed ASP rules.

Geometry: per-avenue least-squares lines fitted through NYC DOT camera coordinates
(they sit exactly at intersections), interpolated to every street 59-78.
Regulations: NYC Open Data "Parking Regulation Locations and Signs" (nfid-uabd),
parsed for street-cleaning (broom) windows per blockface side. Degrades gracefully
if Socrata is unreachable: geometry still ships, sides stay empty, rerun later.

Usage: python3 scripts/build_blocks.py   (stdlib only)
"""
import json
import math
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data" / "blocks.json"
HOME = (40.7689, -73.9685)

# (street_number, lat, lng) — NYC DOT camera positions at these intersections
ANCHORS = {
    "5AV":  [(59, 40.764289, -73.973023), (60, 40.764959, -73.972578), (66, 40.768651, -73.969814)],
    "MAD":  [(57, 40.762296, -73.972357), (79, 40.776331, -73.962123)],
    "PARK": [(57, 40.761616, -73.970752), (72, 40.771140, -73.963907), (79, 40.775652, -73.960350)],
    "LEX":  [(57, 40.760927, -73.969147), (72, 40.770429, -73.962214)],
    "3AV":  [(57, 40.760253, -73.967542), (76, 40.772340, -73.958700)],
    "2AV":  [(59, 40.760978, -73.964082), (72, 40.768801, -73.958427), (74, 40.770142, -73.957381)],
}
AVE_ORDER = ["5AV", "MAD", "PARK", "LEX", "3AV", "2AV"]
AVE_SHORT = {"5AV": "5th", "MAD": "Mad", "PARK": "Park", "LEX": "Lex", "3AV": "3rd", "2AV": "2nd"}
AVE_FULL = {"5AV": "5th Ave", "MAD": "Madison Ave", "PARK": "Park Ave",
            "LEX": "Lexington Ave", "3AV": "3rd Ave", "2AV": "2nd Ave"}
STREETS = list(range(59, 79))  # E 59 .. E 78

SODA = "https://data.cityofnewyork.us/resource/nfid-uabd.json"


def linfit(pts):
    """pts: [(x, y)] -> (a, b) for y = a + b*x, least squares."""
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    denom = sum((p[0] - mx) ** 2 for p in pts) or 1e-9
    b = sum((p[0] - mx) * (p[1] - my) for p in pts) / denom
    return my - b * mx, b


FITS = {ave: (linfit([(s, la) for s, la, _ in pts]), linfit([(s, ln) for s, _, ln in pts]))
        for ave, pts in ANCHORS.items()}


def intersection(ave, street):
    (la0, la1), (ln0, ln1) = FITS[ave]
    return la0 + la1 * street, ln0 + ln1 * street


def miles(p, q):
    dy = (p[0] - q[0]) * 69.05
    dx = (p[1] - q[1]) * 69.17 * math.cos(math.radians(p[0]))
    return math.hypot(dx, dy)


# ---------------------------------------------------------------- regulations

DAY_TOKENS = [("WEDNESDAY", 3), ("THURSDAY", 4), ("SATURDAY", 6), ("TUESDAY", 2),
              ("MONDAY", 1), ("FRIDAY", 5), ("SUNDAY", 0),
              ("THURS", 4), ("THUR", 4), ("TUES", 2), ("THU", 4), ("TUE", 2),
              ("MON", 1), ("WED", 3), ("FRI", 5), ("SAT", 6), ("SUN", 0)]
DAY_WORD = "MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY|MON|TUES?|WED|THURS?|FRI|SAT|SUN"
DAY_RANGE_RX = re.compile(rf"({DAY_WORD})\s*(?:-|THRU|TO)\s*({DAY_WORD})")
TIME_RX = re.compile(
    r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM|NOON|MIDNIGHT)?\s*(?:-|TO)\s*"
    r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM|NOON|MIDNIGHT)?")


def to_minutes(hh, mm, mer):
    h, m = int(hh), int(mm or 0)
    if mer == "NOON":
        return 12 * 60
    if mer == "MIDNIGHT":
        return 0
    if mer == "PM" and h != 12:
        h += 12
    if mer == "AM" and h == 12:
        h = 0
    return h * 60 + m


def parse_window(desc):
    m = TIME_RX.search(desc)
    if not m:
        return None
    h1, m1, mer1, h2, m2, mer2 = m.groups()
    if not mer2:
        return None
    end = to_minutes(h2, m2, mer2)
    start = to_minutes(h1, m1, mer1 or mer2)
    if start >= end and not mer1:      # "11-1PM" -> 11AM-1PM
        start = to_minutes(h1, m1, "AM" if mer2 == "PM" else "PM")
    if start >= end:
        return None
    return start, end


def day_num(tok):
    for t, n in DAY_TOKENS:
        if tok.startswith(t) or t.startswith(tok):
            return n
    return None


def parse_days(desc):
    raw = desc.upper()
    rng = DAY_RANGE_RX.search(raw)
    if rng:
        a, b = day_num(rng.group(1)), day_num(rng.group(2))
        if a is not None and b is not None and a < b:
            return list(range(a, b + 1))
    up = " " + re.sub(r"[^A-Z]", " ", raw) + " "
    found = set()
    for tok, num in DAY_TOKENS:
        if f" {tok} " in up:
            found.add(num)
    return sorted(found)


def ave_key(name):
    s = (name or "").upper()
    if "MADISON" in s:
        return "MAD"
    if "LEX" in s:
        return "LEX"
    if "PARK" in s and "CENTRAL" not in s:
        return "PARK"
    if re.search(r"\b5(TH)?\b", s) or "FIFTH" in s:
        return "5AV"
    if re.search(r"\b3(RD)?\b", s) or "THIRD" in s:
        return "3AV"
    if re.search(r"\b2(ND)?\b", s) or "SECOND" in s:
        return "2AV"
    return None


def soda_get(params):
    url = SODA + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "parkscout-build/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
    data = json.loads(body)
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(data.get("message", "soda error"))
    return data


def fetch_signs():
    """Returns rows or raises. Discovers the on_street naming format first."""
    probe = soda_get({"$limit": "1"})
    if not probe:
        raise RuntimeError("empty dataset")
    cols = set(probe[0])
    f_on = next(c for c in ["on_street", "onstreet", "main_street"] if c in cols)
    f_from = next(c for c in ["from_street", "fromstreet"] if c in cols)
    f_to = next(c for c in ["to_street", "tostreet"] if c in cols)
    f_side = next(c for c in ["side_of_street", "sideofstreet", "side"] if c in cols)
    f_desc = next(c for c in ["sign_description", "signdescription", "description"] if c in cols)

    candidates = [lambda n: f"EAST {n:>4} STREET",   # DOT pads to a fixed column
                  lambda n: f"E {n} ST",
                  lambda n: f"EAST {n} STREET",
                  lambda n: f"E {n}TH ST"]
    fmt_fn = None
    for cand in candidates:
        hit = soda_get({"$limit": "1", "$where": f"upper({f_on})='{cand(68)}'"})
        if hit:
            fmt_fn = cand
            break
    if not fmt_fn:
        raise RuntimeError("could not discover street name format")

    borough = " AND borough='Manhattan'" if "borough" in cols else ""
    names = ",".join(f"'{fmt_fn(n)}'" for n in STREETS)
    rows = soda_get({"$limit": "50000",
                     "$select": ",".join([f_on, f_from, f_to, f_side, f_desc]),
                     "$where": f"upper({f_on}) in({names}){borough}"})
    print(f"regs: format={fmt_fn(68)!r}, rows={len(rows)}")
    return rows, (f_on, f_from, f_to, f_side, f_desc)


def build_sides(rows, fields):
    f_on, f_from, f_to, f_side, f_desc = fields
    sides = {}
    unparsed = []
    for row in rows:
        st_m = re.search(r"\d+", row.get(f_on, "") or "")
        a, b = ave_key(row.get(f_from)), ave_key(row.get(f_to))
        if not (st_m and a and b) or a == b:
            continue  # Brooklyn homonyms and unmapped cross streets fall out here
        i, j = AVE_ORDER.index(a), AVE_ORDER.index(b)
        if abs(i - j) != 1:
            continue
        west, east = (a, b) if i < j else (b, a)
        key = (int(st_m.group()), west, east, (row.get(f_side) or "?")[0].upper())
        desc = (row.get(f_desc) or "").upper()
        rec = sides.setdefault(key, {"asp": {}, "noStanding": 0, "noParking": 0,
                                     "meter": 0, "signs": 0})
        rec["signs"] += 1
        if "BROOM" in desc or "SANITATION" in desc:
            win, days = parse_window(desc), parse_days(desc)
            if win and days:
                k = (tuple(days), win)
                rec["asp"][k] = rec["asp"].get(k, 0) + 1
            else:
                unparsed.append(desc)
        elif "NO STANDING" in desc and "ANYTIME" in desc:
            rec["noStanding"] += 1
        elif "NO PARKING" in desc and "ANYTIME" in desc:
            rec["noParking"] += 1
        elif "METER" in desc or " MTR" in desc:
            rec["meter"] += 1
    if unparsed:
        print(f"regs: {len(unparsed)} broom signs unparsed; samples:")
        for s in unparsed[:5]:
            print("   ", s[:100])
    return sides


def main():
    regs_source = None
    sides = {}
    try:
        rows, fields = fetch_signs()
        sides = build_sides(rows, fields)
        regs_source = "nfid-uabd"
    except Exception as e:  # noqa: BLE001
        print(f"WARNING: regulations fetch failed ({e}); shipping geometry only. "
              f"Rerun this script later to fill ASP rules.")

    lng68 = {ave: intersection(ave, 68)[1] for ave in AVE_ORDER}
    lo, hi = min(lng68.values()), max(lng68.values())
    ave_x = {ave: round((lng68[ave] - lo) / (hi - lo), 4) for ave in AVE_ORDER}

    blocks = []
    asp_sides = 0
    for st in STREETS:
        for i in range(len(AVE_ORDER) - 1):
            west, east = AVE_ORDER[i], AVE_ORDER[i + 1]
            p1, p2 = intersection(west, st), intersection(east, st)
            cen = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
            d = miles(cen, HOME)
            blk = {"id": f"E{st}_{west}_{east}", "street": st, "west": west, "east": east,
                   "label": f"E {st} · {AVE_SHORT[west]}–{AVE_SHORT[east]}",
                   "full": f"E {st}th St, {AVE_FULL[west]} → {AVE_FULL[east]}",
                   "lat": round(cen[0], 6), "lng": round(cen[1], 6),
                   "dist": round(d, 3), "inRadius": d <= 0.5, "sides": {}}
            for sk in ("N", "S"):
                rec = sides.get((st, west, east, sk))
                if not rec:
                    continue
                best = max(rec["asp"].items(), key=lambda kv: kv[1])[0] if rec["asp"] else None
                blk["sides"][sk] = {
                    "asp": ({"days": list(best[0]), "start": best[1][0], "end": best[1][1]}
                            if best else None),
                    "noStanding": rec["noStanding"], "noParking": rec["noParking"],
                    "meter": rec["meter"], "signs": rec["signs"]}
                if best:
                    asp_sides += 1
            blocks.append(blk)

    out = {"generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "regsSource": regs_source, "home": {"lat": HOME[0], "lng": HOME[1]},
           "aveOrder": AVE_ORDER, "aveShort": AVE_SHORT, "aveFull": AVE_FULL,
           "aveX": ave_x, "streets": STREETS, "blocks": blocks}
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    n_in = sum(1 for b in blocks if b["inRadius"])
    print(f"blocks: {len(blocks)} total, {n_in} in radius, "
          f"{asp_sides} blockface sides with parsed ASP -> {OUT}")


if __name__ == "__main__":
    main()
