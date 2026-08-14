'use strict';

import { handleAuthRoutes, requireAuthOrError, ensureAdminSeeded } from './auth.js';

const RAW_BASE = 'https://raw.githubusercontent.com/santoshpawar863006-ctrl/KPPP-NEEWWW/main/public';
const KPPP_BASE = 'https://kppp.karnataka.gov.in';
const KPPP_WORKS = KPPP_BASE + '/supplier-registration-service/v1/api/portal-service/works/search-eproc-tenders';
const TENDERKART_BASE = 'https://tenderkart.in';

const HTML_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9'
};

const JSON_HEADERS = {
  'User-Agent': HTML_HEADERS['User-Agent'],
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-IN,en;q=0.9'
};

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

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[₹,]/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function uniqueStrings(value, key = null, limit = 20) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    let text = '';
    if (typeof item === 'string') text = item.trim();
    else if (item && typeof item === 'object' && key) text = String(item[key] || '').trim();
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function reservationFromText(text) {
  const low = String(text || '').toLowerCase();
  if (/\bsc\b|scheduled caste/.test(low)) return 'SC';
  if (/\bst\b|scheduled tribe/.test(low)) return 'ST';
  for (const cat of ['2a', '2b', '3a', '3b', 'cat1', 'category 1']) {
    if (low.includes(cat)) return cat.toUpperCase().replace('CATEGORY ', 'CAT');
  }
  if (low.includes('reserved category')) return 'Reserved category';
  return null;
}

function kpwdClassFromText(text) {
  const match = String(text || '').match(/(?:kpwd|pwd).{0,70}?class\s*[-:]?\s*([ivx0-9]+(?:\s*(?:and|or|&)\s*above)?)/i);
  return match ? match[1].trim() : null;
}

function boqLines(text, limit = 10) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || ['in figures', 'in figures(rs)', 'in figures (rs)', 'total'].includes(line.toLowerCase())) continue;
    if (line.length < 8) continue;
    if (!out.includes(line)) out.push(line.slice(0, 500));
    if (out.length >= limit) break;
  }
  return out;
}

function tenderkartMatchesRef(detail, tenderRef) {
  const ref = norm(tenderRef);
  if (!ref || !detail || typeof detail !== 'object') return false;
  for (const key of ['tender_link', 'portal_link', 'tender_id', 'tender_reference_number']) {
    if (detail[key] && norm(detail[key]).includes(ref)) return true;
  }
  const ext = detail.extended_data && typeof detail.extended_data === 'object' ? detail.extended_data : {};
  const raw = ext.raw_html && typeof ext.raw_html === 'object' ? ext.raw_html : {};
  for (const value of Object.values(raw)) {
    if (value && norm(value).includes(ref)) return true;
  }
  const kd = ext.karnataka_data && typeof ext.karnataka_data === 'object' ? ext.karnataka_data : {};
  for (const key of ['tender_number', 'tender_reference_number', 'reference_number']) {
    if (kd[key] && norm(kd[key]).includes(ref)) return true;
  }
  return false;
}

