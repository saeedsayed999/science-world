// Three.js race scene: circuit, scenery, cars, chase camera and minimap.
// Rendering only — it never decides rank or correctness. It is told the
// display order by the race engine and animates cars toward it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { QUALITY } from './config.js';

const ROAD_HALF = 7;          // metres from centre line to road edge
const CURB = 1.6;
const WALL = 17;
const GAP = 11;               // metres between grid slots
const PASS_TIME = 1.6;        // seconds for an overtake animation
const SPEED = 42;             // pack cruising speed, m/s
const STEER_LIMIT = ROAD_HALF - 1.4;

// Closed circuit in the XZ plane (metres): long start straight, sweepers, hairpin.
const CONTROL = [
  [0, 0], [160, 0], [260, -20], [320, -90], [300, -190], [200, -230], [120, -180],
  [40, -210], [-60, -260], [-170, -230], [-220, -130], [-180, -40], [-100, 0],
];

let carTemplatePromise = null;
export function loadCarTemplate(url) {
  carTemplatePromise ??= new GLTFLoader().loadAsync(url).then((g) => g.scene);
  return carTemplatePromise;
}

function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

export class RaceScene {
  constructor(canvas, { quality = 'medium', fpsCap = 60 } = {}) {
    this.canvas = canvas;
    this.qualityName = quality;
    this.fpsCap = fpsCap;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: QUALITY[quality].antialias, powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 2500);
    this.clock = new THREE.Clock();
    this.cars = new Map();
    this.playerId = null;
    this.mode = 'attract';       // 'attract' | 'race'
    this.freeDrive = false;
    this.steerInput = 0;
    this.packS = 0;
    this.orbit = 0;
    this.fps = 0;
    this.onUpdate = null;
    this._fpsFrames = 0; this._fpsTime = 0; this._acc = 0;

    this.#buildTrack();
    this.#buildWorld();
    this.setQuality(quality);
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  // ---------- world construction ----------

