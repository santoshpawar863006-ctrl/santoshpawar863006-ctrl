import * as C from './core.js';
import { PlanView, planToPng } from './plan2d.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const KEY = 'nivas-planner-v1';
const FLOOR_SHORT = ['Ground', 'First', 'Second', 'Third'];
const PRESETS = [[20, 30], [30, 40], [30, 50], [40, 60], [50, 80]];

const state = {
  unit: 'ft',
  brief: { ...C.DEFAULT_BRIEF },
  plan: null,
  edited: false,
  floor: 0,
  selected: null,
  view: 'plan',
  quality: 'standard',
  rate: C.QUALITY.standard.rate,
  modelMode: 'full',
};

// ---------- persistence & history ----------

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      unit: state.unit, brief: state.brief, plan: state.plan, edited: state.edited,
      quality: state.quality, rate: state.rate, view: state.view,
    }));
  } catch { /* storage unavailable: the plan still works for this visit */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s?.plan?.floors?.length && s.brief) {
      Object.assign(state, { unit: s.unit || 'ft', brief: { ...C.DEFAULT_BRIEF, ...s.brief }, plan: s.plan, edited: !!s.edited, quality: s.quality || 'standard', rate: s.rate || C.QUALITY.standard.rate, view: s.view || 'plan' });
    }
  } catch { /* ignore */ }
}

const snap = () => JSON.stringify({ brief: state.brief, plan: state.plan, edited: state.edited });
let past = [], future = [], current = null;

function commit() {
  const s = snap();
  if (s === current) return;
  if (current) past.push(current);
  if (past.length > 80) past.shift();
  future = [];
  current = s;
  save();
  renderAll();
}
function restore(s) {
  const o = JSON.parse(s);
  state.brief = o.brief; state.plan = o.plan; state.edited = o.edited;
  current = s;
  if (state.floor >= state.plan.floors.length) state.floor = state.plan.floors.length - 1;
  if (!findRoom(state.selected)) state.selected = null;
  fillBrief();
  save();
  renderAll();
}
function undo() { if (past.length) { future.push(current); restore(past.pop()); toast('Undone'); } }
function redo() { if (future.length) { past.push(current); restore(future.pop()); toast('Redone'); } }

// ---------- helpers ----------

const rooms = () => state.plan.floors[state.floor].rooms;
const findRoom = (id) => id && rooms().find((r) => r.id === id);
const u = (m) => +C.toUnit(m, state.unit).toFixed(state.unit === 'm' ? 2 : 1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function generate(reason) {
  state.plan = C.generate(state.brief);
  state.edited = false;
  state.selected = null;
  state.floor = Math.min(state.floor, state.plan.floors.length - 1);
  if (model) model.needsFit = true;
  $('#generateBtn').textContent = 'Generate plan';
  commit();
  if (reason) toast(reason);
}

// ---------- brief form ----------

const NUM_FIELDS = ['plotW', 'plotD', 'setFront', 'setRear', 'setLeft', 'setRight', 'floorH'];
const CHECKS = ['parking', 'pooja', 'study', 'utility', 'balcony', 'terraceStair', 'vastu'];
const LAYOUT_KEYS = ['bhk', 'floors', 'parking', 'pooja', 'study', 'utility', 'balcony', 'terraceStair'];

function fillBrief() {
  const b = state.brief;
  for (const k of NUM_FIELDS) $(`#${k}`).value = u(b[k]);
  for (const k of CHECKS) $(`#${k}`).checked = !!b[k];
  setPressed('#facing', b.facing);
  setPressed('#bhk', String(b.bhk));
  setPressed('#floorsSeg', String(b.floors));
  $$('.u').forEach((n) => { n.textContent = state.unit; });
  $$('[data-unit]').forEach((n) => n.setAttribute('aria-pressed', String(n.dataset.unit === state.unit)));
  renderPresets();
}
function setPressed(sel, v) {
  $$(`${sel} button`).forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.v === v)));
}
function renderPresets() {
  const host = $('#presets');
  host.replaceChildren(...PRESETS.map(([w, d]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `${w}×${d}`;
    b.title = `${w} × ${d} ft site (${(w * d).toLocaleString('en-IN')} sq ft)`;
    b.setAttribute('aria-pressed', String(Math.abs(state.brief.plotW - w * C.FT) < 0.02 && Math.abs(state.brief.plotD - d * C.FT) < 0.02));
    b.addEventListener('click', () => {
      state.brief.plotW = w * C.FT; state.brief.plotD = d * C.FT;
      fillBrief();
      briefChanged(true);
    });
    return b;
  }));
}