function tenderkartSignals(detail) {
  const ext = detail?.extended_data && typeof detail.extended_data === 'object' ? detail.extended_data : {};
  const kd = ext.karnataka_data && typeof ext.karnataka_data === 'object' ? ext.karnataka_data : {};
  const work = ext.work_item_details && typeof ext.work_item_details === 'object' ? ext.work_item_details : {};
  const eligibility = uniqueStrings(kd.eligibility_criteria, null, 20);
  const technical = uniqueStrings(kd.technical_criteria, 'description', 20);
  const required = uniqueStrings(kd.required_documents, 'document_name', 20);
  const tenderDocs = [];
  const docs = ext.documents && typeof ext.documents === 'object' ? ext.documents : {};
  if (Array.isArray(docs.nit)) {
    for (const item of docs.nit) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name || '').trim();
      const type = String(item.document_type || '').trim();
      if (!name) continue;
      const label = type ? `${name} — ${type}` : name;
      if (!tenderDocs.includes(label)) tenderDocs.push(label);
      if (tenderDocs.length >= 15) break;
    }
  }
  const combined = [...eligibility, ...technical, ...required].join(' ');
  const signals = {
    tender_value: asNumber(detail.tender_value),
    emd: asNumber(detail.emd_fee),
    tender_fee: asNumber(detail.tender_fee),
    tender_class: detail.tender_type || null,
    form_of_contract: detail.form_of_contract || null,
    tender_category: detail.tender_category || null,
    product_category: detail.product_category || null,
    location: detail.location || detail.formatted_location || null,
    work_description: detail.work_description || detail.description || null,
    published_date: detail.publish_date || null,
    closing_date: detail.bid_submission_end || detail.effective_bid_submission_end || null,
    bid_opening_date: detail.bid_opening_date || null,
    download_end_date: detail.document_download_end || null,
    bid_validity_days: work.bid_validity_days || kd.bid_validity_days || null,
    nit_id: kd.nit_id || null,
    bid_value_type: kd.bid_value_type || null,
    denomination_type: kd.denomination_type || null,
    tax_type: kd.tax_type || null,
    contact_person: kd.contact_person || null,
    mobile_number: kd.mobile_number || null,
    reservation: reservationFromText(combined),
    kpwd_class: kpwdClassFromText(combined),
    eligibility,
    technical_criteria: technical,
    documents_required: required,
    tender_documents: tenderDocs,
    boq_preview: boqLines(kd.boq_text || detail.boq, 10),
    tags: []
  };
  if (eligibility.length) signals.tags.push(`${eligibility.length} eligibility condition(s)`);
  if (technical.length) signals.tags.push(`${technical.length} technical criterion/criteria`);
  if (required.length) signals.tags.push(`${required.length} mandatory document requirement(s)`);
  if (tenderDocs.length) signals.tags.push(`${tenderDocs.length} tender document file(s)`);
  for (const key of Object.keys(signals)) {
    const v = signals[key];
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) delete signals[key];
  }
  return signals;
}

async function getTenderKartDetail(tenderRef, title = '', department = '') {
  const attempts = [];
  const searches = [
    { keywords: tenderRef, state: 'Karnataka', limit: '8' },
    { keywords: tenderRef, limit: '8' }
  ];
  if (title) {
    const words = (String(title).match(/[A-Za-z0-9]+/g) || []).slice(0, 14).join(' ');
    if (words) searches.push({ keywords: words, state: 'Karnataka', limit: '8' });
  }
  const seen = new Set();
  for (const params of searches) {
    const url = new URL(TENDERKART_BASE + '/api/v1/tenders');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let response;
    try {
      response = await fetch(url, { headers: { ...JSON_HEADERS, Referer: TENDERKART_BASE + '/tenders/filters' } });
    } catch (error) {
      attempts.push({ source: 'TenderKart', method: 'public API', error: String(error).slice(0, 100) });
      continue;
    }
    attempts.push({ source: 'TenderKart', method: 'public API', http: response.status, query: 'keywords' });
    if (!response.ok) continue;
    let payload;
    try { payload = await response.json(); } catch { continue; }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const titleNorm = norm(title);
    const deptNorm = norm(department);
    const ranked = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = String(row.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let score = 0;
      if (String(row.portal_name || '').toLowerCase() === 'karnataka') score += 20;
      const rowTitle = norm(row.title);
      if (titleNorm && rowTitle === titleNorm) score += 60;
      else if (titleNorm && titleNorm.slice(0, 40) && rowTitle.includes(titleNorm.slice(0, 40))) score += 30;
      if (deptNorm && deptNorm.slice(0, 20) && norm(`${row.organisation || ''} ${row.department || ''}`).includes(deptNorm.slice(0, 20))) score += 15;
      ranked.push({ score, id, row });
    }
    ranked.sort((a, b) => b.score - a.score);
    for (const candidate of ranked.slice(0, 5)) {
      let detailResponse;
      try {
        detailResponse = await fetch(TENDERKART_BASE + '/api/v1/tenders/' + encodeURIComponent(candidate.id), { headers: JSON_HEADERS });
      } catch { continue; }
      if (!detailResponse.ok) continue;
      let detail;
      try { detail = await detailResponse.json(); } catch { continue; }
      if (!tenderkartMatchesRef(detail, tenderRef)) continue;
      return [{
        source: 'TenderKart',
        title: detail.title || candidate.row.title || 'TenderKart',
        url: TENDERKART_BASE + '/tender/' + candidate.id,
        host: 'tenderkart.in',
        official: false,
        match_method: 'direct TenderKart public API + exact KPPP reference',
        signals: tenderkartSignals(detail)
      }, attempts];
    }
  }
  return [null, attempts];
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function cleanText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function parseMoney(raw, unit = '') {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || '').toLowerCase();
  if (['crore', 'crores', 'cr'].includes(u)) return n * 10000000;
  if (['lakh', 'lakhs', 'lac', 'lacs', 'l'].includes(u)) return n * 100000;
  return n;
}

