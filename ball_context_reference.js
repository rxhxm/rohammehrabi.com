  // ============================================
  // FLOATING 3D OBJECTS IN THE POOL
  // ============================================
  
  const poolObjects = [];
  const objectsScene = new THREE.Scene();
  
  // Add strong lighting for underwater objects
  const ambientLight = new THREE.AmbientLight(0x88ccff, 0.8); // Slight blue tint underwater
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
  directionalLight.position.set(0, 5, 0); // Light from above
  const pointLight1 = new THREE.PointLight(0xffffff, 0.8, 5);
  pointLight1.position.set(0, -0.5, 0); // Light inside pool
  const pointLight2 = new THREE.PointLight(0x44aaff, 0.5, 3);
  pointLight2.position.set(0, -0.8, 0); // Blue underwater light
  objectsScene.add(ambientLight);
  objectsScene.add(directionalLight);
  objectsScene.add(pointLight1);
  objectsScene.add(pointLight2);
  
  // Pool boundaries (objects stay within these)
  const poolBounds = { minX: -0.85, maxX: 0.85, minZ: -0.85, maxZ: 0.85 };

  // ============================================
  // WATER HEIGHT READING (GPU -> CPU)
  // ============================================
  const waterHeightBuffer = new Float32Array(256 * 256 * 4);
  let heightBufferReady = false;

  function readWaterHeights() {
    renderer.readRenderTargetPixels(
      waterSimulation.texture, 0, 0, 256, 256, waterHeightBuffer
    );
    heightBufferReady = true;
  }

  function getWaterHeight(worldX, worldZ) {
    if (!heightBufferReady) return 0;
    const u = Math.max(0, Math.min(255, Math.floor((worldX * 0.5 + 0.5) * 255)));
    const v = Math.max(0, Math.min(255, Math.floor((worldZ * 0.5 + 0.5) * 255)));
    const h = waterHeightBuffer[(v * 256 + u) * 4];
    // Sanity clamp to prevent extreme physics spikes
    return isNaN(h) ? 0 : Math.max(-0.5, Math.min(0.5, h));
  }

  function getWaterGradient(worldX, worldZ) {
    const d = 0.02;
    const hL = getWaterHeight(worldX - d, worldZ);
    const hR = getWaterHeight(worldX + d, worldZ);
    const hB = getWaterHeight(worldX, worldZ - d);
    const hF = getWaterHeight(worldX, worldZ + d);
    return {
      x: (hR - hL) / (2 * d),
      z: (hF - hB) / (2 * d)
    };
  }

  // ============================================
  // SURFACE FLOATING OBJECTS (ride the waves)
  // ============================================
  const surfaceFloaters = [];

  class SurfaceFloater {
    constructor(mesh, config = {}) {
      this.mesh = mesh;
      this.baseRotationX = mesh.rotation.x;
      this.baseRotationZ = mesh.rotation.z;
      
      this.waterOffset = config.heightOffset || 0.02; // How high above water it floats
      this.buoyancy = config.buoyancy || 0.04;        // Spring constant k
      this.damping = config.damping || 0.85;          // Drag/damping b
      
      this.tiltAmount = config.tiltAmount || 0.5;
      this.spinSpeed = config.spinSpeed || 0.003;
      
      // Preferred location to hover around
      this.anchorX = config.anchorX || 0;
      this.anchorZ = config.anchorZ || 0;
      
      this.velocity = { x: (Math.random() - 0.5) * 0.002, y: 0, z: (Math.random() - 0.5) * 0.002 };
      this.angularVelocity = { x: 0, z: 0 };
      
      objectsScene.add(this.mesh);
    }

    update(time) {
      const x = this.mesh.position.x;
      const y = this.mesh.position.y;
      const z = this.mesh.position.z;

      // 1. Vertical Buoyancy (Spring-Damper System)
      const h = getWaterHeight(x, z);
      const targetY = h + this.waterOffset;
      
      // Hooke's law: F = -k * (current - target)
      const forceY = (targetY - y) * this.buoyancy;
      this.velocity.y += forceY;
      this.velocity.y *= this.damping; // Vertical Damping
      
      // Strict Vertical Clamp to prevent jumping out of water completely
      const maxYVel = 0.05;
      this.velocity.y = Math.max(-maxYVel, Math.min(maxYVel, this.velocity.y));
      this.mesh.position.y += this.velocity.y;

      // 2. Horizontal Translation (sliding down waves + water friction)
      const grad = getWaterGradient(x, z);
      
      // Clamp extreme gradients to stop tweaking/shaking
      const maxGrad = 0.5; // Tighter gradient limit
      grad.x = Math.max(-maxGrad, Math.min(maxGrad, grad.x));
      grad.z = Math.max(-maxGrad, Math.min(maxGrad, grad.z));

      // Gravity pulls objects down the slope
      // Increased this from 0.0003 back up to 0.002 so it actually surfs away from waves
      const gravityPush = 0.002;
      this.velocity.x += grad.x * gravityPush;
      this.velocity.z += grad.z * gravityPush;
      
      // Soft boundary: pull towards anchor instead of (0,0)
      const centerRadius = 0.25; // How far it's allowed to wander from its anchor
      const dist = Math.sqrt((x - this.anchorX)**2 + (z - this.anchorZ)**2);
      
      if (dist > centerRadius) {
        // Pull back towards anchor smoothly but a bit stronger so it doesn't leave the screen easily
        const pullStrength = 0.0005 + (dist - centerRadius) * 0.003;
        this.velocity.x -= ((x - this.anchorX) / dist) * pullStrength;
        this.velocity.z -= ((z - this.anchorZ) / dist) * pullStrength;
      }

      // Drag/friction on water surface
      const horizontalDamping = 0.94; // Less friction (0.94 vs 0.90) so it actually glides when pushed
      this.velocity.x *= horizontalDamping;
      this.velocity.z *= horizontalDamping;

      // Hard clamp horizontal velocity to prevent shooting off-screen
      const maxHVel = 0.02; // Slightly higher top speed so it can surf
      this.velocity.x = Math.max(-maxHVel, Math.min(maxHVel, this.velocity.x));
      this.velocity.z = Math.max(-maxHVel, Math.min(maxHVel, this.velocity.z));

      this.mesh.position.x += this.velocity.x;
      this.mesh.position.z += this.velocity.z;

      // 3. Rotation (Spring-Damper to match water normal)
      const targetRotX = this.baseRotationX + (-grad.z * this.tiltAmount);
      const targetRotZ = this.baseRotationZ + (grad.x * this.tiltAmount);

      const rotForceX = (targetRotX - this.mesh.rotation.x) * this.buoyancy;
      const rotForceZ = (targetRotZ - this.mesh.rotation.z) * this.buoyancy;

      this.angularVelocity.x += rotForceX;
      this.angularVelocity.z += rotForceZ;

      this.angularVelocity.x *= this.damping;
      this.angularVelocity.z *= this.damping;

      // Clamp angular velocity so it doesn't spin wildly
      const maxRotVel = 0.1;
      this.angularVelocity.x = Math.max(-maxRotVel, Math.min(maxRotVel, this.angularVelocity.x));
      this.angularVelocity.z = Math.max(-maxRotVel, Math.min(maxRotVel, this.angularVelocity.z));

      this.mesh.rotation.x += this.angularVelocity.x;
      this.mesh.rotation.z += this.angularVelocity.z;
      
      // Continuous gentle spin
      this.mesh.rotation.y += this.spinSpeed;
    }
  }

  function createSurfaceFloaters() {
    // 1. Sleek Sphere
    const sphereGeo = new THREE.SphereGeometry(0.06, 32, 32);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: 0xdddddd,
      roughness: 0.3,
      metalness: 0.2,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    // Start it near the anchor
    sphere.position.set(0.35, 0, 0.15);

    surfaceFloaters.push(new SurfaceFloater(sphere, {
      heightOffset: 0.065, // Increased so the ball's bottom touches water, instead of its center
      buoyancy: 0.08,      // Increased even more so it bobs to the surface faster
      damping: 0.85,       // Slightly less vertical drag so it can bounce back up
      tiltAmount: 0.3,
      spinSpeed: 0.01,
      // Float around here (bottom right quadrant-ish)
      anchorX: 0.35,
      anchorZ: 0.15
    }));
  }

  createSurfaceFloaters();