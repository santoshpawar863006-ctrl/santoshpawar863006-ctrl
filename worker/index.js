'use strict';

// Hourly collector commits fresh tenders.json / health.json here; deployed assets are the fallback.
const RAW_BASES = [
  'https://raw.githubusercontent.com/santoshpawar863006-ctrl/santoshpawar863006-ctrl/main/public'
];
// Background collectors keep copies of tender details (data branch) and award details (main).
const REPO_RAW = 'https://raw.githubusercontent.com/santoshpawar863006-ctrl/santoshpawar863006-ctrl';
const KPPP_BASE = 'https://kppp.karnataka.gov.in';
const KPPP_WORKS = KPPP_BASE + '/supplier-registration-service/v1/api/portal-service/works/search-eproc-tenders';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function json(payload, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function proxyRaw(filename, ctx, ttl = 60, env = null) {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-data.local/${filename}`, { method: 'GET' });
  let response = await cache.match(cacheKey);
  if (response) return response;

  const headersFor = (source) => new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
    'Access-Control-Allow-Origin': '*',
    'X-KPPP-Data-Source': source
  });

  // Stream the large tenders.json — do NOT JSON.parse the whole ~9MB body (CPU/memory limit).
  const tryUpstream = async (sourceUrl) => {
    const upstream = await fetch(sourceUrl, {
      headers: { Accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtl: ttl }
    });
    if (!upstream.ok) return null;
    const ctype = String(upstream.headers.get('content-type') || '');
    if (ctype.includes('text/html')) return null;
    return new Response(upstream.body, { status: 200, headers: headersFor(sourceUrl) });
  };

  for (const base of RAW_BASES) {
    try {
      response = await tryUpstream(`${base}/${filename}?ts=${Date.now()}`);
      if (response) break;
    } catch {}
  }

  if (!response && env?.ASSETS) {
    try {
      const assetResp = await env.ASSETS.fetch(new Request(`https://assets.local/${filename}`));
      if (assetResp.ok) {
        response = new Response(assetResp.body, {
          status: 200,
          headers: headersFor('assets')
        });
      }
    } catch {}
  }

  if (!response) return json({ success: false, message: `${filename} is temporarily unavailable.` }, 502);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

const KPPP_API = KPPP_BASE + '/supplier-registration-service/v1/api/portal-service';
// KPPP's own tender page loads these per-category endpoints without a login.
const SECTIONS = {
  WORKS: { view: 'works-tender-full-view', info: 'get-works-tender-general-info', files: 'get-works-tender-files', file: 'works-tender-file' },
  GOODS: { view: 'goods-tender-full-view', info: 'get-goods-tender-general-info', files: 'get-goods-tender-files', file: 'goods-tender-file' },
  SERVICES: { view: 'service-tender-full-view', info: 'get-services-tender-general-info', files: 'get-services-tender-files', file: 'services-tender-file' }
};
const KPPP_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Origin: KPPP_BASE,
  Referer: KPPP_BASE + '/',
  Post: 'CONTRACTOR-EPROC-CONTRACTOR',
  'User-Agent': USER_AGENT
};

