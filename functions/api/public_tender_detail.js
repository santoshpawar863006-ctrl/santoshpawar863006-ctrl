const TK_BASE = 'https://tenderkart.in';
const SOURCE_DOMAINS = {
  tenderkart: ['TenderKart', 'tenderkart.in'],
  bidassist: ['BidAssist', 'bidassist.com'],
  tendersplus: ['TendersPlus', 'tendersplus.com']
};

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9'
};

function norm(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function asNumber(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}
function listStrings(value, key = null, limit = 20) {
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
function criteriaReservation(text) {
  const low = String(text || '').toLowerCase();
  if (/\bsc\b|scheduled caste/.test(low)) return 'SC';
  if (/\bst\b|scheduled tribe/.test(low)) return 'ST';
  for (const cat of ['2a','2b','3a','3b','cat1','category 1']) if (low.includes(cat)) return cat.toUpperCase().replace('CATEGORY ', 'CAT');
  if (low.includes('reserved category')) return 'Reserved category';
  return null;
}
function extractKpwdClass(text) {
  const m = String(text || '').match(/(?:kpwd|pwd).{0,70}?class\s*[-:]?\s*([ivx0-9]+(?:\s*(?:and|or|&)\s*above)?)/i);
  return m ? m[1].trim() : null;
}
function boqLines(text, limit = 10) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || ['in figures','in figures(rs)','in figures (rs)','total'].includes(line.toLowerCase()) || line.length < 8) continue;
    if (!out.includes(line)) out.push(line.slice(0, 500));
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchWithTimeout(input, init = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('upstream timeout'), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function tenderkartMatchesRef(detail, ref) {
  const rn = norm(ref);
  if (!rn || !detail || typeof detail !== 'object') return false;
  for (const key of ['tender_link','portal_link','tender_id','tender_reference_number']) {
    if (detail[key] && norm(detail[key]).includes(rn)) return true;
  }
  const ext = detail.extended_data || {};
  const raw = ext.raw_html || {};
  if (raw && typeof raw === 'object') {
    for (const value of Object.values(raw)) if (value && norm(value).includes(rn)) return true;
  }
  const kd = ext.karnataka_data || {};
  for (const key of ['tender_number','tender_reference_number','reference_number']) {
    if (kd[key] && norm(kd[key]).includes(rn)) return true;
  }
  return false;
}
function tenderkartSignals(detail) {
  const ext = detail.extended_data || {};
  const kd = ext.karnataka_data || {};
  const work = ext.work_item_details || {};
  const eligibility = listStrings(kd.eligibility_criteria, null, 20);
  const technical = listStrings(kd.technical_criteria, 'description', 20);
  const required = listStrings(kd.required_documents, 'document_name', 20);
  const tenderDocs = [];
  const nit = ext.documents && Array.isArray(ext.documents.nit) ? ext.documents.nit : [];
  for (const item of nit) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    const dtype = String(item.document_type || '').trim();
    if (!name) continue;
    const label = dtype ? `${name} — ${dtype}` : name;
    if (!tenderDocs.includes(label)) tenderDocs.push(label);
    if (tenderDocs.length >= 15) break;
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
    reservation: criteriaReservation(combined),
    kpwd_class: extractKpwdClass(combined),
    eligibility,
    technical_criteria: technical,
    documents_required: required,
    tender_documents: tenderDocs,
    boq_preview: boqLines(kd.boq_text || detail.boq, 10),
    tags: []
  };
  for (const key of Object.keys(signals)) {
    const v = signals[key];
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) delete signals[key];
  }
  signals.tags = [];
  if (eligibility.length) signals.tags.push(`${eligibility.length} eligibility condition(s)`);
  if (technical.length) signals.tags.push(`${technical.length} technical criterion/criteria`);
  if (required.length) signals.tags.push(`${required.length} mandatory document requirement(s)`);
  if (tenderDocs.length) signals.tags.push(`${tenderDocs.length} tender document file(s)`);
  return signals;
}

async function loadTenderKartCandidate(item, ref) {
  try {
    const dr = await fetchWithTimeout(`${TK_BASE}/api/v1/tenders/${encodeURIComponent(item.id)}`, {
      headers: { ...headers, 'Accept':'application/json, text/plain, */*' }
    }, 3500);
    if (!dr.ok) return null;
    const detail = await dr.json();
    if (!tenderkartMatchesRef(detail, ref)) return null;
    return {
      source:'TenderKart',
      title: detail.title || item.row.title || 'TenderKart',
      url:`${TK_BASE}/tender/${item.id}`,
      host:'tenderkart.in',
      official:false,
      match_method:'direct TenderKart public API + exact KPPP reference',
      signals:tenderkartSignals(detail)
    };
  } catch (_) {
    return null;
  }
}

