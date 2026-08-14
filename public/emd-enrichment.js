'use strict';

(() => {
  const CACHE_KEY = 'kppp_secondary_financial_cache_v2';
  const FAIL_TTL = 6 * 60 * 60 * 1000;
  const SUCCESS_TTL = 24 * 60 * 60 * 1000;
  const MAX_CONCURRENT = 2;
  let active = 0;
  const queue = [];

  function loadCache(){
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveCache(cache){
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
  }
  const cache = loadCache();

  function numeric(value){
    const n = Number(String(value ?? '').replace(/[₹,]/g,'').trim());
    return Number.isFinite(n) ? n : null;
  }
  function hasValidMoney(value){
    const n = numeric(value);
    return n !== null && n > 0;
  }
  function isMissingText(value){
    const t=String(value||'').replace(/\s+/g,' ').trim().toLowerCase();
    if(!t || t==='—' || t==='-' || t==='not available' || t==='refer tender') return true;
    return /^₹?\s*0(?:\.0+)?$/.test(t);
  }
  function cleanRef(value){ return String(value || '').trim(); }
  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }
  function formatMoney(value){
    return '₹' + Number(value).toLocaleString('en-IN',{maximumFractionDigits:2});
  }

  function cachedResult(ref){
    const item=cache[ref];
    if(!item) return null;
    const ttl=item.success ? SUCCESS_TTL : FAIL_TTL;
    if(Date.now()-item.saved_at>ttl){
      delete cache[ref]; saveCache(cache); return null;
    }
    return item;
  }

  function normalizeField(field){
    if(!field || !hasValidMoney(field.value)) return null;
    return {
      value:Number(field.value),
      source:field.source?String(field.source):'External',
      url:field.url?String(field.url):null,
      estimated:Boolean(field.estimated),
    };
  }

  function remember(ref,payload){
    const fields=payload?.fields || {};
    const item={
      success:Boolean(payload?.success),
      amount:normalizeField(fields.amount || (hasValidMoney(payload?.amount)?{value:payload.amount,source:payload.source,url:payload.url}:null)),
      emd:normalizeField(fields.emd || (hasValidMoney(payload?.emd)?{value:payload.emd,source:payload.source,url:payload.url}:null)),
      tender_fee:normalizeField(fields.tender_fee || (hasValidMoney(payload?.tender_fee)?{value:payload.tender_fee,source:payload.source,url:payload.url}:null)),
      saved_at:Date.now(),
    };
    item.success=Boolean(item.amount || item.emd || item.tender_fee);
    cache[ref]=item; saveCache(cache); return item;
  }

  function sourceLink(field){
    const label=`🟠 Secondary · ${escapeHtml(field.source || 'External')}`;
    if(!field.url) return `<span class="secondary-fin-source">${label}</span>`;
    const safe=String(field.url).replace(/"/g,'%22');
    return `<a class="secondary-fin-source" href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function renderSecondary(cell,field,type){
    if(!cell || !field) return;
    const estimate=type==='amount' && field.estimated ? '<span class="secondary-estimate">Estimated by secondary source</span>' : '';
    cell.innerHTML=`<strong>${formatMoney(field.value)}</strong>${estimate}<br>${sourceLink(field)}`;
    cell.dataset.secondaryFilled='1';
  }
  function renderUnavailable(cell,label='KPPP'){
    if(!cell) return;
    cell.innerHTML=`<span class="zero-unavailable">Not available</span><span class="mini-source primary">${label}</span>`;
  }
  function renderChecking(cell){
    if(!cell) return;
    cell.innerHTML='<span class="emd-checking">Checking secondary…</span>';
  }

  function originalValueFromTender(ref,field){
    try{
      if(!window.state || !Array.isArray(window.state.all)) return null;
      const tender=window.state.all.find(t=>String(t.ref_no||t.id||'').trim()===ref);
      return tender ? tender[field] : null;
    }catch{return null;}
  }

  function needsLookupForRow(amountCell,emdCell,ref){
    const amountOriginal=originalValueFromTender(ref,'amount');
    const emdOriginal=originalValueFromTender(ref,'emd');
    return {
      amount: hasValidMoney(amountOriginal) ? false : isMissingText(amountCell?.textContent),
      emd: hasValidMoney(emdOriginal) ? false : isMissingText(emdCell?.textContent),
      fee:true,
    };
  }

  function applyRowResult(task,result){
    const {amountCell,emdCell,needs}=task;
    if(needs.amount){
      if(result.amount) renderSecondary(amountCell,result.amount,'amount');
      else renderUnavailable(amountCell);
    }
    if(needs.emd){
      if(result.emd) renderSecondary(emdCell,result.emd,'emd');
      else renderUnavailable(emdCell);
    }
  }

  async function doLookup(task){
    try{
      const r=await fetch('/api/secondary_emd?tender='+encodeURIComponent(task.ref),{cache:'no-store'});
      const payload=r.ok?await r.json():{success:false};
      applyRowResult(task,remember(task.ref,payload));
    }catch{
      applyRowResult(task,remember(task.ref,{success:false}));
    }finally{ active--; pump(); }
  }
  function pump(){
    while(active<MAX_CONCURRENT && queue.length){
      const task=queue.shift();
      if(!task || !document.body.contains(task.row)) continue;
      active++; doLookup(task);
    }
  }
  function enqueue(task){
    if(!task.ref || !task.row || task.row.dataset.finQueued==='1') return;
    task.row.dataset.finQueued='1';
    const existing=cachedResult(task.ref);
    if(existing){ applyRowResult(task,existing); return; }
    if(task.needs.amount) renderChecking(task.amountCell);
    if(task.needs.emd) renderChecking(task.emdCell);
    queue.push(task); pump();
  }

  function processRows(){
    const tbody=document.getElementById('tableBody'); if(!tbody) return;
    for(const row of tbody.querySelectorAll('tr')){
      const cells=row.querySelectorAll('td'); if(cells.length<6) continue;
      const amountCell=cells[4], emdCell=cells[5];
      const ref=cleanRef(row.querySelector('.t-title + .muted')?.textContent || '');
      if(!ref) continue;

      if(isMissingText(amountCell.textContent)) renderUnavailable(amountCell);
      if(isMissingText(emdCell.textContent)) renderUnavailable(emdCell);

      const needs=needsLookupForRow(amountCell,emdCell,ref);
      if(needs.amount || needs.emd) enqueue({ref,row,amountCell,emdCell,needs});
    }
  }

  function currentModalRef(){
    const sub=document.getElementById('modalSub')?.textContent || '';
    const parts=sub.split('•').map(s=>s.trim()).filter(Boolean);
    return parts.length>=2?parts[1]:'';
  }

  function modalMetricMap(){
    const map={};
    document.querySelectorAll('#modalBody .metric').forEach(metric=>{
      const label=(metric.querySelector('span')?.textContent||'').trim().toUpperCase();
      if(label.includes('ESTIMATED')) map.amount=metric;
      else if(label==='EMD') map.emd=metric;
      else if(label.includes('TENDER FEE')) map.tender_fee=metric;
    });
    return map;
  }

  async function enrichModal(){
    const ref=currentModalRef(); if(!ref) return;
    const metrics=modalMetricMap(); if(!metrics.amount && !metrics.emd && !metrics.tender_fee) return;
    const needed={};
    for(const [field,metric] of Object.entries(metrics)){
      const strong=metric.querySelector('strong');
      needed[field]=Boolean(strong && isMissingText(strong.textContent));
      if(needed[field]) strong.textContent='Checking secondary…';
    }
    if(!Object.values(needed).some(Boolean)) return;

    let result=cachedResult(ref);
    if(!result){
      try{
        const r=await fetch('/api/secondary_emd?tender='+encodeURIComponent(ref),{cache:'no-store'});
        result=remember(ref,r.ok?await r.json():{success:false});
      }catch{ result=remember(ref,{success:false}); }
    }

    for(const [field,metric] of Object.entries(metrics)){
      if(!needed[field]) continue;
      const strong=metric.querySelector('strong');
      const data=result[field];
      if(data){
        strong.textContent=formatMoney(data.value);
        const badge=document.createElement(data.url?'a':'span');
        badge.className='modal-secondary-source';
        badge.textContent=`🟠 Secondary · ${data.source}` + (field==='amount'&&data.estimated?' · estimated':'');
        if(data.url){badge.href=data.url;badge.target='_blank';badge.rel='noopener noreferrer';}
        metric.appendChild(badge);
      }else strong.textContent='Not available';
    }
  }

  let scheduled=false;
  function schedule(){
    if(scheduled) return; scheduled=true;
    requestAnimationFrame(()=>{scheduled=false;processRows();enrichModal();});
  }

  const observer=new MutationObserver(schedule);
  observer.observe(document.documentElement,{subtree:true,childList:true});
  window.addEventListener('load',schedule);
  schedule();
})();