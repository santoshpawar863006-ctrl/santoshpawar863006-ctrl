'use strict';

(() => {
  const AMOUNT_KEYS = [
    'ecv',
    'estimatedContractValue',
    'estimatedAmount',
    'estimatedTenderValue',
    'tenderValue',
    'estimatedCost',
    'provisionalAmount',
    'amount'
  ];

  function positiveNumber(value){
    if(value === null || value === undefined) return null;
    const cleaned = String(value).replace(/[₹,]/g, '').trim();
    if(!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function bestAmount(tender){
    const raw = tender?.raw && typeof tender.raw === 'object' ? tender.raw : {};

    // Prefer a usable value directly from the original KPPP response.
    for(const key of AMOUNT_KEYS){
      const n = positiveNumber(raw[key]);
      if(n !== null) return n;
    }

    const normalized = positiveNumber(tender?.amount);
    return normalized !== null ? normalized : null;
  }

  function formatMoney(value){
    return '₹' + Number(value).toLocaleString('en-IN', {maximumFractionDigits: 2});
  }

  function sanitizeTenderAmounts(){
    if(typeof state === 'undefined' || !Array.isArray(state.all) || !state.all.length) return false;

    let changed = false;

    for(const tender of state.all){
      const recovered = bestAmount(tender);

      if(recovered !== null){
        if(positiveNumber(tender.amount) !== recovered){
          tender.amount = recovered;
          changed = true;
        }
        tender.amount_display = formatMoney(recovered);
      } else {
        // Use a non-numeric marker so the old numeric helper cannot turn an empty value into 0.
        if(tender.amount !== 'N/A') changed = true;
        tender.amount = 'N/A';
        tender.amount_display = 'Refer tender';
      }
    }

    if(changed){
      try { applyFilters(); }
      catch {
        try { render(); } catch {}
      }
    }

    return true;
  }

  function currentTenderFromModal(){
    try {
      const sub = document.getElementById('modalSub')?.textContent || '';
      const parts = sub.split('•').map(s => s.trim()).filter(Boolean);
      const ref = parts.length >= 2 ? parts[1] : '';
      if(!ref || typeof state === 'undefined' || !Array.isArray(state.all)) return null;
      return state.all.find(t => String(t.ref_no || t.id || '').trim() === ref) || null;
    } catch {
      return null;
    }
  }

  function fixVisibleEstimatedAmount(){
    const body = document.getElementById('modalBody');
    if(!body) return;

    const tender = currentTenderFromModal();
    const recovered = tender ? positiveNumber(tender.amount) : null;

    body.querySelectorAll('.metric').forEach(metric => {
      const label = (metric.querySelector('span')?.textContent || '').trim().toLowerCase();
      if(!label.includes('estimated') || !label.includes('value')) return;

      const strong = metric.querySelector('strong');
      if(!strong) return;

      const shown = positiveNumber(strong.textContent);
      if(shown !== null) return;

      const desired = recovered !== null ? formatMoney(recovered) : 'Refer tender';
      // Critical guard: never rewrite identical text. Without this, MutationObserver
      // can observe our own textContent write and repeatedly trigger itself.
      if(String(strong.textContent || '').trim() !== desired){
        strong.textContent = desired;
      }
    });
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const ready = sanitizeTenderAmounts();
    fixVisibleEstimatedAmount();
    if(ready || attempts > 120) clearInterval(timer);
  }, 100);

  const modal = document.getElementById('modalBody');
  if(modal){
    // Child-list changes are enough because View Details replaces/inserts sections.
    // Do not observe characterData; that made normal text changes unnecessarily wake this fixer.
    new MutationObserver(fixVisibleEstimatedAmount).observe(modal, {childList:true, subtree:true});
  }
})();
