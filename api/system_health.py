import json
import os
from datetime import datetime, timezone

import requests

KPPP_BASE = "https://kppp.karnataka.gov.in"
KPPP_WORKS = KPPP_BASE + "/supplier-registration-service/v1/api/portal-service/works/search-eproc-tenders"
TENDERKART = "https://tenderkart.in/api/v1/tenders"
RAW_HEALTH = "https://raw.githubusercontent.com/santoshpawar863006-ctrl/KPPP-NEEWWW/main/public/health.json"


def _age_hours(value):
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds() / 3600)
    except Exception:
        return None


def _database_status(session):
    out = {"ok": False, "status": "unknown", "age_hours": None, "count": 0, "category_counts": {}}
    urls = []
    for env_name in ("VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"):
        host = (os.getenv(env_name) or "").strip().strip("/")
        if host:
            if not host.startswith("http"):
                host = "https://" + host
            urls.append(host + "/health.json")
    urls.append(RAW_HEALTH)

    last_error = None
    for url in urls:
        try:
            r = session.get(url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 Chrome/124.0"}, timeout=5)
            if r.status_code != 200:
                last_error = f"health snapshot HTTP {r.status_code}"
                continue
            data = r.json()
            stamp = data.get("last_success_at") or data.get("generated_at")
            age = _age_hours(stamp)
            count = int(data.get("count") or 0)
            counts = data.get("category_counts") or {}
            out.update({
                "ok": count > 0 and age is not None and age <= 6,
                "status": "fresh" if age is not None and age <= 2 else ("stale" if age is not None and age <= 6 else "very_stale"),
                "generated_at": data.get("generated_at"),
                "last_success_at": data.get("last_success_at"),
                "age_hours": round(age, 2) if age is not None else None,
                "count": count,
                "category_counts": {
                    "WORKS": int(counts.get("WORKS") or 0),
                    "GOODS": int(counts.get("GOODS") or 0),
                    "SERVICES": int(counts.get("SERVICES") or 0),
                },
                "collector": data,
            })
            return out
        except Exception as exc:
            last_error = str(exc)[:160]
    if last_error:
        out["error"] = last_error
    return out


def _probe_kppp(session):
    try:
        r = session.post(
            KPPP_WORKS,
            params={"page": 0, "size": 1, "order-by-tender-publish": "true"},
            json={"category": "WORKS", "status": "PUBLISHED", "title": ""},
            headers={
                "Accept": "application/json, text/plain, */*",
                "Content-Type": "application/json",
                "Origin": KPPP_BASE,
                "Referer": KPPP_BASE + "/",
                "Post": "CONTRACTOR-EPROC-CONTRACTOR",
                "User-Agent": "Mozilla/5.0 Chrome/124.0",
            },
            timeout=8,
        )
        total = r.headers.get("X-Total-Count")
        return {"ok": r.status_code == 200, "http": r.status_code, "reported_works": int(total) if total and total.isdigit() else None}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:160]}


def _probe_tenderkart(session):
    try:
        r = session.get(
            TENDERKART,
            params={"keywords": "Karnataka", "state": "Karnataka", "limit": "1"},
            headers={"Accept": "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 Chrome/124.0"},
            timeout=8,
        )
        valid = False
        if r.status_code == 200:
            try:
                payload = r.json()
                valid = isinstance(payload, dict) and isinstance(payload.get("data"), list)
            except Exception:
                valid = False
        return {"ok": r.status_code == 200 and valid, "http": r.status_code}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:160]}


def get_system_health():
    session = requests.Session()
    database = _database_status(session)
    kppp = _probe_kppp(session)
    tenderkart = _probe_tenderkart(session)
    overall = bool(database.get("ok") and kppp.get("ok"))
    return {
        "success": True,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "overall": "healthy" if overall else "attention",
        "database": database,
        "kppp": kppp,
        "tenderkart": tenderkart,
        "bidassist": {"status": "search_based", "note": "Checked only when a tender search is requested."},
        "tendersplus": {"status": "search_based", "note": "Checked only when a tender search is requested."},
    }
