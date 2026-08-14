'use strict';

(() => {
  let organizeTimer = null;

  function $(id){ return document.getElementById(id); }

  function setTab(name){
    const tab = String(name || 'enrichment');
    document.querySelectorAll('.detail-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.detail-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === tab);
    });
  }

  function bindTabs(){
    const nav = $('detailTabs');
    if (!nav || nav.dataset.bound === '1') return;
    nav.dataset.bound = '1';
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      setTab(btn.dataset.tab);
    });
  }

  function sectionTitle(section){
    return String(section.querySelector('.section-title h3, .bid-intel-head h3, .bc-head h3, .tk-primary-head h3')?.textContent || '').trim().toLowerCase();
  }

  function isOverview(section){
    if (section.classList.contains('detail-overview')) return true;
    const title = sectionTitle(section);
    return title === 'overview' || title.startsWith('overview');
  }

  function toAccordion(section, open = false){
    if (section.tagName === 'DETAILS' || section.classList.contains('detail-accordion')) return section;
    const titleEl = section.querySelector('.section-title h3, h3, h4');
    const title = titleEl ? titleEl.textContent.trim() : 'Details';
    const chip = section.querySelector('.section-title .source-chip, .section-title .count-chip');
    const details = document.createElement('details');
    details.className = ('detail-accordion ' + (section.className || '')).replace(/\bdetail-section\b/g, '').trim();
    details.open = open;
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = title;
    summary.appendChild(label);
    if (chip) summary.appendChild(chip.cloneNode(true));
    const body = document.createElement('div');
    body.className = 'detail-accordion-body';
    [...section.childNodes].forEach((node) => {
      if (node.nodeType === 1 && node.classList?.contains('section-title')) return;
      body.appendChild(node);
    });
    details.appendChild(summary);
    details.appendChild(body);
    section.replaceWith(details);
    return details;
  }

  function updateEmptyHints(){
    const summaryHas = Boolean($('summaryReadinessHost')?.children.length || $('summaryOverviewHost')?.children.length);
    const enrichHas = Boolean($('tenderKartPrimaryHost')?.children.length || $('enrichmentExtraHost')?.children.length);
    const bidHas = Boolean($('bidCalculatorPanel') || $('bidPanelHost')?.querySelector('.bid-calculator-panel'));
    const summaryHint = $('summaryEmptyHint');
    const enrichHint = $('enrichmentEmptyHint');
    const bidHint = $('bidEmptyHint');
    if (summaryHint) summaryHint.hidden = summaryHas;
    if (enrichHint) enrichHint.hidden = enrichHas;
    if (bidHint) bidHint.hidden = bidHas;
  }

  function organize(){
    const body = $('modalBody');
    const summaryHost = $('summaryOverviewHost');
    const readinessHost = $('summaryReadinessHost');
    const enrichExtra = $('enrichmentExtraHost');
    const bidHost = $('bidPanelHost');
    if (!body || !summaryHost) return;

    body.querySelectorAll('.stable-readiness, .bid-intelligence').forEach((el) => {
      if (readinessHost && el.parentElement !== readinessHost) readinessHost.appendChild(el);
    });

    body.querySelectorAll('.tk-primary-section, .public-web-section').forEach((el) => {
      if (enrichExtra && el.parentElement !== enrichExtra) enrichExtra.appendChild(el);
    });

    const bid = $('bidCalculatorPanel');
    if (bid && bidHost && bid.parentElement !== bidHost) bidHost.appendChild(bid);

    // Keep status banners with the overview summary
    body.querySelectorAll(':scope > .live-banner').forEach((banner) => {
      summaryHost.prepend(banner);
    });

    const sections = [...body.querySelectorAll(':scope > .detail-section, :scope > details.detail-accordion')];
    let overviewPlaced = [...summaryHost.children].some((el) => el.classList?.contains('detail-overview') || isOverview(el));
    sections.forEach((section, idx) => {
      if (!overviewPlaced && isOverview(section)) {
        // Keep only one overview in summary
        [...summaryHost.querySelectorAll('.detail-overview')].forEach((old) => old.remove());
        summaryHost.appendChild(section);
        overviewPlaced = true;
        return;
      }
      toAccordion(section, idx < 2);
    });

    body.querySelectorAll('.detail-section').forEach((section) => {
      if (summaryHost.contains(section) || readinessHost?.contains(section) || bidHost?.contains(section) || enrichExtra?.contains(section)) return;
      toAccordion(section, false);
    });

    updateEmptyHints();
  }

  function scheduleOrganize(){
    clearTimeout(organizeTimer);
    organizeTimer = setTimeout(organize, 60);
  }

  function wrapOpenDetails(){
    if (window.__detailLayoutWrapped || typeof window.openDetails !== 'function') return false;
    const base = window.openDetails;
    window.openDetails = async function(key){
      setTab('enrichment');
      ['summaryOverviewHost','summaryReadinessHost','enrichmentExtraHost','bidPanelHost','modalBody'].forEach((id) => {
        const el = $(id); if (el) el.innerHTML = '';
      });
      const host = $('tenderKartPrimaryHost');
      if (host) { host.innerHTML = ''; delete host.dataset.tenderRef; }
      updateEmptyHints();
      const result = await base(key);
      scheduleOrganize();
      setTimeout(scheduleOrganize, 200);
      setTimeout(scheduleOrganize, 700);
      setTimeout(scheduleOrganize, 1400);
      return result;
    };
    window.__detailLayoutWrapped = true;
    return true;
  }

  bindTabs();
  const modal = $('detailModal');
  if (modal) {
    const observer = new MutationObserver(scheduleOrganize);
    observer.observe(modal, { childList: true, subtree: true });
  }

  if (!wrapOpenDetails()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (wrapOpenDetails() || tries > 60) clearInterval(timer);
    }, 100);
  }

  window.KPPPDetailLayout = { setTab, organize, scheduleOrganize };
})();
