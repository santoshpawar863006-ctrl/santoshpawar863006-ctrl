// Planning engine: units, room types, layout generation, doors and windows,
// Vastu checks and quantity/cost estimates. All lengths are metres.
// Plan coordinates: x grows to the right, y grows toward the road (front).

export const FT = 0.3048;
export const SQFT_PER_M2 = 10.7639;

export const WALL = 0.23;          // 9" brick wall
export const HALF_WALL = WALL / 2; // each room carries half of a shared wall
export const PLINTH = 0.45;
export const SLAB = 0.15;
export const PARAPET = 1.0;

export const ROOM_TYPES = {
  living:  { label: 'Living room',     hub: true,  minW: 3.0 },
  dining:  { label: 'Dining',          hub: true,  minW: 2.4 },
  lounge:  { label: 'Family lounge',   hub: true,  minW: 2.4 },
  kitchen: { label: 'Kitchen',         minW: 2.1 },
  master:  { label: 'Master bedroom',  minW: 3.0 },
  bedroom: { label: 'Bedroom',         minW: 2.7 },
  bath:    { label: 'Bathroom',        minW: 1.2 },
  dress:   { label: 'Dress',           minW: 1.2 },
  pooja:   { label: 'Pooja',           minW: 1.2 },
  study:   { label: 'Study',           minW: 2.1 },
  utility: { label: 'Utility',         minW: 1.2 },
  stair:   { label: 'Staircase',       minW: 2.3 },
  parking: { label: 'Car parking',     minW: 2.9 },
  balcony: { label: 'Balcony',         minW: 1.2 },
  hall:    { label: 'Multipurpose hall', hub: true, minW: 3.0 },
  store:   { label: 'Store',           minW: 1.2 },
};

export const FLOOR_NAMES = ['Ground floor', 'First floor', 'Second floor', 'Third floor'];

// ---------- units ----------

export function fmtLen(m, unit) {
  if (unit === 'm') return `${m.toFixed(2)} m`;
  let inches = Math.round(m / 0.0254);
  const ft = Math.floor(inches / 12);
  inches -= ft * 12;
  return `${ft}′${inches ? `${inches}″` : ''}`;
}
export function fmtDims(w, d, unit) {
  if (unit === 'm') return `${w.toFixed(2)} × ${d.toFixed(2)}`;
  return `${fmtLen(w, unit)} × ${fmtLen(d, unit)}`;
}
export function fmtArea(m2, unit) {
  return unit === 'm'
    ? `${m2.toFixed(1)} m²`
    : `${Math.round(m2 * SQFT_PER_M2).toLocaleString('en-IN')} sq ft`;
}
export const toUnit = (m, unit) => unit === 'm' ? m : m / FT;
export const fromUnit = (v, unit) => unit === 'm' ? v : v * FT;
export const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
export function inrShort(n) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return inr(n);
}

// ---------- geometry helpers ----------

let seq = 0;
export const newId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

export function buildable(brief) {
  const x0 = brief.setLeft, x1 = brief.plotW - brief.setRight;
  const y0 = brief.setRear, y1 = brief.plotD - brief.setFront;
  return { x: x0, y: y0, w: Math.max(2, x1 - x0), d: Math.max(2, y1 - y0) };
}

export function bbox(rooms) {
  if (!rooms.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rooms) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.d);
  }
  return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
}

const inside = (r, px, py, eps = 1e-6) =>
  px > r.x + eps && px < r.x + r.w - eps && py > r.y + eps && py < r.y + r.d - eps;

export function overlaps(rooms) {
  const out = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
      if (ox > 0.05 && oy > 0.05) out.push([a, b, ox * oy]);
    }
  }
  return out;
}

// ---------- layout generation ----------

// Split `total` between items proportionally to weight, honouring each item's
// minimum and any fixed size.
function distribute(total, items) {
  const size = items.map((it) => it.fixed ?? 0);
  let free = items.map((it, i) => (it.fixed == null ? i : -1)).filter((i) => i >= 0);
  let remaining = total - size.reduce((a, b) => a + b, 0);
  for (let guard = 0; guard < 10 && free.length; guard++) {
    const wsum = free.reduce((a, i) => a + items[i].weight, 0) || 1;
    const short = free.filter((i) => (remaining * items[i].weight) / wsum < items[i].min);
    if (!short.length) {
      for (const i of free) size[i] = (remaining * items[i].weight) / wsum;
      return size;
    }
    for (const i of short) { size[i] = items[i].min; remaining -= items[i].min; }
    free = free.filter((i) => !short.includes(i));
  }
  if (free.length) {
    const wsum = free.reduce((a, i) => a + items[i].weight, 0) || 1;
    for (const i of free) size[i] = Math.max(0, (remaining * items[i].weight) / wsum);
  } else if (remaining < 0) {
    const s = total / size.reduce((a, b) => a + b, 0);
    for (let i = 0; i < size.length; i++) size[i] *= s;
  }
  return size;
}

