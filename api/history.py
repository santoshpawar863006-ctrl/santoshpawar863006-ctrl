from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime
import json
import os
import requests

BASE = "https://kppp.karnataka.gov.in"
API_BASE = BASE + "/supplier-registration-service/v1/api"
TOKEN = os.getenv("KPPP_AUTH_TOKEN", "").strip()

ENDPOINTS = {
    "WORKS": API_BASE + "/portal-service/works/search-eproc-tenders",
    "GOODS": API_BASE + "/portal-service/search-eproc-tenders",
    "SERVICES": API_BASE + "/portal-service/services/search-eproc-tenders",
}

HISTORY_STATUSES = ("AWARDED", "CLOSED")


def headers():
    h = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": BASE,
        "Referer": BASE + "/",
        "Post": "CONTRACTOR-EPROC-CONTRACTOR",
        "User-Agent": "Mozilla/5.0",
    }
    if TOKEN:
        h["Authorization"] = "Bearer " + TOKEN
    return h


def pick(d, *keys, default=""):
    if not isinstance(d, dict):
        return default
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return default


def find_list(data):
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("content", "items", "results", "tenders", "records", "data"):
        value = data.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            nested = find_list(value)
            if nested:
                return nested
    return []


def num(v):
    try:
        n = float(str(v).replace("₹", "").replace(",", "").strip())
        return n if n > 0 else None
    except Exception:
        return None


def parse_date(v):
    if not v:
        return None
    s = str(v).strip()
    for fmt in ("%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d-%m-%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except Exception:
            pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


def normalize(raw, category, requested_status):
    tid = str(pick(raw, "id", "tenderId", "tenderID", "tenderPk", "tenderNumber", default="")).strip()
    ref = str(pick(raw, "tenderNumber", "tenderNo", "tenderReferenceNumber", "referenceNumber", "nitNumber", default=tid)).strip()
    close = str(pick(raw, "tenderClosureDate", "closingDate", "bidSubmissionEndDate", "submissionEndDate", "lastDate", default="")).strip()
    status = str(pick(raw, "status", default=requested_status)).strip()
    status_text = str(pick(raw, "statusText", default=status)).strip()
    upper = (status + " " + status_text + " " + requested_status).upper()
    return {
        "id": tid,
        "ref_no": ref,
        "title": str(pick(raw, "title", "tenderTitle", "description", "workDescription", default="Tender")).strip(),
        "category": category,
        "department": str(pick(raw, "deptName", "departmentName", "department", "organisationName", default="Karnataka Government")).strip(),
        "location": str(pick(raw, "locationName", "location", "placeOfWork", "districtName", default="Karnataka")).strip(),
        "district": str(pick(raw, "districtName", "district", default="")).strip(),
        "amount": num(pick(raw, "ecv", "estimatedContractValue", "estimatedAmount", "tenderValue", "provisionalAmount", default="")),
        "emd": num(pick(raw, "emdAmount", "emd", "emdValue", default="")),
        "fee": num(pick(raw, "tenderFee", "tenderFeeAmount", "fee", default="")),
        "published_date": str(pick(raw, "publishedDate", "publishDate", default="")).strip(),
        "closing_date": close,
        "status": status,
        "status_text": status_text,
        "history_status": requested_status,
        "award_hint": any(word in upper for word in ("AWARD", "AOC", "CONTRACT")),
    }


def request_status(session, category, status, page, size):
    response = session.post(
        ENDPOINTS[category],
        params={"page": page, "size": size, "order-by-tender-publish": "true"},
        json={"category": category, "status": status, "title": ""},
        headers=headers(),
        timeout=10,
    )
    total = response.headers.get("X-Total-Count")
    if response.status_code != 200:
        return [], {
            "category": category,
            "status": status,
            "http": response.status_code,
            "body": response.text[:180],
        }
    items = find_list(response.json())
    return items, {
        "category": category,
        "status": status,
        "http": 200,
        "returned": len(items),
        "total": total,
    }


def fetch_history(page, size):
    session = requests.Session()
    rows = []
    attempts = []

    for category in ("WORKS", "GOODS", "SERVICES"):
        for status in HISTORY_STATUSES:
            try:
                items, attempt = request_status(session, category, status, page, size)
                attempts.append(attempt)
            except Exception as exc:
                attempts.append({
                    "category": category,
                    "status": status,
                    "error": str(exc)[:180],
                })
                continue

            for raw in items:
                rows.append(normalize(raw, category, status))

    seen = set()
    unique = []
    for row in rows:
        key = row["id"] or row["ref_no"]
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(row)

    unique.sort(
        key=lambda r: parse_date(r.get("closing_date")) or parse_date(r.get("published_date")) or datetime.min,
        reverse=True,
    )

    return {
        "success": True,
        "page": page,
        "page_size": size,
        "count": len(unique),
        "tenders": unique,
        "attempts": attempts,
        "message": None if unique else "KPPP returned no records for the AWARDED/CLOSED status queries on this page.",
    }


class handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=300, s-maxage=300")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        try:
            page = max(0, int((query.get("page", ["0"])[0] or "0")))
        except Exception:
            page = 0
        try:
            size = min(100, max(20, int((query.get("size", ["50"])[0] or "50"))))
        except Exception:
            size = 50
        try:
            self.send_json(200, fetch_history(page, size))
        except Exception as exc:
            self.send_json(200, {"success": False, "message": "Closed tender history is temporarily unavailable.", "error": str(exc)[:180]})
