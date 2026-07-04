import * as THREE from 'three';

// Builds Banksia Street: road, lots, enterable houses with real floor plans that
// match the advertised beds/baths, gums, and sale signs.
// Returns { world, houses, solids } — solids are world-space AABBs for collision.

function mat(color, opts = {}) {
  return new THREE.MeshLambertMaterial({ color, ...opts });
}

function box(w, h, d, material, solid = false) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = true;
  m.receiveShadow = true;
  if (solid) m.userData.solid = true;
  return m;
}

// ---------- signs ----------

function drawSignCanvas(listing, priceText, sold) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 384;
  const g = c.getContext('2d');
  const isAuction = listing.saleType === 'auction';
  g.fillStyle = '#f7f4ee';
  g.fillRect(0, 0, 512, 384);
  g.fillStyle = isAuction ? '#0f2038' : '#00572b';
  g.fillRect(0, 0, 512, 86);
  g.fillStyle = isAuction ? '#ffcd00' : '#ffffff';
  g.font = '900 52px Helvetica, Arial';
  g.textAlign = 'center';
  g.fillText(isAuction ? 'AUCTION' : 'FOR SALE', 256, 62);
  g.fillStyle = '#0f2038';
  g.font = '700 34px Helvetica, Arial';
  g.fillText(listing.address, 256, 140);
  g.font = '400 26px Helvetica, Arial';
  g.fillStyle = '#444';
  g.fillText(`${listing.beds} bed · ${listing.baths} bath · ${listing.land} m²`, 256, 182);
  g.font = '800 34px Helvetica, Arial';
  g.fillStyle = '#00843d';
  g.fillText(priceText, 256, 236);
  g.font = '600 24px Helvetica, Arial';
  g.fillStyle = '#666';
  g.fillText(isAuction ? 'Saturday 10:00am on site' : 'Private sale — offers invited', 256, 278);
  g.font = 'italic 700 28px Helvetica, Arial';
  g.fillStyle = '#b0332a';
  g.fillText('Ray Wight — Wattlebrook', 256, 330);
  if (sold) {
    g.save();
    g.translate(256, 192);
    g.rotate(-0.22);
    g.fillStyle = 'rgba(214, 69, 65, 0.92)';
    g.fillRect(-240, -50, 480, 100);
    g.fillStyle = '#fff';
    g.font = '900 76px Helvetica, Arial';
    g.fillText(sold === 'you' ? 'SOLD — YOURS!' : 'SOLD', 0, 26);
    g.restore();
  }
  return c;
}

function makeSign(listing, priceText) {
  const group = new THREE.Group();
  const post = box(0.08, 1.9, 0.08, mat(0x8a8a8a));
  const post2 = post.clone();
  post.position.set(-0.75, 0.95, 0);
  post2.position.set(0.75, 0.95, 0);
  group.add(post, post2);

  const canvas = drawSignCanvas(listing, priceText, null);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const boardMat = new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.01 });
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.55, 0.06), [
    mat(0xffffff), mat(0xffffff), mat(0xffffff), mat(0xffffff), boardMat, boardMat,
  ]);
  board.position.y = 1.5;
  board.castShadow = true;
  group.add(board);
  group.userData.updateSign = (newPriceText, sold) => {
    texture.image = drawSignCanvas(listing, newPriceText, sold);
    texture.needsUpdate = true;
  };
  return group;
}

// ---------- room labels ----------

function makeRoomLabel(name, dims) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 144;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(15, 32, 56, 0.72)';
  g.beginPath();
  g.roundRect(6, 6, 500, 132, 26);
  g.fill();
  g.textAlign = 'center';
  g.fillStyle = '#ffcd00';
  g.font = '800 52px Helvetica, Arial';
  g.fillText(name.toUpperCase(), 256, 66);
  g.fillStyle = '#cfd9e8';
  g.font = '400 34px Helvetica, Arial';
  g.fillText(dims, 256, 114);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.set(1.9, 0.53, 1);
  return sprite;
}

// ---------- house construction ----------

const FLOOR_Y = 0.15;
const WALL_H = 2.6;
const TOP_Y = FLOOR_Y + WALL_H; // 2.75
const T = 0.12;

