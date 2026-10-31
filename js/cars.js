// Car catalogue and model loading. Cars are cosmetic only: every car has the
// same speed and handling in a race (handoff S04/E02).
// Shapes are original designs inspired by car classes; names are invented and
// no real brand names, logos or badges are used.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const RARITY = {
  starter:   { label: 'Starter',   color: '#9aa3b2' },
  bronze:    { label: 'Bronze',    color: '#c98a4b' },
  silver:    { label: 'Silver',    color: '#cfd6df' },
  gold:      { label: 'Gold',      color: '#f2c14e' },
  legendary: { label: 'Legendary', color: '#c86bff' },
  mythic:    { label: 'Mythic',    color: '#38e8ff' },
};

// Prices are starting values (handoff E02 ladder) and live in the database in
// Part 2; this list is the display copy for the game.
export const CARS = [
  { id: 'rookie',   name: 'Rookie GT',        kind: 'Sports coupé',     rarity: 'starter',   price: 0,     color: '#18c6e8' },
  { id: 'metro',    name: 'Metro Hatch',      kind: 'City hatchback',   rarity: 'bronze',    price: 3000,  color: '#e8e4da' },
  { id: 'sedan',    name: 'Urban Saloon',     kind: 'Family saloon',    rarity: 'bronze',    price: 4500,  color: '#2f5fbf' },
  { id: 'trail',    name: 'Trail SUV',        kind: 'Off-road SUV',     rarity: 'silver',    price: 7500,  color: '#3c6e47' },
  { id: 'sterling', name: 'Sterling Coupé',   kind: 'Performance coupé', rarity: 'gold',     price: 15000, color: '#1f8fff' },
  { id: 'heritage', name: 'Heritage RS',      kind: 'Classic sports car', rarity: 'gold',    price: 22000, color: '#e8c547' },
  { id: 'vortex',   name: 'Vortex Super-SUV', kind: 'Super SUV',        rarity: 'legendary', price: 30000, color: '#ff7a00' },
  { id: 'raptor',   name: 'Raptor V12',       kind: 'Supercar',         rarity: 'legendary', price: 45000, color: '#9be15d' },
  { id: 'phantom',  name: 'Phantom Hyper',    kind: 'Hypercar',         rarity: 'legendary', price: 60000, color: '#14161c' },
  { id: 'mythic',   name: 'Apex Mythic',      kind: 'Earned, never sold', rarity: 'mythic',  price: null,  color: '#0a0d12' },
];
export const CAR_BY_ID = Object.fromEntries(CARS.map((c) => [c.id, c]));
export const DEFAULT_CAR = 'rookie';

const loader = new GLTFLoader();
const cache = new Map();

export function loadCar(id) {
  const key = CAR_BY_ID[id] ? id : DEFAULT_CAR;
  if (!cache.has(key)) cache.set(key, loader.loadAsync(new URL(`../assets/cars/${key}.glb`, import.meta.url).href).then((g) => g.scene));
  return cache.get(key);
}

/**
 * Clone a loaded car, repaint it and upgrade its materials for the chosen quality.
 * Wheel nodes are wrapped in pivots so they can spin around the axle.
 */
export function makeCar(template, { color, quality = 'medium', envMap = null }) {
  const obj = template.clone(true);
  const wheels = [];
  obj.traverse((o) => {
    if (/^Wheel_/.test(o.name)) wheels.push(o);
    if (!o.isMesh) return;
    o.castShadow = quality !== 'low';
    o.material = Array.isArray(o.material) ? o.material.map((m) => upgrade(m, color, quality, envMap)) : upgrade(o.material, color, quality, envMap);
  });
  const pivots = wheels.map((w) => {
    const pivot = new THREE.Group();
    pivot.position.copy(w.position);
    w.position.set(0, 0, 0);
    w.parent.add(pivot);
    pivot.add(w);
    return pivot;
  });
  return { obj, pivots };
}

function upgrade(m, color, quality, envMap) {
  const name = m.name;
  if (name === 'Body') {
    const opts = { color: new THREE.Color(color), metalness: 0.55, roughness: 0.28, envMap, envMapIntensity: 1.1, name };
    return quality === 'low'
      ? new THREE.MeshStandardMaterial(opts)
      : new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 1, clearcoatRoughness: 0.08 });
  }
  const c = m.clone();
  c.envMap = envMap;
  if (name === 'Glass') { c.transparent = true; c.opacity = 0.82; c.roughness = 0.05; c.metalness = 0.4; c.envMapIntensity = 1.4; }
  if (name === 'Tail') { c.emissiveIntensity = 1.4; c.userData.base = 1.4; }
  if (name === 'Head') c.emissiveIntensity = 1.2;
  return c;
}

/** Brake-light glow: 1 = normal, higher when braking/slowed. */
export function setBrakeGlow(obj, k) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) if (m.name === 'Tail') m.emissiveIntensity = (m.userData.base ?? 1.4) * k;
  });
}