// KPPP is sometimes slow or briefly fails, so each call has a time limit and is retried.
async function kpppJson(path, { timeoutMs = 20000, tries = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${KPPP_API}/${path}`, { headers: KPPP_HEADERS, signal: controller.signal, cf: { cacheTtl: 1800, cacheEverything: true } });
      if (!response.ok) throw new Error(`KPPP returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = controller.signal.aborted ? new Error(`KPPP took longer than ${timeoutMs / 1000}s`) : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const clean = (v) => {
  const text = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
};
const amount = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const list = (v) => (Array.isArray(v) ? v : []);

// Reshape KPPP's full view into only what the tender page shows.
function shapeTender(category, full, files, nitId) {
  const nit = full.noticeInvitingTenderDTO || {};
  const sched = full.tenderSchedule || {};
  const addr = full.tenderAddress || {};
  const eligibility = [...list(full.generalCriterionList), ...list(full.tenderEligibilityCriterionList)]
    .filter((c) => !c.criterionType || c.criterionType === 'ELIGIBILITY')
    .map((c) => clean(c.description)).filter(Boolean);
  const technical = [...list(full.technicalCriterionList), ...list(full.tenderTechnicalCriterionList)].map((c) => ({
    category: clean(c.criterionCategoryText),
    text: clean(c.criterionTypeOthersValue && c.criterionCategoryText === 'Others' ? c.criterionTypeOthersValue : c.description),
    weight: amount(c.weight),
    documents: list(c.tenderTechnicalCriterionDocumentList).map((d) => clean(d.documentName)).filter(Boolean)
  })).filter((c) => c.text);
  const documents = list(full.tenderCriterionDocumentList).map((d) => ({
    name: clean(d.documentName), cover: clean(d.documentTypeText), optional: Boolean(d.optional)
  })).filter((d) => d.name);

  let groups = [];
  if (category === 'WORKS') {
    groups = list(full.tenderSubEstimateList).map((g) => ({
      name: clean(g.subEstimateName), note: clean(g.workCategoryName), total: amount(g.estimateTotal),
      items: list(g.itemList).filter((i) => !i.hideYn).map((i) => ({
        code: clean(i.itemCode), section: clean(i.categoryName), name: clean(i.description),
        qty: amount(i.quantity), unit: clean(i.uomName), rate: amount(i.finalRate ?? i.baseRate), amount: amount(i.netAmount)
      }))
    }));
  } else {
    groups = list(full.tenderGroups).map((g) => ({
      name: clean(g.groupName === 'Default' ? null : g.groupName), total: null,
      items: list(g.itemList).map((i) => ({
        code: clean(i.itemCode), name: clean(i.itemName), spec: clean(i.specifications),
        qty: amount(i.quantity), unit: clean(i.uomName || i.biddingUnit),
        rate: amount(i.price ?? i.estimateUnitRate), amount: amount(i.netAmt ?? i.estimateItemPrice)
      }))
    }));
  }

  return {
    success: true,
    nit: String(nitId),
    ref: clean(sched.tenderNumber),
    description: clean(sched.description),
    fileNumber: clean(sched.fileNumber),
    dates: {
      published: clean(nit.publishedDate),
      queries: clean(nit.tenderQueryClose),
      preBid: nit.preBidMeetingYn ? clean(nit.preBidMeetingDate) : null,
      submission: clean(nit.tenderReceiptClose),
      opening: clean(nit.technicalBidOpen)
    },
    money: {
      emd: amount(nit.emd), emdCash: amount(nit.emdCash), emdGuarantee: amount(nit.emdBankGuarantee),
      fee: amount(nit.tenderFee), provisional: amount(sched.provisionalAmount)
    },
    terms: {
      evaluation: clean(nit.evaluationTypeText),
      bidType: clean(nit.bidValueTypeText),
      tax: nit.taxType ? clean(String(nit.taxType).replace(/_/g, ' ').toLowerCase()) : null,
      validityDays: amount(nit.bidValidityPeriod),
      call: amount(nit.noOfCalls),
      retender: Boolean(nit.retenderedYn),
      techWeight: nit.hideWeightage ? null : amount(nit.techWeightage)
    },
    contact: {
      person: clean(nit.contactPerson),
      mobile: clean(nit.mobileNumber),
      address: [addr.blockNumber, addr.street, addr.area, addr.city, addr.state, addr.pin].map(clean).filter(Boolean).join(', ') || null
    },
    eligibility,
    technical,
    documents,
    groups,
    files: list(files).map((f) => ({
      name: clean(f.fileName), type: clean(f.documentType),
      url: `/api/tender-file/${category}/${nitId}/${encodeURIComponent(f.uuid)}?name=${encodeURIComponent(f.fileName || 'document')}`
    })).filter((f) => f.name)
  };
}

// The copy collected in the background by collect_details.py, if there is one.
async function storedDetail(category, nitId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${REPO_RAW}/data/details/${category}/${nitId}.json`, { signal: controller.signal, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!response.ok) return null;
    const stored = await response.json();
    return stored && stored.full ? stored : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tenderDetail(category, nitId, ctx) {
  const section = SECTIONS[category];
  if (!section || !/^\d+$/.test(nitId)) return json({ success: false, message: 'Unknown tender.' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-detail.local/v3/${category}/${nitId}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let shaped;
  const stored = await storedDetail(category, nitId);
  if (stored) {
    shaped = { ...shapeTender(category, stored.full, [], nitId), checkedAt: stored.fetched || null, changes: list(stored.changes), past: stored.past || null };
    delete shaped.files;
    const response = json(shaped, 200, 'public, max-age=600, s-maxage=600');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  try {
    shaped = shapeTender(category, await kpppJson(`${nitId}/${section.view}`), [], nitId);
  } catch (fullError) {
    // Fall back to the small "general info" call: dates, money, terms and contact, without lists.
    try {
      const info = await kpppJson(`${nitId}/${section.info}`, { timeoutMs: 12000 });
      shaped = { ...shapeTender(category, { noticeInvitingTenderDTO: info.invitingTenderDTO, tenderSchedule: info.tenderScheduleDTO }, [], nitId), partial: true };
    } catch {
      return json({ success: false, message: `Could not load details from KPPP (${String(fullError.message || fullError).slice(0, 80)}).` }, 502);
    }
  }
  delete shaped.files;
  const response = json(shaped, 200, `public, max-age=${shaped.partial ? 120 : 1800}, s-maxage=${shaped.partial ? 120 : 1800}`);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// The documents list can take KPPP 30s+, so it is fetched separately from the details.
async function tenderFiles(category, nitId, ctx) {
  const section = SECTIONS[category];
  if (!section || !/^\d+$/.test(nitId)) return json({ success: false, message: 'Unknown tender.' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-files.local/v2/${category}/${nitId}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const stored = await storedDetail(category, nitId);
  if (stored && Array.isArray(stored.files)) {
    const response = json({ success: true, files: shapeTender(category, {}, stored.files, nitId).files }, 200, 'public, max-age=600, s-maxage=600');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  try {
    const files = await kpppJson(`${nitId}/${section.files}`, { timeoutMs: 45000 });
    const response = json({ success: true, files: shapeTender(category, {}, files, nitId).files }, 200, 'public, max-age=21600, s-maxage=21600');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json({ success: false, message: `KPPP did not send the documents list (${String(error.message || error).slice(0, 80)}).` }, 502);
  }
}

async function tenderFile(category, nitId, uuid, name, forceDownload = false) {
  const section = SECTIONS[category];
  if (!section || !/^\d+$/.test(nitId) || !/^[0-9a-f-]{36}$/i.test(uuid)) return json({ success: false, message: 'Unknown file.' }, 400);
  const upstream = await fetch(`${KPPP_API}/${nitId}/${section.file}/${uuid}/download-file`, { headers: { ...KPPP_HEADERS, Accept: '*/*' } });
  if (!upstream.ok) return json({ success: false, message: `KPPP returned HTTP ${upstream.status} for this file.` }, 502);
  const safeName = String(name || 'tender-document').replace(/[^\w.\- ()&]+/g, '_').slice(0, 150);
  // KPPP sends every file as octet-stream; label PDFs so the browser can open them directly.
  const isPdf = /\.pdf$/i.test(safeName);
  const inline = isPdf && !forceDownload;
  return new Response(upstream.body, {
    headers: {
      'Content-Type': isPdf ? 'application/pdf' : (upstream.headers.get('content-type') || 'application/octet-stream'),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

// Award details (timeline, officers, every bidder's item rates) saved by collect_results.py.
async function awardDetail(nitId, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-award.local/v1/${nitId}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  try {
    const upstream = await fetch(`${REPO_RAW}/main/data/awards/${nitId}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!upstream.ok) return json({ success: false, message: 'Award details are not collected for this tender yet.' }, 404, 'public, max-age=300');
    const response = new Response(upstream.body, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600', 'Access-Control-Allow-Origin': '*' }
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json({ success: false, message: 'Award details are unavailable right now.' }, 502);
  }
}

// Works history (collect_history.py): comparison figures and Excel downloads, streamed as-is.
const HISTORY_TYPES = { json: 'application/json; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
async function historyFile(path, ctx, ttl, download = false) {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-history.local/v1/${path}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let upstream;
  try {
    upstream = await fetch(`${REPO_RAW}/history/${path}`, { cf: { cacheTtl: ttl, cacheEverything: true } });
  } catch {}
  if (!upstream || !upstream.ok) return json({ success: false, message: 'Past works history is still being collected.' }, 404, 'public, max-age=120');
  const ext = path.split('.').pop();
  const headers = { 'Content-Type': HISTORY_TYPES[ext] || 'application/octet-stream', 'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`, 'Access-Control-Allow-Origin': '*' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.split('/').pop()}"`;
  const response = new Response(upstream.body, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function ageHours(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 3600000);
}

async function systemHealth(ctx, env = {}) {
  let snapshot = {};
  try {
    const response = await proxyRaw('health.json', ctx, 30, env);
    if (response.ok) snapshot = await response.json();
  } catch {}
  const stamp = snapshot.last_success_at || snapshot.generated_at;
  const age = ageHours(stamp);
  const count = Number(snapshot.count || 0);
  const counts = snapshot.category_counts || {};
  const database = {
    ok: count > 0 && age !== null && age <= 6,
    status: age !== null && age <= 2 ? 'fresh' : (age !== null && age <= 6 ? 'stale' : 'very_stale'),
    age_hours: age === null ? null : Math.round(age * 100) / 100,
    count,
    emd_known: Number(snapshot.emd_known || 0),
    category_counts: {
      WORKS: Number(counts.WORKS || 0),
      GOODS: Number(counts.GOODS || 0),
      SERVICES: Number(counts.SERVICES || 0)
    },
    generated_at: snapshot.generated_at || null,
    last_success_at: snapshot.last_success_at || null,
    collector: snapshot
  };

  const kppp = await (async () => {
    try {
      const response = await fetch(KPPP_WORKS + '?page=0&size=1&order-by-tender-publish=true', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Origin: KPPP_BASE,
          Referer: KPPP_BASE + '/',
          Post: 'CONTRACTOR-EPROC-CONTRACTOR',
          'User-Agent': USER_AGENT
        },
        body: JSON.stringify({ category: 'WORKS', status: 'PUBLISHED', title: '' })
      });
      const reported = Number(response.headers.get('X-Total-Count'));
      return { ok: response.ok, http: response.status, reported_works: Number.isFinite(reported) && reported > 0 ? reported : null };
    } catch (error) { return { ok: false, error: String(error).slice(0, 160) }; }
  })();

  return json({
    success: true,
    checked_at: new Date().toISOString(),
    overall: database.ok && kppp.ok ? 'healthy' : 'attention',
    database,
    kppp,
    hosting: { platform: 'Cloudflare Workers', live_data_source: 'GitHub hourly collector + deployed assets fallback' }
  }, 200, 'public, max-age=60, s-maxage=60');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': '*' } });
    }

    if (request.method !== 'GET') return json({ success: false, message: 'Method not allowed.' }, 405);

    if (['/tenders-lite.json', '/tenders.json', '/results-lite.json', '/rates-lite.json'].includes(url.pathname)) {
      return proxyRaw(url.pathname.slice(1), ctx, 300, env);
    }
    if (url.pathname === '/history-index.json') return historyFile('index.json', ctx, 600);
    if (url.pathname === '/similar-lite.json') return historyFile('similar.json', ctx, 1800);
    const download = url.pathname.match(/^\/downloads\/(works-[a-z0-9-]+\.xlsx)$/);
    if (download) return historyFile(`excel/${download[1]}`, ctx, 1800, true);
    if (url.pathname === '/health.json') return proxyRaw('health.json', ctx, 30, env);
    if (url.pathname === '/api/system_health') return systemHealth(ctx, env);
    const detail = url.pathname.match(/^\/api\/tender\/(WORKS|GOODS|SERVICES)\/(\d+)$/);
    if (detail) return tenderDetail(detail[1], detail[2], ctx);
    const award = url.pathname.match(/^\/api\/award\/(\d+)$/);
    if (award) return awardDetail(award[1], ctx);
    const fileList = url.pathname.match(/^\/api\/tender-files\/(WORKS|GOODS|SERVICES)\/(\d+)$/);
    if (fileList) return tenderFiles(fileList[1], fileList[2], ctx);
    const file = url.pathname.match(/^\/api\/tender-file\/(WORKS|GOODS|SERVICES)\/(\d+)\/([0-9a-fA-F-]+)$/);
    if (file) return tenderFile(file[1], file[2], file[3], url.searchParams.get('name'), url.searchParams.has('dl'));
    // Old bookmarks to the removed login/admin pages go to the tender list.
    if (['/login', '/login.html', '/admin', '/admin.html'].includes(url.pathname)) {
      return Response.redirect(new URL('/', url).toString(), 301);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ success: false, message: 'Not found.' }, 404);
    }
    return env.ASSETS.fetch(request);
  }
};
