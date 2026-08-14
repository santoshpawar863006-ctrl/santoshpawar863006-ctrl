import html
import re

import requests

from api import public_tender_detail as base

_ORIGINAL_SEARCH = base.search_public


def brave_search(session, query):
    try:
        r = session.get(
            "https://search.brave.com/search",
            params={"q": query, "source": "web"},
            headers={
                "User-Agent": base.HEADERS["User-Agent"],
                "Accept-Language": "en-IN,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            timeout=8,
        )
    except Exception:
        return []
    if r.status_code != 200:
        return []

    results = []
    text = r.text or ""

    # Brave currently exposes result destinations as normal absolute hrefs.
    # Keep only our approved tender/government domains through base.add_result().
    for m in re.finditer(r'href=["\'](https?://[^"\']+)["\']', text, flags=re.I):
        url = html.unescape(m.group(1))
        start = max(0, m.start() - 500)
        end = min(len(text), m.end() + 700)
        context = base.clean_text(text[start:end])
        base.add_result(results, url, context[:180], context[:800])
        if len(results) >= 15:
            break

    # Fallback for absolute URLs occurring outside href attributes.
    if not results:
        for raw in re.findall(r'https?://[^\s"\'<>]+', text, flags=re.I):
            base.add_result(results, html.unescape(raw), "", "")
            if len(results) >= 15:
                break
    return results


def combined_search(session, query):
    brave = brave_search(session, query)
    if brave:
        return brave
    return _ORIGINAL_SEARCH(session, query)


# base.lookup_public_details resolves search_public from its own module globals.
base.search_public = combined_search
lookup_public_details = base.lookup_public_details
