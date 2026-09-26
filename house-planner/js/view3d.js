// 3D model built from the same rooms, doors and windows as the plan.
// Plan x → world X, plan y → world Z (the road is toward +Z), up is Y.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  WALL, HALF_WALL, PLINTH, SLAB, PARAPET, openings, exteriorEdges, bbox,
} from './core.js';

const FLOOR_TINT = {
  living: 0xe9dcc6, dining: 0xe9dcc6, lounge: 0xe9dcc6, hall: 0xe9dcc6,
  kitchen: 0xd9dfd5, utility: 0xd9dfd5, master: 0xcfb897, bedroom: 0xd8c3a2,
  bath: 0xc9d6dc, dress: 0xd8c3a2, pooja: 0xf0d9a8, study: 0xd8c3a2, store: 0xd6d2c8,
  stair: 0xcac5bb, parking: 0xa9a7a1, balcony: 0xd6cfc2,
};

export class ModelView {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels3d';
    host.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x6f7a5c, 1.1));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.mat = {
      wall: new THREE.MeshStandardMaterial({ color: 0xefe9df, roughness: 0.9 }),
      wallExt: new THREE.MeshStandardMaterial({ color: 0xe8dcc8, roughness: 0.92 }),
      slab: new THREE.MeshStandardMaterial({ color: 0xbfb8ad, roughness: 0.85 }),
      plinth: new THREE.MeshStandardMaterial({ color: 0x8f877b, roughness: 0.95 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9cc3d8, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.45 }),
      frame: new THREE.MeshStandardMaterial({ color: 0x3d4448, roughness: 0.6 }),
      door: new THREE.MeshStandardMaterial({ color: 0x8a5a3b, roughness: 0.7 }),
      mainDoor: new THREE.MeshStandardMaterial({ color: 0x5c3a24, roughness: 0.6 }),
      step: new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.8 }),
      grass: new THREE.MeshStandardMaterial({ color: 0x86a36b, roughness: 1 }),
      paving: new THREE.MeshStandardMaterial({ color: 0xc8c2b5, roughness: 1 }),
      road: new THREE.MeshStandardMaterial({ color: 0x4d5054, roughness: 1 }),
      compound: new THREE.MeshStandardMaterial({ color: 0xd4c7b2, roughness: 0.95 }),
      roof: new THREE.MeshStandardMaterial({ color: 0xb9afa0, roughness: 0.95 }),
      car: new THREE.MeshStandardMaterial({ color: 0x35607a, roughness: 0.35, metalness: 0.4 }),
      rail: new THREE.MeshStandardMaterial({ color: 0x2f3437, roughness: 0.5, metalness: 0.5 }),
    };
    this.floorMats = {};

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.opts = { mode: 'full', floor: 0, labels: true };
    this.needsFit = true;

    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(host);
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setBackground(color) {
    this.scene.background = new THREE.Color(color);
  }

  floorMat(type) {
    if (!this.floorMats[type]) this.floorMats[type] = new THREE.MeshStandardMaterial({ color: FLOOR_TINT[type] ?? 0xddd5c8, roughness: 0.75 });
    return this.floorMats[type];
  }

  box(w, h, d, mat, x, y, z, group, shadow = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.001), Math.max(h, 0.001), Math.max(d, 0.001)), mat);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    group.add(m);
    return m;
  }

  clear() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isCSS2DObject) o.element.remove();
    });
    this.root.clear();
  }

  build(state, opts = {}) {
    Object.assign(this.opts, opts);
    this.clear();
    const { brief, plan } = state;
    const H = brief.floorH;
    const g = this.root;
    const W = brief.plotW, D = brief.plotD;

    // Site: lawn, plot paving, road, compound wall with a gate opening.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W + 40, D + 40), this.mat.grass);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, -0.02, D / 2);
    ground.receiveShadow = true;
    g.add(ground);
    this.box(W, 0.04, D, this.mat.paving, W / 2, 0, D / 2, g, false);
    this.box(W + 40, 0.03, 7, this.mat.road, W / 2, 0, D + 3.8, g, false);
    for (let x = -18; x < W + 18; x += 3) this.box(1.4, 0.035, 0.12, this.mat.paving, x, 0.01, D + 3.8, g, false);
    const cw = 0.15, ch = 1.5;
    const ground0 = plan.floors[0]?.rooms || [];
    const parking = ground0.find((r) => r.type === 'parking');
    const gateA = parking ? parking.x : W / 2 - 1.8, gateB = parking ? parking.x + parking.w : W / 2 + 1.8;
    this.box(W, ch, cw, this.mat.compound, W / 2, ch / 2, cw / 2, g);
    this.box(cw, ch, D, this.mat.compound, cw / 2, ch / 2, D / 2, g);
    this.box(cw, ch, D, this.mat.compound, W - cw / 2, ch / 2, D / 2, g);
    if (gateA > 0.2) this.box(gateA, ch, cw, this.mat.compound, gateA / 2, ch / 2, D - cw / 2, g);
    if (gateB < W - 0.2) this.box(W - gateB, ch, cw, this.mat.compound, (W + gateB) / 2, ch / 2, D - cw / 2, g);

    const nFloors = plan.floors.length;
    const showUpTo = this.opts.mode === 'cut' ? this.opts.floor : nFloors - 1;

    plan.floors.forEach((floor, fi) => {
      if (fi > showUpTo) return;
      const base = PLINTH + fi * H;
      const fg = new THREE.Group();
      g.add(fg);
      const rooms = floor.rooms;
      const { doors, windows } = openings(rooms, fi === 0);
      const ext = exteriorEdges(rooms);
      const below = fi > 0 ? plan.floors[fi - 1].rooms : [];
      const wallH = H - SLAB;
      const cutTop = this.opts.mode === 'cut' && fi === showUpTo;
      const topH = cutTop ? Math.min(wallH, 1.35) : wallH;

      for (const r of rooms) {
        const cx = r.x + r.w / 2, cz = r.y + r.d / 2;
        // Floor: plinth on the ground floor, slab above (skip over stair wells).
        if (fi === 0) {
          const ph = r.type === 'parking' ? 0.15 : PLINTH;
          this.box(r.w, ph, r.d, this.mat.plinth, cx, ph / 2, cz, fg);
          this.box(r.w, 0.02, r.d, this.floorMat(r.type), cx, ph + 0.01, cz, fg, false);
        } else {
          const stairBelow = below.find((s) => s.type === 'stair' && Math.abs(s.x - r.x) < 0.05 && Math.abs(s.y - r.y) < 0.05);
          if (!(r.type === 'stair' && stairBelow)) {
            this.box(r.w, SLAB, r.d, this.mat.slab, cx, base - SLAB / 2, cz, fg);
            this.box(r.w, 0.02, r.d, this.floorMat(r.type), cx, base + 0.01, cz, fg, false);
          }
        }
        if (r.type === 'stair' && (fi < nFloors - 1 || brief.terraceStair)) this.stair(r, base, H, fg);
        if (r.type === 'parking') { this.car(r, fg); this.pillars(r, base, topH, fg); continue; }

        const e = ext.get(r.id);
        const low = r.type === 'balcony';
        const sides = [
          { axis: 'h', pos: r.y, a: r.x, b: r.x + r.w, isExt: e.top, inward: 1 },
          { axis: 'h', pos: r.y + r.d, a: r.x, b: r.x + r.w, isExt: e.bottom, inward: -1 },
          { axis: 'v', pos: r.x, a: r.y, b: r.y + r.d, isExt: e.left, inward: 1 },
          { axis: 'v', pos: r.x + r.w, a: r.y, b: r.y + r.d, isExt: e.right, inward: -1 },
        ];
        for (const s of sides) {
          if (low && !s.isExt) continue;
          const t = s.isExt ? WALL : HALF_WALL;
          const h = low ? 1.05 : topH;
          const mat = s.isExt ? this.mat.wallExt : this.mat.wall;
          const cuts = low ? [] : [...doors.map((d) => ({ ...d, sill: 0, head: 2.1 })), ...windows]
            .filter((c) => c.axis === s.axis && Math.abs(c.pos - s.pos) < 0.02 && c.a < s.b && c.a + c.w > s.a);
          this.wall(s, t, h, base, mat, cuts, fg, low);
        }
      }

      // Door leaves and window glass.
      for (const d of doors) {
        if (d.kind === 'open') continue;
        this.doorLeaf(d, base, fg);
      }
      for (const w of windows) {
        if (cutTop && w.sill > topH) continue;
        this.windowPane(w, base, rooms, fg, cutTop ? topH : null);
      }

      // Labels for the floor being looked at.
      // Labels only in the cut-away view, where the rooms are visible.
      if (this.opts.labels && this.opts.mode === 'cut' && fi === showUpTo) {
        for (const r of rooms) {
          if (r.w * r.d < 2.5) continue;
          const div = document.createElement('div');
          div.className = 'label3d';
          div.textContent = r.name;
          const lbl = new CSS2DObject(div);
          lbl.position.set(r.x + r.w / 2, base + 0.4, r.y + r.d / 2);
          fg.add(lbl);
        }
      }
    });

    // Roof slab, parapet and stair headroom on the terrace.
    if (showUpTo === nFloors - 1 && nFloors) {
      const top = plan.floors[nFloors - 1].rooms.filter((r) => r.type !== 'balcony');
      const roofY = PLINTH + nFloors * H;
      const stair = top.find((r) => r.type === 'stair');
      for (const r of top) {
        if (brief.terraceStair && r === stair) continue;
        this.box(r.w, SLAB, r.d, this.mat.slab, r.x + r.w / 2, roofY - SLAB / 2, r.y + r.d / 2, g);
        this.box(r.w, 0.03, r.d, this.mat.roof, r.x + r.w / 2, roofY + 0.015, r.y + r.d / 2, g, false);
      }
      const ext = exteriorEdges(top);
      for (const r of top) {
        const e = ext.get(r.id);
        const sides = [
          { axis: 'h', pos: r.y, a: r.x, b: r.x + r.w, isExt: e.top, inward: 1 },
          { axis: 'h', pos: r.y + r.d, a: r.x, b: r.x + r.w, isExt: e.bottom, inward: -1 },
          { axis: 'v', pos: r.x, a: r.y, b: r.y + r.d, isExt: e.left, inward: 1 },
          { axis: 'v', pos: r.x + r.w, a: r.y, b: r.y + r.d, isExt: e.right, inward: -1 },
        ];
        for (const s of sides) if (s.isExt) this.wall(s, WALL, PARAPET, roofY, this.mat.wallExt, [], g);
      }
      if (brief.terraceStair && stair) {
        // Headroom cabin over the stair with a door onto the terrace.
        const hh = 2.4;
        const s = stair;
        const sides = [
          { axis: 'h', pos: s.y, a: s.x, b: s.x + s.w, inward: 1 },
          { axis: 'h', pos: s.y + s.d, a: s.x, b: s.x + s.w, inward: -1 },
          { axis: 'v', pos: s.x, a: s.y, b: s.y + s.d, inward: 1 },
          { axis: 'v', pos: s.x + s.w, a: s.y, b: s.y + s.d, inward: -1 },
        ];
        const door = { axis: 'h', pos: s.y + s.d, a: s.x + s.w / 2 + 0.1, w: 0.9, sill: 0, head: 2.1 };
        for (const sd of sides) this.wall(sd, WALL, hh, roofY, this.mat.wallExt, sd.pos === door.pos && sd.axis === 'h' ? [door] : [], g);
        this.box(s.w + 0.3, SLAB, s.d + 0.3, this.mat.slab, s.x + s.w / 2, roofY + hh + SLAB / 2, s.y + s.d / 2, g);
      }
    }

    // Sun and shadow camera sized to the site.
    const span = Math.max(W, D) + 8;
    this.sun.position.set(W / 2 - span * 0.6, span * 1.1, D / 2 + span * 0.7);
    this.sun.target.position.set(W / 2, 0, D / 2);
    const sc = this.sun.shadow.camera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 0.5; sc.far = span * 4;
    sc.updateProjectionMatrix();

    if (this.needsFit) { this.view('iso', state); this.needsFit = false; }
  }

  wall(s, t, h, base, mat, cuts, group, low = false) {
    const pieces = [];
    const sorted = cuts.map((c) => ({ a: Math.max(s.a, c.a), b: Math.min(s.b, c.a + c.w), sill: c.sill ?? 0, head: Math.min(c.head ?? 2.1, h) })).sort((p, q) => p.a - q.a);
    let cur = s.a;
    for (const c of sorted) {
      if (c.a > cur) pieces.push([cur, c.a, 0, h]);
      if (c.sill > 0) pieces.push([c.a, c.b, 0, c.sill]);
      if (c.head < h) pieces.push([c.a, c.b, c.head, h]);
      cur = Math.max(cur, c.b);
    }
    if (cur < s.b) pieces.push([cur, s.b, 0, h]);
    const off = s.inward > 0 ? s.pos + t / 2 : s.pos - t / 2;
    for (const [a, b, y0, y1] of pieces) {
      if (b - a < 0.005 || y1 - y0 < 0.005) continue;
      const len = b - a, mid = (a + b) / 2, hy = base + (y0 + y1) / 2;
      if (s.axis === 'h') this.box(len, y1 - y0, t, mat, mid, hy, off, group);
      else this.box(t, y1 - y0, len, mat, off, hy, mid, group);
    }
    if (low) {
      // Railing cap on balcony parapets.
      const len = s.b - s.a, mid = (s.a + s.b) / 2;
      if (s.axis === 'h') this.box(len, 0.05, t + 0.04, this.mat.rail, mid, base + h + 0.025, off, group);
      else this.box(t + 0.04, 0.05, len, this.mat.rail, off, base + h + 0.025, mid, group);
    }
  }

  doorLeaf(d, base, group) {
    const w = d.w, th = 0.04, hgt = 2.05;
    const pivot = new THREE.Group();
    const mat = d.kind === 'main' ? this.mat.mainDoor : this.mat.door;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, th), mat);
    leaf.position.set(w / 2, hgt / 2, 0);
    leaf.castShadow = true;
    pivot.add(leaf);
    const open = (d.kind === 'main' ? 30 : 65) * Math.PI / 180;
    if (d.axis === 'h') {
      pivot.position.set(d.a, base, d.pos);
      pivot.rotation.y = d.side > 0 ? -open : open;
    } else {
      pivot.position.set(d.pos, base, d.a);
      pivot.rotation.y = -Math.PI / 2 + (d.side > 0 ? open : -open);
    }
    group.add(pivot);
  }

  windowPane(w, base, rooms, group, clipH) {
    const mid = w.a + w.w / 2;
    const probe = 0.05;
    const hit = (px, pz) => rooms.some((r) => px > r.x && px < r.x + r.w && pz > r.y && pz < r.y + r.d);
    const inward = w.axis === 'h' ? (hit(mid, w.pos + probe) ? 1 : -1) : (hit(w.pos + probe, mid) ? 1 : -1);
    const off = inward > 0 ? w.pos + WALL * 0.3 : w.pos - WALL * 0.3;
    const head = clipH != null ? Math.min(w.head, clipH) : w.head;
    const h = head - w.sill, y = base + w.sill + h / 2;
    if (h <= 0.02) return;
    if (w.axis === 'h') {
      this.box(w.w, h, 0.02, this.mat.glass, mid, y, off, group, false);
      this.box(w.w, 0.05, 0.08, this.mat.frame, mid, base + w.sill, off, group, false);
      this.box(0.04, h, 0.06, this.mat.frame, mid, y, off, group, false);
    } else {
      this.box(0.02, h, w.w, this.mat.glass, off, y, mid, group, false);
      this.box(0.08, 0.05, w.w, this.mat.frame, off, base + w.sill, mid, group, false);
      this.box(0.06, h, 0.04, this.mat.frame, off, y, mid, group, false);
    }
  }

  stair(r, base, H, group) {
    // Dog-legged stair: first flight runs away from the road on the left half,
    // a landing at the rear, then back on the right half.
    const risers = Math.round(H / 0.15);
    const perFlight = Math.ceil(risers / 2);
    const rise = H / risers;
    const landing = Math.min(1.0, r.d * 0.3);
    const tread = (r.d - landing) / perFlight;
    const half = r.w / 2 - 0.02;
    for (let i = 0; i < perFlight; i++) {
      const top = (i + 1) * rise;
      const z = r.y + r.d - (i + 0.5) * tread;
      this.box(half, top, tread, this.mat.step, r.x + half / 2, base + top / 2, z, group);
    }
    const landY = perFlight * rise;
    this.box(r.w, 0.15, landing, this.mat.step, r.x + r.w / 2, base + landY - 0.075, r.y + landing / 2, group);
    for (let i = 0; i < risers - perFlight; i++) {
      const top = landY + (i + 1) * rise;
      const z = r.y + landing + (i + 0.5) * tread;
      this.box(half, 0.15, tread, this.mat.step, r.x + r.w - half / 2, base + top - 0.075, z, group);
    }
  }

  car(r, group) {
    const cw = Math.min(1.75, r.w - 0.5), cl = Math.min(4.2, r.d - 0.4);
    if (cw < 1 || cl < 2.5) return;
    const cx = r.x + r.w / 2, cz = r.y + r.d / 2;
    this.box(cw, 0.65, cl, this.mat.car, cx, 0.5, cz, group);
    this.box(cw * 0.86, 0.5, cl * 0.5, this.mat.car, cx, 1.05, cz - cl * 0.05, group);
    this.box(cw * 0.87, 0.36, cl * 0.46, this.mat.glass, cx, 1.03, cz - cl * 0.05, group, false);
  }

  pillars(r, base, h, group) {
    const p = 0.3;
    for (const [x, z] of [[r.x + p / 2, r.y + r.d - p / 2], [r.x + r.w - p / 2, r.y + r.d - p / 2]]) {
      this.box(p, h, p, this.mat.wallExt, x, base + h / 2, z, group);
    }
  }

  view(kind, state) {
    const { brief, plan } = state;
    const box = bbox(plan.floors.flatMap((f) => f.rooms)) || { x: 0, y: 0, w: brief.plotW, d: brief.plotD };
    const cx = box.x + box.w / 2, cz = box.y + box.d / 2;
    const height = PLINTH + plan.floors.length * brief.floorH;
    const r = Math.max(brief.plotW, brief.plotD) * 1.25 + height;
    this.controls.target.set(cx, height * 0.35, cz);
    if (kind === 'top') this.camera.position.set(cx, r * 1.5, cz + 0.01);
    else if (kind === 'front') this.camera.position.set(cx, height * 0.55, cz + r * 1.1);
    else this.camera.position.set(cx + r * 0.75, r * 0.7, cz + r * 0.95);
    this.controls.update();
  }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
