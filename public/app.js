'use strict';

(() => {
  const DATA_URL = '/tenders-lite.json';
  const CACHE_NAME = 'tenderone-data-v1';
  const SAVED_KEY = 'kppp_saved_tenders';
  const THEME_KEY = 'tenderone_theme';
  const PAGE = 30;
  const DAY = 86400000;

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (typeof v === 'number' && v > 0 ? v : null);
  const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');

  // ₹1.18 Cr / ₹25.4 L / ₹2,940 — how contractors read amounts.
  function money(v, { full = false } = {}) {
    const n = num(v);
    if (n === null) return null;
    if (full || n < 100000) return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    if (n >= 10000000) return '₹' + (n / 10000000).toFixed(n >= 1e9 ? 0 : 2).replace(/\.?0+$/, '') + ' Cr';
    return '₹' + (n / 100000).toFixed(1).replace(/\.0$/, '') + ' L';
  }
  const dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const shortDate = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

  function timeLeft(ms) {
    if (!ms) return null;
    const diff = ms - Date.now();
    if (diff <= 0) return { label: 'Closed', tone: 'hot', days: -1 };
    const days = diff / DAY;
    if (days < 1) {
      const h = Math.max(1, Math.round(diff / 3600000));
      return { label: `${h} hr left`, tone: 'hot', days };
    }
    const d = Math.floor(days);
    return { label: `${d} day${d === 1 ? '' : 's'} left`, tone: days <= 3 ? 'hot' : days <= 7 ? 'warm' : '', days };
  }

  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const min = Math.round(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 48) return `${h} hr ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  const S = {
    all: [], filtered: [], shown: 0, generatedAt: null,
    cat: 'ALL', soon: 0, savedOnly: false, q: '',
    saved: new Set(readJSON(SAVED_KEY, [])),
    byId: new Map()
  };

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(readJSON(THEME_KEY, null));

  // ---------- Data ----------
  function prepare(t) {
    t._close = t.closing ? Date.parse(t.closing) : null;
    t._pub = t.published ? Date.parse(t.published) : 0;
    t._hay = [t.title, t.desc, t.ref, t.dept, t.office, t.district, t.work].filter(Boolean).join(' ').toLowerCase();
    return t;
  }

  function ingest(payload) {
    const now = Date.now();
    S.generatedAt = payload.generated_at || null;
    S.all = (payload.tenders || []).map(prepare).filter((t) => !t._close || t._close > now);
    S.byId = new Map(S.all.map((t) => [t.id, t]));
    buildFilterOptions();
    updateCounts();
    updateLive();
    apply();
  }

  async function readCache() {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(DATA_URL);
      return hit ? await hit.json() : null;
    } catch { return null; }
  }
  async function writeCache(text) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(DATA_URL, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    } catch {}
  }

  async function load() {
    // Show the last copy instantly on repeat visits, then swap in fresh data.
    const network = fetch(DATA_URL, { cache: 'no-cache' });
    const cached = await readCache();
    if (cached?.tenders?.length) ingest(cached);
    try {
      const r = await network;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const fresh = JSON.parse(text);
      if (!cached || cached.generated_at !== fresh.generated_at) ingest(fresh);
      writeCache(text);
    } catch (err) {
      if (!cached) {
        $('resultTitle').textContent = 'Could not load tenders';
        $('grid').innerHTML = `<div class="empty"><strong>Tender data is unavailable right now.</strong>Please refresh in a minute. (${esc(err.message)})</div>`;
      }
    }
  }

  // ---------- Filters ----------
  function buildFilterOptions() {
    const fill = (id, label, key) => {
      const counts = new Map();
      for (const t of S.all) if (t[key]) counts.set(t[key], (counts.get(t[key]) || 0) + 1);
      const sel = $(id);
      const current = sel.value;
      const opts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      sel.innerHTML = `<option value="">${label}</option>` + opts.map(([v, c]) => `<option value="${esc(v)}">${esc(v)} (${fmtInt(c)})</option>`).join('');
      if (current && counts.has(current)) sel.value = current;
    };
    fill('fDistrict', 'All districts', 'district');
    fill('fDept', 'All departments', 'dept');
  }

  function updateCounts() {
    const c = { ALL: S.all.length, WORKS: 0, GOODS: 0, SERVICES: 0, soon: 0 };
    const soonLimit = Date.now() + 7 * DAY;
    for (const t of S.all) {
      c[t.cat] = (c[t.cat] || 0) + 1;
      if (t._close && t._close <= soonLimit) c.soon++;
    }
    $('cAll').textContent = fmtInt(c.ALL);
    $('cWorks').textContent = fmtInt(c.WORKS);
    $('cGoods').textContent = fmtInt(c.GOODS);
    $('cServices').textContent = fmtInt(c.SERVICES);
    $('cSoon').textContent = fmtInt(c.soon);
  }

  function updateLive() {
    const when = S.generatedAt ? ago(S.generatedAt) : null;
    const stale = S.generatedAt && Date.now() - Date.parse(S.generatedAt) > 3 * 3600000;
    $('liveText').textContent = when ? `${fmtInt(S.all.length)} live tenders · updated ${when}` : `${fmtInt(S.all.length)} live tenders`;
    $('livePill').classList.toggle('stale', Boolean(stale));
    if (S.generatedAt) $('footData').textContent = `Source: KPPP · last updated ${dateFmt.format(new Date(S.generatedAt))}`;
  }

  function readFilters() {
    const [vmin, vmax] = ($('fValue').value || '-').split('-');
    const closing = Number($('fClosing').value || 0) || S.soon;
    return {
      q: S.q.trim().toLowerCase(),
      district: $('fDistrict').value,
      dept: $('fDept').value,
      vmin: vmin ? Number(vmin) : null,
      vmax: vmax ? Number(vmax) : null,
      closing,
      access: $('fAccess').value,
      sort: $('fSort').value
    };
  }

  function apply({ keepScroll = false } = {}) {
    const f = readFilters();
    const terms = f.q ? f.q.split(/\s+/).filter(Boolean) : [];
    const closeBy = f.closing ? Date.now() + f.closing * DAY : null;
    const out = [];
    for (const t of S.all) {
      if (S.cat !== 'ALL' && t.cat !== S.cat) continue;
      if (S.savedOnly && !S.saved.has(t.id)) continue;
      if (f.district && t.district !== f.district) continue;
      if (f.dept && t.dept !== f.dept) continue;
      if (f.access && t.access !== f.access) continue;
      if (f.vmin !== null || f.vmax !== null) {
        const v = num(t.value);
        if (v === null) continue;
        if (f.vmin !== null && v < f.vmin) continue;
        if (f.vmax !== null && v >= f.vmax) continue;
      }
      if (closeBy && !(t._close && t._close <= closeBy)) continue;
      if (terms.length && !terms.every((w) => t._hay.includes(w))) continue;
      out.push(t);
    }
    const by = {
      new: (a, b) => b._pub - a._pub,
      closing: (a, b) => (a._close || Infinity) - (b._close || Infinity),
      value: (a, b) => (num(b.value) || 0) - (num(a.value) || 0),
      emd: (a, b) => (num(a.emd) ?? Infinity) - (num(b.emd) ?? Infinity)
    }[f.sort] || ((a, b) => b._pub - a._pub);
    out.sort(by);
    S.filtered = out;
    S.shown = 0;
    $('grid').innerHTML = '';
    renderMore();
    renderHead(f);
    syncControls(f);
    if (!keepScroll && window.scrollY > $('filters').offsetTop) window.scrollTo({ top: $('filters').offsetTop - 4 });
  }

  function renderHead(f) {
    const n = S.filtered.length;
    const catLabel = { ALL: 'tenders', WORKS: 'works tenders', GOODS: 'goods tenders', SERVICES: 'services tenders' }[S.cat];
    $('resultTitle').innerHTML = `${fmtInt(n)} <span>${S.savedOnly ? 'saved ' : ''}${catLabel}</span>`;
    const chips = [];
    if (S.cat !== 'ALL') chips.push(['cat', S.cat[0] + S.cat.slice(1).toLowerCase()]);
    if (f.q) chips.push(['q', `“${S.q.trim()}”`]);
    if (f.district) chips.push(['fDistrict', f.district]);
    if (f.dept) chips.push(['fDept', f.dept.length > 34 ? f.dept.slice(0, 32) + '…' : f.dept]);
    if ($('fValue').value) chips.push(['fValue', $('fValue').selectedOptions[0].text]);
    if (f.closing) chips.push(['fClosing', `Closing in ${f.closing} days`]);
    if (f.access) chips.push(['fAccess', f.access]);
    if (S.savedOnly) chips.push(['saved', 'Saved only']);
    $('chips').innerHTML = chips.map(([k, label]) => `<button type="button" class="chip" data-clear="${k}">${esc(label)}<b aria-hidden="true">×</b></button>`).join('');
  }

  function syncControls(f) {
    for (const id of ['fDistrict', 'fDept', 'fValue', 'fClosing', 'fAccess']) $(id).classList.toggle('set', Boolean($(id).value));
    document.querySelectorAll('.stat[data-cat]').forEach((el) => el.classList.toggle('active', el.dataset.cat === S.cat && !f.closing));
    document.querySelector('.stat.soon').classList.toggle('active', S.soon === 7 && !$('fClosing').value);
    $('savedBtn').classList.toggle('on', S.savedOnly);
    $('savedBtn').setAttribute('aria-pressed', String(S.savedOnly));
    $('savedCount').textContent = S.saved.size;
  }

  // ---------- Cards ----------
  const pinIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const heartIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/></svg>';

  function fig(label, value) {
    return `<div><span>${label}</span>${value ? `<strong>${value}</strong>` : '<strong class="na">Not given</strong>'}</div>`;
  }

  function card(t) {
    const left = timeLeft(t._close);
    const saved = S.saved.has(t.id);
    const where = [t.district, t.dept].filter(Boolean).join(' · ') || t.office || 'Karnataka';
    return `<article class="card" data-id="${esc(t.id)}" tabindex="0" aria-label="${esc(t.title)}">
      <div class="card-top">
        <span class="badge ${esc(t.cat)}">${esc(t.cat)}</span>
        ${t.access && t.access !== 'Open' ? `<span class="badge reserved">${esc(t.access)}</span>` : ''}
        ${t.work ? `<span class="badge soft">${esc(t.work)}</span>` : ''}
        ${left ? `<span class="due ${left.tone}">${esc(left.label)}</span>` : ''}
      </div>
      <h3>${esc(t.title)}</h3>
      <div class="meta">${pinIcon}<span>${esc(where)}</span></div>
      <div class="figures">${fig('Value', money(t.value))}${fig('EMD', money(t.emd))}${fig('Fee', money(t.fee))}</div>
      <button class="save ${saved ? 'on' : ''}" type="button" data-save="${esc(t.id)}" aria-label="${saved ? 'Remove from saved' : 'Save tender'}" aria-pressed="${saved}">${heartIcon}</button>
    </article>`;
  }

  function renderMore() {
    const grid = $('grid');
    if (!S.filtered.length) {
      grid.innerHTML = `<div class="empty"><strong>No tenders match these filters.</strong>Try removing a filter or searching for a different word.</div>`;
      $('moreBtn').hidden = true;
      return;
    }
    const next = S.filtered.slice(S.shown, S.shown + PAGE);
    grid.insertAdjacentHTML('beforeend', next.map(card).join(''));
    S.shown += next.length;
    const left = S.filtered.length - S.shown;
    $('moreBtn').hidden = left <= 0;
    $('moreBtn').textContent = `Show more (${fmtInt(left)} left)`;
  }

  function toggleSave(id) {
    if (S.saved.has(id)) S.saved.delete(id); else S.saved.add(id);
    writeJSON(SAVED_KEY, [...S.saved]);
    const on = S.saved.has(id);
    document.querySelectorAll(`[data-save="${CSS.escape(id)}"]`).forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      if (b.classList.contains('btn')) b.lastChild.textContent = on ? ' Saved' : ' Save';
    });
    $('savedCount').textContent = S.saved.size;
    toast(on ? 'Saved to your list' : 'Removed from saved');
    if (S.savedOnly && !on) apply({ keepScroll: true });
  }

  // ---------- Drawer ----------
  let lastFocus = null;
  function openTender(id) {
    const t = S.byId.get(id);
    if (!t) return;
    lastFocus = document.activeElement;
    const left = timeLeft(t._close);
    const closeText = t._close ? dateFmt.format(new Date(t._close)) : 'Not given';
    const saved = S.saved.has(t.id);
    const tk = 'https://www.google.com/search?q=' + encodeURIComponent(`site:tenderkart.in "${t.ref}"`);
    const facts = [
      ['Tender number', `<span class="ref">${esc(t.ref)}</span>`],
      ['Department', esc(t.dept)],
      ['Office', esc(t.office)],
      ['District', esc(t.district || 'Not identified')],
      ['Work category', esc(t.work)],
      ['Tender type', esc(t.bidType)],
      ['Who can bid', esc(t.access)],
      ['Published', t._pub ? esc(dateFmt.format(new Date(t._pub))) : '']
    ].filter(([, v]) => v);
    const d = $('drawer');
    d.innerHTML = `
      <div class="drawer-head">
        <div class="row">
          <span class="badge ${esc(t.cat)}">${esc(t.cat)}</span>
          ${t.access && t.access !== 'Open' ? `<span class="badge reserved">${esc(t.access)}</span>` : ''}
          <button class="close" type="button" data-close aria-label="Close">✕</button>
        </div>
        <h2 id="dTitle">${esc(t.title)}</h2>
        ${t.desc ? `<p>${esc(t.desc)}</p>` : ''}
      </div>
      <div class="drawer-body">
        <div class="countdown ${left ? left.tone : ''}">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>
          <div><div class="big">${left ? esc(left.label) : 'No closing date'}</div><small>Bid submission closes ${esc(closeText)}</small></div>
        </div>
        <div class="kpis">
          <div class="kpi"><span>Tender value</span><strong>${money(t.value) || '—'}</strong><small>${num(t.value) ? money(t.value, { full: true }) : 'Hidden by department'}</small></div>
          <div class="kpi"><span>EMD</span><strong>${money(t.emd) || '—'}</strong><small>${num(t.emd) ? money(t.emd, { full: true }) : 'Check on KPPP'}</small></div>
          <div class="kpi"><span>Tender fee</span><strong>${money(t.fee) || '—'}</strong><small>${num(t.fee) ? 'Non-refundable' : 'Check on KPPP'}</small></div>
        </div>
        <div class="actions">
          <a class="btn primary" href="https://kppp.karnataka.gov.in/" target="_blank" rel="noopener">Open KPPP portal ↗</a>
          <button class="btn" type="button" data-copy="${esc(t.ref)}">Copy tender number</button>
          <button class="btn ${saved ? 'on' : ''}" type="button" data-save="${esc(t.id)}" aria-pressed="${saved}">${heartIcon}${saved ? ' Saved' : ' Save'}</button>
          <a class="btn" href="${esc(tk)}" target="_blank" rel="noopener">Search on TenderKart ↗</a>
        </div>
        <section class="panel">
          <h3>Tender details</h3>
          <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
          <p class="note">On KPPP, search this tender number to download documents and submit your bid.</p>
        </section>
        ${calculatorHtml(t)}
      </div>`;
    d.setAttribute('aria-hidden', 'false');
    d.classList.add('open');
    $('scrim').classList.add('open');
    document.body.style.overflow = 'hidden';
    d.querySelector('.drawer-body').scrollTop = 0;
    d.querySelector('[data-close]').focus();
    bindCalculator(t);
    if (location.hash !== '#t=' + t.id) history.pushState({ tender: t.id }, '', '#t=' + encodeURIComponent(t.id));
  }

  function closeDrawer({ fromHistory = false } = {}) {
    const d = $('drawer');
    if (!d.classList.contains('open')) return;
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    $('scrim').classList.remove('open');
    document.body.style.overflow = '';
    if (!fromHistory && location.hash.startsWith('#t=')) history.back();
    lastFocus?.focus?.();
  }

  // ---------- Bid calculator (runs in the browser) ----------
  const PROFILES = {
    WORKS: { direct: 80, overhead: 5, contingency: 3, margin: 8 },
    GOODS: { direct: 90, overhead: 3, contingency: 2, margin: 6 },
    SERVICES: { direct: 75, overhead: 8, contingency: 4, margin: 10 }
  };

  function calculatorHtml(t) {
    const p = PROFILES[t.cat] || PROFILES.WORKS;
    const slider = (id, label, value, max) => `<div class="field"><label for="${id}">${label}<output id="${id}Out">${value}%</output></label><input id="${id}" type="range" min="0" max="${max}" step="0.5" value="${value}"></div>`;
    return `<section class="panel">
      <h3>Bid calculator</h3>
      <div class="calc-grid">
        <div class="field" style="grid-column:1/-1"><label for="cValue">Tender value (₹)</label><input id="cValue" type="number" min="0" step="1000" inputmode="numeric" value="${num(t.value) ? Math.round(t.value) : ''}" placeholder="Enter the tender value"></div>
        ${slider('cDirect', 'Direct cost (material + labour)', p.direct, 120)}
        ${slider('cOverhead', 'Site overhead', p.overhead, 30)}
        ${slider('cContingency', 'Risk / contingency', p.contingency, 20)}
        ${slider('cMargin', 'Your profit margin', p.margin, 30)}
      </div>
      <div class="calc-out" id="calcOut"></div>
      <p class="note">Percentages are of tender value and start from a typical ${esc((t.cat || 'works').toLowerCase())} profile — move them to match your own rates. Planning estimate only.</p>
    </section>`;
  }

  function bindCalculator(t) {
    const ids = ['cValue', 'cDirect', 'cOverhead', 'cContingency', 'cMargin'];
    const run = () => {
      const v = Number($('cValue').value) || 0;
      const [direct, overhead, contingency, margin] = ids.slice(1).map((id) => {
        const n = Number($(id).value) || 0;
        $(id + 'Out').textContent = n + '%';
        return n;
      });
      const out = $('calcOut');
      if (v <= 0) {
        out.innerHTML = '<div class="warnline">Enter the tender value to calculate your bid.</div>';
        return;
      }
      const cost = v * (direct + overhead + contingency) / 100;
      const bid = margin < 100 ? cost / (1 - margin / 100) : cost;
      const profit = bid - cost;
      const vsValue = ((bid - v) / v) * 100;
      const pct = (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
      out.innerHTML = `
        <div class="kpi hero-kpi"><span>Suggested bid</span><strong>${money(bid, { full: true })}</strong><small>${pct(vsValue)} vs tender value (${vsValue <= 0 ? 'below' : 'above'} estimate)</small></div>
        <div class="kpi"><span>Your total cost</span><strong>${money(cost)}</strong><small>Break-even bid</small></div>
        <div class="kpi"><span>Expected profit</span><strong>${money(profit) || '₹0'}</strong><small>${margin}% of your bid</small></div>
        <div class="kpi"><span>Maximum discount</span><strong>${cost < v ? ((v - cost) / v * 100).toFixed(1) + '%' : 'None'}</strong><small>Bid lower than this and you make a loss</small></div>
        <div class="kpi"><span>Working capital</span><strong>${money(Math.max(cost * 0.12, num(t.emd) || 0))}</strong><small>Rough cash needed to start</small></div>
        ${cost >= v ? '<div class="warnline" style="grid-column:1/-1">Your cost is at or above the tender value — check your rates before bidding.</div>' : ''}`;
    };
    ids.forEach((id) => $(id).addEventListener('input', run));
    run();
  }

  // ---------- Export ----------
  function exportCsv() {
    const rows = [['Tender number', 'Category', 'Title', 'Department', 'Office', 'District', 'Tender value', 'EMD', 'Fee', 'Published', 'Closing', 'Who can bid', 'Work category']];
    const d = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');
    for (const t of S.filtered) rows.push([t.ref, t.cat, t.title, t.dept, t.office, t.district, t.value, t.emd, t.fee, d(t._pub), d(t._close), t.access, t.work]);
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `karnataka-tenders-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${fmtInt(S.filtered.length)} tenders`);
  }

  // ---------- Status (admins) ----------
  async function showStatus() {
    const dlg = $('statusDialog');
    const list = $('statusList');
    list.innerHTML = '<li>Checking…</li>';
    dlg.showModal();
    try {
      const r = await fetch('/api/system_health', { cache: 'no-store' });
      const h = await r.json();
      const db = h.database || {};
      const row = (label, ok, text) => `<li><span>${label}</span><b class="${ok ? 'ok-t' : 'bad-t'}">${ok ? '✓' : '⚠'} ${esc(text)}</b></li>`;
      list.innerHTML = [
        row('Tender data', db.ok, `${fmtInt(db.count)} tenders · ${db.age_hours == null ? 'unknown age' : ago(db.last_success_at || db.generated_at)}`),
        row('KPPP connection', h.kppp?.ok, h.kppp?.ok ? 'Reachable' : `Not reachable (HTTP ${h.kppp?.http || '—'})`),
        row('EMD & fee', db.emd_known > 0, `Known for ${fmtInt(db.emd_known)} tenders`)
      ].join('');
    } catch (err) {
      list.innerHTML = `<li><span>Status check</span><b class="bad-t">⚠ ${esc(err.message)}</b></li>`;
    }
  }

  // ---------- Misc ----------
  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function clearFilter(key) {
    if (key === 'cat') S.cat = 'ALL';
    else if (key === 'q') { S.q = ''; $('q').value = ''; }
    else if (key === 'saved') S.savedOnly = false;
    else if (key === 'fClosing') { $('fClosing').value = ''; S.soon = 0; }
    else if ($(key)) $(key).value = '';
    apply({ keepScroll: true });
  }

  function reset() {
    S.cat = 'ALL'; S.soon = 0; S.savedOnly = false; S.q = '';
    $('q').value = '';
    for (const id of ['fDistrict', 'fDept', 'fValue', 'fClosing', 'fAccess']) $(id).value = '';
    $('fSort').value = 'new';
    apply();
  }

  // ---------- Events ----------
  let qTimer;
  $('q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { S.q = e.target.value; apply({ keepScroll: true }); }, 140);
  });
  for (const id of ['fDistrict', 'fDept', 'fValue', 'fAccess', 'fSort']) $(id).addEventListener('change', () => apply({ keepScroll: true }));
  $('fClosing').addEventListener('change', () => { S.soon = 0; apply({ keepScroll: true }); });
  document.querySelectorAll('.stat[data-cat]').forEach((el) => el.addEventListener('click', () => {
    S.cat = el.dataset.cat; S.soon = 0; $('fClosing').value = ''; apply();
  }));
  document.querySelector('.stat.soon').addEventListener('click', () => {
    S.soon = S.soon === 7 ? 0 : 7; $('fClosing').value = ''; if (S.soon) $('fSort').value = 'closing'; apply();
  });
  $('savedBtn').addEventListener('click', () => { S.savedOnly = !S.savedOnly; apply({ keepScroll: true }); });
  $('resetBtn').addEventListener('click', reset);
  $('exportBtn').addEventListener('click', exportCsv);
  $('moreBtn').addEventListener('click', renderMore);
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-clear]'); if (b) clearFilter(b.dataset.clear); });
  $('scrim').addEventListener('click', () => closeDrawer());
  $('statusBtn').addEventListener('click', showStatus);
  $('statusDialog').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('statusDialog').close(); });
  $('themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next); writeJSON(THEME_KEY, next);
  });

  document.addEventListener('click', (e) => {
    const save = e.target.closest('[data-save]');
    if (save) { e.stopPropagation(); toggleSave(save.dataset.save); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('Tender number copied')); return; }
    if (e.target.closest('#drawer [data-close]')) { closeDrawer(); return; }
    const c = e.target.closest('.card');
    if (c) openTender(c.dataset.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === 'Enter' && e.target.classList?.contains('card')) openTender(e.target.dataset.id);
    if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); $('q').focus(); }
  });
  window.addEventListener('popstate', () => {
    const m = location.hash.match(/^#t=(.+)$/);
    if (m && S.byId.has(decodeURIComponent(m[1]))) openTender(decodeURIComponent(m[1]));
    else closeDrawer({ fromHistory: true });
  });

  // Auto-load the next page when the "Show more" button scrolls into view.
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && !$('moreBtn').hidden) renderMore();
  }, { rootMargin: '600px' }).observe($('moreBtn'));
  new IntersectionObserver(([en]) => $('filters').classList.toggle('stuck', en.intersectionRatio < 1), { threshold: [1], rootMargin: '-1px 0px 0px 0px' }).observe($('filters'));


  load().then(() => {
    const m = location.hash.match(/^#t=(.+)$/);
    if (m && S.byId.has(decodeURIComponent(m[1]))) {
      history.replaceState(null, '', location.pathname);
      openTender(decodeURIComponent(m[1]));
    }
  });
  setInterval(updateLive, 60000);
})();
