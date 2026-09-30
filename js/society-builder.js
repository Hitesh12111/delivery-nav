// Society builder: turns society.json into an architectural "white model".
// Everything is generated from data — move a tower in the JSON and the
// towers, driveways, trees and labels follow.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { towerExtents, doorPoint } from './route-engine.js';

export const C = {
  bg: 0xeceeec,
  outside: 0xdfe1dd,
  site: 0xe4e9df,
  paving: 0xf3f2ee,
  lawn: 0xd0ddc4,
  track: 0xede8df,
  road: 0xd2d5d7,
  service: 0xe4d9c8,
  sectorRoad: 0xcdd0d2,
  wall: 0xdedfd9,
  shell: 0xf7f9fa,
  edge: 0x76818a,
  slab: 0xa3adb4,
  core: 0xd9dee2,
  canopy: [0xb3c6a8, 0xa8bd9d, 0xbdcdb2, 0xc4d2ba],
  trunk: 0xbfb6a8,
  water: 0xb7d6de,
  court: 0xd8c6b4,
  red: 0xe0262d,
  ink: 0x15191d,
};

// Y layers (m). Generous gaps avoid z-fighting at long camera distances.
const Y = { site: 0.0, lawn: 0.12, paving: 0.14, road: 0.24, service: 0.28, mark: 0.36 };

const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function flatQuad(p, y) {
  // p: 4 corners {x,z} in CCW order seen from above.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p.flatMap((q) => [q.x, y, q.z]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

const rectQuad = (minX, maxX, minZ, maxZ, y) =>
  flatQuad([{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }], y);

function stripQuad(a, b, w, y, cap = true) {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  const n = { x: -d.z, z: d.x };
  const e = cap ? w / 2 : 0, h = w / 2;
  const A = { x: a.x - d.x * e, z: a.z - d.z * e }, B = { x: b.x + d.x * e, z: b.z + d.z * e };
  return flatQuad([
    { x: A.x + n.x * h, z: A.z + n.z * h }, { x: A.x - n.x * h, z: A.z - n.z * h },
    { x: B.x - n.x * h, z: B.z - n.z * h }, { x: B.x + n.x * h, z: B.z + n.z * h },
  ], y);
}

function shapeFlat(shape, y) {
  const g = new THREE.ShapeGeometry(shape, 24);
  g.rotateX(Math.PI / 2); // shape y -> world +z
  g.translate(0, y, 0);
  // rotateX(+90) flips the face down; flip winding back up.
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.computeVertexNormals();
  return g;
}

function roundedRectShape(minX, maxX, minZ, maxZ, r) {
  const s = new THREE.Shape();
  s.moveTo(minX + r, minZ);
  s.lineTo(maxX - r, minZ); s.quadraticCurveTo(maxX, minZ, maxX, minZ + r);
  s.lineTo(maxX, maxZ - r); s.quadraticCurveTo(maxX, maxZ, maxX - r, maxZ);
  s.lineTo(minX + r, maxZ); s.quadraticCurveTo(minX, maxZ, minX, maxZ - r);
  s.lineTo(minX, minZ + r); s.quadraticCurveTo(minX, minZ, minX + r, minZ);
  return s;
}

function ellipseShape(x, z, rx, rz, hole) {
  const s = new THREE.Shape();
  s.absellipse(x, z, rx, rz, 0, Math.PI * 2, false);
  if (hole) {
    const h = new THREE.Path();
    h.absellipse(x, z, hole[0], hole[1], 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  return s;
}

function label(html, cls, pos) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  el.innerHTML = `<div class="lbl-in">${html}</div>`;
  const o = new CSS2DObject(el);
  o.position.copy(pos);
  return o;
}

// H-shaped tower footprint (32 x 20 m), typical of Gurgaon 4-flat-per-core towers.
function towerShape() {
  const pts = [[-16, -10], [-5, -10], [-5, -4], [5, -4], [5, -10], [16, -10], [16, 10], [5, 10], [5, 4], [-5, 4], [-5, 10], [-16, 10]];
  const s = new THREE.Shape();
  pts.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)));
  return { shape: s, outline: pts };
}