const HOUSE_DIMS = {
  weatherboard: [8.4, 9.0],
  brick: [10.5, 9.6],
  reno: [7.6, 8.4],
  mcmansion: [11.0, 10.0],
  townhouse: [6.8, 8.0],
  bungalow: [8.6, 9.2],
};

function segsFrom(a0, a1, gaps) {
  const sorted = [...gaps].sort((p, q) => p[0] - q[0]);
  const segs = [];
  let cur = a0;
  for (const [c, gw] of sorted) {
    const g0 = c - gw / 2, g1 = c + gw / 2;
    if (g0 > cur + 0.01) segs.push([cur, g0]);
    cur = Math.max(cur, g1);
  }
  if (cur < a1 - 0.01) segs.push([cur, a1]);
  return segs;
}

// wall along z at fixed x
function wallX(g, m, x, z0, z1, gaps = []) {
  for (const [s0, s1] of segsFrom(Math.min(z0, z1), Math.max(z0, z1), gaps)) {
    const wall = box(T, WALL_H, s1 - s0, m, true);
    wall.position.set(x, FLOOR_Y + WALL_H / 2, (s0 + s1) / 2);
    g.add(wall);
  }
  for (const [c, gw] of gaps) { // lintel over each doorway
    const lin = box(T, 0.5, gw, m);
    lin.position.set(x, TOP_Y - 0.25, c);
    g.add(lin);
  }
}

// wall along x at fixed z
function wallZ(g, m, z, x0, x1, gaps = []) {
  for (const [s0, s1] of segsFrom(Math.min(x0, x1), Math.max(x0, x1), gaps)) {
    const wall = box(s1 - s0, WALL_H, T, m, true);
    wall.position.set((s0 + s1) / 2, FLOOR_Y + WALL_H / 2, z);
    g.add(wall);
  }
  for (const [c, gw] of gaps) {
    const lin = box(gw, 0.5, T, m);
    lin.position.set(c, TOP_Y - 0.25, z);
    g.add(lin);
  }
}

function addWindow(g, trim, x, z, rotY, width = 1.3) {
  const win = new THREE.Group();
  const frame = box(width + 0.16, 1.35, 0.26, mat(trim));
  frame.position.y = 1.62;
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(width, 1.16, 0.18),
    new THREE.MeshLambertMaterial({ color: 0xa8cfe0, transparent: true, opacity: 0.55 })
  );
  glass.position.y = 1.62;
  const sill = box(width + 0.3, 0.08, 0.34, mat(trim));
  sill.position.y = 0.92;
  win.add(frame, glass, sill);
  win.position.set(x, 0, z);
  win.rotation.y = rotY;
  g.add(win);
}

// ---------- furniture ----------

