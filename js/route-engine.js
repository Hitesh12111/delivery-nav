// Route engine: turns society.json into a routable graph and answers
// "how does a <role> get from <gate> to <tower entrance>?".
// Pure data — no rendering. Roles and road types come from society.access.

const EPS = 1e-6;
const key = (x, z) => `${Math.round(x * 10)}/${Math.round(z * 10)}`;
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

export function towerExtents(t) {
  // Footprint is 32 x 20 m; rot 90 swaps the axes.
  const L = 32, D = 20;
  return t.rot === 90 ? { hx: D / 2, hz: L / 2 } : { hx: L / 2, hz: D / 2 };
}

export function doorPoint(t, side) {
  const [dx, dz] = DIRS[side];
  const { hx, hz } = towerExtents(t);
  return { x: t.x + dx * hx, z: t.z + dz * hz };
}

function segIntersect(a, b, c, d) {
  // Returns [t, u] params where a + t(b-a) == c + u(d-c), or null.
  const r = [b.x - a.x, b.z - a.z], s = [d.x - c.x, d.z - c.z];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < EPS) return null;
  const qp = [c.x - a.x, c.z - a.z];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return [Math.min(1, Math.max(0, t)), Math.min(1, Math.max(0, u))];
}

function projectOnSeg(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  const x = a.x + dx * t, z = a.z + dz * t;
  return { t, x, z, d: Math.hypot(p.x - x, p.z - z) };
}

export function buildGraph(society) {
  // 1. Raw segments from road polylines.
  const segs = [];
  for (const r of society.roads) {
    const pts = r.points.map(([x, z]) => ({ x, z }));
    const n = r.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      segs.push({ a: pts[i], b: pts[(i + 1) % pts.length], type: r.type, road: r, splits: [0, 1] });
    }
  }

  // 2. Junctions wherever roads cross or touch.
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const hit = segIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (hit) { segs[i].splits.push(hit[0]); segs[j].splits.push(hit[1]); }
    }
  }

  // 3. Entrances: connect each tower door to the nearest road its role may use.
  const spurs = [];
  const nonGate = (types) => types.filter((t) => !t.startsWith('gate_') && !t.startsWith('spur_'));
  const doorKinds = [
    { kind: 'service', side: 'serviceSide', role: 'delivery', spurType: 'spur_service' },
    { kind: 'resident', side: 'residentSide', role: 'resident', spurType: 'spur_resident' },
  ];
  for (const t of society.towers) {
    for (const dk of doorKinds) {
      const door = doorPoint(t, t[dk.side]);
      const allowed = nonGate(society.access[dk.role]);
      let best = null;
      for (const s of segs) {
        if (!allowed.includes(s.type)) continue;
        const p = projectOnSeg(door, s.a, s.b);
        if (!best || p.d < best.p.d) best = { s, p };
      }
      if (!best) continue;
      best.s.splits.push(best.p.t);
      spurs.push({ id: `${t.id}:${dk.kind}`, tower: t.id, kind: dk.kind, door, to: { x: best.p.x, z: best.p.z }, type: dk.spurType });
    }
  }

  // 4. Nodes + edges.
  const nodes = new Map();
  const adj = new Map();
  const edges = [];
  const addNode = (id, x, z, extra = {}) => {
    if (!nodes.has(id)) { nodes.set(id, { id, x, z, ...extra }); adj.set(id, []); }
    return id;
  };
  const addEdge = (a, b, type, road) => {
    if (a === b) return;
    const A = nodes.get(a), B = nodes.get(b);
    const len = Math.hypot(A.x - B.x, A.z - B.z);
    const e = { a, b, len, type, roadId: road?.id, roadName: road?.name };
    edges.push(e);
    adj.get(a).push({ to: b, e });
    adj.get(b).push({ to: a, e });
  };

  for (const s of segs) {
    const ts = [...new Set(s.splits.map((t) => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y);
    let prev = null;
    for (const t of ts) {
      const x = s.a.x + (s.b.x - s.a.x) * t, z = s.a.z + (s.b.z - s.a.z) * t;
      const id = addNode(key(x, z), x, z);
      if (prev) addEdge(prev, id, s.type, s.road);
      prev = id;
    }
  }

  for (const sp of spurs) {
    addNode(sp.id, sp.door.x, sp.door.z, { tower: sp.tower, kind: sp.kind });
    addEdge(sp.id, key(sp.to.x, sp.to.z), sp.type, { id: `${sp.id}:spur`, name: `Tower ${sp.tower.slice(1)} ${sp.kind} entrance` });
  }

  // 5. Gates attach to the nearest road node.
  for (const g of society.gates) {
    addNode(g.id, g.x, g.z, { gate: g });
    let best = null;
    for (const n of nodes.values()) {
      if (n.id === g.id || n.tower) continue;
      const d = Math.hypot(n.x - g.x, n.z - g.z);
      if (!best || d < best.d) best = { n, d };
    }
    const road = society.roads.find((r) => r.type === (g.type === 'main' ? 'gate_main' : 'gate_service'));
    addEdge(g.id, best.n.id, g.type === 'main' ? 'gate_main' : 'gate_service', road);
  }

  return { nodes, adj, edges, spurs, society };
}

export function findRoute(graph, fromId, toId, role) {
  const allowed = new Set(graph.society.access[role]);
  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const done = new Set();
  // Graph is tiny (~100 nodes): a linear-scan Dijkstra is plenty.
  while (true) {
    let u = null, best = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; u = id; }
    if (u === null || u === toId) break;
    done.add(u);
    for (const { to, e } of graph.adj.get(u)) {
      if (!allowed.has(e.type)) continue;
      const nd = best + e.len;
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, { from: u, e }); }
    }
  }
  if (!dist.has(toId)) return null;

  const ids = [toId], legs = [];
  let cur = toId;
  while (prev.has(cur)) { const p = prev.get(cur); legs.unshift(p.e); ids.unshift(p.from); cur = p.from; }
  const points = ids.map((id) => ({ x: graph.nodes.get(id).x, z: graph.nodes.get(id).z }));
  return { role, from: fromId, to: toId, ids, legs, points, length: dist.get(toId) };
}

