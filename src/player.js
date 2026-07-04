import * as THREE from 'three';

// First-person walker: pointer-lock mouse look + WASD, AABB wall collision.

const RADIUS = 0.3; // player body radius

export class Player {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.enabled = false;
    this.pos = new THREE.Vector3(0, 1.7, 70);
    this.yaw = Math.PI;
    this.pitch = 0;
    this.keys = new Set();
    this.speed = 6.5;
    this.solids = []; // {minX,maxX,minZ,maxZ}
    this.locked = false;

    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch));
    });
  }

  requestLock() {
    if (!this.locked) this.dom.requestPointerLock?.();
  }
  releaseLock() {
    if (this.locked) document.exitPointerLock?.();
  }

  teleport(x, z, yaw) {
    this.pos.set(x, 1.7, z);
    if (yaw !== undefined) { this.yaw = yaw; this.pitch = 0; }
  }

  lookAt(target) {
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = 0;
  }

  // push the point out of every expanded AABB along the axis of least penetration
  resolveCollisions(p) {
    for (let pass = 0; pass < 2; pass++) {
      for (const s of this.solids) {
        const minX = s.minX - RADIUS, maxX = s.maxX + RADIUS;
        const minZ = s.minZ - RADIUS, maxZ = s.maxZ + RADIUS;
        if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;
        const pushLeft = p.x - minX, pushRight = maxX - p.x;
        const pushFront = p.z - minZ, pushBack = maxZ - p.z;
        const min = Math.min(pushLeft, pushRight, pushFront, pushBack);
        if (min === pushLeft) p.x = minX;
        else if (min === pushRight) p.x = maxX;
        else if (min === pushFront) p.z = minZ;
        else p.z = maxZ;
      }
    }
  }

  update(dt) {
    if (this.enabled) {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const move = new THREE.Vector3();
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(fwd);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(fwd);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(this.speed * dt);
        const next = this.pos.clone().add(move);
        this.resolveCollisions(next);
        next.x = Math.max(-32, Math.min(32, next.x));
        next.z = Math.max(-85, Math.min(85, next.z));
        this.pos.copy(next);
      }
    }
    this.camera.position.copy(this.pos);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }
}
