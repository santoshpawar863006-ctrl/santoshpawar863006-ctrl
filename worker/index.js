'use strict';

import { handleAuthRoutes, requireAuthOrError, ensureAdminSeeded } from './auth.js';

// Hourly collector commits fresh tenders.json / health.json here; deployed assets are the fallback.
const RAW_BASES = [
  'https://raw.githubusercontent.com/santoshpawar863006-ctrl/santoshpawar863006-ctrl/main/public'
];
const KPPP_BASE = 'https://kppp.karnataka.gov.in';
const KPPP_WORKS = KPPP_BASE + '/supplier-registration-service/v1/api/portal-service/works/search-eproc-tenders';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function getSecret(env, ...names) {
  for (const name of names) {
    const raw = env?.[name];
    if (raw === undefined || raw === null) continue;
    let value = String(raw).trim();
    // Dashboard pastes sometimes include wrapping quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (value) return value;
  }
  return '';
}

function secretPresence(env) {
  return {
    ADMIN_USERNAME: Boolean(getSecret(env, 'ADMIN_USERNAME')),
    ADMIN_PASSWORD: Boolean(getSecret(env, 'ADMIN_PASSWORD')),
    ADMIN_NAME: Boolean(getSecret(env, 'ADMIN_NAME')),
    SESSION_SECRET: Boolean(getSecret(env, 'SESSION_SECRET')),
    AUTH_STORE: Boolean(env?.AUTH_STORE),
    ASSETS: Boolean(env?.ASSETS)
  };
}

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
    secrets: secretPresence(env),
    hosting: { platform: 'Cloudflare Workers', live_data_source: 'GitHub hourly collector + deployed assets fallback' }
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
  const assumptions = {
    ...defaultAssumptions(tender.category, tender.emd),
    ...(override || {}),
    emd_hint: asNumber(tender.emd)
  };

  const math = computeBidMath(tender.amount, assumptions);
  return json({
    success: true,
    tender_ref: tender.ref_no || tender.id || '',
    ecv: tender.amount,
    emd: tender.emd,
    category: String(tender.category || '').toUpperCase(),
    message: override ? 'Calculated from your edited assumptions.' : 'Calculated from the standard category profile. Edit the percentages and recalculate to match your rates.',
    ...math,
    disclaimer: 'Planning estimate only. Verify BOQ quantities, current rates, royalties, GST, machinery and site conditions before submitting a bid.'
  });
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

    // Auth/admin APIs must always be handled by the Worker (never static assets).
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path.startsWith('/api/auth') || path.startsWith('/api/admin')) {
      try {
        const handled = await handleAuthRoutes(request, env, url);
        if (handled) return handled;
        return json({ success: false, message: 'Auth route not found.' }, 404);
      } catch (err) {
        return json({
          success: false,
          message: 'Auth handler error: ' + (err && err.message ? err.message : 'unknown')
        }, 500);
      }
    }

    if (url.pathname === '/api/bid_calculator' && request.method === 'POST') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return bidCalculator(request, env);
    }
    if (request.method !== 'GET') return json({ success: false, message: 'Method not allowed.' }, 405);

    if (url.pathname === '/tenders.json') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return proxyRaw('tenders.json', ctx, 60, env);
    }
    if (url.pathname === '/health.json') return proxyRaw('health.json', ctx, 30, env);
    if (url.pathname === '/api/system_health') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return systemHealth(ctx, env);
    }
    if (url.pathname === '/api/tender_detail') {
      return json({ success: false, message: 'Authenticated KPPP full-view is not required on Cloudflare. All public KPPP feed details remain available.' });
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ success: false, message: 'This optional legacy endpoint is not enabled on the zero-cost Cloudflare runtime.' }, 404);
    }
    return env.ASSETS.fetch(request);
  }
};