export function buildSociety(society) {
  const root = new THREE.Group();
  const fh = society.floorHeight;
  const site = society.site;
  const obstacles = []; // rects for tree placement
  const roadsForTrees = []; // {a,b,hw}
  const labels = { towers: {}, gates: {}, amenities: [] };

  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, ...extra });

  // ---------- ground ----------
  const outside = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), mat(C.outside));
  outside.position.y = -0.05;
  outside.receiveShadow = true;
  root.add(outside);

  const siteMesh = new THREE.Mesh(rectQuad(site.minX, site.maxX, site.minZ, site.maxZ, Y.site), mat(C.site));
  siteMesh.receiveShadow = true;
  root.add(siteMesh);

  // Outside sector roads with lane dashes.
  const sectorGeoms = [], dashGeoms = [];
  for (const r of society.outsideRoads) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = { x: r.points[i][0], z: r.points[i][1] }, b = { x: r.points[i + 1][0], z: r.points[i + 1][1] };
      sectorGeoms.push(stripQuad(a, b, r.width, Y.road));
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 0; d < len; d += 12) {
        const t0 = d / len, t1 = Math.min(1, (d + 5) / len);
        dashGeoms.push(stripQuad(
          { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 },
          { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 }, 0.35, Y.mark, false));
      }
    }
  }
  const sector = new THREE.Mesh(mergeGeometries(sectorGeoms), mat(C.sectorRoad));
  sector.receiveShadow = true;
  root.add(sector);
  root.add(new THREE.Mesh(mergeGeometries(dashGeoms), new THREE.MeshBasicMaterial({ color: 0xf4f4f2 })));

  // ---------- central green ----------
  const g = society.green;
  const lawn = new THREE.Mesh(shapeFlat(roundedRectShape(g.minX, g.maxX, g.minZ, g.maxZ, 18), Y.lawn), mat(C.lawn));
  lawn.receiveShadow = true;
  root.add(lawn);
  const cx = (g.minX + g.maxX) / 2, cz = (g.minZ + g.maxZ) / 2;
  const rx = (g.maxX - g.minX) / 2 - 12, rz = (g.maxZ - g.minZ) / 2 - 12;
  const track = new THREE.Mesh(shapeFlat(ellipseShape(cx, cz, rx, rz, [rx - 3, rz - 3]), Y.paving), mat(C.track));
  track.receiveShadow = true;
  root.add(track);
  const plaza = new THREE.Mesh(shapeFlat(ellipseShape(cx, cz, g.plazaRadius, g.plazaRadius), Y.paving), mat(C.paving));
  plaza.receiveShadow = true;
  root.add(plaza);
  // Cross paths from plaza to the avenues.
  const paths = [
    stripQuad({ x: cx, z: g.minZ }, { x: cx, z: g.maxZ }, 3, Y.paving - 0.01, false),
    stripQuad({ x: g.minX + 8, z: cz }, { x: g.maxX - 8, z: cz }, 3, Y.paving - 0.01, false),
  ];
  root.add(new THREE.Mesh(mergeGeometries(paths), mat(C.track)));
  const fountain = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 0.6, 48), mat(C.water, { roughness: 0.3 }));
  fountain.position.set(cx, 0.3, cz);
  root.add(fountain);
  const pond = new THREE.Mesh(shapeFlat(ellipseShape(g.pond.x, g.pond.z, g.pond.rx, g.pond.rz), Y.paving + 0.02), mat(C.water, { roughness: 0.25 }));
  root.add(pond);
  obstacles.push({ minX: g.pond.x - g.pond.rx - 2, maxX: g.pond.x + g.pond.rx + 2, minZ: g.pond.z - g.pond.rz - 2, maxZ: g.pond.z + g.pond.rz + 2 });
  obstacles.push({ minX: cx - g.plazaRadius - 3, maxX: cx + g.plazaRadius + 3, minZ: cz - g.plazaRadius - 3, maxZ: cz + g.plazaRadius + 3 });

  // ---------- roads ----------
  const roadGeoms = { internal: [], service: [] };
  for (const r of society.roads) {
    const pts = r.points.map(([x, z]) => ({ x, z }));
    const n = r.closed ? pts.length : pts.length - 1;
    const bucket = ['service', 'gate_service'].includes(r.type) ? 'service' : 'internal';
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      roadGeoms[bucket].push(stripQuad(a, b, r.width, bucket === 'service' ? Y.service : Y.road));
      roadsForTrees.push({ a, b, hw: r.width / 2 });
    }
  }

  // ---------- towers ----------
  const { shape, outline } = towerShape();
  const shellMat = new THREE.MeshStandardMaterial({
    color: C.shell, roughness: 0.55, metalness: 0, transparent: true, opacity: 0.8, depthWrite: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.85 });
  const slabMat = new THREE.LineBasicMaterial({ color: C.slab, transparent: true, opacity: 0.55 });
  const coreMat = mat(C.core);
  const podiumGeoms = [];
  const towers = {};

  for (const t of society.towers) {
    const h = t.floors * fh + 1.2;
    const grp = new THREE.Group();
    grp.position.set(t.x, 0, t.z);
    grp.rotation.y = t.rot === 90 ? Math.PI / 2 : 0;

    const body = new THREE.Group(); // scaled during the "rise" intro
    grp.add(body);

    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const shell = new THREE.Mesh(geo, shellMat);
    shell.castShadow = true;
    shell.renderOrder = 2;
    body.add(shell);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), edgeMat);
    body.add(edges);

    const slabPts = [];
    for (let f = 1; f < t.floors; f++) {
      const y = f * fh;
      for (let i = 0; i < outline.length; i++) {
        const [x0, z0] = outline[i], [x1, z1] = outline[(i + 1) % outline.length];
        slabPts.push(x0, y, z0, x1, y, z1);
      }
    }
    const slabGeo = new THREE.BufferGeometry();
    slabGeo.setAttribute('position', new THREE.Float32BufferAttribute(slabPts, 3));
    const slabs = new THREE.LineSegments(slabGeo, slabMat);
    body.add(slabs);

    // Lift/stair core, visible through the frosted shell; rises above roof as the machine room.
    const core = new THREE.Mesh(new THREE.BoxGeometry(8, h + 3.5, 6), coreMat);
    core.position.y = (h + 3.5) / 2;
    core.castShadow = true;
    body.add(core);
    const tank = new THREE.Mesh(new THREE.BoxGeometry(5, 2.2, 4), coreMat);
    tank.position.set(-11, h + 1.1, 0);
    body.add(tank);

    root.add(grp);

    const { hx, hz } = towerExtents(t);
    podiumGeoms.push(rectQuad(t.x - hx - 5, t.x + hx + 5, t.z - hz - 5, t.z + hz + 5, Y.paving));
    obstacles.push({ minX: t.x - hx - 6, maxX: t.x + hx + 6, minZ: t.z - hz - 6, maxZ: t.z + hz + 6 });

    const lbl = label(`<span class="n">${t.label}</span>`, 'lbl-tower', new THREE.Vector3(t.x, h + 8, t.z));
    root.add(lbl);
    labels.towers[t.id] = lbl;

    towers[t.id] = { data: t, group: grp, body, shell, edges, slabs, height: h, geo };
  }
  root.add(Object.assign(new THREE.Mesh(mergeGeometries(podiumGeoms), mat(C.paving)), { receiveShadow: true }));

  // Driveways from each entrance to its road (generated from the same data the router uses).
  const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
  for (const t of society.towers) {
    for (const [side, kind] of [[t.serviceSide, 'service'], [t.residentSide, 'resident']]) {
      const d = doorPoint(t, side);
      const [dx, dz] = DIRS[side];
      const types = society.access[kind === 'service' ? 'delivery' : 'resident'].filter((x) => !x.startsWith('gate_') && !x.startsWith('spur_'));
      // March outward until we hit a road of an allowed type.
      let end = null;
      for (let s = 0; s < 80 && !end; s += 0.5) {
        const p = { x: d.x + dx * s, z: d.z + dz * s };
        for (const r of society.roads) {
          if (!types.includes(r.type)) continue;
          const pts = r.points;
          const n = r.closed ? pts.length : pts.length - 1;
          for (let i = 0; i < n && !end; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]), minZ = Math.min(a[1], b[1]), maxZ = Math.max(a[1], b[1]);
            if (p.x >= minX - 0.3 && p.x <= maxX + 0.3 && p.z >= minZ - 0.3 && p.z <= maxZ + 0.3) end = p;
          }
        }
      }
      if (!end) continue;
      roadGeoms[kind === 'service' ? 'service' : 'internal'].push(stripQuad(d, end, kind === 'service' ? 5 : 6, kind === 'service' ? Y.service : Y.road, false));
      roadsForTrees.push({ a: d, b: end, hw: 3 });
    }
  }

  const roadMesh = new THREE.Mesh(mergeGeometries(roadGeoms.internal), mat(C.road));
  roadMesh.receiveShadow = true;
  root.add(roadMesh);
  const serviceMesh = new THREE.Mesh(mergeGeometries(roadGeoms.service), mat(C.service));
  serviceMesh.receiveShadow = true;
  root.add(serviceMesh);

  // ---------- boundary wall with gate openings ----------
  const wallGeoms = [];
  const wh = site.wallHeight, wt = 0.5;
  const gateGap = (axis, v) => society.gates.find((gt) => (gt.axis === 'z' ? gt.z : gt.x) === v && gt.axis === axis);
  const wallRun = (a, b, fixed, axis) => {
    // axis 'x' => wall runs along x at z=fixed, gates with axis 'z' cut it.
    const gate = society.gates.find((gt) => (axis === 'x' ? gt.axis === 'z' && gt.z === fixed : gt.axis === 'x' && gt.x === fixed));
    const spans = gate ? [[a, (axis === 'x' ? gate.x : gate.z) - gate.width / 2 - 3], [(axis === 'x' ? gate.x : gate.z) + gate.width / 2 + 3, b]] : [[a, b]];
    for (const [s0, s1] of spans) {
      const len = s1 - s0;
      const box = new THREE.BoxGeometry(axis === 'x' ? len : wt, wh, axis === 'x' ? wt : len);
      box.translate(axis === 'x' ? (s0 + s1) / 2 : fixed, wh / 2, axis === 'x' ? fixed : (s0 + s1) / 2);
      wallGeoms.push(box);
    }
  };
  void gateGap;
  wallRun(site.minX, site.maxX, site.minZ, 'x');
  wallRun(site.minX, site.maxX, site.maxZ, 'x');
  wallRun(site.minZ, site.maxZ, site.minX, 'z');
  wallRun(site.minZ, site.maxZ, site.maxX, 'z');
  const wall = new THREE.Mesh(mergeGeometries(wallGeoms), mat(C.wall));
  wall.castShadow = true; wall.receiveShadow = true;
  root.add(wall);

  // ---------- gates ----------
  const solid = mat(0xf2f2ef);
  const barrierTex = (() => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 8;
    const x = c.getContext('2d');
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#ffffff' : '#d8262d'; x.fillRect(i * 16, 0, 16, 8); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  for (const gt of society.gates) {
    const G = new THREE.Group();
    G.position.set(gt.x, 0, gt.z);
    if (gt.axis === 'x') G.rotation.y = Math.PI / 2; // road runs along x => gate spans z
    const main = gt.type === 'main';
    const ph = main ? 9 : 5.5, pw = main ? 2.6 : 1.6;
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pw), solid);
      p.position.set(s * (gt.width / 2 + pw / 2 + 0.5), ph / 2, 0);
      p.castShadow = true;
      G.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(gt.width + pw * 2 + 1, main ? 1.8 : 0.9, main ? 3.2 : 1.6), solid);
    beam.position.y = ph - (main ? 0.9 : 0.45);
    beam.castShadow = true;
    G.add(beam);
    // Boom barrier (half width, closed).
    const boom = new THREE.Mesh(new THREE.BoxGeometry(gt.width / (main ? 2 : 1) - 0.6, 0.18, 0.18), new THREE.MeshBasicMaterial({ map: barrierTex }));
    boom.position.set(main ? gt.width / 4 : 0, 1.1, main ? -2 : 1.2);
    G.add(boom);
    // Guard cabin inside the wall.
    const cab = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 4), solid);
    cab.position.set(gt.width / 2 + 6, 1.5, main ? -6 : -5);
    cab.castShadow = true;
    G.add(cab);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.35, 5.2), mat(0xd9ddde));
    roof.position.set(cab.position.x, 3.2, cab.position.z);
    G.add(roof);
    root.add(G);
    const lp = new THREE.Vector3(gt.x, ph + 4, gt.z);
    const lbl = label(`<b>${gt.name}</b><span>${gt.sub}</span>`, `lbl-gate ${main ? 'is-main' : 'is-service'}`, lp);
    root.add(lbl);
    labels.gates[gt.id] = lbl;
  }

  // ---------- clubhouse ----------
  const cl = society.clubhouse;
  const club = new THREE.Group();
  const clubMat = new THREE.MeshStandardMaterial({ color: C.shell, roughness: 0.4, transparent: true, opacity: 0.8, depthWrite: false });
  const lower = new THREE.Mesh(new THREE.BoxGeometry(cl.w, cl.h * 0.55, cl.d), clubMat);
  lower.position.y = cl.h * 0.275;
  const upper = new THREE.Mesh(new THREE.BoxGeometry(cl.w * 0.62, cl.h * 0.45, cl.d * 0.8), clubMat);
  upper.position.set(-cl.w * 0.15, cl.h * 0.55 + cl.h * 0.225, 0);
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(cl.w + 4, 0.5, cl.d + 4), mat(0xf4f4f1));
  canopy.position.y = cl.h * 0.55;
  for (const m of [lower, upper, canopy]) { m.castShadow = true; club.add(m); }
  for (const m of [lower, upper]) club.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat).translateX(m.position.x).translateY(m.position.y));
  club.position.set(cl.x, 0, cl.z);
  root.add(club);
  const deck = new THREE.Mesh(rectQuad(cl.pool.x - cl.pool.w / 2 - 3, cl.pool.x + cl.pool.w / 2 + 3, cl.pool.z - cl.pool.d / 2 - 2, cl.pool.z + cl.pool.d / 2 + 2, Y.paving), mat(C.paving));
  deck.receiveShadow = true;
  root.add(deck);
  root.add(new THREE.Mesh(rectQuad(cl.pool.x - cl.pool.w / 2, cl.pool.x + cl.pool.w / 2, cl.pool.z - cl.pool.d / 2, cl.pool.z + cl.pool.d / 2, Y.paving + 0.04), mat(0x9fcbd8, { roughness: 0.2 })));
  obstacles.push({ minX: cl.x - cl.w / 2 - 4, maxX: cl.x + cl.w / 2 + 4, minZ: cl.z - cl.d / 2 - 4, maxZ: cl.pool.z + cl.pool.d / 2 + 4 });
  labels.amenities.push(label('Clubhouse', 'lbl-amenity', new THREE.Vector3(cl.x, cl.h + 5, cl.z)));

  // ---------- courts ----------
  for (const ct of society.courts || []) {
    root.add(new THREE.Mesh(rectQuad(ct.x - ct.w / 2 - 3, ct.x + ct.w / 2 + 3, ct.z - ct.d / 2 - 3, ct.z + ct.d / 2 + 3, Y.paving), mat(0xcfd9c8)));
    root.add(new THREE.Mesh(rectQuad(ct.x - ct.w / 2, ct.x + ct.w / 2, ct.z - ct.d / 2, ct.z + ct.d / 2, Y.paving + 0.03), mat(C.court)));
    const lp = [];
    const r = [ct.x - ct.w / 2 + 0.5, ct.x + ct.w / 2 - 0.5, ct.z - ct.d / 2 + 0.5, ct.z + ct.d / 2 - 0.5];
    lp.push(r[0], 0.3, r[2], r[1], 0.3, r[2], r[1], 0.3, r[2], r[1], 0.3, r[3], r[1], 0.3, r[3], r[0], 0.3, r[3], r[0], 0.3, r[3], r[0], 0.3, r[2], ct.x, 0.3, r[2], ct.x, 0.3, r[3]);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    root.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffffff })));
    obstacles.push({ minX: ct.x - ct.w / 2 - 4, maxX: ct.x + ct.w / 2 + 4, minZ: ct.z - ct.d / 2 - 4, maxZ: ct.z + ct.d / 2 + 4 });
  }
  for (const l of labels.amenities) root.add(l);

  // ---------- parking ----------
  const rand = rng(65);
  const lotGeoms = [], lineP = [], cars = [];
  for (const p of society.parking) {
    lotGeoms.push(rectQuad(p.minX, p.maxX, p.minZ, p.maxZ, Y.road - 0.02));
    obstacles.push({ minX: p.minX - 1, maxX: p.maxX + 1, minZ: p.minZ - 1, maxZ: p.maxZ + 1 });
    const alongX = p.rowsAlong === 'x';
    const [a0, a1] = alongX ? [p.minX + 1, p.maxX - 1] : [p.minZ + 1, p.maxZ - 1]; // stall axis
    const [b0, b1] = alongX ? [p.minZ, p.maxZ] : [p.minX, p.maxX]; // depth axis
    // pattern across depth: row(5) aisle(6) row(5) row(5) aisle(6) row(5)...
    const rows = [];
    let b = b0 + 0.5, k = 0;
    while (b + 5 <= b1) {
      rows.push(b);
      b += 5;
      if (k % 2 === 0) b += 6;
      k++;
    }
    for (const r0 of rows) {
      for (let a = a0; a + 2.6 <= a1; a += 2.6) {
        const P = (aa, bb) => (alongX ? [aa, Y.mark, bb] : [bb, Y.mark, aa]);
        lineP.push(...P(a, r0), ...P(a, r0 + 5));
        if (rand() < 0.72) {
          const ca = a + 1.3, cb = r0 + 2.5;
          cars.push({ x: alongX ? ca : cb, z: alongX ? cb : ca, alongX, c: rand() });
        }
      }
    }
  }
  root.add(Object.assign(new THREE.Mesh(mergeGeometries(lotGeoms), mat(0xd9dcdd)), { receiveShadow: true }));
  const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineP, 3));
  root.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xf7f7f5 })));
  const carGeo = new THREE.BoxGeometry(1.8, 1.45, 4.3); carGeo.translate(0, 0.72, 0);
  const carMesh = new THREE.InstancedMesh(carGeo, mat(0xffffff, { roughness: 0.6 }), cars.length);
  const carCols = [0xf4f4f4, 0xe8e9ea, 0xc9ccce, 0xb0b5b9, 0x8d949a, 0xb9c2cc, 0xc7b8ad];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  cars.forEach((c, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.alongX ? 0 : Math.PI / 2);
    m4.compose(new THREE.Vector3(c.x, 0, c.z), q, sc);
    carMesh.setMatrixAt(i, m4);
    carMesh.setColorAt(i, col.setHex(carCols[Math.floor(c.c * carCols.length)]));
  });
  carMesh.castShadow = true;
  root.add(carMesh);

  // ---------- trees ----------
  const treeRand = rng(14);
  const trees = [];
  const blocked = (x, z, pad = 0) => {
    if (x < site.minX + 3 || x > site.maxX - 3 || z < site.minZ + 3 || z > site.maxZ - 3) return true;
    for (const o of obstacles) if (x > o.minX - pad && x < o.maxX + pad && z > o.minZ - pad && z < o.maxZ + pad) return true;
    for (const r of roadsForTrees) {
      const dx = r.b.x - r.a.x, dz = r.b.z - r.a.z, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - r.a.x) * dx + (z - r.a.z) * dz) / l2));
      if (Math.hypot(x - (r.a.x + dx * t), z - (r.a.z + dz * t)) < r.hw + 2.2 + pad) return true;
    }
    // gate forecourts
    for (const gt of society.gates) if (Math.hypot(x - gt.x, z - gt.z) < gt.width + 8) return true;
    return false;
  };
  const tooClose = (x, z, d) => trees.some((t) => Math.hypot(t.x - x, t.z - z) < d);
  const addTree = (x, z, s, minD = 5.5) => { if (!blocked(x, z) && !tooClose(x, z, minD)) trees.push({ x, z, s }); };

  // Avenue trees along roads.
  for (const r of society.roads) {
    const pts = r.points.map(([x, z]) => ({ x, z }));
    const n = r.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len }, nn = { x: -d.z, z: d.x };
      const off = r.width / 2 + 4.2;
      for (let s = 6; s < len - 6; s += 11) {
        for (const sgn of [-1, 1]) addTree(a.x + d.x * s + nn.x * off * sgn, a.z + d.z * s + nn.z * off * sgn, 0.9 + treeRand() * 0.25);
      }
    }
  }
  // Boundary green belt.
  for (let x = site.minX + 5; x < site.maxX - 4; x += 8) { addTree(x, site.minZ + 5, 1.05); addTree(x, site.maxZ - 5, 1.05); }
  for (let z = site.minZ + 5; z < site.maxZ - 4; z += 8) { addTree(site.minX + 5, z, 1.05); addTree(site.maxX - 5, z, 1.05); }
  // Central green clusters.
  for (let i = 0; i < 260; i++) {
    const x = g.minX + 8 + treeRand() * (g.maxX - g.minX - 16), z = g.minZ + 8 + treeRand() * (g.maxZ - g.minZ - 16);
    const e = ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2;
    if (e > 0.78 && e < 1.25) continue; // keep jogging track clear
    if (Math.abs(x - cx) < 3.5 || Math.abs(z - cz) < 3.5) continue; // cross paths
    addTree(x, z, 0.8 + treeRand() * 0.6, 6.5);
  }
  // Fill open pockets across the site.
  for (let i = 0; i < 1400; i++) {
    addTree(site.minX + treeRand() * (site.maxX - site.minX), site.minZ + treeRand() * (site.maxZ - site.minZ), 0.8 + treeRand() * 0.5, 9);
  }

  const canopyGeo = new THREE.IcosahedronGeometry(1, 2);
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.25, 1, 6); trunkGeo.translate(0, 0.5, 0);
  const canopyMesh = new THREE.InstancedMesh(canopyGeo, mat(0xffffff, { roughness: 1 }), trees.length);
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, mat(C.trunk), trees.length);
  trees.forEach((t, i) => {
    const r = 2.6 * t.s, th = 3.2 * t.s;
    m4.compose(new THREE.Vector3(t.x, th + r * 0.75, t.z), q.identity(), new THREE.Vector3(r, r * 0.9, r));
    canopyMesh.setMatrixAt(i, m4);
    canopyMesh.setColorAt(i, col.setHex(C.canopy[i % C.canopy.length]));
    m4.compose(new THREE.Vector3(t.x, 0, t.z), q.identity(), new THREE.Vector3(1, th + 0.5, 1));
    trunkMesh.setMatrixAt(i, m4);
  });
  canopyMesh.castShadow = true;
  root.add(canopyMesh, trunkMesh);

  return { root, towers, labels, treeCount: trees.length, shellMat, edgeMat, slabMat };
}

