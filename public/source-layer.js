'use strict';

(function(){
  const originalMetric = metric;
  const originalInfo = info;
  const originalFallback = renderListingFallback;
  const originalLive = renderLiveDetail;

  function officialTag(){
    return '<span class="field-source">🟢 KPPP ✓ Official</span>';
  }

  metric = function(label,value){
    return `<div class="metric"><span>${esc(label)}</span><strong>${esc(text(value))}</strong>${officialTag()}</div>`;
  };

  info = function(label,value){
    return `<div class="info"><span>${esc(label)}</span><strong>${esc(text(value))}</strong>${officialTag()}</div>`;
  };

  function exactReference(tender){
    return String(tender.ref_no || tender.id || tender.title || '').trim();
  }

  function googleSiteSearch(domain,ref){
    const q = `site:${domain} "${ref}"`;
    return 'https://www.google.com/search?q=' + encodeURIComponent(q);
  }

  function generalWebSearch(tender){
    const ref = exactReference(tender);
    const q = `"${ref}" Karnataka tender EMD tender fee BOQ`;
    return 'https://www.google.com/search?q=' + encodeURIComponent(q);
  }

  function sourceLegend(){
    return `<div class="source-legend">
      <strong>Data source:</strong>
      <span class="source-tag primary">🟢 KPPP ✓ Official / Primary</span>
      <span class="source-tag secondary">🟠 Secondary ↗ External portal</span>
      <span class="source-tag conflict">⚠ Conflict = KPPP stays primary</span>
    </div>`;
  }

  function secondaryPanel(tender){
    const ref = exactReference(tender);
    if(!ref) return '';
    const bidassist = googleSiteSearch('bidassist.com',ref);
    const tenderdetail = googleSiteSearch('tenderdetail.com',ref);
    const web = generalWebSearch(tender);
    return `<section class="detail-section secondary-panel">
      <div class="section-title">
        <h3>Secondary Tender Sources</h3>
        <span class="source-chip secondary">🟠 Secondary data</span>
      </div>
      <p class="secondary-note">
        These searches use the exact tender reference <strong>${esc(ref)}</strong>. Information found here is supplementary only. KPPP remains the primary source, and external values must never silently replace an official KPPP value.
      </p>
      <div class="secondary-links">
        <a class="secondary-link" href="${esc(bidassist)}" target="_blank" rel="noopener noreferrer">
          <span>🔎 BidAssist<small>Search exact tender number</small></span><b>↗</b>
        </a>
        <a class="secondary-link" href="${esc(tenderdetail)}" target="_blank" rel="noopener noreferrer">
          <span>🔎 TenderDetail<small>Search exact tender number</small></span><b>↗</b>
        </a>
        <a class="secondary-link" href="${esc(web)}" target="_blank" rel="noopener noreferrer">
          <span>🌐 Search Web<small>EMD, fee, BOQ & documents</small></span><b>↗</b>
        </a>
      </div>
      <div class="secondary-status">
        🟠 Any EMD, fee, value, date or document found through these links must be shown as <strong>Secondary ↗ + source name</strong>. If it conflicts with KPPP, show both values and mark the difference with ⚠.
      </div>
    </section>`;
  }

  renderListingFallback = function(t,loading=false,message=''){
    return sourceLegend() + originalFallback(t,loading,message) + secondaryPanel(t);
  };

  renderLiveDetail = function(listing,d){
    const html = originalLive(listing,d);
    return sourceLegend() + html + secondaryPanel(listing);
  };
})();