async function getTenderKart(ref, title = '', department = '', lightweight = false) {
  const attempts = [];
  const searches = lightweight
    ? [{ keywords: ref, state: 'Karnataka', limit: '5' }]
    : [
        { keywords: ref, state: 'Karnataka', limit: '6' },
        { keywords: ref, limit: '6' }
      ];
  const seen = new Set();

  for (const params of searches) {
    const u = new URL(TK_BASE + '/api/v1/tenders');
    Object.entries(params).forEach(([k,v]) => u.searchParams.set(k,v));
    let r;
    try {
      r = await fetchWithTimeout(u, {
        headers: { ...headers, 'Accept': 'application/json, text/plain, */*', 'Referer': TK_BASE + '/tenders/filters' }
      }, lightweight ? 2500 : 3500);
    } catch (e) {
      attempts.push({ source:'TenderKart', method:'public API', error:'timeout_or_network_error' });
      continue;
    }
    attempts.push({ source:'TenderKart', method:'public API', http:r.status });
    if (!r.ok) continue;
    let payload;
    try { payload = await r.json(); } catch (_) { continue; }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const ranked = rows.map(row => {
      const id = String(row?.id || '').trim();
      if (!id || seen.has(id)) return null;
      seen.add(id);
      let score = String(row?.portal_name || '').toLowerCase() === 'karnataka' ? 20 : 0;
      if (tenderkartMatchesRef(row, ref)) score += 100;
      if (title && norm(row?.title) === norm(title)) score += 60;
      if (department && norm(`${row?.organisation || ''} ${row?.department || ''}`).includes(norm(department).slice(0,20))) score += 15;
      return { score, id, row };
    }).filter(Boolean).sort((a,b) => b.score-a.score);

    const candidates = ranked.slice(0, lightweight ? 2 : 3);
    if (!candidates.length) continue;

    const results = await Promise.all(candidates.map(item => loadTenderKartCandidate(item, ref)));
    const match = results.find(Boolean);
    if (match) return [match, attempts];
  }
  return [null, attempts];
}

function decodeXml(v) { return String(v || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
async function searchSource(sourceKey, ref, title = '', department = '', location = '') {
  const [sourceName, domain] = SOURCE_DOMAINS[sourceKey];
  const attempts = [];
  const queries = [`"${ref}" ${sourceName}`];
  const words = String(ref).replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (words) queries.push(`"${words}" ${sourceName} Karnataka`);
  if (title) queries.push(`"${title.split(/\s+/).slice(0,11).join(' ')}" ${department} ${location} ${sourceName} Karnataka`);
  for (const q of queries) {
    const u = new URL('https://www.bing.com/search');
    u.searchParams.set('q', q); u.searchParams.set('format','rss'); u.searchParams.set('count','10'); u.searchParams.set('setlang','en-IN');
    let r;
    try { r = await fetchWithTimeout(u, { headers }, 4500); }
    catch (e) { attempts.push({source:sourceName,error:'timeout_or_network_error'}); continue; }
    if (!r.ok) { attempts.push({source:sourceName,http:r.status}); continue; }
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
    let found = 0;
    for (const block of items) {
      const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/i)||[])[1]);
      const t = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]);
      const snippet = decodeXml((block.match(/<description>([\s\S]*?)<\/description>/i)||[])[1]);
      if (!link || !link.toLowerCase().includes(domain)) continue;
      found++;
      const combined = `${link} ${t} ${snippet}`;
      if (!norm(combined).includes(norm(ref))) continue;
      return [{ source:sourceName, title:t || sourceName, url:link, host:domain, official:false, match_method:'public search result + exact tender reference', signals:{} }, [...attempts,{source:sourceName,found}]];
    }
    attempts.push({source:sourceName,found});
  }
  return [null, attempts];
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const ref = (url.searchParams.get('tender') || '').trim();
  const title = (url.searchParams.get('title') || '').trim();
  const department = (url.searchParams.get('department') || '').trim();
  const location = (url.searchParams.get('location') || '').trim();
  let source = (url.searchParams.get('source') || 'all').trim().toLowerCase();
  if (!ref) return json({ success:false, message:'Tender number is required.' }, 400);
  if (!['all','tenderkart','bidassist','tendersplus'].includes(source)) source = 'all';

  const sources = [], attempts = [];
  if (source === 'all' || source === 'tenderkart') {
    const lightweight = !title && !department && !location;
    const [item, a] = await getTenderKart(ref, title, department, lightweight);
    attempts.push(...a);
    if (item) sources.push(item);
  }
  for (const key of ['bidassist','tendersplus']) {
    if (source !== 'all' && source !== key) continue;
    const [item, a] = await searchSource(key, ref, title, department, location); attempts.push(...a); if (item) sources.push(item);
  }
  const priority = { TendersPlus:0, TenderKart:1, BidAssist:2 };
  sources.sort((a,b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9));
  return json({
    success:true,
    tender_ref:ref,
    requested_source:source,
    sources,
    source_count:sources.length,
    attempts,
    note:'TenderKart lookup is bounded for fast Cloudflare responses. BidAssist and TendersPlus use public search results. Locked content is not accessed.'
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'public, max-age=3600',
      'Access-Control-Allow-Origin':'*'
    }
  });
}