// Destination treatment: solid, lit, red-edged, with the target floor banded.
export function makeHighlight(tw, floor, fh) {
  const shell = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, transparent: true, opacity: 0.8, depthWrite: false, emissive: 0xfff4f2, emissiveIntensity: 0 });
  const edges = new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.85 });
  const slabs = new THREE.LineBasicMaterial({ color: C.slab, transparent: true, opacity: 0.55 });
  tw.shell.material = shell;
  tw.edges.material = edges;
  tw.slabs.material = slabs;

  // Target floor band.
  const { shape } = towerShape();
  const bandGeo = new THREE.ExtrudeGeometry(shape, { depth: fh, bevelEnabled: false });
  bandGeo.rotateX(-Math.PI / 2);
  const band = new THREE.Mesh(bandGeo, new THREE.MeshBasicMaterial({ color: C.red, transparent: true, opacity: 0, depthWrite: false }));
  band.scale.set(1.035, 1, 1.05);
  band.position.y = floor * fh;
  band.renderOrder = 3;
  tw.body.add(band);

  // Ground halo.
  const halo = new THREE.Mesh(new THREE.RingGeometry(26, 27.2, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.red, transparent: true, opacity: 0, depthWrite: false }));
  halo.position.y = 0.5;
  tw.group.add(halo);

  const red = new THREE.Color(C.red), grey = new THREE.Color(C.edge), slabGrey = new THREE.Color(C.slab), slabRed = new THREE.Color(0xef8b8e);
  return {
    set(a) {
      shell.opacity = 0.8 + 0.17 * a;
      shell.emissiveIntensity = 0.12 * a;
      edges.color.copy(grey).lerp(red, a);
      edges.opacity = 0.85 + 0.15 * a;
      slabs.color.copy(slabGrey).lerp(slabRed, a);
      slabs.opacity = 0.55 + 0.1 * a;
      band.material.opacity = 0.55 * a;
      halo.material.opacity = 0.9 * a;
    },
    tick(time, a) {
      const k = (time % 2.4) / 2.4;
      halo.scale.setScalar(1 + k * 0.5);
      halo.material.opacity = a * 0.9 * (1 - k);
    },
  };
}
