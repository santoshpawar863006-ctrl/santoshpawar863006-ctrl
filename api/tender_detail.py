from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import os
import requests


BASE = "https://kppp.karnataka.gov.in"

API_BASE = (
    BASE
    + "/supplier-registration-service/v1/api/portal-service"
)

TOKEN = os.getenv(
    "KPPP_AUTH_TOKEN",
    ""
).strip()


def headers():

    h = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": BASE,
        "Referer": BASE + "/",
        "Post": "CONTRACTOR-EPROC-CONTRACTOR",
        "User-Agent": (
            "Mozilla/5.0 "
            "(Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 "
            "Chrome/124 Safari/537.36"
        ),
    }

    if TOKEN:

        h["Authorization"] = (
            "Bearer " + TOKEN
        )

    return h


def looks_like_full_detail(data):

    if not isinstance(data, dict):
        return False

    # Direct full-detail response
    useful_keys = {
        "noticeInvitingTenderDTO",
        "tenderSchedule",
        "tenderSubEstimateList",
        "generalCriterionList",
        "technicalCriterionList",
        "tenderCriterionDocumentList",
    }

    if any(
        key in data
        for key in useful_keys
    ):
        return True

    # Sometimes APIs wrap response inside "data"
    nested = data.get("data")

    if isinstance(nested, dict):

        if any(
            key in nested
            for key in useful_keys
        ):
            return True

    return False


def unwrap_detail(data):

    if (
        isinstance(data, dict)
        and isinstance(
            data.get("data"),
            dict
        )
        and looks_like_full_detail(
            data["data"]
        )
    ):

        return data["data"]

    return data


def safe_json(response):

    try:
        return response.json()

    except Exception:
        return None


def request_candidate(
    session,
    method,
    url,
    params=None,
    body=None
):

    try:

        if method == "GET":

            response = session.get(
                url,
                params=params,
                headers=headers(),
                timeout=10,
            )

        else:

            response = session.post(
                url,
                params=params,
                json=body,
                headers=headers(),
                timeout=10,
            )

        data = safe_json(
            response
        )

        return {
            "ok": (
                response.status_code == 200
                and
                looks_like_full_detail(
                    data
                )
            ),

            "status":
                response.status_code,

            "data":
                data,

            "preview":
                response.text[:300],
        }

    except Exception as exc:

        return {
            "ok": False,
            "status": None,
            "data": None,
            "preview": str(exc),
        }


def get_category_names(category):

    category = (
        category
        or ""
    ).upper().strip()

    if category == "WORKS":

        return [
            "works"
        ]

    if category == "GOODS":

        return [
            "goods"
        ]

    if category == "SERVICES":

        return [
            "services"
        ]

    return [
        "works",
        "goods",
        "services",
    ]


