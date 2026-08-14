'use strict';

(() => {
  const CACHE_KEY = 'kppp_missing_financial_tenderkart_v1';
  const SUCCESS_TTL = 24 * 60 * 60 * 1000;
  const MISS_TTL = 6 * 60 * 60 * 1000;
  const MAX_CONCURRENT = 6;
  let active = 0;
  const queue = [];
  const pendingRefs = new Set();

  function loadCache(){
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveCache(){
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
  }
  const cache = loadCache();

  function numeric(value){
    const n = Number(String(value ?? '').replace(/[₹,]/g, '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function money(value){
    return '₹' + Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  function missing(value){
    const t = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t || ['—','-','n/a','na','not available','refer tender','refer document','refer documents'].includes(t)) return true;
    return /^₹?\s*0(?:\.0+)?$/.test(t);
  }
  function rowRef(row){
    return String(row.querySelector('.t-title + .muted')?.textContent || '').trim();
  }
  function cached(ref){
    const item = cache[ref];
    if (!item) return null;
    const ttl = item.found ? SUCCESS_TTL : MISS_TTL;
    if (Date.now() - Number(item.saved_at || 0) > ttl) {
      delete cache[ref];
      saveCache();
      return null;
    }
    return item;
  }
  function remember(ref, result){
    cache[ref] = { ...result, saved_at: Date.now() };
    saveCache();
    return cache[ref];
  }

  function updateTenderState(ref, field, value){
    if (!numeric(value)) return;
    try {
      const tender = Array.isArray(state?.all)
        ? state.all.find(t => String(t?.ref_no || t?.id || '').trim() === ref)
        : null;
      if (tender) tender[field] = Number(value);
    } catch {}
  }

  function replaceDisplayedNumber(cell, value){
    if (!cell || !numeric(value)) return;
    const display = money(value);
    if (String(cell.textContent || '').includes(display)) return;
    let target = cell.querySelector('strong')?.firstChild || cell.firstChild;
    if (target && target.nodeType === Node.TEXT_NODE) {
      target.nodeValue = display;
    } else {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      target = walker.nextNode();
      if (target) target.nodeValue = display;
      else cell.appendChild(document.createTextNode(display));
    }
    cell.dataset.secondaryFinancial = 'tenderkart';
    cell.title = 'Recovered from an exact verified TenderKart match';
  }

  function applyResult(task, result){
    if (!task?.row?.isConnected || !result?.found) return;
    if (task.needAmount && missing(task.amountCell?.textContent) && numeric(result.amount)) {
      replaceDisplayedNumber(task.amountCell, result.amount);
      updateTenderState(task.ref, 'amount', result.amount);
    }
    if (task.needEmd && missing(task.emdCell?.textContent) && numeric(result.emd)) {
      replaceDisplayedNumber(task.emdCell, result.emd);
      updateTenderState(task.ref, 'emd', result.emd);
    }
  }

  async function lookup(task){
    try {
      const params = new URLSearchParams({ tender: task.ref, source: 'tenderkart' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      let response;
      try {
        response = await fetch('/api/public_tender_detail?' + params.toString(), { cache: 'no-store', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const payload = response.ok ? await response.json() : null;
      const source = Array.isArray(payload?.sources)
        ? payload.sources.find(x => String(x?.source || '').toLowerCase() === 'tenderkart')
        : null;
      const signals = source?.signals || {};
      const result = remember(task.ref, {
        found: Boolean(source && (numeric(signals.tender_value) || numeric(signals.emd))),
        amount: numeric(signals.tender_value),
        emd: numeric(signals.emd),
        tender_fee: numeric(signals.tender_fee),
        url: source?.url || null,
        match_method: source?.match_method || null
      });
      applyResult(task, result);
    } catch {
      remember(task.ref, { found: false, amount: null, emd: null, tender_fee: null, url: null });
    } finally {
      pendingRefs.delete(task.ref);
      active--;
      pump();
    }
  }

  function pump(){
    while (active < MAX_CONCURRENT && queue.length) {
      const task = queue.shift();
      if (!task?.row?.isConnected) {
        pendingRefs.delete(task?.ref);
        continue;
      }
      active++;
      lookup(task);
    }
  }

  function processRows(){
    const body = document.getElementById('tableBody');
    if (!body) return;
    const rows = [...body.querySelectorAll('tr')];
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 6 || row.dataset.missingFinancialChecked === '1') continue;
      const ref = rowRef(row);
      if (!ref) continue;
      const amountCell = cells[4];
      const emdCell = cells[5];
      const needAmount = missing(amountCell.textContent);
      const needEmd = missing(emdCell.textContent);
      row.dataset.missingFinancialChecked = '1';
      if (!needAmount && !needEmd) continue;

      const task = { ref, row, amountCell, emdCell, needAmount, needEmd };
      const hit = cached(ref);
      if (hit) {
        applyResult(task, hit);
        continue;
      }
      if (pendingRefs.has(ref)) continue;
      pendingRefs.add(ref);
      queue.push(task);
    }
    pump();
  }

  let timer = null;
  function schedule(){
    clearTimeout(timer);
    timer = setTimeout(processRows, 40);
  }

  const tableBody = document.getElementById('tableBody');
  if(tableBody){
    new MutationObserver(schedule).observe(tableBody, { childList: true });
  }
  window.addEventListener('load', schedule);
  ['categoryFilter','cityFilter','deptFilter','sortFilter','searchInput'].forEach(id => {
    const el=document.getElementById(id);
    if(el) el.addEventListener(id==='searchInput'?'input':'change', schedule);
  });
  schedule();
})();
