'use strict';

(() => {
  const fmtAge = (hours) => {
    const n = Number(hours);
    if(!Number.isFinite(n)) return 'Unknown';
    if(n < 1) return `${Math.max(1, Math.round(n * 60))} min ago`;
    if(n < 24) return `${n.toFixed(n < 10 ? 1 : 0)} hr ago`;
    return `${(n / 24).toFixed(1)} days ago`;
  };

  function statusText(ok, good='Working', bad='Attention'){
    return `<strong class="${ok ? 'health-ok' : 'health-bad'}">${ok ? '✓ ' + good : '⚠ ' + bad}</strong>`;
  }

  function install(){
    const quickbar = document.querySelector('.quickbar');
    const sync = document.getElementById('syncText');
    if(!quickbar || !sync || document.getElementById('healthLaunch')) return;

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';
    right.style.flexWrap = 'wrap';
    sync.parentElement?.insertBefore(right, sync);
    right.appendChild(sync);

    const btn = document.createElement('button');
    btn.id = 'healthLaunch';
    btn.className = 'health-launch';
    btn.innerHTML = '<span class="health-dot"></span> System Health';
    right.appendChild(btn);

    const stale = document.createElement('div');
    stale.id = 'staleBanner';
    stale.className = 'stale-banner';
    stale.textContent = 'Tender data has not refreshed recently. Verify System Health before relying on closing dates or newly published tenders.';
    quickbar.insertAdjacentElement('afterend', stale);

    const panel = document.createElement('section');
    panel.id = 'healthPanel';
    panel.className = 'health-panel';
    panel.innerHTML = `
      <div class="health-head">
        <div><h3>System Health</h3><small id="healthChecked">Live checks run only when this panel is opened.</small></div>
        <button type="button" class="health-refresh" id="healthRefresh">Refresh</button>
      </div>
      <div class="health-grid" id="healthGrid">
        <div class="health-card"><span>Status</span><strong>Checking…</strong></div>
      </div>`;
    stale.insertAdjacentElement('afterend', panel);

    btn.addEventListener('click', () => {
      const opening = !panel.classList.contains('open');
      panel.classList.toggle('open');
      if(opening) loadLiveHealth();
    });
    panel.querySelector('#healthRefresh')?.addEventListener('click', loadLiveHealth);

    checkSnapshot();
  }

  async function checkSnapshot(){
    const btn = document.getElementById('healthLaunch');
    const stale = document.getElementById('staleBanner');
    try{
      const r = await fetch('/health.json?ts=' + Date.now(), {cache:'no-store'});
      if(!r.ok) return;
      const h = await r.json();
      const stamp = h.last_success_at || h.generated_at;
      if(!stamp) return;
      const age = (Date.now() - new Date(stamp).getTime()) / 3600000;
      if(Number.isFinite(age)){
        btn?.classList.remove('healthy','warn','bad');
        if(age <= 2) btn?.classList.add('healthy');
        else if(age <= 6) btn?.classList.add('warn');
        else btn?.classList.add('bad');
        stale?.classList.toggle('show', age > 3);
      }
    }catch{}
  }

  async function loadLiveHealth(){
    const grid = document.getElementById('healthGrid');
    const checked = document.getElementById('healthChecked');
    const btn = document.getElementById('healthLaunch');
    if(!grid) return;
    grid.innerHTML = '<div class="health-card"><span>Status</span><strong>Running live checks…</strong><small>KPPP and TenderKart are being tested.</small></div>';
    try{
      const r = await fetch('/api/system_health?ts=' + Date.now(), {cache:'no-store'});
      const h = await r.json();
      if(!h?.success) throw new Error(h?.message || 'Health check failed');
      const db = h.database || {};
      const counts = db.category_counts || {};
      const collector = db.collector || {};
      const age = db.age_hours;
      const kppp = h.kppp || {};
      const tk = h.tenderkart || {};

      grid.innerHTML = `
        <div class="health-card"><span>Overall</span>${statusText(h.overall === 'healthy','Healthy','Needs attention')}<small>Database + KPPP live connection</small></div>
        <div class="health-card"><span>KPPP Connection</span>${statusText(!!kppp.ok)}<small>${kppp.reported_works ? `KPPP currently reports ${Number(kppp.reported_works).toLocaleString('en-IN')} WORKS` : `HTTP ${kppp.http || 'unavailable'}`}</small></div>
        <div class="health-card"><span>Tender Database</span>${statusText(!!db.ok, db.status === 'fresh' ? 'Fresh' : 'Available', 'Stale')}<small>${Number(db.count || 0).toLocaleString('en-IN')} tenders • ${fmtAge(age)}</small></div>
        <div class="health-card"><span>TenderKart</span>${statusText(!!tk.ok)}<small>Public enrichment API • HTTP ${tk.http || 'unavailable'}</small></div>
        <div class="health-card"><span>WORKS</span><strong>${Number(counts.WORKS || 0).toLocaleString('en-IN')}</strong><small>Last good database</small></div>
        <div class="health-card"><span>GOODS</span><strong>${Number(counts.GOODS || 0).toLocaleString('en-IN')}</strong><small>Last good database</small></div>
        <div class="health-card"><span>SERVICES</span><strong>${Number(counts.SERVICES || 0).toLocaleString('en-IN')}</strong><small>Last good database</small></div>
        <div class="health-card"><span>Collector Protection</span><strong class="health-ok">✓ Protected</strong><small>Zero-result and abnormal count changes are blocked before Git commit.${collector.previous_count ? ` Previous total: ${Number(collector.previous_count).toLocaleString('en-IN')}.` : ''}</small></div>
        <div class="health-card"><span>BidAssist</span><strong class="health-warn">Search based</strong><small>Checked only when you press the BidAssist button.</small></div>
        <div class="health-card"><span>TendersPlus</span><strong class="health-warn">Search based</strong><small>Checked only when you press the TendersPlus button.</small></div>`;

      checked.textContent = `Checked ${new Date(h.checked_at).toLocaleString('en-IN')}`;
      btn?.classList.remove('healthy','warn','bad');
      btn?.classList.add(h.overall === 'healthy' ? 'healthy' : 'warn');
    }catch(err){
      grid.innerHTML = `<div class="health-card"><span>Health Check</span><strong class="health-bad">⚠ Unavailable</strong><small>${String(err?.message || 'Please try again.')}</small></div>`;
      btn?.classList.remove('healthy','warn');
      btn?.classList.add('bad');
    }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
