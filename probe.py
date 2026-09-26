import json, time, statistics
from concurrent.futures import ThreadPoolExecutor
import requests
API = "https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service"
H = {"Accept": "application/json, text/plain, */*", "Origin": "https://kppp.karnataka.gov.in", "Referer": "https://kppp.karnataka.gov.in/",
     "Post": "CONTRACTOR-EPROC-CONTRACTOR", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36"}
VIEW = {"WORKS": "works-tender-full-view", "GOODS": "goods-tender-full-view", "SERVICES": "service-tender-full-view"}
FILES = {"WORKS": "get-works-tender-files", "GOODS": "get-goods-tender-files", "SERVICES": "get-services-tender-files"}
def short(v, n=600):
    return json.dumps(v, ensure_ascii=False)[:n]
for cat, nit in [("WORKS", "323266"), ("GOODS", "54429"), ("SERVICES", "83445")]:
    t = time.time()
    d = requests.get(f"{API}/{nit}/{VIEW[cat]}", headers=H, timeout=60).json()
    print(f"== {cat} {nit} awarded full view {time.time()-t:.1f}s keys:", sorted(d.keys()))
    for k in ("tenderAwardDatesDTO", "evalStagesCompletedInfoDTO", "tenderWorkLocationList", "tenderAddress", "noticeInvitingTenderDTO", "tenderSchedule"):
        print(" ", k, "=", short(d.get(k), 1500))
    for k, v in d.items():
        if k not in ("tenderSubEstimateList", "tenderGroups") and v not in (None, [], {}, "") and not isinstance(v, (dict, list)):
            print("  scalar", k, "=", short(v, 200))
    for k, v in d.items():
        if isinstance(v, list) and v and k not in ("tenderSubEstimateList", "tenderGroups"):
            print("  list", k, len(v), short(v[0], 400))
lite = json.loads(requests.get("https://raw.githubusercontent.com/santoshpawar863006-ctrl/santoshpawar863006-ctrl/main/public/tenders-lite.json").text)["tenders"]
sample = [t for t in lite if t["cat"] == "WORKS"][:12] + [t for t in lite if t["cat"] == "GOODS"][:6] + [t for t in lite if t["cat"] == "SERVICES"][:6]
def timed(kind, t):
    s = time.time()
    try:
        r = requests.get(f"{API}/{t['nit']}/{(VIEW if kind=='view' else FILES)[t['cat']]}", headers=H, timeout=90)
        return kind, t["cat"], time.time() - s, r.status_code, len(r.content)
    except Exception as e:
        return kind, t["cat"], time.time() - s, str(e)[:60], 0
for kind in ("view", "files"):
    s = time.time()
    with ThreadPoolExecutor(8) as pool:
        out = list(pool.map(lambda t: timed(kind, t), sample))
    print(f"== {kind}: wall {time.time()-s:.1f}s for {len(out)}")
    for o in out: print("  ", o[0], o[1], f"{o[2]:.1f}s", o[3], o[4])
    print("   median", statistics.median(o[2] for o in out))