function moneyAfter(text, labelPattern) {
  const patterns = [
    new RegExp(`(?:${labelPattern})\\s*(?:amount|value)?\\s*[:\\-|]?\\s*(?:rs\\.?|inr|₹)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(crore|crores|cr|lakh|lakhs|lac|lacs|l)?\\b`, 'i'),
    new RegExp(`(?:${labelPattern})[\\s\\S]{0,80}?(?:rs\\.?|inr|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(crore|crores|cr|lakh|lakhs|lac|lacs|l)?\\b`, 'i')
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) {
      const value = parseMoney(match[1], match[2]);
      if (value) return value;
    }
  }
  return null;
}

function basicSignals(text) {
  const low = String(text || '').toLowerCase();
  const signals = {};
  const tenderValue = moneyAfter(text, 'tender\\s+value|estimated\\s+tender\\s+value|tender\\s+amount');
  const emd = moneyAfter(text, 'emd(?:\\s+fee)?|emd\\s+amount');
  const fee = moneyAfter(text, 'tender\\s+fee|document\\s+cost');
  if (tenderValue) signals.tender_value = tenderValue;
  if (emd) signals.emd = emd;
  if (fee) signals.tender_fee = fee;
  if (/\btender\s+type\s*[:\-]?\s*reserved\b/i.test(low)) signals.tender_class = 'Reserved';
  else if (/\btender\s+type\s*[:\-]?\s*open\b/i.test(low)) signals.tender_class = 'Regular / Open';
  else if (/\btender\s+type\s*[:\-]?\s*restricted\b/i.test(low)) signals.tender_class = 'Qualified / Restricted';
  const reservation = reservationFromText(text);
  if (reservation) signals.reservation = reservation;
  const cls = kpwdClassFromText(text);
  if (cls) signals.kpwd_class = cls;
  return signals;
}

async function braveSearch(query, domain) {
  const searchUrl = new URL('https://search.brave.com/search');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('source', 'web');
  let response;
  try {
    response = await fetch(searchUrl, { headers: { ...HTML_HEADERS, Referer: 'https://search.brave.com/' } });
  } catch { return []; }
  if (!response.ok) return [];
  const html = await response.text();
  const out = [];
  const regex = /href=["'](https?:\/\/[^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = decodeEntities(match[1]);
    const host = hostOf(url);
    if (!(host === domain || host.endsWith('.' + domain))) continue;
    if (out.some(x => x.url === url)) continue;
    const start = Math.max(0, match.index - 1200);
    const end = Math.min(html.length, match.index + 2200);
    const context = cleanText(html.slice(start, end));
    out.push({ url, host, context });
    if (out.length >= 8) break;
  }
  return out;
}

