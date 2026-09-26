"""Collect every awarded KPPP works tender since May 2023 into a history store.

The website keeps only recent results (collect_results.py). This collector walks back through all
of KPPP's awarded works tenders (about 1 lakh) and keeps, in the "history" branch:

  results/{YYYY-MM}.json      each tender: winner and every bidder's total, rank and % vs estimate
  items/{YYYY-MM}.json.gz     each tender's item-wise quoted rates of every bidder
  excel/works-results-{YYYY}.xlsx   one sheet of tenders, one of all bids (for download)
  excel/works-item-rates.xlsx       past winning rates for every BOQ item seen
  rates.json.gz               the same item rates, read by collect_details.py for live tenders
  similar.json                how similar tenders were won, per department / district and type of work
  index.json                  what is there, for the website's download list

The work is split into parts that run at the same time (each looks up every Nth page of KPPP's
list), then merged. Tenders already in the history are skipped, so an unfinished run is simply
continued by the next one; once the whole history is in, each run only adds new awards.
"""

import gzip
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook

from build_lite import district_of, iso_ist, positive
from collect_results import (API, AWARDS, CACHE, HEADERS, SEARCH, clean, fetch_statement, full_view, list_page,
                             make_session, quantiles, with_pct)

TIME_BUDGET = int(os.getenv("HISTORY_TIME_BUDGET", "18000"))
WORKERS = int(os.getenv("HISTORY_WORKERS", "6"))
CATEGORY = "WORKS"


def month_of(record):
    return (record.get("closed") or record.get("published") or "unknown")[:7]


def load_json(path, default):
    try:
        if path.suffix == ".gz":
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                return json.load(fh)
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


