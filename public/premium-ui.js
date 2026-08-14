'use strict';

(() => {
  const VIEW_KEY='kppp_ui_view_v2';
  const COLLAPSE_KEY='kppp_filter_collapsed_v2';
  const labels=['Save','Category','Tender','Department / Location','Tender Value','EMD','Closing','Status','Actions'];

  const q=(s,r=document)=>r.querySelector(s);
  const qa=(s,r=document)=>[...r.querySelectorAll(s)];

  function toast(message){
    let el=q('#uiToast');
    if(!el){
      el=document.createElement('div');el.id='uiToast';el.className='ui-toast';document.body.appendChild(el);
    }
    el.textContent=message;el.classList.add('show');
    clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),1800);
  }

  function setCellLabels(){
    qa('#tableBody tr').forEach(row=>qa('td',row).forEach((cell,i)=>{if(labels[i]) cell.dataset.label=labels[i];}));
  }

  function updateActiveFilters(){
    const checks=[
      ['searchInput',v=>v.trim()!=='' ],
      ['categoryFilter',v=>v!=='ALL'],
      ['cityFilter',v=>v!=='ALL'],
      ['deptFilter',v=>v!=='ALL'],
      ['valueMin',v=>v!=='' ],['valueMax',v=>v!=='' ],['emdMax',v=>v!=='' ],
      ['publishFrom',v=>v!=='' ],['publishTo',v=>v!=='' ],['closingFrom',v=>v!=='' ],['closingTo',v=>v!=='']
    ];
    let count=0;
    checks.forEach(([id,test])=>{const el=document.getElementById(id);if(el&&test(String(el.value||'')))count++;});
    const badge=q('#activeFilterCount');
    if(badge){badge.textContent=count;badge.classList.toggle('show',count>0);badge.title=count?`${count} active filter${count===1?'':'s'}`:'No active filters';}
  }

  function setView(view){
    const results=q('#resultsPanel');if(!results)return;
    const cards=view==='cards';
    results.classList.toggle('view-cards',cards);
    q('#viewCardsBtn')?.classList.toggle('active',cards);
    q('#viewTableBtn')?.classList.toggle('active',!cards);
    try{localStorage.setItem(VIEW_KEY,cards?'cards':'table');}catch{}
    setCellLabels();
  }

  function setFilterCollapsed(collapsed){
    const filters=q('#filterPanel');if(!filters)return;
    filters.classList.toggle('is-collapsed',collapsed);
    const btn=q('#filterCollapseBtn');
    if(btn){btn.textContent=collapsed?'Show filters':'Hide filters';btn.setAttribute('aria-expanded',collapsed?'false':'true');}
    try{localStorage.setItem(COLLAPSE_KEY,collapsed?'1':'0');}catch{}
  }

  function scrollTo(id){q(id)?.scrollIntoView({behavior:'smooth',block:'start'});}

  function forwardClick(selector,fallback){
    const target=q(selector);
    if(target){target.click();return true;}
    if(fallback) fallback();
    return false;
  }

  function bindNav(){
    qa('[data-ui-nav]').forEach(btn=>btn.addEventListener('click',()=>{
      const action=btn.dataset.uiNav;
      if(action==='dashboard') scrollTo('#dashboardStats');
      else if(action==='live') scrollTo('#resultsPanel');
      else if(action==='saved') forwardClick('#savedViewBtn',()=>scrollTo('#resultsPanel'));
      else if(action==='closing') forwardClick('#closingViewBtn',()=>scrollTo('#resultsPanel'));
      else if(action==='analytics'){
        scrollTo('#analysisToolbar');
        setTimeout(()=>{const panel=q('#analyticsPanel');if(panel?.hidden) q('#analyticsToggle')?.click();},350);
      }
    }));
  }

  function bindStats(){
    const cards=qa('#dashboardStats .stat');
    const actions=[
      ()=>{const c=q('#categoryFilter');if(c){c.value='ALL';try{applyFilters();}catch{}scrollTo('#resultsPanel');}},
      ()=>{const c=q('#categoryFilter');if(c){c.value='WORKS';try{applyFilters();}catch{}scrollTo('#resultsPanel');}},
      ()=>{const c=q('#categoryFilter');if(c){c.value='GOODS';try{applyFilters();}catch{}scrollTo('#resultsPanel');}},
      ()=>{const c=q('#categoryFilter');if(c){c.value='SERVICES';try{applyFilters();}catch{}scrollTo('#resultsPanel');}},
      ()=>forwardClick('#closingViewBtn',()=>scrollTo('#resultsPanel')),
      ()=>forwardClick('#savedViewBtn',()=>scrollTo('#resultsPanel'))
    ];
    cards.forEach((card,i)=>{
      card.setAttribute('role','button');card.setAttribute('tabindex','0');
      const run=()=>actions[i]?.();
      card.addEventListener('click',run);
      card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();run();}});
    });
  }

  function bindFilters(){
    q('#filterCollapseBtn')?.addEventListener('click',()=>setFilterCollapsed(!q('#filterPanel')?.classList.contains('is-collapsed')));
    q('#resetBtn')?.addEventListener('click',()=>setTimeout(()=>{updateActiveFilters();toast('Filters cleared');},30));
    document.addEventListener('input',e=>{if(e.target.closest('#filterPanel'))updateActiveFilters();});
    document.addEventListener('change',e=>{if(e.target.closest('#filterPanel'))updateActiveFilters();});
  }

  function bindView(){
    q('#viewTableBtn')?.addEventListener('click',()=>setView('table'));
    q('#viewCardsBtn')?.addEventListener('click',()=>setView('cards'));
    let saved='table';try{saved=localStorage.getItem(VIEW_KEY)||'table';}catch{}
    setView(saved);
  }

  function bindSearch(){
    const focus=()=>{
      const filters=q('#filterPanel');if(filters?.classList.contains('is-collapsed'))setFilterCollapsed(false);
      scrollTo('#filterPanel');setTimeout(()=>q('#searchInput')?.focus(),300);
    };
    q('#uiSearchJump')?.addEventListener('click',focus);
    document.addEventListener('keydown',e=>{
      const tag=(document.activeElement?.tagName||'').toLowerCase();
      const typing=['input','textarea','select'].includes(tag);
      if(e.key==='/'&&!typing){e.preventDefault();focus();}
      if(e.key==='Escape'&&document.activeElement?.id==='searchInput') document.activeElement.blur();
    });
  }

  function bindBackToTop(){
    const btn=q('#backToTop');if(!btn)return;
    const update=()=>btn.classList.toggle('show',window.scrollY>520);
    window.addEventListener('scroll',update,{passive:true});update();
    btn.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
  }

  function observeDynamicUI(){
    const observer=new MutationObserver(()=>{
      setCellLabels();updateActiveFilters();
    });
    observer.observe(document.body,{childList:true,subtree:true});
  }

  function enhanceSync(){
    const sync=q('#syncText');if(!sync)return;
    const observer=new MutationObserver(()=>{
      if(sync.textContent.includes('Last KPPP sync')) sync.title='Tender data is synchronized automatically from KPPP';
    });
    observer.observe(sync,{childList:true,characterData:true,subtree:true});
  }

  function init(){
    bindNav();bindStats();bindFilters();bindView();bindSearch();bindBackToTop();observeDynamicUI();enhanceSync();
    let collapsed=false;try{collapsed=localStorage.getItem(COLLAPSE_KEY)==='1';}catch{}
    setFilterCollapsed(collapsed);setCellLabels();updateActiveFilters();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
