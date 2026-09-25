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
TARGET = Path("public/results-lite.json")
API = "https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service"
SEARCH = {"WORKS": "works/search-eproc-tenders", "GOODS": "search-eproc-tenders", "SERVICES": "services/search-eproc-tenders"}
FULL_VIEW = {"WORKS": "works-tender-full-view", "GOODS": "goods-tender-full-view", "SERVICES": "service-tender-full-view"}

# How far back to list awarded tenders (newest first), and how many new ones to look up per run.
LIST_LIMIT = {"WORKS": int(os.getenv("RESULTS_WORKS_LIMIT", "6000")),
              "GOODS": int(os.getenv("RESULTS_GOODS_LIMIT", "1500")),
              "SERVICES": int(os.getenv("RESULTS_SERVICES_LIMIT", "1500"))}
MAX_LOOKUPS = int(os.getenv("RESULTS_MAX_LOOKUPS", "1200"))
# Stop starting new lookups after this many seconds so the run always saves what it has.
TIME_BUDGET = int(os.getenv("RESULTS_TIME_BUDGET", "1200"))
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


def list_awarded(session, category):
    rows, page = [], 0
    while len(rows) < LIST_LIMIT[category]:
        response = session.post(
            f"{API}/{SEARCH[category]}?page={page}&size={PAGE_SIZE}&order-by-tender-publish=true",
            json={"category": category, "status": "AWARDED", "title": ""}, headers=HEADERS, timeout=60)
        response.raise_for_status()
        batch = response.json() or []
        if not batch:
            break
        rows.extend(batch)
        page += 1
    return rows[:LIST_LIMIT[category]]


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def parse_statement(content):
    """Bidders, their totals, ranks and % vs estimate from a WORKS comparative statement."""
    sheet = load_workbook(io.BytesIO(content)).worksheets[0]
    rows = [[c for c in row if c not in (None, "")] for row in sheet.iter_rows(values_only=True)]
    names, totals = [], []
    for i, row in enumerate(rows):
        if not row:
            continue
        head = clean(row[0]).lower()
        if head.startswith("dept name") or head.startswith("department name"):
            # The bidder names are on the next non-empty row.
            for nxt in rows[i + 1:i + 4]:
                if nxt:
                    names = [clean(n) for n in nxt]
                    break
        elif head.startswith("total bid amount"):
            totals = [clean(v) for v in row[1:]]
    bidders = []
    for idx, name in enumerate(names):
        total = totals[idx] if idx < len(totals) else ""
        rank = re.search(r"\(L(\d+)\)", total)
        bidders.append({
            "name": name,
            "amount": positive(re.sub(r"\(.*?\)", "", total)),
            "rank": int(rank.group(1)) if rank else None,
            })
    bidders.sort(key=lambda b: (b["rank"] is None, b["rank"] or 0))
    return bidders


def lookup(session, category, raw):
    nit = raw.get("nitId")
    full = session.get(f"{API}/{nit}/{FULL_VIEW[category]}", headers=HEADERS, timeout=40)
    full.raise_for_status()
    detail = full.json() or {}
    award = detail.get("tenderAwardDatesDTO") or {}
    winners = [clean(w.get("name")) for w in award.get("listOfBidderDonePBGDTO") or [] if w.get("name")]
    bidders = []
    if category == "WORKS":
        sheet = session.get(
            f"{API}/tender-eval/{nit}/commercial-evaluation/tender-category/{category}/commercial-comparison/download-detailed",
            headers={**HEADERS, "Accept": "*/*"}, timeout=60)
        if sheet.status_code == 200 and sheet.content[:2] == b"PK":
            try:
                bidders = parse_statement(sheet.content)
            except Exception:
                bidders = []
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
    return {k: v for k, v in record.items() if v not in (None, "", [])}


def main():
    session = make_session()
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    todo = []
    for category in SEARCH:
        try:
            listed = list_awarded(session, category)
        except Exception as exc:
            print(f"Could not list awarded {category}: {exc}")
            continue
        print(f"{category}: {len(listed)} awarded tenders listed", flush=True)
        todo.extend((category, raw) for raw in listed if raw.get("nitId") and str(raw["nitId"]) not in cache)
    todo = todo[:MAX_LOOKUPS]

    started = time.monotonic()
    ok = failed = 0

    def save():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True), encoding="utf-8")

    def guarded(cat, raw):
        # Lookups queued after the time budget are skipped, not started.
        if time.monotonic() - started > TIME_BUDGET:
            return None
        return lookup(session, cat, raw)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(guarded, cat, raw): raw for cat, raw in todo}
        for future in as_completed(futures):
            try:
                record = future.result()
            except Exception:
                failed += 1
                continue
            if record is None:
                continue
            cache[record["nit"]] = record
            ok += 1
            if ok % 200 == 0:
                save()
                print(f"  {ok} results saved ({int(time.monotonic() - started)}s)", flush=True)

    save()
    results = sorted(cache.values(), key=lambda r: r.get("awarded") or r.get("closed") or "", reverse=True)
    TARGET.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(results),
        "results": results,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_bids = sum(1 for r in results if r.get("bidders"))
    print(f"Looked up {len(todo)}: {ok} ok, {failed} failed. {len(results)} results, {with_bids} with bidder amounts "
          f"({TARGET.stat().st_size / 1e6:.2f} MB).")


if __name__ == "__main__":
    main()