const spec = (type, area, extra = {}) => ({ type, area, name: extra.name || ROOM_TYPES[type].label, ...extra });

// Rooms per floor, sorted into three bands: rear (0), middle (1), front (2).
function floorPrograms(b) {
  const floors = b.floors;
  const beds = b.bhk;
  const groundBeds = floors === 1 ? beds : Math.min(1, beds - 1);
  const perUpper = Array.from({ length: floors - 1 }, () => 0);
  for (let k = 0; k < beds - groundBeds; k++) perUpper[k % perUpper.length]++;
  const hasStair = floors > 1 || b.terraceStair;
  let bedNo = 1;
  const nextBed = (attach) => {
    const n = bedNo++;
    return n === 1 ? spec('master', 15, { attach: true }) : spec('bedroom', 12, { name: `Bedroom ${n}`, attach });
  };

  const programs = [];
  const rear = [], mid = [], front = [];
  if (b.parking) front.push(spec('parking', 16));
  front.push(spec('living', 20));
  if (hasStair) mid.push(spec('stair', 9));
  mid.push(spec('dining', 11));
  rear.push(spec('kitchen', 10));
  if (b.utility) rear.push(spec('utility', 3.5));
  if (b.pooja) (floors === 1 ? front : mid).push(spec('pooja', 3));
  if (floors === 1) {
    // Whole house on one floor: bedrooms fill the rear, extras go to the middle.
    for (let i = 0; i < beds; i++) (i < 2 ? rear : i === 2 ? mid : front).push(nextBed(i < 2));
    if (beds >= 2) mid.push(spec('bath', 4, { name: 'Common toilet' }));
    if (b.study) mid.push(spec('study', 8));
  } else if (groundBeds) {
    rear.push(spec('bedroom', 12, { name: 'Guest bedroom', attach: true }));
  } else {
    mid.push(spec('bath', 3.5, { name: 'Common toilet' }));
  }
  programs.push([rear, mid, front]);

  for (let f = 1; f < floors; f++) {
    const n = perUpper[f - 1];
    const up = [[], [spec('stair', 9), spec('lounge', 12)], []];
    for (let i = 0; i < n; i++) up[0].push(nextBed(true));
    if (n === 0) up[0].push(spec('hall', 22));
    if (n >= 3) up[1].push(spec('bath', 3.5, { name: 'Common toilet' }));
    up.study = f === 1 && b.study;
    programs.push(up);
  }
  return { programs, hasStair };
}

const minOf = (s) => (s.type === 'stair' ? 2.4 : s.type === 'parking' ? 3.0 : ROOM_TYPES[s.type].minW + (s.attach ? 1.5 : 0));
const minSum = (band) => band.reduce((a, s) => a + minOf(s), 0);
const ALLOWED = { kitchen: [0, 1], utility: [0, 1], lounge: [1], dining: [1, 2, 0] };

// Move rooms between bands (or drop an attached bath) until each band fits.
function balanceBands(bands, width) {
  let droppedBath = false;
  for (let guard = 0; guard < 20; guard++) {
    const over = bands.findIndex((band) => minSum(band) > width);
    if (over < 0) break;
    const band = bands[over];
    const movable = band
      .filter((s) => !['stair', 'parking', 'living'].includes(s.type))
      .sort((a, c) => a.area - c.area);
    let moved = false;
    for (const mover of movable) {
      const target = (ALLOWED[mover.type] || [0, 1, 2])
        .filter((i) => i !== over && width - minSum(bands[i]) >= minOf(mover))
        .sort((a, c) => minSum(bands[a]) - minSum(bands[c]))[0];
      if (target != null) {
        band.splice(band.indexOf(mover), 1);
        bands[target].push(mover);
        moved = true;
        break;
      }
    }
    if (moved) continue;
    const att = band.find((s) => s.attach && s.type !== 'master') || band.find((s) => s.attach);
    if (!att) break;
    att.attach = false;
    droppedBath = true;
  }
  const hasCommon = bands.some((band) => band.some((s) => s.type === 'bath'));
  if (droppedBath && !hasCommon) {
    const i = [1, 0, 2].find((k) => width - minSum(bands[k]) >= 1.2);
    if (i != null) bands[i].push(spec('bath', 3.5, { name: 'Common toilet' }));
  }
}

