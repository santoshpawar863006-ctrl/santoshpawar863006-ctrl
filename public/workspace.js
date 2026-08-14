'use strict';

(() => {
  const RECENT_KEY = 'kppp_recent_tenders_v1';
  const NOTES_KEY = 'kppp_tender_notes_v1';
  const PRESET_KEY = 'kppp_filter_presets_v1';
  const MAX_RECENT = 50;

  let viewMode = 'ALL';
  let currentDetailKey = '';

  const readJSON = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  };
  const saveJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  function injectWorkspace(){
    const quick = document.querySelector('.quick-cats');
    if(quick && !document.getElementById('savedViewBtn')){
      quick.insertAdjacentHTML('beforeend', `
        <button id="savedViewBtn" class="workspace-view" type="button">♥ Saved <span id="savedViewCount">0</span></button>
        <button id="closingViewBtn" class="workspace-view" type="button">⏳ Closing ≤ 7 Days <span id="closingViewCount">0</span></button>
        <button id="recentViewBtn" class="workspace-view" type="button">◷ Recently Viewed <span id="recentViewCount">0</span></button>
      `);
    }

    const filters = document.querySelector('.filters');
    if(filters && !document.getElementById('advancedTenderFilters')){
      filters.insertAdjacentHTML('beforeend', `
        <div class="advanced-filter-head">
          <strong>Advanced Filters</strong>
          <span>Combine value, EMD and date filters</span>
        </div>
        <div class="advanced-filter-grid" id="advancedTenderFilters">
          <div class="field"><label>MIN TENDER VALUE ₹</label><input id="valueMin" type="number" min="0" step="1000" placeholder="e.g. 500000"></div>
          <div class="field"><label>MAX TENDER VALUE ₹</label><input id="valueMax" type="number" min="0" step="1000" placeholder="e.g. 5000000"></div>
          <div class="field"><label>MAX EMD ₹</label><input id="emdMax" type="number" min="0" step="1000" placeholder="e.g. 100000"></div>
          <div class="field"><label>PUBLISHED FROM</label><input id="publishFrom" type="date"></div>
          <div class="field"><label>PUBLISHED TO</label><input id="publishTo" type="date"></div>
          <div class="field"><label>CLOSING FROM</label><input id="closingFrom" type="date"></div>
          <div class="field"><label>CLOSING TO</label><input id="closingTo" type="date"></div>
        </div>
        <div class="preset-bar">
          <div class="preset-select-wrap">
            <label for="filterPreset">SAVED FILTER PRESET</label>
            <select id="filterPreset"><option value="">Choose a preset…</option></select>
          </div>
          <button id="savePresetBtn" class="workspace-action" type="button">＋ Save Current Filters</button>
          <button id="deletePresetBtn" class="workspace-action secondary" type="button">Delete Preset</button>
          <button id="clearAdvancedBtn" class="workspace-action secondary" type="button">Clear Advanced</button>
        </div>
      `);
    }

    refreshPresetSelect();
    bindWorkspaceEvents();
    refreshWorkspaceCounts();
  }

  function numericInput(id){
    const el = document.getElementById(id);
    if(!el || el.value === '') return null;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  }

  function dateInput(id, endOfDay=false){
    const v = document.getElementById(id)?.value;
    if(!v) return null;
    const d = new Date(v + (endOfDay ? 'T23:59:59' : 'T00:00:00'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function recentKeys(){
    const list = readJSON(RECENT_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function rememberRecent(key){
    if(!key) return;
    const next = [key, ...recentKeys().filter(k => k !== key)].slice(0, MAX_RECENT);
    saveJSON(RECENT_KEY, next);
    refreshWorkspaceCounts();
  }

  function viewLabel(){
    if(viewMode === 'SAVED') return 'Saved tenders';
    if(viewMode === 'SOON') return 'Tenders closing within 7 days';
    if(viewMode === 'RECENT') return 'Recently viewed tenders';
    return 'tenders';
  }

  function enhancedApplyFilters(){
    const q = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
    const cat = document.getElementById('categoryFilter')?.value || 'ALL';
    const city = document.getElementById('cityFilter')?.value || 'ALL';
    const dept = document.getElementById('deptFilter')?.value || 'ALL';

    const valueMin = numericInput('valueMin');
    const valueMax = numericInput('valueMax');
    const emdMax = numericInput('emdMax');
    const publishFrom = dateInput('publishFrom');
    const publishTo = dateInput('publishTo', true);
    const closingFrom = dateInput('closingFrom');
    const closingTo = dateInput('closingTo', true);
    const recent = recentKeys();
    const recentSet = new Set(recent);

    state.filtered = state.all.filter(t => {
      const key = tenderKey(t);
      if(viewMode === 'SAVED' && !state.saved.has(key)) return false;
      if(viewMode === 'SOON' && !closingSoon(t.closing_date)) return false;
      if(viewMode === 'RECENT' && !recentSet.has(key)) return false;

      if(cat !== 'ALL' && String(t.category || '').toUpperCase() !== cat) return false;
      if(city !== 'ALL' && t.derived_city !== city) return false;
      if(dept !== 'ALL' && String(t.department || '') !== dept) return false;

      const value = num(t.amount);
      const emd = num(t.emd);
      if(valueMin !== null && (value === null || value < valueMin)) return false;
      if(valueMax !== null && (value === null || value > valueMax)) return false;
      if(emdMax !== null && (emd === null || emd > emdMax)) return false;

      const published = parseDate(t.published_date);
      const closing = parseDate(t.closing_date);
      if(publishFrom && (!published || published < publishFrom)) return false;
      if(publishTo && (!published || published > publishTo)) return false;
      if(closingFrom && (!closing || closing < closingFrom)) return false;
      if(closingTo && (!closing || closing > closingTo)) return false;

      if(q){
        const hay = [t.title,t.ref_no,t.id,t.department,t.location,t.district,t.city,t.derived_city,t.category,t.status,t.status_text]
          .filter(Boolean).join(' ').toLowerCase();
        if(!hay.includes(q)) return false;
      }
      return true;
    });

    sortFiltered();
    if(viewMode === 'RECENT'){
      const order = new Map(recent.map((k,i) => [k,i]));
      state.filtered.sort((a,b) => (order.get(tenderKey(a)) ?? 9999) - (order.get(tenderKey(b)) ?? 9999));
    }
    state.page = 1;
    render();
    const result = document.getElementById('resultCount');
    if(result) result.textContent = `${fmt(state.filtered.length)} ${viewLabel()} found`;
    refreshWorkspaceCounts();
    updateViewButtons();
  }

  const originalApplyFilters = applyFilters;
  applyFilters = enhancedApplyFilters;

  const originalToggleSaved = toggleSaved;
  toggleSaved = function(key){
    originalToggleSaved(key);
    if(viewMode === 'SAVED') enhancedApplyFilters();
    refreshWorkspaceCounts();
  };

  const originalOpenDetails = openDetails;
  openDetails = async function(key){
    currentDetailKey = key;
    rememberRecent(key);
    await originalOpenDetails(key);
    appendPersonalWorkspace(key);
  };

  function updateViewButtons(){
    document.querySelectorAll('.workspace-view').forEach(btn => btn.classList.remove('active'));
    if(viewMode === 'SAVED') document.getElementById('savedViewBtn')?.classList.add('active');
    if(viewMode === 'SOON') document.getElementById('closingViewBtn')?.classList.add('active');
    if(viewMode === 'RECENT') document.getElementById('recentViewBtn')?.classList.add('active');
  }

  function refreshWorkspaceCounts(){
    const saved = document.getElementById('savedViewCount');
    const soon = document.getElementById('closingViewCount');
    const recent = document.getElementById('recentViewCount');
    if(saved) saved.textContent = state.saved.size;
    if(soon) soon.textContent = state.all.filter(t => closingSoon(t.closing_date)).length;
    if(recent) recent.textContent = recentKeys().filter(k => state.all.some(t => tenderKey(t) === k)).length;
  }

  function setView(mode){
    viewMode = viewMode === mode ? 'ALL' : mode;
    enhancedApplyFilters();
  }

  function clearAdvanced(){
    ['valueMin','valueMax','emdMax','publishFrom','publishTo','closingFrom','closingTo'].forEach(id => {
      const el = document.getElementById(id); if(el) el.value = '';
    });
    enhancedApplyFilters();
  }

  function currentPreset(){
    return {
      q: document.getElementById('searchInput')?.value || '',
      category: document.getElementById('categoryFilter')?.value || 'ALL',
      city: document.getElementById('cityFilter')?.value || 'ALL',
      department: document.getElementById('deptFilter')?.value || 'ALL',
      sort: document.getElementById('sortFilter')?.value || 'NEWEST',
      valueMin: document.getElementById('valueMin')?.value || '',
      valueMax: document.getElementById('valueMax')?.value || '',
      emdMax: document.getElementById('emdMax')?.value || '',
      publishFrom: document.getElementById('publishFrom')?.value || '',
      publishTo: document.getElementById('publishTo')?.value || '',
      closingFrom: document.getElementById('closingFrom')?.value || '',
      closingTo: document.getElementById('closingTo')?.value || '',
      viewMode,
    };
  }

  function refreshPresetSelect(selected=''){
    const select = document.getElementById('filterPreset');
    if(!select) return;
    const presets = readJSON(PRESET_KEY, {});
    const names = Object.keys(presets).sort((a,b) => a.localeCompare(b));
    select.innerHTML = '<option value="">Choose a preset…</option>' + names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    if(selected && presets[selected]) select.value = selected;
  }

  function savePreset(){
    const existing = readJSON(PRESET_KEY, {});
    const suggestion = `Filter ${Object.keys(existing).length + 1}`;
    const name = window.prompt('Name this filter preset:', suggestion)?.trim();
    if(!name) return;
    existing[name] = currentPreset();
    saveJSON(PRESET_KEY, existing);
    refreshPresetSelect(name);
  }

  function applyPreset(name){
    if(!name) return;
    const preset = readJSON(PRESET_KEY, {})[name];
    if(!preset) return;
    const set = (id,value) => { const el=document.getElementById(id); if(el && value !== undefined && value !== null) el.value=value; };
    set('searchInput',preset.q || '');
    set('categoryFilter',preset.category || 'ALL');
    set('cityFilter',preset.city || 'ALL');
    set('deptFilter',preset.department || 'ALL');
    set('sortFilter',preset.sort || 'NEWEST');
    set('valueMin',preset.valueMin || '');
    set('valueMax',preset.valueMax || '');
    set('emdMax',preset.emdMax || '');
    set('publishFrom',preset.publishFrom || '');
    set('publishTo',preset.publishTo || '');
    set('closingFrom',preset.closingFrom || '');
    set('closingTo',preset.closingTo || '');
    viewMode = preset.viewMode || 'ALL';
    enhancedApplyFilters();
  }

  function deletePreset(){
    const select = document.getElementById('filterPreset');
    const name = select?.value;
    if(!name) return;
    const presets = readJSON(PRESET_KEY, {});
    delete presets[name];
    saveJSON(PRESET_KEY, presets);
    refreshPresetSelect();
  }

  function noteMap(){
    const notes = readJSON(NOTES_KEY, {});
    return notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : {};
  }

  function appendPersonalWorkspace(key){
    const body = document.getElementById('modalBody');
    if(!body || !key) return;
    body.querySelector('.personal-tender-workspace')?.remove();
    const tender = state.all.find(t => tenderKey(t) === key);
    const note = noteMap()[key] || '';
    const isSaved = state.saved.has(key);
    body.insertAdjacentHTML('beforeend', `
      <section class="detail-section personal-tender-workspace">
        <div class="section-title"><h3>My Tender Workspace</h3><span class="count-chip">Private on this browser</span></div>
        <div class="personal-actions">
          <button id="modalSaveTender" class="workspace-action" type="button">${isSaved ? '♥ Saved Tender' : '♡ Save Tender'}</button>
          <span>${esc(tender?.ref_no || tender?.id || '')}</span>
        </div>
        <label class="note-label" for="tenderPersonalNote">My Notes</label>
        <textarea id="tenderPersonalNote" class="tender-note" rows="5" placeholder="Add internal notes, site observations, quotation reminders, eligibility checks, follow-up points…">${esc(note)}</textarea>
        <div class="note-footer"><button id="saveTenderNote" class="workspace-action" type="button">Save Note</button><span id="noteSaveStatus"></span></div>
      </section>
    `);

    document.getElementById('modalSaveTender')?.addEventListener('click', () => {
      toggleSaved(key);
      const btn = document.getElementById('modalSaveTender');
      if(btn) btn.textContent = state.saved.has(key) ? '♥ Saved Tender' : '♡ Save Tender';
    });
    document.getElementById('saveTenderNote')?.addEventListener('click', () => {
      const notes = noteMap();
      const value = document.getElementById('tenderPersonalNote')?.value.trim() || '';
      if(value) notes[key] = value; else delete notes[key];
      saveJSON(NOTES_KEY, notes);
      const status = document.getElementById('noteSaveStatus');
      if(status){
        status.textContent = value ? 'Saved' : 'Note cleared';
        setTimeout(() => { if(status) status.textContent=''; }, 1800);
      }
    });
  }

  let workspaceBound = false;
  function bindWorkspaceEvents(){
    if(workspaceBound) return;
    workspaceBound = true;

    document.getElementById('savedViewBtn')?.addEventListener('click', () => setView('SAVED'));
    document.getElementById('closingViewBtn')?.addEventListener('click', () => setView('SOON'));
    document.getElementById('recentViewBtn')?.addEventListener('click', () => setView('RECENT'));

    ['valueMin','valueMax','emdMax','publishFrom','publishTo','closingFrom','closingTo'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', enhancedApplyFilters);
      document.getElementById(id)?.addEventListener('change', enhancedApplyFilters);
    });

    ['categoryFilter','cityFilter','deptFilter','sortFilter'].forEach(id => document.getElementById(id)?.addEventListener('change', enhancedApplyFilters));
    document.getElementById('searchInput')?.addEventListener('input', () => setTimeout(enhancedApplyFilters, 190));
    document.getElementById('clearAdvancedBtn')?.addEventListener('click', clearAdvanced);
    document.getElementById('savePresetBtn')?.addEventListener('click', savePreset);
    document.getElementById('deletePresetBtn')?.addEventListener('click', deletePreset);
    document.getElementById('filterPreset')?.addEventListener('change', e => applyPreset(e.target.value));
    document.getElementById('resetBtn')?.addEventListener('click', () => {
      viewMode = 'ALL';
      ['valueMin','valueMax','emdMax','publishFrom','publishTo','closingFrom','closingTo'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
      setTimeout(enhancedApplyFilters, 0);
    });
  }

  injectWorkspace();

  const waitForData = setInterval(() => {
    if(state.all.length){
      clearInterval(waitForData);
      refreshWorkspaceCounts();
      enhancedApplyFilters();
    }
  }, 250);
})();
