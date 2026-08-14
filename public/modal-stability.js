'use strict';

(() => {
  const sourceCache = new Map();
  const sourceInflight = new Map();
  let currentKey = '';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const positive = (v) => {
    if(v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[₹,]/g,'').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const money = (v, fallback='Not available') => {
    const n = positive(v);
    return n === null ? fallback : '₹' + n.toLocaleString('en-IN',{maximumFractionDigits:2});
  };
  const keyOf = (t) => {
    try { return typeof tenderKey === 'function' ? tenderKey(t) : String(t?.id || t?.ref_no || ''); }
    catch { return String(t?.id || t?.ref_no || ''); }
  };
  const dateOf = (v) => {
    if(!v) return null;
    try { if(typeof parseDate === 'function') return parseDate(v); } catch {}
    const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d;
  };
  const daysLeft = (v) => {
    const d=dateOf(v); return d ? Math.ceil((d.getTime()-Date.now())/86400000) : null;
  };
  const tenderForKey = (key) => {
    try { return Array.isArray(state?.all) ? state.all.find(t => keyOf(t) === key) || null : null; }
    catch { return null; }
  };
  const currentTender = () => tenderForKey(currentKey);
  const sourceName = (s) => ({tenderkart:'TenderKart',bidassist:'BidAssist',tendersplus:'TendersPlus'}[String(s||'').toLowerCase()] || String(s||'Public source'));

  function installSourceButtons(){
    const close=document.getElementById('modalClose');
    if(!close || document.getElementById('sourceSearchButtons')) return;
    const wrap=document.createElement('div');
    wrap.id='sourceSearchButtons';
    wrap.className='source-search-buttons';
    wrap.innerHTML=`
      <button type="button" class="source-search-btn tenderkart" data-stable-source="tenderkart">TenderKart</button>
      <button type="button" class="source-search-btn bidassist" data-stable-source="bidassist">BidAssist</button>
      <button type="button" class="source-search-btn tendersplus" data-stable-source="tendersplus">TendersPlus</button>`;
    close.parentElement?.insertBefore(wrap,close);
    wrap.addEventListener('click', async e => {
      const btn=e.target.closest('[data-stable-source]'); if(!btn) return;
      const tender=currentTender(); if(!tender) return;
      const source=btn.dataset.stableSource;
      const original=sourceName(source);
      btn.disabled=true; btn.textContent=original+'…';
      try{
        const payload=await fetchSource(tender,source);
        if(source==='tenderkart') renderTenderKart(tender,firstSource(payload,'tenderkart'));
        else renderManualSource(tender,source,payload);
      } finally {
        btn.disabled=false; btn.textContent=original;
      }
    });
  }

  function paramsFor(t,source){
    return new URLSearchParams({
      tender:String(t.ref_no||t.id||'').trim(),
      title:String(t.title||''),
      department:String(t.department||''),
      location:String(t.location||t.derived_city||t.district||''),
      source
    });
  }

  async function fetchSource(t,source){
    const ref=String(t.ref_no||t.id||'').trim();
    const cacheKey=source+'|'+ref;
    if(sourceCache.has(cacheKey)) return sourceCache.get(cacheKey);
    if(sourceInflight.has(cacheKey)) return sourceInflight.get(cacheKey);
    const promise=(async()=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),7000);
      try{
        const r=await fetch('/api/public_tender_detail?'+paramsFor(t,source).toString(),{cache:'no-store',signal:controller.signal});
        const data=r.ok ? await r.json() : {success:false,sources:[]};
        sourceCache.set(cacheKey,data);
        return data;
      } catch {
        const data={success:false,sources:[]};
        sourceCache.set(cacheKey,data);
        return data;
      } finally {
        clearTimeout(timer); sourceInflight.delete(cacheKey);
      }
    })();
    sourceInflight.set(cacheKey,promise);
    return promise;
  }

  function firstSource(payload,expected){
    const wanted=String(expected||'').toLowerCase();
    return (Array.isArray(payload?.sources)?payload.sources:[]).find(x=>String(x?.source||'').toLowerCase()===wanted)||null;
  }

  function metric(label,value){ return `<div class="tk-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`; }
  function rows(items){
    const good=items.filter(([,v])=>v!==null&&v!==undefined&&v!==''&&v!=='Not available');
    return good.length?`<div class="tk-detail-grid">${good.map(([k,v])=>`<div class="tk-detail-cell"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`:'';
  }
  function numbered(title,items){
    if(!Array.isArray(items)||!items.length) return '';
    return `<section class="tk-subsection"><div class="tk-subhead"><h4>${esc(title)}</h4><span>${items.length}</span></div><div class="tk-table-wrap"><table class="tk-table"><tbody>${items.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x)}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  function documentLabel(item){
    if(typeof item === 'string') return item;
    if(item && typeof item === 'object'){
      return String(item.label || item.name || item.document_name || item.title || '').trim();
    }
    return String(item || '').trim();
  }

  function tenderDocumentsSection(items, tenderKartUrl){
    if(!Array.isArray(items)||!items.length) return '';
    const safeUrl=String(tenderKartUrl||'').startsWith('http')?tenderKartUrl:'';
    const note = safeUrl
      ? 'File names come from TenderKart’s public data. To download the real PDFs/ZIP, open TenderKart, sign in there, then download.'
      : 'File names are listed below. Open the matched TenderKart page (when available) to sign in and download.';
    const headAction = safeUrl
      ? `<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" class="tk-doc-open-all">Open tender on TenderKart to download ↗</a>`
      : '';
    const rows = items.map((item,i)=>{
      const label=documentLabel(item) || `Document ${i+1}`;
      const action = safeUrl
        ? `<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" class="tk-doc-download">Download on TenderKart ↗</a>`
        : `<span class="tk-doc-unavailable">TenderKart link unavailable</span>`;
      return `<tr><td>${i+1}</td><td><div class="tk-doc-name">${esc(label)}</div><div class="tk-doc-hint">Sign in on TenderKart if prompted</div></td><td class="tk-doc-action">${action}</td></tr>`;
    }).join('');
    return `<section class="tk-subsection tk-docs-section">
      <div class="tk-subhead">
        <div>
          <h4>Tender Document Files</h4>
          <p class="tk-docs-note">${esc(note)}</p>
        </div>
        <div class="tk-docs-head-actions"><span>${items.length}</span>${headAction}</div>
      </div>
      <div class="tk-table-wrap"><table class="tk-table tk-docs-table"><thead><tr><th>#</th><th>Document</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function renderTenderKart(tender,source){
    const host=document.getElementById('tenderKartPrimaryHost');
    if(!host) return;
    const ref=String(tender.ref_no||tender.id||'');
    if(!source){
      if(host.dataset.tenderRef===ref) host.innerHTML='';
      return;
    }
    const s=source.signals||{};
    const safeUrl=String(source.url||'').startsWith('http')?source.url:'#';
    const hasTkUrl=String(source.url||'').startsWith('http');
    host.dataset.tenderRef=ref;
    host.innerHTML=`<section class="detail-section tk-primary-section">
      <div class="tk-primary-head"><div><div class="tk-eyebrow">VERIFIED TENDERKART ENRICHMENT</div><h3>TenderKart Details</h3><p>Loaded once into a separate stable area. KPPP details below are not rebuilt when this section loads.</p></div><a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" class="tk-source-link">Open TenderKart ↗</a></div>
      <div class="tk-metric-grid">${metric('Tender Value',money(s.tender_value))}${metric('EMD',money(s.emd))}${metric('Tender Fee',money(s.tender_fee))}${metric('Tender Class',s.tender_class||'Not available')}${metric('Reservation',s.reservation||'Not available')}${metric('KPWD / PWD Class',s.kpwd_class||'Not available')}</div>
      <section class="tk-subsection"><div class="tk-subhead"><h4>Tender Summary</h4></div>${rows([
        ['Tender Number',ref],['NIT ID',s.nit_id],['Category',s.tender_category||tender.category],['Product Category',s.product_category],['Form of Contract',s.form_of_contract],['Bid Value Type',s.bid_value_type],['Location',s.location||tender.location||tender.derived_city],['Bid Validity',s.bid_validity_days?`${s.bid_validity_days} days`:null]
      ])}${s.work_description?`<div class="tk-description"><span>Work Description</span><p>${esc(s.work_description)}</p></div>`:''}</section>
      ${numbered('Mandatory Documents / Certificates',s.documents_required)}
      ${numbered('Technical Criteria',s.technical_criteria)}
      ${numbered('Eligibility Conditions',s.eligibility)}
      ${tenderDocumentsSection(s.tender_documents, hasTkUrl ? source.url : '')}
      ${numbered('BOQ / Work Item Preview',s.boq_preview)}
      <div class="tk-source-foot">Source: <strong>TenderKart</strong> • ${esc(source.match_method||'verified tender match')} • Cross-check with KPPP before bidding. Document downloads require TenderKart login on their site.</div>
    </section>`;
  }

  function renderManualSource(tender,sourceKey,payload){
    const body=document.getElementById('enrichmentExtraHost') || document.getElementById('modalBody'); if(!body) return;
    const cls='stable-manual-'+sourceKey;
    body.querySelector('.'+cls)?.remove();
    const source=firstSource(payload,sourceKey);
    const display=sourceName(sourceKey);
    if(!source){
      body.insertAdjacentHTML('beforeend',`<section class="detail-section public-web-section ${cls}"><div class="section-title"><h3>${esc(display)} Search</h3><span class="count-chip">No verified match</span></div><div class="empty-block">No verified public ${esc(display)} match was found for this exact tender. Existing KPPP/TenderKart details are unchanged.</div></section>`);
      try { window.KPPPDetailLayout?.scheduleOrganize?.(); } catch {}
      return;
    }
    const s=source.signals||{};
    const safeUrl=String(source.url||'').startsWith('http')?source.url:'#';
    body.insertAdjacentHTML('beforeend',`<section class="detail-section public-web-section ${cls}"><div class="section-title"><h3>${esc(display)} Public Data</h3><span class="count-chip">Verified match</span></div><div class="public-source-card"><div class="public-source-head"><div><strong>${esc(source.title||display)}</strong><small>${esc(source.match_method||'verified match')}</small></div><a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">Open ${esc(display)} ↗</a></div>${rows([['Tender Value',money(s.tender_value)],['EMD',money(s.emd)],['Tender Fee',money(s.tender_fee)],['Tender Class',s.tender_class],['Reservation',s.reservation],['Location',s.location]])}</div></section>`);
    try { window.KPPPDetailLayout?.scheduleOrganize?.(); } catch {}
  }

  function readiness(t){
    const amount=positive(t.amount), emd=positive(t.emd), days=daysLeft(t.closing_date);
    let score=0; const parts=[];
    let time=10;
    if(days!==null){ time=days<0?0:days<3?5:days<7?15:25; }
    score+=time; parts.push(['Preparation time',time,25,days===null?'Closing date unavailable':days<0?'Closed':`${days} days left`]);
    let emdScore=12, emdText='EMD/value relationship unavailable';
    if(emd!==null&&amount!==null){ const p=emd/amount*100; emdScore=p<=1?25:p<=2?22:p<=3?17:p<=5?10:4; emdText=`EMD is ${p.toFixed(2)}% of tender value`; }
    else if(emd!==null){ emdScore=16; emdText=`EMD ${money(emd)}`; }
    score+=emdScore; parts.push(['EMD burden',emdScore,25,emdText]);
    const valueScore=amount!==null?20:10; score+=valueScore; parts.push(['Tender value data',valueScore,20,amount!==null?money(amount):'Value unavailable']);
    const dataScore=(t.department?10:4)+(t.derived_city&&t.derived_city!=='Other / Unspecified'?10:4); score+=dataScore; parts.push(['Department / location data',dataScore,20,`${t.department||'Department unavailable'} • ${t.derived_city||t.location||'Location unavailable'}`]);
    score=Math.min(100,Math.round(score+10));
    const tone=score>=75?'high':score>=55?'mid':'low';
    const label=score>=75?'Strong candidate for review':score>=55?'Review carefully':'Caution';
    return {score,tone,label,parts,amount,emd,days};
  }

  function renderReadiness(t){
    const host=document.getElementById('summaryReadinessHost') || document.getElementById('modalBody');
    if(!host) return;
    host.querySelector('.bid-intelligence')?.remove();
    const r=readiness(t);
    host.insertAdjacentHTML('afterbegin',`<section class="detail-section bid-intelligence stable-readiness">
      <div class="bid-intel-head"><div><h3>Should I Bid? — Readiness Check</h3><p>Lightweight decision support for this tender before you dig into specs and documents.</p></div><div class="bid-score ${r.tone}"><strong>${r.score}</strong><span>/100</span><small>${esc(r.label)}</small></div></div>
      <div class="bid-summary-grid"><div><span>Tender Value</span><strong>${esc(money(r.amount))}</strong></div><div><span>EMD</span><strong>${esc(money(r.emd))}</strong></div><div><span>Days Left</span><strong>${r.days===null?'Not available':r.days<0?'Closed':esc(r.days+' days')}</strong></div><div><span>Location</span><strong>${esc(t.derived_city||t.location||'Not available')}</strong></div></div>
      <div class="bid-score-parts">${r.parts.map(p=>`<div><div class="bid-part-top"><strong>${esc(p[0])}</strong><span>${p[1]}/${p[2]}</span></div><div class="bid-mini-track"><i style="width:${Math.round(p[1]/p[2]*100)}%"></i></div><p>${esc(p[3])}</p></div>`).join('')}</div>
      <div class="bid-manual-checks"><strong>Before bidding, manually verify:</strong><span>Eligibility/class/license</span><span>BOQ & quantities</span><span>Site conditions</span><span>Material/labour cost</span><span>Taxes & escalation</span><span>Working capital</span></div>
    </section>`);
    try { window.KPPPDetailLayout?.scheduleOrganize?.(); } catch {}
  }

  async function loadTenderKartOnce(t,key){
    const payload=await fetchSource(t,'tenderkart');
    if(currentKey!==key || !document.getElementById('detailModal')?.classList.contains('open')) return;
    renderTenderKart(t,firstSource(payload,'tenderkart'));
  }

  function wrapOpenDetails(){
    if(window.__stableModalController || typeof window.openDetails!=='function') return false;
    const base=window.openDetails;
    window.openDetails=async function(key){
      currentKey=String(key||'');
      const host=document.getElementById('tenderKartPrimaryHost');
      if(host){ host.innerHTML=''; delete host.dataset.tenderRef; }
      const result=await base(key);
      const t=tenderForKey(currentKey);
      if(t){
        renderReadiness(t);
        loadTenderKartOnce(t,currentKey);
      }
      return result;
    };
    window.__stableModalController=true;
    return true;
  }

  installSourceButtons();
  if(!wrapOpenDetails()){
    let tries=0;
    const timer=setInterval(()=>{ tries++; installSourceButtons(); if(wrapOpenDetails()||tries>40) clearInterval(timer); },100);
  }
})();