function bandRooms(band, x0, width, y, depth, exteriorSide) {
  const items = band.map((s) => ({
    weight: s.area + (s.attach ? 5 : 0),
    min: ROOM_TYPES[s.type].minW + (s.attach ? 1.5 : 0),
    fixed: s.type === 'stair' ? Math.min(2.5, width * 0.35) : s.type === 'parking' ? Math.min(3.2, width * 0.45) : undefined,
  }));
  const widths = distribute(width, items);
  const rooms = [];
  let x = x0;
  const centerX = x0 + width / 2;
  band.forEach((s, i) => {
    const w = widths[i];
    if (s.attach && w > 3.8) {
      // Bedroom with attached bath strip on the side facing the house centre.
      const bw = 1.5;
      const bathLeft = x + w / 2 < centerX ? false : true;
      const bedX = bathLeft ? x + bw : x;
      const stripX = bathLeft ? x : x + w - bw;
      rooms.push({ id: newId(), type: s.type, name: s.name, x: bedX, y, w: w - bw, d: depth });
      const parentId = rooms[rooms.length - 1].id;
      if (depth > 3.4) {
        const bd = 2.2;
        const bathY = exteriorSide === 'rear' ? y : y + depth - bd;
        const dressY = exteriorSide === 'rear' ? y + bd : y;
        rooms.push({ id: newId(), type: 'bath', name: 'Toilet', x: stripX, y: bathY, w: bw, d: bd, parent: parentId });
        rooms.push({ id: newId(), type: 'dress', name: 'Dress', x: stripX, y: dressY, w: bw, d: depth - bd, parent: parentId });
      } else {
        rooms.push({ id: newId(), type: 'bath', name: 'Toilet', x: stripX, y, w: bw, d: depth, parent: parentId });
      }
    } else {
      rooms.push({ id: newId(), type: s.type, name: s.name, x, y, w, d: depth });
    }
    x += w;
  });
  return rooms;
}

export function generate(brief) {
  const B = buildable(brief);
  const { programs } = floorPrograms(brief);
  programs.forEach((bands, f) => {
    balanceBands(bands, B.w);
    if (f === 0) return;
    const beds = (band) => band.filter((s) => s.type === 'master' || s.type === 'bedroom');
    if (!bands[2].length && beds(bands[0]).length >= 2) {
      const mover = beds(bands[0]).pop();
      bands[0].splice(bands[0].indexOf(mover), 1);
      bands[2].push(mover);
    }
    let studyUsed = false;
    for (const i of [2, 0]) {
      for (let k = 0; k < 2; k++) {
        if (bands[i].length && !(bands[i].length === 1 && B.w - minSum(bands[i]) > 2.9)) break;
        const slack = B.w - minSum(bands[i]);
        const filler = k === 0
          ? slack < 3.6 && bands[i].length
            ? spec('store', 5, { name: 'Store' })
            : spec('study', 9, { name: bands.study && !studyUsed ? 'Study' : i === 2 ? 'Home office' : 'Study' })
          : spec('hall', 14, { name: 'Multipurpose hall' });
        bands[i].push(filler);
        studyUsed = true;
      }
    }
  });
  // Bedrooms first, service rooms last in each band, so the kitchen lands next to dining.
  const order = { kitchen: 2, utility: 3 };
  programs.forEach((bands) => bands.forEach((band) => band.sort((a, c) => (order[a.type] || 0) - (order[c.type] || 0))));
  // Band depths come from the ground floor so walls line up floor to floor.
  const g = programs[0];
  const hasParking = g[2].some((s) => s.type === 'parking');
  const depthItems = programs[0].map((band, i) => {
    const upperMax = Math.max(0, ...programs.slice(1).map((p) => p[i].reduce((a, s) => a + s.area + (s.attach ? 5 : 0), 0)));
    const area = Math.max(band.reduce((a, s) => a + s.area + (s.attach ? 5 : 0), 0), upperMax);
    return { weight: Math.max(area, 6), min: i === 1 ? 3.2 : i === 2 && hasParking ? 4.5 : 3.0 };
  });
  // On big plots, keep the house compact and leave the rest as open ground at the rear.
  const need = Math.max(...programs.map((bands) => bands.flat().reduce((a, s) => a + s.area + (s.attach ? 5 : 0), 0))) * 1.45;
  const houseD = Math.min(B.d, Math.max(depthItems.reduce((a, it) => a + it.min, 0) + 1.5, need / B.w));
  const y0 = B.y + B.d - houseD;
  const depths = distribute(houseD, depthItems);
  const ys = [y0, y0 + depths[0], y0 + depths[0] + depths[1]];
  const sides = ['rear', 'mid', 'front'];
  const floors = programs.map((bands, f) => {
    const rooms = [];
    bands.forEach((band, i) => {
      // Stair sits at the left end of the middle band on every floor.
      band.sort((a, c) => (a.type === 'stair' ? -1 : c.type === 'stair' ? 1 : 0));
      if (band.length) rooms.push(...bandRooms(band, B.x, B.w, ys[i], depths[i], sides[i]));
    });
    // Upper floors get a balcony cantilevered over the front setback.
    if (f > 0 && brief.balcony && brief.setFront >= 0.9) {
      const frontY = B.y + B.d;
      const host = rooms.filter((r) => Math.abs(r.y + r.d - frontY) < 0.01 && r.type !== 'bath' && r.type !== 'dress')
        .sort((a, c) => c.w - a.w)[0];
      if (host) {
        const w = Math.min(host.w, 3.6);
        rooms.push({ id: newId(), type: 'balcony', name: 'Balcony', x: host.x + (host.w - w) / 2, y: frontY, w, d: Math.min(1.2, brief.setFront - 0.3), parent: host.id });
      }
    }
    return { name: FLOOR_NAMES[f], rooms };
  });
  let plan = { floors };
  if (brief.vastu) {
    const flipped = mirrorPlan(plan, brief);
    if (vastuScore(flipped, brief).score > vastuScore(plan, brief).score) plan = flipped;
  }
  return plan;
}

