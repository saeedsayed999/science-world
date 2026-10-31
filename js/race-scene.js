// Three.js race scene: coastal circuit at sunset, cars, chase camera, effects.
// Rendering only — it never decides answers or winners. Every car follows a
// state object ({ d, lat, latV, v, mode, crashSpin, offRoad }) owned by the
// race controller: the player's own simulation, a Solo bot, or a remote player.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { QUALITY } from './config.js';
import { loadCar, makeCar, setBrakeGlow } from './cars.js';
import { SIM } from './race-sim.js';

const ROAD_HALF = SIM.roadHalf;
const CURB = 1.4;
const WALL = ROAD_HALF + 4.2;

// Closed circuit in the XZ plane (metres): long start straight by the sea, sweepers, hairpin.
const CONTROL = [
  [0, 0], [160, 0], [260, -20], [320, -90], [300, -190], [200, -230], [120, -180],
  [40, -210], [-60, -260], [-170, -230], [-220, -130], [-180, -40], [-100, 0],
];

function canvasTexture(w, h, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

// ---------- soft particles (smoke, dust, sparks) ----------

class Particles {
  constructor(max = 500) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; attribute vec4 pcolor; varying vec4 vC; uniform float scale;
        void main(){ vC = pcolor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
        gl_FragColor = vec4(vC.rgb, vC.a * smoothstep(0.5, 0.15, d)); }`,
    }));
    this.points.frustumCulled = false;
  }

  emit(p, v, { life = 1, size = 1, grow = 1, color = [1, 1, 1], alpha = 0.6 } = {}) {
    const i = this.next++ % this.max;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([...color, alpha], i * 4);
    this.size[i] = size; this.life[i] = life; this.age[i] = 0; this.grow[i] = grow;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      if (k >= 1) { this.life[i] = 0; this.col[i * 4 + 3] = 0; continue; }
      for (let a = 0; a < 3; a++) this.pos[i * 3 + a] += this.vel[i * 3 + a] * dt;
      this.vel[i * 3 + 1] -= 2 * dt * (this.grow[i] < 1 ? 4 : -0.3);
      this.size[i] += this.grow[i] * dt;
      this.col[i * 4 + 3] *= 1 - dt * 1.6;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = g.attributes.pcolor.needsUpdate = g.attributes.size.needsUpdate = true;
  }
}

export class RaceScene {
  constructor(canvas, { quality = 'medium', fpsCap = 60 } = {}) {
    this.canvas = canvas;
    this.fpsCap = fpsCap;
    this.qualityName = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: QUALITY[quality].antialias, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.5;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000);
    this.clock = new THREE.Clock();
    this.cars = new Map();           // id -> { obj, pivots, state, bbox, prevMode }
    this.playerId = null;
    this.mode = 'attract';
    this.fps = 0;
    this.onUpdate = null;
    this.onCrash = null;
    this.shake = 0;
    this.orbit = 0;
    this._fpsFrames = 0; this._fpsTime = 0; this._acc = 0;

    this.particles = new Particles(600);
    this.scene.add(this.particles.points);

    this.#buildSky();
    this.#buildTrack();
    this.#buildWorld();
    this.#buildSpeedLines();
    this.setQuality(quality);
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  // ---------- sky, light and reflections ----------

  #buildSky() {
    const sky = new Sky();
    sky.scale.setScalar(3500);
    const u = sky.material.uniforms;
    u.turbidity.value = 10;
    u.rayleigh.value = 3.2;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.92;
    // Golden hour: sun 3° above the sea, behind the start straight.
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(87), THREE.MathUtils.degToRad(60));
    u.sunPosition.value.copy(this.sunDir);
    this.scene.add(sky);
    this.sky = sky;

    // Car paint and the sea reflect this sky (one-off render into an environment map).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.envMap = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();

    this.scene.fog = new THREE.Fog(0xe9a46e, 160, 900);
    this.scene.add(new THREE.HemisphereLight(0xb9d4ff, 0x6b5a3a, 0.9));
    this.sun = new THREE.DirectionalLight(0xffc98a, 3.2);
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -40; sc.right = sc.top = 40; sc.near = 1; sc.far = 300;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
  }

  // ---------- circuit ----------

  #buildTrack() {
    const pts = CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();
    const N = 1400;
    this.samples = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = this.curve.getPointAt(u % 1);
      const t = this.curve.getTangentAt(u % 1);
      this.samples.push({ p, t, n: new THREE.Vector3(-t.z, 0, t.x), s: u * this.length });
    }

    const asphalt = canvasTexture(512, 1024, (g, w, h) => {
      g.fillStyle = '#34373c'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 26000; i++) {
        const v = 38 + Math.random() * 40;
        g.fillStyle = `rgba(${v},${v},${v + 3},${0.35 + Math.random() * 0.4})`;
        g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
      // Racing-line rubber and tyre marks.
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0.3, 'rgba(0,0,0,0)'); grad.addColorStop(0.5, 'rgba(0,0,0,0.22)'); grad.addColorStop(0.7, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(10,10,10,0.25)'; g.lineWidth = 6;
      for (let k = 0; k < 6; k++) { g.beginPath(); const x = w * (0.35 + Math.random() * 0.3); g.moveTo(x, Math.random() * h); g.lineTo(x + (Math.random() - 0.5) * 20, Math.random() * h); g.stroke(); }
      g.fillStyle = '#f4f4f0';
      g.fillRect(10, 0, 12, h); g.fillRect(w - 22, 0, 12, h);
      for (let y = 0; y < h; y += 128) g.fillRect(w / 2 - 4, y, 8, 64);
    });
    const curb = canvasTexture(64, 128, (g, w, h) => {
      g.fillStyle = '#d42a2f'; g.fillRect(0, 0, w, h / 2);
      g.fillStyle = '#f6f6f6'; g.fillRect(0, h / 2, w, h / 2);
    });
    this.roadMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.82, metalness: 0.05 });
    this.#ribbon(-ROAD_HALF, ROAD_HALF, 0.03, 30, this.roadMat, true);
    const curbMat = new THREE.MeshStandardMaterial({ map: curb, roughness: 0.6 });
    this.#ribbon(ROAD_HALF, ROAD_HALF + CURB, 0.05, 5, curbMat, true);
    this.#ribbon(-ROAD_HALF - CURB, -ROAD_HALF, 0.05, 5, curbMat, true);
    const runoff = new THREE.MeshStandardMaterial({ color: 0x2aa9bf, roughness: 0.7 });
    this.#ribbon(ROAD_HALF + CURB, WALL, 0.04, 0, runoff, true);
    this.#ribbon(-WALL, -ROAD_HALF - CURB, 0.04, 0, runoff, true);

    // Barriers: white/red armco with sponsor boards for this school's own brand.
    const wallTex = canvasTexture(256, 32, (g, w, h) => {
      g.fillStyle = '#f2f4f6'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#d42a2f'; for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 32, h);
    });
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.5, side: THREE.DoubleSide });
    for (const side of [-1, 1]) this.#wall(side * WALL, 1.0, wallMat);

    this.#boards();
    this.#gantry();
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
    const pos = [], uv = [], idx = [];
    this.samples.forEach(({ p, n, s }, i) => {
      const x = p.x + n.x * offset, z = p.z + n.z * offset;
      pos.push(x, 0, z, x, height, z);
      uv.push(s / 8, 0, s / 8, 1);
      if (i > 0) { const k = i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, material));
  }

  #boards() {
    const words = [['SCIENCE WORLD', '#0f1a2b', '#f2c14e'], ['DR. OMAR', '#f2c14e', '#111'], ['PLANT SEASON', '#1e7a46', '#fff'], ['ENERGY SEASON', '#ff7a00', '#fff'], ['RACE TO 10', '#18c6e8', '#06222b']];
    const mats = words.map(([text, bg, fg]) => new THREE.MeshStandardMaterial({ roughness: 0.6, map: canvasTexture(512, 96, (g, w, h) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.fillStyle = fg; g.font = 'italic 700 58px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 3);
    }, { repeat: false }) }));
    const geo = new THREE.PlaneGeometry(9, 1.7);
    for (let i = 20; i < this.samples.length - 20; i += 38) {
      const { p, n, t } = this.samples[i];
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(geo, mats[(i + (side > 0 ? 2 : 0)) % mats.length]);
        m.position.set(p.x + n.x * side * (WALL + 0.25), 1.9, p.z + n.z * side * (WALL + 0.25));
        m.lookAt(p.x, 1.9, p.z);
        this.scene.add(m);
      }
    }
  }

  #gantry() {
    const s0 = this.samples[4];
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x22262d, metalness: 0.7, roughness: 0.4 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, 10, 0.9), steel);
      post.position.set(side * (WALL - 0.5), 5, 0);
      g.add(post);
    }
    const checker = canvasTexture(512, 64, (c, w, h) => {
      for (let x = 0; x < w / 32; x++) for (let y = 0; y < 2; y++) { c.fillStyle = (x + y) % 2 ? '#111' : '#fafafa'; c.fillRect(x * 32, y * 32, 32, 32); }
    }, { repeat: false });
    const face = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.5 });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * WALL, 2, 0.7), [steel, steel, steel, steel, face, face]);
    beam.position.y = 9.6;
    g.add(beam);
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x000000 });
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 10), m);
      l.position.set((i - 2) * 1.2, 8.1, 0.45);
      g.add(l);
      this.startLights.push(m);
    }
    g.position.copy(s0.p);
    g.rotation.y = Math.atan2(s0.t.x, s0.t.z);
    this.scene.add(g);
  }

  #nearTrack(x, z, min) {
    for (let i = 0; i < this.samples.length; i += 6) {
      const p = this.samples[i].p;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < min * min) return true;
    }
    return false;
  }

  // ---------- surroundings ----------

  #buildWorld() {
    const rand = seeded(11);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), v = new THREE.Vector3();

    const grassTex = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#5f8f3a'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const k = Math.random(); g.fillStyle = `rgba(${70 + k * 50},${110 + k * 60},${40 + k * 20},0.5)`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    });
    grassTex.repeat.set(220, 220);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Sea along the start straight, with a sandy shore. It reflects the sunset.
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(3000, 70), new THREE.MeshStandardMaterial({ color: 0xd9c08d, roughness: 1 }));
    sand.rotation.x = -Math.PI / 2; sand.position.set(0, 0.02, 75);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(3000, 1400), new THREE.MeshStandardMaterial({ color: 0x0d4a6b, metalness: 0.85, roughness: 0.12 }));
    sea.rotation.x = -Math.PI / 2; sea.position.set(0, 0.06, 810);
    this.scene.add(sand, sea);
    this.sea = sea;

    // Hillside town above the far side of the circuit: instanced houses with lit windows.
    const winTex = canvasTexture(64, 64, (g, w, h) => {
      g.fillStyle = '#efe3cf'; g.fillRect(0, 0, w, h);
      for (let y = 8; y < h; y += 18) for (let x = 6; x < w; x += 16) { g.fillStyle = Math.random() < 0.45 ? '#ffcf7a' : '#3b4656'; g.fillRect(x, y, 8, 10); }
    });
    const houseMat = new THREE.MeshStandardMaterial({ map: winTex, roughness: 0.8, emissive: 0x6b4a1c, emissiveIntensity: 0.25 });
    const houses = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), houseMat, 260);
    for (let i = 0; i < 260; i++) {
      const a = -0.6 + rand() * 1.6, r = 470 + rand() * 260;
      const x = 60 + Math.cos(a + Math.PI) * r * -0.9, z = -140 - Math.sin(a) * r * 0.2 - 330 - rand() * 120;
      const h = 8 + rand() * 18, y = Math.max(0, (-z - 470) * 0.35);
      mtx.compose(v.set(x, y + h / 2, z), q.setFromEuler(new THREE.Euler(0, rand() * 3, 0)), sc.set(12 + rand() * 14, h, 10 + rand() * 12));
      houses.setMatrixAt(i, mtx);
    }
    this.scene.add(houses);

    // Distant hills.
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4c, roughness: 1, flatShading: true });
    for (let i = 0; i < 22; i++) {
      const a = Math.PI + (i / 22) * Math.PI + rand() * 0.1;
      const r = 900 + rand() * 300, h = 140 + rand() * 220;
      const m = new THREE.Mesh(new THREE.ConeGeometry(220 + rand() * 160, h, 9, 3), hillMat);
      m.position.set(50 + Math.cos(a) * r, h / 2 - 10, -120 + Math.sin(a) * r * 0.8);
      m.rotation.y = rand() * 3;
      this.scene.add(m);
    }

    // Palm trees: bent trunk + seven drooping fronds, two instanced meshes in total.
    const trunk = new THREE.CylinderGeometry(0.22, 0.42, 10, 7, 6);
    trunk.translate(0, 5, 0);
    const tp = trunk.attributes.position;
    for (let i = 0; i < tp.count; i++) { const y = tp.getY(i); tp.setX(i, tp.getX(i) + (y / 10) ** 2 * 1.4); }
    trunk.computeVertexNormals();
    const fronds = [];
    for (let k = 0; k < 7; k++) {
      const f = new THREE.PlaneGeometry(1.3, 5.2, 1, 6);
      const fp = f.attributes.position;
      for (let i = 0; i < fp.count; i++) { const y = fp.getY(i) + 2.6; fp.setXYZ(i, fp.getX(i) * (1 - y / 6), -0.12 * y * y, y); }
      f.rotateY((k / 7) * Math.PI * 2);
      f.translate(1.4, 10, 0);
      fronds.push(f);
    }
    const crown = mergeGeometries(fronds);
    const spots = [];
    for (let tries = 0; spots.length < 340 && tries < 8000; tries++) {
      const smp = this.samples[Math.floor(rand() * (this.samples.length - 1))];
      const off = (rand() < 0.5 ? -1 : 1) * (WALL + 5 + rand() * 55);
      const x = smp.p.x + smp.n.x * off, z = smp.p.z + smp.n.z * off;
      if (!this.#nearTrack(x, z, WALL + 4) && z < 45) spots.push([x, z, 0.8 + rand() * 0.5, rand() * 6]);
    }
    this.trunks = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x8a6b4a, roughness: 0.9 }), spots.length);
    this.crowns = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.8, side: THREE.DoubleSide }), spots.length);
    spots.forEach(([x, z, s, r], i) => {
      mtx.compose(v.set(x, 0, z), q.setFromEuler(new THREE.Euler(0, r, 0)), sc.set(s, s, s));
      this.trunks.setMatrixAt(i, mtx); this.crowns.setMatrixAt(i, mtx);
    });
    this.trunks.castShadow = this.crowns.castShadow = true;
    this.treeTotal = spots.length;
    this.scene.add(this.trunks, this.crowns);

    // Light poles along the outside of the circuit.
    const pole = new THREE.CylinderGeometry(0.12, 0.16, 12, 6); pole.translate(0, 6, 0);
    const head = new THREE.BoxGeometry(1.6, 0.3, 0.6); head.translate(0.6, 12, 0);
    const poleMesh = new THREE.InstancedMesh(mergeGeometries([pole, head]), new THREE.MeshStandardMaterial({ color: 0x9aa2ad, metalness: 0.6, roughness: 0.4 }), 90);
    let k = 0;
    for (let i = 10; i < this.samples.length && k < 90; i += 16, k++) {
      const { p, n } = this.samples[i];
      mtx.compose(v.set(p.x + n.x * (WALL + 2.5), 0, p.z + n.z * (WALL + 2.5)), q.setFromEuler(new THREE.Euler(0, Math.atan2(-n.x, -n.z) - Math.PI / 2, 0)), sc.set(1, 1, 1));
      poleMesh.setMatrixAt(k, mtx);
    }
    poleMesh.count = k;
    this.scene.add(poleMesh);

    // Grandstands with roofs and crowds on the start straight and at the hairpin.
    for (const [si, side] of [[40, 1], [520, -1]]) this.#stand(this.samples[si], side, rand);
  }

  #stand(smp, side, rand) {
    const g = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.9 });
    for (let r = 0; r < 7; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(140, 1.1, 2.3), concrete);
      step.position.set(0, 0.55 + r * 1.1, -r * 2.3);
      g.add(step);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(146, 0.5, 14), new THREE.MeshStandardMaterial({ color: 0xe8ecf0, metalness: 0.3, roughness: 0.4 }));
    roof.position.set(0, 13, -10);
    g.add(roof);
    for (let x = -66; x <= 66; x += 22) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 15, 8), roof.material);
      col.position.set(x, 7.5, -15);
      g.add(col);
    }
    const crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.3, 0.6, 2, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), 7 * 120);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    let k = 0;
    for (let r = 0; r < 7; r++) for (let i = 0; i < 120; i++) {
      m.makeTranslation(-66 + i * 1.1 + rand() * 0.3, 1.8 + r * 1.1, -r * 2.3);
      crowd.setMatrixAt(k, m);
      crowd.setColorAt(k++, c.setHSL(rand(), 0.6, 0.55));
    }
    g.add(crowd);
    const off = side * (WALL + 12);
    g.position.set(smp.p.x + smp.n.x * off, 0, smp.p.z + smp.n.z * off);
    g.rotation.y = Math.atan2(-side * smp.n.x, -side * smp.n.z);
    this.scene.add(g);
  }

  #buildSpeedLines() {
    const n = 70, pos = new Float32Array(n * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.speedLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.speedLines.frustumCulled = false;
    this.speedSeeds = Array.from({ length: n }, () => [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()]);
    this.camera.add(this.speedLines);
    this.scene.add(this.camera);
  }

  // ---------- cars ----------

  /** list: [{ id, car: modelId, color, state }] */
  async setCars(list) {
    for (const c of this.cars.values()) this.scene.remove(c.obj, c.glow);
    this.cars.clear();
    const templates = await Promise.all(list.map((c) => loadCar(c.car)));
    list.forEach((c, i) => {
      const { obj, pivots } = makeCar(templates[i], { color: c.color, quality: this.qualityName, envMap: this.envMap });
      const bbox = new THREE.Box3().setFromObject(obj);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.#glowTex(), color: 0x66ccff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
      glow.scale.set(1.6, 1.6, 1);
      glow.position.set(0, 0.45, bbox.min.z - 0.2);
      obj.add(glow);
      this.scene.add(obj);
      this.cars.set(c.id, { obj, pivots, state: c.state, bbox, glow, prevMode: c.state?.mode, brake: 1 });
    });
  }

  bindState(id, state) { const c = this.cars.get(id); if (c) c.state = state; }

  #glowTex() {
    this._glow ??= canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.3, 'rgba(120,200,255,0.8)'); r.addColorStop(1, 'rgba(0,80,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    }, { repeat: false });
    return this._glow;
  }

  setPlayer(id) { this.playerId = id; }

  setStartLights(n) {
    this.startLights.forEach((m, i) => { m.color.set(i < n ? 0xff2a1a : 0x220000); m.emissive.set(i < n ? 0xff2a1a : 0x000000); });
  }

  /** Track frame at distance d (wraps around the lap). */
  frame(d) {
    const L = this.length;
    const u = (((d % L) + L) % L) / L;
    const f = u * (this.samples.length - 1);
    const i = Math.floor(f), a = f - i;
    const A = this.samples[i], B = this.samples[Math.min(i + 1, this.samples.length - 1)];
    const p = A.p.clone().lerp(B.p, a);
    const t = A.t.clone().lerp(B.t, a).normalize();
    return { p, t, n: new THREE.Vector3(-t.z, 0, t.x) };
  }

  // ---------- frame loop ----------

  start() { this.clock.start(); this.renderer.setAnimationLoop(() => this.#frame()); }
  stop() { this.renderer.setAnimationLoop(null); }

  /** Advance one simulated frame by dt seconds (used by automated checks). */
  advance(dt) { this.onUpdate?.(dt); this.#update(dt); this.#render(); }

  #frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this._acc += dt;
    if (this._acc < 1 / this.fpsCap - 0.002) return;
    const step = Math.min(this._acc, 0.1);
    this._acc = 0;
    this._fpsFrames++; this._fpsTime += step;
    if (this._fpsTime >= 0.5) { this.fps = Math.round(this._fpsFrames / this._fpsTime); this._fpsFrames = 0; this._fpsTime = 0; }
    this.onUpdate?.(step);
    this.#update(step);
    this.#render();
  }

  #render() {
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  }

  #update(dt) {
    const tmp = new THREE.Vector3();
    for (const [id, c] of this.cars) {
      const s = c.state;
      if (!s) continue;
      const { p, t, n } = this.frame(s.d);
      c.obj.position.copy(p).addScaledVector(n, s.lat);
      const slip = Math.atan2(s.latV || 0, Math.max(6, s.v));
      const yaw = Math.atan2(t.x, t.z) - slip + (s.mode === 'crash' ? s.crashSpin : 0);
      c.obj.rotation.set(0, yaw, (s.latV || 0) * -0.012);
      if (s.mode === 'crash') c.obj.position.y = Math.abs(Math.sin(s.crashSpin * 0.9)) * 0.35;
      for (const pv of c.pivots) pv.rotation.x += (s.v * dt) / 0.35;

      // Brake lights and turbo glow.
      const braking = s.mode === 'slow' || s.mode === 'crash' ? 3 : 1;
      if (braking !== c.brake) { setBrakeGlow(c.obj, braking); c.brake = braking; }
      c.glow.material.opacity = s.mode === 'turbo' ? 0.65 + Math.random() * 0.35 : 0;

      // Effects: crash burst, off-road dust, turbo exhaust.
      if (s.mode === 'crash' && c.prevMode !== 'crash') this.#crashBurst(c, id);
      c.prevMode = s.mode;
      if (s.mode === 'crash' && Math.random() < 0.6) this.#smoke(c.obj.position, 0.25);
      if (s.offRoad && s.v > 6 && Math.random() < 0.7) {
        tmp.copy(c.obj.position).addScaledVector(t, -2);
        this.particles.emit(tmp, { x: (Math.random() - 0.5) * 2, y: 1 + Math.random(), z: (Math.random() - 0.5) * 2 }, { life: 1.2, size: 1.2, grow: 2.5, color: [0.78, 0.66, 0.48], alpha: 0.5 });
      }
    }
    this.particles.update(dt);
    this.#updateCamera(dt);
  }

  #smoke(p, chance) {
    if (Math.random() > chance + 0.5) return;
    this.particles.emit({ x: p.x + (Math.random() - 0.5) * 1.5, y: 0.6, z: p.z + (Math.random() - 0.5) * 1.5 },
      { x: (Math.random() - 0.5), y: 1.5 + Math.random(), z: (Math.random() - 0.5) }, { life: 2, size: 1.6, grow: 2.2, color: [0.35, 0.36, 0.38], alpha: 0.55 });
  }

  #crashBurst(c, id) {
    const p = c.obj.position;
    for (let i = 0; i < 40; i++) {
      this.particles.emit({ x: p.x, y: 0.6, z: p.z },
        { x: (Math.random() - 0.5) * 16, y: 3 + Math.random() * 6, z: (Math.random() - 0.5) * 16 },
        { life: 0.6 + Math.random() * 0.4, size: 0.18, grow: 0, color: [1, 0.7 + Math.random() * 0.3, 0.2], alpha: 1 });
    }
    for (let i = 0; i < 18; i++) this.#smoke(p, 1);
    if (id === this.playerId) this.shake = 0.9;
    this.onCrash?.(id);
  }

  #updateCamera(dt) {
    const player = this.cars.get(this.playerId) ?? this.cars.values().next().value;
    if (!player?.state) return;
    const s = player.state;
    const { p: tp, t } = this.frame(s.d);
    const pos = player.obj.position;
    const fwd = t.clone();
    let want, look, fov = 60;
    if (this.mode === 'attract') {
      this.orbit += dt * 0.15;
      const a = Math.sin(this.orbit) * 0.7;
      const back = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      want = pos.clone().addScaledVector(back, -7.5).add(new THREE.Vector3(0, 1.6, 0));
      look = pos.clone().addScaledVector(fwd, 3).add(new THREE.Vector3(0, 0.8, 0));
    } else {
      const speedK = Math.min(1, s.v / SIM.turbo);
      want = tp.clone().addScaledVector(player.obj.position.clone().sub(tp), 0.75).addScaledVector(fwd, -8.5 - speedK * 1.5).add(new THREE.Vector3(0, 3.1, 0));
      look = pos.clone().addScaledVector(fwd, 12).add(new THREE.Vector3(0, 0.9, 0));
      fov = 58 + speedK * 16;
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(want, k);
    this._look ??= look.clone();
    this._look.lerp(look, k);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 1.2);
      const a = this.shake * 0.5;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a));
    }
    this.camera.lookAt(this._look);
    this.camera.fov += (fov - this.camera.fov) * k;
    this.camera.updateProjectionMatrix();

    // Speed lines while driving fast.
    const turbo = this.mode === 'race' && (s.mode === 'turbo' || s.mode === 'drive');
    const target = turbo ? (s.mode === 'turbo' ? 0.55 : 0.25) : 0;
    const lm = this.speedLines.material;
    lm.opacity += (target - lm.opacity) * k;
    if (lm.opacity > 0.01) {
      const arr = this.speedLines.geometry.attributes.position.array;
      this.speedSeeds.forEach((sd, i) => {
        sd[2] = (sd[2] + dt * 2.2) % 1;
        const z = -2 - (1 - sd[2]) * 30, x = sd[0] * 6, y = sd[1] * 3.5;
        if (Math.abs(x) < 1.6 && Math.abs(y) < 1.2) { arr.fill(0, i * 6, i * 6 + 6); return; }
        arr.set([x, y, z, x * 1.04, y * 1.04, z + 4 + sd[2] * 3], i * 6);
      });
      this.speedLines.geometry.attributes.position.needsUpdate = true;
    }

    // The sun's shadow box follows the player.
    if (this.renderer.shadowMap.enabled) {
      this.sun.position.copy(pos).addScaledVector(this.sunDir, 150);
      this.sun.target.position.copy(pos);
    }
  }

  /** Draws the circuit and car dots onto a 2D canvas. */
  drawMinimap(ctx, colors) {
    const { width: w, height: h } = ctx.canvas;
    if (!this._mapBounds) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const { p } of this.samples) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
      this._mapBounds = { minX, minZ, maxX, maxZ, scale: Math.min((w - 20) / (maxX - minX), (h - 20) / (maxZ - minZ)) };
    }
    const b = this._mapBounds;
    const ox = (w - (b.maxX - b.minX) * b.scale) / 2, oz = (h - (b.maxZ - b.minZ) * b.scale) / 2;
    const map = (p) => [ox + (p.x - b.minX) * b.scale, oz + (p.z - b.minZ) * b.scale];
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineJoin = 'round';
    ctx.beginPath();
    this.samples.forEach(({ p }, i) => { const [x, y] = map(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    const order = [...this.cars.entries()].sort(([a], [c]) => (a === this.playerId) - (c === this.playerId));
    for (const [id, c] of order) {
      const [x, y] = map(c.obj.position);
      ctx.fillStyle = colors[id] ?? '#fff';
      ctx.beginPath(); ctx.arc(x, y, id === this.playerId ? 5.5 : 4, 0, Math.PI * 2); ctx.fill();
      if (id === this.playerId) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
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
    this.camera.far = q.fogFar + 2500;
    this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    // Glow on bright lights (bloom) only on High: it is the most expensive effect.
    this.composer?.dispose();
    this.composer = null;
    if (q.bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.5, 0.92));
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  setFpsCap(cap) { this.fpsCap = cap; }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}

/** Minimal geometry merge (positions, normals, uvs; non-indexed output). */
function mergeGeometries(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const attr of ['position', 'normal', 'uv']) {
    const size = parts[0].attributes[attr].itemSize;
    const total = parts.reduce((s, g) => s + g.attributes[attr].count * size, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of parts) { arr.set(g.attributes[attr].array, o); o += g.attributes[attr].array.length; }
    out.setAttribute(attr, new THREE.BufferAttribute(arr, size));
  }
  out.computeVertexNormals();
  return out;
}