async function getIndexedSource(sourceKey, tenderRef, title = '', department = '', location = '') {
  const config = sourceKey === 'bidassist'
    ? { name: 'BidAssist', domain: 'bidassist.com' }
    : { name: 'TendersPlus', domain: 'tendersplus.com' };
  const attempts = [];
  const refWords = String(tenderRef || '').replace(/[^A-Za-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const titleWords = (String(title).match(/[A-Za-z0-9]+/g) || []).slice(0, 11).join(' ');
  const contextWords = [
    (String(department).match(/[A-Za-z0-9]+/g) || []).slice(0, 5).join(' '),
    (String(location).match(/[A-Za-z0-9]+/g) || []).slice(0, 4).join(' ')
  ].filter(Boolean).join(' ');
  const queries = [
    `"${tenderRef}" ${config.name}`,
    `"${refWords}" ${config.name} Karnataka`
  ];
  if (titleWords) queries.push(`"${titleWords}" "${contextWords}" ${config.name} Karnataka`);
  const targetRef = norm(tenderRef);

  for (const query of queries) {
    const candidates = await braveSearch(query, config.domain);
    attempts.push({ source: config.name, query_type: 'public search', found: candidates.length });
    for (const candidate of candidates) {
      let pageText = '';
      try {
        const page = await fetch(candidate.url, { headers: HTML_HEADERS, redirect: 'follow' });
        if (page.ok && page.status !== 202) pageText = cleanText(await page.text());
      } catch {}
      const combined = `${candidate.url} ${candidate.context} ${pageText}`;
      if (!targetRef || !norm(combined).includes(targetRef)) continue;
      return [{
        source: config.name,
        title: candidate.context.slice(0, 180) || config.name,
        url: candidate.url,
        host: config.domain,
        official: false,
        match_method: pageText ? 'public indexed page + exact tender reference' : 'public search result + exact tender reference',
        signals: basicSignals(combined)
      }, attempts];
    }
  }
  return [null, attempts];
}

async function lookupPublicDetails(url) {
  const tenderRef = String(url.searchParams.get('tender') || '').trim();
  const title = String(url.searchParams.get('title') || '').trim();
  const department = String(url.searchParams.get('department') || '').trim();
  const location = String(url.searchParams.get('location') || '').trim();
  let source = String(url.searchParams.get('source') || 'all').trim().toLowerCase();
  if (!tenderRef) return json({ success: false, message: 'Tender number is required.' }, 400);
  if (!['all', 'tenderkart', 'bidassist', 'tendersplus'].includes(source)) source = 'all';
  const sources = [];
  const attempts = [];

  if (source === 'all' || source === 'tenderkart') {
    const [item, itemAttempts] = await getTenderKartDetail(tenderRef, title, department);
    attempts.push(...itemAttempts);
    if (item) sources.push(item);
  }
  for (const key of ['bidassist', 'tendersplus']) {
    if (source !== 'all' && source !== key) continue;
    const [item, itemAttempts] = await getIndexedSource(key, tenderRef, title, department, location);
    attempts.push(...itemAttempts);
    if (item) sources.push(item);
  }
  const priority = { TendersPlus: 0, TenderKart: 1, BidAssist: 2 };
  sources.sort((a, b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9));
  return json({
    success: true,
    tender_ref: tenderRef,
    requested_source: source,
    sources,
    source_count: sources.length,
    attempts,
    note: 'TenderKart is queried through its public website API. BidAssist and TendersPlus use verified public indexed pages only; locked content is not accessed.'
  }, 200, 'public, max-age=3600, s-maxage=3600');
}

async function proxyRaw(filename, ctx, ttl = 60) {
  const sourceUrl = `${RAW_BASE}/${filename}`;
  const cache = caches.default;
  const cacheKey = new Request(sourceUrl, { method: 'GET' });
  let response = await cache.match(cacheKey);
  if (!response) {
    const upstream = await fetch(sourceUrl, { headers: { Accept: 'application/json' }, cf: { cacheEverything: true, cacheTtl: ttl } });
    if (!upstream.ok) return json({ success: false, message: `${filename} is temporarily unavailable.` }, 502);
    const headers = new Headers(upstream.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`);
    headers.set('Access-Control-Allow-Origin', '*');
    response = new Response(upstream.body, { status: upstream.status, headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

function ageHours(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 3600000);
}

async function systemHealth(ctx) {
  let snapshot = {};
  try {
    const response = await fetch(`${RAW_BASE}/health.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 30 } });
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
    category_counts: {
      WORKS: Number(counts.WORKS || 0),
      GOODS: Number(counts.GOODS || 0),
      SERVICES: Number(counts.SERVICES || 0)
    },
    generated_at: snapshot.generated_at || null,
    last_success_at: snapshot.last_success_at || null,
    collector: snapshot
  };

  const [kppp, tenderkart] = await Promise.all([
    (async () => {
      try {
        const response = await fetch(KPPP_WORKS + '?page=0&size=1&order-by-tender-publish=true', {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            Origin: KPPP_BASE,
            Referer: KPPP_BASE + '/',
            Post: 'CONTRACTOR-EPROC-CONTRACTOR',
            'User-Agent': HTML_HEADERS['User-Agent']
          },
          body: JSON.stringify({ category: 'WORKS', status: 'PUBLISHED', title: '' })
        });
        const reported = Number(response.headers.get('X-Total-Count'));
        return { ok: response.ok, http: response.status, reported_works: Number.isFinite(reported) && reported > 0 ? reported : null };
      } catch (error) { return { ok: false, error: String(error).slice(0, 160) }; }
    })(),
    (async () => {
      try {
        const u = new URL(TENDERKART_BASE + '/api/v1/tenders');
        u.searchParams.set('keywords', 'Karnataka');
        u.searchParams.set('state', 'Karnataka');
        u.searchParams.set('limit', '1');
        const response = await fetch(u, { headers: JSON_HEADERS });
        let valid = false;
        if (response.ok) {
          try { const p = await response.json(); valid = Array.isArray(p?.data); } catch {}
        }
        return { ok: response.ok && valid, http: response.status };
      } catch (error) { return { ok: false, error: String(error).slice(0, 160) }; }
    })()
  ]);

  return json({
    success: true,
    checked_at: new Date().toISOString(),
    overall: database.ok && kppp.ok ? 'healthy' : 'attention',
    database,
    kppp,
    tenderkart,
    bidassist: { status: 'search_based', note: 'Checked only when a tender search is requested.' },
    tendersplus: { status: 'search_based', note: 'Checked only when a tender search is requested.' },
    hosting: { platform: 'Cloudflare Workers', live_data_source: 'GitHub hourly collector' }
  }, 200, 'public, max-age=60, s-maxage=60');
}

