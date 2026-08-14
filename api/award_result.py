from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
import html
import json
import os
import re
import requests

TENDERKART_API_KEY = os.getenv("TENDERKART_API_KEY", "").strip()
TENDERKART_LOOKUP = "https://tenderkart.in/api/v1/client/tenders/lookup"

SOURCES = [
    ("TenderKart", "tenderkart.in"),
    ("TenderDetail", "tenderdetail.com"),
    ("BidEasy", "tenders.infralens.in"),
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}


def clean_text(raw_html):
    if not raw_html:
        return ""
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", raw_html, flags=re.I | re.S)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def norm(v):
    return re.sub(r"[^a-z0-9]+", "", str(v or "").lower())


def parse_money(number, unit=None):
    try:
        value = float(str(number).replace(",", "").strip())
    except Exception:
        return None
    u = str(unit or "").lower()
    if u in ("l", "lakh", "lakhs", "lac", "lacs"):
        value *= 100000
    elif u in ("cr", "crore", "crores"):
        value *= 10000000
    return value if value > 0 else None


def add_bidder(bidders, name, rank, amount=None):
    name = re.sub(r"\s+", " ", str(name or "")).strip(" .,-|")
    if len(name) < 3:
        return
    if name.lower() in {"company", "bidder", "contractor", "contractor name", "bidder list"}:
        return
    key = (name.lower(), rank)
    if not any((x["name"].lower(), x["rank"]) == key for x in bidders):
        bidders.append({"name": name, "rank": rank, "amount": amount})


def extract_bidders(text):
    bidders = []

    # TenderKart AOC pages typically render:
    # Company --- ABC CONTRACTOR ₹5.0 L accepted-aoc
    company_section = re.search(
        r"\bCompany\b\s*-*\s*(.+?)(?=\s+Download\b|\s+Tender\s+Value\b|\s+EMD\s+Value\b|$)",
        text,
        flags=re.I,
    )
    if company_section:
        section = company_section.group(1)
        for m in re.finditer(
            r"([A-Za-z0-9][A-Za-z0-9&.,()'\/\- ]{2,120}?)\s*₹\s*([0-9][0-9,.]*)\s*(Cr|Crores?|L|Lakhs?|Lacs?)?\s+(?:Accepted-AOC|accepted-aoc)\b",
            section,
            flags=re.I,
        ):
            add_bidder(bidders, m.group(1), "AWARDEE", parse_money(m.group(2), m.group(3)))

    # Fallback for TenderKart pages where markup flattening leaves extra tokens.
    for m in re.finditer(
        r"(?:Company\s*-*\s*)?([A-Za-z0-9][A-Za-z0-9&.,()'\/\- ]{2,120}?)\s*₹\s*([0-9][0-9,.]*)\s*(Cr|Crores?|L|Lakhs?|Lacs?)?\s+accepted-aoc\b",
        text,
        flags=re.I,
    ):
        add_bidder(bidders, m.group(1), "AWARDEE", parse_money(m.group(2), m.group(3)))

    # TenderDetail result pages expose a Contractor Name field.
    m = re.search(
        r"Contractor\s+Name\s*\|?\s*(.{3,140}?)(?=\s+Information\s+Source\b|\s+View\s+Original\b|\s+Contract\s+Value\b|$)",
        text,
        flags=re.I,
    )
    if m:
        contract_value = None
        vm = re.search(
            r"Contract\s+Value\s*\|?\s*₹?\s*([0-9][0-9,.]*)\s*(Cr|Crores?|L|Lakhs?|Lacs?)?",
            text,
            flags=re.I,
        )
        if vm:
            contract_value = parse_money(vm.group(1), vm.group(2))
        add_bidder(bidders, m.group(1), "AWARDEE", contract_value)

    patterns = [
        (r"([A-Z0-9&.,()\-/ ]{3,100}?)\s+was\s+the\s+lowest\s+bidder\s*\(L1\)\s+at\s+₹?\s*([0-9][0-9,.]*)\s*(Cr|Crores?|L|Lakhs?|Lacs?)?", "L1"),
        (r"lowest\s+bidder\s*\(L1\)\s*[:\-]?\s*([A-Z0-9&.,()\-/ ]{3,100})", "L1"),
        (r"successful\s+(?:bidder|contractor)\s*[:\-]?\s*([A-Z0-9&.,()\-/ ]{3,100})", "AWARDEE"),
        (r"accepted\s+contractor\s*[:\-]?\s*([A-Z0-9&.,()\-/ ]{3,100})", "AWARDEE"),
    ]

    for pattern, rank in patterns:
        for m in re.finditer(pattern, text, flags=re.I):
            amount = None
            if m.lastindex and m.lastindex >= 2 and rank == "L1":
                amount = parse_money(m.group(2), m.group(3) if m.lastindex >= 3 else None)
            add_bidder(bidders, m.group(1), rank, amount)

    return bidders[:20]


