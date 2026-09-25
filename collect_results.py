"""Collect results of awarded KPPP tenders into public/results-lite.json.

For each awarded tender KPPP publishes, without a login:
  * the winner (tenderAwardDatesDTO in the tender full view), and
  * for WORKS, a "Comparative Statement" spreadsheet with every bidder's
    total quoted amount, rank (L1, L2 ...) and % against the estimate.

Results never change once awarded, so each tender is fetched once and kept in
data/results-cache.json; each run only looks up newly awarded tenders.
"""

import io
import time
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests
from openpyxl import load_workbook
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from build_lite import district_of, iso_ist, positive

CACHE = Path("data/results-cache.json")
ITEMS_CACHE = Path("data/item-rates-cache.json")
TARGET = Path("public/results-lite.json")
RATES = Path("public/rates-lite.json")
API = "https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service"
SEARCH = {"WORKS": "works/search-eproc-tenders", "GOODS": "search-eproc-tenders", "SERVICES": "services/search-eproc-tenders"}
FULL_VIEW = {"WORKS": "works-tender-full-view", "GOODS": "goods-tender-full-view", "SERVICES": "service-tender-full-view"}

# Pages of 100 awarded tenders (newest first) to list per run. KPPP takes ~40s per page, so this
# is kept small; each run first catches up on newly awarded tenders, then spends what is left on
# older pages, continuing from where the last run stopped (data/results-state.json).
LIST_PAGES = {"WORKS": int(os.getenv("RESULTS_WORKS_PAGES", "6")),
              "GOODS": int(os.getenv("RESULTS_GOODS_PAGES", "1")),
              "SERVICES": int(os.getenv("RESULTS_SERVICES_PAGES", "1"))}
MAX_LOOKUPS = int(os.getenv("RESULTS_MAX_LOOKUPS", "1200"))
# Stop listing / starting lookups after this many seconds (from the start of the run) so the
# run always finishes and saves what it has.
TIME_BUDGET = int(os.getenv("RESULTS_TIME_BUDGET", "1200"))
STATE = Path("data/results-state.json")
WORKERS = int(os.getenv("RESULTS_WORKERS", "6"))
PAGE_SIZE = 100

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://kppp.karnataka.gov.in",
    "Referer": "https://kppp.karnataka.gov.in/",
    "Post": "CONTRACTOR-EPROC-CONTRACTOR",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}


def make_session():
    session = requests.Session()
    retry = Retry(total=2, backoff_factor=1, status_forcelist=[429, 502, 503, 504], allowed_methods=["GET", "POST"])
    session.mount("https://", HTTPAdapter(max_retries=retry, pool_maxsize=WORKERS))
    return session


def list_page(session, category, page):
    response = session.post(
        f"{API}/{SEARCH[category]}?page={page}&size={PAGE_SIZE}&order-by-tender-publish=true",
        json={"category": category, "status": "AWARDED", "title": ""}, headers=HEADERS, timeout=90)
    response.raise_for_status()
    return response.json() or []


def list_awarded(session, category, cache, state, out_of_time):
    """Newly awarded tenders first (until a page is already fully known), then older pages."""
    rows, budget = [], LIST_PAGES[category]
    page = 0
    while budget > 0 and not out_of_time():
        batch = list_page(session, category, page)
        budget -= 1
        rows.extend(batch)
        if not batch or all(str(r.get("nitId")) in cache for r in batch):
            break
        page += 1
    # Spend what is left of this run's pages further back in history.
    cursor = max(state.get(category, 1), page + 1)
    while budget > 0 and not out_of_time():
        batch = list_page(session, category, cursor)
        budget -= 1
        if not batch:
            break
        rows.extend(batch)
        cursor += 1
    state[category] = cursor
    return rows


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def item_key(code, name, unit):
    """Match the same BOQ item across tenders: schedule code + unit + first words of the name.

    Custom codes ("code01", "Item No. 3") mean nothing across tenders, so those items match by name.
    public/app.js has the same function; keep them in step.
    """
    c = re.sub(r"\s+", "", str(code or "").lower())
    if re.fullmatch(r"(code|itemno\.?|item|sl\.?no\.?)?\d*", c):
        c = ""
    n = " ".join(re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).split()[:10])
    u = re.sub(r"\s+", "", str(unit or "").lower())
    return f"{c}|{u}|{n}"


def num(value):
    try:
        return float(str(value).replace(",", "").strip())
    except Exception:
        return None