export function mirrorPlan(plan, brief) {
  const B = buildable(brief);
  const cx = B.x * 2 + B.w;
  const flipO = (o) => (o.axis === 'h'
    ? { ...o, a: cx - o.a - o.w, hinge: o.hinge ? 0 : 1 }
    : { ...o, pos: cx - o.pos, side: o.side ? -o.side : o.side });
  return {
    floors: plan.floors.map((fl) => ({
      ...fl,
      rooms: fl.rooms.map((r) => ({ ...r, x: cx - r.x - r.w })),
      openings: fl.openings ? fl.openings.map(flipO) : fl.openings,
    })),
  };
}

// ---------- doors & windows ----------

// Shared edge between two rooms, if any: {axis:'h'|'v', pos, a, b} where the
// edge lies on y=pos (h) or x=pos (v) and spans [a,b].
function sharedEdge(r, s) {
  const eps = 0.02;
  const ox0 = Math.max(r.x, s.x), ox1 = Math.min(r.x + r.w, s.x + s.w);
  const oy0 = Math.max(r.y, s.y), oy1 = Math.min(r.y + r.d, s.y + s.d);
  if (Math.abs(r.y + r.d - s.y) < eps && ox1 - ox0 > 0) return { axis: 'h', pos: s.y, a: ox0, b: ox1, side: 1 };
  if (Math.abs(s.y + s.d - r.y) < eps && ox1 - ox0 > 0) return { axis: 'h', pos: r.y, a: ox0, b: ox1, side: -1 };
  if (Math.abs(r.x + r.w - s.x) < eps && oy1 - oy0 > 0) return { axis: 'v', pos: s.x, a: oy0, b: oy1, side: 1 };
  if (Math.abs(s.x + s.w - r.x) < eps && oy1 - oy0 > 0) return { axis: 'v', pos: r.x, a: oy0, b: oy1, side: -1 };
  return null;
}

const DOOR_W = { main: 1.05, room: 0.9, bath: 0.75, open: 1.2 };