function furnish(g, room, palette) {
  const { name, cx, cz, w, d } = room;
  const F = FLOOR_Y;
  const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); g.add(mesh); };

  if (name.startsWith('Bedroom')) {
    const bw = Math.min(1.4, w - 1.2), bl = Math.min(1.9, d - 1.0);
    const base = box(bw, 0.3, bl, mat(0x6b4a33), true);
    add(base, cx, F + 0.15, cz - (d / 2 - bl / 2 - 0.35));
    const mattress = box(bw - 0.1, 0.18, bl - 0.1, mat(0xf2efe6));
    add(mattress, cx, F + 0.39, cz - (d / 2 - bl / 2 - 0.35));
    const pillow = box(bw - 0.5, 0.1, 0.4, mat(0xdfe6ee));
    add(pillow, cx, F + 0.53, cz - (d / 2 - 0.65));
    const robe = box(Math.min(1.4, w - 1.6), 1.9, 0.5, mat(0x8a7156), true);
    add(robe, cx + w / 2 - 0.9, F + 0.95, cz + d / 2 - 0.4);
  } else if (name === 'Living') {
    const sofa = box(2.1, 0.45, 0.85, mat(0x5e6e84), true);
    add(sofa, cx - 0.3, F + 0.23, cz + 0.5);
    const back = box(2.1, 0.5, 0.22, mat(0x536276));
    add(back, cx - 0.3, F + 0.68, cz + 0.9);
    const table = box(1.0, 0.32, 0.55, mat(0x7a5c40));
    add(table, cx - 0.3, F + 0.16, cz - 0.55);
    const tv = box(1.7, 0.95, 0.09, mat(0x14181d));
    add(tv, cx + w / 2 - 0.35, F + 1.15, cz - 0.2);
    tv.rotation.y = Math.PI / 2;
  } else if (name === 'Kitchen') {
    const bench = box(0.62, 0.92, Math.max(1.2, d - 0.8), mat(0xd8d2c6), true);
    add(bench, cx + w / 2 - 0.45, F + 0.46, cz);
    const fridge = box(0.7, 1.75, 0.68, mat(0x9aa2ab), true);
    add(fridge, cx - w / 2 + 0.5, F + 0.88, cz - d / 2 + 0.5);
    const island = box(1.3, 0.9, 0.62, mat(0xc9c2b4), true);
    add(island, cx - 0.2, F + 0.45, cz + 0.1);
  } else if (name === 'Bathroom' || name === 'Ensuite') {
    const vanity = box(0.9, 0.82, 0.48, mat(0xe8e4da), true);
    add(vanity, cx - w / 2 + 0.55, F + 0.41, cz + d / 2 - 0.4);
    const shower = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 2.0, 0.85),
      new THREE.MeshLambertMaterial({ color: 0xbfdde8, transparent: true, opacity: 0.35 })
    );
    shower.userData.solid = true;
    add(shower, cx + w / 2 - 0.55, F + 1.0, cz - d / 2 + 0.55);
    const loo = box(0.4, 0.55, 0.5, mat(0xffffff));
    add(loo, cx - w / 2 + 0.4, F + 0.28, cz - d / 2 + 0.45);
  } else if (name === 'Laundry') {
    const washer = box(0.6, 0.85, 0.6, mat(0xf0f0ee), true);
    add(washer, cx + w / 2 - 0.5, F + 0.43, cz - d / 2 + 0.5);
    const trough = box(0.55, 0.85, 0.5, mat(0xd8d8d4), true);
    add(trough, cx + w / 2 - 1.15, F + 0.43, cz - d / 2 + 0.48);
  }
}

// ---------- the floor plan ----------

function buildInterior(g, listing, w, d) {
  const { beds, baths, palette } = listing;
  const hallW = w < 7.5 ? 1.3 : 1.5;
  const xL = -hallW / 2, xR = hallW / 2;
  const wallM = mat(0xf0ebe0);
  const rooms = [];

  // floor & ceiling
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(palette.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y + 0.01;
  floor.receiveShadow = true;
  g.add(floor);
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ color: 0xd9d4c8 }) // flat — dodges the green hemisphere bounce
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = TOP_Y;
  g.add(ceil);

  // left column cells: bedrooms then bathroom(s) at rear
  const leftNames = beds === 2 ? ['Bedroom 1', 'Bedroom 2', 'BATH'] : ['Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'BATH'];
  const nL = leftNames.length;
  const cellD = d / nL;
  const leftW = xL - (-w / 2);
  const doorGaps = [];
  leftNames.forEach((nm, i) => {
    const z1 = d / 2 - i * cellD, z0 = z1 - cellD;
    const cz = (z0 + z1) / 2;
    if (i > 0) wallZ(g, wallM, z1, -w / 2, xL); // divider above this cell
    if (nm === 'BATH') {
      if (baths >= 2) {
        const xM = (-w / 2 + xL) / 2;
        wallX(g, wallM, xM, z0, z1, [[cz, 0.8]]); // ensuite entered through bathroom
        rooms.push({ name: 'Bathroom', cx: (xM + xL) / 2, cz, w: xL - xM, d: cellD });
        rooms.push({ name: 'Ensuite', cx: (-w / 2 + xM) / 2, cz, w: xM + w / 2, d: cellD });
      } else {
        rooms.push({ name: 'Bathroom', cx: (-w / 2 + xL) / 2, cz, w: leftW, d: cellD });
      }
    } else {
      rooms.push({ name: nm, cx: (-w / 2 + xL) / 2, cz, w: leftW, d: cellD });
    }
    doorGaps.push([cz, 1.2]);
  });
  wallX(g, wallM, xL, -d / 2, d / 2, doorGaps);

  // right column: living (open plan, front), kitchen, rear room
  const rightW = w / 2 - xR;
  const zLiv = d / 2 - d * 0.4;
  const zKit = zLiv - d * 0.3;
  rooms.push({ name: 'Living', cx: (xR + w / 2) / 2, cz: d / 2 - d * 0.2, w: rightW, d: d * 0.4 });
  rooms.push({ name: 'Kitchen', cx: (xR + w / 2) / 2, cz: (zLiv + zKit) / 2, w: rightW, d: d * 0.3 });
  const rearName = beds === 4 ? 'Bedroom 4' : 'Laundry';
  const rearCz = (zKit + -d / 2) / 2;
  rooms.push({ name: rearName, cx: (xR + w / 2) / 2, cz: rearCz, w: rightW, d: zKit + d / 2 });
  wallZ(g, wallM, zKit, xR, w / 2);                      // kitchen / rear divider
  wallX(g, wallM, xR, -d / 2, zKit, [[rearCz, 1.2]]);    // rear room hall wall + door

  // labels + furniture
  for (const r of rooms) {
    const label = makeRoomLabel(r.name, `${r.w.toFixed(1)}m × ${r.d.toFixed(1)}m`);
    label.position.set(r.cx, 2.28, r.cz);
    g.add(label);
    furnish(g, r, palette);
  }

  // warm interior light
  const lamp = new THREE.PointLight(0xffe3c0, 6, 16, 1.6);
  lamp.position.set(0, TOP_Y - 0.7, d * 0.1);
  g.add(lamp);

  return rooms;
}

