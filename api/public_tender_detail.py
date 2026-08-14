import html
import os
import re
from urllib.parse import urlparse, unquote

import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

TENDERKART_API_KEY = os.getenv("TENDERKART_API_KEY", "").strip()
TENDERKART_LOOKUP = "https://tenderkart.in/api/v1/client/tenders/lookup"

SOURCE_HOSTS = {
    "tenderkart.in": "TenderKart",
    "www.tenderkart.in": "TenderKart",
    "bidassist.com": "BidAssist",
    "www.bidassist.com": "BidAssist",
    "tendersplus.com": "TendersPlus",
    "www.tendersplus.com": "TendersPlus",
}
MIRROR_HOSTS = {"s3.nl.geostorage.net"}


def clean_text(raw_html):
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", raw_html or "", flags=re.I | re.S)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def clean_lines(raw_html):
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", raw_html or "", flags=re.I | re.S)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.I | re.S)
    value = re.sub(
        r"</?(?:br|p|div|li|tr|td|th|h1|h2|h3|h4|section|article|header|footer)[^>]*>",
        "\n",
        value,
        flags=re.I,
    )
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    lines = []
    for line in value.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return lines


def norm(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def host_of(url):
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def is_official(host):
    return (
        host == "kppp.karnataka.gov.in"
        or host.endswith(".karnataka.gov.in")
        or host == "karnataka.gov.in"
        or host.endswith(".kar.nic.in")
        or host.endswith(".gov.in")
        or host == "gov.in"
    )


def source_name(host):
    if host in SOURCE_HOSTS:
        return SOURCE_HOSTS[host]
    if is_official(host):
        return "Government source"
    if host in MIRROR_HOSTS:
        return "Public tender document"
    return host


def allowed_host(host):
    return is_official(host) or host in MIRROR_HOSTS or host in SOURCE_HOSTS


def add_result(results, url, title="", snippet=""):
    url = html.unescape(str(url or "")).strip()
    if "uddg=" in url:
        m = re.search(r"[?&]uddg=([^&]+)", url)
        if m:
            url = unquote(m.group(1))
    if url.startswith("//"):
        url = "https:" + url
    if not url.startswith("http"):
        return
    host = host_of(url)
    if not allowed_host(host):
        return
    if any(x in url.lower() for x in ("bing.com", "google.com", "duckduckgo.com")):
        return
    if any(x["url"] == url for x in results):
        return
    results.append(
        {
            "url": url,
            "title": clean_text(title)[:180],
            "snippet": clean_text(snippet)[:800],
            "host": host,
            "source": source_name(host),
            "official": is_official(host),
        }
    )


def bing_rss_search(session, query):
    try:
        r = session.get(
            "https://www.bing.com/search",
            params={"q": query, "format": "rss", "count": "10", "setlang": "en-IN"},
            headers=HEADERS,
            timeout=7,
        )
    except Exception:
        return []
    if r.status_code != 200:
        return []
    results = []
    for item in re.findall(r"<item>([\s\S]*?)</item>", r.text, flags=re.I):
        lm = re.search(r"<link>([\s\S]*?)</link>", item, flags=re.I)
        tm = re.search(r"<title>([\s\S]*?)</title>", item, flags=re.I)
        dm = re.search(r"<description>([\s\S]*?)</description>", item, flags=re.I)
        if lm:
            add_result(
                results,
                lm.group(1).strip(),
                tm.group(1).strip() if tm else "",
                dm.group(1).strip() if dm else "",
            )
        if len(results) >= 10:
            break
    return results


def bing_search(session, query):
    try:
        r = session.get(
            "https://www.bing.com/search",
            params={"q": query, "count": "10", "setlang": "en-IN"},
            headers={**HEADERS, "Referer": "https://www.bing.com/"},
            timeout=7,
        )
    except Exception:
        return []
    if r.status_code != 200:
        return []
    results = []
    for block in re.findall(
        r'<li[^>]*class=["\'][^"\']*b_algo[^"\']*["\'][\s\S]*?</li>',
        r.text,
        flags=re.I,
    ):
        m = re.search(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>', block, flags=re.I)
        sm = re.search(r'<p>([\s\S]*?)</p>', block, flags=re.I)
        if m:
            add_result(results, m.group(1), m.group(2), sm.group(1) if sm else "")
        if len(results) >= 10:
            break
    if not results:
        for m in re.finditer(r'href=["\'](https?://[^"\']+)["\']', r.text, flags=re.I):
            add_result(results, m.group(1), "", "")
            if len(results) >= 10:
                break
    return results


def ddg_search(session, query):
    try:
        r = session.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers=HEADERS,
            timeout=7,
        )
    except Exception:
        return []
    if r.status_code != 200:
        return []
    results = []
    for block in re.findall(r'<div[^>]*class=["\'][^"\']*result[^"\']*["\'][\s\S]*?</div>', r.text, flags=re.I):
        m = re.search(
            r'<a[^>]+class=["\'][^"\']*result__a[^"\']*["\'][^>]+href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>',
            block,
            flags=re.I,
        )
        sm = re.search(r'class=["\'][^"\']*result__snippet[^"\']*["\'][^>]*>([\s\S]*?)</', block, flags=re.I)
        if m:
            add_result(results, m.group(1), m.group(2), sm.group(1) if sm else "")
        if len(results) >= 10:
            break
    if not results:
        for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>', r.text, flags=re.I):
            add_result(results, m.group(1), m.group(2), "")
            if len(results) >= 10:
                break
    return results


def search_public(session, query):
    combined = []
    for searcher in (bing_rss_search, bing_search, ddg_search):
        out = searcher(session, query)
        for item in out:
            if not any(x["url"] == item["url"] for x in combined):
                combined.append(item)
        if combined:
            break
    return combined


def parse_money_value(raw, unit=""):
    if raw is None:
        return None
    try:
        value = float(str(raw).replace(",", "").strip())
    except Exception:
        return None
    u = str(unit or "").lower()
    if u in {"crore", "crores", "cr"}:
        value *= 10000000
    elif u in {"lakh", "lakhs", "lac", "lacs", "l"}:
        value *= 100000
    return value if value > 0 else None


def money_after(text, labels):
    label_pattern = "|".join(labels)
    patterns = [
        rf"(?:{label_pattern})\s*(?:amount|value)?\s*[:\-|]?\s*(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(crore|crores|cr|lakh|lakhs|lac|lacs|l)?\b",
        rf"(?:{label_pattern}).{{0,80}}?(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(crore|crores|cr|lakh|lakhs|lac|lacs|l)?\b",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, flags=re.I)
        if m:
            value = parse_money_value(m.group(1), m.group(2) if m.lastindex >= 2 else "")
            if value:
                return value
    return None


def value_after_label(lines, labels):
    for i, line in enumerate(lines):
        low = line.lower().strip()
        for label in labels:
            label_low = label.lower()
            if low == label_low or low.startswith(label_low + " ") or low.startswith(label_low + ":"):
                same = re.sub(rf"^{re.escape(label)}\s*[:\-|]?\s*", "", line, flags=re.I).strip()
                if same and same != line:
                    return same
                if i + 1 < len(lines):
                    return lines[i + 1].strip()
    return None


def section(lines, start_labels, end_labels, limit=20):
    start = None
    for i, line in enumerate(lines):
        if any(label.lower() in line.lower() for label in start_labels):
            start = i + 1
            break
    if start is None:
        return []
    out = []
    for line in lines[start:]:
        if any(label.lower() in line.lower() for label in end_labels):
            break
        if line not in out:
            out.append(line)
        if len(out) >= limit:
            break
    return out


def useful_document_lines(lines):
    raw = section(lines, ["Documents Required"], ["Eligibility Criteria", "Fee & Financial", "Important Dates"], 60)
    out = []
    for line in raw:
        if re.match(r"^(required|optional)\b", line, flags=re.I):
            line = re.sub(r"^(required|optional)\s+", "", line, flags=re.I).strip()
            if 4 <= len(line) <= 300 and line not in out:
                out.append(line)
        if len(out) >= 12:
            break
    return out


def useful_eligibility_lines(lines):
    raw = section(lines, ["Eligibility Criteria"], ["Fee & Financial", "Important Dates", "BOQ Preview", "Documents"], 80)
    out = []
    ignore = {"show all criteria", "show all", "subscribe to view"}
    for line in raw:
        low = line.lower().strip()
        if low in ignore or len(line) < 12 or len(line) > 420:
            continue
        if line not in out:
            out.append(line)
        if len(out) >= 10:
            break
    return out


def useful_boq_lines(lines):
    raw = section(lines, ["BOQ Preview", "BOQ Items"], ["Documents", "Ready to Participate", "Disclaimer"], 80)
    out = []
    for line in raw:
        low = line.lower()
        if len(line) < 8 or len(line) > 300:
            continue
        if any(x in low for x in ("search boq", "refer documents", "user do not have access", "invalid")):
            continue
        if line not in out:
            out.append(line)
        if len(out) >= 8:
            break
    return out


def extract_signals(text, lines=None):
    lines = lines or []
    low = text.lower()
    signals = {}
    tags = []

    tender_value = money_after(text, [r"tender\s+value", r"estimated\s+tender\s+value", r"tender\s+amount"])
    emd = money_after(text, [r"emd(?:\s+fee)?", r"emd\s+amount"])
    fee = money_after(text, [r"tender\s+fee", r"document\s+cost"])
    if tender_value:
        signals["tender_value"] = tender_value
    if emd:
        signals["emd"] = emd
    if fee:
        signals["tender_fee"] = fee

    if re.search(r"\btender\s+type\s*[:\-]?\s*reserved\b", low):
        signals["tender_class"] = "Reserved"
    elif re.search(r"\btender\s+type\s*[:\-]?\s*open\b", low):
        signals["tender_class"] = "Regular / Open"
    elif re.search(r"\btender\s+type\s*[:\-]?\s*restricted\b", low):
        signals["tender_class"] = "Qualified / Restricted"

    if re.search(r"reservation\s+(?:sc|scheduled caste)|reserved.*scheduled caste|belonging sc category", low, flags=re.I):
        signals["reservation"] = "SC"
        tags.append("SC reservation condition found")
    elif re.search(r"reservation\s+(?:st|scheduled tribe)|reserved.*scheduled tribe|belonging st category", low, flags=re.I):
        signals["reservation"] = "ST"
        tags.append("ST reservation condition found")
    elif "reserved category" in low:
        signals["reservation"] = "Reserved category"
        tags.append("Reserved-category condition found")

    class_match = re.search(
        r"(?:kpwd|pwd)\s+(?:civil\s+)?(?:registration\s+certificate\s+for\s+)?class\s*[-:]?\s*([ivx0-9]+(?:\s*(?:or|and|&)\s*above)?)",
        text,
        flags=re.I,
    )
    if class_match:
        signals["kpwd_class"] = class_match.group(1).strip()
        tags.append("KPWD/PWD class requirement found")
    elif "kpwd registration" in low or "pwd registration" in low:
        tags.append("KPWD/PWD registration requirement found")

    validity = re.search(r"(?:bid\s+(?:offer\s+)?validity).{0,100}?([0-9]{1,4})\s*days?", text, flags=re.I)
    if validity:
        signals["bid_validity_days"] = int(validity.group(1))
        tags.append("Bid-validity period found")

    for key, labels in (
        ("published_date", ["Published", "Published Date", "Opening Date"]),
        ("closing_date", ["Closing Date", "Bid Submission End Date", "Closing Soon"]),
        ("bid_opening_date", ["Bid Opening", "Bid Opening Date"]),
        ("location", ["Location"]),
        ("product_category", ["Product Category"]),
        ("work_description", ["Work Description", "Description", "Summary"]),
        ("contact_person", ["Contact Person"]),
        ("mobile_number", ["Mobile Number", "Office Number"]),
        ("tender_id", ["Tender ID", "Tender Id"]),
    ):
        value = value_after_label(lines, labels)
        if value and len(value) <= 600:
            signals[key] = value

    docs = useful_document_lines(lines)
    eligibility = useful_eligibility_lines(lines)
    boq = useful_boq_lines(lines)
    if docs:
        signals["documents_required"] = docs
        tags.append(f"{len(docs)} document requirement(s) extracted")
    if eligibility:
        signals["eligibility"] = eligibility
        tags.append(f"{len(eligibility)} eligibility condition(s) extracted")
    if boq:
        signals["boq_preview"] = boq
        tags.append(f"{len(boq)} BOQ preview line(s) extracted")

    signals["tags"] = tags[:10]
    return signals


def tender_match(tender_ref, text, title="", department="", location=""):
    if tender_ref and norm(tender_ref) in norm(text):
        return True, "exact tender number"
    title_words = [w for w in re.findall(r"[a-z0-9]+", str(title or "").lower()) if len(w) >= 5][:12]
    if len(title_words) < 4:
        return False, ""
    text_low = text.lower()
    hit = sum(1 for w in title_words if w in text_low)
    context_terms = [w for w in re.findall(r"[a-z0-9]+", f"{department} {location}".lower()) if len(w) >= 5]
    context_hit = any(w in text_low for w in context_terms[:10]) if context_terms else True
    source_context = any(x in text_low for x in ("kppp", "karnataka", "tender"))
    if hit >= max(4, int(len(title_words) * 0.65)) and context_hit and source_context:
        return True, "title + authority/location"
    return False, ""


def fetch_verified(session, tender_ref, item, title="", department="", location=""):
    try:
        r = session.get(item["url"], headers=HEADERS, timeout=8, allow_redirects=True)
    except Exception:
        r = None

    if r is not None and r.status_code == 200:
        host = host_of(r.url)
        if allowed_host(host):
            text = clean_text(r.text)
            matched, match_method = tender_match(tender_ref, text, title, department, location)
            if matched:
                return {
                    "source": source_name(host),
                    "title": item.get("title") or source_name(host),
                    "url": r.url,
                    "host": host,
                    "official": is_official(host),
                    "match_method": match_method,
                    "signals": extract_signals(text, clean_lines(r.text)),
                }

    snippet_text = f"{item.get('title','')} {item.get('snippet','')}"
    matched, match_method = tender_match(tender_ref, snippet_text, title, department, location)
    if matched and item.get("snippet"):
        return {
            "source": item.get("source") or source_name(item.get("host", "")),
            "title": item.get("title") or item.get("source") or "Public tender source",
            "url": item.get("url"),
            "host": item.get("host"),
            "official": item.get("official", False),
            "match_method": match_method + " (search snippet)",
            "signals": extract_signals(snippet_text, []),
        }
    return None


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


def tenderkart_api_lookup(session, tender_ref, title="", department="", location=""):
    attempt = {"source": "TenderKart API", "configured": bool(TENDERKART_API_KEY)}
    if not TENDERKART_API_KEY:
        return None, attempt
    try:
        r = session.get(
            TENDERKART_LOOKUP,
            params={"tender_id": tender_ref},
            headers={
                "X-API-Key": TENDERKART_API_KEY,
                "Accept": "application/json",
                "User-Agent": HEADERS["User-Agent"],
            },
            timeout=8,
        )
    except Exception as exc:
        attempt["error"] = str(exc)[:120]
        return None, attempt
    attempt["http"] = r.status_code
    if r.status_code != 200:
        return None, attempt
    try:
        payload = r.json()
    except Exception:
        return None, attempt
    public_url = find_key(payload, {"tenderkart_url", "public_url", "url"})
    if not public_url or "tenderkart.in/tender/" not in str(public_url):
        return None, attempt
    item = {
        "url": str(public_url),
        "title": str(find_key(payload, {"title", "tender_title"}) or "TenderKart"),
        "snippet": "",
        "host": "tenderkart.in",
        "source": "TenderKart",
        "official": False,
    }
    verified = fetch_verified(session, tender_ref, item, title, department, location)
    return verified, attempt


def compact_phrase(value, max_words=10):
    words = re.findall(r"[A-Za-z0-9]+", str(value or ""))
    return " ".join(words[:max_words])


def human_ref(value):
    return re.sub(r"[/_\-]+", " ", str(value or "")).strip()


def lookup_public_details(tender_ref, title="", department="", location=""):
    tender_ref = str(tender_ref or "").strip()
    if not tender_ref:
        return {"success": False, "message": "Tender number is required."}

    session = requests.Session()
    short_title = compact_phrase(title, 10)
    short_dept = compact_phrase(department, 5)
    ref_words = human_ref(tender_ref)

    candidates = []
    source_attempts = []
    direct, api_attempt = tenderkart_api_lookup(session, tender_ref, title, department, location)
    source_attempts.append(api_attempt)
    if direct:
        candidates.append({
            "url": direct["url"],
            "title": direct.get("title", "TenderKart"),
            "snippet": "",
            "host": direct.get("host", "tenderkart.in"),
            "source": "TenderKart",
            "official": False,
            "_verified": direct,
        })

    exact_specs = [
        ("TenderKart", "tenderkart.in", f'"{tender_ref}" TenderKart', "exact tender number"),
        ("BidAssist", "bidassist.com", f'"{tender_ref}" BidAssist', "exact tender number"),
        ("TendersPlus", "tendersplus.com", f'"{tender_ref}" TendersPlus', "exact tender number"),
    ]
    human_specs = [
        ("TenderKart", "tenderkart.in", f'"{ref_words}" TenderKart Karnataka', "tender number keywords"),
        ("BidAssist", "bidassist.com", f'"{ref_words}" BidAssist Karnataka', "tender number keywords"),
        ("TendersPlus", "tendersplus.com", f'"{ref_words}" TendersPlus Karnataka', "tender number keywords"),
    ]
    title_specs = []
    if short_title:
        title_specs = [
            ("TenderKart", "tenderkart.in", f'"{short_title}" "{short_dept}" TenderKart Karnataka', "title/department keywords"),
            ("BidAssist", "bidassist.com", f'"{short_title}" "{short_dept}" BidAssist Karnataka', "title/department keywords"),
            ("TendersPlus", "tendersplus.com", f'"{short_title}" "{short_dept}" TendersPlus Karnataka', "title/department keywords"),
        ]
    fallback_specs = [
        ("Government", "karnataka.gov.in", f'"{tender_ref}" Karnataka government tender', "exact tender number"),
        ("Public document", "s3.nl.geostorage.net", f'"{tender_ref}" KPPP tender document', "exact tender number"),
    ]

    def run_specs(specs):
        if not specs:
            return
        with ThreadPoolExecutor(max_workers=min(6, len(specs))) as pool:
            futures = {
                pool.submit(search_public, session, query): (expected, domain, qtype)
                for expected, domain, query, qtype in specs
            }
            for future in as_completed(futures):
                expected, domain, qtype = futures[future]
                try:
                    found = future.result()
                except Exception:
                    found = []
                domain_found = [x for x in found if domain in x.get("host", "")]
                source_attempts.append({"source": expected, "query_type": qtype, "found": len(domain_found)})
                for item in domain_found:
                    if not any(x["url"] == item["url"] for x in candidates):
                        candidates.append(item)

    run_specs(exact_specs)
    if len(candidates) < 2:
        run_specs(human_specs)
    if len(candidates) < 2 and title_specs:
        run_specs(title_specs)
    if not candidates:
        run_specs(fallback_specs)

    priority = {"TenderKart": 0, "BidAssist": 1, "TendersPlus": 2, "Government source": 3, "Public tender document": 4}
    candidates.sort(key=lambda x: (priority.get(x.get("source"), 9), not x.get("official", False)))

    sources = []
    seen_sources = set()
    for item in candidates:
        if item.get("_verified"):
            verified = item["_verified"]
            key = (verified.get("source"), verified.get("url"))
            if key not in seen_sources:
                seen_sources.add(key)
                sources.append(verified)

    to_check = [x for x in candidates if not x.get("_verified")][:9]
    if to_check:
        with ThreadPoolExecutor(max_workers=min(6, len(to_check))) as pool:
            futures = [
                pool.submit(fetch_verified, session, tender_ref, item, title, department, location)
                for item in to_check
            ]
            for future in as_completed(futures):
                try:
                    verified = future.result()
                except Exception:
                    verified = None
                if not verified:
                    continue
                key = (verified.get("source"), verified.get("url"))
                if key in seen_sources:
                    continue
                seen_sources.add(key)
                sources.append(verified)
                if len(sources) >= 6:
                    break

    sources.sort(key=lambda x: priority.get(x.get("source"), 9))
    return {
        "success": True,
        "tender_ref": tender_ref,
        "sources": sources,
        "source_count": len(sources),
        "attempts": source_attempts,
        "note": (
            "KPPP remains the primary source. TenderKart, BidAssist and TendersPlus are searched "
            "for publicly visible enrichment only; locked/subscriber-only content is not accessed."
        ),
    }