// side: +1 means the door swings toward +y (h) / +x (v).
export function openings(rooms, ground = true) {
  const doors = [], windows = [];
  const byId = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const fp = bbox(rooms);
  const connected = new Set();
  const pairKey = (a, b) => [a.id, b.id].sort().join('|');

  const addDoor = (from, to, kind) => {
    const e = sharedEdge(from, to);
    if (!e) return false;
    const w = Math.min(DOOR_W[kind], e.b - e.a - 0.2);
    if (w < 0.6) return false;
    const center = (e.a + e.b) / 2;
    let start = center - w / 2;
    // Keep the leaf near a corner of the smaller room, like a real plan.
    const room = to;
    const lo = e.axis === 'h' ? room.x : room.y;
    const hi = e.axis === 'h' ? room.x + room.w : room.y + room.d;
    if (kind !== 'open' && hi - lo > w + 0.6) {
      const cand = [Math.max(e.a, lo) + 0.15, Math.min(e.b, hi) - 0.15 - w];
      start = cand.reduce((best, c) => (c >= e.a + 0.05 && c + w <= e.b - 0.05 && Math.abs(c + w / 2 - center) > Math.abs(best + w / 2 - center) ? c : best), start);
    }
    doors.push({ axis: e.axis, pos: e.pos, a: start, w, side: e.side, hinge: 0, kind, rooms: [from.id, to.id] });
    connected.add(pairKey(from, to));
    return true;
  };

  const hubs = rooms.filter((r) => ROOM_TYPES[r.type]?.hub || r.type === 'stair');
  const living = rooms.find((r) => r.type === 'living') || rooms.find((r) => r.type === 'lounge' || r.type === 'hall');

  // Hubs open into each other.
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const a = hubs[i], b = hubs[j];
      if (sharedEdge(a, b)) addDoor(a, b, 'open');
    }
  }

  for (const r of rooms) {
    if (ROOM_TYPES[r.type]?.hub || r.type === 'stair') continue;
    const neighbours = rooms.filter((s) => s !== r && sharedEdge(r, s));
    let target = null, kind = 'room';
    if (r.parent && byId[r.parent] && sharedEdge(byId[r.parent], r)) {
      target = byId[r.parent];
      kind = r.type === 'dress' ? 'open' : r.type === 'bath' ? 'bath' : 'room';
    } else if (r.parent && r.type === 'bath') {
      const dress = rooms.find((s) => s.parent === r.parent && s.type === 'dress' && sharedEdge(s, r));
      if (dress) { target = dress; kind = 'bath'; }
    }
    if (!target) {
      const len = (s) => { const e = sharedEdge(r, s); return e ? e.b - e.a : 0; };
      const prefs = r.type === 'kitchen'
        ? neighbours.filter((s) => s.type === 'dining').concat(neighbours.filter((s) => ROOM_TYPES[s.type]?.hub))
        : r.type === 'parking'
          ? neighbours.filter((s) => ['living', 'utility', 'stair'].includes(s.type))
          : neighbours.filter((s) => ROOM_TYPES[s.type]?.hub || s.type === 'stair' && r.type === 'balcony');
      const pool = prefs.length ? prefs : r.type === 'balcony' || r.type === 'utility' || r.type === 'parking'
        ? neighbours.filter((s) => !['bath', 'dress', 'pooja', 'store'].includes(s.type))
        : neighbours.filter((s) => !['bath', 'dress', 'pooja', 'parking', 'store'].includes(s.type) && !s.parent);
      const rest = neighbours.filter((s) => !pool.includes(s) && !['bath', 'dress', 'parking'].includes(s.type));
      const cands = [...pool.sort((a, b) => len(b) - len(a)), ...rest.sort((a, b) => len(b) - len(a))];
      if (r.type === 'bath') kind = 'bath';
      for (const c of cands) {
        if (connected.has(pairKey(r, c))) break;
        const k = r.type === 'kitchen' && c.type === 'dining' ? 'open' : kind;
        if (addDoor(c, r, k)) break;
      }
      continue;
    }
    if (target && !connected.has(pairKey(r, target))) addDoor(target, r, kind);
  }

  // Main door on the front face of the living room (or whatever room faces the road).
  const frontY = fp ? fp.y + fp.d : 0;
  const entry = living && Math.abs(living.y + living.d - frontY) < 0.05 ? living
    : rooms.filter((r) => Math.abs(r.y + r.d - frontY) < 0.05 && ROOM_TYPES[r.type]?.hub)[0];
  let mainDoor = null;
  if (entry && ground) {
    const w = DOOR_W.main;
    const a = entry.x + Math.max(0.3, entry.w * 0.72 - w / 2);
    mainDoor = { axis: 'h', pos: entry.y + entry.d, a: Math.min(a, entry.x + entry.w - w - 0.2), w, side: -1, hinge: 0, kind: 'main', rooms: [entry.id] };
    doors.push(mainDoor);
  }

  // Windows on exterior faces.
  const isExterior = (r, axis, pos, a, b) => {
    const mid = (a + b) / 2;
    const probes = [a + (b - a) * 0.25, mid, a + (b - a) * 0.75];
    return probes.every((t) => {
      const p = axis === 'h' ? [t, pos + (pos > r.y + 0.01 ? 0.05 : -0.05)] : [pos + (pos > r.x + 0.01 ? 0.05 : -0.05), t];
      return !rooms.some((s) => s !== r && inside(s, p[0], p[1], -0.001));
    });
  };
  for (const r of rooms) {
    if (['parking', 'stair', 'dress', 'store'].includes(r.type) && r.type !== 'stair') continue;
    const edges = [
      { axis: 'h', pos: r.y, a: r.x, b: r.x + r.w },
      { axis: 'h', pos: r.y + r.d, a: r.x, b: r.x + r.w },
      { axis: 'v', pos: r.x, a: r.y, b: r.y + r.d },
      { axis: 'v', pos: r.x + r.w, a: r.y, b: r.y + r.d },
    ].filter((e) => isExterior(r, e.axis, e.pos, e.a, e.b)).sort((p, q) => (q.b - q.a) - (p.b - p.a));
    const kind = r.type === 'bath' ? 'vent' : r.type === 'balcony' ? null : 'window';
    if (!kind) continue;
    const limit = r.type === 'bath' || r.type === 'kitchen' || r.type === 'pooja' || r.type === 'stair' ? 1 : 2;
    for (const e of edges.slice(0, limit)) {
      const len = e.b - e.a;
      let w = kind === 'vent' ? 0.6 : r.type === 'kitchen' ? 1.2 : r.type === 'stair' || r.type === 'pooja' ? 0.9 : len > 3.6 ? 1.8 : 1.5;
      if (len < w + 0.5) w = len - 0.5;
      if (w < 0.45) continue;
      let a = e.a + (len - w) / 2;
      const clash = doors.find((d) => d.axis === e.axis && Math.abs(d.pos - e.pos) < 0.02 && d.a < a + w && d.a + d.w > a);
      if (clash) {
        const left = clash.a - e.a, right = e.b - (clash.a + clash.w);
        if (Math.max(left, right) < w + 0.4) continue;
        a = left > right ? e.a + (left - w) / 2 : clash.a + clash.w + (right - w) / 2;
      }
      windows.push({
        axis: e.axis, pos: e.pos, a, w, kind, room: r.id,
        sill: kind === 'vent' ? 1.65 : r.type === 'kitchen' ? 1.05 : 0.9,
        head: 2.1,
      });
    }
  }
  return { doors, windows, mainDoor };
}

