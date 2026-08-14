from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json


class handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload, cache="no-store"):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        query = parse_qs(parsed.query)

        if path == "/api/system_health":
            try:
                from api.system_health import get_system_health
                self.send_json(200, get_system_health(), "public, max-age=300, s-maxage=300")
            except Exception as exc:
                self.send_json(200, {
                    "success": False,
                    "overall": "attention",
                    "message": "System health check is temporarily unavailable.",
                    "error": str(exc)[:240],
                })
            return

        if path == "/api/public_tender_detail":
            tender_ref = (query.get("tender", [""])[0] or "").strip()
            title = (query.get("title", [""])[0] or "").strip()
            department = (query.get("department", [""])[0] or "").strip()
            location = (query.get("location", [""])[0] or "").strip()
            source = (query.get("source", ["all"])[0] or "all").strip()
            if not tender_ref:
                self.send_json(400, {"success": False, "message": "Tender number is required."})
                return
            try:
                from api.public_tender_detail_v3 import lookup_public_details
                self.send_json(
                    200,
                    lookup_public_details(tender_ref, title, department, location, source),
                    "public, max-age=3600, s-maxage=3600",
                )
            except Exception as exc:
                self.send_json(200, {
                    "success": False,
                    "message": "Public web enrichment is temporarily unavailable.",
                    "error": str(exc)[:240],
                })
            return

        if path == "/api/tender_detail":
            category = (query.get("category", [""])[0] or "").strip()
            tender_id = (query.get("id", [""])[0] or "").strip()
            nit_id = (query.get("nitId", [""])[0] or "").strip()
            if not tender_id and not nit_id:
                self.send_json(400, {"success": False, "message": "Provide id or nitId."})
                return
            try:
                from api.full_view_probe import get_full_view
                result = get_full_view(category, tender_id, nit_id)
                if not result.get("success"):
                    from api.tender_detail import find_full_detail
                    legacy = find_full_detail(category, tender_id, nit_id)
                    if legacy.get("success"):
                        result = legacy
                self.send_json(200, result)
            except Exception as exc:
                self.send_json(200, {
                    "success": False,
                    "message": "KPPP full tender details are temporarily unavailable.",
                    "error": str(exc)[:240],
                })
            return

        if path == "/api/history":
            try:
                from api.history import fetch_history
                try:
                    page = max(0, int((query.get("page", ["0"])[0] or "0")))
                except Exception:
                    page = 0
                try:
                    size = min(100, max(20, int((query.get("size", ["100"])[0] or "100"))))
                except Exception:
                    size = 100
                payload = fetch_history(page, size)
                self.send_json(200, payload, "public, max-age=900, s-maxage=900")
            except Exception as exc:
                self.send_json(200, {
                    "success": False,
                    "message": "Closed tender history is temporarily unavailable.",
                    "error": str(exc)[:240],
                })
            return

        if path == "/api/award_result":
            tender_ref = (query.get("tender", [""])[0] or "").strip()
            if not tender_ref:
                self.send_json(400, {"success": False, "message": "Tender number is required."})
                return
            try:
                from api.award_result import lookup
                self.send_json(200, lookup(tender_ref), "public, max-age=21600, s-maxage=21600")
            except Exception as exc:
                self.send_json(200, {
                    "success": False,
                    "message": "Award lookup is temporarily unavailable.",
                    "error": str(exc)[:240],
                })
            return

        self.send_json(200, {"status":"API active"})
