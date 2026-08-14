import re

import requests

from api import public_tender_detail as base
from api import public_tender_detail_v2 as web_fallback

TK_BASE = "https://tenderkart.in"
HEADERS = {
    "User-Agent": base.HEADERS["User-Agent"],
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-IN,en;q=0.9",
    "Referer": TK_BASE + "/tenders/filters",
}

SOURCE_DOMAINS = {
    "tenderkart": ("TenderKart", "tenderkart.in"),
    "bidassist": ("BidAssist", "bidassist.com"),
    "tendersplus": ("TendersPlus", "tendersplus.com"),
}


def norm(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def as_number(value):
    try:
        n = float(str(value).replace(",", "").strip())
        return n if n > 0 else None
    except Exception:
        return None


def list_strings(value, key=None, limit=20):
    out = []
    if not isinstance(value, list):
        return out
    for item in value:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict) and key:
            text = str(item.get(key) or "").strip()
        else:
            text = ""
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def tenderkart_matches_ref(detail, tender_ref):
    ref_norm = norm(tender_ref)
    if not ref_norm or not isinstance(detail, dict):
        return False
    for key in ("tender_link", "portal_link", "tender_id", "tender_reference_number"):
        value = detail.get(key)
        if value and ref_norm in norm(value):
            return True
    ext = detail.get("extended_data") or {}
    raw = ext.get("raw_html") if isinstance(ext, dict) else {}
    if isinstance(raw, dict):
        for value in raw.values():
            if value and ref_norm in norm(value):
                return True
    kd = ext.get("karnataka_data") if isinstance(ext, dict) else {}
    if isinstance(kd, dict):
        for key in ("tender_number", "tender_reference_number", "reference_number"):
            value = kd.get(key)
            if value and ref_norm in norm(value):
                return True
    return False


def criteria_reservation(text):
    low = str(text or "").lower()
    if re.search(r"\bsc\b|scheduled caste", low):
        return "SC"
    if re.search(r"\bst\b|scheduled tribe", low):
        return "ST"
    for cat in ("2a", "2b", "3a", "3b", "cat1", "category 1"):
        if cat in low:
            return cat.upper().replace("CATEGORY ", "CAT")
    if "reserved category" in low:
        return "Reserved category"
    return None


def extract_kpwd_class(text):
    m = re.search(
        r"(?:kpwd|pwd).{0,70}?class\s*[-:]?\s*([ivx0-9]+(?:\s*(?:and|or|&)\s*above)?)",
        str(text or ""),
        flags=re.I,
    )
    return m.group(1).strip() if m else None


def boq_lines(text, limit=10):
    out = []
    for raw in str(text or "").splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not line or line.lower() in {"in figures", "in figures(rs)", "in figures (rs)", "total"}:
            continue
        if len(line) < 8:
            continue
        if line not in out:
            out.append(line[:500])
        if len(out) >= limit:
            break
    return out


