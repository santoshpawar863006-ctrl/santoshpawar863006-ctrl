'use strict';

(() => {
  const DISTRICT_RULES = [
    ['Bengaluru Rural', ['bengaluru rural', 'bangalore rural']],
    ['Bengaluru Urban', ['bengaluru urban', 'bangalore urban']],
    ['Vijayanagara', ['vijayanagara', 'vijayanagar', 'hosapete', 'hospet']],
    ['Dakshina Kannada', ['dakshina kannada', 'south canara', 'mangaluru', 'mangalore']],
    ['Uttara Kannada', ['uttara kannada', 'north canara', 'karwar']],
    ['Chikkaballapur', ['chikkaballapur', 'chikballapur', 'chikkaballapura']],
    ['Chikkamagaluru', ['chikkamagaluru', 'chikmagalur', 'chikkamagalur']],
    ['Chamarajanagar', ['chamarajanagar', 'chamarajanagara']],
    ['Kalaburagi', ['kalaburagi', 'gulbarga']],
    ['Vijayapura', ['vijayapura', 'bijapur']],
    ['Bagalkot', ['bagalkot', 'bagalkote', 'bagalakot', 'bagalakote']],
    ['Belagavi', ['belagavi', 'belgaum']],
    ['Ballari', ['ballari', 'bellary']],
    ['Shivamogga', ['shivamogga', 'shimoga']],
    ['Tumakuru', ['tumakuru', 'tumkur']],
    ['Ramanagara', ['ramanagara', 'ramanagaram']],
    ['Davanagere', ['davanagere', 'davangere']],
    ['Mysuru', ['mysuru', 'mysore']],
    ['Bengaluru', ['bengaluru', 'bangalore']],
    ['Bidar', ['bidar']],
    ['Yadgir', ['yadgir']],
    ['Raichur', ['raichur']],
    ['Koppal', ['koppal']],
    ['Gadag', ['gadag']],
    ['Haveri', ['haveri']],
    ['Dharwad', ['dharwad']],
    ['Udupi', ['udupi']],
    ['Chitradurga', ['chitradurga']],
    ['Hassan', ['hassan']],
    ['Kodagu', ['kodagu', 'madikeri']],
    ['Mandya', ['mandya']],
    ['Kolar', ['kolar']]
  ];

  const BAGALKOT_PLACE_HINTS = [
    'mudhol', 'jamkhandi', 'jamakhandi', 'badami', 'bilagi', 'hunagund', 'hungund',
    'ilkal', 'guledgudd', 'rabakavi', 'banahatti', 'mahalingpur', 'lokapur'
  ];

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasPhrase(text, phrase) {
    const hay = ` ${normalizeText(text)} `;
    const needle = ` ${normalizeText(phrase)} `;
    return needle.trim() && hay.includes(needle);
  }

  function canonicalDistrictFromText(value) {
    const text = normalizeText(value);
    if (!text) return '';
    for (const [district, aliases] of DISTRICT_RULES) {
      if (aliases.some(alias => hasPhrase(text, alias))) return district;
    }
    if (BAGALKOT_PLACE_HINTS.some(place => hasPhrase(text, place))) return 'Bagalkot';
    return '';
  }

  function canonicalDepartmentName(value) {
    const original = String(value || '').replace(/\s+/g, ' ').trim();
    const text = normalizeText(original);
    if (!text) return '';
    if (text === 'rdpr' || (text.includes('rural development') && text.includes('panchayat raj'))) {
      return 'Rural Development and Panchayat Raj Department';
    }
    if (text === 'pwd' || text === 'kpwd' || text.includes('public works department')) {
      return 'Public Works Department';
    }
    return original;
  }

  function departmentFromTender(t) {
    const raw = t && t.raw && typeof t.raw === 'object' ? t.raw : {};
    const candidates = [
      raw.deptName, raw.departmentName, raw.department, raw.departmentNameEn,
      raw.organisationName, raw.organisation, raw.organization, raw.procuringEntity,
      t?.department
    ];
    for (const value of candidates) {
      const clean = canonicalDepartmentName(value);
      const low = normalizeText(clean);
      if (clean && low !== 'karnataka government' && low !== 'government of karnataka') return clean;
    }
    return canonicalDepartmentName(t?.department) || 'Karnataka Government';
  }

  function districtFromTender(t) {
    const raw = t && t.raw && typeof t.raw === 'object' ? t.raw : {};
    const strongFields = [
      t?.city, t?.district, raw.cityName, raw.city, raw.townName, raw.town,
      raw.districtName, raw.district, raw.talukName, raw.taluk,
      t?.location, raw.locationName, raw.location, raw.placeOfWork
    ];
    for (const value of strongFields) {
      const district = canonicalDistrictFromText(value);
      if (district) return district;
    }
    const descriptiveFields = [t?.title, raw.title, raw.description, raw.workDescription, raw.tenderDescription];
    for (const value of descriptiveFields) {
      const district = canonicalDistrictFromText(value);
      if (district) return district;
    }
    return 'Other / Unspecified';
  }

  const utils = { normalizeText, canonicalDistrictFromText, canonicalDepartmentName, districtFromTender, departmentFromTender };
  globalThis.KPPPFilterQualityUtils = utils;

  if (typeof document === 'undefined') return;

  let normalized = false;

  function sortCities(values) {
    return [...values].sort((a, b) => {
      if (a === 'Other / Unspecified') return 1;
      if (b === 'Other / Unspecified') return -1;
      return a.localeCompare(b);
    });
  }

  function installPopulationOverride() {
    if (typeof populateFilters !== 'function' || typeof fillSelect !== 'function') return false;
    populateFilters = function() {
      const cityValues = sortCities(new Set(
        state.all.map(t => String(t.derived_city || '').trim()).filter(Boolean)
      ));
      const departmentValues = [...new Set(
        state.all.map(t => String(t.department || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
      )].sort((a, b) => a.localeCompare(b));
      fillSelect('cityFilter', cityValues, 'All cities / districts');
      fillSelect('deptFilter', departmentValues, 'All departments');
    };
    return true;
  }

  function normalizeTenderData() {
    if (normalized || typeof state === 'undefined' || !Array.isArray(state.all) || !state.all.length) return false;
    installPopulationOverride();
    for (const tender of state.all) {
      tender.derived_city = districtFromTender(tender);
      tender.department = departmentFromTender(tender);
    }
    normalized = true;
    try { populateFilters(); } catch {}
    try { applyFilters(); } catch {}
    return true;
  }

  function moveTenderClassToMainFilters() {
    const field = document.querySelector('.tender-class-field');
    const grid = document.querySelector('.filter-grid');
    if (!field || !grid) return false;
    if (field.parentElement !== grid) grid.appendChild(field);
    field.classList.add('main-tender-class-field');
    return true;
  }

  function advancedActiveCount() {
    return ['valueMin','valueMax','emdMax','publishFrom','publishTo','closingFrom','closingTo']
      .filter(id => String(document.getElementById(id)?.value || '').trim()).length;
  }

  function updateAdvancedSummary() {
    const status = document.getElementById('advancedFilterSummaryStatus');
    if (!status) return;
    const count = advancedActiveCount();
    status.textContent = count ? `${count} active` : 'Value, EMD & dates';
    status.classList.toggle('active', count > 0);
  }

  function collapseAdvancedFilters() {
    if (document.getElementById('advancedFilterDropdown')) return true;
    const head = document.querySelector('.advanced-filter-head');
    const grid = document.getElementById('advancedTenderFilters');
    const preset = document.querySelector('.preset-bar');
    const filters = document.querySelector('.filters');
    if (!head || !grid || !preset || !filters) return false;

    const details = document.createElement('details');
    details.id = 'advancedFilterDropdown';
    details.className = 'advanced-filter-dropdown';
    details.innerHTML = `
      <summary>
        <span class="advanced-summary-title">⚙ Advanced Filters</span>
        <span class="advanced-summary-status" id="advancedFilterSummaryStatus">Value, EMD & dates</span>
      </summary>
      <div class="advanced-filter-content"></div>`;

    filters.insertBefore(details, head);
    const content = details.querySelector('.advanced-filter-content');
    content.appendChild(grid);
    content.appendChild(preset);
    head.remove();

    ['valueMin','valueMax','emdMax','publishFrom','publishTo','closingFrom','closingTo'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', updateAdvancedSummary);
      document.getElementById(id)?.addEventListener('change', updateAdvancedSummary);
    });
    document.getElementById('clearAdvancedBtn')?.addEventListener('click', () => setTimeout(updateAdvancedSummary, 0));
    document.getElementById('filterPreset')?.addEventListener('change', () => setTimeout(updateAdvancedSummary, 0));
    document.getElementById('resetBtn')?.addEventListener('click', () => setTimeout(updateAdvancedSummary, 0));
    updateAdvancedSummary();
    return true;
  }

  function installUi() {
    const moved = moveTenderClassToMainFilters();
    const collapsed = collapseAdvancedFilters();
    return moved && collapsed;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    installUi();
    normalizeTenderData();
    if (attempts > 120 || (normalized && document.getElementById('advancedFilterDropdown') && document.querySelector('.main-tender-class-field'))) {
      clearInterval(timer);
    }
  }, 100);

  const observer = new MutationObserver(() => {
    installUi();
    normalizeTenderData();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 15000);
})();