const BID_PROFILES = {
  WORKS: { direct_pct: 80, overhead_pct: 5, contingency_pct: 3, savings_pct: 0, target_margin_pct: 8 },
  GOODS: { direct_pct: 90, overhead_pct: 3, contingency_pct: 2, savings_pct: 0, target_margin_pct: 6 },
  SERVICES: { direct_pct: 75, overhead_pct: 8, contingency_pct: 4, savings_pct: 0, target_margin_pct: 10 },
  DEFAULT: { direct_pct: 80, overhead_pct: 5, contingency_pct: 3, savings_pct: 0, target_margin_pct: 8 }
};

function clampPct(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function computeBidMath(ecv, assumptions) {
  const directPct = clampPct(assumptions.direct_pct, 0, 150, 80);
  const overheadPct = clampPct(assumptions.overhead_pct, 0, 50, 5);
  const contingencyPct = clampPct(assumptions.contingency_pct, 0, 50, 3);
  const savingsPct = clampPct(assumptions.savings_pct, 0, 50, 0);
  const marginPct = clampPct(assumptions.target_margin_pct, 0, 40, 8);

  const directBase = ecv * (directPct / 100);
  const saving = directBase * (savingsPct / 100);
  const adjustedDirect = directBase - saving;
  const overhead = ecv * (overheadPct / 100);
  const contingency = ecv * (contingencyPct / 100);
  const siteCost = adjustedDirect + overhead + contingency;
  const targetBid = marginPct < 100 ? siteCost / (1 - marginPct / 100) : siteCost;
  const profit = targetBid - siteCost;
  const targetDiscount = ((ecv - targetBid) / ecv) * 100;
  const breakEvenDiscount = ((ecv - siteCost) / ecv) * 100;
  const costShare = (siteCost / ecv) * 100;
  const workingCapital = Math.max(siteCost * 0.12, asNumber(assumptions.emd_hint) || 0);

  const round = (n) => Math.round(n * 100) / 100;
  const scenarios = [
    { label: 'Aggressive', bid: round(siteCost * 1.03), note: 'Thin ~3% buffer above site cost' },
    { label: 'Balanced (target)', bid: round(targetBid), note: `${marginPct.toFixed(1)}% target margin` },
    { label: 'Conservative', bid: round(Math.max(targetBid, siteCost * 1.12)), note: 'Higher safety cushion' }
  ].map((s) => ({
    ...s,
    profit: round(s.bid - siteCost),
    discount_vs_ecv_pct: round(((ecv - s.bid) / ecv) * 100)
  }));

  const warnings = [];
  if (costShare >= 100) warnings.push('Modelled site cost is at or above ECV. Re-rate carefully before bidding.');
  else if (costShare >= 95) warnings.push('Very little cost headroom remains under these assumptions.');
  if (targetBid > ecv) warnings.push('Target margin implies a bid above ECV.');
  if (directPct + overheadPct + contingencyPct < 60) warnings.push('Entered cost percentages look unusually low.');

  return {
    assumptions: {
      direct_pct: directPct,
      overhead_pct: overheadPct,
      contingency_pct: contingencyPct,
      savings_pct: savingsPct,
      target_margin_pct: marginPct,
      rationale: assumptions.rationale || null
    },
    results: {
      estimated_site_cost: round(siteCost),
      break_even_bid: round(siteCost),
      cost_to_cost_bid: round(siteCost),
      target_bid: round(targetBid),
      expected_profit: round(profit),
      target_discount_vs_ecv_pct: round(targetDiscount),
      max_safe_discount_pct: round(breakEvenDiscount),
      cost_share_of_ecv_pct: round(costShare),
      working_capital_hint: round(workingCapital)
    },
    scenarios,
    risks: Array.isArray(assumptions.risks) ? assumptions.risks.filter(Boolean).slice(0, 8) : [],
    warnings
  };
}

function defaultAssumptions(category, emd) {
  const base = BID_PROFILES[String(category || '').toUpperCase()] || BID_PROFILES.DEFAULT;
  return {
    ...base,
    emd_hint: asNumber(emd),
    rationale: `Default ${String(category || 'WORKS').toUpperCase()} contractor planning profile. Adjust with your rate analysis.`,
    risks: [
      'Verify BOQ quantities and current material/labour rates before submission.',
      'Confirm eligibility, class, EMD mode and site conditions on the official KPPP notice.'
    ]
  };
}

async function askClaudeForAssumptions(env, tender) {
  const apiKey = String(env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || '').trim();
  if (!apiKey) {
    return {
      assumptions: defaultAssumptions(tender.category, tender.emd),
      ai_used: false,
      ai_message: 'ANTHROPIC_API_KEY not set. Add it to .dev.vars and restart wrangler. Using category defaults.'
    };
  }

  const category = String(tender.category || 'WORKS').toUpperCase();
  const defaults = defaultAssumptions(category, tender.emd);
  const system = `You are a Karnataka government works/goods/services tender bid planner for Indian contractors.
Return ONLY valid JSON with keys:
direct_pct, overhead_pct, contingency_pct, savings_pct, target_margin_pct, rationale, risks (array of short strings).
Percentages are of ECV except savings_pct which is % saving on direct cost.
Be practical for Karnataka site conditions. Do not invent fake BOQ line items. No markdown.`;
  const userContent = JSON.stringify({
    ref_no: tender.ref_no || tender.id || '',
    title: tender.title || '',
    category,
    department: tender.department || '',
    location: tender.location || '',
    amount_ecv: asNumber(tender.amount),
    emd: asNumber(tender.emd),
    fee: asNumber(tender.fee),
    closing_date: tender.closing_date || '',
    work_category: tender.work_category || '',
    tender_type: tender.tender_type || '',
    inviting_strategy: tender.inviting_strategy || '',
    default_profile: defaults
  });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || 'claude-sonnet-4-5',
        max_tokens: 1024,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      let detail = String(errText).slice(0, 220);
      try {
        const errJson = JSON.parse(errText);
        detail = String(errJson?.error?.message || errJson?.message || detail).slice(0, 220);
      } catch {}
      let hint = `Claude HTTP ${response.status}. Using defaults. ${detail}`;
      if (response.status === 401) hint = 'Claude rejected the API key (401). Check ANTHROPIC_API_KEY in .dev.vars, then restart wrangler.';
      if (response.status === 403) hint = `Claude access forbidden (403). Check plan/billing for the API key. ${detail}`;
      if (response.status === 429) hint = `Claude rate limit / quota (429). Check console.anthropic.com usage/billing, then retry. ${detail}`;
      return {
        assumptions: defaults,
        ai_used: false,
        ai_message: hint
      };
    }

    const payload = await response.json();
    const content = Array.isArray(payload?.content)
      ? payload.content.map((part) => part?.text || '').join('\n')
      : '';
    let parsed = {};
    const raw = String(content || '').trim();
    try {
      parsed = JSON.parse(raw);
    } catch {
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) {
        try { parsed = JSON.parse(fence[1]); } catch { parsed = {}; }
      } else {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = {}; }
        }
      }
    }

    return {
      assumptions: {
        direct_pct: clampPct(parsed.direct_pct, 0, 150, defaults.direct_pct),
        overhead_pct: clampPct(parsed.overhead_pct, 0, 50, defaults.overhead_pct),
        contingency_pct: clampPct(parsed.contingency_pct, 0, 50, defaults.contingency_pct),
        savings_pct: clampPct(parsed.savings_pct, 0, 50, defaults.savings_pct),
        target_margin_pct: clampPct(parsed.target_margin_pct, 0, 40, defaults.target_margin_pct),
        emd_hint: asNumber(tender.emd),
        rationale: String(parsed.rationale || defaults.rationale).slice(0, 600),
        risks: Array.isArray(parsed.risks) && parsed.risks.length
          ? parsed.risks.map((x) => String(x).slice(0, 180)).slice(0, 8)
          : defaults.risks
      },
      ai_used: true,
      ai_message: 'Assumptions suggested by Claude. Rupee totals are calculated locally.'
    };
  } catch (error) {
    return {
      assumptions: defaults,
      ai_used: false,
      ai_message: `Claude unavailable (${String(error).slice(0, 120)}). Using defaults.`
    };
  }
}

