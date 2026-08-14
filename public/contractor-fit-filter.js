'use strict';

(() => {
  const FILTER_ID = 'contractorFitFilter';
  const CACHE_KEY = 'kppp_contractor_fit_v1';
  const BATCH_SIZE = 50;
  const MAX_CONCURRENT = 6;
  const GOOD_TTL = 24 * 60 * 60 * 1000;
  const MISS_TTL = 6 * 60 * 60 * 1000;

  let renderWrapped = false;
  let ready = false;
  let scanning = false;
  let scanToken = 0;
  let scopeRefs = [];
  let matchRefs = new Set();
  let lastScopeSize = 0;
  let rescanTimer = null;

  const class3Re = /\bclass\s*[-:/]?\s*(?:iii|3)\b/i;
  const workProofRe = /\bwork\s*[- ]?done\b|\bworkdone\b|\bwork\s+experience\b|\bexperience\s+certificate\b|\bcompletion\s+certificate\b|\bsimilar\s+(?:nature\s+of\s+)?work\b|\bsatisfactorily\s+completed\b|\bcompleted\s+as\s+(?:a\s+)?prime\s+contractor\b|\bexecuted\s+quantit(?:y|ies)\b|\bquantity\s*[- ]?wise\b|\bpast\s+experience\b/i;

  function refOf(t){ return String(t?.ref_no || t?.id || '').trim(); }
  function cacheLoad(){ try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; } }
  const cache = cacheLoad();
  function cacheSave(){ try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {} }
  function cached(ref){
    const item = cache[ref];
    if(!item) return null;
    const ttl = item.verified ? GOOD_TTL : MISS_TTL;
    if(Date.now() - Number(item.saved_at || 0) > ttl){ delete cache[ref]; cacheSave(); return null; }
    return item;
  }
  function remember(ref, item){ cache[ref] = {...item, saved_at: Date.now()}; cacheSave(); return cache[ref]; }

  function status(text, tone=''){
    const el = document.getElementById('contractorFitStatus');
    if(!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
  }

  function installField(){
    if(document.getElementById(FILTER_ID)) return true;
    const grid = document.querySelector('.filter-grid');
    if(!grid) return false;
    const field = document.createElement('div');
    field.className = 'field contractor-fit-field';
    field.innerHTML = `
      <label>CONTRACTOR FIT</label>
      <select id="${FILTER_ID}" title="Verified from available TenderKart qualification data">
        <option value="ALL">All contractor requirements</option>
        <option value="CLASS3_NO_WORK">Class III + No work-done proof found</option>
      </select>
      <small id="contractorFitStatus" style="display:block;margin-top:5px;font-size:10px;line-height:1.25;color:#64748b"></small>
      <button id="contractorFitMore" type="button" style="display:none;margin-top:5px;border:0;background:transparent;padding:0;color:#2563eb;font-size:10px;font-weight:800;cursor:pointer">Scan next 50 →</button>`;
    grid.appendChild(field);

    document.getElementById(FILTER_ID)?.addEventListener('change', async () => {
      if(document.getElementById(FILTER_ID)?.value === 'CLASS3_NO_WORK'){
        ready = false;
        try { applyFilters(); } catch {}
        await scanScope(true);
      } else {
        ready = false; matchRefs.clear(); scopeRefs = [];
        status('');
        const more=document.getElementById('contractorFitMore'); if(more) more.style.display='none';
        try { applyFilters(); } catch {}
      }
    });

    document.getElementById('contractorFitMore')?.addEventListener('click', () => scanScope(false));
    document.getElementById('resetBtn')?.addEventListener('click', () => {
      const select=document.getElementById(FILTER_ID); if(select) select.value='ALL';
      ready=false; matchRefs.clear(); scopeRefs=[]; status('');
      const more=document.getElementById('contractorFitMore'); if(more) more.style.display='none';
    });
    return true;
  }

  function wrapRender(){
    if(renderWrapped || typeof render !== 'function') return false;
    const base = render;
    render = function(){
      const active = document.getElementById(FILTER_ID)?.value === 'CLASS3_NO_WORK';
      if(active && ready && typeof state !== 'undefined' && Array.isArray(state.filtered)){
        state.filtered = state.filtered.filter(t => matchRefs.has(refOf(t)));
      }
      return base();
    };
    renderWrapped = true;
    return true;
  }

  function evidenceFrom(payload){
    const source = Array.isArray(payload?.sources)
      ? payload.sources.find(x => String(x?.source || '').toLowerCase() === 'tenderkart')
      : null;
    if(!source) return {verified:false, match:false, reason:'No verified TenderKart detail'};
    const s = source.signals || {};
    const docs = Array.isArray(s.documents_required) ? s.documents_required : [];
    const tech = Array.isArray(s.technical_criteria) ? s.technical_criteria : [];
    const elig = Array.isArray(s.eligibility) ? s.eligibility : [];
    const combined = [s.kpwd_class, ...docs, ...tech, ...elig].filter(Boolean).join('\n');
    const class3 = class3Re.test(combined);
    const workProof = workProofRe.test(combined);
    const qualificationVisible = docs.length > 0;
    return {
      verified: true,
      match: Boolean(class3 && qualificationVisible && !workProof),
      class3,
      workProof,
      qualificationVisible,
      documents: docs.length,
      source_url: source.url || null,
      reason: !class3 ? 'Class III wording not found' : !qualificationVisible ? 'Mandatory-document list unavailable' : workProof ? 'Previous-work/work-done proof found' : 'Verified match'
    };
  }

  async function verifyTender(tender){
    const ref = refOf(tender);
    const hit = cached(ref);
    if(hit) return hit;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try{
      const params = new URLSearchParams({
        tender: ref,
        title: String(tender.title || ''),
        department: String(tender.department || ''),
        location: String(tender.location || tender.derived_city || tender.district || ''),
        source: 'tenderkart'
      });
      const r = await fetch('/api/public_tender_detail?' + params.toString(), {cache:'no-store', signal:controller.signal});
      if(!r.ok) return remember(ref,{verified:false,match:false,reason:'Lookup failed'});
      const payload = await r.json();
      return remember(ref,evidenceFrom(payload));
    }catch{
      return remember(ref,{verified:false,match:false,reason:'Lookup timed out'});
    }finally{ clearTimeout(timer); }
  }

  async function runPool(items, token){
    let cursor = 0, completed = 0;
    async function worker(){
      while(cursor < items.length && token === scanToken){
        const idx = cursor++;
        const tender = items[idx];
        const result = await verifyTender(tender);
        if(result?.match) matchRefs.add(refOf(tender));
        completed++;
        if(completed === 1 || completed % 5 === 0 || completed === items.length){
          status(`Checking Class III requirements… ${completed}/${items.length} in this batch`);
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(MAX_CONCURRENT,items.length)},worker));
  }

  function knownFromScope(scope){
    matchRefs = new Set();
    let known = 0;
    for(const tender of scope){
      const hit = cached(refOf(tender));
      if(hit){ known++; if(hit.match) matchRefs.add(refOf(tender)); }
    }
    return known;
  }

  async function scanScope(reset){
    if(scanning) scanToken++;
    const token = ++scanToken;
    scanning = true;
    ready = false;

    // At this moment our render wrapper is not filtering, so state.filtered is the
    // result of the normal search/city/department/class/advanced filters.
    try { applyFilters(); } catch {}
    const scope = Array.isArray(state?.filtered)
      ? state.filtered.filter(t => String(t?.category || '').toUpperCase() === 'WORKS')
      : [];
    lastScopeSize = scope.length;
    if(reset) scopeRefs = [];

    const known = knownFromScope(scope);
    const already = new Set(scopeRefs);
    const unchecked = scope.filter(t => !already.has(refOf(t)) && !cached(refOf(t)));
    const batch = unchecked.slice(0,BATCH_SIZE);
    scopeRefs.push(...batch.map(refOf));

    if(!scope.length){
      ready=true; scanning=false; status('No WORKS tenders in the current search scope.');
      try { applyFilters(); } catch {}
      return;
    }

    if(batch.length){
      status(`Checking ${batch.length} tenders against verified qualification data…`);
      await runPool(batch, token);
      if(token !== scanToken) return;
    }

    // Re-read all cached results in the scope so previously checked matches are retained.
    knownFromScope(scope);
    const checked = scope.filter(t => Boolean(cached(refOf(t)))).length;
    ready = true;
    scanning = false;
    try { applyFilters(); } catch {}

    const more = document.getElementById('contractorFitMore');
    const remaining = Math.max(0, scope.length - checked);
    if(more) more.style.display = remaining > 0 ? 'inline-block' : 'none';
    if(remaining > 0){
      status(`${matchRefs.size} verified match${matchRefs.size===1?'':'es'} • ${checked}/${scope.length} checked. Narrow City/Department or scan more.`, 'partial');
    }else{
      status(`${matchRefs.size} verified match${matchRefs.size===1?'':'es'} • all ${scope.length} WORKS tenders in this search checked.`, 'complete');
    }
  }

  function scheduleRescan(){
    if(document.getElementById(FILTER_ID)?.value !== 'CLASS3_NO_WORK') return;
    ready = false;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => scanScope(true), 650);
  }

  function bindScopeChanges(){
    ['searchInput','categoryFilter','cityFilter','deptFilter','sortFilter','tenderClassFilter','valueMin','valueMax','emdMax','publishFrom','publishTo','closingFrom','closingTo']
      .forEach(id => {
        const el=document.getElementById(id); if(!el || el.dataset.contractorFitBound) return;
        el.dataset.contractorFitBound='1';
        el.addEventListener(id==='searchInput'?'input':'change', scheduleRescan, {capture:true});
      });
  }

  function install(){
    const a=installField(); const b=wrapRender(); bindScopeChanges(); return a&&b;
  }

  if(!install()){
    let tries=0;
    const timer=setInterval(()=>{ tries++; if(install()||tries>100) clearInterval(timer); },100);
  } else {
    const timer=setInterval(bindScopeChanges,500); setTimeout(()=>clearInterval(timer),15000);
  }
})();
