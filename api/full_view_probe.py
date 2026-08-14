import os
import requests

BASE = "https://kppp.karnataka.gov.in"
API = BASE + "/supplier-registration-service/v1/api"
TOKEN = os.getenv("KPPP_AUTH_TOKEN", "").strip()


def _headers():
    h = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": BASE,
        "Referer": BASE + "/shared/viewTenderDetails",
        "Post": "CONTRACTOR-EPROC-CONTRACTOR",
        "User-Agent": "Mozilla/5.0",
    }
    if TOKEN:
        h["Authorization"] = "Bearer " + TOKEN
    return h


def _is_detail(data):
    if not isinstance(data, dict):
        return False
    keys = {
        "noticeInvitingTenderDTO", "tenderSchedule", "tenderSubEstimateList",
        "generalCriterionList", "technicalCriterionList", "tenderFiles",
        "tenderCriterionDocumentList", "invitingAuthority", "openAuthority",
    }
    if keys.intersection(data.keys()):
        return True
    wrapped = data.get("data")
    return isinstance(wrapped, dict) and bool(keys.intersection(wrapped.keys()))


def _unwrap(data):
    if isinstance(data, dict) and isinstance(data.get("data"), dict) and _is_detail(data["data"]):
        return data["data"]
    return data


def get_full_view(category, tender_id, nit_id):
    cat = str(category or "").upper().strip()
    section = {"WORKS": "works", "GOODS": "goods", "SERVICES": "services"}.get(cat, "works")
    ids = []
    for value in (nit_id, tender_id):
        value = str(value or "").strip()
        if value and value not in ids:
            ids.append(value)

    # Candidate paths centered on the exact browser request name: full-view.
    paths = [
        f"/portal-service/{section}/full-view",
        "/portal-service/full-view",
        f"/portal-service/{section}/tender/full-view",
        f"/portal-service/{section}/tender-full-view",
        f"/portal-service/{section}-tender/full-view",
        f"/portal-service/tenders/full-view",
    ]
    param_names = ("nitId", "id", "tenderId")
    session = requests.Session()
    attempts = []

    for path in paths:
        url = API + path
        for identifier in ids:
            for param in param_names:
                try:
                    r = session.get(url, params={param: identifier}, headers=_headers(), timeout=8)
                    data = None
                    try:
                        data = r.json()
                    except Exception:
                        pass
                    attempts.append({"url": url, "method": "GET", "param": param, "id": identifier, "status": r.status_code})
                    if r.status_code == 200 and _is_detail(data):
                        return {"success": True, "detail": _unwrap(data), "endpoint_used": url, "method_used": "GET", "parameter_used": param, "attempts": attempts}
                except Exception as exc:
                    attempts.append({"url": url, "method": "GET", "param": param, "id": identifier, "error": str(exc)[:100]})

            for body in ({"nitId": identifier}, {"id": identifier}, {"tenderId": identifier}):
                try:
                    r = session.post(url, json=body, headers=_headers(), timeout=8)
                    data = None
                    try:
                        data = r.json()
                    except Exception:
                        pass
                    attempts.append({"url": url, "method": "POST", "body": list(body.keys())[0], "id": identifier, "status": r.status_code})
                    if r.status_code == 200 and _is_detail(data):
                        return {"success": True, "detail": _unwrap(data), "endpoint_used": url, "method_used": "POST", "parameter_used": list(body.keys())[0], "attempts": attempts}
                except Exception as exc:
                    attempts.append({"url": url, "method": "POST", "id": identifier, "error": str(exc)[:100]})

    return {"success": False, "message": "KPPP full-view endpoint not yet confirmed.", "attempts": attempts}
