from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
import html
import json
import re
import requests


SEARCH_URLS = [
    ("BidAssist", "bidassist.com"),
    ("TenderDetail", "tenderdetail.com"),
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
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


def normalise_ref(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def parse_money(number_text, unit_text=None):
    if number_text is None:
        return None
    try:
        value = float(str(number_text).replace(",", "").strip())
    except Exception:
        return None

    unit = str(unit_text or "").strip().lower()
    if unit in {"lakh", "lakhs", "lac", "lacs"}:
        value *= 100000
    elif unit in {"crore", "crores", "cr"}:
        value *= 10000000

    return value if value > 0 else None


def first_money(text, patterns):
    if not text:
        return None
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.I)
        if match:
            value = parse_money(
                match.group(1),
                match.group(2) if match.lastindex and match.lastindex >= 2 else None,
            )
            if value:
                return value
    return None


def extract_amount(text):
    return first_money(text, [
        r"Tender\s+(?:Amount|Value)\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(Crores?|Cr|Lakhs?|Lacs?)?\b",
        r"Estimated\s+(?:Tender\s+)?(?:Cost|Value|Amount)\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(Crores?|Cr|Lakhs?|Lacs?)?\b",
    ])


def extract_emd(text):
    return first_money(text, [
        r"\bEMD\b\s*(?:Amount)?\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(Crores?|Cr|Lakhs?|Lacs?)?\b",
        r"Earnest\s+Money\s+Deposit\s*(?:Amount)?\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(Crores?|Cr|Lakhs?|Lacs?)?\b",
    ])


def extract_fee(text):
    return first_money(text, [
        r"Tender\s+Fee\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(Crores?|Cr|Lakhs?|Lacs?)?\b",
        r"Document\s+(?:Cost|Fees?)\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(Crores?|Cr|Lakhs?|Lacs?)?\b",
        r"Application\s+Fee\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(Crores?|Cr|Lakhs?|Lacs?)?\b",
    ])


def ddg_result_urls(session, tender_ref, domain):
    query = f'site:{domain} "{tender_ref}"'
    response = session.get(
        "https://html.duckduckgo.com/html/",
        params={"q": query},
        headers=HEADERS,
        timeout=12,
    )
    if response.status_code != 200:
        return []

    urls = []
    for href in re.findall(r'href=["\']([^"\']+)["\']', response.text, flags=re.I):
        href = html.unescape(href)
        if "uddg=" in href:
            match = re.search(r"[?&]uddg=([^&]+)", href)
            if match:
                href = unquote(match.group(1))
        if href.startswith("//"):
            href = "https:" + href
        if href.startswith("http") and domain in href.lower() and href not in urls:
            urls.append(href)
        if len(urls) >= 4:
            break
    return urls


def check_candidate(session, tender_ref, source, url):
    try:
        response = session.get(
            url,
            headers=HEADERS,
            timeout=12,
            allow_redirects=True,
        )
    except Exception:
        return None

    if response.status_code != 200:
        return None

    page_text = clean_text(response.text)
    wanted_ref = normalise_ref(tender_ref)

    # Never attach secondary data unless the exact tender number is visible
    # on the source page after punctuation/spacing normalization.
    if not wanted_ref or wanted_ref not in normalise_ref(page_text):
        return None

    amount = extract_amount(page_text)
    emd = extract_emd(page_text)
    fee = extract_fee(page_text)

    if not amount and not emd and not fee:
        return None

    lower_text = page_text.lower()
    estimated = "estimated" in lower_text or "estimated cost" in lower_text

    return {
        "source": source,
        "url": response.url,
        "amount": amount,
        "emd": emd,
        "tender_fee": fee,
        "amount_estimated": bool(estimated and amount),
    }


def lookup_secondary(tender_ref):
    session = requests.Session()
    attempts = []
    fields = {
        "amount": None,
        "emd": None,
        "tender_fee": None,
    }

    def save_field(name, value, source, url, estimated=False):
        if fields[name] is None and value:
            fields[name] = {
                "value": value,
                "source": source,
                "url": url,
                "estimated": bool(estimated) if name == "amount" else False,
            }

    for source, domain in SEARCH_URLS:
        try:
            candidates = ddg_result_urls(session, tender_ref, domain)
        except Exception as exc:
            attempts.append({"source": source, "error": str(exc)[:160]})
            continue

        attempts.append({"source": source, "candidates": len(candidates)})

        for url in candidates:
            result = check_candidate(session, tender_ref, source, url)
            if not result:
                continue

            save_field(
                "amount",
                result.get("amount"),
                source,
                result.get("url"),
                result.get("amount_estimated", False),
            )
            save_field("emd", result.get("emd"), source, result.get("url"))
            save_field("tender_fee", result.get("tender_fee"), source, result.get("url"))

            if all(fields.values()):
                break

        if all(fields.values()):
            break

    success = any(fields.values())
    sources = sorted({
        item["source"]
        for item in fields.values()
        if item and item.get("source")
    })

    response = {
        "success": success,
        "tender_ref": tender_ref,
        "fields": fields,
        "amount": fields["amount"]["value"] if fields["amount"] else None,
        "emd": fields["emd"]["value"] if fields["emd"] else None,
        "tender_fee": fields["tender_fee"]["value"] if fields["tender_fee"] else None,
        "source": sources[0] if len(sources) == 1 else ("Multiple secondary sources" if sources else None),
        "sources": sources,
        "attempts": attempts,
    }

    if not success:
        response["message"] = "No verified secondary amount, EMD or tender fee was found for this tender number."

    return response


class handler(BaseHTTPRequestHandler):

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=21600, s-maxage=21600")
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
            self.send_json(200, lookup_secondary(tender_ref))
        except Exception as exc:
            self.send_json(200, {
                "success": False,
                "tender_ref": tender_ref,
                "message": "Secondary lookup is temporarily unavailable.",
                "error": str(exc)[:180],
            })