def extract_result(text):
    lower = text.lower()
    bidders = extract_bidders(text)

    awarded = bool(re.search(
        r"\b(?:award(?:ed)?|aoc|award of contract|successful bidder|accepted contractor|accepted-aoc)\b",
        lower,
    ))
    if any(b.get("rank") == "AWARDEE" for b in bidders):
        awarded = True

    provisional = bool(re.search(
        r"l1\s+is\s+provisional|award\s+has\s+not\s+been\s+declared|financial bid opening",
        lower,
    ))
    if provisional:
        awarded = False

    accepted_amount = None
    for pattern in (
        r"(?:awarded|accepted|contract)\s+(?:amount|value)\s*[:\-|]?\s*₹?\s*([0-9][0-9,.]*)\s*(Cr|Crores?|L|Lakhs?|Lacs?)?",
        r"Contract\s+Value\s*\|?\s*₹?\s*([0-9][0-9,.]*)\s*(Cr|Crores?|L|Lakhs?|Lacs?)?",
        r"award\s+value\s*[:\-]?\s*₹?\s*([0-9][0-9,.]*)\s*(Cr|Crores?|L|Lakhs?|Lacs?)?",
    ):
        m = re.search(pattern, text, flags=re.I)
        if m:
            accepted_amount = parse_money(m.group(1), m.group(2) if m.lastindex >= 2 else None)
            if accepted_amount:
                break

    if not accepted_amount:
        awardee = next((b for b in bidders if b.get("rank") == "AWARDEE" and b.get("amount")), None)
        if awardee:
            accepted_amount = awardee.get("amount")

    participant_count = None
    for pattern in (r"([0-9]+)\s+Bids?\b", r"([0-9]+)\s+bidders?\s+participated"):
        m = re.search(pattern, text, flags=re.I)
        if m:
            participant_count = int(m.group(1))
            break

    return {
        "awarded": awarded,
        "provisional": provisional,
        "bidders": bidders,
        "accepted_amount": accepted_amount,
        "participant_count": participant_count,
    }


def find_key(obj, wanted):
    wanted = {x.lower() for x in wanted}
    if isinstance(obj, dict):
        for key, value in obj.items():
            if str(key).lower() in wanted and value:
                return value
        for value in obj.values():
            found = find_key(value, wanted)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_key(value, wanted)
            if found:
                return found
    return None


def fetch_verified_page(session, tender_ref, source, url):
    try:
        response = session.get(url, headers=HEADERS, timeout=7, allow_redirects=True)
    except Exception:
        return None
    if response.status_code != 200:
        return None
    text = clean_text(response.text)
    if norm(tender_ref) not in norm(text):
        return None
    parsed = extract_result(text)
    return {"source": source, "url": response.url, **parsed}


def tenderkart_exact_lookup(session, tender_ref):
    if not TENDERKART_API_KEY:
        return None, {"source": "TenderKart API", "configured": False}

    try:
        response = session.get(
            TENDERKART_LOOKUP,
            params={"tender_id": tender_ref},
            headers={"X-API-Key": TENDERKART_API_KEY, "Accept": "application/json", "User-Agent": HEADERS["User-Agent"]},
            timeout=7,
        )
    except Exception as exc:
        return None, {"source": "TenderKart API", "configured": True, "error": str(exc)[:150]}

    attempt = {"source": "TenderKart API", "configured": True, "http": response.status_code}
    if response.status_code != 200:
        return None, attempt

    try:
        payload = response.json()
    except Exception:
        return None, attempt

    public_url = find_key(payload, {"tenderkart_url", "public_url", "url"})
    if not public_url or "tenderkart.in/tender/" not in str(public_url):
        return None, attempt

    candidate = fetch_verified_page(session, tender_ref, "TenderKart", str(public_url))
    return candidate, attempt


