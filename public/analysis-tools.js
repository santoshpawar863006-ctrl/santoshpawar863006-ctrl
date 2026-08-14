'use strict';

(() => {
  const COMPARE_KEY = 'kppp_compare_tenders_v1';
  const MAX_COMPARE = 4;
  const selected = new Set(readJSON(COMPARE_KEY, []));
  let analyticsOpen = false;

  function readJSON(key, fallback){
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  }
  function saveJSON(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function e(value){
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }
  function keyOf(t){
    try { return tenderKey(t); }
    catch { return String(t?.id || t?.ref_no || ''); }
  }
  function numberOf(v){
    try { return num(v); }
    catch {
      const n=Number(String(v??'').replace(/[₹,]/g,'').trim());
      return Number.isFinite(n)?n:null;
    }
  }
  function dateOf(v){
    try { return parseDate(v); }
    catch { const d=new Date(v); return Number.isNaN(d.getTime())?null:d; }
  }
  function moneyOf(v, fallback='—'){
    const n=numberOf(v);
    return n===null ? fallback : '₹'+n.toLocaleString('en-IN',{maximumFractionDigits:2});
  }
  function daysLeft(v){
    const d=dateOf(v); if(!d) return null;
    return Math.ceil((d.getTime()-Date.now())/86400000);
  }
  function validSelected(){
    const available=new Set(state.all.map(keyOf));
    let changed=false;
    [...selected].forEach(k=>{ if(!available.has(k)){ selected.delete(k); changed=true; } });
    if(changed) persistSelected();
  }
  function persistSelected(){ saveJSON(COMPARE_KEY,[...selected]); }

  function injectToolbar(){
    if(document.getElementById('analysisToolbar')) return;
    const results=document.getElementById('resultsPanel');
    if(!results) return;
    results.insertAdjacentHTML('beforebegin', `
      <section class="analysis-tools" id="analysisToolbar">
        <div class="analysis-tools-main">
          <div>
            <strong>Tender Analysis Tools</strong>
            <span>Analyze the current filtered tender list</span>
          </div>
          <div class="analysis-actions">
            <button id="analyticsToggle" class="analysis-btn" type="button">▦ Analytics</button>
            <button id="exportFilteredBtn" class="analysis-btn" type="button">⇩ Export Excel / CSV</button>
            <button id="compareSelectedBtn" class="analysis-btn primary" type="button">⇄ Compare <span id="compareCount">0</span></button>
          </div>
        </div>
        <div class="analysis-panel" id="analyticsPanel" hidden></div>
        <div class="analysis-message" id="analysisMessage" aria-live="polite"></div>
      </section>
    `);

    document.getElementById('analyticsToggle')?.addEventListener('click',()=>{
      analyticsOpen=!analyticsOpen;
      const panel=document.getElementById('analyticsPanel');
      if(panel){ panel.hidden=!analyticsOpen; if(analyticsOpen) renderAnalytics(); }
      document.getElementById('analyticsToggle')?.classList.toggle('active',analyticsOpen);
    });
    document.getElementById('exportFilteredBtn')?.addEventListener('click',exportFiltered);
    document.getElementById('compareSelectedBtn')?.addEventListener('click',openCompare);
  }

  function message(text, kind='info'){
    const el=document.getElementById('analysisMessage'); if(!el) return;
    el.textContent=text; el.className='analysis-message show '+kind;
    clearTimeout(message.timer);
    message.timer=setTimeout(()=>{ el.className='analysis-message'; el.textContent=''; },2600);
  }

  function updateCompareUI(){
    validSelected();
    const count=document.getElementById('compareCount'); if(count) count.textContent=selected.size;
    document.querySelectorAll('[data-compare-key]').forEach(btn=>{
      const key=decodeURIComponent(btn.dataset.compareKey||'');
      const on=selected.has(key);
      btn.classList.toggle('selected',on);
      btn.textContent=on?'✓ Compare':'＋ Compare';
      btn.setAttribute('aria-pressed',on?'true':'false');
    });
  }

  function injectRowCompareButtons(){
    const body=document.getElementById('tableBody'); if(!body) return;
    body.querySelectorAll('tr').forEach(row=>{
      const detail=row.querySelector('[data-detail]'); if(!detail) return;
      const key=decodeURIComponent(detail.dataset.detail||''); if(!key) return;
      const cell=detail.closest('td'); if(!cell || cell.querySelector('.row-compare-btn')) return;
      const btn=document.createElement('button');
      btn.type='button'; btn.className='row-compare-btn';
      btn.dataset.compareKey=encodeURIComponent(key);
      cell.classList.add('action-cell-tools');
      cell.appendChild(btn);
    });
    updateCompareUI();
  }

  function toggleCompare(key){
    if(selected.has(key)) selected.delete(key);
    else {
      if(selected.size>=MAX_COMPARE){ message(`You can compare up to ${MAX_COMPARE} tenders at a time.`,'warning'); return; }
      selected.add(key);
    }
    persistSelected(); updateCompareUI();
  }

  function csvCell(value){
    const s=String(value??'').replace(/\r?\n/g,' ').trim();
    return '"'+s.replace(/"/g,'""')+'"';
  }

  function exportFiltered(){
    const rows=Array.isArray(state.filtered)?state.filtered:[];
    if(!rows.length){ message('No tenders are available in the current filtered list.','warning'); return; }
    const headers=['Tender Number','Category','Title','Department','City / District','Location','Tender Value','EMD','Tender Fee','Published Date','Closing Date','Status'];
    const lines=[headers.map(csvCell).join(',')];
    rows.forEach(t=>{
      lines.push([
        t.ref_no||t.id||'', t.category||'', t.title||'', t.department||'', t.derived_city||t.district||t.city||'', t.location||'',
        numberOf(t.amount)??'', numberOf(t.emd)??'', numberOf(t.fee)??'', t.published_date||'', t.closing_date||'', t.status_text||t.status||''
      ].map(csvCell).join(','));
    });
    const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const stamp=new Date().toISOString().slice(0,10);
    a.href=url; a.download=`karnataka-tenders-${stamp}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    message(`Exported ${rows.length.toLocaleString('en-IN')} filtered tenders.`,'success');
  }

  function groupCounts(rows, getter, limit=6){
    const map=new Map();
    rows.forEach(t=>{
      const key=String(getter(t)||'Other / Unspecified').trim()||'Other / Unspecified';
      map.set(key,(map.get(key)||0)+1);
    });
    return [...map.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit);
  }

  function median(values){
    if(!values.length) return null;
    const a=[...values].sort((x,y)=>x-y), m=Math.floor(a.length/2);
    return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }

  function barList(entries,total){
    if(!entries.length) return '<div class="analysis-empty">No data available.</div>';
    return `<div class="analysis-bars">${entries.map(([label,count])=>{
      const pct=total?Math.max(2,(count/total)*100):0;
      return `<div class="analysis-bar-row"><div class="analysis-bar-label"><span>${e(label)}</span><strong>${count.toLocaleString('en-IN')}</strong></div><div class="analysis-track"><i style="width:${pct.toFixed(1)}%"></i></div></div>`;
    }).join('')}</div>`;
  }

  function renderAnalytics(){
    const panel=document.getElementById('analyticsPanel'); if(!panel) return;
    const rows=Array.isArray(state.filtered)?state.filtered:[];
    const values=rows.map(t=>numberOf(t.amount)).filter(v=>v!==null&&v>=0);
    const emds=rows.map(t=>numberOf(t.emd)).filter(v=>v!==null&&v>=0);
    const totalValue=values.reduce((a,b)=>a+b,0);
    const avgValue=values.length?totalValue/values.length:null;
    const medValue=median(values);
    const soon3=rows.filter(t=>{const d=daysLeft(t.closing_date);return d!==null&&d>=0&&d<=3;}).length;
    const soon7=rows.filter(t=>{const d=daysLeft(t.closing_date);return d!==null&&d>=0&&d<=7;}).length;

    const departments=groupCounts(rows,t=>t.department,6);
    const cities=groupCounts(rows,t=>t.derived_city||t.district||t.city,6);

    const valueBands=[['Below ₹5 lakh',0],['₹5–25 lakh',0],['₹25 lakh–₹1 crore',0],['₹1–5 crore',0],['Above ₹5 crore',0],['Value unavailable',0]];
    rows.forEach(t=>{
      const v=numberOf(t.amount);
      if(v===null) valueBands[5][1]++;
      else if(v<500000) valueBands[0][1]++;
      else if(v<2500000) valueBands[1][1]++;
      else if(v<10000000) valueBands[2][1]++;
      else if(v<50000000) valueBands[3][1]++;
      else valueBands[4][1]++;
    });

    const closingBands=[['Closing in 0–3 days',0],['Closing in 4–7 days',0],['Closing in 8–15 days',0],['Closing after 15 days',0],['Closing date unavailable / passed',0]];
    rows.forEach(t=>{
      const d=daysLeft(t.closing_date);
      if(d===null||d<0) closingBands[4][1]++;
      else if(d<=3) closingBands[0][1]++;
      else if(d<=7) closingBands[1][1]++;
      else if(d<=15) closingBands[2][1]++;
      else closingBands[3][1]++;
    });

    panel.innerHTML=`
      <div class="analysis-summary-grid">
        <div><span>Filtered Tenders</span><strong>${rows.length.toLocaleString('en-IN')}</strong></div>
        <div><span>Known Tender Value</span><strong>${moneyOf(totalValue,'—')}</strong><small>${values.length.toLocaleString('en-IN')} tenders with value</small></div>
        <div><span>Average Value</span><strong>${moneyOf(avgValue,'—')}</strong></div>
        <div><span>Median Value</span><strong>${moneyOf(medValue,'—')}</strong></div>
        <div><span>Closing ≤ 3 Days</span><strong>${soon3.toLocaleString('en-IN')}</strong></div>
        <div><span>Closing ≤ 7 Days</span><strong>${soon7.toLocaleString('en-IN')}</strong></div>
        <div><span>Value Data Coverage</span><strong>${rows.length?Math.round(values.length/rows.length*100):0}%</strong></div>
        <div><span>EMD Data Coverage</span><strong>${rows.length?Math.round(emds.length/rows.length*100):0}%</strong></div>
      </div>
      <div class="analysis-grid">
        <section><h4>Top Departments</h4>${barList(departments,rows.length)}</section>
        <section><h4>Top Cities / Districts</h4>${barList(cities,rows.length)}</section>
        <section><h4>Tender Value Distribution</h4>${barList(valueBands,rows.length)}</section>
        <section><h4>Closing Timeline</h4>${barList(closingBands,rows.length)}</section>
      </div>`;
  }

  function tenderForKey(key){ return state.all.find(t=>keyOf(t)===key); }

  function ensureCompareModal(){
    if(document.getElementById('compareModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="compare-modal" id="compareModal" aria-hidden="true">
        <div class="compare-card">
          <div class="compare-head"><div><h2>Compare Tenders</h2><p>Side-by-side comparison of up to ${MAX_COMPARE} tenders</p></div><button id="compareClose" class="compare-close" type="button">×</button></div>
          <div class="compare-body" id="compareBody"></div>
        </div>
      </div>`);
    document.getElementById('compareClose')?.addEventListener('click',closeCompare);
    document.getElementById('compareModal')?.addEventListener('click',ev=>{if(ev.target.id==='compareModal') closeCompare();});
  }

  function compareValue(label,t){
    const raw=t.raw||{};
    switch(label){
      case 'Tender': return t.title||'—';
      case 'Tender Number': return t.ref_no||t.id||'—';
      case 'Category': return t.category||'—';
      case 'Department': return t.department||'—';
      case 'City / District': return t.derived_city||t.district||t.city||'—';
      case 'Work Location': return t.location||raw.locationName||'—';
      case 'Tender Value': return moneyOf(t.amount,'—');
      case 'EMD': return moneyOf(t.emd,'—');
      case 'EMD % of Value': {
        const v=numberOf(t.amount), emd=numberOf(t.emd); return v&&emd!==null?((emd/v)*100).toFixed(2)+'%':'—';
      }
      case 'Tender Fee': return moneyOf(t.fee,'—');
      case 'Published': return t.published_date||'—';
      case 'Closing': return t.closing_date||'—';
      case 'Days Left': {const d=daysLeft(t.closing_date); return d===null?'—':d<0?'Closed':`${d} days`;}
      case 'Status': return t.status_text||t.status||'—';
      default:return '—';
    }
  }

  function openCompare(){
    validSelected(); ensureCompareModal();
    const body=document.getElementById('compareBody'); if(!body) return;
    const tenders=[...selected].map(tenderForKey).filter(Boolean);
    if(!tenders.length){ message('Select 2–4 tenders using the Compare buttons in the list.','warning'); return; }
    const fields=['Tender','Tender Number','Category','Department','City / District','Work Location','Tender Value','EMD','EMD % of Value','Tender Fee','Published','Closing','Days Left','Status'];
    body.innerHTML=`
      <div class="compare-toolbar"><span>${tenders.length} tender${tenders.length===1?'':'s'} selected</span><button id="clearCompareBtn" type="button">Clear Selection</button></div>
      <div class="compare-wrap"><table class="compare-table"><thead><tr><th>Field</th>${tenders.map(t=>`<th><button class="compare-remove" data-remove-compare="${encodeURIComponent(keyOf(t))}" title="Remove">×</button>${e(t.ref_no||t.id||'Tender')}</th>`).join('')}</tr></thead><tbody>
      ${fields.map(field=>`<tr><th>${e(field)}</th>${tenders.map(t=>`<td>${e(compareValue(field,t))}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;
    body.querySelectorAll('[data-remove-compare]').forEach(btn=>btn.addEventListener('click',()=>{
      selected.delete(decodeURIComponent(btn.dataset.removeCompare||'')); persistSelected(); updateCompareUI(); openCompare();
    }));
    document.getElementById('clearCompareBtn')?.addEventListener('click',()=>{selected.clear();persistSelected();updateCompareUI();closeCompare();message('Compare selection cleared.','success');});
    const modal=document.getElementById('compareModal'); modal?.classList.add('open'); modal?.setAttribute('aria-hidden','false'); document.body.classList.add('modal-open');
  }
  function closeCompare(){
    const modal=document.getElementById('compareModal'); modal?.classList.remove('open'); modal?.setAttribute('aria-hidden','true');
    if(!document.getElementById('detailModal')?.classList.contains('open')) document.body.classList.remove('modal-open');
  }

  function refreshAll(){
    injectToolbar(); injectRowCompareButtons(); updateCompareUI();
    if(analyticsOpen) renderAnalytics();
  }

  function bind(){
    const tbody=document.getElementById('tableBody');
    tbody?.addEventListener('click',ev=>{
      const btn=ev.target.closest('[data-compare-key]'); if(!btn) return;
      ev.preventDefault(); ev.stopPropagation();
      toggleCompare(decodeURIComponent(btn.dataset.compareKey||''));
    });
    document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&document.getElementById('compareModal')?.classList.contains('open')) closeCompare();});

    const observer=new MutationObserver(()=>requestAnimationFrame(refreshAll));
    if(tbody) observer.observe(tbody,{childList:true,subtree:true});
    const resultCount=document.getElementById('resultCount');
    if(resultCount) observer.observe(resultCount,{childList:true,subtree:true,characterData:true});
  }

  injectToolbar(); bind();
  const ready=setInterval(()=>{
    if(typeof state!=='undefined' && Array.isArray(state.all) && state.all.length){
      clearInterval(ready); refreshAll();
    }
  },200);
})();
