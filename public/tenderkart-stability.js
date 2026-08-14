'use strict';

(() => {
  const hostId = 'tenderKartPrimaryHost';
  const sentinelClass = 'tk-host-sentinel';

  function host(){ return document.getElementById(hostId); }
  function body(){ return document.getElementById('modalBody'); }
  function modal(){ return document.getElementById('detailModal'); }
  function currentRef(){
    const sub = document.getElementById('modalSub')?.textContent || '';
    const parts = sub.split('•').map(x => x.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[1] : '';
  }
  function sentinel(){ return body()?.querySelector('.' + sentinelClass) || null; }

  function addSentinel(){
    const b = body();
    if(!b || sentinel()) return;
    const mark = document.createElement('div');
    mark.className = 'tk-primary-section ' + sentinelClass;
    mark.hidden = true;
    mark.setAttribute('aria-hidden','true');
    b.prepend(mark);
  }

  function stabilize(){
    const h = host();
    const b = body();
    if(!h || !b || !modal()?.classList.contains('open')) return;

    const ref = currentRef();
    const live = [...b.querySelectorAll('.tk-primary-section')].find(el => !el.classList.contains(sentinelClass));

    if(live){
      h.replaceChildren(live);
      h.dataset.tenderRef = ref;
      addSentinel();
      return;
    }

    if(h.children.length && h.dataset.tenderRef === ref){
      addSentinel();
    }
  }

  function resetForNextTender(){
    const h = host();
    if(h){
      h.replaceChildren();
      delete h.dataset.tenderRef;
    }
    sentinel()?.remove();
  }

  function init(){
    const b = body();
    if(!b || !host()) return;

    const observer = new MutationObserver(stabilize);
    observer.observe(b,{childList:true,subtree:false});

    const sub = document.getElementById('modalSub');
    if(sub){
      let lastRef = currentRef();
      const subObserver = new MutationObserver(() => {
        const nextRef = currentRef();
        if(nextRef && nextRef !== lastRef){
          resetForNextTender();
          lastRef = nextRef;
        }
      });
      subObserver.observe(sub,{childList:true,characterData:true,subtree:true});
    }

    document.addEventListener('click', event => {
      if(event.target.closest('[data-detail]')) resetForNextTender();
    }, true);

    stabilize();
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