async function bidCalculator(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  const tender = {
    id: body.id || '',
    ref_no: body.ref_no || body.tender || '',
    title: body.title || '',
    category: body.category || 'WORKS',
    department: body.department || '',
    location: body.location || '',
    amount: asNumber(body.amount ?? body.ecv),
    emd: asNumber(body.emd),
    fee: asNumber(body.fee),
    closing_date: body.closing_date || '',
    work_category: body.work_category || '',
    tender_type: body.tender_type || '',
    inviting_strategy: body.inviting_strategy || ''
  };

  if (!tender.amount) {
    return json({
      success: false,
      message: 'Tender value (ECV) is required to calculate a bid. Enter amount manually if missing from the feed.'
    }, 400);
  }

  const override = body.assumptions && typeof body.assumptions === 'object' ? body.assumptions : null;
  let aiMeta = { ai_used: false, ai_message: 'Using your edited assumptions.' };
  let assumptions;

  if (override) {
    assumptions = {
      ...defaultAssumptions(tender.category, tender.emd),
      ...override,
      emd_hint: asNumber(tender.emd)
    };
  } else if (body.skip_ai) {
    assumptions = defaultAssumptions(tender.category, tender.emd);
    aiMeta = { ai_used: false, ai_message: 'Using category defaults (AI skipped).' };
  } else {
    const asked = await askClaudeForAssumptions(env, tender);
    assumptions = asked.assumptions;
    aiMeta = { ai_used: asked.ai_used, ai_message: asked.ai_message };
  }

  const math = computeBidMath(tender.amount, assumptions);
  return json({
    success: true,
    tender_ref: tender.ref_no || tender.id || '',
    ecv: tender.amount,
    emd: tender.emd,
    category: String(tender.category || '').toUpperCase(),
    ...aiMeta,
    ...math,
    disclaimer: 'Planning estimate only. Verify BOQ quantities, current rates, royalties, GST, machinery and site conditions before submitting a bid.'
  });
}