// Collapse the node-by-node route into human-sized manoeuvres.
export function describeRoute(graph, route) {
  const segs = [];
  for (let i = 0; i < route.legs.length; i++) {
    const a = route.points[i], b = route.points[i + 1], e = route.legs[i];
    if (e.len < 0.5) continue; // gate node sits on the road end
    const dir = { x: (b.x - a.x) / e.len, z: (b.z - a.z) / e.len };
    const last = segs[segs.length - 1];
    const straight = last && Math.abs(last.dir.x * dir.z - last.dir.z * dir.x) < 0.02 && last.dir.x * dir.x + last.dir.z * dir.z > 0;
    if (last && straight && last.type === e.type) {
      last.len += e.len; last.b = b; last.junctions++;
    } else {
      segs.push({ a, b, dir, len: e.len, type: e.type, roadName: e.roadName, junctions: 0 });
    }
  }

  const landmarks = graph.society.landmarks || [];
  return segs.map((s, i) => {
    let turn = 'start';
    if (i > 0) {
      const p = segs[i - 1].dir;
      const cross = p.x * s.dir.z - p.z * s.dir.x; // +ve = clockwise = right (x east, z south)
      turn = Math.abs(cross) < 0.3 ? 'straight' : cross > 0 ? 'right' : 'left';
    }
    const past = landmarks.find((l) => {
      const pr = projectOnSeg(l, s.a, s.b);
      return pr.d < 45 && pr.t > 0.1 && pr.t < 0.9;
    });
    return { ...s, turn, past: past?.name, isLast: i === segs.length - 1 };
  });
}