def add_search_url(urls, href, domain):
    href = html.unescape(str(href or ""))
    if href.startswith("//"):
        href = "https:" + href
    if not href.startswith("http"):
        return
    if domain.lower() not in href.lower():
        return
    # Avoid search/cache/static links; we want actual result pages.
    if any(x in href.lower() for x in ("bing.com", "duckduckgo.com", "google.com", "/api-docs", "/pricing")):
        return
    if href not in urls:
        urls.append(href)


def bing_search_urls(session, tender_ref, domain):
    query = f'site:{domain} "{tender_ref}"'
    try:
        response = session.get(
            "https://www.bing.com/search",
            params={"q": query, "count": "8", "setlang": "en-IN"},
            headers={**HEADERS, "Referer": "https://www.bing.com/"},
            timeout=6,
        )
    except Exception:
        return []
    if response.status_code != 200:
        return []

    urls = []
    # Standard Bing result markup.
    for href in re.findall(r'<li[^>]*class=["\'][^"\']*b_algo[^"\']*["\'][\s\S]*?<a[^>]+href=["\']([^"\']+)', response.text, flags=re.I):
        add_search_url(urls, href, domain)
        if len(urls) >= 3:
            return urls

    # Generic fallback in case Bing changes the result wrapper.
    for href in re.findall(r'href=["\'](https?://[^"\']+)["\']', response.text, flags=re.I):
        add_search_url(urls, href, domain)
        if len(urls) >= 3:
            break
    return urls


def ddg_search_urls(session, tender_ref, domain):
    try:
        response = session.get(
            "https://html.duckduckgo.com/html/",
            params={"q": f'site:{domain} "{tender_ref}"'},
            headers=HEADERS,
            timeout=5,
        )
    except Exception:
        return []
    if response.status_code != 200:
        return []

    urls = []
    for href in re.findall(r'href=["\']([^"\']+)["\']', response.text, flags=re.I):
        href = html.unescape(href)
        if "uddg=" in href:
            m = re.search(r"[?&]uddg=([^&]+)", href)
            if m:
                href = unquote(m.group(1))
        add_search_url(urls, href, domain)
        if len(urls) >= 3:
            break
    return urls


def search_urls(session, tender_ref, domain):
    # Bing currently indexes KPPP award mirrors much better than DDG.
    urls = bing_search_urls(session, tender_ref, domain)
    if urls:
        return urls, "bing"
    urls = ddg_search_urls(session, tender_ref, domain)
    return urls, "duckduckgo"


def lookup(tender_ref):
    session = requests.Session()
    attempts = []
    best = None

    candidate, attempt = tenderkart_exact_lookup(session, tender_ref)
    attempts.append(attempt)
    if candidate:
        if candidate.get("awarded") and candidate.get("bidders"):
            return {"success": True, "tender_ref": tender_ref, "result": candidate, "attempts": attempts}
        if candidate.get("bidders") or candidate.get("provisional"):
            best = candidate

    for source, domain in SOURCES:
        try:
            candidates, engine = search_urls(session, tender_ref, domain)
        except Exception as exc:
            attempts.append({"source": source, "error": str(exc)[:150]})
            continue

        attempts.append({"source": source, "engine": engine, "candidates": len(candidates)})

        for url in candidates:
            candidate = fetch_verified_page(session, tender_ref, source, url)
            if not candidate:
                continue

            if candidate.get("awarded") and candidate.get("bidders"):
                return {"success": True, "tender_ref": tender_ref, "result": candidate, "attempts": attempts}

            if candidate.get("bidders") or candidate.get("provisional"):
                best = candidate

    if best:
        return {"success": True, "tender_ref": tender_ref, "result": best, "attempts": attempts}

    return {
        "success": False,
        "tender_ref": tender_ref,
        "message": "No verified contractor name was found in the indexed public award records for this tender.",
        "attempts": attempts,
    }


class handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=900, s-maxage=900")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        tender_ref = (query.get("tender", [""])[0] or "").strip()
        if not tender_ref:
            self.send_json(400, {"success": False, "message": "Tender number is required."})
            return
        if len(tender_ref) > 180:
            self.send_json(400, {"success": False, "message": "Tender number is too long."})
            return
        try:
            self.send_json(200, lookup(tender_ref))
        except Exception as exc:
            self.send_json(200, {"success": False, "message": "Award lookup is temporarily unavailable.", "error": str(exc)[:180]})