async function bidAsk(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  const question = String(body.question || body.prompt || '').trim();
  if (!question) {
    return json({ success: false, message: 'Type a question about this tender or bid plan first.' }, 400);
  }
  if (question.length > 2000) {
    return json({ success: false, message: 'Question is too long. Keep it under 2000 characters.' }, 400);
  }

  const apiKey = String(env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || '').trim();
  if (!apiKey) {
    return json({
      success: false,
      message: 'ANTHROPIC_API_KEY not set. Add it to .dev.vars and restart wrangler.'
    }, 503);
  }

  const tender = body.tender && typeof body.tender === 'object' ? body.tender : {};
  const bidPlan = body.bid_plan && typeof body.bid_plan === 'object' ? body.bid_plan : {};
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

  const system = `You are a practical Karnataka government tender bidding advisor for Indian contractors.
Answer clearly and briefly using the tender details and bid calculator context provided.
Use Indian rupees and percentage terms when relevant.
If information is missing (BOQ, site photos, soil, royalty, GST slabs), say what the contractor should verify on KPPP / site.
Do not invent exact official BOQ rates. This is planning advice, not a certified estimate.
Prefer short paragraphs or bullet points.`;

  const contextBlock = JSON.stringify({
    tender: {
      ref_no: tender.ref_no || tender.id || '',
      title: tender.title || '',
      category: tender.category || '',
      department: tender.department || '',
      location: tender.location || '',
      amount_ecv: tender.amount || tender.ecv || null,
      emd: tender.emd || null,
      fee: tender.fee || null,
      closing_date: tender.closing_date || '',
      work_category: tender.work_category || '',
      tender_type: tender.tender_type || '',
      inviting_strategy: tender.inviting_strategy || ''
    },
    bid_plan: {
      assumptions: bidPlan.assumptions || null,
      results: bidPlan.results || null,
      scenarios: bidPlan.scenarios || null,
      risks: bidPlan.risks || null,
      warnings: bidPlan.warnings || null,
      ai_message: bidPlan.ai_message || null
    }
  });

  const messages = [];
  for (const turn of history) {
    const role = String(turn.role || '').toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const text = String(turn.content || '').trim();
    if (!text) continue;
    messages.push({ role, content: text.slice(0, 2500) });
  }
  messages.push({
    role: 'user',
    content: `Tender + bid calculator context:\n${contextBlock}\n\nContractor question:\n${question}`
  });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || 'claude-sonnet-4-5',
        max_tokens: 1200,
        temperature: 0.3,
        system,
        messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      let detail = String(errText).slice(0, 220);
      try {
        const errJson = JSON.parse(errText);
        detail = String(errJson?.error?.message || errJson?.message || detail).slice(0, 220);
      } catch {}
      let message = `Claude HTTP ${response.status}. ${detail}`;
      if (response.status === 401) message = 'Claude rejected the API key (401). Check ANTHROPIC_API_KEY in .dev.vars.';
      if (response.status === 429) message = `Claude rate limit / quota (429). ${detail}`;
      return json({ success: false, message }, response.status === 401 ? 401 : 502);
    }

    const payload = await response.json();
    const answer = Array.isArray(payload?.content)
      ? payload.content.map((part) => part?.text || '').join('\n').trim()
      : '';
    if (!answer) {
      return json({ success: false, message: 'Claude returned an empty answer. Try again.' }, 502);
    }

    return json({
      success: true,
      answer,
      model: payload?.model || null
    });
  } catch (error) {
    return json({
      success: false,
      message: `Claude unavailable (${String(error).slice(0, 140)}).`
    }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': '*' } });
    }

    // Seed default admin on cold starts when KV is available.
    if (env.AUTH_STORE) {
      ctx.waitUntil(ensureAdminSeeded(env).catch(() => {}));
    }

    if (url.pathname.startsWith('/api/auth') || url.pathname.startsWith('/api/admin')) {
      const handled = await handleAuthRoutes(request, env, url);
      if (handled) return handled;
      return json({ success: false, message: 'Auth route not found.' }, 404);
    }

    if (url.pathname === '/api/bid_calculator' && request.method === 'POST') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return bidCalculator(request, env);
    }
    if (url.pathname === '/api/bid_ask' && request.method === 'POST') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return bidAsk(request, env);
    }

    if (request.method !== 'GET') return json({ success: false, message: 'Method not allowed.' }, 405);

    if (url.pathname === '/tenders.json') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return proxyRaw('tenders.json', ctx, 60);
    }
    if (url.pathname === '/health.json') return proxyRaw('health.json', ctx, 30);
    if (url.pathname === '/api/system_health') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return systemHealth(ctx);
    }
    if (url.pathname === '/api/public_tender_detail') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return lookupPublicDetails(url);
    }
    if (url.pathname === '/api/tender_detail') {
      return json({ success: false, message: 'Authenticated KPPP full-view is not required on Cloudflare. All public KPPP feed details remain available, with TenderKart enrichment loaded separately.' });
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ success: false, message: 'This optional legacy endpoint is not enabled on the zero-cost Cloudflare runtime.' }, 404);
    }
    return env.ASSETS.fetch(request);
  }
};