function pyramidRoof(w, d, h, color) {
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1, h, 4), mat(color));
  roof.scale.set(w * 0.72, 1, d * 0.72);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  return roof;
}

function gableRoof(w, d, h, color) {
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  geo.rotateY(Math.PI / 2);
  geo.translate(-w / 2, 0, 0);
  const roof = new THREE.Mesh(geo, mat(color));
  roof.castShadow = true;
  return roof;
}

function buildHouse(listing) {
  const { palette, id } = listing;
  const g = new THREE.Group();
  const [w, d] = HOUSE_DIMS[id];
  const twoStorey = id === 'mcmansion' || id === 'townhouse';
  const wallM = mat(palette.wall);

  // slab
  const slab = box(w + 0.4, FLOOR_Y, d + 0.4, mat(0xa8a29a), true);
  slab.position.y = FLOOR_Y / 2;
  slab.userData.solid = false; // low lip, walkable
  g.add(slab);

  // perimeter walls with front door gap
  wallZ(g, wallM, d / 2, -w / 2, w / 2, [[0, 1.5]]);
  wallZ(g, wallM, -d / 2, -w / 2, w / 2);
  wallX(g, wallM, -w / 2, -d / 2, d / 2);
  wallX(g, wallM, w / 2, -d / 2, d / 2);

  // front door ajar
  const doorG = new THREE.Group();
  const door = box(0.9, 2.05, 0.06, mat(0x5b3a24));
  door.position.set(-0.45, FLOOR_Y + 1.03, 0);
  doorG.add(door);
  doorG.position.set(0.72, 0, d / 2 - 0.1);
  doorG.rotation.y = 1.2; // swung open, welcoming
  g.add(doorG);

  const rooms = buildInterior(g, listing, w, d);

  // exterior windows: front pair, one per left-column cell, kitchen side
  addWindow(g, palette.trim, -w * 0.3, d / 2, 0);
  addWindow(g, palette.trim, w * 0.3, d / 2, 0);
  const nL = listing.beds === 2 ? 3 : 4;
  for (let i = 0; i < nL; i++) {
    const cz = d / 2 - (i + 0.5) * (d / nL);
    addWindow(g, palette.trim, -w / 2, cz, Math.PI / 2, 1.1);
  }
  addWindow(g, palette.trim, w / 2, d / 2 - d * 0.55, Math.PI / 2, 1.1);
  addWindow(g, palette.trim, -w * 0.25, -d / 2, 0, 1.1);

  // fascia + roof
  const fascia = box(w + 0.5, 0.22, d + 0.5, mat(palette.trim));
  fascia.position.y = TOP_Y + 0.16; // bottom sits clear of the ceiling plane (z-fighting)
  g.add(fascia);

  let roofBase = TOP_Y + 0.27;
  if (twoStorey) {
    const upper = box(w, 2.5, d, wallM, false);
    upper.position.y = roofBase + 1.25;
    g.add(upper);
    for (const wx of [-w * 0.3, 0, w * 0.3]) {
      const win = new THREE.Group();
      const fr = box(1.3, 1.2, 0.2, mat(palette.trim));
      const gl = box(1.1, 1.0, 0.24, mat(0xa8cfe0));
      win.add(fr, gl);
      win.position.set(wx, roofBase + 1.5, d / 2);
      g.add(win);
    }
    const cap = box(w + 0.6, 0.3, d + 0.6, mat(palette.roof));
    cap.position.y = roofBase + 2.5 + 0.15;
    g.add(cap);
  } else if (id === 'weatherboard' || id === 'bungalow') {
    const roof = gableRoof(w + 0.9, d + 0.9, 2.1, palette.roof);
    roof.position.y = roofBase;
    g.add(roof);
    const chim = box(0.7, 1.6, 0.7, mat(0x8c5a45));
    chim.position.set(w * 0.3, roofBase + 1.6, -d * 0.2);
    g.add(chim);
  } else {
    const roof = pyramidRoof(w + 0.9, d + 0.9, 2.0, palette.roof);
    roof.position.y = roofBase + 1.0;
    g.add(roof);
  }

  // veranda for the period homes
  if (id === 'weatherboard' || id === 'bungalow' || id === 'reno') {
    const vRoof = box(w * 0.92, 0.12, 2.1, mat(palette.roof));
    vRoof.position.set(0, 2.55, d / 2 + 1.05);
    g.add(vRoof);
    for (const px of [-w * 0.42, -1.4, 1.4, w * 0.42]) {
      const post = box(0.12, 2.4, 0.12, mat(palette.trim));
      post.position.set(px, 1.35, d / 2 + 1.95);
      g.add(post);
    }
  }

  // porch landing
  const porch = box(2.2, 0.14, 1.5, mat(0xb3ada2));
  porch.position.set(0, 0.07, d / 2 + 0.8);
  g.add(porch);

  return { g, rooms, w, d };
}