// Room edges that face outside, so 3D knows where to use full-thickness walls.
export function exteriorEdges(rooms) {
  const out = new Map();
  for (const r of rooms) {
    const probe = (px, py) => !rooms.some((s) => s !== r && inside(s, px, py, -0.001));
    out.set(r.id, {
      top: probe(r.x + r.w / 2, r.y - 0.05),
      bottom: probe(r.x + r.w / 2, r.y + r.d + 0.05),
      left: probe(r.x - 0.05, r.y + r.d / 2),
      right: probe(r.x + r.w + 0.05, r.y + r.d / 2),
    });
  }
  return out;
}

// ---------- editable openings ----------
// A floor uses automatic doors and windows until the user edits one; then the
// current set is stored on the floor (floor.openings) and kept as edited.

export const OPENING_KINDS = {
  main:   { cat: 'door', label: 'Main door', w: 1.05 },
  room:   { cat: 'door', label: 'Door', w: 0.9 },
  bath:   { cat: 'door', label: 'Toilet door', w: 0.75 },
  open:   { cat: 'door', label: 'Open archway', w: 1.2 },
  window: { cat: 'window', label: 'Window', w: 1.5, sill: 0.9, head: 2.1 },
  vent:   { cat: 'window', label: 'Ventilator', w: 0.6, sill: 1.65, head: 2.1 },
};

// Rooms whose edge carries this opening.
export function openingRooms(o, rooms) {
  const mid = o.a + o.w / 2;
  return rooms.filter((r) => (o.axis === 'h'
    ? (Math.abs(r.y - o.pos) < 0.03 || Math.abs(r.y + r.d - o.pos) < 0.03) && mid > r.x && mid < r.x + r.w
    : (Math.abs(r.x - o.pos) < 0.03 || Math.abs(r.x + r.w - o.pos) < 0.03) && mid > r.y && mid < r.y + r.d));
}

export function floorOpenings(floor, fi) {
  if (!floor.openings) {
    const o = openings(floor.rooms, fi === 0);
    o.doors.forEach((d, i) => { d.id = `auto-${fi}-d${i}`; d.cat = 'door'; });
    o.windows.forEach((w, i) => { w.id = `auto-${fi}-w${i}`; w.cat = 'window'; });
    return { ...o, manual: false };
  }
  const valid = floor.openings.filter((o) => openingRooms(o, floor.rooms).length);
  const doors = valid.filter((o) => o.cat === 'door').map((d) => ({ ...d, rooms: openingRooms(d, floor.rooms).map((r) => r.id) }));
  const windows = valid.filter((o) => o.cat === 'window');
  return { doors, windows, manual: true, lost: floor.openings.length - valid.length };
}

// Store the automatic set on the floor so it can be edited. Returns the id map.
export function freezeOpenings(floor, fi) {
  if (floor.openings) return null;
  const o = floorOpenings(floor, fi);
  const map = {};
  floor.openings = [...o.doors, ...o.windows].map((x) => {
    const id = `o${newId().slice(1)}`;
    map[x.id] = id;
    const { rooms: _r, room: _w, ...rest } = x;
    return { ...rest, id };
  });
  return map;
}

