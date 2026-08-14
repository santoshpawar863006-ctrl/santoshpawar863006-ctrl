import re
import requests

from api import public_tender_detail_v3 as v3
from api import public_tender_detail_v2 as search_layer

SOURCE_CONFIG = {
    "bidassist": ("BidAssist", "bidassist.com"),
    "tendersplus": ("TendersPlus", "tendersplus.com"),
}


def _short(value, words):
    return " ".join(re.findall(r"[A-Za-z0-9]+", str(value or ""))[:words])


def _human_ref(value):
    return re.sub(r"[/_\-]+", " ", str(value or "")).strip()


def _indexed_source(session, source_key, tender_ref, title="", department="", location=""):
    source_name, domain = SOURCE_CONFIG[source_key]
    attempts = []
    queries = [
        (f'"{tender_ref}" {source_name}', "exact tender number"),
        (f'"{_human_ref(tender_ref)}" {source_name} Karnataka', "tender number keywords"),
    ]
    short_title = _short(title, 12)
    short_dept = _short(department, 5)
    if short_title:
        queries.append((f'"{short_title}" "{short_dept}" {source_name} Karnataka', "title + department keywords"))

    seen = set()
    candidates = []
    for query, query_type in queries:
        try:
            found = search_layer.combined_search(session, query)
        except Exception:
            found = []
        domain_found = [x for x in found if domain in str(x.get("host") or "")]
        attempts.append({"source": source_name, "query_type": query_type, "found": len(domain_found)})
        for item in domain_found:
            url = item.get("url")
            if url and url not in seen:
                seen.add(url)
                candidates.append(item)
        if candidates:
            # Exact/keyword results are usually enough; verify before accepting.
            break

    for item in candidates[:8]:
        try:
            verified = v3.base.fetch_verified(session, tender_ref, item, title, department, location)
        except Exception:
            verified = None
        if verified and str(verified.get("source") or "").lower() == source_name.lower():
            return verified, attempts
    return None, attempts


def _tenderkart(session, tender_ref, title="", department="", location=""):
    return v3.get_tenderkart_detail(session, tender_ref, title, department, location)


def lookup_public_details(tender_ref, title="", department="", location="", source="all"):
    tender_ref = str(tender_ref or "").strip()
    if not tender_ref:
        return {"success": False, "message": "Tender number is required."}

    source_key = str(source or "all").strip().lower()
    session = requests.Session()
    sources = []
    attempts = []

    if source_key == "tenderkart":
        result, a = _tenderkart(session, tender_ref, title, department, location)
        attempts.extend(a)
        if result:
            sources.append(result)

    elif source_key in SOURCE_CONFIG:
        result, a = _indexed_source(session, source_key, tender_ref, title, department, location)
        attempts.extend(a)
        if result:
            sources.append(result)

    elif source_key == "preferred":
        # View Details preference requested by the portal owner:
        # use verified TendersPlus information first, then reliable TenderKart data.
        result, a = _indexed_source(session, "tendersplus", tender_ref, title, department, location)
        attempts.extend(a)
        if result:
            sources.append(result)
        else:
            result, a = _tenderkart(session, tender_ref, title, department, location)
            attempts.extend(a)
            if result:
                result = dict(result)
                result["match_method"] = str(result.get("match_method") or "verified match") + " · fallback when TendersPlus is unavailable"
                sources.append(result)

    else:
        return v3.lookup_public_details(tender_ref, title, department, location)

    return {
        "success": True,
        "tender_ref": tender_ref,
        "requested_source": source_key,
        "sources": sources,
        "source_count": len(sources),
        "attempts": attempts,
        "note": (
            "Only publicly visible and verified matching information is returned. "
            "TendersPlus is preferred for automatic View Details enrichment; TenderKart is the fallback. "
            "KPPP remains the base tender record."
        ),
    }