def tenderkart_signals(detail):
    ext = detail.get("extended_data") or {}
    kd = ext.get("karnataka_data") if isinstance(ext, dict) else {}
    kd = kd if isinstance(kd, dict) else {}
    work = ext.get("work_item_details") if isinstance(ext, dict) else {}
    work = work if isinstance(work, dict) else {}

    eligibility = list_strings(kd.get("eligibility_criteria"), limit=20)
    technical = list_strings(kd.get("technical_criteria"), key="description", limit=20)
    required_docs = list_strings(kd.get("required_documents"), key="document_name", limit=20)

    tender_docs = []
    docs = ext.get("documents") if isinstance(ext, dict) else {}
    nit_docs = docs.get("nit") if isinstance(docs, dict) else []
    if isinstance(nit_docs, list):
        for item in nit_docs:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            dtype = str(item.get("document_type") or "").strip()
            if not name:
                continue
            label = f"{name} — {dtype}" if dtype else name
            if label not in tender_docs:
                tender_docs.append(label)
            if len(tender_docs) >= 15:
                break

    combined_criteria = " ".join(eligibility + technical + required_docs)
    signals = {
        "tender_value": as_number(detail.get("tender_value")),
        "emd": as_number(detail.get("emd_fee")),
        "tender_fee": as_number(detail.get("tender_fee")),
        "tender_class": detail.get("tender_type"),
        "form_of_contract": detail.get("form_of_contract"),
        "tender_category": detail.get("tender_category"),
        "product_category": detail.get("product_category"),
        "location": detail.get("location") or detail.get("formatted_location"),
        "work_description": detail.get("work_description") or detail.get("description"),
        "published_date": detail.get("publish_date"),
        "closing_date": detail.get("bid_submission_end") or detail.get("effective_bid_submission_end"),
        "bid_opening_date": detail.get("bid_opening_date"),
        "download_end_date": detail.get("document_download_end"),
        "bid_validity_days": work.get("bid_validity_days") or kd.get("bid_validity_days"),
        "nit_id": kd.get("nit_id"),
        "bid_value_type": kd.get("bid_value_type"),
        "denomination_type": kd.get("denomination_type"),
        "tax_type": kd.get("tax_type"),
        "contact_person": kd.get("contact_person"),
        "mobile_number": kd.get("mobile_number"),
        "reservation": criteria_reservation(combined_criteria),
        "kpwd_class": extract_kpwd_class(combined_criteria),
        "eligibility": eligibility,
        "technical_criteria": technical,
        "documents_required": required_docs,
        "tender_documents": tender_docs,
        "boq_preview": boq_lines(kd.get("boq_text") or detail.get("boq"), 10),
        "tags": [],
    }
    signals = {k: v for k, v in signals.items() if v not in (None, "", [], {})}
    tags = signals.setdefault("tags", [])
    if eligibility:
        tags.append(f"{len(eligibility)} eligibility condition(s)")
    if technical:
        tags.append(f"{len(technical)} technical criterion/criteria")
    if required_docs:
        tags.append(f"{len(required_docs)} mandatory document requirement(s)")
    if tender_docs:
        tags.append(f"{len(tender_docs)} tender document file(s)")
    return signals


def get_tenderkart_detail(session, tender_ref, title="", department="", location=""):
    attempts = []
    searches = [
        {"keywords": tender_ref, "state": "Karnataka", "limit": "8"},
        {"keywords": tender_ref, "limit": "8"},
    ]
    if title:
        words = " ".join(re.findall(r"[A-Za-z0-9]+", title)[:14])
        if words:
            searches.append({"keywords": words, "state": "Karnataka", "limit": "8"})

    seen_ids = set()
    for params in searches:
        try:
            r = session.get(TK_BASE + "/api/v1/tenders", params=params, headers=HEADERS, timeout=9)
        except Exception as exc:
            attempts.append({"source": "TenderKart", "method": "public API", "error": str(exc)[:100]})
            continue
        attempts.append({"source": "TenderKart", "method": "public API", "http": r.status_code, "query": "keywords"})
        if r.status_code != 200:
            continue
        try:
            payload = r.json()
        except Exception:
            continue
        rows = payload.get("data") if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            continue

        ranked = []
        title_norm = norm(title)
        dept_norm = norm(department)
        for row in rows:
            if not isinstance(row, dict):
                continue
            uuid = str(row.get("id") or "").strip()
            if not uuid or uuid in seen_ids:
                continue
            seen_ids.add(uuid)
            score = 0
            if str(row.get("portal_name") or "").lower() == "karnataka":
                score += 20
            if title_norm and norm(row.get("title")) == title_norm:
                score += 60
            elif title_norm and title_norm[:40] and title_norm[:40] in norm(row.get("title")):
                score += 30
            if dept_norm and dept_norm[:20] and dept_norm[:20] in norm(
                f"{row.get('organisation','')} {row.get('department','')}"
            ):
                score += 15
            ranked.append((score, uuid, row))
        ranked.sort(reverse=True, key=lambda x: x[0])

        for _, uuid, row in ranked[:5]:
            try:
                dr = session.get(TK_BASE + "/api/v1/tenders/" + uuid, headers=HEADERS, timeout=9)
            except Exception:
                continue
            if dr.status_code != 200:
                continue
            try:
                detail = dr.json()
            except Exception:
                continue
            if not isinstance(detail, dict) or not tenderkart_matches_ref(detail, tender_ref):
                continue
            return {
                "source": "TenderKart",
                "title": detail.get("title") or row.get("title") or "TenderKart",
                "url": TK_BASE + "/tender/" + uuid,
                "host": "tenderkart.in",
                "official": False,
                "match_method": "direct TenderKart public API + exact KPPP reference",
                "signals": tenderkart_signals(detail),
            }, attempts
    return None, attempts