class Store:
    """Results and item rates, one file per month, loaded when first needed."""

    def __init__(self, root):
        self.root = root
        self.results = {}   # month -> {nit: record}
        self.items = {}     # month -> {nit: items}
        self.dirty = set()
        for path in (root / "results").glob("*.json"):
            self.results[path.stem] = load_json(path, {})
        self.known = {nit for month in self.results.values() for nit in month}

    def month_items(self, month):
        if month not in self.items:
            self.items[month] = load_json(self.root / "items" / f"{month}.json.gz", {})
        return self.items[month]

    def add(self, record, items):
        month = month_of(record)
        self.results.setdefault(month, {})[record["nit"]] = record
        if items:
            self.month_items(month)[record["nit"]] = items
        self.known.add(record["nit"])
        self.dirty.add(month)

    def save(self):
        (self.root / "results").mkdir(parents=True, exist_ok=True)
        (self.root / "items").mkdir(parents=True, exist_ok=True)
        for month in self.dirty:
            (self.root / "results" / f"{month}.json").write_text(
                json.dumps(self.results.get(month, {}), ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
            if month in self.items:
                with gzip.open(self.root / "items" / f"{month}.json.gz", "wt", encoding="utf-8", compresslevel=6) as fh:
                    json.dump(self.items[month], fh, ensure_ascii=False, separators=(",", ":"))
        self.dirty.clear()

    def all_results(self):
        for month in sorted(self.results):
            yield from self.results[month].values()

    def all_items(self):
        for path in sorted((self.root / "items").glob("*.json.gz")):
            month = path.name[:-len(".json.gz")]
            yield from (self.items[month] if month in self.items else load_json(path, {})).items()


def compact(record):
    """Only what the Excel files and comparisons need."""
    keep = ("nit", "ref", "title", "dept", "office", "district", "work", "value", "published", "closed", "awarded", "winner", "bidders")
    out = {k: record[k] for k in keep if record.get(k) not in (None, "", [])}
    out["bidders"] = [{k: b[k] for k in ("name", "amount", "rank", "pct") if b.get(k) is not None} for b in record.get("bidders") or []]
    return out


def lookup(session, raw):
    nit = str(raw.get("nitId"))
    bidders, items = fetch_statement(session, CATEGORY, nit)
    estimate = positive(raw.get("ecv"))
    with_pct(bidders, estimate)
    office, title = clean(raw.get("locationName")), clean(raw.get("title"))
    winner = bidders[0]["name"] if bidders else None
    if not bidders:
        # No comparative statement: the winner is still in the tender's award details.
        try:
            award = full_view(session, CATEGORY, nit).get("tenderAwardDatesDTO") or {}
            names = [clean(w.get("name")) for w in award.get("listOfBidderDonePBGDTO") or [] if w.get("name")]
            winner = names[0] if names else None
        except Exception:
            pass
    record = {
        "nit": nit, "ref": clean(raw.get("tenderNumber")), "title": title,
        "dept": clean(raw.get("deptName")), "office": office,
        "district": district_of(office, title, raw.get("description")),
        "work": clean(raw.get("workCategoryName")),
        "value": estimate,
        "published": iso_ist(raw.get("publishedDate")), "closed": iso_ist(raw.get("tenderClosureDate")),
        "winner": winner, "bidders": bidders,
    }
    items = [[i["key"], i["code"], i["name"], i["unit"], i["qty"], i["est"], i["rates"]] for i in items]
    return compact(record), items


def seed_from_recent(store):
    """Results the website collector already has (with award pages) need no new lookup."""
    cache = load_json(CACHE, {})
    added = 0
    for nit, record in cache.items():
        if record.get("cat") != CATEGORY or nit in store.known:
            continue
        page = load_json(AWARDS / f"{nit}.json", {})
        items = [[i.get("key"), i.get("code"), i.get("name"), i.get("unit"), i.get("qty"), i.get("est"), i.get("rates")]
                 for i in page.get("items") or []]
        store.add(compact(record), items)
        added += 1
    return added


def build_rates(store):
    groups = {}
    for nit, items in store.all_items():
        for key, code, name, unit, qty, est, rates in items:
            if not rates or not est or est <= 0 or rates[0] is None or rates[0] <= 0:
                continue
            g = groups.setdefault(key, {"names": defaultdict(int), "code": code, "unit": unit, "l1": [], "all": [], "est": [], "n": 0})
            g["names"][name] += 1
            g["l1"].append(rates[0])
            g["all"].extend(r for r in rates if r and r > 0)
            g["est"].append(est)
            g["n"] += 1
    out = {}
    for key, g in groups.items():
        l1, est = quantiles(g["l1"]), quantiles(g["est"])[2]
        out[key] = {"name": max(g["names"], key=g["names"].get), "code": g["code"], "unit": g["unit"], "tenders": g["n"],
                    "est": est, "l1": l1, "all": quantiles(g["all"])[1:4], "ratio": round(l1[2] / est, 4) if est else None}
    return out


def build_similar(results):
    """Winning bid vs estimate per (department, type of work) and (district, type of work)."""
    groups = defaultdict(lambda: {"pcts": [], "bidders": [], "wins": defaultdict(int)})
    for r in results:
        bidders = r.get("bidders") or []
        pct = bidders[0].get("pct") if bidders else None
        for key in (f"d|{r.get('dept') or ''}|{r.get('work') or ''}", f"x|{r.get('district') or ''}|{r.get('work') or ''}"):
            g = groups[key]
            if pct is not None and -80 < pct < 80:
                g["pcts"].append(pct)
            if bidders:
                g["bidders"].append(len(bidders))
            if r.get("winner"):
                g["wins"][r["winner"]] += 1
    out = {}
    for key, g in groups.items():
        if len(g["pcts"]) < 3:
            continue
        q = quantiles(g["pcts"])
        out[key] = {"n": len(g["pcts"]), "q": [q[1], q[2], q[3]],
                    "bidders": round(sum(g["bidders"]) / len(g["bidders"]), 1) if g["bidders"] else None,
                    "top": sorted(g["wins"].items(), key=lambda kv: -kv[1])[:3]}
    return out


def date_only(value):
    return (value or "")[:10] or None


def write_excel(results, rates, root):
    folder = root / "excel"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.xlsx"):
        old.unlink()
    by_year = defaultdict(list)
    for r in results:
        by_year[(r.get("closed") or r.get("published") or "unknown")[:4]].append(r)
    files = []
    for year, rows in sorted(by_year.items()):
        rows.sort(key=lambda r: r.get("closed") or "", reverse=True)
        wb = Workbook(write_only=True)
        ws = wb.create_sheet("Tenders")
        ws.append(["Tender number", "NIT id", "Work", "Department", "Office", "District", "Type of work", "Estimate (Rs)",
                   "Published", "Bids closed", "Winner", "Winning bid (Rs)", "Winner vs estimate %", "Bidders",
                   "L2 bidder", "L2 bid (Rs)", "L1 below L2 %"])
        bids = wb.create_sheet("All bids")
        bids.append(["Tender number", "NIT id", "Work", "Department", "District", "Type of work", "Estimate (Rs)",
                     "Bids closed", "Rank", "Bidder", "Quoted amount (Rs)", "vs estimate %"])
        n_bids = 0
        for r in rows:
            b = r.get("bidders") or []
            l1 = b[0] if b else {}
            l2 = b[1] if len(b) > 1 else {}
            gap = round((l2["amount"] - l1["amount"]) / l2["amount"] * 100, 2) if l1.get("amount") and l2.get("amount") else None
            ws.append([r.get("ref"), r.get("nit"), r.get("title"), r.get("dept"), r.get("office"), r.get("district"), r.get("work"),
                       r.get("value"), date_only(r.get("published")), date_only(r.get("closed")), r.get("winner"),
                       l1.get("amount"), l1.get("pct"), len(b) or None, l2.get("name"), l2.get("amount"), gap])
            for bidder in b:
                bids.append([r.get("ref"), r.get("nit"), r.get("title"), r.get("dept"), r.get("district"), r.get("work"), r.get("value"),
                             date_only(r.get("closed")), f"L{bidder['rank']}" if bidder.get("rank") else None,
                             bidder.get("name"), bidder.get("amount"), bidder.get("pct")])
                n_bids += 1
        name = f"works-results-{year}.xlsx"
        wb.save(folder / name)
        files.append({"file": name, "year": year, "tenders": len(rows), "bids": n_bids, "bytes": (folder / name).stat().st_size})

    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Item rates")
    ws.append(["Item code", "Item", "Unit", "Tenders", "Department rate (median, Rs)", "Winning rate lowest", "Winning rate 25%",
               "Winning rate median", "Winning rate 75%", "Winning rate highest", "Winning median vs department %",
               "All bidders 25%", "All bidders median", "All bidders 75%"])
    for key, g in sorted(rates.items(), key=lambda kv: -kv[1]["tenders"]):
        l1 = g["l1"]
        ws.append([g["code"], g["name"], g["unit"], g["tenders"], g["est"], *l1,
                   round((g["ratio"] - 1) * 100, 2) if g.get("ratio") else None, *g["all"]])
    name = "works-item-rates.xlsx"
    wb.save(folder / name)
    files.append({"file": name, "year": None, "items": len(rates), "bytes": (folder / name).stat().st_size})
    return files


def total_pages(session):
    response = session.post(f"{API}/{SEARCH[CATEGORY]}?page=0&size=1&order-by-tender-publish=true",
                            json={"category": CATEGORY, "status": "AWARDED", "title": ""}, headers=HEADERS, timeout=120)
    response.raise_for_status()
    return (int(response.headers.get("X-Total-Count") or 0) + 99) // 100


def collect(history, out, shard, shards):
    """Look up one part of KPPP's awarded list (pages shard, shard + shards, ...) into a new store."""
    started = time.monotonic()
    out_of_time = lambda: time.monotonic() - started > TIME_BUDGET
    known = Store(history).known
    filled = load_json(history / "state.json", {}).get("filled", False)
    store = Store(out)
    session = make_session()
    pages = total_pages(session)
    print(f"KPPP lists {pages} pages of awarded works ({int(time.monotonic() - started)}s)", flush=True)
    # Interleaved pages spread old and new tenders evenly over the parts.
    mine = list(range(shard, pages + 1, shards))
    print(f"Part {shard + 1}/{shards}: {len(mine)} of {pages} pages; {len(known)} already in history", flush=True)
    ok = failed = 0
    stats = {"pages_done": 0, "pages": len(mine)}

    def run(raw):
        return None if out_of_time() else lookup(session, raw)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for n, page in enumerate(mine, 1):
            if out_of_time():
                break
            try:
                batch = list_page(session, CATEGORY, page)
            except Exception as exc:
                print(f"Could not list page {page}: {exc}", flush=True)
                continue
            todo = [raw for raw in batch if str(raw.get("nitId")) not in known and str(raw.get("nitId")) not in store.known]
            if filled and not todo:
                break  # history is complete: this part has caught up with what is known
            for future in as_completed([pool.submit(run, raw) for raw in todo]):
                try:
                    done = future.result()
                except Exception:
                    failed += 1
                    continue
                if done is not None:
                    store.add(*done)
                    ok += 1
            stats["pages_done"] = n
            if n % 25 == 0 or n <= 3:
                print(f"  {n}/{len(mine)} pages, {ok} new, {failed} failed ({int(time.monotonic() - started)}s)", flush=True)
    store.save()
    stats.update(new=ok, failed=failed, finished=stats["pages_done"] == len(mine) or filled)
    (out / "part.json").write_text(json.dumps(stats), encoding="utf-8")
    print(f"Part {shard + 1} done: {ok} new, {failed} failed, {stats['pages_done']}/{len(mine)} pages ({int(time.monotonic() - started)}s)")


def build(history, parts):
    """Merge the parts into the history, then write the Excel files and comparison figures."""
    started = time.monotonic()
    store = Store(history)
    state = load_json(history / "state.json", {})
    print(f"History has {len(store.known)} works results; seeded {seed_from_recent(store)} from the website's recent results", flush=True)
    finished = bool(parts)
    for part in parts:
        info = load_json(part / "part.json", {})
        finished = finished and bool(info.get("finished"))
        other = Store(part)
        for month, records in other.results.items():
            items = other.month_items(month)
            for nit, record in records.items():
                store.add(record, items.get(nit))
        print(f"  merged {part.name}: {info}", flush=True)
    if finished:
        state["filled"] = True
    store.save()
    (history / "state.json").write_text(json.dumps(state), encoding="utf-8")

    results = list(store.all_results())
    rates = build_rates(store)
    with gzip.open(history / "rates.json.gz", "wt", encoding="utf-8") as fh:
        json.dump(rates, fh, ensure_ascii=False, separators=(",", ":"))
    similar = build_similar(results)
    (history / "similar.json").write_text(json.dumps(similar, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    files = write_excel(results, rates, history)
    closed = sorted(r["closed"] for r in results if r.get("closed"))
    (history / "index.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tenders": len(results),
        "with_bids": sum(1 for r in results if r.get("bidders")),
        "from": closed[0][:10] if closed else None,
        "to": closed[-1][:10] if closed else None,
        "complete": bool(state.get("filled")),
        "files": files,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Done: {len(results)} works results in history, {len(rates)} BOQ items, "
          f"{len(similar)} comparison groups ({int(time.monotonic() - started)}s).")


if __name__ == "__main__":
    # collect_history.py collect HISTORY OUT SHARD SHARDS  |  collect_history.py build HISTORY PART...
    if sys.argv[1] == "collect":
        collect(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]))
    else:
        build(Path(sys.argv[2]), [Path(p) for p in sys.argv[3:]])