// Layout-shaping changes regenerate the plan unless the user has hand-edited it.
function briefChanged(layout) {
  if (layout && !state.edited) { generate(); return; }
  if (layout) {
    $('#generateBtn').textContent = 'Generate plan with new brief';
    toast('Press Generate to rebuild the layout. Your edits stay until you do.');
  }
  commit();
}

function bindBrief() {
  for (const k of NUM_FIELDS) {
    $(`#${k}`).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v < 0) { fillBrief(); return; }
      state.brief[k] = C.fromUnit(v, state.unit);
      if (k === 'floorH') state.brief.floorH = Math.max(2.7, state.brief.floorH);
      if (k === 'plotW' || k === 'plotD') state.brief[k] = Math.max(4, state.brief[k]);
      renderPresets();
      briefChanged(k !== 'floorH');
    });
  }
  for (const k of CHECKS) {
    $(`#${k}`).addEventListener('change', (e) => {
      state.brief[k] = e.target.checked;
      briefChanged(LAYOUT_KEYS.includes(k) || k === 'vastu');
    });
  }
  const seg = (sel, key, num) => $$(`${sel} button`).forEach((btn) => btn.addEventListener('click', () => {
    state.brief[key] = num ? Number(btn.dataset.v) : btn.dataset.v;
    setPressed(sel, btn.dataset.v);
    briefChanged(key !== 'facing' || state.brief.vastu);
  }));
  seg('#facing', 'facing', false);
  seg('#bhk', 'bhk', true);
  seg('#floorsSeg', 'floors', true);
  $('#generateBtn').addEventListener('click', () => generate('New plan generated. Undo brings back the previous one.'));
}

// ---------- plan view ----------

const plan = new PlanView($('#planSvg'), {
  onSelect: (id) => { state.selected = id; renderPlan(); renderSide(); },
  onChange: () => { renderPlan(); renderSide(); },
  onCommit: () => { state.edited = true; commit(); },
});

function renderPlan() {
  plan.render(state, state.floor, state.selected);
}

function renderFloorTabs() {
  const host = $('#floorTabs');
  host.replaceChildren(...state.plan.floors.map((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = FLOOR_SHORT[i];
    b.setAttribute('aria-pressed', String(i === state.floor));
    b.addEventListener('click', () => {
      state.floor = i; state.selected = null;
      renderAll();
    });
    return b;
  }));
}

function addRoom() {
  const type = $('#addType').value;
  const B = C.buildable(state.brief);
  const w = type === 'bath' ? 1.5 : type === 'pooja' ? 1.5 : 3.0;
  const d = type === 'bath' ? 2.1 : type === 'pooja' ? 1.5 : 3.0;
  const list = rooms();
  let spot = null;
  for (let y = B.y; y + d <= B.y + B.d + 0.001 && !spot; y += 0.3) {
    for (let x = B.x; x + w <= B.x + B.w + 0.001 && !spot; x += 0.3) {
      if (!list.some((r) => x < r.x + r.w - 0.01 && x + w > r.x + 0.01 && y < r.y + r.d - 0.01 && y + d > r.y + 0.01)) spot = { x, y };
    }
  }
  if (!spot) spot = { x: B.x + (B.w - w) / 2, y: B.y + (B.d - d) / 2 };
  const same = list.filter((r) => r.type === type).length;
  const name = C.ROOM_TYPES[type].label + (same ? ` ${same + 1}` : '');
  const room = { id: C.newId(), type, name, x: +spot.x.toFixed(3), y: +spot.y.toFixed(3), w, d };
  list.push(room);
  state.selected = room.id;
  state.edited = true;
  commit();
  toast(`${name} added. Drag it into place.`);
}

