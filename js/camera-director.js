// Camera director: frames a set of points inside the part of the screen that
// isn't covered by UI, and flies smoothly between shots.
import * as THREE from 'three';

export const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  outBack: (t) => { const c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};

export class CameraDirector {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.flight = null;
    this.probe = camera.clone();
  }

  // box: free screen area in NDC {x0,x1,y0,y1}. az/el in degrees; az 0 = camera south of target.
  fit(points, { az = 20, el = 50, box = { x0: -0.9, x1: 0.9, y0: -0.9, y1: 0.9 } } = {}) {
    const cam = this.probe;
    cam.aspect = this.camera.aspect; cam.fov = this.camera.fov; cam.updateProjectionMatrix();
    const A = THREE.MathUtils.degToRad(az), E = THREE.MathUtils.degToRad(el);
    const dir = new THREE.Vector3(Math.sin(A) * Math.cos(E), Math.sin(E), Math.cos(A) * Math.cos(E));
    const target = new THREE.Vector3();
    points.forEach((p) => target.add(p));
    target.divideScalar(points.length);
    const v = new THREE.Vector3();
    const measure = (d) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of points) {
        v.copy(p).project(cam);
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      }
      return { x0, x1, y0, y1 };
    };
    let d = 400;
    for (let iter = 0; iter < 4; iter++) {
      let lo = 20, hi = 5000;
      for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        const r = measure(m);
        const fits = r.x1 - r.x0 <= box.x1 - box.x0 && r.y1 - r.y0 <= box.y1 - box.y0;
        if (fits) hi = m; else lo = m;
      }
      d = hi;
      const r = measure(d);
      const offX = (r.x0 + r.x1) / 2 - (box.x0 + box.x1) / 2;
      const offY = (r.y0 + r.y1) / 2 - (box.y0 + box.y1) / 2;
      const halfH = d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      // Shift the target (keeping the view direction) so the content centres in the box.
      target.addScaledVector(right, offX * halfH * cam.aspect).addScaledVector(up, offY * halfH);
      target.y = Math.max(0, target.y);
    }
    return { pos: target.clone().addScaledVector(dir, d), target: target.clone() };
  }

  flyTo(shot, dur = 1.6, fn = ease.inOut) {
    return new Promise((resolve) => {
      this.flight = {
        p0: this.camera.position.clone(), t0: this.controls.target.clone(),
        p1: shot.pos.clone(), t1: shot.target.clone(), dur, fn, time: 0, resolve,
      };
    });
  }

  jumpTo(shot) {
    this.camera.position.copy(shot.pos);
    this.controls.target.copy(shot.target);
    this.camera.lookAt(shot.target);
  }

  update(dt) {
    const f = this.flight;
    if (!f) return false;
    f.time = Math.min(f.dur, f.time + dt);
    const k = f.fn(f.time / f.dur);
    this.camera.position.lerpVectors(f.p0, f.p1, k);
    this.controls.target.lerpVectors(f.t0, f.t1, k);
    this.camera.lookAt(this.controls.target);
    if (f.time >= f.dur) { this.flight = null; f.resolve(); }
    return true;
  }
}
