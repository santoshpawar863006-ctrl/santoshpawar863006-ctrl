'use strict';

(() => {
  const FILTER_ID = 'tenderClassFilter';
  let installed = false;
  let renderWrapped = false;

  function strategyOf(t){
    const raw = t && t.raw && typeof t.raw === 'object' ? t.raw : {};
    return String(
      raw.invitingStrategy ||
      t.invitingStrategy ||
      t.inviting_strategy ||
      ''
    ).trim().toUpperCase();
  }

  function installField(){
    if(document.getElementById(FILTER_ID)) return true;

    const advanced = document.getElementById('advancedTenderFilters');
    if(!advanced) return false;

    advanced.insertAdjacentHTML('afterbegin', `
      <div class="field tender-class-field">
        <label>TENDER CLASS</label>
        <select id="${FILTER_ID}" title="KPPP invitation strategy">
          <option value="ALL">All tender classes</option>
          <option value="OPEN">Regular Tenders</option>
          <option value="RESTRICTED">Qualified Tenders</option>
          <option value="RESERVED">Reserved Tenders</option>
        </select>
      </div>
    `);

    const select = document.getElementById(FILTER_ID);
    select?.addEventListener('change', () => {
      try { applyFilters(); } catch {}
    });

    document.getElementById('resetBtn')?.addEventListener('click', () => {
      if(select) select.value = 'ALL';
      setTimeout(() => { try { applyFilters(); } catch {} }, 0);
    });

    return true;
  }

  function wrapRender(){
    if(renderWrapped || typeof render !== 'function') return;
    const baseRender = render;
    render = function(){
      const wanted = document.getElementById(FILTER_ID)?.value || 'ALL';
      if(wanted !== 'ALL' && typeof state !== 'undefined' && Array.isArray(state.filtered)){
        state.filtered = state.filtered.filter(t => strategyOf(t) === wanted);
      }
      return baseRender();
    };
    renderWrapped = true;
  }


  function install(){
    wrapRender();
    const fieldReady = installField();
    installed = fieldReady && renderWrapped;
    return installed;
  }

  if(!install()){
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if(install() || attempts > 80) clearInterval(timer);
    }, 100);
  }
})();