// ---------- side panel ----------

function renderSide() {
  const a = C.areas(state.plan, state.brief);
  const est = C.estimate(state.plan, state.brief, state.rate);
  const vs = C.vastuScore(state.plan, state.brief);
  const stat = (label, value, sub = '') => `<div class="stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('#stats').innerHTML = [
    stat('Plot', C.fmtArea(a.plot, state.unit), `${u(state.brief.plotW)} × ${u(state.brief.plotD)} ${state.unit}`),
    stat('Built-up', C.fmtArea(a.builtUp, state.unit), `${state.plan.floors.length} floor${state.plan.floors.length > 1 ? 's' : ''}`),
    stat('Carpet', C.fmtArea(a.carpet, state.unit), 'inside walls'),
    stat('Est. cost', C.inrShort(est.total), `${C.QUALITY[state.quality].label} · ₹${state.rate}/sq ft`),
    stat('Coverage', `${Math.round(a.coverage * 100)}%`, `FAR ${a.far.toFixed(2)}`),
    stat('Vastu', `${vs.pct}%`, state.brief.vastu ? 'layout follows Vastu' : 'Vastu not applied'),
  ].join('');

  const r = findRoom(state.selected);
  const ed = $('#editor');
  $('#editorTitle').textContent = r ? 'Selected room' : 'Room';
  if (!r) {
    ed.innerHTML = `<p class="empty">Select a room on the plan to rename, resize or delete it, or add a new one.</p>
      <div class="add-room"><select id="addType2" aria-label="Room type to add">${typeOptions('bedroom')}</select><button type="button" class="btn small" id="addRoomBtn2">Add room</button></div>`;
    $('#addRoomBtn2').addEventListener('click', () => { $('#addType').value = $('#addType2').value; addRoom(); });
  } else {
    const unit = state.unit;
    ed.innerHTML = `
      <label class="field"><span>Name</span><input type="text" id="eName" value="${esc(r.name)}"></label>
      <label class="field"><span>Type</span><select id="eType">${typeOptions(r.type)}</select></label>
      <div class="row">
        <label class="field"><span>Width (${unit})</span><input type="number" id="eW" step="0.1" min="0.6" value="${u(r.w)}"></label>
        <label class="field"><span>Depth (${unit})</span><input type="number" id="eD" step="0.1" min="0.6" value="${u(r.d)}"></label>
      </div>
      <div class="row">
        <label class="field"><span>From left (${unit})</span><input type="number" id="eX" step="0.1" value="${u(r.x)}"></label>
        <label class="field"><span>From rear (${unit})</span><input type="number" id="eY" step="0.1" value="${u(r.y)}"></label>
      </div>
      <p class="empty">Area ${C.fmtArea(r.w * r.d, unit)} · ${C.fmtDims(r.w, r.d, unit)}</p>
      <div class="actions">
        <button type="button" class="btn small" id="eRotate">Rotate</button>
        <button type="button" class="btn small" id="eDup">Duplicate</button>
        <button type="button" class="btn small danger" id="eDel">Delete</button>
      </div>`;
    const set = (fn) => { fn(); state.edited = true; commit(); };
    $('#eName').addEventListener('change', (e) => set(() => { r.name = e.target.value.trim() || C.ROOM_TYPES[r.type].label; }));
    $('#eType').addEventListener('change', (e) => set(() => { r.type = e.target.value; }));
    const num = (id, key, min = 0.6) => $(id).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return renderSide();
      set(() => { r[key] = Math.max(key === 'w' || key === 'd' ? min : -50, +C.fromUnit(v, unit).toFixed(3)); });
    });
    num('#eW', 'w'); num('#eD', 'd'); num('#eX', 'x'); num('#eY', 'y');
    $('#eRotate').addEventListener('click', () => set(() => { [r.w, r.d] = [r.d, r.w]; }));
    $('#eDup').addEventListener('click', () => set(() => {
      const copy = { ...r, id: C.newId(), x: r.x + 0.6, y: r.y + 0.6, name: `${r.name} copy` };
      delete copy.parent;
      rooms().push(copy);
      state.selected = copy.id;
    }));
    $('#eDel').addEventListener('click', () => deleteSelected());
  }
  renderChecks();
}

function deleteSelected() {
  const r = findRoom(state.selected);
  if (!r) return;
  state.plan.floors[state.floor].rooms = rooms().filter((q) => q.id !== r.id);
  state.selected = null;
  state.edited = true;
  commit();
  toast(`${r.name} deleted. Undo to bring it back.`);
}

function typeOptions(sel) {
  return Object.entries(C.ROOM_TYPES).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v.label}</option>`).join('');
}

