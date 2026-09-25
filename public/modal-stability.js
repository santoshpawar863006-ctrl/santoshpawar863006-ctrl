'use strict';

(() => {
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
  // TenderKart blocks automated lookups with a bot check, so link out and let the
  // contractor's own browser open the search instead of fetching it server-side.
  function tenderKartSearchUrl(t){
    const ref=String(t?.ref_no||t?.id||'').trim();
    return 'https://www.google.com/search?q='+encodeURIComponent(`site:tenderkart.in "${ref}"`);
  }

  function installSourceButtons(){
    const close=document.getElementById('modalClose');
    if(!close || document.getElementById('sourceSearchButtons')) return;
    const wrap=document.createElement('div');
    wrap.id='sourceSearchButtons';
    wrap.className='source-search-buttons';
    wrap.innerHTML=`<a class="source-search-btn tenderkart" id="tenderKartSearchLink" href="#" target="_blank" rel="noopener noreferrer" title="Opens a search for this tender number on TenderKart in a new tab">Search on TenderKart ↗</a>`;
    close.parentElement?.insertBefore(wrap,close);
  }

  function updateSourceLink(t){
    const link=document.getElementById('tenderKartSearchLink');
    if(link) link.href=tenderKartSearchUrl(t);
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

  function wrapOpenDetails(){
    if(window.__stableModalController || typeof window.openDetails!=='function') return false;
    const base=window.openDetails;
    window.openDetails=async function(key){
      currentKey=String(key||'');
      const result=await base(key);
      const t=tenderForKey(currentKey);
      if(t){
        renderReadiness(t);
        updateSourceLink(t);
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