def get_web_source_detail(session, source_key, tender_ref, title="", department="", location=""):
    source_name, domain = SOURCE_DOMAINS[source_key]
    attempts = []
    ref_words = base.human_ref(tender_ref)
    short_title = base.compact_phrase(title, 11)
    short_dept = base.compact_phrase(department, 5)
    short_location = base.compact_phrase(location, 4)
    queries = [
        (f'"{tender_ref}" {source_name}', "exact tender number"),
        (f'"{ref_words}" {source_name} Karnataka', "tender number keywords"),
    ]
    if short_title:
        context = " ".join(x for x in (short_dept, short_location) if x).strip()
        queries.append((f'"{short_title}" "{context}" {source_name} Karnataka', "title/authority/location keywords"))

    seen = set()
    for query, query_type in queries:
        try:
            found = base.search_public(session, query)
        except Exception as exc:
            attempts.append({"source": source_name, "query_type": query_type, "error": str(exc)[:100]})
            continue
        domain_found = [x for x in found if domain in str(x.get("host") or "").lower()]
        attempts.append({"source": source_name, "query_type": query_type, "found": len(domain_found)})
        for item in domain_found[:8]:
            url = str(item.get("url") or "")
            if not url or url in seen:
                continue
            seen.add(url)
            try:
                verified = base.fetch_verified(session, tender_ref, item, title, department, location)
            except Exception:
                verified = None
            if verified and str(verified.get("source") or "").lower() == source_name.lower():
                return verified, attempts
    return None, attempts


def lookup_public_details(tender_ref, title="", department="", location="", source="all"):
    tender_ref = str(tender_ref or "").strip()
    if not tender_ref:
        return {"success": False, "message": "Tender number is required."}

    source_key = str(source or "all").strip().lower()
    if source_key not in {"all", "tenderkart", "bidassist", "tendersplus"}:
        source_key = "all"

    session = requests.Session()
    sources = []
    attempts = []

    if source_key in {"all", "tenderkart"}:
        tenderkart, tk_attempts = get_tenderkart_detail(session, tender_ref, title, department, location)
        attempts.extend(tk_attempts)
        if tenderkart:
            sources.append(tenderkart)

    for key in ("bidassist", "tendersplus"):
        if source_key not in {"all", key}:
            continue
        item, item_attempts = get_web_source_detail(session, key, tender_ref, title, department, location)
        attempts.extend(item_attempts)
        if item:
            sources.append(item)

    priority = {"TendersPlus": 0, "TenderKart": 1, "BidAssist": 2}
    sources.sort(key=lambda x: priority.get(x.get("source"), 9))
    return {
        "success": True,
        "tender_ref": tender_ref,
        "requested_source": source_key,
        "sources": sources,
        "source_count": len(sources),
        "attempts": attempts,
        "note": (
            "TenderKart is queried through its public website API. BidAssist and TendersPlus are searched through "
            "their publicly indexed pages. Only verified public matches are returned; locked content is not accessed."
        ),
    }