// NBC 2016 (Part 3) minimums for residential rooms, plus layout sanity checks.
const NBC = {
  master: { area: 9.5, w: 2.4, label: 'habitable room' }, bedroom: { area: 9.5, w: 2.4, label: 'habitable room' },
  living: { area: 9.5, w: 2.4, label: 'habitable room' }, study: { area: 7.5, w: 2.1, label: 'habitable room' },
  kitchen: { area: 5.0, w: 1.8, label: 'kitchen' }, bath: { area: 1.8, w: 1.2, label: 'bathroom' },
  stair: { area: 0, w: 1.9, label: 'dog-legged stair (2 × 0.9 m flights)' },
};

function problems() {
  const out = [];
  const B = C.buildable(state.brief);
  state.plan.floors.forEach((f, fi) => {
    const where = state.plan.floors.length > 1 ? ` (${FLOOR_SHORT[fi]})` : '';
    for (const [a, b] of C.overlaps(f.rooms)) out.push({ status: 'bad', text: `${a.name} overlaps ${b.name}${where}` });
    const { doors } = C.openings(f.rooms, fi === 0);
    for (const r of f.rooms) {
      const n = NBC[r.type];
      if (n && (r.w * r.d < n.area - 0.01 || Math.min(r.w, r.d) < n.w - 0.01)) {
        out.push({ status: 'ok', text: `${r.name}${where} is below the NBC minimum for a ${n.label} (${n.area ? `${C.fmtArea(n.area, state.unit)}, ` : ''}${C.fmtLen(n.w, state.unit)} wide)` });
      }
      const outside = r.type !== 'balcony' && r.type !== 'parking' && (r.x < B.x - 0.02 || r.y < B.y - 0.02 || r.x + r.w > B.x + B.w + 0.02 || r.y + r.d > B.y + B.d + 0.02);
      if (outside) out.push({ status: 'bad', text: `${r.name}${where} crosses the setback line` });
      if (r.x < -0.01 || r.y < -0.01 || r.x + r.w > state.brief.plotW + 0.01 || r.y + r.d > state.brief.plotD + 0.01) out.push({ status: 'bad', text: `${r.name}${where} is outside the plot` });
      if (!doors.some((d) => d.rooms.includes(r.id))) out.push({ status: 'ok', text: `${r.name}${where} has no door. Place it against a hall or its parent room.` });
    }
  });
  if (state.brief.floorH < 3.0) out.push({ status: 'ok', text: `Floor-to-floor height under ${C.fmtLen(3.0, state.unit)} leaves less than 2.75 m clear` });
  return out;
}

