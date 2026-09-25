'use strict';

(() => {
  const DATA_URL = '/tenders-lite.json';
  const CACHE_NAME = 'tenderone-data-v1';
  const SAVED_KEY = 'kppp_saved_tenders';
  const THEME_KEY = 'tenderone_theme';
  const VIEW_KEY = 'tenderone_view';
  const PROFILE_KEY = 'tenderone_profile';
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
    cat: 'ALL', soon: 0, savedOnly: false, forMe: false, q: '',
    profile: readJSON(PROFILE_KEY, null),
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
      if (S.forMe && !matchesProfile(t)) continue;
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
    if (S.forMe) chips.push(['forMe', 'For me']);
    $('chips').innerHTML = chips.map(([k, label]) => `<button type="button" class="chip" data-clear="${k}">${esc(label)}<b aria-hidden="true">×</b></button>`).join('');
  }

  function syncControls(f) {
    for (const id of ['fDistrict', 'fDept', 'fValue', 'fClosing', 'fAccess']) $(id).classList.toggle('set', Boolean($(id).value));
    document.querySelectorAll('.stat[data-cat]').forEach((el) => el.classList.toggle('active', el.dataset.cat === S.cat && !f.closing));
    document.querySelector('.stat.soon').classList.toggle('active', S.soon === 7 && !$('fClosing').value);
    $('savedBtn').classList.toggle('on', S.savedOnly);
    $('forMeBtn').classList.toggle('on', S.forMe);
    $('forMeBtn').setAttribute('aria-pressed', String(S.forMe));
    $('savedBtn').setAttribute('aria-pressed', String(S.savedOnly));
    $('savedCount').textContent = S.saved.size;
  }

  // ---------- Tenders for me ----------
  function matchesProfile(t) {
    const p = S.profile;
    if (!p) return true;
    if (p.cats?.length && !p.cats.includes(t.cat)) return false;
    if (p.districts?.length && !p.districts.includes(t.district)) return false;
    if (p.work?.length && !p.work.includes(t.work)) return false;
    if (!p.reserved && t.access && t.access !== 'Open') return false;
    const v = num(t.value);
    if (v === null) return p.noValue !== false;
    if (p.min && v < p.min) return false;
    if (p.max && v > p.max) return false;
    return true;
  }

  function openProfile() {
    const p = S.profile || {};
    const box = (id, values, chosen) => {
      $(id).innerHTML = values.map(([v, label, n]) => `<label class="check"><input type="checkbox" value="${esc(v)}" ${chosen?.includes(v) ? 'checked' : ''}> ${esc(label)}${n ? ` <small>${fmtInt(n)}</small>` : ''}</label>`).join('');
    };
    const counts = (key) => {
      const m = new Map();
      for (const t of S.all) if (t[key]) m.set(t[key], (m.get(t[key]) || 0) + 1);
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([v, n]) => [v, v, n]);
    };
    box('pCats', [['WORKS', 'Works'], ['GOODS', 'Goods'], ['SERVICES', 'Services']], p.cats);
    box('pDistricts', counts('district'), p.districts);
    box('pWork', counts('work'), p.work);
    $('pMin').value = p.min || '';
    $('pMax').value = p.max || '';
    $('pNoValue').checked = p.noValue !== false;
    $('pReserved').checked = Boolean(p.reserved);
    $('profileDialog').showModal();
  }

  function saveProfile() {
    const picked = (id) => [...$(id).querySelectorAll('input:checked')].map((i) => i.value);
    S.profile = {
      cats: picked('pCats'), districts: picked('pDistricts'), work: picked('pWork'),
      min: Number($('pMin').value) || 0, max: Number($('pMax').value) || 0,
      noValue: $('pNoValue').checked, reserved: $('pReserved').checked
    };
    writeJSON(PROFILE_KEY, S.profile);
    S.forMe = true;
    apply();
    toast(`${fmtInt(S.filtered.length)} tenders match your profile`);
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

  // ---------- Tender page ----------
  let lastFocus = null;
  const detailCache = new Map();

  // KPPP full-view dates are 'dd-mm-yyyy HH:MM:SS' India time.
  function kpppDate(v) {
    const m = String(v || '').match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
    return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+05:30`) : null;
  }
  const fmtKppp = (v) => { const ms = kpppDate(v); return ms ? dateFmt.format(new Date(ms)) : null; };
  const icon = {
    doc: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m5 12 5 5 9-10"/></svg>',
    phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>'
  };

  function openTender(id) {
    const t = S.byId.get(id);
    if (!t) return;
    lastFocus = document.activeElement;
    const left = timeLeft(t._close);
    const closeText = t._close ? dateFmt.format(new Date(t._close)) : 'Not given';
    const saved = S.saved.has(t.id);
    const tk = 'https://www.google.com/search?q=' + encodeURIComponent(`site:tenderkart.in "${t.ref}"`);
    const place = [t.office, t.district].filter(Boolean).join(' · ');
    const d = $('drawer');
    d.innerHTML = `
      <div class="tp-bar">
        <div class="wrap tp-bar-in">
          <button class="btn ghost" type="button" data-close>${icon.back} Back to tenders</button>
          <span class="spacer"></span>
          <button class="btn" type="button" data-copy="${esc(t.ref)}">Copy tender no.</button>
          <button class="btn ${saved ? 'on' : ''}" type="button" data-save="${esc(t.id)}" aria-pressed="${saved}">${heartIcon}${saved ? ' Saved' : ' Save'}</button>
        </div>
      </div>
      <header class="tp-hero">
        <div class="wrap">
          <div class="row">
            <span class="badge ${esc(t.cat)}">${esc(t.cat)}</span>
            ${t.access ? `<span class="badge ${t.access === 'Open' ? 'soft' : 'reserved'}">${esc(t.access)} tender</span>` : ''}
            ${t.work ? `<span class="badge soft">${esc(t.work)}</span>` : ''}
          </div>
          <h2 id="dTitle">${esc(t.title)}</h2>
          <p class="tp-sub">${esc(t.dept)}${place ? ` · ${esc(place)}` : ''}</p>
          <p class="ref">${esc(t.ref)}</p>
        </div>
      </header>
      <div class="wrap tp-grid">
        <aside class="tp-side">
          <div class="countdown ${left ? left.tone : ''}">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>
            <div><div class="big">${left ? esc(left.label) : 'No closing date'}</div><small>Bid submission closes ${esc(closeText)}</small></div>
          </div>
          <div class="kpis">
            <div class="kpi"><span>Tender value</span><strong>${money(t.value) || '—'}</strong><small>${num(t.value) ? money(t.value, { full: true }) : 'Not published'}</small></div>
            <div class="kpi"><span>EMD</span><strong>${money(t.emd) || '—'}</strong><small id="emdNote">${num(t.emd) ? money(t.emd, { full: true }) : 'Not published'}</small></div>
            <div class="kpi"><span>Tender fee</span><strong>${money(t.fee) || '—'}</strong><small>${num(t.fee) ? money(t.fee, { full: true }) : 'Not published'}</small></div>
          </div>
          <section class="panel" id="tpDates"><h3>Important dates</h3><dl class="facts">
            ${t._pub ? `<dt>Published</dt><dd>${esc(dateFmt.format(new Date(t._pub)))}</dd>` : ''}
            <dt>Bid submission ends</dt><dd>${esc(closeText)}</dd>
          </dl></section>
          <section class="panel" id="tpContact" hidden></section>
          <div class="actions col">
            <a class="btn primary" href="https://kppp.karnataka.gov.in/" target="_blank" rel="noopener">Bid on KPPP portal ↗</a>
            <a class="btn" href="${esc(tk)}" target="_blank" rel="noopener">Search on TenderKart ↗</a>
          </div>
        </aside>
        <main class="tp-main">
          <div id="tpFull">${loadingBlock()}</div>
          <section class="panel" id="tpSimilar" hidden></section>
          ${calculatorHtml(t)}
        </main>
      </div>`;
    d.setAttribute('aria-hidden', 'false');
    d.classList.add('open');
    document.body.style.overflow = 'hidden';
    d.scrollTop = 0;
    d.querySelector('[data-close]').focus();
    bindCalculator(t);
    loadFull(t);
    renderSimilar(t);
    if (location.hash !== '#t=' + t.id) history.pushState({ tender: t.id }, '', '#t=' + encodeURIComponent(t.id));
  }

  function loadingBlock() {
    return `<section class="panel"><h3>Loading full details from KPPP…</h3><div class="skeleton line"></div><div class="skeleton line"></div><div class="skeleton line short"></div></section>`;
  }

  async function loadFull(t) {
    const box = $('tpFull');
    if (!t.nit) { box.innerHTML = fullUnavailable(t); return; }
    const key = `${t.cat}/${t.nit}`;
    try {
      if (!detailCache.has(key)) {
        detailCache.set(key, fetch(`/api/tender/${key}`).then((r) => r.json()).then((j) => {
          if (!j.success) throw new Error(j.message || 'Not available');
          return j;
        }));
      }
      const full = await detailCache.get(key);
      if ($('tpFull') !== box) return; // another tender was opened meanwhile
      renderFull(t, full);
    } catch {
      detailCache.delete(key);
      if ($('tpFull') === box) box.innerHTML = fullUnavailable(t);
    }
  }

  function fullUnavailable(t) {
    return `<section class="panel"><h3>Full details</h3><p class="muted-p">KPPP didn't send the full details right now. Search for <b class="ref">${esc(t.ref)}</b> on the KPPP portal to see documents and conditions, or try again in a minute.</p></section>`;
  }

  function renderFull(t, f) {
    // Side column: exact dates, EMD split and contact.
    const dates = [
      ['Published', fmtKppp(f.dates.published)],
      ['Last date for questions', fmtKppp(f.dates.queries)],
      ['Pre-bid meeting', fmtKppp(f.dates.preBid)],
      ['Bid submission ends', fmtKppp(f.dates.submission)],
      ['Bids open', fmtKppp(f.dates.opening)]
    ].filter(([, v]) => v);
    if (dates.length) $('tpDates').innerHTML = `<h3>Important dates</h3><dl class="facts">${dates.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    if (f.money.emdCash && f.money.emdGuarantee && $('emdNote')) {
      $('emdNote').textContent = `${money(f.money.emdCash)} cash + ${money(f.money.emdGuarantee)} bank guarantee`;
    }
    const c = f.contact || {};
    if (c.person || c.mobile || c.address) {
      const box = $('tpContact');
      box.hidden = false;
      box.innerHTML = `<h3>Contact</h3><dl class="facts">
        ${c.person ? `<dt>Officer</dt><dd>${esc(c.person)}</dd>` : ''}
        ${c.mobile ? `<dt>Mobile</dt><dd><a href="tel:${esc(c.mobile)}">${icon.phone} ${esc(c.mobile)}</a></dd>` : ''}
        ${c.address ? `<dt>Address</dt><dd>${esc(c.address)}</dd>` : ''}
      </dl>`;
    }

    // Main column.
    const terms = [
      ['Work description', f.description && f.description !== t.title ? esc(f.description) : ''],
      ['Evaluation', esc(f.terms.evaluation)],
      ['Bid type', esc(f.terms.bidType)],
      ['Tax', f.terms.tax ? esc(f.terms.tax[0].toUpperCase() + f.terms.tax.slice(1)) : ''],
      ['Bid validity', f.terms.validityDays ? `${f.terms.validityDays} days` : ''],
      ['Call', f.terms.call ? `Call ${f.terms.call}${f.terms.retender ? ' (re-tender)' : ''}` : ''],
      ['Technical weightage', f.terms.techWeight ? `${f.terms.techWeight}%` : ''],
      ['Tender value (approved amount)', num(f.money.provisional) ? money(f.money.provisional, { full: true }) : ''],
      ['File number', esc(f.fileNumber)],
      ['Department', esc(t.dept)],
      ['Office', esc(t.office)]
    ].filter(([, v]) => v);

    const files = f.files.length ? `<section class="panel"><h3>Tender documents <span class="count">${f.files.length}</span></h3>
      <div class="files">${f.files.map((x) => `<div class="file">${icon.doc}<span><b>${esc(x.name)}</b><small>${esc(x.type || 'Document')}</small></span>
        ${/\.pdf$/i.test(x.name) ? `<a class="btn" href="${esc(x.url)}" target="_blank" rel="noopener">View</a>` : ''}
        <a class="btn primary" href="${esc(x.url)}&dl=1" download="${esc(x.name)}">Download</a></div>`).join('')}</div>
      <p class="note">Downloads come straight from KPPP. Large files can take a few seconds to start.</p>
    </section>` : '';

    const eligibility = f.eligibility.length ? `<section class="panel"><h3>Who is eligible <span class="count">${f.eligibility.length}</span></h3>
      <ol class="rules">${f.eligibility.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></section>` : '';

    const technical = f.technical.length ? `<section class="panel"><h3>Technical qualification <span class="count">${f.technical.length}</span></h3>
      <div class="quals">${f.technical.map((q) => `<div class="qual">
        <div class="qual-top">${q.category ? `<span class="badge soft">${esc(q.category)}</span>` : ''}${q.weight ? `<span class="badge soft">${q.weight} marks</span>` : ''}</div>
        <p>${esc(q.text)}</p>
        ${q.documents.length ? `<small>Proof: ${q.documents.map(esc).join(', ')}</small>` : ''}
      </div>`).join('')}</div></section>` : '';

    const docs = f.documents.length ? `<section class="panel"><h3>Documents to upload with your bid <span class="count">${f.documents.length}</span></h3>
      <ul class="checklist">${f.documents.map((x) => `<li>${icon.check}<span>${esc(x.name)}${x.cover ? `<small>${esc(x.cover)}${x.optional ? '' : ' · mandatory'}</small>` : ''}</span></li>`).join('')}</ul></section>` : '';

    const itemCount = f.groups.reduce((n, g) => n + g.items.length, 0);
    const items = itemCount ? `<section class="panel"><h3>${t.cat === 'WORKS' ? 'Bill of quantities' : 'Items'} <span class="count">${fmtInt(itemCount)}</span></h3>
      ${f.groups.map((g, gi) => {
        // Goods tenders often carry ₹1 placeholder prices; only show real rates.
        const showRate = g.items.some((i) => i.rate > 1);
        const showAmt = g.items.some((i) => i.amount > 1);
        return `<div class="boq">
        ${g.name || g.total ? `<div class="boq-head"><b>${esc(g.name || 'Items')}</b>${g.note ? `<span class="badge soft">${esc(g.note)}</span>` : ''}${g.total ? `<span class="spacer"></span><strong>${money(g.total, { full: true })}</strong>` : ''}</div>` : ''}
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Item</th><th class="n">Qty</th><th>Unit</th>${showRate ? '<th class="n">Rate</th>' : ''}${showAmt ? '<th class="n">Amount</th>' : ''}</tr></thead>
          <tbody>${g.items.map((i, ii) => `<tr${ii >= 12 ? ` class="more-row" data-group="${gi}" hidden` : ''}>
            <td>${esc(i.code || ii + 1)}</td>
            <td><div class="item-name">${esc(i.name)}</div>${i.spec && i.spec !== i.name ? `<small>${esc(i.spec)}</small>` : ''}${i.section ? `<small>${esc(i.section)}</small>` : ''}</td>
            <td class="n">${i.qty ?? ''}</td><td>${esc(i.unit)}</td>
            ${showRate ? `<td class="n">${i.rate ? money(i.rate, { full: true }) : ''}</td>` : ''}
            ${showAmt ? `<td class="n">${i.amount ? money(i.amount, { full: true }) : ''}</td>` : ''}
          </tr>`).join('')}</tbody>
        </table></div>
        ${g.items.length > 12 ? `<button class="btn ghost show-rows" type="button" data-group="${gi}">Show all ${fmtInt(g.items.length)} items</button>` : ''}
      </div>`;
      }).join('')}
    </section>` : '';

    $('tpFull').innerHTML = `
      <section class="panel"><h3>Tender details</h3><dl class="facts">${terms.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      ${files}${eligibility}${technical}${docs}${items}`;
    $('tpFull').querySelectorAll('.show-rows').forEach((b) => b.addEventListener('click', () => {
      $('tpFull').querySelectorAll(`.more-row[data-group="${b.dataset.group}"]`).forEach((r) => { r.hidden = false; });
      b.remove();
    }));
  }

  function closeDrawer({ fromHistory = false } = {}) {
    const d = $('drawer');
    if (!d.classList.contains('open')) return;
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (!fromHistory && /^#[tc]=/.test(location.hash)) history.back();
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

  // ---------- Past results & winners ----------
  const R = { mode: 'live', all: null, filtered: [], shown: 0, q: '', loading: null };
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const pctText = (p) => (p === null || p === undefined ? '—' : `${Math.abs(p).toFixed(1)}% ${p < 0 ? 'below' : p > 0 ? 'above' : 'at'} estimate`);
  const winPct = (r) => r.bidders?.[0]?.pct ?? null;

  function loadResults() {
    if (!R.loading) {
      R.loading = fetch('/results-lite.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          R.all = (d.results || []).map((r) => {
            r._award = r.awarded ? Date.parse(r.awarded) : (r.closed ? Date.parse(r.closed) : 0);
            r._hay = [r.title, r.ref, r.dept, r.office, r.district, r.work, r.winner, ...(r.bidders || []).map((b) => b.name)].filter(Boolean).join(' ').toLowerCase();
            return r;
          });
          const fill = (id, label, key) => {
            const counts = new Map();
            for (const r of R.all) if (r[key]) counts.set(r[key], (counts.get(r[key]) || 0) + 1);
            $(id).innerHTML = `<option value="">${label}</option>` + [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([v, c]) => `<option value="${esc(v)}">${esc(v)} (${fmtInt(c)})</option>`).join('');
          };
          fill('rDistrict', 'All districts', 'district');
          fill('rDept', 'All departments', 'dept');
          fill('rWork', 'All types of work', 'work');
          return R.all;
        })
        .catch((err) => { R.loading = null; throw err; });
    }
    return R.loading;
  }

  function setMode(mode) {
    R.mode = mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    $('liveView').hidden = mode !== 'live';
    $('resultsView').hidden = mode !== 'results';
    $('q').value = mode === 'results' ? R.q : S.q;
    $('q').placeholder = mode === 'results' ? 'Search results by work, department, town or contractor name…' : 'Search by work, tender number, department or town…';
    if (mode === 'results') {
      $('rTitle').textContent = 'Loading results…';
      loadResults().then(applyResults).catch((err) => {
        $('rTitle').textContent = 'Results are not available yet';
        $('rList').innerHTML = `<div class="empty"><strong>Past results are still being collected.</strong>Please check again later. (${esc(err.message)})</div>`;
      });
    }
  }

  function filterResults(f) {
    const terms = (f.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (R.all || []).filter((r) => (!f.cat || r.cat === f.cat) && (!f.district || r.district === f.district)
      && (!f.dept || r.dept === f.dept) && (!f.work || r.work === f.work)
      && (!terms.length || terms.every((w) => r._hay.includes(w))));
  }

  function summarize(list) {
    const pcts = list.map(winPct).filter((p) => p !== null);
    const withBids = list.filter((r) => r.bidders?.length);
    const wins = new Map();
    for (const r of list) if (r.winner) wins.set(r.winner, (wins.get(r.winner) || 0) + 1);
    return {
      count: list.length,
      median: median(pcts),
      bidders: withBids.length ? withBids.reduce((n, r) => n + r.bidders.length, 0) / withBids.length : null,
      top: [...wins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    };
  }

  function applyResults() {
    if (!R.all) return;
    const f = { q: R.q, cat: $('rCat').value, district: $('rDistrict').value, dept: $('rDept').value, work: $('rWork').value };
    const list = filterResults(f);
    const sort = $('rSort').value;
    const by = {
      new: (a, b) => b._award - a._award,
      discount: (a, b) => (winPct(a) ?? 999) - (winPct(b) ?? 999),
      value: (a, b) => (num(b.value) || 0) - (num(a.value) || 0),
      bidders: (a, b) => (b.bidders?.length || 0) - (a.bidders?.length || 0)
    }[sort];
    list.sort(by);
    R.filtered = list;
    R.shown = 0;
    const sum = summarize(list);
    $('rCount').textContent = fmtInt(sum.count);
    $('rMedian').textContent = sum.median === null ? '—' : `${Math.abs(sum.median).toFixed(1)}% ${sum.median <= 0 ? 'below' : 'above'}`;
    $('rBidders').textContent = sum.bidders === null ? '—' : sum.bidders.toFixed(1);
    $('rWinners').innerHTML = sum.top.length ? sum.top.map(([n, c]) => `<li><button type="button" data-win="${esc(n)}">${esc(n)}</button><b>${c}</b></li>`).join('') : '<li>—</li>';
    $('rTitle').innerHTML = `${fmtInt(list.length)} <span>awarded tenders</span>`;
    for (const id of ['rCat', 'rDistrict', 'rDept', 'rWork']) $(id).classList.toggle('set', Boolean($(id).value));
    $('rList').innerHTML = '';
    moreResults();
  }

  function resultRow(r) {
    const p = winPct(r);
    const tone = p === null ? '' : p <= -15 ? 'deep' : p < 0 ? 'below' : 'above';
    const when = r._award ? shortDate.format(new Date(r._award)) : '';
    return `<details class="rrow">
      <summary>
        <div class="rmain">
          <div class="card-top"><span class="badge ${esc(r.cat)}">${esc(r.cat)}</span>${r.work ? `<span class="badge soft">${esc(r.work)}</span>` : ''}${when ? `<span class="due">Awarded ${esc(when)}</span>` : ''}</div>
          <h3>${esc(r.title)}</h3>
          <div class="meta">${pinIcon}<span>${esc([r.district, r.dept].filter(Boolean).join(' · ') || r.office || '')}</span></div>
        </div>
        <div class="rside">
          <span class="rlabel">Winner</span>
          <strong class="rwinner">${esc(r.winner || 'Not published')}</strong>
          <div class="rstats">
            ${p !== null ? `<span class="pct ${tone}">${esc(pctText(p))}</span>` : ''}
            ${r.bidders?.length ? `<span class="badge soft">${r.bidders.length} bidder${r.bidders.length === 1 ? '' : 's'}</span>` : ''}
          </div>
        </div>
      </summary>
      <div class="rbody">
        <p class="ref">${esc(r.ref)}${num(r.value) ? ` · Estimate ${money(r.value, { full: true })}` : ''}${r.office ? ` · ${esc(r.office)}` : ''}</p>
        ${r.bidders?.length ? `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Bidder</th><th class="n">Quoted amount</th><th class="n">vs estimate</th></tr></thead><tbody>
          ${r.bidders.map((b) => `<tr${b.rank === 1 ? ' class="l1"' : ''}><td>${b.rank ? 'L' + b.rank : ''}</td><td><button type="button" class="linkish" data-win="${esc(b.name)}">${esc(b.name)}</button></td><td class="n">${b.amount ? money(b.amount, { full: true }) : ''}</td><td class="n">${b.pct === null || b.pct === undefined ? '' : (b.pct > 0 ? '+' : '') + b.pct.toFixed(2) + '%'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="note">KPPP has not published the bid comparison for this tender.</p>'}
      </div>
    </details>`;
  }

  function moreResults() {
    if (!R.filtered.length) {
      $('rList').innerHTML = '<div class="empty"><strong>No results match.</strong>Try a different search or remove a filter.</div>';
      $('rMore').hidden = true;
      return;
    }
    const next = R.filtered.slice(R.shown, R.shown + PAGE);
    $('rList').insertAdjacentHTML('beforeend', next.map(resultRow).join(''));
    R.shown += next.length;
    const left = R.filtered.length - R.shown;
    $('rMore').hidden = left <= 0;
    $('rMore').textContent = `Show more (${fmtInt(left)} left)`;
  }

  // Past results for work like this tender: same department and type of work, else same type of work in the district.
  async function similarResults(t) {
    try { await loadResults(); } catch { return null; }
    let list = filterResults({ dept: t.dept, work: t.work, cat: t.cat });
    let scope = `${t.work || 'this type of'} work in ${t.dept}`;
    if (list.filter((r) => winPct(r) !== null).length < 5 && t.district) {
      list = filterResults({ district: t.district, work: t.work, cat: t.cat });
      scope = `${t.work || t.cat.toLowerCase()} work in ${t.district}`;
    }
    const sum = summarize(list);
    return sum.count ? { ...sum, scope } : null;
  }

  async function renderSimilar(t) {
    const box = $('tpSimilar');
    if (!box) return;
    const sim = await similarResults(t);
    if ($('tpSimilar') !== box) return;
    if (!sim || sim.median === null) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<h3>How similar tenders were won</h3>
      <p class="muted-p">Based on ${fmtInt(sim.count)} awarded tenders for ${esc(sim.scope)}.</p>
      <div class="kpis" style="margin-top:12px">
        <div class="kpi"><span>Typical winning bid</span><strong>${Math.abs(sim.median).toFixed(1)}% ${sim.median <= 0 ? 'below' : 'above'}</strong><small>the estimate (median L1)</small></div>
        <div class="kpi"><span>Average bidders</span><strong>${sim.bidders === null ? '—' : sim.bidders.toFixed(1)}</strong><small>per tender</small></div>
        <div class="kpi"><span>Most wins</span><strong style="font-size:14px">${sim.top[0] ? `<button type="button" class="linkish" data-contractor="${esc(sim.top[0][0])}">${esc(sim.top[0][0])}</button>` : '—'}</strong><small>${sim.top[0] ? `${sim.top[0][1]} tenders` : ''}</small></div>
      </div>
      ${num(t.value) ? `<p class="note">At that rate the winning bid for this tender would be about <b>${money(t.value * (1 + sim.median / 100), { full: true })}</b>.</p>` : ''}
      <button class="btn" type="button" id="seeSimilar">See these results</button>`;
    $('seeSimilar').addEventListener('click', () => {
      closeDrawer();
      setMode('results');
      loadResults().then(() => {
        $('rCat').value = t.cat; $('rWork').value = t.work || '';
        $('rDept').value = sim.scope.includes(t.dept) ? t.dept : '';
        $('rDistrict').value = sim.scope.includes(t.dept) ? '' : (t.district || '');
        applyResults();
        window.scrollTo({ top: $('resultsView').offsetTop - 10 });
      });
    });
  }

  // ---------- Contractor profile ----------
  // KPPP writes the same bidder slightly differently across tenders ("NAME (1)( FIRM )", extra spaces).
  const nameKey = (n) => String(n || '').toUpperCase().replace(/\(\s*\d+\s*\)/g, ' ').replace(/[^A-Z0-9()]+/g, ' ').replace(/\s+/g, ' ').trim();

  function countBy(list, key) {
    const m = new Map();
    for (const r of list) if (r[key]) m.set(r[key], (m.get(r[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function bars(title, entries, total) {
    if (!entries.length) return '';
    return `<section class="panel"><h3>${title}</h3><div class="bars">${entries.slice(0, 8).map(([k, n]) => `
      <div class="bar"><span>${esc(k)}</span><i style="--w:${Math.max(4, Math.round(n / total * 100))}%"></i><b>${fmtInt(n)}</b></div>`).join('')}</div></section>`;
  }

  async function openContractor(name) {
    try { await loadResults(); } catch { toast('Past results are not available yet'); return; }
    const key = nameKey(name);
    const rows = [];
    for (const r of R.all) {
      const mine = (r.bidders || []).find((b) => nameKey(b.name) === key);
      const won = nameKey(r.winner) === key || mine?.rank === 1;
      if (mine || won) rows.push({ r, mine, won });
    }
    if (!rows.length) { toast('No results found for this contractor'); return; }
    rows.sort((a, b) => b.r._award - a.r._award);
    const display = rows.find((x) => x.mine)?.mine.name || rows[0].r.winner || name;
    const wins = rows.filter((x) => x.won);
    const withBids = rows.filter((x) => x.mine);
    const winPcts = wins.map((x) => x.mine?.pct).filter((p) => p !== null && p !== undefined);
    const allPcts = withBids.map((x) => x.mine.pct).filter((p) => p !== null && p !== undefined);
    const wonValue = wins.reduce((n, x) => n + (num(x.mine?.amount) || num(x.r.value) || 0), 0);
    const ranks = { 1: 0, 2: 0, 3: 0 };
    for (const x of withBids) if (x.mine.rank) ranks[Math.min(3, x.mine.rank)]++;
    const winRate = withBids.length ? wins.filter((x) => x.mine).length / withBids.length * 100 : null;
    const medWin = median(winPcts);
    const medAll = median(allPcts);

    // Competitors: who they meet most, and who finished ahead.
    const rivals = new Map();
    for (const x of withBids) {
      for (const b of x.r.bidders) {
        const k = nameKey(b.name);
        if (k === key) continue;
        const v = rivals.get(k) || { name: b.name, met: 0, ahead: 0 };
        v.met++;
        if (b.rank && x.mine.rank && x.mine.rank < b.rank) v.ahead++;
        rivals.set(k, v);
      }
    }
    const topRivals = [...rivals.values()].sort((a, b) => b.met - a.met).slice(0, 8);
    const tenders = rows.map((x) => x.r);

    lastFocus = document.activeElement;
    const d = $('drawer');
    d.innerHTML = `
      <div class="tp-bar"><div class="wrap tp-bar-in">
        <button class="btn ghost" type="button" data-close>${icon.back} Back</button>
        <span class="spacer"></span>
        <button class="btn" type="button" data-copy="${esc(display)}">Copy name</button>
      </div></div>
      <header class="tp-hero"><div class="wrap">
        <div class="row"><span class="badge soft">Contractor profile</span></div>
        <h2 id="dTitle">${esc(display)}</h2>
        <p class="tp-sub">Based on ${fmtInt(rows.length)} awarded KPPP tenders in our records · ${fmtInt(wins.length)} won</p>
      </div></header>
      <div class="wrap cp">
        <div class="cp-kpis">
          <div class="kpi"><span>Tenders won</span><strong>${fmtInt(wins.length)}</strong><small>${wonValue ? `worth ${money(wonValue)}` : ''}</small></div>
          <div class="kpi"><span>Win rate</span><strong>${winRate === null ? '—' : winRate.toFixed(0) + '%'}</strong><small>${withBids.length ? `of ${fmtInt(withBids.length)} works tenders bid` : 'bid amounts not published'}</small></div>
          <div class="kpi"><span>Usual winning bid</span><strong>${medWin === null ? '—' : pctText(medWin).replace(' estimate', '')}</strong><small>median when they won</small></div>
          <div class="kpi"><span>Usual bid</span><strong>${medAll === null ? '—' : pctText(medAll).replace(' estimate', '')}</strong><small>median of all their bids</small></div>
        </div>
        ${withBids.length ? `<section class="panel"><h3>Where they finish</h3><div class="ranks">
          <div><b>${ranks[1]}</b><span>L1 (lowest)</span></div><div><b>${ranks[2]}</b><span>L2</span></div><div><b>${ranks[3]}</b><span>L3 or lower</span></div>
        </div></section>` : ''}
        <div class="cp-grid">
          ${bars('Districts', countBy(tenders, 'district'), tenders.length)}
          ${bars('Departments', countBy(tenders, 'dept'), tenders.length)}
          ${bars('Type of work', countBy(tenders, 'work'), tenders.length)}
          ${topRivals.length ? `<section class="panel"><h3>Frequent competitors</h3><div class="table-wrap"><table>
            <thead><tr><th>Competitor</th><th class="n">Met</th><th class="n">${esc(display.split(' ')[0])} ahead</th></tr></thead>
            <tbody>${topRivals.map((v) => `<tr><td><button type="button" class="linkish" data-contractor="${esc(v.name)}">${esc(v.name)}</button></td><td class="n">${v.met}</td><td class="n">${v.ahead} of ${v.met}</td></tr>`).join('')}</tbody>
          </table></div></section>` : ''}
        </div>
        <section class="panel"><h3>Tenders <span class="count">${fmtInt(rows.length)}</span></h3><div class="table-wrap"><table>
          <thead><tr><th>Awarded</th><th>Tender</th><th>Result</th><th class="n">Their bid</th><th class="n">vs estimate</th></tr></thead>
          <tbody>${rows.slice(0, 200).map((x) => `<tr${x.won ? ' class="l1"' : ''}>
            <td>${x.r._award ? esc(shortDate.format(new Date(x.r._award))) : ''}</td>
            <td><div class="item-name">${esc(x.r.title)}</div><small>${esc([x.r.district, x.r.dept].filter(Boolean).join(' · '))}</small></td>
            <td>${x.won ? '<b>Won</b>' : x.mine?.rank ? `L${x.mine.rank}` : ''}${!x.won && x.r.winner ? `<small>Winner: <button type="button" class="linkish" data-contractor="${esc(x.r.winner)}">${esc(x.r.winner)}</button></small>` : ''}</td>
            <td class="n">${x.mine?.amount ? money(x.mine.amount) : ''}</td>
            <td class="n">${x.mine?.pct === null || x.mine?.pct === undefined ? '' : (x.mine.pct > 0 ? '+' : '') + x.mine.pct.toFixed(1) + '%'}</td>
          </tr>`).join('')}</tbody>
        </table></div>${rows.length > 200 ? '<p class="note">Showing the latest 200.</p>' : ''}</section>
      </div>`;
    d.setAttribute('aria-hidden', 'false');
    d.classList.add('open');
    document.body.style.overflow = 'hidden';
    d.scrollTop = 0;
    d.querySelector('[data-close]').focus();
    const hash = '#c=' + encodeURIComponent(display);
    if (location.hash !== hash) history.pushState({ contractor: display }, '', hash);
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
    else if (key === 'forMe') S.forMe = false;
    else if (key === 'fClosing') { $('fClosing').value = ''; S.soon = 0; }
    else if ($(key)) $(key).value = '';
    apply({ keepScroll: true });
  }

  function reset() {
    S.cat = 'ALL'; S.soon = 0; S.savedOnly = false; S.forMe = false; S.q = '';
    $('q').value = '';
    for (const id of ['fDistrict', 'fDept', 'fValue', 'fClosing', 'fAccess']) $(id).value = '';
    $('fSort').value = 'new';
    apply();
  }

  // ---------- Events ----------
  let qTimer;
  $('q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      if (R.mode === 'results') { R.q = e.target.value; applyResults(); return; }
      S.q = e.target.value; apply({ keepScroll: true });
    }, 140);
  });
  for (const id of ['fDistrict', 'fDept', 'fValue', 'fAccess', 'fSort']) $(id).addEventListener('change', () => apply({ keepScroll: true }));
  $('fClosing').addEventListener('change', () => { S.soon = 0; apply({ keepScroll: true }); });
  document.querySelectorAll('.stat[data-cat]').forEach((el) => el.addEventListener('click', () => {
    S.cat = el.dataset.cat; S.soon = 0; $('fClosing').value = ''; apply();
  }));
  document.querySelector('.stat.soon').addEventListener('click', () => {
    S.soon = S.soon === 7 ? 0 : 7; $('fClosing').value = ''; if (S.soon) $('fSort').value = 'closing'; apply();
  });
  $('forMeBtn').addEventListener('click', () => {
    if (!S.profile) { openProfile(); return; }
    S.forMe = !S.forMe;
    apply({ keepScroll: true });
    if (S.forMe) toast(`${fmtInt(S.filtered.length)} tenders for you · long-press or right-click “For me” to edit`);
  });
  $('forMeBtn').addEventListener('contextmenu', (e) => { e.preventDefault(); openProfile(); });
  let pressTimer;
  $('forMeBtn').addEventListener('touchstart', () => { pressTimer = setTimeout(openProfile, 600); }, { passive: true });
  $('forMeBtn').addEventListener('touchend', () => clearTimeout(pressTimer));
  $('profileForm').addEventListener('submit', saveProfile);
  $('pClear').addEventListener('click', () => {
    S.profile = null; S.forMe = false;
    try { localStorage.removeItem(PROFILE_KEY); } catch {}
    $('profileDialog').close(); apply();
  });
  $('profileDialog').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('profileDialog').close(); });
  $('savedBtn').addEventListener('click', () => { S.savedOnly = !S.savedOnly; apply({ keepScroll: true }); });
  $('resetBtn').addEventListener('click', reset);
  $('exportBtn').addEventListener('click', exportCsv);
  $('moreBtn').addEventListener('click', renderMore);
  function setView(view) {
    const list = view === 'list';
    $('grid').classList.toggle('list', list);
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === (list ? 'list' : 'cards'))));
    writeJSON(VIEW_KEY, list ? 'list' : 'cards');
  }
  setView(readJSON(VIEW_KEY, 'cards'));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  for (const id of ['rCat', 'rDistrict', 'rDept', 'rWork', 'rSort']) $(id).addEventListener('change', applyResults);
  $('rMore').addEventListener('click', moreResults);
  $('rReset').addEventListener('click', () => {
    for (const id of ['rCat', 'rDistrict', 'rDept', 'rWork']) $(id).value = '';
    $('rSort').value = 'new'; R.q = ''; $('q').value = ''; applyResults();
  });
  $('resultsView').addEventListener('click', (e) => {
    const w = e.target.closest('[data-win]');
    if (!w) return;
    e.preventDefault();
    openContractor(w.dataset.win);
  });
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && !$('rMore').hidden && R.mode === 'results') moreResults();
  }, { rootMargin: '600px' }).observe($('rMore'));
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-clear]'); if (b) clearFilter(b.dataset.clear); });
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
    const who = e.target.closest('[data-contractor]');
    if (who) { e.preventDefault(); openContractor(who.dataset.contractor); return; }
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
    const c = location.hash.match(/^#c=(.+)$/);
    if (m && S.byId.has(decodeURIComponent(m[1]))) openTender(decodeURIComponent(m[1]));
    else if (c) openContractor(decodeURIComponent(c[1]));
    else closeDrawer({ fromHistory: true });
  });

  // Auto-load the next page when the "Show more" button scrolls into view.
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && !$('moreBtn').hidden) renderMore();
  }, { rootMargin: '600px' }).observe($('moreBtn'));
  new IntersectionObserver(([en]) => $('filters').classList.toggle('stuck', en.intersectionRatio < 1), { threshold: [1], rootMargin: '-1px 0px 0px 0px' }).observe($('filters'));


  const deepContractor = location.hash.match(/^#c=(.+)$/);
  if (deepContractor) {
    history.replaceState(null, '', location.pathname);
    openContractor(decodeURIComponent(deepContractor[1]));
  }
  load().then(() => {
    const m = location.hash.match(/^#t=(.+)$/);
    if (m && S.byId.has(decodeURIComponent(m[1]))) {
      history.replaceState(null, '', location.pathname);
      openTender(decodeURIComponent(m[1]));
    }
  });
  setInterval(updateLive, 60000);
})();
