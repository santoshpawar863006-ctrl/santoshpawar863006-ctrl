import json, time, requests
API = "https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service"
H = {"Accept": "application/json, text/plain, */*", "Content-Type": "application/json", "Origin": "https://kppp.karnataka.gov.in", "Referer": "https://kppp.karnataka.gov.in/",
     "Post": "CONTRACTOR-EPROC-CONTRACTOR", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36"}
for cat, nit in [("GOODS", "54429"), ("SERVICES", "83445"), ("WORKS", "323266")]:
    for variant in ("download-detailed", "download"):
        r = requests.get(f"{API}/tender-eval/{nit}/commercial-evaluation/tender-category/{cat}/commercial-comparison/{variant}", headers={**H, "Accept": "*/*"}, timeout=60)
        print(cat, variant, r.status_code, r.headers.get("content-type"), len(r.content), r.content[:2])
r = requests.get(f"{API}/333347/get-works-tender-files", headers=H, timeout=60); print("files", r.text[:400])
for cat, path in [("WORKS", "works/search-eproc-tenders"), ("GOODS", "search-eproc-tenders")]:
    t = time.time()
    r = requests.post(f"{API}/{path}?page=0&size=100&order-by-tender-publish=true", json={"category": cat, "status": "AWARDED", "title": ""}, headers=H, timeout=120)
    print("list", cat, f"{time.time()-t:.1f}s", r.status_code, r.headers.get("X-Total-Count"), len(r.json()))