// A new opening where the user clicked near a wall.
export function openingAt(rooms, px, py, kind) {
  let best = null;
  for (const r of rooms) {
    const edges = [
      { axis: 'h', pos: r.y, lo: r.x, hi: r.x + r.w, dist: Math.abs(py - r.y), t: px, into: 1 },
      { axis: 'h', pos: r.y + r.d, lo: r.x, hi: r.x + r.w, dist: Math.abs(py - r.y - r.d), t: px, into: -1 },
      { axis: 'v', pos: r.x, lo: r.y, hi: r.y + r.d, dist: Math.abs(px - r.x), t: py, into: 1 },
      { axis: 'v', pos: r.x + r.w, lo: r.y, hi: r.y + r.d, dist: Math.abs(px - r.x - r.w), t: py, into: -1 },
    ];
    for (const e of edges) {
      if (e.t < e.lo || e.t > e.hi || e.dist > 0.45) continue;
      if (!best || e.dist < best.dist) best = { ...e, room: r };
    }
  }
  if (!best) return null;
  const spec = OPENING_KINDS[kind];
  const w = Math.min(spec.w, best.hi - best.lo - 0.1);
  if (w < 0.4) return null;
  const a = Math.min(Math.max(best.t - w / 2, best.lo + 0.05), best.hi - w - 0.05);
  const o = { id: `o${newId().slice(1)}`, cat: spec.cat, kind, axis: best.axis, pos: best.pos, a, w };
  if (spec.cat === 'door') { o.side = best.into; o.hinge = 0; } else { o.sill = spec.sill; o.head = spec.head; }
  return o;
}

// ---------- compass & Vastu ----------

const BEARING = { N: 0, E: 90, S: 180, W: 270 };
const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Compass bearing of "up" on the plan (away from the road).
export const upBearing = (facing) => (BEARING[facing] + 180) % 360;
// Rotation for a north arrow drawn on the plan, clockwise degrees from up.
export const northRotation = (facing) => (360 - upBearing(facing)) % 360;

export function zoneOf(px, py, box, facing) {
  const cx = box.x + box.w / 2, cy = box.y + box.d / 2;
  const nx = (px - cx) / (box.w / 2), ny = (py - cy) / (box.d / 2);
  if (Math.abs(nx) < 0.34 && Math.abs(ny) < 0.34) return 'C';
  const local = (Math.atan2(nx, -ny) * 180) / Math.PI;
  const bearing = (((upBearing(facing) + local) % 360) + 360) % 360;
  return SECTORS[Math.round(bearing / 45) % 8];
}

const VASTU_RULES = [
  { type: 'kitchen', label: 'Kitchen', best: ['SE'], ok: ['NW', 'E', 'S'], avoid: ['NE', 'SW', 'C'] },
  { type: 'master', label: 'Master bedroom', best: ['SW'], ok: ['S', 'W'], avoid: ['NE', 'SE', 'C'] },
  { type: 'pooja', label: 'Pooja room', best: ['NE'], ok: ['N', 'E', 'W'], avoid: ['S', 'SW', 'SE'] },
  { type: 'living', label: 'Living room', best: ['N', 'E', 'NE'], ok: ['NW', 'W', 'C'], avoid: ['SW'] },
  { type: 'bath', label: 'Toilets', best: ['W', 'NW'], ok: ['S', 'SE', 'N', 'E'], avoid: ['NE', 'SW', 'C'] },
  { type: 'stair', label: 'Staircase', best: ['S', 'W', 'SW'], ok: ['SE', 'NW'], avoid: ['NE', 'C'] },
  { type: 'parking', label: 'Car parking', best: ['NW', 'SE'], ok: ['N', 'E'], avoid: ['SW', 'NE'] },
  { type: 'dining', label: 'Dining', best: ['W', 'E'], ok: ['N', 'C', 'S'], avoid: [] },
];

export function vastuReport(plan, brief) {
  const all = plan.floors.flatMap((f, i) => f.rooms.map((r) => ({ ...r, floor: i })));
  const box = bbox(plan.floors[0]?.rooms.filter((r) => r.type !== 'balcony') || []) || buildable(brief);
  const items = [];
  for (const rule of VASTU_RULES) {
    const rooms = all.filter((r) => r.type === rule.type);
    for (const r of rooms) {
      const z = zoneOf(r.x + r.w / 2, r.y + r.d / 2, box, brief.facing);
      const status = rule.best.includes(z) ? 'good' : rule.ok.includes(z) ? 'ok' : rule.avoid.includes(z) ? 'bad' : 'ok';
      items.push({ label: rooms.length > 1 ? `${rule.label}: ${r.name}` : rule.label, zone: z, status, advice: `Preferred: ${rule.best.join(', ')}`, floor: r.floor });
    }
  }
  const facingStatus = brief.facing === 'E' || brief.facing === 'N' ? 'good' : brief.facing === 'W' ? 'ok' : 'ok';
  items.unshift({ label: 'Main entrance', zone: brief.facing, status: facingStatus, advice: 'East and north entries are traditionally preferred' });
  return items;
}

