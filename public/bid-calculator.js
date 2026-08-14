'use strict';

(() => {
  const CACHE_KEY = 'kppp_bid_calculator_v1';
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  let currentKey = '';
  let lastPayload = null;
  let inflight = null;
  let chatInflight = null;
  const chatByTender = new Map();

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const money = (v, fallback = '—') => {
    const n = Number(v);
    return Number.isFinite(n) ? '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : fallback;
  };
  const pct = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
  };
  const keyOf = (t) => {
    try { return typeof tenderKey === 'function' ? tenderKey(t) : String(t?.id || t?.ref_no || ''); }
    catch { return String(t?.id || t?.ref_no || ''); }
  };
  const tenderForKey = (key) => {
    try { return Array.isArray(state?.all) ? state.all.find((t) => keyOf(t) === key) || null : null; }
    catch { return null; }
  };
  const positive = (v) => {
    const n = Number(String(v ?? '').replace(/[₹,]/g, '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
  }
  function cached(ref) {
    const item = loadCache()[ref];
    if (!item || !item.saved_at) return null;
    if (Date.now() - Number(item.saved_at) > CACHE_TTL) return null;
    return item.payload || null;
  }
  function remember(ref, payload) {
    const cache = loadCache();
    cache[ref] = { saved_at: Date.now(), payload };
    saveCache(cache);
  }

  function ensurePanel(tender) {
    const body = document.getElementById('modalBody');
    const host = document.getElementById('bidPanelHost') || body;
    if (!host || !tender) return null;

    let panel = document.getElementById('bidCalculatorPanel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'bidCalculatorPanel';
      panel.className = 'detail-section bid-calculator-panel';
      host.appendChild(panel);
    } else if (panel.parentElement !== host) {
      host.appendChild(panel);
    }

    const amount = positive(tender.amount) || positive(tender.raw?.ecv);
    panel.innerHTML = `
      <div class="bc-head">
        <div>
          <h3>Tender Bid Calculator</h3>
          <p>Estimate site cost, break-even bid, safe discount vs ECV, and target profit. Claude suggests assumptions; rupee totals are calculated locally.</p>
        </div>
        <span class="bc-badge">Contractor tool</span>
      </div>
      <div class="bc-actions">
        <button type="button" class="bc-btn primary" id="bcCalculateBtn">Calculate Bid with Claude</button>
        <button type="button" class="bc-btn" id="bcDefaultsBtn">Use Defaults (no AI)</button>
        <button type="button" class="bc-btn secondary" id="bcRecalcBtn" hidden>Recalculate from edits</button>
      </div>
      <div class="bc-status" id="bcStatus">${amount ? 'Click Calculate Bid with Claude to generate a planning estimate for this tender.' : 'Tender value is missing. Enter ECV manually after opening the calculator defaults.'}</div>
      <div class="bc-body" id="bcBody"></div>
      <div class="bc-disclaimer"><strong>Important:</strong> Planning estimate only. Verify BOQ quantities, current material/labour rates, royalties, GST, machinery and site conditions before submitting a bid.</div>`;

    document.getElementById('bcCalculateBtn')?.addEventListener('click', () => runCalculate(tender, { skip_ai: false, force: true }));
    document.getElementById('bcDefaultsBtn')?.addEventListener('click', () => runCalculate(tender, { skip_ai: true }));
    document.getElementById('bcRecalcBtn')?.addEventListener('click', () => runCalculate(tender, { skip_ai: true, from_edits: true }));
    return panel;
  }

  function readEditedAssumptions() {
    return {
      direct_pct: Number(document.getElementById('bcDirect')?.value),
      overhead_pct: Number(document.getElementById('bcOverhead')?.value),
      contingency_pct: Number(document.getElementById('bcContingency')?.value),
      savings_pct: Number(document.getElementById('bcSavings')?.value),
      target_margin_pct: Number(document.getElementById('bcMargin')?.value)
    };
  }

  function tenderPayload(tender, options = {}) {
    const raw = tender.raw && typeof tender.raw === 'object' ? tender.raw : {};
    const amount = positive(document.getElementById('bcEcv')?.value)
      || positive(tender.amount)
      || positive(raw.ecv);
    const body = {
      id: tender.id || '',
      ref_no: tender.ref_no || '',
      title: tender.title || '',
      category: tender.category || 'WORKS',
      department: tender.department || '',
      location: tender.derived_city || tender.location || '',
      amount,
      emd: positive(tender.emd) || positive(raw.emdAmount) || positive(raw.emd),
      fee: positive(tender.fee) || positive(raw.tenderFee),
      closing_date: tender.closing_date || '',
      work_category: raw.workCategoryName || '',
      tender_type: raw.tenderType || '',
      inviting_strategy: raw.invitingStrategy || '',
      skip_ai: Boolean(options.skip_ai)
    };
    if (options.from_edits || options.assumptions) {
      body.assumptions = options.assumptions || readEditedAssumptions();
      body.skip_ai = true;
    }
    return body;
  }

  function setBusy(busy, label) {
    const btn = document.getElementById('bcCalculateBtn');
    const defaults = document.getElementById('bcDefaultsBtn');
    const recalc = document.getElementById('bcRecalcBtn');
    const status = document.getElementById('bcStatus');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? (label || 'Calculating…') : 'Calculate Bid with Claude';
    }
    if (defaults) defaults.disabled = busy;
    if (recalc) recalc.disabled = busy;
    if (status && busy) {
      status.className = 'bc-status loading';
      status.textContent = label || 'Calculating bid…';
    }
  }

  async function runCalculate(tender, options = {}) {
    const body = tenderPayload(tender, options);
    if (!body.amount) {
      const status = document.getElementById('bcStatus');
      if (status) {
        status.className = 'bc-status warn';
        status.textContent = 'Enter a tender value (ECV) first, then calculate.';
      }
      renderEmptyEcvForm(tender);
      return;
    }

    const ref = String(body.ref_no || body.id || keyOf(tender));
    // Only reuse cache for successful AI runs. Never reuse a "key not set" fallback.
    if (!options.from_edits && !options.skip_ai && !options.force) {
      const hit = cached(ref);
      if (hit?.success && hit.ai_used === true) {
        lastPayload = hit;
        renderResult(hit, tender);
        const status = document.getElementById('bcStatus');
        if (status) {
          status.className = 'bc-status info';
          status.textContent = 'Showing cached Claude bid plan (24h). Click Calculate again after clearing cache if you want a fresh Claude run.';
        }
        return;
      }
    }

    setBusy(true, options.skip_ai ? 'Calculating with defaults…' : 'Asking Claude for assumptions…');
    try {
      if (inflight) { /* allow replace */ }
      inflight = fetch('/api/bid_calculator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      });
      const response = await inflight;
      const payload = await response.json().catch(() => ({ success: false, message: 'Invalid calculator response.' }));
      if (!response.ok || !payload.success) {
        const status = document.getElementById('bcStatus');
        if (status) {
          status.className = 'bc-status warn';
          status.textContent = payload.message || `Calculator failed (HTTP ${response.status}).`;
        }
        return;
      }
      lastPayload = payload;
      // Cache only real AI successes so a missing-key response cannot stick for 24h.
      if (!options.from_edits && payload.ai_used === true) remember(ref, payload);
      renderResult(payload, tender);
    } catch (error) {
      const status = document.getElementById('bcStatus');
      if (status) {
        status.className = 'bc-status warn';
        status.textContent = `Calculator unavailable: ${String(error).slice(0, 140)}`;
      }
    } finally {
      inflight = null;
      setBusy(false);
    }
  }

  function renderEmptyEcvForm(tender) {
    const body = document.getElementById('bcBody');
    if (!body) return;
    body.innerHTML = `
      <div class="bc-layout">
        <div class="bc-card">
          <h4>Enter tender value</h4>
          <div class="bc-input-grid">
            <label><span>Tender Value / ECV (₹)</span><input id="bcEcv" type="number" min="0" step="1000" placeholder="e.g. 1000000"></label>
          </div>
        </div>
      </div>`;
  }

  function metric(label, value, small) {
    return `<div class="bc-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(small || '')}</small></div>`;
  }

  function renderResult(payload, tender) {
    const body = document.getElementById('bcBody');
    const status = document.getElementById('bcStatus');
    const recalc = document.getElementById('bcRecalcBtn');
    if (!body || !status) return;

    const a = payload.assumptions || {};
    const r = payload.results || {};
    status.className = 'bc-status ' + (payload.ai_used ? 'ok' : 'info');
    status.textContent = payload.ai_message || (payload.ai_used ? 'Claude assumptions ready.' : 'Defaults used.');
    if (recalc) recalc.hidden = false;

    const scenarios = Array.isArray(payload.scenarios) ? payload.scenarios : [];
    const risks = [...(payload.risks || []), ...(payload.warnings || [])];

    body.innerHTML = `
      <div class="bc-layout">
        <div class="bc-card">
          <h4>Cost assumptions</h4>
          <div class="bc-input-grid">
            <label><span>Tender Value / ECV (₹)</span><input id="bcEcv" type="number" min="0" step="1000" value="${esc(payload.ecv ?? '')}"></label>
            <label><span>Direct execution cost (% of ECV)</span><input id="bcDirect" type="number" min="0" max="150" step="0.5" value="${esc(a.direct_pct ?? '')}"></label>
            <label><span>Site overhead (% of ECV)</span><input id="bcOverhead" type="number" min="0" max="50" step="0.5" value="${esc(a.overhead_pct ?? '')}"></label>
            <label><span>Contingency / risk (% of ECV)</span><input id="bcContingency" type="number" min="0" max="50" step="0.5" value="${esc(a.contingency_pct ?? '')}"></label>
            <label><span>Procurement saving on direct (%)</span><input id="bcSavings" type="number" min="0" max="50" step="0.5" value="${esc(a.savings_pct ?? '')}"></label>
            <label><span>Target profit margin on bid (%)</span><input id="bcMargin" type="number" min="0" max="40" step="0.5" value="${esc(a.target_margin_pct ?? '')}"></label>
          </div>
          ${a.rationale ? `<div class="bc-note">${esc(a.rationale)}</div>` : ''}
        </div>
        <div class="bc-card">
          <h4>Bid planning result</h4>
          <div class="bc-metrics">
            ${metric('Estimated site cost', money(r.estimated_site_cost), 'Actual modelled cost to complete')}
            ${metric('Break-even / cost-to-cost', money(r.break_even_bid), 'Below this = modelled loss')}
            ${metric('Target bid', money(r.target_bid), 'At your target profit margin')}
            ${metric('Expected profit', money(r.expected_profit), pct(a.target_margin_pct) + ' margin on target bid')}
            ${metric('Target discount vs ECV', pct(r.target_discount_vs_ecv_pct), r.target_discount_vs_ecv_pct >= 0 ? 'Bid below ECV' : 'Bid above ECV')}
            ${metric('Max discount at break-even', pct(r.max_safe_discount_pct), 'Before modelled profit turns negative')}
            ${metric('Cost share of ECV', pct(r.cost_share_of_ecv_pct), 'Site cost ÷ tender value')}
            ${metric('Working capital hint', money(r.working_capital_hint), 'Rough mobilization / cash need')}
          </div>
        </div>
      </div>
      <div class="bc-scenarios">
        <h4>Bid scenarios</h4>
        <div class="bc-scenario-grid">
          ${scenarios.map((s) => `
            <div class="bc-scenario">
              <strong>${esc(s.label)}</strong>
              <span>${esc(money(s.bid))}</span>
              <small>Profit ${esc(money(s.profit))} · Discount ${esc(pct(s.discount_vs_ecv_pct))}</small>
              <em>${esc(s.note || '')}</em>
            </div>`).join('')}
        </div>
      </div>
      ${risks.length ? `<div class="bc-risks"><h4>Risks & checks</h4><ul>${risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="bc-strip">
        <span><b>Tender:</b> ${esc(payload.tender_ref || tender.ref_no || tender.id || '—')}</span>
        <span><b>Category:</b> ${esc(payload.category || tender.category || '—')}</span>
        <span><b>ECV:</b> ${esc(money(payload.ecv))}</span>
        <span><b>EMD:</b> ${esc(money(payload.emd, 'Not in feed'))}</span>
        <span><b>Claude:</b> ${payload.ai_used ? 'Used' : 'Not used'}</span>
      </div>
      <div class="bc-ask" id="bcAskBox">
        <div class="bc-ask-head">
          <h4>Ask Claude about this bid</h4>
          <p>Have a doubt after calculating? Ask about discount, profit, EMD, risk, or what to verify before bidding. Claude uses this tender + your bid plan as context.</p>
        </div>
        <div class="bc-ask-thread" id="bcAskThread"></div>
        <label class="bc-ask-label" for="bcAskInput">Your question</label>
        <textarea id="bcAskInput" rows="3" maxlength="2000" placeholder="Example: If I bid 5% below ECV, will I still keep profit? What should I check on site for this work?"></textarea>
        <div class="bc-ask-actions">
          <button type="button" class="bc-btn primary" id="bcAskBtn">Ask Claude</button>
          <button type="button" class="bc-btn secondary" id="bcAskClearBtn">Clear chat</button>
          <span class="bc-ask-status" id="bcAskStatus"></span>
        </div>
      </div>`;

    ['bcEcv', 'bcDirect', 'bcOverhead', 'bcContingency', 'bcSavings', 'bcMargin'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', () => {
        const rbtn = document.getElementById('bcRecalcBtn');
        if (rbtn) rbtn.hidden = false;
      });
    });

    bindAskBox(tender);
    renderAskThread(chatKeyFor(tender));
  }

  function chatKeyFor(tender) {
    return String(tender?.ref_no || tender?.id || keyOf(tender) || currentKey || 'unknown');
  }

  function getChat(ref) {
    if (!chatByTender.has(ref)) chatByTender.set(ref, []);
    return chatByTender.get(ref);
  }

  function renderAskThread(ref) {
    const thread = document.getElementById('bcAskThread');
    if (!thread) return;
    const turns = getChat(ref);
    if (!turns.length) {
      thread.innerHTML = '<div class="bc-ask-empty">No questions yet. Ask anything about this tender or the calculated bid plan.</div>';
      return;
    }
    thread.innerHTML = turns.map((turn) => `
      <div class="bc-ask-turn ${esc(turn.role)}">
        <strong>${turn.role === 'assistant' ? 'Claude' : 'You'}</strong>
        <div class="bc-ask-text">${esc(turn.content).replace(/\n/g, '<br>')}</div>
      </div>`).join('');
    thread.scrollTop = thread.scrollHeight;
  }

  function bindAskBox(tender) {
    const askBtn = document.getElementById('bcAskBtn');
    const clearBtn = document.getElementById('bcAskClearBtn');
    const input = document.getElementById('bcAskInput');
    if (!askBtn || !input) return;

    askBtn.onclick = () => askClaudeAboutBid(tender);
    if (clearBtn) {
      clearBtn.onclick = () => {
        const ref = chatKeyFor(tender);
        chatByTender.set(ref, []);
        renderAskThread(ref);
        const status = document.getElementById('bcAskStatus');
        if (status) status.textContent = 'Chat cleared.';
      };
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        askClaudeAboutBid(tender);
      }
    };
  }

  async function askClaudeAboutBid(tender) {
    const input = document.getElementById('bcAskInput');
    const status = document.getElementById('bcAskStatus');
    const askBtn = document.getElementById('bcAskBtn');
    const question = String(input?.value || '').trim();
    if (!question) {
      if (status) status.textContent = 'Type a question first.';
      return;
    }
    if (!lastPayload?.success) {
      if (status) status.textContent = 'Calculate the bid first, then ask follow-up questions.';
      return;
    }

    const ref = chatKeyFor(tender);
    const history = getChat(ref).slice(-6);
    const raw = tender.raw && typeof tender.raw === 'object' ? tender.raw : {};
    const body = {
      question,
      tender: {
        id: tender.id || '',
        ref_no: tender.ref_no || '',
        title: tender.title || '',
        category: tender.category || '',
        department: tender.department || '',
        location: tender.derived_city || tender.location || '',
        amount: lastPayload.ecv || tender.amount || null,
        emd: lastPayload.emd || tender.emd || null,
        fee: tender.fee || null,
        closing_date: tender.closing_date || '',
        work_category: raw.workCategoryName || '',
        tender_type: raw.tenderType || '',
        inviting_strategy: raw.invitingStrategy || ''
      },
      bid_plan: {
        assumptions: lastPayload.assumptions || null,
        results: lastPayload.results || null,
        scenarios: lastPayload.scenarios || null,
        risks: lastPayload.risks || null,
        warnings: lastPayload.warnings || null,
        ai_message: lastPayload.ai_message || null
      },
      history
    };

    if (askBtn) {
      askBtn.disabled = true;
      askBtn.textContent = 'Asking…';
    }
    if (status) status.textContent = 'Claude is thinking…';

    try {
      chatInflight = fetch('/api/bid_ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      });
      const response = await chatInflight;
      const payload = await response.json().catch(() => ({ success: false, message: 'Invalid chat response.' }));
      if (!response.ok || !payload.success) {
        if (status) status.textContent = payload.message || `Ask failed (HTTP ${response.status}).`;
        return;
      }
      const turns = getChat(ref);
      turns.push({ role: 'user', content: question });
      turns.push({ role: 'assistant', content: String(payload.answer || '').trim() });
      if (turns.length > 20) turns.splice(0, turns.length - 20);
      if (input) input.value = '';
      renderAskThread(ref);
      if (status) status.textContent = 'Answer ready.';
    } catch (error) {
      if (status) status.textContent = `Ask unavailable: ${String(error).slice(0, 120)}`;
    } finally {
      chatInflight = null;
      if (askBtn) {
        askBtn.disabled = false;
        askBtn.textContent = 'Ask Claude';
      }
    }
  }

  function mountForKey(key) {
    currentKey = String(key || '');
    const tender = tenderForKey(currentKey);
    if (!tender) return;
    ensurePanel(tender);
    const ref = String(tender.ref_no || tender.id || keyOf(tender));
    const hit = cached(ref);
    if (hit?.success && hit.ai_used === true) {
      lastPayload = hit;
      renderResult(hit, tender);
      const status = document.getElementById('bcStatus');
      if (status) {
        status.className = 'bc-status info';
        status.textContent = 'Showing cached Claude bid plan (24h). Click Calculate Bid with Claude to refresh.';
      }
    }
  }

  function wrapOpenDetails() {
    if (window.__bidCalculatorWrapped || typeof window.openDetails !== 'function') return false;
    const base = window.openDetails;
    window.openDetails = async function (key) {
      const result = await base(key);
      setTimeout(() => mountForKey(key), 80);
      setTimeout(() => mountForKey(key), 300);
      return result;
    };
    window.__bidCalculatorWrapped = true;
    return true;
  }

  if (!wrapOpenDetails()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (wrapOpenDetails() || tries > 50) clearInterval(timer);
    }, 100);
  }
})();
