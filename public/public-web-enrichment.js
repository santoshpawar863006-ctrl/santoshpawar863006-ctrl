'use strict';

(() => {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const cache = new Map();
  const inflight = new Map();
  let autoTimer = null;

  const money = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? '₹' + n.toLocaleString('en-IN', {maximumFractionDigits:2}) : 'Refer tender';
  };
  const dateText = (value) => {
    if(!value) return 'Not available';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('en-IN', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  };
  const val = (v, fallback='Not available') => (v === null || v === undefined || v === '') ? fallback : String(v);

  function currentTender(){
    try{
      const sub = document.getElementById('modalSub')?.textContent || '';
      const parts = sub.split('•').map(x => x.trim()).filter(Boolean);
      const ref = parts.length >= 2 ? parts[1] : '';
      if(!ref || typeof state === 'undefined' || !Array.isArray(state.all)) return null;
      return state.all.find(t => String(t.ref_no || t.id || '').trim() === ref) || null;
    }catch{
      return null;
    }
  }

  function sourceName(source){
    const s = String(source || '').toLowerCase();
    if(s === 'tenderkart') return 'TenderKart';
    if(s === 'bidassist') return 'BidAssist';
    if(s === 'tendersplus') return 'TendersPlus';
    return source || 'Public source';
  }

  function installButtons(){
    const close = document.getElementById('modalClose');
    if(!close || document.getElementById('sourceSearchButtons')) return;
    document.getElementById('publicWebDetailBtn')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'sourceSearchButtons';
    wrap.className = 'source-search-buttons';
    wrap.innerHTML = `
      <button type="button" class="source-search-btn tenderkart" data-public-source="tenderkart" title="Load verified TenderKart details">TenderKart</button>
      <button type="button" class="source-search-btn bidassist" data-public-source="bidassist" title="Search BidAssist public data">BidAssist</button>
      <button type="button" class="source-search-btn tendersplus" data-public-source="tendersplus" title="Search TendersPlus public data">TendersPlus</button>`;
    close.parentElement?.insertBefore(wrap, close);

    wrap.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-public-source]');
      if(!btn) return;
      const tender = currentTender();
      if(!tender) return;
      const source = btn.dataset.publicSource;
      await manualSearch(tender, source, btn);
    });
  }

  function paramsFor(tender, source){
    return new URLSearchParams({
      tender: String(tender.ref_no || tender.id || '').trim(),
      title: String(tender.title || ''),
      department: String(tender.department || ''),
      location: String(tender.location || tender.derived_city || tender.district || ''),
      source
    });
  }

  async function fetchSource(tender, source){
    const ref = String(tender.ref_no || tender.id || '').trim();
    if(!ref) return {success:false, sources:[]};
    const key = `${source}|${ref}`;
    if(cache.has(key)) return cache.get(key);
    if(inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      try{
        const r = await fetch('/api/public_tender_detail?' + paramsFor(tender, source).toString(), {cache:'no-store'});
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = await r.json();
        if(!payload?.success) throw new Error(payload?.message || 'Search failed');
        cache.set(key, payload);
        return payload;
      }catch(err){
        const payload = {success:false, sources:[], message:err?.message || 'Search failed'};
        cache.set(key, payload);
        return payload;
      }finally{
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  function firstSource(payload, expected){
    const wanted = sourceName(expected).toLowerCase();
    return (Array.isArray(payload?.sources) ? payload.sources : []).find(x => String(x?.source || '').toLowerCase() === wanted) || null;
  }

  function metric(label, value){
    return `<div class="tk-metric"><span>${e(label)}</span><strong>${e(value)}</strong></div>`;
  }

  function detailRows(rows){
    const filtered = rows.filter(([,v]) => v !== null && v !== undefined && v !== '' && v !== 'Not available');
    if(!filtered.length) return '';
    return `<div class="tk-detail-grid">${filtered.map(([k,v]) => `<div class="tk-detail-cell"><span>${e(k)}</span><strong>${e(v)}</strong></div>`).join('')}</div>`;
  }

  function numberedTable(title, items, secondTitle='Requirement'){
    if(!Array.isArray(items) || !items.length) return '';
    return `<section class="tk-subsection">
      <div class="tk-subhead"><h4>${e(title)}</h4><span>${items.length}</span></div>
      <div class="tk-table-wrap"><table class="tk-table"><thead><tr><th>#</th><th>${e(secondTitle)}</th></tr></thead><tbody>
        ${items.map((item,i)=>`<tr><td>${i+1}</td><td>${e(item)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`;
  }

  function boqTable(items){
    if(!Array.isArray(items) || !items.length) return '';
    return `<section class="tk-subsection">
      <div class="tk-subhead"><h4>BOQ / Work Item Preview</h4><span>${items.length} lines</span></div>
      <div class="tk-table-wrap"><table class="tk-table boq"><thead><tr><th>Item</th><th>Description</th></tr></thead><tbody>
        ${items.map((item,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td>${e(item)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`;
  }

  function renderTenderKartPrimary(tender, source){
    const body = document.getElementById('modalBody');
    if(!body || !source) return;
    body.querySelector('.tk-primary-section')?.remove();
    const s = source.signals || {};
    const safeUrl = String(source.url || '').startsWith('http') ? source.url : '#';
    const tenderRef = String(tender.ref_no || tender.id || '');

    const html = `<section class="detail-section tk-primary-section">
      <div class="tk-primary-head">
        <div>
          <div class="tk-eyebrow">VIEW DETAILS • TENDERKART ENRICHMENT</div>
          <h3>Tender Details</h3>
          <p>Verified against the KPPP tender reference. KPPP data remains available below for cross-checking.</p>
        </div>
        <a href="${e(safeUrl)}" target="_blank" rel="noopener noreferrer" class="tk-source-link">Open TenderKart ↗</a>
      </div>

      <div class="tk-metric-grid">
        ${metric('Tender Value', money(s.tender_value))}
        ${metric('EMD', money(s.emd))}
        ${metric('Tender Fee', money(s.tender_fee))}
        ${metric('Tender Class', val(s.tender_class))}
        ${metric('Reservation', val(s.reservation))}
        ${metric('KPWD / PWD Class', val(s.kpwd_class))}
      </div>

      <section class="tk-subsection">
        <div class="tk-subhead"><h4>Tender Summary</h4></div>
        ${detailRows([
          ['Tender Number', tenderRef],
          ['NIT ID', s.nit_id],
          ['Tender Category', s.tender_category || tender.category],
          ['Product Category', s.product_category],
          ['Form of Contract', s.form_of_contract],
          ['Bid Value Type', s.bid_value_type],
          ['Denomination', s.denomination_type],
          ['Tax Type', s.tax_type],
          ['Location', s.location || tender.location || tender.derived_city]
        ])}
        ${s.work_description ? `<div class="tk-description"><span>Work Description</span><p>${e(s.work_description)}</p></div>` : ''}
      </section>

      <section class="tk-subsection">
        <div class="tk-subhead"><h4>Important Dates & Bid Conditions</h4></div>
        ${detailRows([
          ['Published', dateText(s.published_date)],
          ['Bid Submission End', dateText(s.closing_date)],
          ['Bid Opening', dateText(s.bid_opening_date)],
          ['Document Download End', dateText(s.download_end_date)],
          ['Bid Validity', s.bid_validity_days ? `${s.bid_validity_days} days` : null]
        ])}
      </section>

      ${(s.contact_person || s.mobile_number) ? `<section class="tk-subsection"><div class="tk-subhead"><h4>Contact Details</h4></div>${detailRows([
        ['Contact Person', s.contact_person], ['Contact Number', s.mobile_number]
      ])}</section>` : ''}

      ${numberedTable('Mandatory Documents / Certificates', s.documents_required, 'Document / Certificate')}
      ${numberedTable('Technical Criteria', s.technical_criteria, 'Technical Requirement')}
      ${numberedTable('Eligibility Conditions', s.eligibility, 'Eligibility Requirement')}
      ${numberedTable('Tender Document Files', s.tender_documents, 'File')}
      ${boqTable(s.boq_preview)}

      <div class="tk-source-foot">Source: <strong>TenderKart</strong> • ${e(source.match_method || 'verified tender match')} • Data is used for enrichment and should be cross-checked with KPPP before bidding.</div>
    </section>`;

    body.insertAdjacentHTML('afterbegin', html);
  }

  function manualSignalGrid(source){
    const s = source.signals || {};
    const rows = [
      ['Tender Value', s.tender_value ? money(s.tender_value) : null],
      ['EMD', s.emd ? money(s.emd) : null],
      ['Tender Fee', s.tender_fee ? money(s.tender_fee) : null],
      ['Tender Class', s.tender_class],
      ['Reservation', s.reservation],
      ['KPWD / PWD Class', s.kpwd_class],
      ['Published', s.published_date ? dateText(s.published_date) : null],
      ['Closing', s.closing_date ? dateText(s.closing_date) : null],
      ['Bid Opening', s.bid_opening_date ? dateText(s.bid_opening_date) : null],
      ['Location', s.location]
    ].filter(([,v])=>v);
    return rows.length ? `<div class="public-signal-grid">${rows.map(([k,v])=>`<div><span>${e(k)}</span><strong>${e(v)}</strong></div>`).join('')}</div>` : '<div class="public-no-signals">Verified page found, but no additional structured fields were publicly extractable.</div>';
  }

  function renderManualResult(tender, sourceKey, payload){
    const body = document.getElementById('modalBody');
    if(!body) return;
    const className = `manual-source-${sourceKey}`;
    body.querySelector('.' + className)?.remove();
    const display = sourceName(sourceKey);
    const source = firstSource(payload, sourceKey);

    if(!source){
      body.insertAdjacentHTML('beforeend', `<section class="detail-section public-web-section ${className}">
        <div class="section-title"><h3>${e(display)} Search</h3><span class="count-chip">No verified match</span></div>
        <div class="empty-block">No verified public ${e(display)} page was found for this exact tender right now. The TenderKart/KPPP details above are unchanged.</div>
      </section>`);
      body.querySelector('.' + className)?.scrollIntoView({behavior:'smooth',block:'start'});
      return;
    }

    const s = source.signals || {};
    const safeUrl = String(source.url || '').startsWith('http') ? source.url : '#';
    body.insertAdjacentHTML('beforeend', `<section class="detail-section public-web-section ${className}">
      <div class="section-title"><h3>${e(display)} Public Data</h3><span class="count-chip">Verified match</span></div>
      <div class="public-source-card">
        <div class="public-source-head"><div><strong>${e(source.title || display)}</strong><small>${e(source.match_method || 'verified match')}</small></div><a href="${e(safeUrl)}" target="_blank" rel="noopener noreferrer">Open ${e(display)} ↗</a></div>
        ${manualSignalGrid(source)}
        ${Array.isArray(s.documents_required) && s.documents_required.length ? numberedTable('Documents / Certificates', s.documents_required) : ''}
        ${Array.isArray(s.eligibility) && s.eligibility.length ? numberedTable('Eligibility', s.eligibility) : ''}
        ${Array.isArray(s.boq_preview) && s.boq_preview.length ? boqTable(s.boq_preview) : ''}
      </div>
    </section>`);
    body.querySelector('.' + className)?.scrollIntoView({behavior:'smooth',block:'start'});
  }

  async function manualSearch(tender, sourceKey, btn){
    const display = sourceName(sourceKey);
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = `${display}…`;
    const payload = await fetchSource(tender, sourceKey);
    btn.disabled = false;
    btn.textContent = old;

    if(sourceKey === 'tenderkart'){
      const source = firstSource(payload, 'tenderkart');
      if(source){
        renderTenderKartPrimary(tender, source);
        document.querySelector('.tk-primary-section')?.scrollIntoView({behavior:'smooth',block:'start'});
      }else{
        renderManualResult(tender, sourceKey, payload);
      }
      return;
    }
    renderManualResult(tender, sourceKey, payload);
  }

  async function ensureTenderKartPrimary(){
    const modal = document.getElementById('detailModal');
    const body = document.getElementById('modalBody');
    if(!modal?.classList.contains('open') || !body) return;
    const tender = currentTender();
    if(!tender) return;
    const ref = String(tender.ref_no || tender.id || '').trim();
    if(!ref) return;

    const key = `tenderkart|${ref}`;
    if(cache.has(key)){
      const source = firstSource(cache.get(key), 'tenderkart');
      if(source && !body.querySelector('.tk-primary-section')) renderTenderKartPrimary(tender, source);
      return;
    }
    if(inflight.has(key)) return;
    const payload = await fetchSource(tender, 'tenderkart');
    const source = firstSource(payload, 'tenderkart');
    if(source && modal.classList.contains('open') && currentTender() === tender){
      renderTenderKartPrimary(tender, source);
    }
  }

  function scheduleAuto(){
    clearTimeout(autoTimer);
    autoTimer = setTimeout(ensureTenderKartPrimary, 220);
  }

  function startObserver(){
    const body = document.getElementById('modalBody');
    if(!body) return;
    const observer = new MutationObserver(() => {
      if(document.getElementById('detailModal')?.classList.contains('open')) scheduleAuto();
    });
    observer.observe(body, {childList:true, subtree:false});

    document.addEventListener('click', (event) => {
      if(event.target.closest('[data-detail]')) scheduleAuto();
    }, true);
  }

  function init(){
    installButtons();
    startObserver();
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