  #buildTrack() {
    const pts = CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();
    const N = 700;
    this.samples = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = this.curve.getPointAt(u % 1);
      const t = this.curve.getTangentAt(u % 1);
      const n = new THREE.Vector3(-t.z, 0, t.x); // left-hand normal
      this.samples.push({ p, t, n, s: u * this.length });
    }

    const road = canvasTexture(256, 512, (g, w, h) => {
      g.fillStyle = '#3a3d42'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2500; i++) {
        const v = 50 + Math.random() * 30;
        g.fillStyle = `rgba(${v},${v},${v + 4},0.5)`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      g.fillStyle = '#f2f2ee';
      g.fillRect(6, 0, 7, h); g.fillRect(w - 13, 0, 7, h);
      g.fillStyle = 'rgba(242,242,238,0.75)';
      for (const x of [w / 3, (2 * w) / 3]) g.fillRect(x - 2, 0, 4, h * 0.45);
    });
    const curb = canvasTexture(64, 128, (g, w, h) => {
      g.fillStyle = '#d8262c'; g.fillRect(0, 0, w, h / 2);
      g.fillStyle = '#f4f4f4'; g.fillRect(0, h / 2, w, h / 2);
    });
    const runoff = new THREE.MeshLambertMaterial({ color: 0x28b5c9 });

    this.#ribbon(-ROAD_HALF, ROAD_HALF, 0.02, 24,
      new THREE.MeshStandardMaterial({ map: road, roughness: 0.85 }), true);
    this.#ribbon(ROAD_HALF, ROAD_HALF + CURB, 0.04, 6, new THREE.MeshLambertMaterial({ map: curb }), true);
    this.#ribbon(-ROAD_HALF - CURB, -ROAD_HALF, 0.04, 6, new THREE.MeshLambertMaterial({ map: curb }), true);
    this.#ribbon(ROAD_HALF + CURB, ROAD_HALF + 4, 0.03, 0, runoff);
    this.#ribbon(-ROAD_HALF - 4, -ROAD_HALF - CURB, 0.03, 0, runoff);

    // Low barrier walls on both sides.
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xe9eef2, side: THREE.DoubleSide });
    for (const side of [-1, 1]) this.#wall(side * WALL, 1.3, wallMat);

    // Start/finish gantry with countdown lights.
    const s0 = this.samples[3];
    const gantry = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x2b2f36 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 9, 0.8), postMat);
      post.position.set(side * (ROAD_HALF + 3), 4.5, 0);
      gantry.add(post);
    }
    const checker = canvasTexture(256, 32, (g, w, h) => {
      for (let x = 0; x < w / 16; x++) for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#fafafa';
        g.fillRect(x * 16, y * 16, 16, 16);
      }
    }, false);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * ROAD_HALF + 7, 1.8, 0.6),
      [postMat, postMat, postMat, postMat, new THREE.MeshBasicMaterial({ map: checker }), new THREE.MeshBasicMaterial({ map: checker })]);
    beam.position.y = 8.6;
    gantry.add(beam);
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0x330000 });
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), m);
      l.position.set((i - 2) * 1.1, 7.2, 0.4);
      gantry.add(l);
      this.startLights.push(m);
    }
    gantry.position.copy(s0.p);
    gantry.rotation.y = Math.atan2(s0.t.x, s0.t.z);
    this.scene.add(gantry);
  }

  #ribbon(a, b, y, vScale, material, receive = false) {
    const pos = [], uv = [], idx = [];
    this.samples.forEach(({ p, n, s }, i) => {
      pos.push(p.x + n.x * a, y, p.z + n.z * a, p.x + n.x * b, y, p.z + n.z * b);
      const v = vScale ? s / vScale : 0;
      uv.push(0, v, 1, v);
      if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = receive;
    this.scene.add(m);
    return m;
  }

  #wall(offset, height, material) {
    const pos = [], idx = [];
    this.samples.forEach(({ p, n }, i) => {
      const x = p.x + n.x * offset, z = p.z + n.z * offset;
      pos.push(x, 0, z, x, height, z);
      if (i > 0) { const k = i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, material));
  }

  #nearTrack(x, z, min) {
    for (let i = 0; i < this.samples.length; i += 4) {
      const p = this.samples[i].p;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < min * min) return true;
    }
    return false;
  }

  #buildWorld() {
    const horizon = new THREE.Color(0xf6a35c);
    this.scene.fog = new THREE.Fog(horizon, 120, 700);

    // Gradient sunset sky dome.
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x2c5d9e) }, mid: { value: new THREE.Color(0xf3b26b) }, low: { value: new THREE.Color(0xf7d29a) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 vP;
        void main(){ float h = vP.y; vec3 c = h > 0.08 ? mix(mid, top, smoothstep(0.08, 0.55, h)) : mix(low, mid, smoothstep(-0.05, 0.08, h));
        vec3 sunDir = normalize(vec3(-0.6, 0.12, -0.8)); float sun = pow(max(dot(vP, sunDir), 0.0), 220.0);
        float glow = pow(max(dot(vP, sunDir), 0.0), 8.0) * 0.35; gl_FragColor = vec4(c + vec3(1.0,0.85,0.6)*(sun*1.5+glow), 1.0); }`,
    }));
    this.scene.add(sky);

    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x5d6b3a, 1.2));
    this.sun = new THREE.DirectionalLight(0xffd9a8, 2.4);
    this.sun.position.set(-120, 140, -160);
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -60; sc.right = sc.top = 60; sc.near = 10; sc.far = 400;
    this.scene.add(this.sun, this.sun.target);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(1600, 32), new THREE.MeshLambertMaterial({ color: 0x6f9a45 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const rand = seeded(7);
    const center = new THREE.Vector3(50, 0, -120);

    // Distant low-poly mountains.
    const mountMat = new THREE.MeshLambertMaterial({ color: 0xa8755a, flatShading: true });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rand() * 0.2;
      const r = 650 + rand() * 250;
      const h = 90 + rand() * 160;
      const m = new THREE.Mesh(new THREE.ConeGeometry(110 + rand() * 90, h, 6), mountMat);
      m.position.set(center.x + Math.cos(a) * r, h / 2 - 5, center.z + Math.sin(a) * r);
      m.rotation.y = rand() * 3;
      this.scene.add(m);
    }

    // Palm trees as two instanced meshes so 300 trees cost two draw calls.
    const spots = [];
    for (let tries = 0; spots.length < 320 && tries < 6000; tries++) {
      const smp = this.samples[Math.floor(rand() * (this.samples.length - 1))];
      const off = (rand() < 0.5 ? -1 : 1) * (WALL + 4 + rand() * 60);
      const x = smp.p.x + smp.n.x * off, z = smp.p.z + smp.n.z * off;
      if (!this.#nearTrack(x, z, WALL + 3)) spots.push([x, z, 0.8 + rand() * 0.6, rand() * 6]);
    }
    const trunkG = new THREE.CylinderGeometry(0.25, 0.4, 9, 5); trunkG.translate(0, 4.5, 0);
    const crownG = new THREE.ConeGeometry(3.6, 2.2, 7); crownG.translate(0, 9.4, 0);
    this.trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshLambertMaterial({ color: 0x8a6542 }), spots.length);
    this.crowns = new THREE.InstancedMesh(crownG, new THREE.MeshLambertMaterial({ color: 0x2f7d3a, flatShading: true }), spots.length);
    const mtx = new THREE.Matrix4();
    spots.forEach(([x, z, sc2, rot], i) => {
      mtx.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0)), new THREE.Vector3(sc2, sc2, sc2));
      this.trunks.setMatrixAt(i, mtx); this.crowns.setMatrixAt(i, mtx);
    });
    this.treeTotal = spots.length;
    this.scene.add(this.trunks, this.crowns);

    // Grandstand with an instanced crowd along the start straight.
    const stand = new THREE.Group();
    const standMat = new THREE.MeshLambertMaterial({ color: 0xd9dde3 });
    for (let r = 0; r < 6; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(130, 1.2, 2.4), standMat);
      step.position.set(0, 0.6 + r * 1.2, -r * 2.4);
      stand.add(step);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(134, 0.5, 18), new THREE.MeshLambertMaterial({ color: 0x23272e }));
    roof.position.set(0, 14, -6);
    stand.add(roof);
    const crowdG = new THREE.BoxGeometry(0.7, 1.1, 0.5);
    const crowd = new THREE.InstancedMesh(crowdG, new THREE.MeshLambertMaterial(), 6 * 120);
    const col = new THREE.Color();
    let k = 0;
    for (let r = 0; r < 6; r++) for (let c = 0; c < 120; c++) {
      mtx.makeTranslation(-62 + c * 1.05 + rand() * 0.3, 1.8 + r * 1.2, -r * 2.4);
      crowd.setMatrixAt(k, mtx);
      crowd.setColorAt(k++, col.setHSL(rand(), 0.55, 0.5));
    }
    stand.add(crowd);
    // Local -Z (rows stepping back) must point away from the track: along -n.
    const sStand = this.samples[30];
    const off = -(WALL + 6);
    stand.position.set(sStand.p.x + sStand.n.x * off, 0, sStand.p.z + sStand.n.z * off);
    stand.rotation.y = Math.atan2(sStand.n.x, sStand.n.z);
    this.scene.add(stand);
  }

  // ---------- cars ----------

  setCars(list, template) {
    for (const c of this.cars.values()) this.scene.remove(c.obj);
    this.cars.clear();
    list.forEach(({ id, color }, slot) => {
      const obj = template.clone(true);
      const wheels = [];
      obj.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          if (o.material.name === 'Body') {
            o.material = o.material.clone();
            o.material.color.set(color);
          }
        }
      });
      // Re-parent wheels under axle-aligned pivots so they spin about the car's X axis.
      obj.traverse((o) => { if (/^Wheel_/.test(o.name) && !o.userData.pivoted) wheels.push(o); });
      const pivots = wheels.map((w) => {
        const pivot = new THREE.Group();
        pivot.position.copy(w.position);
        w.position.set(0, 0, 0);
        w.userData.pivoted = true;
        w.parent.add(pivot);
        pivot.add(w);
        return pivot;
      });
      this.scene.add(obj);
      this.cars.set(id, {
        id, obj, pivots, slot, slotFrom: slot, slotTo: slot, t: 1, dir: 0,
        lane: this.#laneFor(slot), lat: this.#laneFor(slot), wobble: Math.random() * 10,
      });
    });
    this.#applyShadows();
  }

  #laneFor(slot) { return slot % 2 ? -2.8 : 2.8; }

  /** Display order from the race engine: ids, first place first. */
  setOrder(ids) {
    ids.forEach((id, slot) => {
      const c = this.cars.get(id);
      if (!c || c.slotTo === slot) return;
      const current = c.slotFrom + (c.slotTo - c.slotFrom) * this.#ease(c.t);
      c.slotFrom = current;
      c.slotTo = slot;
      c.dir = Math.sign(slot - current);
      c.t = 0;
    });
  }

  #ease(t) { return t * t * (3 - 2 * t); }

  setPlayer(id) { this.playerId = id; }

  setFreeDrive(on) {
    this.freeDrive = on;
    if (!on) this.steerInput = 0;
  }

  setStartLights(n) {
    this.startLights.forEach((m, i) => m.color.set(i < n ? 0xff2a1a : 0x330000));
  }

  /** World position of a car at track distance s and lateral offset. */
  #place(s, lat) {
    const L = this.length;
    const u = (((s % L) + L) % L) / L;
    const f = u * (this.samples.length - 1);
    const i = Math.floor(f), a = f - i;
    const A = this.samples[i], B = this.samples[Math.min(i + 1, this.samples.length - 1)];
    const p = A.p.clone().lerp(B.p, a);
    const t = A.t.clone().lerp(B.t, a).normalize();
    const n = new THREE.Vector3(-t.z, 0, t.x);
    return { pos: p.addScaledVector(n, lat), t, n };
  }

  // ---------- frame loop ----------

  start() {
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  stop() { this.renderer.setAnimationLoop(null); }

  /** Advance one simulated frame by dt seconds (used by automated checks). */
  advance(dt) {
    this.onUpdate?.(dt);
    this.#update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  #frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this._acc += dt;
    const minStep = 1 / this.fpsCap - 0.002;
    if (this._acc < minStep) return;
    const step = this._acc;
    this._acc = 0;

    this._fpsFrames++; this._fpsTime += step;
    if (this._fpsTime >= 0.5) { this.fps = Math.round(this._fpsFrames / this._fpsTime); this._fpsFrames = 0; this._fpsTime = 0; }

    this.onUpdate?.(step);
    this.#update(step);
    this.renderer.render(this.scene, this.camera);
  }

  #update(dt) {
    this.packS += SPEED * dt;
    const steerRate = 9;
    for (const c of this.cars.values()) {
      if (c.t < 1) c.t = Math.min(1, c.t + dt / PASS_TIME);
      const e = this.#ease(c.t);
      const slot = c.slotFrom + (c.slotTo - c.slotFrom) * e;
      const bump = Math.sin(Math.PI * e) * (c.t < 1 ? (c.dir < 0 ? 3.4 : -3.4) : 0);
      const isPlayer = c.id === this.playerId;
      c.wobble += dt;

      if (isPlayer && this.freeDrive) {
        c.lat = THREE.MathUtils.clamp(c.lat + this.steerInput * steerRate * dt, -STEER_LIMIT, STEER_LIMIT);
      } else {
        c.lane = this.#laneFor(c.slotTo);
        c.lat += (c.lane + Math.sin(c.wobble * 0.7) * 0.5 - c.lat) * Math.min(1, dt * 1.6);
      }
      const lat = THREE.MathUtils.clamp(c.lat + bump, -STEER_LIMIT, STEER_LIMIT);
      const s = this.packS - slot * GAP;
      const { pos, t } = this.#place(s, lat);
      c.obj.position.copy(pos);
      const yawSteer = isPlayer && this.freeDrive ? this.steerInput * 0.12 : 0;
      c.obj.rotation.set(0, Math.atan2(t.x, t.z) - yawSteer, 0);
      for (const pv of c.pivots) pv.rotation.x += (SPEED * dt) / 0.36;
    }
    this.#updateCamera(dt);
  }

  #updateCamera(dt) {
    const player = this.cars.get(this.playerId) ?? this.cars.values().next().value;
    if (!player) return;
    const p = player.obj.position;
    const yaw = player.obj.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    let want, look;
    if (this.mode === 'attract') {
      this.orbit += dt * 0.12;
      const a = Math.sin(this.orbit) * 0.5;
      const back = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      want = p.clone().addScaledVector(back, -8).add(new THREE.Vector3(0, 2.2, 0));
      look = p.clone().addScaledVector(fwd, 6).add(new THREE.Vector3(0, 1, 0));
    } else {
      want = p.clone().addScaledVector(fwd, -10).add(new THREE.Vector3(0, 4, 0));
      look = p.clone().addScaledVector(fwd, 14).add(new THREE.Vector3(0, 1.2, 0));
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(want, k);
    this._look ??= look.clone();
    this._look.lerp(look, k);
    this.camera.lookAt(this._look);

    if (this.renderer.shadowMap.enabled) {
      this.sun.position.set(p.x - 60, 120, p.z - 80);
      this.sun.target.position.copy(p);
    }
  }

  /** Draws the circuit and car dots onto a 2D canvas. */
  drawMinimap(ctx, colors) {
    const { width: w, height: h } = ctx.canvas;
    if (!this._mapBounds) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const { p } of this.samples) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      this._mapBounds = { minX, minZ, scale: Math.min((w - 20) / (maxX - minX), (h - 20) / (maxZ - minZ)), maxX, maxZ };
    }
    const b = this._mapBounds;
    const ox = (w - (b.maxX - b.minX) * b.scale) / 2, oz = (h - (b.maxZ - b.minZ) * b.scale) / 2;
    const map = (p) => [ox + (p.x - b.minX) * b.scale, oz + (p.z - b.minZ) * b.scale];
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineJoin = 'round';
    ctx.beginPath();
    this.samples.forEach(({ p }, i) => { const [x, y] = map(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    const order = [...this.cars.values()].sort((a, c) => (a.id === this.playerId) - (c.id === this.playerId));
    for (const c of order) {
      const [x, y] = map(c.obj.position);
      ctx.fillStyle = colors[c.id];
      ctx.beginPath(); ctx.arc(x, y, c.id === this.playerId ? 5.5 : 4, 0, Math.PI * 2); ctx.fill();
      if (c.id === this.playerId) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    }
  }

  // ---------- settings ----------

  setQuality(name) {
    const q = QUALITY[name];
    this.qualityName = name;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    const n = Math.floor(this.treeTotal * q.scenery);
    this.trunks.count = n; this.crowns.count = n;
    this.scene.fog.far = q.fogFar;
    this.camera.far = q.fogFar + 1800;
    this.camera.updateProjectionMatrix();
    this.#applyShadows();
    this.resize();
  }

  #applyShadows() {
    this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
  }

  setFpsCap(cap) { this.fpsCap = cap; }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