function renderChecks() {
  const list = problems();
  const host = $('#checks');
  if (!list.length) {
    host.innerHTML = '<li><span class="pill good">OK</span><span>No overlaps, every room has a door, sizes meet NBC 2016 minimums.</span></li>';
    return;
  }
  host.innerHTML = list.slice(0, 12).map((p) => `<li><span class="pill ${p.status}">${p.status === 'bad' ? 'Fix' : 'Check'}</span><span>${esc(p.text)}</span></li>`).join('')
    + (list.length > 12 ? `<li><span></span><span class="note">${list.length - 12} more</span></li>` : '');
}

// ---------- details report ----------

const FLOORING = {
  living: 'Vitrified tiles 800×800', dining: 'Vitrified tiles 800×800', lounge: 'Vitrified tiles 800×800', hall: 'Vitrified tiles 800×800',
  master: 'Laminated wood / vitrified', bedroom: 'Vitrified tiles 600×600', study: 'Vitrified tiles 600×600', dress: 'Vitrified tiles 600×600',
  kitchen: 'Anti-skid vitrified; granite counter', utility: 'Anti-skid ceramic', bath: 'Anti-skid ceramic; wall tiles to 2.1 m',
  pooja: 'Marble / granite', stair: 'Granite treads', parking: 'Paver blocks / IPS', balcony: 'Anti-skid ceramic', store: 'Ceramic tiles',
};
const DOOR_SPEC = {
  main: ['MD', 'Main door', 'Teak wood frame and shutter'],
  room: ['D1', 'Room door', 'Wood frame, flush shutter'],
  bath: ['D2', 'Toilet door', 'WPC / PVC, waterproof'],
};
const WIN_SPEC = {
  window: ['W', 'Window', 'UPVC / aluminium sliding, 3-track with mesh'],
  vent: ['V', 'Ventilator', 'Louvred glass with exhaust cut-out'],
};

