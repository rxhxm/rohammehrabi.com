const canvas = document.getElementById('canvas');

// Set canvas to full window size
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const width = canvas.width;
const height = canvas.height;

// Colors
const black = new THREE.Color('black');
const white = new THREE.Color('white');

function loadFile(filename) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.FileLoader();
    const path = filename.startsWith('/') ? filename : '/' + filename;
    loader.load(path, (data) => {
      resolve(data);
    });
  });
}

// Shader chunks
loadFile('shaders/utils.glsl').then((utils) => {
  THREE.ShaderChunk['utils'] = utils;

  // Camera looking down from above, FOV adapts to aspect ratio so the
  // pool always fills the viewport (prevents seeing beyond the pool on ultrawides).
  const cameraHeight = 1.2;
  const poolExtent = 1.0;
  const baseFOV = 50;

  function computeFOV(aspect, h) {
    h = h || cameraHeight;
    var maxFOV = 2 * Math.atan(poolExtent / (h * aspect)) * (180 / Math.PI);
    return Math.min(baseFOV, Math.max(maxFOV, 20));
  }

  const camera = new THREE.PerspectiveCamera(computeFOV(width / height), width / height, 0.01, 100);
  camera.position.set(0, cameraHeight, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({canvas: canvas, antialias: true, alpha: true});
  renderer.setSize(width, height);
  renderer.autoClear = false;

  // Light direction
  const light = [0.7559289460184544, 0.7559289460184544, -0.3779644730092272];

  // Camera is locked - controls created but fully disabled
  const controls = new THREE.TrackballControls(camera, canvas);
  controls.screen.width = width;
  controls.screen.height = height;
  controls.enabled = false;
  controls.noRotate = true;
  controls.noZoom = true;
  controls.noPan = true;

  // Ray caster
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const targetgeometry = new THREE.PlaneGeometry(2, 2);
  for (let vertex of targetgeometry.vertices) {
    vertex.z = - vertex.y;
    vertex.y = 0.;
  }
  const targetmesh = new THREE.Mesh(targetgeometry);

  // Textures
  const cubetextureloader = new THREE.CubeTextureLoader();

  const textureCube = cubetextureloader.load([
    '/xpos.jpg', '/xneg.jpg',
    '/ypos.jpg', '/ypos.jpg',
    '/zpos.jpg', '/zneg.jpg',
  ]);

  const textureloader = new THREE.TextureLoader();

  const tiles = textureloader.load('/tiles.jpg');

  class WaterSimulation {

    constructor() {
      this._camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 2000);

      this._geometry = new THREE.PlaneBufferGeometry(2, 2);

      this._textureA = new THREE.WebGLRenderTarget(256, 256, {type: THREE.FloatType});
      this._textureB = new THREE.WebGLRenderTarget(256, 256, {type: THREE.FloatType});
      this.texture = this._textureA;

      const shadersPromises = [
        loadFile('shaders/simulation/vertex.glsl'),
        loadFile('shaders/simulation/drop_fragment.glsl'),
        loadFile('shaders/simulation/normal_fragment.glsl'),
        loadFile('shaders/simulation/update_fragment.glsl'),
      ];

      this.loaded = Promise.all(shadersPromises)
          .then(([vertexShader, dropFragmentShader, normalFragmentShader, updateFragmentShader]) => {
        const dropMaterial = new THREE.RawShaderMaterial({
          uniforms: {
              center: { value: [0, 0] },
              radius: { value: 0 },
              strength: { value: 0 },
              texture: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: dropFragmentShader,
        });

        const normalMaterial = new THREE.RawShaderMaterial({
          uniforms: {
              delta: { value: [1 / 256, 1 / 256] },  // TODO: Remove this useless uniform and hardcode it in shaders?
              texture: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: normalFragmentShader,
        });

        const updateMaterial = new THREE.RawShaderMaterial({
          uniforms: {
              delta: { value: [1 / 256, 1 / 256] },
              texture: { value: null },
              damping: { value: 0.995 },
              speed: { value: 2.0 },
          },
          vertexShader: vertexShader,
          fragmentShader: updateFragmentShader,
        });

        this._dropMesh = new THREE.Mesh(this._geometry, dropMaterial);
        this._normalMesh = new THREE.Mesh(this._geometry, normalMaterial);
        this._updateMesh = new THREE.Mesh(this._geometry, updateMaterial);
      });
    }

    // Add a drop of water at the (x, y) coordinate (in the range [-1, 1])
    addDrop(renderer, x, y, radius, strength) {
      this._dropMesh.material.uniforms['center'].value = [x, y];
      this._dropMesh.material.uniforms['radius'].value = radius;
      this._dropMesh.material.uniforms['strength'].value = strength;

      this._render(renderer, this._dropMesh);
    }

    stepSimulation(renderer) {
      this._render(renderer, this._updateMesh);
    }

    updateNormals(renderer) {
      this._render(renderer, this._normalMesh);
    }

    set damping(val) { this._updateMesh.material.uniforms['damping'].value = val; }
    get damping() { return this._updateMesh.material.uniforms['damping'].value; }

    set speed(val) { this._updateMesh.material.uniforms['speed'].value = val; }
    get speed() { return this._updateMesh.material.uniforms['speed'].value; }

    _render(renderer, mesh) {
      const oldTexture = this.texture;
      const newTexture = this.texture === this._textureA ? this._textureB : this._textureA;

      mesh.material.uniforms['texture'].value = oldTexture.texture;

      renderer.setRenderTarget(newTexture);

      renderer.render(mesh, this._camera);

      this.texture = newTexture;
    }

  }


  class Caustics {

    constructor(lightFrontGeometry) {
      this._camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 2000);

      this._geometry = lightFrontGeometry;

      this.texture = new THREE.WebGLRenderTarget(1024, 1024, {type: THREE.UNSIGNED_BYTE});

      const shadersPromises = [
        loadFile('shaders/caustics/vertex.glsl'),
        loadFile('shaders/caustics/fragment.glsl')
      ];

      this.loaded = Promise.all(shadersPromises)
          .then(([vertexShader, fragmentShader]) => {
        const material = new THREE.RawShaderMaterial({
          uniforms: {
              light: { value: light },
              water: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: fragmentShader,
        });

        this._causticMesh = new THREE.Mesh(this._geometry, material);
      });
    }

    update(renderer, waterTexture) {
      this._causticMesh.material.uniforms['water'].value = waterTexture;

      renderer.setRenderTarget(this.texture);
      renderer.setClearColor(black, 0);
      renderer.clear();

      // TODO Camera is useless here, what should be done?
      renderer.render(this._causticMesh, this._camera);
    }

  }


  class Water {

    constructor() {
      this.geometry = new THREE.PlaneBufferGeometry(2, 2, 200, 200);

      const shadersPromises = [
        loadFile('shaders/water/vertex.glsl'),
        loadFile('shaders/water/fragment.glsl')
      ];

      this.loaded = Promise.all(shadersPromises)
          .then(([vertexShader, fragmentShader]) => {
        this.material = new THREE.RawShaderMaterial({
          uniforms: {
              light: { value: light },
              tiles: { value: tiles },
              sky: { value: textureCube },
              water: { value: null },
              causticTex: { value: null },
              underwater: { value: false },
          },
          vertexShader: vertexShader,
          fragmentShader: fragmentShader,
        });

        this.mesh = new THREE.Mesh(this.geometry, this.material);
      });
    }

    draw(renderer, waterTexture, causticsTexture) {
      this.material.uniforms['water'].value = waterTexture;
      this.material.uniforms['causticTex'].value = causticsTexture;

      this.material.side = THREE.FrontSide;
      this.material.uniforms['underwater'].value = true;
      renderer.render(this.mesh, camera);

      this.material.side = THREE.BackSide;
      this.material.uniforms['underwater'].value = false;
      renderer.render(this.mesh, camera);
    }

  }


  class Pool {

    constructor() {
      this._geometry = new THREE.BufferGeometry();
      const vertices = new Float32Array([
        -1, -1, -1,
        -1, -1, 1,
        -1, 1, -1,
        -1, 1, 1,
        1, -1, -1,
        1, 1, -1,
        1, -1, 1,
        1, 1, 1,
        -1, -1, -1,
        1, -1, -1,
        -1, -1, 1,
        1, -1, 1,
        -1, 1, -1,
        -1, 1, 1,
        1, 1, -1,
        1, 1, 1,
        -1, -1, -1,
        -1, 1, -1,
        1, -1, -1,
        1, 1, -1,
        -1, -1, 1,
        1, -1, 1,
        -1, 1, 1,
        1, 1, 1
      ]);
      const indices = new Uint32Array([
        0, 1, 2,
        2, 1, 3,
        4, 5, 6,
        6, 5, 7,
        12, 13, 14,
        14, 13, 15,
        16, 17, 18,
        18, 17, 19,
        20, 21, 22,
        22, 21, 23
      ]);

      this._geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      this._geometry.setIndex(new THREE.BufferAttribute(indices, 1));

      const shadersPromises = [
        loadFile('shaders/pool/vertex.glsl'),
        loadFile('shaders/pool/fragment.glsl')
      ];

      this.loaded = Promise.all(shadersPromises)
          .then(([vertexShader, fragmentShader]) => {
        this._material = new THREE.RawShaderMaterial({
          uniforms: {
              light: { value: light },
              tiles: { value: tiles },
              water: { value: null },
              causticTex: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: fragmentShader,
        });
        this._material.side = THREE.FrontSide;

        this._mesh = new THREE.Mesh(this._geometry, this._material);
      });
    }

    draw(renderer, waterTexture, causticsTexture) {
      this._material.uniforms['water'].value = waterTexture;
      this._material.uniforms['causticTex'].value = causticsTexture;

      renderer.render(this._mesh, camera);
    }

  }


  class Debug {

    constructor() {
      this._camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 1);
      this._geometry = new THREE.PlaneBufferGeometry();

      const shadersPromises = [
        loadFile('shaders/debug/vertex.glsl'),
        loadFile('shaders/debug/fragment.glsl')
      ];

      this.loaded = Promise.all(shadersPromises)
          .then(([vertexShader, fragmentShader]) => {
        this._material = new THREE.RawShaderMaterial({
          uniforms: {
              texture: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: fragmentShader,
        });

        this._mesh = new THREE.Mesh(this._geometry, this._material);
      });
    }

    draw(renderer, texture) {
      this._material.uniforms['texture'].value = texture;

      renderer.setRenderTarget(null);
      renderer.render(this._mesh, this._camera);
    }

  }

  const waterSimulation = new WaterSimulation();
  const water = new Water();
  const caustics = new Caustics(water.geometry);
  const pool = new Pool();

  const debug = new Debug();

  // ============================================
  // FLOATING 3D OBJECTS IN THE POOL (REMOVED)
  // Saved in ball_context_reference.js for future reference
  // ============================================

  // Tunable parameters (driven by GUI)
  const params = {
    dropFrequency: 0.02,
    dropRadius: 0.03,
    dropStrength: 0.01,
    mouseRadius: 0.03,
    mouseStrength: 0.04,
    waveSpeed: 2.0,
    damping: 0.995,
    cameraHeight: cameraHeight,
    simStepsPerFrame: 1,
  };

  // Animation time tracker
  let animationTime = 0;

  // Main rendering loop
  function animate() {
    animationTime += 0.016;

    waterSimulation.speed = params.waveSpeed;
    waterSimulation.damping = params.damping;

    if (Math.random() < params.dropFrequency) {
      waterSimulation.addDrop(
        renderer,
        Math.random() * 2 - 1, Math.random() * 2 - 1,
        params.dropRadius, (Math.random() > 0.5) ? params.dropStrength : -params.dropStrength
      );
    }

    for (var s = 0; s < params.simStepsPerFrame; s++) {
      waterSimulation.stepSimulation(renderer);
    }
    waterSimulation.updateNormals(renderer);

    const waterTexture = waterSimulation.texture.texture;
    caustics.update(renderer, waterTexture);
    const causticsTexture = caustics.texture.texture;

    // Read water heights from GPU for surface floaters (REMOVED)
    // readWaterHeights();

    // Update floaters physics (REMOVED)
    // for (let floater of surfaceFloaters) {
    //   floater.update(animationTime);
    // }

    renderer.setRenderTarget(null);
    renderer.setClearColor(black, 1);
    renderer.clear();

    pool.draw(renderer, waterTexture, causticsTexture);
    water.draw(renderer, waterTexture, causticsTexture);

    // Draw the 3D objects over the water (REMOVED)
    // renderer.render(objectsScene, camera);

    window.requestAnimationFrame(animate);
  }

  function onMouseMove(event) {
    const rect = canvas.getBoundingClientRect();

    mouse.x = (event.clientX - rect.left) * 2 / width - 1;
    mouse.y = - (event.clientY - rect.top) * 2 / height + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObject(targetmesh);

    for (let intersect of intersects) {
      waterSimulation.addDrop(renderer, intersect.point.x, intersect.point.z, params.mouseRadius, params.mouseStrength);
    }
  }

  function onTouchMove(event) {
    if (event.cancelable) event.preventDefault();
    const touches = event.touches && event.touches.length ? event.touches : event.changedTouches;
    if (!touches || !touches.length) return;
    const rect = canvas.getBoundingClientRect();

    for (let i = 0; i < touches.length; i++) {
      const t = touches[i];
      mouse.x = (t.clientX - rect.left) * 2 / rect.width - 1;
      mouse.y = - (t.clientY - rect.top) * 2 / rect.height + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(targetmesh);
      for (let intersect of intersects) {
        waterSimulation.addDrop(renderer, intersect.point.x, intersect.point.z, params.mouseRadius, params.mouseStrength);
      }
    }
  }

  const loaded = [waterSimulation.loaded, caustics.loaded, water.loaded, pool.loaded, debug.loaded];

  Promise.all(loaded).then(() => {
    canvas.addEventListener('mousemove', { handleEvent: onMouseMove });
    canvas.addEventListener('touchstart', onTouchMove, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });

    for (var i = 0; i < 20; i++) {
      waterSimulation.addDrop(
        renderer,
        Math.random() * 2 - 1, Math.random() * 2 - 1,
        0.03, (i & 1) ? 0.02 : -0.02
      );
    }

    animate();
  });
  
  // Handle window resize
  window.addEventListener('resize', () => {
    const newWidth = window.innerWidth;
    const newHeight = window.innerHeight;
    const newAspect = newWidth / newHeight;

    camera.fov = computeFOV(newAspect, camera.position.y);
    camera.aspect = newAspect;
    camera.updateProjectionMatrix();

    renderer.setSize(newWidth, newHeight);
  });

});
