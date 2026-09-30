// Route renderer: the red delivery route (hero element) and the grey dashed
// resident route used for comparison. Geometry is sampled every metre so the
// route can "draw itself" via drawRange.
import * as THREE from 'three';
import { C } from './society-builder.js';

function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; }
  return t;
}

// Clean polyline + rounded corners -> evenly spaced samples.
export function samplePath(points, { y = 1, radius = 12, step = 1 } = {}) {
  const P = [];
  for (const p of points) {
    const last = P[P.length - 1];
    if (last && Math.hypot(last.x - p.x, last.z - p.z) < 0.5) continue;
    P.push({ x: p.x, z: p.z });
  }
  for (let i = P.length - 2; i > 0; i--) {
    const a = P[i - 1], b = P[i], c = P[i + 1];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) < 1e-3) P.splice(i, 1);
  }
  const V = (p) => new THREE.Vector3(p.x, y, p.z);
  const path = new THREE.CurvePath();
  let cur = V(P[0]);
  for (let i = 1; i < P.length - 1; i++) {
    const a = V(P[i - 1]), b = V(P[i]), c = V(P[i + 1]);
    const r = Math.min(radius, a.distanceTo(b) / 2, b.distanceTo(c) / 2);
    const inn = b.clone().sub(a).normalize(), out = c.clone().sub(b).normalize();
    const p0 = b.clone().addScaledVector(inn, -r), p1 = b.clone().addScaledVector(out, r);
    if (cur.distanceTo(p0) > 0.01) path.add(new THREE.LineCurve3(cur, p0));
    path.add(new THREE.QuadraticBezierCurve3(p0, b, p1));
    cur = p1;
  }
  path.add(new THREE.LineCurve3(cur, V(P[P.length - 1])));
  const length = path.getLength();
  const n = Math.max(2, Math.round(length / step));
  const pts = path.getSpacedPoints(n);
  const dist = pts.map((_, i) => (i / n) * length);
  return { pts, dist, length, corners: P };
}

function ribbon(sample, width, y, uScale = 1) {
  const { pts, dist } = sample;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l, nz = tx / l;
    const p = pts[i];
    pos.push(p.x + nx * width / 2, y, p.z + nz * width / 2, p.x - nx * width / 2, y, p.z - nz * width / 2);
    uv.push(dist[i] / uScale, 1, dist[i] / uScale, 0);
    if (i < pts.length - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function curtain(sample, h, y) {
  const { pts, dist } = sample;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    pos.push(p.x, y, p.z, p.x, y + h, p.z);
    uv.push(dist[i], 0, dist[i], 1);
    if (i < pts.length - 1) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const RED = '#e0262d';

export function makeDeliveryRoute(points) {
  const s = samplePath(points, { y: 0, radius: 14 });
  const segs = s.pts.length - 1;
  const group = new THREE.Group();

  const glowTex = canvasTex(4, 64, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(224,38,45,0)'); g.addColorStop(0.5, 'rgba(224,38,45,0.55)'); g.addColorStop(1, 'rgba(224,38,45,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  });
  const wallTex = canvasTex(4, 128, (x, w, h) => {
    const g = x.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(224,38,45,0.42)'); g.addColorStop(0.35, 'rgba(224,38,45,0.16)'); g.addColorStop(1, 'rgba(224,38,45,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  });
  const chevTex = canvasTex(256, 128, (x, w, h) => {
    x.strokeStyle = '#ffffff'; x.lineWidth = 20; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(92, 26); x.lineTo(150, 64); x.lineTo(92, 102); x.stroke();
  }, true);

  const glow = new THREE.Mesh(ribbon(s, 22, 0.45), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, map: glowTex, transparent: true, depthWrite: false }));
  glow.renderOrder = 1;
  const core = new THREE.Mesh(ribbon(s, 5.2, 0.9), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: C.red }));
  const edge = new THREE.Mesh(ribbon(s, 6.6, 0.85), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: 0xffffff }));
  const chev = new THREE.Mesh(ribbon(s, 4.2, 0.98, 11), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, map: chevTex, transparent: true, depthWrite: false }));
  chev.renderOrder = 4;
  const wall = new THREE.Mesh(curtain(s, 9, 0.9), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, map: wallTex, transparent: true, depthWrite: false }));
  wall.renderOrder = 3;
  // X-ray pass: keeps the route readable where towers sit in front of it.
  const xray = new THREE.Mesh(ribbon(s, 5.2, 0.9), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: C.red, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false }));
  xray.renderOrder = 50;
  const meshes = [glow, edge, core, chev, wall, xray];
  group.add(...meshes);

  // Travelling head while drawing.
  const head = new THREE.Group();
  const headDot = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 1.2, 40), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: C.red }));
  headDot.position.y = 1.2;
  const headGlow = new THREE.Mesh(new THREE.CircleGeometry(12, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide,
    map: canvasTex(64, 64, (x, w, h) => {
      const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(224,38,45,0.6)'); g.addColorStop(1, 'rgba(224,38,45,0)');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    }), transparent: true, depthWrite: false,
  }));
  headGlow.position.y = 0.6;
  head.add(headDot, headGlow);
  group.add(head);

  let progress = 0;
  const api = {
    group, sample: s, length: s.length,
    setProgress(p) {
      progress = Math.max(0, Math.min(1, p));
      const n = Math.floor(progress * segs) * 6;
      for (const m of meshes) m.geometry.setDrawRange(0, n);
      const i = Math.min(s.pts.length - 1, Math.floor(progress * segs));
      head.position.set(s.pts[i].x, 0, s.pts[i].z);
      head.visible = progress > 0 && progress < 1;
    },
    // Fade the part already travelled (used during navigation).
    setTravelled() {},
    tick(dt) { chevTex.offset.x -= dt * 1.1; },
    get progress() { return progress; },
  };
  api.setProgress(0);
  return api;
}

export function makeResidentRoute(points) {
  const s = samplePath(points, { y: 0, radius: 12 });
  const dashTex = canvasTex(64, 16, (x, w, h) => {
    x.fillStyle = 'rgba(92,100,108,1)'; x.fillRect(0, 0, w * 0.55, h);
  }, true);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, map: dashTex, transparent: true, opacity: 0, depthWrite: false });
  const mesh = new THREE.Mesh(ribbon(s, 3.4, 0.7, 7), mat);
  mesh.renderOrder = 2;
  const xray = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, map: dashTex, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  xray.renderOrder = 49;
  const group = new THREE.Group();
  group.add(mesh, xray);
  return {
    group, sample: s, length: s.length,
    setOpacity(a) { mat.opacity = 0.9 * a; xray.material.opacity = 0.3 * a; group.visible = a > 0.001; },
  };
}

// "You are here" rider marker with a pulse.
export function makeRiderMarker() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 1, 48), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: 0xffffff }));
  ring.position.y = 1.4;
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 1.2, 48), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: C.ink }));
  dot.position.y = 1.6;
  const pulse = new THREE.Mesh(new THREE.RingGeometry(4.6, 5.6, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: C.ink, transparent: true, opacity: 0.5, depthWrite: false }));
  pulse.position.y = 0.8;
  g.add(ring, dot, pulse);
  return {
    group: g,
    tick(time) {
      const k = (time % 1.8) / 1.8;
      pulse.scale.setScalar(1 + k * 2.4);
      pulse.material.opacity = 0.45 * (1 - k);
    },
  };
}