def parse_statement(content):
    """Bidders (total, rank) and item-wise quoted rates from a WORKS comparative statement.

    Layout: bidder names sit above their "Quoted Rate" column; the next column is that
    bidder's item amount, and the "Total Bid Amount" row carries "<total> (L<rank>)" there.
    KPPP lists every item twice, so items are de-duplicated.
    """
    rows = [list(r) for r in load_workbook(io.BytesIO(content)).worksheets[0].iter_rows(values_only=True)]
    text = lambda v: clean(v).lower()
    header_at = next(i for i, r in enumerate(rows) if r and text(r[0]).startswith(("sno", "sl. no", "sl.no")))
    header = [text(v) for v in rows[header_at]]
    col = {name: header.index(name) for name in ("item name", "item code", "unit", "estimate quantity", "estimate rate") if name in header}
    quoted_cols = [j for j, h in enumerate(header) if h == "quoted rate"]
    names_row = next((r for r in reversed(rows[:header_at]) if any(r[j] not in (None, "") for j in quoted_cols if j < len(r))), [])
    totals_row = next((r for r in rows if any(text(v).startswith("total bid amount") for v in r)), [])

    bidders = []
    for j in quoted_cols:
        total = clean(totals_row[j + 1]) if j + 1 < len(totals_row) else ""
        rank = re.search(r"\(L(\d+)\)", total)
        bidders.append({
            "name": clean(names_row[j]) if j < len(names_row) else "",
            "amount": positive(re.sub(r"\(.*?\)", "", total)),
            "rank": int(rank.group(1)) if rank else None,
            "_col": j,
        })

    items, seen = [], set()
    for r in rows[header_at + 1:]:
        if any(text(v).startswith("total summary") for v in r):
            break
        get = lambda name: r[col[name]] if name in col and col[name] < len(r) else None
        name, code, unit = clean(get("item name")), clean(get("item code")), clean(get("unit"))
        qty, est = num(get("estimate quantity")), num(get("estimate rate"))
        if not name or est is None:
            continue
        rates = [num(r[b["_col"]]) if b["_col"] < len(r) else None for b in bidders]
        sig = (code, name, qty, est, tuple(rates))
        if sig in seen:
            continue
        seen.add(sig)
        items.append({"key": item_key(code, name, unit), "code": code, "name": name[:140], "unit": unit,
                      "qty": qty, "est": est, "rates": rates})

    # Order bidders (and each item's rates) by rank, L1 first.
    order = sorted(range(len(bidders)), key=lambda i: (bidders[i]["rank"] is None, bidders[i]["rank"] or 0))
    bidders = [{k: v for k, v in bidders[i].items() if k != "_col"} for i in order]
    for item in items:
        item["rates"] = [item["rates"][i] for i in order]
    return bidders, items


def fetch_statement(session, category, nit):
    sheet = session.get(
        f"{API}/tender-eval/{nit}/commercial-evaluation/tender-category/{category}/commercial-comparison/download-detailed",
        headers={**HEADERS, "Accept": "*/*"}, timeout=60)
    if sheet.status_code != 200 or sheet.content[:2] != b"PK":
        return [], []
    try:
        return parse_statement(sheet.content)
    except Exception:
        return [], []


def lookup(session, category, raw):
    nit = raw.get("nitId")
    full = session.get(f"{API}/{nit}/{FULL_VIEW[category]}", headers=HEADERS, timeout=40)
    full.raise_for_status()
    detail = full.json() or {}
    award = detail.get("tenderAwardDatesDTO") or {}
    winners = [clean(w.get("name")) for w in award.get("listOfBidderDonePBGDTO") or [] if w.get("name")]
    bidders, items = fetch_statement(session, category, nit) if category == "WORKS" else ([], [])
    # KPPP's own "% against Estimated Rate" is taken against a double-counted
    # estimate, so work it out from the tender's estimated contract value.
    estimate = positive(raw.get("ecv"))
    for bidder in bidders:
        bidder["pct"] = round((bidder["amount"] / estimate - 1) * 100, 2) if estimate and bidder.get("amount") else None
    awarded_ms = award.get("awardedDates")
    office = clean(raw.get("locationName"))
    title = clean(raw.get("title"))
    record = {
        "nit": str(nit),
        "ref": clean(raw.get("tenderNumber")),
        "title": title,
        "cat": category,
        "dept": clean(raw.get("deptName")),
        "office": office,
        "district": district_of(office, title, raw.get("description")),
        "work": clean(raw.get("workCategoryName")),
        "value": positive(raw.get("ecv")) if raw.get("ecvtenderYn") else None,
        "published": iso_ist(raw.get("publishedDate")),
        "closed": iso_ist(raw.get("tenderClosureDate")),
        "awarded": datetime.fromtimestamp(awarded_ms / 1000, timezone.utc).isoformat(timespec="seconds") if awarded_ms else None,
        "winner": winners[0] if winners else (bidders[0]["name"] if bidders else None),
        "bidders": bidders,
    }
    return {k: v for k, v in record.items() if v not in (None, "", [])}, items


