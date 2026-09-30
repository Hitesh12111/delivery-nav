// Rider experience. Reads the destination from the URL (what the QR encodes),
// builds the society, computes the delivery-only route and plays the reveal.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { buildSociety, makeHighlight, C } from './society-builder.js';
import { buildGraph, findRoute, describeRoute, doorPoint } from './route-engine.js';
import { makeDeliveryRoute, makeResidentRoute, makeRiderMarker } from './route-renderer.js';
import { CameraDirector, ease } from './camera-director.js';
import { t } from './strings.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// QR payload: #AG65/T14/304  (society / tower / flat). Falls back to the demo destination.
function parseDestination(society) {
  const [soc, tower, flat] = decodeURIComponent(location.hash.slice(1)).split('/');
  const d = society.delivery;
  const tw = society.towers.find((x) => x.id === tower) ? tower : d.tower;
  const f = /^\d{3,4}$/.test(flat || '') ? flat : d.flat;
  return { society: soc || society.id, tower: tw, flat: f, floor: Math.floor(Number(f) / 100), from: d.from };
}

async function main() {
  const society = await (await fetch('../data/society.json', { cache: 'no-store' })).json();
  const dest = parseDestination(society);
  const towerData = society.towers.find((x) => x.id === dest.tower);

  // ---------- renderer ----------
  const canvas = $('#gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const labelRenderer = new CSS2DRenderer({ element: $('#labels') });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.bg);
  scene.fog = new THREE.Fog(C.bg, 900, 2200);

  const camera = new THREE.PerspectiveCamera(30, 1, 2, 6000);
  const controls = new OrbitControls(camera, labelRenderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(76);
  controls.minDistance = 60;
  controls.maxDistance = 1600;
  controls.enabled = false;
  const director = new CameraDirector(camera, controls);

  // ---------- light ----------
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc9bd, 1.25));
  const sun = new THREE.DirectionalLight(0xfffaf2, 2.9);
  sun.position.set(-260, 420, 180);
  sun.castShadow = true;
  const sm = Math.min(4096, renderer.capabilities.maxTextureSize);
  sun.shadow.mapSize.set(innerWidth < 700 ? 2048 : sm, innerWidth < 700 ? 2048 : sm);
  Object.assign(sun.shadow.camera, { left: -330, right: 330, top: 330, bottom: -330, near: 50, far: 1200 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  // ---------- society ----------
  const built = buildSociety(society);
  scene.add(built.root);
  const tw = built.towers[dest.tower];
  const hl = makeHighlight(tw, dest.floor, society.floorHeight);
  built.labels.towers[dest.tower].visible = false;

  // ---------- routes ----------
  const graph = buildGraph(society);
  const route = findRoute(graph, dest.from, `${dest.tower}:service`, 'delivery');
  const resRoute = findRoute(graph, 'G1', `${dest.tower}:resident`, 'resident');
  const steps = describeRoute(graph, route);
  const delivery = makeDeliveryRoute(route.points);
  const resident = makeResidentRoute(resRoute.points);
  resident.setOpacity(0);
  scene.add(delivery.group, resident.group);

  const rider = makeRiderMarker();
  const start = graph.nodes.get(dest.from);
  rider.group.position.set(start.x - 4, 0, start.z);
  scene.add(rider.group);

  // ---------- labels ----------
  const mk = (html, cls, pos) => {
    const el = document.createElement('div');
    el.className = `lbl ${cls}`;
    el.innerHTML = `<div class="lbl-in">${html}</div>`;
    const o = new CSS2DObject(el); o.position.copy(pos); scene.add(o); return o;
  };
  const destLbl = mk(
    `<b>${t('tower')} ${towerData.label}</b><span>${t('flat')} ${dest.flat} · ${t('floor')} ${dest.floor}</span>`,
    'lbl-dest', new THREE.Vector3(towerData.x, tw.height + 10, towerData.z));
  const startGate = society.gates.find((g) => g.id === dest.from);
  const youLbl = mk(`${t('youAreHere')}<span>${startGate.name}</span>`, 'lbl-you', new THREE.Vector3(start.x - 4, 2, start.z));
  built.labels.gates[dest.from].visible = false;
  const svcDoor = doorPoint(towerData, towerData.serviceSide);
  const resDoor = doorPoint(towerData, towerData.residentSide);
  const svcLbl = mk(`<i></i>${t('serviceEntrance')}`, 'lbl-entrance is-service', new THREE.Vector3(svcDoor.x, 3, svcDoor.z));
  const resLbl = mk(`<i></i>${t('residentEntrance')}`, 'lbl-entrance is-resident', new THREE.Vector3(resDoor.x, 3, resDoor.z));
  const reveal = (o, on) => o.element.classList.toggle('on', on);
  [destLbl, youLbl, svcLbl, resLbl].forEach((o) => reveal(o, false));
  Object.values(built.labels.towers).forEach((o) => reveal(o, false));
  Object.values(built.labels.gates).forEach((o) => reveal(o, false));
  built.labels.amenities.forEach((o) => reveal(o, false));

  // ---------- UI copy ----------
  $('#destTitle').innerHTML = `${t('tower')} ${towerData.label}<span class="sep">·</span>${t('flat')} ${dest.flat}`;
  $('#destSoc').textContent = `${society.name} · ${society.locality.replace(', Gurugram', '')}`;
  $('#dist').textContent = Math.round(route.length);
  $('#via').textContent = t('viaService');
  $('#enter').textContent = t('enterThrough', { gate: society.gates.find((g) => g.id === dest.from).name });
  const chain = [
    ['gate', t('chainGate')], ['road', t('chainRoad')], ['door', t('chainEntrance')],
    ['lift', t('chainLift')], ['floor', t('chainFloor', { floor: dest.floor })], ['flat', t('chainFlat', { flat: dest.flat })],
  ];
  $('#chain').innerHTML = chain.map(([k, s], i) => `<li class="c-${k}" style="--i:${i}"><span>${s}</span></li>`).join('');
  window.__route = { steps, length: route.length }; // handy for debugging

  // ---------- layout / framing ----------
  let W = 0, H = 0;
  function resize() {
    W = innerWidth; H = innerHeight;
    renderer.setSize(W, H, false);
    labelRenderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }
  resize();

  // Free screen area (NDC) not covered by the destination card and bottom sheet.
  function freeBox() {
    const card = $('#destCard').getBoundingClientRect();
    const sheet = $('#sheet');
    const wide = W >= 760;
    let x0 = 16, x1 = W - 16, y0 = card.bottom + 18, y1 = H - sheet.offsetHeight - 24;
    if (wide) { x0 = sheet.getBoundingClientRect().right + 40; y0 = 90; y1 = H - 40; x1 = W - 40; }
    const nx = (px) => (px / W) * 2 - 1, ny = (py) => 1 - (py / H) * 2;
    return { x0: nx(x0), x1: nx(x1), y0: ny(y1), y1: ny(y0) };
  }

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const s = society.site;
  const siteCorners = [V(s.minX, 0, s.minZ), V(s.maxX, 0, s.minZ), V(s.maxX, 0, s.maxZ), V(s.minX, 0, s.maxZ), V(0, 80, 0)];
  const routeFocus = () => [
    ...route.points.map((p) => V(p.x, 0, p.z)),
    V(towerData.x, tw.height + 75, towerData.z),
    V(start.x + 12, 0, start.z),
  ];
  const shots = {
    establish: () => director.fit(siteCorners, { az: -28, el: 62, box: { x0: -1.05, x1: 1.05, y0: -0.75, y1: 0.95 } }),
    overview: () => director.fit(routeFocus(), { az: 28, el: 44, box: freeBox() }),
    compare: () => director.fit([...routeFocus(), ...resRoute.points.map((p) => V(p.x, 0, p.z)), V(-45, 0, 175)], { az: 12, el: 56, box: freeBox() }),
  };

  // ---------- intro timeline ----------
  const towerOrder = Object.values(built.towers)
    .map((x) => ({ x, d: Math.hypot(x.data.x - start.x, x.data.z - start.z) }))
    .sort((a, b) => a.d - b.d);
  const maxD = towerOrder[towerOrder.length - 1].d;
  let T = 0;
  let playing = true;
  let hlA = 0;
  let compareA = 0, compareOn = false;

  function setIntroState(time) {
    // Towers rise, nearest-to-rider first.
    for (const { x, d } of towerOrder) {
      const k = THREE.MathUtils.clamp((time - 0.15 - (d / maxD) * 0.9) / 0.9, 0, 1);
      x.body.scale.y = Math.max(0.001, ease.out(k));
      x.group.visible = k > 0;
      const lbl = built.labels.towers[x.data.id];
      if (x.data.id !== dest.tower) reveal(lbl, k > 0.95);
    }
    const labelsOn = time > 1.3;
    Object.values(built.labels.gates).forEach((o) => reveal(o, labelsOn));
    built.labels.amenities.forEach((o) => reveal(o, labelsOn));
    reveal(youLbl, time > 1.0);
    rider.group.visible = time > 0.8;

    hlA = ease.inOut(THREE.MathUtils.clamp((time - 1.9) / 0.7, 0, 1));
    hl.set(hlA);
    // Everything else steps back as the destination lights up.
    built.shellMat.opacity = 0.8 - 0.1 * hlA;
    built.edgeMat.opacity = 0.85 - 0.35 * hlA;
    built.slabMat.opacity = 0.55 - 0.25 * hlA;
    reveal(destLbl, time > 2.1);

    delivery.setProgress(ease.inOut(THREE.MathUtils.clamp((time - 2.7) / 2.4, 0, 1)));
    document.body.classList.toggle('ready', time > 5.1);
    document.body.classList.toggle('dest-in', time > 2.1);
  }

  async function playIntro() {
    T = 0; playing = true;
    controls.enabled = false;
    director.jumpTo(shots.establish());
    document.body.classList.remove('ready', 'dest-in');
    await new Promise((r) => setTimeout(r, 1900));
    await director.flyTo(shots.overview(), 3.3, ease.inOut);
    controls.enabled = true;
  }

  // ---------- interactions ----------
  $('#compare').addEventListener('change', (e) => {
    compareOn = e.target.checked;
    document.body.classList.toggle('comparing', compareOn);
    reveal(resLbl, compareOn);
    reveal(built.labels.gates.G1, true);
    controls.enabled = false;
    director.flyTo(compareOn ? shots.compare() : shots.overview(), 1.4).then(() => { controls.enabled = true; });
  });
  $('#replay').addEventListener('click', () => playIntro());
  $('#start').addEventListener('click', () => {
    const toast = $('#toast');
    toast.textContent = t('comingNext');
    toast.classList.add('on');
    setTimeout(() => toast.classList.remove('on'), 2200);
  });
  addEventListener('resize', () => {
    resize();
    if (!director.flight && document.body.classList.contains('ready')) director.jumpTo(shots.overview());
  });

  // ---------- loop ----------
  const clock = new THREE.Clock();
  let time = 0;
  function frame() {
    const dt = Math.min(0.05, clock.getDelta());
    time += dt;
    if (playing) { T += dt; setIntroState(T); if (T > 6) playing = false; }
    compareA += ((compareOn ? 1 : 0) - compareA) * Math.min(1, dt * 6);
    resident.setOpacity(compareA);
    delivery.tick(dt);
    rider.tick(time);
    hl.tick(time, hlA);
    if (!director.update(dt)) controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  if (params.has('skip')) { T = 6; setIntroState(6); playing = false; director.jumpTo(shots.overview()); controls.enabled = true; }
  else playIntro();
  document.body.classList.add('loaded');
  frame();
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre class="err">${e.stack || e}</pre>`);
});