export function vastuScore(plan, brief) {
  const items = vastuReport(plan, brief);
  const pts = { good: 2, ok: 1, bad: -1 };
  const score = items.reduce((a, i) => a + pts[i.status], 0);
  const max = items.length * 2 || 1;
  return { score, pct: Math.max(0, Math.round((score / max) * 100)), items };
}

// ---------- areas & estimates ----------

export function areas(plan, brief) {
  const plot = brief.plotW * brief.plotD;
  const floors = plan.floors.map((f) => {
    const rooms = f.rooms;
    const builtUp = rooms.filter((r) => r.type !== 'balcony').reduce((a, r) => a + r.w * r.d, 0);
    const carpet = rooms
      .filter((r) => !['parking', 'balcony', 'stair'].includes(r.type))
      .reduce((a, r) => a + Math.max(0, r.w - WALL) * Math.max(0, r.d - WALL), 0);
    const balcony = rooms.filter((r) => r.type === 'balcony').reduce((a, r) => a + r.w * r.d, 0);
    return { name: f.name, builtUp, carpet, balcony };
  });
  const builtUp = floors.reduce((a, f) => a + f.builtUp + f.balcony * 0.5, 0);
  const carpet = floors.reduce((a, f) => a + f.carpet, 0);
  const ground = floors[0] ? floors[0].builtUp : 0;
  return {
    plot, floors, builtUp, carpet,
    coverage: plot ? ground / plot : 0,
    far: plot ? builtUp / plot : 0,
    height: PLINTH + plan.floors.length * brief.floorH + PARAPET,
  };
}

export const QUALITY = {
  basic:    { label: 'Basic',    rate: 1900, note: 'Standard brick, vitrified tiles, local fittings' },
  standard: { label: 'Standard', rate: 2400, note: 'Branded fittings, granite kitchen, better tiles' },
  premium:  { label: 'Premium',  rate: 3200, note: 'Designer finishes, wood flooring, false ceilings' },
};

export const COST_SPLIT = [
  ['Excavation & foundation', 0.12],
  ['RCC frame: columns, beams, slabs', 0.24],
  ['Brickwork', 0.10],
  ['Plastering', 0.06],
  ['Flooring & wall tiles', 0.09],
  ['Doors & windows', 0.08],
  ['Plumbing & sanitary', 0.08],
  ['Electrical', 0.07],
  ['Painting', 0.05],
  ['Waterproofing & finishing', 0.04],
  ['Supervision & overheads', 0.07],
];

// Common Indian thumb rules per sq ft of built-up area.
export const MATERIALS = [
  { key: 'cement', label: 'Cement', per: 0.4, unit: 'bags (50 kg)' },
  { key: 'steel', label: 'TMT steel', per: 4.0, unit: 'kg' },
  { key: 'sand', label: 'Sand (M-sand)', per: 1.8, unit: 'cft' },
  { key: 'agg', label: 'Aggregate 20 mm', per: 1.35, unit: 'cft' },
  { key: 'bricks', label: 'Bricks', per: 8, unit: 'nos' },
  { key: 'tiles', label: 'Floor tiles', per: 1.3, unit: 'sq ft' },
  { key: 'paint', label: 'Paint', per: 0.18, unit: 'litres' },
];

export function estimate(plan, brief, rate) {
  const a = areas(plan, brief);
  const sqft = a.builtUp * SQFT_PER_M2;
  const total = sqft * rate;
  return {
    sqft, total,
    split: COST_SPLIT.map(([label, share]) => ({ label, share, amount: total * share })),
    materials: MATERIALS.map((m) => ({ ...m, qty: sqft * m.per })),
  };
}

export const DEFAULT_STYLE = { wall: '#e8dcc8', accent: '#8a6f55', roof: '#b9afa0', sunHour: 10 };

export const WALL_COLOURS = [
  ['#e8dcc8', 'Ivory'], ['#f2efe8', 'White'], ['#d9c09a', 'Sand'], ['#c98f6d', 'Terracotta'],
  ['#b9c4a7', 'Sage'], ['#c3ced6', 'Grey blue'], ['#e3c46f', 'Mustard'],
];
export const ACCENT_COLOURS = [
  ['#8a6f55', 'Walnut'], ['#5f6a70', 'Slate'], ['#3e4a3d', 'Forest'], ['#9a4a3a', 'Brick'],
  ['#d8d2c6', 'Stone'], ['#2f3437', 'Charcoal'],
];

export const DEFAULT_BRIEF = {
  plotW: 30 * FT, plotD: 40 * FT,
  setFront: 5 * FT, setRear: 3 * FT, setLeft: 2 * FT, setRight: 2 * FT,
  facing: 'E', bhk: 3, floors: 2, floorH: 3.0,
  parking: true, pooja: true, study: false, balcony: true, utility: false,
  terraceStair: true, vastu: true,
};