def quantiles(values):
    v = sorted(values)
    pick = lambda q: round(v[min(len(v) - 1, int(q * (len(v) - 1) + 0.5))], 2)
    return [pick(0), pick(0.25), pick(0.5), pick(0.75), pick(1)]


def build_rates(results, items_cache):
    """Per BOQ item: what winners (L1) and all bidders quoted, against the department's rate."""
    groups = {}
    for nit, items in items_cache.items():
        result = results.get(nit) or {}
        for item in items:
            rates = item.get("rates") or []
            est = item.get("est")
            if not rates or not est or est <= 0 or rates[0] is None or rates[0] <= 0:
                continue
            g = groups.setdefault(item["key"], {"names": {}, "unit": item.get("unit"), "code": item.get("code"),
                                                "l1": [], "all": [], "ratio": [], "est": [], "tenders": set(), "recent": []})
            g["names"][item["name"]] = g["names"].get(item["name"], 0) + 1
            g["l1"].append(rates[0])
            g["all"].extend(r for r in rates if r and r > 0)
            g["ratio"].append(rates[0] / est)
            g["est"].append(est)
            g["tenders"].add(nit)
            g["recent"].append((result.get("awarded") or "", rates[0], est, result.get("district") or "", nit))
    out = {}
    for key, g in groups.items():
        recent = sorted(g["recent"], reverse=True)[:5]
        out[key] = {
            "name": max(g["names"], key=g["names"].get),
            "code": g["code"], "unit": g["unit"],
            "tenders": len(g["tenders"]),
            "est": quantiles(g["est"])[2],
            "l1": quantiles(g["l1"]),
            "all": quantiles(g["all"])[1:4],
            "ratio": round(quantiles(g["ratio"])[2], 4),
            "recent": [{"date": d[:10], "rate": r, "est": e, "district": dist, "nit": n} for d, r, e, dist, n in recent],
        }
    return out


def main():
    session = make_session()
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    items_cache = json.loads(ITEMS_CACHE.read_text(encoding="utf-8")) if ITEMS_CACHE.exists() else {}
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    started = time.monotonic()
    out_of_time = lambda: time.monotonic() - started > TIME_BUDGET
    todo, seen = [], set()
    for category in SEARCH:
        try:
            listed = list_awarded(session, category, cache, state, out_of_time)
        except Exception as exc:
            print(f"Could not list awarded {category}: {exc}", flush=True)
            continue
        print(f"{category}: {len(listed)} awarded tenders listed ({int(time.monotonic() - started)}s)", flush=True)
        for raw in listed:
            nit = str(raw.get("nitId") or "")
            if nit and nit not in cache and nit not in seen:
                seen.add(nit)
                todo.append((category, raw))
    # Works results collected before item rates were stored only need their statement re-read.
    backfill = [nit for nit, r in cache.items() if r.get("cat") == "WORKS" and r.get("bidders") and nit not in items_cache]
    todo = todo[:MAX_LOOKUPS]
    backfill = backfill[:max(0, MAX_LOOKUPS - len(todo))]
    print(f"{len(todo)} new results to look up, {len(backfill)} item-rate backfills", flush=True)

    ok = failed = 0

    def save():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        STATE.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
        ITEMS_CACHE.write_text(json.dumps(items_cache, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")

    def guarded(job):
        # Jobs queued after the time budget are skipped, not started.
        if out_of_time():
            return None
        kind, cat, payload = job
        if kind == "new":
            return kind, lookup(session, cat, payload)
        return kind, (payload, fetch_statement(session, cat, payload)[1])

    jobs = [("new", cat, raw) for cat, raw in todo] + [("items", "WORKS", nit) for nit in backfill]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(guarded, job) for job in jobs]
        for future in as_completed(futures):
            try:
                done = future.result()
            except Exception:
                failed += 1
                continue
            if done is None:
                continue
            kind, value = done
            if kind == "new":
                record, items = value
                cache[record["nit"]] = record
                if items:
                    items_cache[record["nit"]] = items
            else:
                nit, items = value
                items_cache[nit] = items
            ok += 1
            if ok % 200 == 0:
                save()
                print(f"  {ok} done ({int(time.monotonic() - started)}s)", flush=True)

    save()
    results = sorted(cache.values(), key=lambda r: r.get("awarded") or r.get("closed") or "", reverse=True)
    TARGET.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(results),
        "results": results,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    rates = build_rates(cache, items_cache)
    RATES.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tenders": len(items_cache),
        "items": rates,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_bids = sum(1 for r in results if r.get("bidders"))
    print(f"Done {ok} jobs, {failed} failed. {len(results)} results, {with_bids} with bidder amounts "
          f"({TARGET.stat().st_size / 1e6:.2f} MB); {len(rates)} BOQ items with past rates "
          f"from {len(items_cache)} tenders ({RATES.stat().st_size / 1e6:.2f} MB).")


if __name__ == "__main__":
    main()