function renderReport() {
  const unit = state.unit;
  const b = state.brief;
  const a = C.areas(state.plan, b);
  const est = C.estimate(state.plan, b, state.rate);
  const vs = C.vastuScore(state.plan, b);
  const sq = (m2) => C.fmtArea(m2, unit);
  const nF = state.plan.floors.length;
  const floorsLabel = nF === 1 ? 'G' : `G+${nF - 1}`;
  const facingName = { N: 'north', E: 'east', S: 'south', W: 'west' }[b.facing];

  // Doors & windows across all floors.
  const dw = new Map();
  state.plan.floors.forEach((f, fi) => {
    const { doors, windows } = C.openings(f.rooms, fi === 0);
    for (const d of doors) {
      if (d.kind === 'open') continue;
      const [code, name, spec] = DOOR_SPEC[d.kind];
      const key = `${code}|${Math.round(d.w * 100)}`;
      const row = dw.get(key) || { code, name, spec, w: d.w, h: 2.1, n: 0 };
      row.n++; dw.set(key, row);
    }
    for (const w of windows) {
      const [code, name, spec] = WIN_SPEC[w.kind];
      const key = `${code}|${Math.round(w.w * 100)}`;
      const row = dw.get(key) || { code, name, spec, w: w.w, h: w.head - w.sill, n: 0 };
      row.n++; dw.set(key, row);
    }
  });
  const dwRows = [...dw.values()].sort((p, q) => p.code.localeCompare(q.code) || q.w - p.w);
  const mm = (m) => Math.round(m * 1000);

  const maxShare = Math.max(...est.split.map((s) => s.share));
  $('#report').innerHTML = `
    <header>
      <h1>${b.bhk} BHK ${floorsLabel} house on a ${u(b.plotW)} × ${u(b.plotD)} ${unit} plot</h1>
      <p>Road on the ${facingName} side · ${state.plan.floors.reduce((n, f) => n + f.rooms.length, 0)} rooms · ${state.edited ? 'edited by you' : 'generated layout'}</p>
    </header>

    <div class="tiles">
      <div class="tile"><span>Built-up area</span><b>${sq(a.builtUp)}</b><small>all floors, balconies at half</small></div>
      <div class="tile"><span>Carpet area</span><b>${sq(a.carpet)}</b><small>${Math.round((a.carpet / a.builtUp) * 100)}% of built-up</small></div>
      <div class="tile"><span>Ground coverage</span><b>${Math.round(a.coverage * 100)}%</b><small>FAR ${a.far.toFixed(2)}</small></div>
      <div class="tile"><span>Building height</span><b>${C.fmtLen(a.height, unit)}</b><small>plinth to parapet top</small></div>
      <div class="tile"><span>Estimated cost</span><b>${C.inrShort(est.total)}</b><small>${C.QUALITY[state.quality].label} finish</small></div>
    </div>

    <section class="sec">
      <h2>Area statement</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Floor</th><th class="num">Built-up</th><th class="num">Carpet</th><th class="num">Balcony</th></tr></thead>
        <tbody>${a.floors.map((f) => `<tr><td>${f.name}</td><td class="num">${sq(f.builtUp)}</td><td class="num">${sq(f.carpet)}</td><td class="num">${f.balcony ? sq(f.balcony) : '–'}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${sq(a.builtUp)}</td><td class="num">${sq(a.carpet)}</td><td class="num">${sq(a.floors.reduce((s, f) => s + f.balcony, 0))}</td></tr></tfoot>
      </table></div>
      <p>Plot ${sq(a.plot)}. Setbacks: front ${C.fmtLen(b.setFront, unit)}, rear ${C.fmtLen(b.setRear, unit)}, left ${C.fmtLen(b.setLeft, unit)}, right ${C.fmtLen(b.setRight, unit)}. Carpet area is measured inside ${mm(C.WALL)} mm walls and excludes stairs, parking and balconies.</p>
    </section>

    <section class="sec">
      <h2>Room schedule</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Room</th><th class="num">Size (${unit === 'm' ? 'm' : 'ft-in'})</th><th class="num">Area</th><th>Suggested flooring</th></tr></thead>
        <tbody>${state.plan.floors.map((f) => `<tr class="floor-row"><td colspan="4">${f.name}</td></tr>` + f.rooms.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${C.fmtDims(r.w, r.d, unit)}</td><td class="num">${sq(r.w * r.d)}</td><td>${FLOORING[r.type] || '–'}</td></tr>`).join('')).join('')}</tbody>
      </table></div>
    </section>

    <section class="sec">
      <h2>Cost estimate</h2>
      <div class="cost-head">
        <div class="field"><span>Finish</span><div class="seg" role="group" aria-label="Finish quality" id="qualitySeg">${Object.entries(C.QUALITY).map(([k, q]) => `<button type="button" data-v="${k}" aria-pressed="${k === state.quality}">${q.label}</button>`).join('')}</div></div>
        <label class="field"><span>Rate (₹ per sq ft built-up)</span><input type="number" id="rateInput" step="50" min="500" value="${state.rate}"></label>
        <div class="field"><span>Total for ${Math.round(est.sqft).toLocaleString('en-IN')} sq ft</span><div class="cost-total">${C.inr(est.total)}</div></div>
      </div>
      <p>${C.QUALITY[state.quality].note}. The rate covers civil work and finishes; it excludes land, approvals, compound wall, borewell, sump and interiors.</p>
      <div class="bars" role="table" aria-label="Cost breakdown">
        ${est.split.map((s) => `<div class="bar-row" role="row" title="${s.label}: ${C.inr(s.amount)} (${Math.round(s.share * 100)}%)"><span role="cell">${s.label}</span><div class="bar-track" role="presentation"><div class="bar-fill" style="width:${(s.share / maxShare) * 100}%"></div></div><span class="v" role="cell">${C.inrShort(s.amount)} · ${Math.round(s.share * 100)}%</span></div>`).join('')}
      </div>
    </section>

    <div class="two">
      <section class="sec">
        <h2>Materials (thumb rule)</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Material</th><th class="num">Quantity</th><th>Unit</th></tr></thead>
          <tbody>${est.materials.map((m) => `<tr><td>${m.label}</td><td class="num">${Math.round(m.qty).toLocaleString('en-IN')}</td><td>${m.unit}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>
      <section class="sec">
        <h2>Doors &amp; windows</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Mark</th><th class="num">Size (mm)</th><th class="num">Nos</th><th>Specification</th></tr></thead>
          <tbody>${dwRows.map((r) => `<tr><td>${r.code} · ${r.name}</td><td class="num">${mm(r.w)} × ${mm(r.h)}</td><td class="num">${r.n}</td><td>${r.spec}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>
    </div>

    <section class="sec">
      <h2>Vastu check · ${vs.pct}%</h2>
      <p>Zones are read from the centre of the ground-floor footprint with the road on the ${facingName}. These are traditional guidelines; weigh them against light, ventilation and your own needs.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Element</th><th>Zone</th><th>Result</th><th>Guideline</th></tr></thead>
        <tbody>${vs.items.map((i) => `<tr><td>${esc(i.label)}${i.floor ? ` <span class="note">(${FLOOR_SHORT[i.floor]})</span>` : ''}</td><td>${i.zone === 'C' ? 'Centre' : i.zone}</td><td><span class="pill ${i.status}">${i.status === 'good' ? 'Ideal' : i.status === 'ok' ? 'Acceptable' : 'Avoid'}</span></td><td>${i.advice}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>

    <p class="disclaimer">This is a concept plan for early decisions and conversations with your architect and engineer. Quantities use common Indian thumb rules per sq ft and costs use the rate above; both vary by city, soil and design. Get a structural design, a detailed BOQ and building plan approval before construction.</p>
  `;
  $$('#qualitySeg button').forEach((btn) => btn.addEventListener('click', () => {
    state.quality = btn.dataset.v;
    state.rate = C.QUALITY[state.quality].rate;
    save(); renderReport(); renderSide();
  }));
  $('#rateInput').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) state.rate = Math.round(v);
    save(); renderReport(); renderSide();
  });
}

// ---------- 3D ----------

let model = null, modelLoading = null, modelTimer = null;
async function ensureModel() {
  if (model) return model;
  if (!modelLoading) {
    modelLoading = import('./view3d.js').then(({ ModelView }) => {
      model = new ModelView($('#modelPane'));
      return model;
    }).catch((err) => {
      console.error(err);
      const p = document.createElement('div');
      p.className = 'model-fallback';
      p.textContent = 'The 3D view needs WebGL and the three.js library from cdn.jsdelivr.net. Check your connection and reload.';
      $('#modelPane').appendChild(p);
      modelLoading = null;
      return null;
    });
  }
  return modelLoading;
}
function renderModel() {
  clearTimeout(modelTimer);
  modelTimer = setTimeout(async () => {
    const m = await ensureModel();
    if (!m) return;
    m.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--sky').trim() || '#dfe7ec');
    m.resize();
    m.build(state, { mode: state.modelMode, floor: state.floor });
  }, 30);
}

// ---------- views & rendering ----------

function setView(v) {
  state.view = v;
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('#planPane').hidden = v !== 'plan';
  $('#modelPane').hidden = v !== 'model';
  $('#detailsPane').hidden = v !== 'details';
  $('#planTools').hidden = v !== 'plan';
  $('#modelTools').hidden = v !== 'model';
  $('#floorTabs').hidden = v === 'details';
  save();
  renderAll();
}

function renderAll() {
  renderFloorTabs();
  if (state.view === 'plan') renderPlan();
  if (state.view === 'model') renderModel();
  if (state.view === 'details') renderReport();
  renderSide();
  $('#undoBtn').disabled = !past.length;
  $('#redoBtn').disabled = !future.length;
}

// ---------- export ----------

function showImage(title, url, filename) {
  $('#modalTitle').textContent = title;
  $('#modalImg').src = url;
  $('#modalImg').alt = title;
  $('#modalDownload').href = url;
  $('#modalDownload').download = filename;
  $('#modal').hidden = false;
  $('#modalClose').focus();
}
async function doExport(kind) {
  $('#exportMenu').hidden = true;
  $('#exportBtn').setAttribute('aria-expanded', 'false');
  const base = `nivas-${state.brief.bhk}bhk-${Math.round(C.toUnit(state.brief.plotW, 'ft'))}x${Math.round(C.toUnit(state.brief.plotD, 'ft'))}`;
  if (kind === 'plan') {
    if (state.view !== 'plan') renderPlan();
    try {
      const url = await planToPng($('#planSvg'));
      showImage(`${state.plan.floors[state.floor].name} plan`, url, `${base}-${FLOOR_SHORT[state.floor].toLowerCase()}.png`);
    } catch { toast('Could not draw the plan image in this browser.'); }
  } else if (kind === 'model') {
    if (state.view !== 'model') setView('model');
    const m = await ensureModel();
    if (!m) return;
    setTimeout(() => showImage('3D view', m.snapshot(), `${base}-3d.png`), 120);
  } else if (kind === 'json') {
    const blob = new Blob([JSON.stringify({ app: 'nivas-planner', version: 1, brief: state.brief, plan: state.plan }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`Downloading ${base}.json`);
  }
}
function openProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const o = JSON.parse(reader.result);
      if (!o.plan?.floors?.length || !o.brief) throw new Error('shape');
      state.brief = { ...C.DEFAULT_BRIEF, ...o.brief };
      state.plan = o.plan;
      state.edited = true;
      state.floor = 0; state.selected = null;
      if (model) model.needsFit = true;
      fillBrief();
      commit();
      toast(`Opened ${file.name}`);
    } catch { toast('That file is not a Nivas project (.json).'); }
  };
  reader.readAsText(file);
}

// ---------- wiring ----------

function bindUI() {
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    state.unit = b.dataset.unit;
    fillBrief(); save(); renderAll();
  }));
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#addType').innerHTML = typeOptions('bedroom');
  $('#addRoomBtn').addEventListener('click', addRoom);
  $('#flipBtn').addEventListener('click', () => {
    state.plan = C.mirrorPlan(state.plan, state.brief);
    state.edited = true;
    commit();
    toast('Plan mirrored left to right');
  });
  $$('#modelMode button').forEach((b) => b.addEventListener('click', () => {
    state.modelMode = b.dataset.v;
    setPressed('#modelMode', b.dataset.v);
    renderModel();
  }));
  $$('#camSeg button').forEach((b) => b.addEventListener('click', async () => {
    const m = await ensureModel();
    m?.view(b.dataset.v, state);
  }));
  $('#exportBtn').addEventListener('click', (e) => {
    const menu = $('#exportMenu');
    menu.hidden = !menu.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) { $('#exportMenu').hidden = true; $('#exportBtn').setAttribute('aria-expanded', 'false'); }
  });
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));
  $('#openFile').addEventListener('change', (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; $('#exportMenu').hidden = true; });
  $('#modalClose').addEventListener('click', () => { $('#modal').hidden = true; });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, select, textarea');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === 'Escape') { $('#modal').hidden = true; state.selected = null; renderAll(); }
    const r = findRoom(state.selected);
    if (!r || state.view !== 'plan') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    const step = (state.unit === 'm' ? 0.05 : 0.0762) * (e.shiftKey ? 10 : 1);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      r.x = +(r.x + moves[e.key][0]).toFixed(3);
      r.y = +(r.y + moves[e.key][1]).toFixed(3);
      state.edited = true;
      commit();
    }
  });

  // Keep the 3D background in step with the theme.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', () => { if (state.view === 'model') renderModel(); });
  new MutationObserver(() => { if (state.view === 'model') renderModel(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ---------- boot ----------

load();
if (!state.plan) state.plan = C.generate(state.brief);
current = snap();
fillBrief();
bindBrief();
bindUI();
setView(state.view);