function buildFence(lotW, lotD, trim) {
  const g = new THREE.Group();
  const m = mat(trim ?? 0xe8e2d2);
  const addRun = (len, x, z, rotY) => {
    if (len <= 0.05) return;
    const run = box(len, 0.85, 0.08, m, true);
    run.position.set(x, 0.45, z);
    run.rotation.y = rotY;
    run.castShadow = false;
    g.add(run);
  };
  addRun(lotW, 0, -lotD / 2, 0);
  addRun(lotD, -lotW / 2, 0, Math.PI / 2);
  addRun(lotD, lotW / 2, 0, Math.PI / 2);
  // front fence with a gate gap centred on the path
  const gateW = 1.7;
  const runL = (lotW - gateW) / 2;
  addRun(runL, -(gateW / 2 + runL / 2), lotD / 2, 0);
  addRun(runL, gateW / 2 + runL / 2, lotD / 2, 0);
  return g;
}

function buildGum(scale = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16 * scale, 0.28 * scale, 4.4 * scale, 7),
    mat(0xd9cfc0)
  );
  trunk.position.y = 2.2 * scale;
  trunk.castShadow = true;
  g.add(trunk);
  const leaf = mat(0x6d7d54);
  for (let i = 0; i < 4; i++) {
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry((1.1 + Math.random() * 0.7) * scale, 0), leaf);
    blob.position.set(
      (Math.random() - 0.5) * 2.4 * scale,
      (3.9 + Math.random() * 1.6) * scale,
      (Math.random() - 0.5) * 2.4 * scale
    );
    blob.castShadow = true;
    g.add(blob);
  }
  return g;
}

export function buildPerson(shirtColor) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.85, 3, 8), mat(shirtColor));
  body.position.y = 0.95;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), mat(0xe0b896));
  head.position.y = 1.72;
  head.castShadow = true;
  g.add(body, head);
  return g;
}

// ---------- the street ----------

