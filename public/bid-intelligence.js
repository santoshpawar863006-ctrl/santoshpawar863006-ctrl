'use strict';

(() => {
  const PROFILE_KEY = 'kppp_bid_profile_v1';
  const DEFAULT_PROFILE = {
    minValue: '',
    maxValue: '',
    maxEmd: '',
    minDays: '5',
    category: 'ALL',
    city: 'ALL',
    department: 'ALL'
  };

  const readProfile = () => {
    try { return {...DEFAULT_PROFILE, ...JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}')}; }
    catch { return {...DEFAULT_PROFILE}; }
  };
  const saveProfile = (p) => {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
  };
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const n = (v) => {
    if(v === null || v === undefined) return null;
    const s = String(v).replace(/[₹,]/g,'').trim();
    if(!s || s.toUpperCase()==='N/A') return null;
    const x = Number(s); return Number.isFinite(x) && x > 0 ? x : null;
  };
  const moneyFmt = (v) => n(v) === null ? 'Not available' : '₹' + n(v).toLocaleString('en-IN',{maximumFractionDigits:2});
  const dateVal = (v) => { try { return parseDate(v); } catch { const d=new Date(v); return Number.isNaN(d.getTime())?null:d; } };
  const keyOf = (t) => { try { return tenderKey(t); } catch { return String(t?.id || t?.ref_no || ''); } };
  const daysLeft = (v) => { const d=dateVal(v); if(!d) return null; return Math.ceil((d.getTime()-Date.now())/86400000); };

  function profileNumber(v){
    if(v === '' || v === null || v === undefined) return null;
    const x=Number(v); return Number.isFinite(x) && x >= 0 ? x : null;
  }

  function scoreTender(t, profile){
    const amount=n(t.amount), emd=n(t.emd), days=daysLeft(t.closing_date);
    const minValue=profileNumber(profile.minValue), maxValue=profileNumber(profile.maxValue), maxEmd=profileNumber(profile.maxEmd);
    const minDays=Math.max(0, Number(profile.minDays || 5));
    const parts=[];
    let score=0;

    // Time readiness: 25 points.
    let timeScore=0, timeText='Closing date unavailable';
    if(days === null){ timeScore=10; }
    else if(days < 0){ timeScore=0; timeText='Closing date has passed'; }
    else if(days < 3){ timeScore=4; timeText=`Only ${days} day${days===1?'':'s'} left`; }
    else if(days < minDays){ timeScore=9; timeText=`${days} days left, below your ${minDays}-day preparation target`; }
    else if(days < minDays + 5){ timeScore=18; timeText=`${days} days left`; }
    else { timeScore=25; timeText=`${days} days left — comfortable preparation window`; }
    score += timeScore; parts.push({label:'Preparation time',score:timeScore,max:25,text:timeText});

    // EMD burden: 25 points.
    let emdScore=12, emdText='EMD/value relationship unavailable';
    if(emd !== null && maxEmd !== null){
      if(emd <= maxEmd){ emdScore=25; emdText=`EMD ${moneyFmt(emd)} is within your limit`; }
      else { emdScore=4; emdText=`EMD ${moneyFmt(emd)} exceeds your ${moneyFmt(maxEmd)} limit`; }
    } else if(emd !== null && amount !== null){
      const pct=(emd/amount)*100;
      if(pct <= 1){ emdScore=25; }
      else if(pct <= 2){ emdScore=22; }
      else if(pct <= 3){ emdScore=17; }
      else if(pct <= 5){ emdScore=10; }
      else { emdScore=4; }
      emdText=`EMD is ${pct.toFixed(2)}% of tender value`;
    } else if(emd !== null){
      emdScore=16; emdText=`EMD is ${moneyFmt(emd)}; tender value unavailable`;
    }
    score += emdScore; parts.push({label:'EMD burden',score:emdScore,max:25,text:emdText});

    // Value fit: 20 points.
    let valueScore=12, valueText=amount===null?'Tender value unavailable':'No value range set in Bid Profile';
    if(amount !== null && (minValue !== null || maxValue !== null)){
      const lowOK=minValue===null || amount>=minValue;
      const highOK=maxValue===null || amount<=maxValue;
      if(lowOK && highOK){ valueScore=20; valueText=`${moneyFmt(amount)} is within your value range`; }
      else { valueScore=5; valueText=`${moneyFmt(amount)} is outside your preferred value range`; }
    } else if(amount !== null){ valueScore=14; }
    score += valueScore; parts.push({label:'Tender value fit',score:valueScore,max:20,text:valueText});

    // Preference fit: 25 points.
    let prefScore=0; const prefNotes=[];
    const cat=String(t.category||'').toUpperCase();
    const city=String(t.derived_city||t.district||t.city||'').trim();
    const dept=String(t.department||'').trim();
    if(profile.category==='ALL'){ prefScore+=7; prefNotes.push('Category preference not restricted'); }
    else if(cat===profile.category){ prefScore+=10; prefNotes.push('Matches preferred category'); }
    else prefNotes.push('Outside preferred category');
    if(profile.city==='ALL'){ prefScore+=7; prefNotes.push('City preference not restricted'); }
    else if(city===profile.city){ prefScore+=10; prefNotes.push('Matches preferred city/district'); }
    else prefNotes.push('Outside preferred city/district');
    if(profile.department==='ALL'){ prefScore+=3; }
    else if(dept===profile.department){ prefScore+=5; prefNotes.push('Matches preferred department'); }
    else prefNotes.push('Outside preferred department');
    score += prefScore; parts.push({label:'Preference fit',score:prefScore,max:25,text:prefNotes.join(' • ')});

    // Data quality: 5 points.
    let dataScore=0; const known=[];
    if(amount!==null){dataScore+=2;known.push('value');}
    if(emd!==null){dataScore+=1;known.push('EMD');}
    if(days!==null){dataScore+=1;known.push('closing date');}
    if(t.department){dataScore+=1;known.push('department');}
    score += dataScore; parts.push({label:'Data completeness',score:dataScore,max:5,text:`Known: ${known.length?known.join(', '):'limited public data'}`});

    score=Math.max(0,Math.min(100,Math.round(score)));
    let label='Caution', tone='low';
    if(score>=75){label='Strong candidate for review';tone='high';}
    else if(score>=55){label='Review carefully';tone='mid';}

    return {score,label,tone,parts,amount,emd,days};
  }

  function similarity(a,b){
    if(!a||!b||keyOf(a)===keyOf(b)) return -1;
    let s=0;
    if(String(a.category||'')===String(b.category||'')) s+=30;
    if(String(a.department||'') && String(a.department||'')===String(b.department||'')) s+=25;
    if(String(a.derived_city||'') && String(a.derived_city||'')===String(b.derived_city||'')) s+=25;
    const av=n(a.amount), bv=n(b.amount);
    if(av!==null&&bv!==null){
      const ratio=Math.min(av,bv)/Math.max(av,bv);
      s+=Math.round(ratio*20);
    }
    return s;
  }

  function similarTenders(t, limit=5){
    if(typeof state==='undefined'||!Array.isArray(state.all)) return [];
    return state.all.map(x=>({t:x,s:similarity(t,x)})).filter(x=>x.s>=35).sort((a,b)=>b.s-a.s).slice(0,limit);
  }

  function opportunityContext(t){
    const all=Array.isArray(state.all)?state.all:[];
    const cat=String(t.category||'');
    const city=String(t.derived_city||'');
    const dept=String(t.department||'');
    const sameCat=all.filter(x=>String(x.category||'')===cat);
    const sameCity=all.filter(x=>city && String(x.derived_city||'')===city);
    const sameDept=all.filter(x=>dept && String(x.department||'')===dept);
    const vals=sameDept.map(x=>n(x.amount)).filter(x=>x!==null).sort((a,b)=>a-b);
    const median=vals.length ? (vals.length%2?vals[(vals.length-1)/2]:(vals[vals.length/2-1]+vals[vals.length/2])/2) : null;
    const deptSoon=sameDept.filter(x=>{const d=daysLeft(x.closing_date);return d!==null&&d>=0&&d<=7;}).length;
    return {sameCat:sameCat.length,sameCity:sameCity.length,sameDept:sameDept.length,median,deptSoon};
  }

  function ensureProfilePanel(){
    if(document.getElementById('bidProfilePanel')) return;
    const toolbar=document.getElementById('analysisToolbar');
    if(!toolbar) return;
    const p=readProfile();
    toolbar.insertAdjacentHTML('beforeend', `
      <div class="bid-profile-panel" id="bidProfilePanel" hidden>
        <div class="bid-profile-head"><div><strong>My Bid Profile</strong><span>Stored only in this browser</span></div><button id="bidProfileClose" type="button">×</button></div>
        <div class="bid-profile-grid">
          <label>Min Tender Value ₹<input id="bpMinValue" type="number" min="0" step="1000" value="${e(p.minValue)}"></label>
          <label>Max Tender Value ₹<input id="bpMaxValue" type="number" min="0" step="1000" value="${e(p.maxValue)}"></label>
          <label>Max EMD ₹<input id="bpMaxEmd" type="number" min="0" step="1000" value="${e(p.maxEmd)}"></label>
          <label>Minimum Preparation Days<input id="bpMinDays" type="number" min="0" max="60" value="${e(p.minDays)}"></label>
          <label>Preferred Category<select id="bpCategory"><option value="ALL">All categories</option><option value="WORKS">WORKS</option><option value="GOODS">GOODS</option><option value="SERVICES">SERVICES</option></select></label>
          <label>Preferred City / District<select id="bpCity"><option value="ALL">All cities / districts</option></select></label>
          <label>Preferred Department<select id="bpDepartment"><option value="ALL">All departments</option></select></label>
        </div>
        <div class="bid-profile-actions"><button id="bidProfileSave" type="button">Save Bid Profile</button><button id="bidProfileReset" type="button" class="secondary">Reset</button></div>
      </div>`);
    const cities=[...new Set(state.all.map(x=>x.derived_city).filter(x=>x&&x!=='Other / Unspecified'))].sort();
    const depts=[...new Set(state.all.map(x=>String(x.department||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    const cityEl=document.getElementById('bpCity'), deptEl=document.getElementById('bpDepartment');
    if(cityEl) cityEl.innerHTML='<option value="ALL">All cities / districts</option>'+cities.map(x=>`<option value="${e(x)}">${e(x)}</option>`).join('');
    if(deptEl) deptEl.innerHTML='<option value="ALL">All departments</option>'+depts.map(x=>`<option value="${e(x)}">${e(x)}</option>`).join('');
    document.getElementById('bpCategory').value=p.category||'ALL';
    if(cityEl && [...cityEl.options].some(o=>o.value===p.city)) cityEl.value=p.city;
    if(deptEl && [...deptEl.options].some(o=>o.value===p.department)) deptEl.value=p.department;
    document.getElementById('bidProfileClose')?.addEventListener('click',()=>{document.getElementById('bidProfilePanel').hidden=true;});
    document.getElementById('bidProfileSave')?.addEventListener('click',()=>{
      saveProfile({
        minValue:document.getElementById('bpMinValue').value,
        maxValue:document.getElementById('bpMaxValue').value,
        maxEmd:document.getElementById('bpMaxEmd').value,
        minDays:document.getElementById('bpMinDays').value||'5',
        category:document.getElementById('bpCategory').value,
        city:document.getElementById('bpCity').value,
        department:document.getElementById('bpDepartment').value
      });
      document.getElementById('bidProfilePanel').hidden=true;
      const body=document.getElementById('modalBody');
      const current=body?.dataset?.bidKey;
      if(current) appendBidIntelligence(current,true);
    });
    document.getElementById('bidProfileReset')?.addEventListener('click',()=>{saveProfile(DEFAULT_PROFILE);document.getElementById('bidProfilePanel').remove();ensureProfilePanel();document.getElementById('bidProfilePanel').hidden=false;});
  }

  function injectProfileButton(){
    const actions=document.querySelector('#analysisToolbar .analysis-actions');
    if(!actions||document.getElementById('bidProfileBtn')) return;
    const b=document.createElement('button');
    b.id='bidProfileBtn'; b.type='button'; b.className='analysis-btn'; b.textContent='⚙ Bid Profile';
    actions.prepend(b);
    b.addEventListener('click',()=>{ensureProfilePanel();const p=document.getElementById('bidProfilePanel');if(p)p.hidden=!p.hidden;});
  }

  function injectRowButtons(){
    const body=document.getElementById('tableBody'); if(!body) return;
    body.querySelectorAll('tr').forEach(row=>{
      const detail=row.querySelector('[data-detail]'); if(!detail) return;
      const key=decodeURIComponent(detail.dataset.detail||''); if(!key) return;
      const cell=detail.closest('td'); if(!cell||cell.querySelector('.bid-check-btn')) return;
      const btn=document.createElement('button');
      btn.type='button'; btn.className='bid-check-btn'; btn.dataset.bidKey=encodeURIComponent(key); btn.textContent='◎ Bid Check';
      cell.classList.add('action-cell-tools'); cell.appendChild(btn);
    });
  }

  function appendBidIntelligence(key, replace=false){
    const body=document.getElementById('modalBody'); if(!body) return;
    const t=state.all.find(x=>keyOf(x)===key); if(!t) return;
    body.dataset.bidKey=key;
    if(replace) body.querySelector('.bid-intelligence')?.remove();
    if(body.querySelector('.bid-intelligence')) return;
    const result=scoreTender(t,readProfile());
    const ctx=opportunityContext(t);
    const sims=similarTenders(t);
    const emdPct=result.amount!==null&&result.emd!==null?((result.emd/result.amount)*100).toFixed(2)+'%':'Not available';

    body.insertAdjacentHTML('afterbegin', `
      <section class="detail-section bid-intelligence">
        <div class="bid-intel-head">
          <div><h3>Should I Bid? — Readiness Check</h3><p>Decision support from public tender data and your Bid Profile. Profitability and eligibility are not automatically verified.</p></div>
          <div class="bid-score ${e(result.tone)}"><strong>${result.score}</strong><span>/100</span><small>${e(result.label)}</small></div>
        </div>
        <div class="bid-summary-grid">
          <div><span>Tender Value</span><strong>${e(moneyFmt(result.amount))}</strong></div>
          <div><span>EMD</span><strong>${e(moneyFmt(result.emd))}</strong></div>
          <div><span>EMD / Value</span><strong>${e(emdPct)}</strong></div>
          <div><span>Days Left</span><strong>${result.days===null?'Not available':result.days<0?'Closed':e(result.days+' days')}</strong></div>
        </div>
        <div class="bid-score-parts">${result.parts.map(p=>`<div><div class="bid-part-top"><strong>${e(p.label)}</strong><span>${p.score}/${p.max}</span></div><div class="bid-mini-track"><i style="width:${Math.round(p.score/p.max*100)}%"></i></div><p>${e(p.text)}</p></div>`).join('')}</div>
        <div class="bid-manual-checks"><strong>Before bidding, manually verify:</strong><span>Eligibility/class/license</span><span>BOQ & quantities</span><span>Site conditions</span><span>Material/labour cost</span><span>Taxes & escalation</span><span>Working capital</span></div>
        <div class="opportunity-context">
          <h4>Current KPPP Opportunity Context</h4>
          <div class="opportunity-grid">
            <div><span>Same Category</span><strong>${ctx.sameCat.toLocaleString('en-IN')}</strong></div>
            <div><span>Same City / District</span><strong>${ctx.sameCity.toLocaleString('en-IN')}</strong></div>
            <div><span>Same Department</span><strong>${ctx.sameDept.toLocaleString('en-IN')}</strong></div>
            <div><span>Dept. Median Value</span><strong>${e(moneyFmt(ctx.median))}</strong></div>
            <div><span>Dept. Closing ≤ 7 Days</span><strong>${ctx.deptSoon.toLocaleString('en-IN')}</strong></div>
          </div>
        </div>
        <div class="similar-tenders">
          <div class="section-title"><h4>Similar Live Tenders</h4><span>${sims.length} matches</span></div>
          ${sims.length?`<div class="similar-list">${sims.map(({t:x,s})=>`<button type="button" data-open-similar="${encodeURIComponent(keyOf(x))}"><span><strong>${e(x.title||'Tender')}</strong><small>${e(x.ref_no||x.id||'')} • ${e(x.derived_city||x.location||'')} • ${e(moneyFmt(x.amount))}</small></span><b>${s}% match</b></button>`).join('')}</div>`:'<div class="empty-block">No close live matches found in the current KPPP dataset.</div>'}
        </div>
      </section>`);
  }

  const originalOpenDetails=window.openDetails;
  if(typeof originalOpenDetails==='function'){
    window.openDetails=async function(key){
      await originalOpenDetails(key);
      appendBidIntelligence(key);
    };
  }

  document.addEventListener('click', async ev=>{
    const bid=ev.target.closest('[data-bid-key]');
    if(bid){
      const key=decodeURIComponent(bid.dataset.bidKey||'');
      if(key){ await window.openDetails(key); setTimeout(()=>document.querySelector('.bid-intelligence')?.scrollIntoView({behavior:'smooth',block:'start'}),50); }
      return;
    }
    const sim=ev.target.closest('[data-open-similar]');
    if(sim){
      const key=decodeURIComponent(sim.dataset.openSimilar||'');
      if(key) await window.openDetails(key);
    }
  });

  let tries=0;
  const timer=setInterval(()=>{
    tries++;
    injectProfileButton(); injectRowButtons();
    if((document.getElementById('analysisToolbar') && state?.all?.length) || tries>120) clearInterval(timer);
  },100);

  new MutationObserver(()=>{injectRowButtons();injectProfileButton();}).observe(document.documentElement,{childList:true,subtree:true});
})();