def find_full_detail(
    category,
    tender_id,
    nit_id
):

    session = requests.Session()

    identifiers = []

    # NIT ID is preferred
    if nit_id:
        identifiers.append(
            str(nit_id)
        )

    if (
        tender_id
        and
        str(tender_id)
        not in identifiers
    ):
        identifiers.append(
            str(tender_id)
        )

    category_names = (
        get_category_names(
            category
        )
    )

    attempts = []


    # =====================================================
    # KPPP full-view route detector
    #
    # We intentionally try only a small number of likely
    # public route forms. This does NOT affect collector.
    # =====================================================

    for name in category_names:

        endpoint = (
            f"{API_BASE}/"
            f"{name}-tender-full-view"
        )

        for identifier in identifiers:

            # ---------------------------------------------
            # Attempt 1
            # GET ?nitId=
            # ---------------------------------------------

            result = request_candidate(

                session,

                "GET",

                endpoint,

                params={
                    "nitId":
                        identifier
                },
            )

            attempts.append({

                "route":
                    endpoint,

                "method":
                    "GET",

                "parameter":
                    "nitId",

                "identifier":
                    identifier,

                "http_status":
                    result["status"],
            })

            if result["ok"]:

                return {

                    "success":
                        True,

                    "category":
                        category,

                    "identifier":
                        identifier,

                    "endpoint_used":
                        endpoint,

                    "method_used":
                        "GET",

                    "parameter_used":
                        "nitId",

                    "detail":
                        unwrap_detail(
                            result["data"]
                        ),

                    "attempts":
                        attempts,
                }


            # ---------------------------------------------
            # Attempt 2
            # GET ?id=
            # ---------------------------------------------

            result = request_candidate(

                session,

                "GET",

                endpoint,

                params={
                    "id":
                        identifier
                },
            )

            attempts.append({

                "route":
                    endpoint,

                "method":
                    "GET",

                "parameter":
                    "id",

                "identifier":
                    identifier,

                "http_status":
                    result["status"],
            })

            if result["ok"]:

                return {

                    "success":
                        True,

                    "category":
                        category,

                    "identifier":
                        identifier,

                    "endpoint_used":
                        endpoint,

                    "method_used":
                        "GET",

                    "parameter_used":
                        "id",

                    "detail":
                        unwrap_detail(
                            result["data"]
                        ),

                    "attempts":
                        attempts,
                }


            # ---------------------------------------------
            # Attempt 3
            # GET /{identifier}
            # ---------------------------------------------

            path_url = (
                endpoint
                + "/"
                + identifier
            )

            result = request_candidate(

                session,

                "GET",

                path_url,
            )

            attempts.append({

                "route":
                    path_url,

                "method":
                    "GET",

                "parameter":
                    "PATH",

                "identifier":
                    identifier,

                "http_status":
                    result["status"],
            })

            if result["ok"]:

                return {

                    "success":
                        True,

                    "category":
                        category,

                    "identifier":
                        identifier,

                    "endpoint_used":
                        path_url,

                    "method_used":
                        "GET",

                    "parameter_used":
                        "PATH",

                    "detail":
                        unwrap_detail(
                            result["data"]
                        ),

                    "attempts":
                        attempts,
                }


            # ---------------------------------------------
            # Attempt 4
            # POST {"nitId": ...}
            # ---------------------------------------------

            result = request_candidate(

                session,

                "POST",

                endpoint,

                body={
                    "nitId":
                        identifier
                },
            )

            attempts.append({

                "route":
                    endpoint,

                "method":
                    "POST",

                "parameter":
                    "nitId",

                "identifier":
                    identifier,

                "http_status":
                    result["status"],
            })

            if result["ok"]:

                return {

                    "success":
                        True,

                    "category":
                        category,

                    "identifier":
                        identifier,

                    "endpoint_used":
                        endpoint,

                    "method_used":
                        "POST",

                    "parameter_used":
                        "nitId",

                    "detail":
                        unwrap_detail(
                            result["data"]
                        ),

                    "attempts":
                        attempts,
                }


    # =====================================================
    # ALTERNATIVE CATEGORY PATH STYLE
    # =====================================================

    for name in category_names:

        for identifier in identifiers:

            url = (
                f"{API_BASE}/"
                f"{name}/"
                f"tender-full-view/"
                f"{identifier}"
            )

            result = request_candidate(

                session,

                "GET",

                url,
            )

            attempts.append({

                "route":
                    url,

                "method":
                    "GET",

                "parameter":
                    "PATH",

                "identifier":
                    identifier,

                "http_status":
                    result["status"],
            })

            if result["ok"]:

                return {

                    "success":
                        True,

                    "category":
                        category,

                    "identifier":
                        identifier,

                    "endpoint_used":
                        url,

                    "method_used":
                        "GET",

                    "parameter_used":
                        "PATH",

                    "detail":
                        unwrap_detail(
                            result["data"]
                        ),

                    "attempts":
                        attempts,
                }


    return {

        "success":
            False,

        "message":
            (
                "KPPP full-detail route was not "
                "confirmed for this tender."
            ),

        "category":
            category,

        "tender_id":
            tender_id,

        "nit_id":
            nit_id,

        "attempts":
            attempts,
    }


class handler(
    BaseHTTPRequestHandler
):

    def send_json(
        self,
        status,
        payload
    ):

        body = json.dumps(
            payload,
            ensure_ascii=False
        ).encode(
            "utf-8"
        )

        self.send_response(
            status
        )

        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8"
        )

        self.send_header(
            "Cache-Control",
            "no-store"
        )

        self.send_header(
            "Access-Control-Allow-Origin",
            "*"
        )

        self.send_header(
            "Content-Length",
            str(
                len(body)
            )
        )

        self.end_headers()

        self.wfile.write(
            body
        )


    def do_GET(self):

        parsed = urlparse(
            self.path
        )

        query = parse_qs(
            parsed.query
        )

        category = (
            query.get(
                "category",
                [""]
            )[0]
        )

        tender_id = (
            query.get(
                "id",
                [""]
            )[0]
        )

        nit_id = (
            query.get(
                "nitId",
                [""]
            )[0]
        )


        if (
            not tender_id
            and
            not nit_id
        ):

            self.send_json(
                400,
                {
                    "success":
                        False,

                    "message":
                        (
                            "Provide id or nitId."
                        ),
                }
            )

            return


        result = find_full_detail(

            category,

            tender_id,

            nit_id
        )


        if result["success"]:

            self.send_json(
                200,
                result
            )

        else:

            # 200 intentionally:
            # frontend can gracefully use
            # existing listing details.
            self.send_json(
                200,
                result
            )