export function buildWorld(scene, listings, signTextFor) {
  const world = new THREE.Group();
  scene.add(world);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(280, 280), mat(0x5e7a44));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  world.add(ground);

  const road = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 180), mat(0x3c3f43));
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.02;
  road.receiveShadow = true;
  world.add(road);

  const dashMat = mat(0xd8d8d8);
  for (let z = -85; z <= 85; z += 6) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 2.4), dashMat);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.03, z);
    world.add(dash);
  }

  for (const side of [-1, 1]) {
    const path = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 180), mat(0xb9b3a8));
    path.rotation.x = -Math.PI / 2;
    path.position.set(side * 5.6, 0.025, 0);
    path.receiveShadow = true;
    world.add(path);
  }

  for (let z = -80; z <= 80; z += 16) {
    for (const side of [-1, 1]) {
      if (Math.abs(z % 32) < 8 && side === 1) continue;
      const gum = buildGum(0.8 + Math.random() * 0.6);
      gum.position.set(side * (8.2 + Math.random() * 2.5), 0, z + (Math.random() - 0.5) * 5);
      world.add(gum);
    }
  }
  for (let i = 0; i < 40; i++) {
    const gum = buildGum(1.1 + Math.random() * 1.2);
    const x = (Math.random() - 0.5) * 240;
    if (Math.abs(x) < 34) continue;
    gum.position.set(x, 0, (Math.random() - 0.5) * 240);
    world.add(gum);
  }

  const houses = {};

  for (const listing of listings) {
    const { lot } = listing;
    const lotGroup = new THREE.Group();
    lotGroup.position.set(lot.x, 0, lot.z);
    lotGroup.rotation.y = lot.facing === 1 ? Math.PI / 2 : -Math.PI / 2;
    world.add(lotGroup);

    const lawnColor = listing.id === 'reno' ? 0x8f8a56 : 0x6b8f4e;
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(20, 22), mat(lawnColor));
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.y = 0.015;
    lawn.receiveShadow = true;
    lotGroup.add(lawn);

    const { g: house, rooms, w, d } = buildHouse(listing);
    house.position.z = -3.5;
    lotGroup.add(house);

    lotGroup.add(buildFence(20, 22, listing.palette.trim));

    // front path: gate (z=11) to porch
    const frontFace = -3.5 + d / 2;
    const path = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 11 - frontFace - 0.2), mat(0xb3ada2));
    path.rotation.x = -Math.PI / 2;
    path.position.set(0, 0.02, (11 + frontFace) / 2);
    lotGroup.add(path);

    // driveway
    const drive = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 22 / 2 - frontFace), mat(0x9d9890));
    drive.rotation.x = -Math.PI / 2;
    drive.position.set(w / 2 + 1.8, 0.02, (11 + frontFace) / 2);
    lotGroup.add(drive);

    // letterbox + garden
    const lbox = box(0.3, 0.3, 0.22, mat(listing.palette.trim));
    const lpost = box(0.07, 0.9, 0.07, mat(0x777777));
    lbox.position.set(1.25, 1.0, 10.6);
    lpost.position.set(1.25, 0.45, 10.6);
    lotGroup.add(lbox, lpost);
    for (const bx of [-w / 2 + 0.4, w / 2 - 0.4]) {
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), mat(0x55703e));
      bush.position.set(bx, 0.45, frontFace + 0.9);
      bush.castShadow = true;
      lotGroup.add(bush);
    }

    const sign = makeSign(listing, signTextFor(listing));
    sign.position.set(-4.5, 0, 11.6);
    sign.rotation.y = -0.15;
    lotGroup.add(sign);

    houses[listing.id] = {
      listing,
      group: lotGroup,
      house,
      rooms,
      sign,
      frontPos: new THREE.Vector3(lot.x + lot.facing * 12.2, 0, lot.z),
      centre: new THREE.Vector3(lot.x, 0, lot.z),
    };
  }

  // collect world-space AABBs from everything flagged solid
  world.updateMatrixWorld(true);
  const solids = [];
  const bb = new THREE.Box3();
  world.traverse((o) => {
    if (o.isMesh && o.userData.solid) {
      bb.setFromObject(o);
      solids.push({ minX: bb.min.x, maxX: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z });
    }
  });

  return { world, houses, solids };
}
