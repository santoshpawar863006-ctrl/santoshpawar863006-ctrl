export async function onRequestGet(context) {
  const { request } = context;
  const checkedAt = new Date().toISOString();
  const result = {
    success: true,
    checked_at: checkedAt,
    overall: 'attention',
    database: { ok: false, status: 'unknown', age_hours: null, count: 0, category_counts: {} },
    kppp: { ok: false },
    tenderkart: { ok: false },
    bidassist: { status: 'search_based', note: 'Checked only when a tender search is requested.' },
    tendersplus: { status: 'search_based', note: 'Checked only when a tender search is requested.' }
  };

  try {
    const healthUrl = new URL('/health.json', request.url);
    const r = await fetch(healthUrl.toString(), { cf: { cacheTtl: 60 } });
    if (r.ok) {
      const h = await r.json();
      const generated = h.generated_at || h.last_success_at;
      const age = generated ? Math.max(0, (Date.now() - new Date(generated).getTime()) / 3600000) : null;
      result.database = {
        ok: Number(h.count || 0) > 0 && age !== null && age <= 6,
        status: age === null ? 'unknown' : (age <= 2 ? 'fresh' : (age <= 6 ? 'stale' : 'very_stale')),
        age_hours: age === null ? null : Math.round(age * 100) / 100,
        count: Number(h.count || 0),
        category_counts: h.category_counts || {},
        generated_at: h.generated_at || null,
        last_success_at: h.last_success_at || null,
        collector: h
      };
    }
  } catch (err) {
    result.database.error = String(err).slice(0, 160);
  }

  try {
    const kpppUrl = 'https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service/works/search-eproc-tenders?page=0&size=1&order-by-tender-publish=true';
    const r = await fetch(kpppUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': 'https://kppp.karnataka.gov.in',
        'Referer': 'https://kppp.karnataka.gov.in/',
        'Post': 'CONTRACTOR-EPROC-CONTRACTOR',
        'User-Agent': 'Mozilla/5.0 Chrome/124.0'
      },
      body: JSON.stringify({ category: 'WORKS', status: 'PUBLISHED', title: '' })
    });
    const total = r.headers.get('X-Total-Count');
    result.kppp = { ok: r.status === 200, http: r.status, reported_works: total && /^\d+$/.test(total) ? Number(total) : null };
  } catch (err) {
    result.kppp = { ok: false, error: String(err).slice(0, 160) };
  }

  try {
    const r = await fetch('https://tenderkart.in/api/v1/tenders?keywords=Karnataka&state=Karnataka&limit=1', {
      headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'Mozilla/5.0 Chrome/124.0' }
    });
    let valid = false;
    if (r.ok) {
      try {
        const p = await r.json();
        valid = p && typeof p === 'object' && Array.isArray(p.data);
      } catch (_) {}
    }
    result.tenderkart = { ok: r.status === 200 && valid, http: r.status };
  } catch (err) {
    result.tenderkart = { ok: false, error: String(err).slice(0, 160) };
  }

  result.overall = result.database.ok && result.kppp.ok ? 'healthy' : 'attention';
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
