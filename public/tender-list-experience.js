'use strict';

(() => {
  function decode(value){
    try { return decodeURIComponent(value || ''); }
    catch { return String(value || ''); }
  }

  function compareButtonFor(key){
    return [...document.querySelectorAll('[data-compare-key]')]
      .find(btn => decode(btn.dataset.compareKey) === key) || null;
  }

  function updateDetailCompareState(key){
    const toggle = document.getElementById('detailCompareToggle');
    const open = document.getElementById('detailOpenCompare');
    if (!toggle || !open) return;
    const hiddenButton = compareButtonFor(key);
    const selected = Boolean(hiddenButton?.classList.contains('selected'));
    toggle.textContent = selected ? '✓ Added to Compare' : '＋ Add to Compare';
    toggle.classList.toggle('selected', selected);
    const count = Number(document.getElementById('compareCount')?.textContent || 0);
    open.hidden = count < 1;
  }

  function ensureDetailActions(key){
    const head = document.querySelector('#detailModal .modal-head');
    const titleBlock = head?.querySelector(':scope > div:first-child');
    if (!head || !titleBlock || !key) return;

    let bar = document.getElementById('detailQuickActions');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'detailQuickActions';
      bar.className = 'detail-quick-actions';
      bar.innerHTML = `
        <button type="button" id="detailCompareToggle">＋ Add to Compare</button>
        <button type="button" id="detailOpenCompare" class="secondary" hidden>⇄ Open Comparison</button>`;
      titleBlock.appendChild(bar);

      document.getElementById('detailCompareToggle')?.addEventListener('click', () => {
        const current = bar.dataset.tenderKey || '';
        const hiddenButton = compareButtonFor(current);
        if (hiddenButton) hiddenButton.click();
        setTimeout(() => updateDetailCompareState(current), 0);
      });
      document.getElementById('detailOpenCompare')?.addEventListener('click', () => {
        document.getElementById('compareSelectedBtn')?.click();
      });
    }

    bar.dataset.tenderKey = key;
    setTimeout(() => updateDetailCompareState(key), 0);
    setTimeout(() => updateDetailCompareState(key), 160);
  }

  function stabilizePlanner(){
    const panel = document.getElementById('analyticsPanel');
    const planner = document.getElementById('bidCostPlanner');
    if (!panel || !planner) return;
    if (planner.parentElement === panel) panel.insertAdjacentElement('afterend', planner);
    if (planner.hidden !== panel.hidden) planner.hidden = panel.hidden;
  }

  function wrapDetails(){
    if (window.__kpppStableDetailWrapped || typeof window.openDetails !== 'function') return false;
    const base = window.openDetails;
    window.openDetails = async function(key){
      const result = await base(key);
      ensureDetailActions(String(key || ''));
      return result;
    };
    window.__kpppStableDetailWrapped = true;
    return true;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    wrapDetails();
    stabilizePlanner();
    if (attempts > 80) clearInterval(timer);
  }, 100);

  document.addEventListener('click', event => {
    if (event.target?.id === 'analyticsToggle') {
      setTimeout(stabilizePlanner, 80);
      setTimeout(stabilizePlanner, 180);
    }
  });

  wrapDetails();
})();
