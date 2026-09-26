// 2D floor plan: an SVG drawn in metres, with wall poché, door swings,
// window symbols, dimensions and a north arrow. Rooms can be dragged,
// resized from their edges, and snap to the grid and to other rooms.
import {
  HALF_WALL, WALL, ROOM_TYPES, fmtLen, fmtDims, fmtArea, openings, exteriorEdges,
  northRotation, buildable,
} from './core.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const r3 = (v) => Math.round(v * 1000) / 1000;

export class PlanView {
  constructor(svg, { onSelect, onChange, onCommit }) {
    this.svg = svg;
    this.onSelect = onSelect;
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.drag = null;
    svg.addEventListener('pointerdown', (e) => this.pointerDown(e));
    svg.addEventListener('pointermove', (e) => this.pointerMove(e));
    svg.addEventListener('pointerup', (e) => this.pointerUp(e));
    svg.addEventListener('pointercancel', (e) => this.pointerUp(e));
  }

  toPlan(e) {
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(this.svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  }

  snap(v) {
    const g = this.state.unit === 'm' ? 0.05 : 0.0762; // 5 cm or 3 inches
    return Math.round(v / g) * g;
  }

  // Snap a moving edge to the nearest edge of another room.
  snapEdge(v, cands) {
    let best = null;
    for (const c of cands) if (Math.abs(c - v) < 0.18 && (best == null || Math.abs(c - v) < Math.abs(best - v))) best = c;
    return best;
  }

  pointerDown(e) {
    const t = e.target.closest('[data-room],[data-handle]');
    if (!t) { this.onSelect(null); return; }
    const id = t.dataset.room || t.dataset.handle.split(':')[0];
    const room = this.rooms.find((r) => r.id === id);
    if (!room) return;
    if (!t.dataset.handle) this.onSelect(id);
    const p = this.toPlan(e);
    this.drag = {
      id, mode: t.dataset.handle ? t.dataset.handle.split(':')[1] : 'move',
      start: p, orig: { ...room }, moved: false,
    };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  pointerMove(e) {
    if (!this.drag) return;
    const p = this.toPlan(e);
    const d = this.drag, o = d.orig;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.08) return;
    d.moved = true;
    const room = this.rooms.find((r) => r.id === d.id);
    const others = this.rooms.filter((r) => r.id !== d.id);
    const xs = others.flatMap((r) => [r.x, r.x + r.w]);
    const ys = others.flatMap((r) => [r.y, r.y + r.d]);
    const B = buildable(this.state.brief);
    xs.push(B.x, B.x + B.w); ys.push(B.y, B.y + B.d);
    const min = 0.6;
    if (d.mode === 'move') {
      let x = this.snap(o.x + dx), y = this.snap(o.y + dy);
      const sx = this.snapEdge(x, xs) ?? (this.snapEdge(x + o.w, xs) != null ? this.snapEdge(x + o.w, xs) - o.w : null);
      const sy = this.snapEdge(y, ys) ?? (this.snapEdge(y + o.d, ys) != null ? this.snapEdge(y + o.d, ys) - o.d : null);
      room.x = r3(sx ?? x); room.y = r3(sy ?? y);
    } else {
      const edge = d.mode;
      if (edge === 'e') { const v = this.snapEdge(o.x + o.w + dx, xs) ?? this.snap(o.x + o.w + dx); room.w = r3(Math.max(min, v - o.x)); }
      if (edge === 'w') { const v = this.snapEdge(o.x + dx, xs) ?? this.snap(o.x + dx); const nx = Math.min(v, o.x + o.w - min); room.x = r3(nx); room.w = r3(o.x + o.w - nx); }
      if (edge === 's') { const v = this.snapEdge(o.y + o.d + dy, ys) ?? this.snap(o.y + o.d + dy); room.d = r3(Math.max(min, v - o.y)); }
      if (edge === 'n') { const v = this.snapEdge(o.y + dy, ys) ?? this.snap(o.y + dy); const ny = Math.min(v, o.y + o.d - min); room.y = r3(ny); room.d = r3(o.y + o.d - ny); }
    }
    this.onChange();
  }

  pointerUp() {
    if (this.drag?.moved) this.onCommit();
    this.drag = null;
  }

  render(state, floorIdx, selectedId) {
    this.state = state;
    const svg = this.svg;
    const { brief, unit } = state;
    const floor = state.plan.floors[floorIdx];
    this.rooms = floor.rooms;
    const pad = 2.2;
    const W = brief.plotW, D = brief.plotD;
    const road = 2.4;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${W + pad * 2} ${D + road + pad * 2 + 0.6}`);
    svg.replaceChildren();
    const fs = Math.min(0.5, Math.max(0.24, Math.min(W, D) / 32));
    svg.style.setProperty('--fs', fs);

    // Plot, setbacks and road.
    el('rect', { x: 0, y: D + 0.6, width: W, height: road, class: 'road' }, svg);
    el('text', { x: W / 2, y: D + 0.6 + road / 2, class: 'road-label', 'font-size': fs * 1.1 }, svg).textContent = 'ROAD';
    el('rect', { x: 0, y: 0, width: W, height: D, class: 'plot' }, svg);
    const B = buildable(brief);
    el('rect', { x: B.x, y: B.y, width: B.w, height: B.d, class: 'setback' }, svg);

    // Grid (1 m or 1 ft) inside the plot.
    const g = el('g', { class: 'grid' }, svg);
    const step = unit === 'm' ? 1 : 0.3048 * 2;
    for (let x = step; x < W; x += step) el('line', { x1: x, y1: 0, x2: x, y2: D }, g);
    for (let y = step; y < D; y += step) el('line', { x1: 0, y1: y, x2: W, y2: y }, g);

    // Floor below as a ghost for alignment.
    if (floorIdx > 0) {
      const gb = el('g', { class: 'ghost' }, svg);
      for (const r of state.plan.floors[floorIdx - 1].rooms) el('rect', { x: r.x, y: r.y, width: r.w, height: r.d }, gb);
    }

    const { doors, windows } = openings(floor.rooms, floorIdx === 0);
    const ext = exteriorEdges(floor.rooms);

    // Room fills.
    const fills = el('g', {}, svg);
    for (const r of floor.rooms) {
      el('rect', {
        x: r.x, y: r.y, width: r.w, height: r.d,
        class: `room t-${r.type}${r.id === selectedId ? ' selected' : ''}`,
        'data-room': r.id,
      }, fills);
    }

    // Stair treads.
    for (const r of floor.rooms.filter((q) => q.type === 'stair')) this.drawStair(r, svg, floorIdx === state.plan.floors.length - 1 && !brief.terraceStair);
    // Car in the parking bay.
    for (const r of floor.rooms.filter((q) => q.type === 'parking')) this.drawCar(r, svg);

    // Walls with gaps for doors and windows.
    const walls = el('g', { class: 'walls' }, svg);
    const cuts = [...doors, ...windows];
    for (const r of floor.rooms) {
      if (r.type === 'parking') continue;
      const e = ext.get(r.id);
      const low = r.type === 'balcony';
      const t = (isExt) => (isExt ? WALL : HALF_WALL);
      const sides = [
        { axis: 'h', pos: r.y, a: r.x, b: r.x + r.w, t: t(e.top), inward: 1, skip: low && !e.top },
        { axis: 'h', pos: r.y + r.d, a: r.x, b: r.x + r.w, t: t(e.bottom), inward: -1, skip: low && !e.bottom },
        { axis: 'v', pos: r.x, a: r.y, b: r.y + r.d, t: t(e.left), inward: 1, skip: low && !e.left },
        { axis: 'v', pos: r.x + r.w, a: r.y, b: r.y + r.d, t: t(e.right), inward: -1, skip: low && !e.right },
      ];
      for (const s of sides) {
        if (s.skip) continue;
        const gaps = cuts
          .filter((c) => c.axis === s.axis && Math.abs(c.pos - s.pos) < 0.02 && c.a < s.b && c.a + c.w > s.a)
          .map((c) => [Math.max(s.a, c.a), Math.min(s.b, c.a + c.w)])
          .sort((p, q) => p[0] - q[0]);
        let cur = s.a;
        const segs = [];
        for (const [ga, gb] of gaps) { if (ga > cur) segs.push([cur, ga]); cur = Math.max(cur, gb); }
        if (cur < s.b) segs.push([cur, s.b]);
        for (const [a, b] of segs) {
          const off = s.inward > 0 ? s.pos : s.pos - s.t;
          const attrs = s.axis === 'h'
            ? { x: a, y: off, width: b - a, height: s.t }
            : { x: off, y: a, width: s.t, height: b - a };
          el('rect', { ...attrs, class: low ? 'wall low' : 'wall' }, walls);
        }
      }
    }

    // Windows: three thin lines across the opening.
    const wg = el('g', { class: 'windows' }, svg);
    for (const w of windows) {
      const ext2 = WALL;
      const inward = this.inwardOf(w, floor.rooms);
      const p0 = inward > 0 ? w.pos : w.pos - ext2;
      for (const f of [0, 0.5, 1]) {
        const o = p0 + ext2 * f;
        if (w.axis === 'h') el('line', { x1: w.a, y1: o, x2: w.a + w.w, y2: o }, wg);
        else el('line', { x1: o, y1: w.a, x2: o, y2: w.a + w.w }, wg);
      }
      if (w.axis === 'h') el('rect', { x: w.a, y: p0, width: w.w, height: ext2, class: 'win-frame' }, wg);
      else el('rect', { x: p0, y: w.a, width: ext2, height: w.w, class: 'win-frame' }, wg);
    }

    // Doors: leaf and swing arc; open archways get a dashed head line.
    const dg = el('g', { class: 'doors' }, svg);
    for (const d of doors) {
      if (d.kind === 'open') {
        if (d.axis === 'h') el('line', { x1: d.a, y1: d.pos, x2: d.a + d.w, y2: d.pos, class: 'arch' }, dg);
        else el('line', { x1: d.pos, y1: d.a, x2: d.pos, y2: d.a + d.w, class: 'arch' }, dg);
        continue;
      }
      const s = d.side, w = d.w;
      if (d.axis === 'h') {
        const hx = d.a, hy = d.pos;
        el('line', { x1: hx, y1: hy, x2: hx, y2: hy + s * w, class: 'leaf' }, dg);
        el('path', { d: `M ${hx + w} ${hy} A ${w} ${w} 0 0 ${s > 0 ? 1 : 0} ${hx} ${hy + s * w}`, class: 'swing' }, dg);
      } else {
        const hx = d.pos, hy = d.a;
        el('line', { x1: hx, y1: hy, x2: hx + s * w, y2: hy, class: 'leaf' }, dg);
        el('path', { d: `M ${hx} ${hy + w} A ${w} ${w} 0 0 ${s > 0 ? 0 : 1} ${hx + s * w} ${hy}`, class: 'swing' }, dg);
      }
      if (d.kind === 'main') {
        el('text', { x: d.a + w / 2, y: d.pos + 0.75, class: 'tag', 'font-size': fs * 0.8 }, dg).textContent = 'ENTRY';
      }
    }

    // Labels.
    const lg = el('g', { class: 'labels' }, svg);
    for (const r of floor.rooms) {
      const small = Math.min(r.w, r.d) < 1.8;
      const size = small ? fs * 0.72 : fs;
      const cx = r.x + r.w / 2, cy = r.y + r.d / 2;
      const vertical = r.d > r.w * 1.6 && r.w < 1.7;
      const tg = el('g', { transform: vertical ? `rotate(-90 ${cx} ${cy})` : '' }, lg);
      el('text', { x: cx, y: cy - size * 0.2, class: 'room-name', 'font-size': size }, tg).textContent = r.name.toUpperCase();
      el('text', { x: cx, y: cy + size * 1.0, class: 'room-dim', 'font-size': size * 0.82 }, tg).textContent = fmtDims(r.w, r.d, unit);
    }

    // Resize handles for the selected room.
    const sel = floor.rooms.find((r) => r.id === selectedId);
    if (sel) {
      const hg = el('g', { class: 'handles' }, svg);
      const hw = 0.35;
      el('rect', { x: sel.x, y: sel.y, width: sel.w, height: sel.d, class: 'sel-outline' }, hg);
      const hs = [
        ['n', sel.x, sel.y - hw / 2, sel.w, hw], ['s', sel.x, sel.y + sel.d - hw / 2, sel.w, hw],
        ['w', sel.x - hw / 2, sel.y, hw, sel.d], ['e', sel.x + sel.w - hw / 2, sel.y, hw, sel.d],
      ];
      for (const [k, x, y, w, h] of hs) el('rect', { x, y, width: w, height: h, class: `handle h-${k}`, 'data-handle': `${sel.id}:${k}` }, hg);
      for (const [k, x, y] of [['n', sel.x + sel.w / 2, sel.y], ['s', sel.x + sel.w / 2, sel.y + sel.d], ['w', sel.x, sel.y + sel.d / 2], ['e', sel.x + sel.w, sel.y + sel.d / 2]]) {
        el('circle', { cx: x, cy: y, r: fs * 0.45, class: `knob h-${k}`, 'data-handle': `${sel.id}:${k}` }, hg);
      }
    }

    this.drawDimensions(svg, floor.rooms, fs);
    this.drawNorth(svg, W, fs, brief.facing);
  }

  inwardOf(o, rooms) {
    const probe = 0.05;
    const hit = (px, py) => rooms.some((r) => px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.d);
    const mid = o.a + o.w / 2;
    return o.axis === 'h' ? (hit(mid, o.pos + probe) ? 1 : -1) : (hit(o.pos + probe, mid) ? 1 : -1);
  }

  drawStair(r, svg, noFlight) {
    const g = el('g', { class: 'stair' }, svg);
    const landing = Math.min(1.0, r.d * 0.3);
    const flight = r.d - landing;
    const n = 10;
    const tread = flight / n;
    const half = r.w / 2;
    for (let i = 1; i < n; i++) {
      const y = r.y + landing + i * tread;
      el('line', { x1: r.x, y1: y, x2: r.x + r.w, y2: y }, g);
    }
    el('line', { x1: r.x + half, y1: r.y + landing, x2: r.x + half, y2: r.y + r.d, class: 'mid' }, g);
    el('line', { x1: r.x, y1: r.y + landing, x2: r.x + r.w, y2: r.y + landing, class: 'mid' }, g);
    if (noFlight) return;
    // "UP" arrow: first flight goes away from the road, back down on the other side.
    const ax = r.x + half / 2;
    el('path', { d: `M ${ax} ${r.y + r.d - 0.2} L ${ax} ${r.y + landing / 2} L ${r.x + half * 1.5} ${r.y + landing / 2} L ${r.x + half * 1.5} ${r.y + landing + 0.6}`, class: 'arrow' }, g);
    el('path', { d: `M ${r.x + half * 1.5 - 0.12} ${r.y + landing + 0.4} L ${r.x + half * 1.5} ${r.y + landing + 0.62} L ${r.x + half * 1.5 + 0.12} ${r.y + landing + 0.4}`, class: 'arrow' }, g);
    el('text', { x: ax, y: r.y + r.d - 0.35, class: 'tag', 'font-size': 0.26 }, g).textContent = 'UP';
  }

  drawCar(r, svg) {
    const cw = Math.min(1.75, r.w - 0.5), cl = Math.min(4.2, r.d - 0.4);
    if (cw < 1 || cl < 2.5) return;
    const x = r.x + (r.w - cw) / 2, y = r.y + (r.d - cl) / 2;
    const g = el('g', { class: 'car' }, svg);
    el('rect', { x, y, width: cw, height: cl, rx: 0.35 }, g);
    el('rect', { x: x + 0.15, y: y + cl * 0.22, width: cw - 0.3, height: cl * 0.5, rx: 0.2 }, g);
  }

  drawDimensions(svg, rooms, fs) {
    const g = el('g', { class: 'dims' }, svg);
    const { brief, unit } = this.state;
    const W = brief.plotW, D = brief.plotD;
    const tick = (x, y) => el('line', { x1: x - 0.12, y1: y + 0.12, x2: x + 0.12, y2: y - 0.12, class: 'tick' }, g);
    const hdim = (x1, x2, y, label) => {
      el('line', { x1, y1: y, x2, y2: y }, g); tick(x1, y); tick(x2, y);
      el('text', { x: (x1 + x2) / 2, y: y - fs * 0.35, 'font-size': fs * 0.85 }, g).textContent = label;
    };
    const vdim = (y1, y2, x, label) => {
      el('line', { x1: x, y1, x2: x, y2 }, g); tick(x, y1); tick(x, y2);
      const t = el('text', { x: x - fs * 0.35, y: (y1 + y2) / 2, 'font-size': fs * 0.85, transform: `rotate(-90 ${x - fs * 0.35} ${(y1 + y2) / 2})` }, g);
      t.textContent = label;
    };
    hdim(0, W, -1.1, `PLOT ${fmtLen(W, unit)}`);
    vdim(0, D, -1.1, `PLOT ${fmtLen(D, unit)}`);
    const body = rooms.filter((r) => r.type !== 'balcony');
    if (body.length) {
      const x0 = Math.min(...body.map((r) => r.x)), x1 = Math.max(...body.map((r) => r.x + r.w));
      const y0 = Math.min(...body.map((r) => r.y)), y1 = Math.max(...body.map((r) => r.y + r.d));
      hdim(x0, x1, -0.45, fmtLen(x1 - x0, unit));
      vdim(y0, y1, W + 0.75, fmtLen(y1 - y0, unit));
      // Setback call-outs.
      const sb = el('g', { class: 'setback-dims' }, g);
      const lab = (x, y, text) => { el('text', { x, y, 'font-size': fs * 0.7 }, sb).textContent = text; };
      if (brief.setFront > 0.4) lab(Math.max(fs * 3, x0 / 2 + 0.2), (y1 + D) / 2 + fs * 0.25, `${fmtLen(D - y1, unit)}`);
      if (y0 > 0.4) lab(Math.max(fs * 3, x0 / 2 + 0.2), y0 / 2 + fs * 0.25, `${fmtLen(y0, unit)}`);
    }
  }

  drawNorth(svg, W, fs, facing) {
    const s = Math.max(0.7, fs * 2.4);
    const g = el('g', { class: 'north', transform: `translate(${W + 1.1} ${-1.1}) rotate(${northRotation(facing)})` }, svg);
    el('circle', { cx: 0, cy: 0, r: s * 0.55 }, g);
    el('path', { d: `M 0 ${-s * 0.5} L ${s * 0.2} ${s * 0.3} L 0 ${s * 0.15} L ${-s * 0.2} ${s * 0.3} Z` }, g);
    el('text', { x: 0, y: -s * 0.72, 'font-size': fs * 0.9 }, g).textContent = 'N';
  }
}

export function planToPng(svg, scale = 2) {
  // Inline the computed styles we rely on so the exported image matches the screen.
  const clone = svg.cloneNode(true);
  const css = [...document.styleSheets]
    .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
    .map((r) => r.cssText)
    .filter((t) => t.includes('.plan-svg') || t.startsWith(':root'))
    .join('\n');
  const style = document.createElementNS(NS, 'style');
  const cs = getComputedStyle(document.documentElement);
  const vars = [...cs].filter((p) => p.startsWith('--')).map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
  style.textContent = `svg{${vars}} ${css}`;
  clone.insertBefore(style, clone.firstChild);
  clone.setAttribute('class', 'plan-svg export');
  const vb = svg.viewBox.baseVal;
  const pxPerM = 60 * scale;
  clone.setAttribute('width', vb.width * pxPerM);
  clone.setAttribute('height', vb.height * pxPerM);
  const data = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vb.width * pxPerM; c.height = vb.height * pxPerM;
      const ctx = c.getContext('2d');
      ctx.fillStyle = cs.getPropertyValue('--paper').trim() || '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export { fmtArea };
