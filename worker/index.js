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

async function proxyRaw(filename, ctx, ttl = 60, env = null, visibility = 'public') {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-data.local/${filename}`, { method: 'GET' });
  // The edge copy is shared; logged-in data must not sit in shared browser/proxy caches.
  const forClient = (resp) => {
    if (visibility !== 'private') return resp;
    const headers = new Headers(resp.headers);
    headers.set('Cache-Control', `private, max-age=${ttl}`);
    return new Response(resp.body, { status: resp.status, headers });
  };
  let response = await cache.match(cacheKey);
  if (response) return forClient(response);

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
  return forClient(response);
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

    if (request.method !== 'GET') return json({ success: false, message: 'Method not allowed.' }, 405);

    if (url.pathname === '/tenders-lite.json' || url.pathname === '/tenders.json') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return proxyRaw(url.pathname.slice(1), ctx, 300, env, 'private');
    }
    if (url.pathname === '/health.json') return proxyRaw('health.json', ctx, 30, env);
    if (url.pathname === '/api/system_health') {
      const denied = await requireAuthOrError(request, env);
      if (denied) return denied;
      return systemHealth(ctx, env);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ success: false, message: 'Not found.' }, 404);
    }
    return env.ASSETS.fetch(request);
  }
};
