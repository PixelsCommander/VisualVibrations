import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

type AudioBands = {
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;
  treblePeak: number;
  overall: number;
  beat: number;
};

type LiquidPhysics = {
  density: number;
  viscosity: number;
  mass: number;
  surfaceTension: number;
  damping: number;
  waveSpeed: number;
  restoringForce: number;
  resonanceStrength: number;
  audioForceStrength: number;
  speakerRadius: number;
  speakerForce: number;
  radialRippleStrength: number;
  dropletLift: number;
};

type PointerRipple = {
  active: boolean;
  uv: THREE.Vector2;
  velocity: number;
};

const LIQUID_SIZE = 6;
const LIQUID_HEIGHT = 2;
const GRID_SIZE = 128;
const TOP_SEGMENTS = 256;
const HALF_SIZE = LIQUID_SIZE * 0.5;
const MICROPHONE_RUMBLE_CUTOFF_HZ = 58;
const THREEJS_ENVIRONMENTS = {
  spruit: {
    label: "Spruit Sunrise",
    path: "/env/threejs/spruit_sunrise_1k.hdr",
  },
  venice: {
    label: "Venice Sunset",
    path: "/env/threejs/venice_sunset_1k.hdr",
  },
  blouberg: {
    label: "Blouberg Sunrise",
    path: "/env/threejs/blouberg_sunrise_2_1k.hdr",
  },
  overpass: {
    label: "Pedestrian Overpass",
    path: "/env/threejs/pedestrian_overpass_1k.hdr",
  },
} as const;

type EnvironmentKey = keyof typeof THREEJS_ENVIRONMENTS;

function fract(value: number): number {
  return value - Math.floor(value);
}

const liquidPhysics: LiquidPhysics = {
  density: 1.0,
  viscosity: 0.35,
  mass: 1.0,
  surfaceTension: 0.5,
  damping: 0.08,
  waveSpeed: 1.7,
  restoringForce: 0.7,
  resonanceStrength: 1.65,
  audioForceStrength: 1.85,
  speakerRadius: 0.34,
  speakerForce: 2.35,
  radialRippleStrength: 4.75,
  dropletLift: 1.25,
};

const silentBands: AudioBands = {
  bass: 0,
  lowMid: 0,
  mid: 0,
  highMid: 0,
  treble: 0,
  treblePeak: 0,
  overall: 0,
  beat: 0,
};

class AudioAnalyzer {
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private frequencyData?: Uint8Array<ArrayBuffer>;
  private previousOverall = 0;
  private previousLowMid = 0;
  private previousMid = 0;
  private previousHighMid = 0;
  private previousTreble = 0;
  private smoothed: AudioBands = { ...silentBands };
  private bassNoiseFloor = 0;
  private calibrated = false;
  private calibrationFrames = 0;

  async startMicrophone(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    source.connect(this.analyser);
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  update(): AudioBands {
    if (!this.analyser || !this.frequencyData || !this.audioContext) {
      return this.smoothed;
    }

    this.analyser.getByteFrequencyData(this.frequencyData);

    const sampleRate = this.audioContext.sampleRate;
    const nyquist = sampleRate * 0.5;
    const binHz = nyquist / this.frequencyData.length;
    const measured: AudioBands = {
      bass: this.averageRange(45, 190, binHz),
      lowMid: this.averageRange(190, 400, binHz),
      mid: this.averageRange(400, 1600, binHz),
      highMid: this.averageRange(1600, 4200, binHz),
      treble: this.averageRange(4200, 12000, binHz),
      treblePeak: 0,
      overall: 0,
      beat: 0,
    };

    this.updateBassNoiseFloor(measured.bass);

    const raw: AudioBands = {
      bass: this.gateBand(measured.bass, this.bassNoiseFloor, 0.014, 5.2),
      lowMid: 0,
      mid: 0,
      highMid: 0,
      treble: THREE.MathUtils.clamp(measured.treble * 5.6, 0, 1),
      treblePeak: 0,
      overall: 0,
      beat: 0,
    };

    raw.lowMid = this.peakGate(measured.lowMid, "lowMid", 2.7);
    raw.mid = this.peakGate(measured.mid, "mid", 2.6);
    raw.highMid = this.peakGate(measured.highMid, "highMid", 2.4);
    raw.treblePeak = THREE.MathUtils.clamp(Math.max(0, raw.treble - this.previousTreble * 0.96) * 6.5, 0, 1);
    this.previousTreble = this.previousTreble * 0.8 + raw.treble * 0.2;
    raw.overall =
      raw.bass * 0.36 +
      raw.lowMid * 0.22 +
      raw.mid * 0.2 +
      raw.highMid * 0.12 +
      raw.treble * 0.1;
    raw.beat = Math.max(0, raw.overall - this.previousOverall * 1.18);
    this.previousOverall = this.previousOverall * 0.92 + raw.overall * 0.08;

    const smoothing = 0.16;
    for (const key of Object.keys(this.smoothed) as Array<keyof AudioBands>) {
      if (key === "treblePeak") {
        this.smoothed.treblePeak = Math.max(raw.treblePeak, this.smoothed.treblePeak * 0.72);
        continue;
      }
      this.smoothed[key] += (raw[key] - this.smoothed[key]) * smoothing;
    }

    return this.smoothed;
  }

  private updateBassNoiseFloor(measuredBass: number): void {
    this.calibrationFrames += 1;
    const learningRate = this.calibrated ? 0.006 : 0.08;
    const target = Math.min(measuredBass, this.bassNoiseFloor + 0.025);
    this.bassNoiseFloor += (target - this.bassNoiseFloor) * learningRate;

    if (this.calibrationFrames > 90) {
      this.calibrated = true;
    }
  }

  private gateBand(value: number, floor: number, threshold: number, gain: number): number {
    const cleaned = Math.max(0, value - floor - threshold);
    const normalized = cleaned / Math.max(0.08, 1 - floor - threshold);
    return Math.pow(THREE.MathUtils.clamp(normalized * gain, 0, 1), 1.28);
  }

  private peakGate(value: number, band: "lowMid" | "mid" | "highMid", gain: number): number {
    const previousKey =
      band === "lowMid" ? "previousLowMid" : band === "mid" ? "previousMid" : "previousHighMid";
    const previous = this[previousKey];
    const peak = Math.max(0, value - previous * 1.06);
    this[previousKey] = previous * 0.88 + value * 0.12;
    return THREE.MathUtils.clamp(Math.pow(peak * gain * 5.5, 0.82), 0, 1);
  }

  private averageRange(minHz: number, maxHz: number, binHz: number): number {
    if (!this.frequencyData) {
      return 0;
    }

    const start = Math.max(0, Math.floor(minHz / binHz));
    const end = Math.min(this.frequencyData.length - 1, Math.ceil(maxHz / binHz));
    let total = 0;
    let count = 0;

    for (let i = start; i <= end; i += 1) {
      total += this.frequencyData[i] / 255;
      count += 1;
    }

    return count > 0 ? total / count : 0;
  }
}

class LiquidHeightfield {
  readonly texture: THREE.DataTexture;
  private readonly heights = new Float32Array(GRID_SIZE * GRID_SIZE);
  private readonly velocities = new Float32Array(GRID_SIZE * GRID_SIZE);
  private readonly nextHeights = new Float32Array(GRID_SIZE * GRID_SIZE);
  private readonly textureData = new Float32Array(GRID_SIZE * GRID_SIZE);
  private readonly dropletWaveSeeds = Array.from({ length: 56 }, (_, index) => ({
    x: fract(Math.sin((index + 1) * 12.9898) * 43758.5453),
    y: fract(Math.sin((index + 1) * 78.233) * 24634.6345),
    phase: fract(Math.sin((index + 1) * 39.425) * 13517.271),
  }));
  private phase = 0;

  constructor() {
    this.texture = new THREE.DataTexture(
      this.textureData,
      GRID_SIZE,
      GRID_SIZE,
      THREE.RedFormat,
      THREE.FloatType,
    );
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  update(deltaTime: number, bands: AudioBands, physics: LiquidPhysics, pointerRipple: PointerRipple): void {
    const dt = Math.min(deltaTime, 1 / 30);
    this.phase += dt;
    const gridStep = LIQUID_SIZE / (GRID_SIZE - 1);
    const invStepSq = 1 / (gridStep * gridStep);
    const viscosityDamping = physics.damping + physics.viscosity * 0.42;
    const mass = Math.max(0.1, physics.mass * physics.density);
    const forceScale = physics.audioForceStrength * 1.45;

    for (let y = 1; y < GRID_SIZE - 1; y += 1) {
      for (let x = 1; x < GRID_SIZE - 1; x += 1) {
        const i = y * GRID_SIZE + x;
        const h = this.heights[i];
        const laplacian =
          (this.heights[i - 1] +
            this.heights[i + 1] +
            this.heights[i - GRID_SIZE] +
            this.heights[i + GRID_SIZE] -
            h * 4) *
          invStepSq;

        const sample = this.sampleSurfacePoint(x, y);
        const audioForce =
          (this.centerSpeakerForce(sample, bands, physics) +
            this.radialRippleForce(sample, bands, physics) +
            this.boundaryResonanceForce(sample, bands, physics) +
            this.pointerRippleForce(sample, pointerRipple)) *
          forceScale;

        const acceleration =
          (physics.waveSpeed * physics.waveSpeed * laplacian +
            audioForce -
            physics.restoringForce * h -
            viscosityDamping * this.velocities[i]) /
          mass;

        this.velocities[i] = THREE.MathUtils.clamp(this.velocities[i] + acceleration * dt, -1.6, 1.6);
        this.nextHeights[i] = h + this.velocities[i] * dt;
      }
    }

    this.applyBoundaryContainment();
    this.applySurfaceTension(physics.surfaceTension, dt);
    this.injectFinePeakWaves(bands, physics, dt);

    for (let i = 0; i < this.heights.length; i += 1) {
      const height = Math.tanh(this.nextHeights[i] / 0.65) * 0.65;
      this.heights[i] = height;
      this.textureData[i] = height;
    }

    this.texture.needsUpdate = true;
  }

  private sampleSurfacePoint(x: number, y: number): {
    nx: number;
    ny: number;
    radius: number;
    edgeFalloff: number;
  } {
    const nx = x / (GRID_SIZE - 1);
    const ny = y / (GRID_SIZE - 1);
    const centeredX = nx - 0.5;
    const centeredY = ny - 0.5;
    const radius = Math.hypot(centeredX, centeredY);
    const edgeDistance = Math.min(nx, ny, 1 - nx, 1 - ny);
    const edgeFalloff = THREE.MathUtils.smoothstep(edgeDistance, 0.02, 0.16);

    return { nx, ny, radius, edgeFalloff };
  }

  private centerSpeakerForce(
    sample: { radius: number; edgeFalloff: number },
    bands: AudioBands,
    physics: LiquidPhysics,
  ): number {
    const radius = Math.max(0.08, physics.speakerRadius);
    const speakerBell = Math.exp(-(sample.radius * sample.radius) / (radius * radius));
    const heavyPressure = bands.bass * 1.18 + bands.beat * 1.85;
    const pressurePhase = Math.sin(this.phase * (8.0 + bands.bass * 6.0));
    return speakerBell * heavyPressure * pressurePhase * physics.speakerForce * sample.edgeFalloff;
  }

  private radialRippleForce(
    sample: { radius: number; edgeFalloff: number },
    bands: AudioBands,
    physics: LiquidPhysics,
  ): number {
    const firstRing = Math.sin(sample.radius * 32 - this.phase * 7.0) * bands.lowMid * 0.8;
    const tightRings = Math.sin(sample.radius * 58 - this.phase * 11.5) * bands.mid * 0.56;
    const fineRings = Math.sin(sample.radius * 84 - this.phase * 16.0) * bands.highMid * 0.26;
    const distanceFade = Math.exp(-sample.radius * 1.1);
    return (
      (firstRing + tightRings + fineRings) *
      distanceFade *
      physics.radialRippleStrength *
      physics.resonanceStrength *
      sample.edgeFalloff
    );
  }

  private boundaryResonanceForce(
    sample: { nx: number; ny: number; edgeFalloff: number },
    bands: AudioBands,
    physics: LiquidPhysics,
  ): number {
    const lowStandingMode = Math.sin(Math.PI * sample.nx) * Math.sin(Math.PI * sample.ny);
    const crossMode = Math.sin(2 * Math.PI * sample.nx) * Math.sin(Math.PI * sample.ny);
    return (
      (bands.bass * lowStandingMode * 0.12 + bands.lowMid * crossMode * 0.08) *
      physics.resonanceStrength *
      0.28 *
      sample.edgeFalloff
    );
  }

  private pointerRippleForce(
    sample: { nx: number; ny: number; edgeFalloff: number },
    pointerRipple: PointerRipple,
  ): number {
    if (!pointerRipple.active || pointerRipple.velocity <= 0.001) {
      return 0;
    }

    const dx = sample.nx - pointerRipple.uv.x;
    const dy = sample.ny - pointerRipple.uv.y;
    const distance = Math.hypot(dx, dy);
    const displacement = Math.exp(-(distance * distance) / 0.0045);
    const ring = Math.sin(distance * 92 - this.phase * 16) * Math.exp(-distance * 10);
    return (displacement * -3.4 + ring * 1.05) * pointerRipple.velocity * sample.edgeFalloff;
  }

  private applyBoundaryContainment(): void {
    const edgeDamping = 0.72;
    for (let i = 0; i < GRID_SIZE; i += 1) {
      this.nextHeights[i] = 0;
      this.nextHeights[(GRID_SIZE - 1) * GRID_SIZE + i] = 0;
      this.nextHeights[i * GRID_SIZE] = 0;
      this.nextHeights[i * GRID_SIZE + GRID_SIZE - 1] = 0;
      this.velocities[i] *= edgeDamping;
      this.velocities[(GRID_SIZE - 1) * GRID_SIZE + i] *= edgeDamping;
      this.velocities[i * GRID_SIZE] *= edgeDamping;
      this.velocities[i * GRID_SIZE + GRID_SIZE - 1] *= edgeDamping;
    }
  }

  private applySurfaceTension(surfaceTension: number, deltaTime: number): void {
    const blend = THREE.MathUtils.clamp(surfaceTension * deltaTime * 0.08, 0, 0.12);

    for (let y = 1; y < GRID_SIZE - 1; y += 1) {
      for (let x = 1; x < GRID_SIZE - 1; x += 1) {
        const i = y * GRID_SIZE + x;
        const smoothed =
          (this.nextHeights[i] * 4 +
            this.nextHeights[i - 1] +
            this.nextHeights[i + 1] +
            this.nextHeights[i - GRID_SIZE] +
            this.nextHeights[i + GRID_SIZE]) /
          8;
        this.nextHeights[i] = THREE.MathUtils.lerp(this.nextHeights[i], smoothed, blend);
      }
    }
  }

  private injectFinePeakWaves(bands: AudioBands, physics: LiquidPhysics, deltaTime: number): void {
    if (bands.treblePeak < 0.012 || physics.dropletLift <= 0) {
      return;
    }

    const chance = THREE.MathUtils.clamp(physics.dropletLift / 4, 0, 1);
    const strength = THREE.MathUtils.smoothstep(bands.treblePeak, 0.012, 0.22) * deltaTime * 3.2;

    for (const seed of this.dropletWaveSeeds) {
      const pulseCycle = fract(this.phase * (2.2 + seed.phase * 5.5) + seed.phase);
      const allowed = seed.phase < chance;
      if (!allowed || pulseCycle > 0.22) {
        continue;
      }

      const centerX = Math.round(seed.x * (GRID_SIZE - 1));
      const centerY = Math.round(seed.y * (GRID_SIZE - 1));
      if (centerX < 4 || centerX > GRID_SIZE - 5 || centerY < 4 || centerY > GRID_SIZE - 5) {
        continue;
      }

      const pulse = Math.pow(1 - pulseCycle / 0.22, 2.2);
      for (let oy = -3; oy <= 3; oy += 1) {
        for (let ox = -3; ox <= 3; ox += 1) {
          const distance = Math.hypot(ox, oy);
          const peak = Math.exp(-distance * distance * 0.72);
          const ring = Math.sin(distance * 3.9) * Math.exp(-distance * 0.7);
          const index = (centerY + oy) * GRID_SIZE + centerX + ox;
          const impulse = (peak * 1.35 - ring * 0.42) * pulse * strength;
          this.nextHeights[index] += impulse * 0.32;
          this.velocities[index] = THREE.MathUtils.clamp(this.velocities[index] + impulse * 1.8, -1.6, 1.6);
        }
      }
    }
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#scene");
if (!canvas) {
  throw new Error("Scene canvas was not found");
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 12.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#07090b");

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 80);
camera.position.set(-3.329, 2.661, 3.005);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.45, 0);
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 5;
controls.maxDistance = 14;

let lastCameraLog = 0;
controls.addEventListener("change", () => {
  const now = performance.now();
  if (now - lastCameraLog < 350) {
    return;
  }

  lastCameraLog = now;
  console.log("camera", {
    position: {
      x: Number(camera.position.x.toFixed(3)),
      y: Number(camera.position.y.toFixed(3)),
      z: Number(camera.position.z.toFixed(3)),
    },
    target: {
      x: Number(controls.target.x.toFixed(3)),
      y: Number(controls.target.y.toFixed(3)),
      z: Number(controls.target.z.toFixed(3)),
    },
  });
});

const pmrem = new THREE.PMREMGenerator(renderer);
const environmentScene = new THREE.Scene();
environmentScene.add(
  new THREE.Mesh(
    new THREE.SphereGeometry(18, 32, 16),
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      color: "#111418",
    }),
  ),
);

const studioBars = [
  { position: [-8, 6, -7], scale: [0.18, 5.0, 10.0], color: "#ffffff" },
  { position: [8, 4, -4], scale: [0.22, 3.2, 9.0], color: "#d9e1e8" },
  { position: [0, 9, 3], scale: [10.0, 0.22, 3.2], color: "#ffffff" },
  { position: [0, 5, 8], scale: [6.5, 2.0, 0.18], color: "#cfd8e3" },
] as const;

for (const bar of studioBars) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: bar.color }),
  );
  mesh.position.set(bar.position[0], bar.position[1], bar.position[2]);
  mesh.scale.set(bar.scale[0], bar.scale[1], bar.scale[2]);
  environmentScene.add(mesh);
}

const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
  type: THREE.HalfFloatType,
  generateMipmaps: true,
  minFilter: THREE.LinearMipmapLinearFilter,
});
const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeRenderTarget);
cubeCamera.update(renderer, environmentScene);
const reflectionCubeMap = cubeRenderTarget.texture;
const environmentMap = pmrem.fromCubemap(reflectionCubeMap).texture;
scene.environment = environmentMap;

const environmentSphereMaterial = new THREE.MeshBasicMaterial({
  color: "#111418",
  side: THREE.BackSide,
});
const environmentSphere = new THREE.Mesh(new THREE.SphereGeometry(32, 96, 48), environmentSphereMaterial);
scene.add(environmentSphere);

const heightfield = new LiquidHeightfield();

const liquidUniforms = {
  uHeightMap: { value: heightfield.texture },
  uEnvMap: { value: reflectionCubeMap },
  uSize: { value: LIQUID_SIZE },
  uGridSize: { value: GRID_SIZE },
  uBaseColor: { value: new THREE.Color("#090a0b") },
  uCameraPosition: { value: camera.position },
  uFresnelPower: { value: 3.0 },
  uEnvIntensity: { value: 1.2 },
  uTreble: { value: 0 },
  uDropletLift: { value: liquidPhysics.dropletLift },
  uTime: { value: 0 },
};

const topSurface = new THREE.Mesh(
  new THREE.PlaneGeometry(LIQUID_SIZE, LIQUID_SIZE, TOP_SEGMENTS, TOP_SEGMENTS),
  new THREE.ShaderMaterial({
    uniforms: liquidUniforms,
    vertexShader: `
      precision highp float;
      uniform sampler2D uHeightMap;
      uniform float uSize;
      uniform float uGridSize;
      uniform float uTreble;
      uniform float uDropletLift;
      uniform float uTime;
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying vec2 vUv;

      float sampleHeight(vec2 uv) {
        return texture2D(uHeightMap, clamp(uv, 0.0, 1.0)).r;
      }

      void main() {
        vUv = uv;
        float height = sampleHeight(uv);
        float texel = 1.0 / uGridSize;
        float shimmer = sin((uv.x * 96.0 + uv.y * 71.0) + uTime * 28.0) * uTreble * 0.012;
        height += shimmer;

        vec3 displaced = position + vec3(0.0, 0.0, height);
        float heightL = sampleHeight(uv - vec2(texel, 0.0));
        float heightR = sampleHeight(uv + vec2(texel, 0.0));
        float heightD = sampleHeight(uv - vec2(0.0, texel));
        float heightU = sampleHeight(uv + vec2(0.0, texel));
        float dropletEnergy = uTreble;
        float dropletSlopeX = 0.0;
        float dropletSlopeY = 0.0;
        for (int i = 0; i < 24; i++) {
          float fi = float(i) + 1.0;
          vec2 center = fract(sin(vec2(fi * 12.9898, fi * 78.233)) * vec2(43758.5453, 24634.6345));
          float seed = fract(sin(fi * 39.425) * 13517.271);
          float chance = step(seed, clamp(uDropletLift / 1.0, 0.0, 1.0));
          float cycle = fract(uTime * (1.45 + seed * 4.2) + seed);
          float pulse = pow(max(0.0, 1.0 - cycle * 3.1), 2.0);
          vec2 delta = uv - center;
          float spot = exp(-dot(delta, delta) * 1680.0) * pulse * chance;
          dropletSlopeX += -delta.x * spot;
          dropletSlopeY += -delta.y * spot;
        }
        vec3 tangentX = normalize(vec3(2.0 * texel * uSize, 0.0, heightR - heightL));
        vec3 tangentY = normalize(vec3(0.0, 2.0 * texel * uSize, heightU - heightD));
        vec3 baseNormal = normalize(cross(tangentX, tangentY));
        baseNormal.xy += vec2(dropletSlopeX, dropletSlopeY) * dropletEnergy * 10.0;
        vNormal = normalize(mat3(modelMatrix) * baseNormal);

        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform samplerCube uEnvMap;
      uniform vec3 uBaseColor;
      uniform vec3 uCameraPosition;
      uniform float uFresnelPower;
      uniform float uEnvIntensity;
      uniform float uTreble;
      uniform float uDropletLift;
      uniform float uTime;
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying vec2 vUv;

      void main() {
        vec3 normal = normalize(vNormal);
        float dropletChance = clamp(uDropletLift / 4.0, 0.0, 1.0);
        float dropletEnergy = smoothstep(0.02, 0.16, uTreble);
        float dropletSlopeX = 0.0;
        float dropletSlopeZ = 0.0;
        float dropletMask = 0.0;
        for (int i = 0; i < 36; i++) {
          float fi = float(i) + 1.0;
          vec2 center = fract(sin(vec2(fi * 12.9898, fi * 78.233)) * vec2(43758.5453, 24634.6345));
          float seed = fract(sin(fi * 39.425) * 13517.271);
          float chance = step(seed, dropletChance);
          float cycle = fract(uTime * (1.55 + seed * 4.8) + seed);
          float pulse = pow(max(0.0, 1.0 - cycle * 2.8), 1.85);
          vec2 delta = vUv - center;
          float spot = exp(-dot(delta, delta) * 520.0) * pulse * chance;
          dropletSlopeX += -delta.x * spot;
          dropletSlopeZ += -delta.y * spot;
          dropletMask += spot;
        }
        normal = normalize(normal + vec3(dropletSlopeX, 0.0, dropletSlopeZ) * dropletEnergy * 5.0);
        vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
        vec3 reflected = reflect(-viewDir, normal);
        vec3 env = textureCube(uEnvMap, reflected).rgb;
        float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), uFresnelPower);
        float spec = pow(max(dot(reflect(vec3(-0.35, -0.8, -0.45), normal), viewDir), 0.0), 80.0);
        float dropletSpark = pow(clamp(dropletMask * dropletEnergy, 0.0, 1.0), 1.4);
        float edgeFade = smoothstep(0.48, 0.5, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)));
        vec3 color = uBaseColor + env * (uEnvIntensity * (0.58 + fresnel * 2.25));
        color += vec3(spec * 1.6);
        color += env * dropletSpark * 0.22;
        color += vec3(dropletSpark * 0.04);
        color += vec3(0.028);
        color += vec3(uTreble * 0.04);
        color *= 1.0 - edgeFade * 0.08;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  }),
);
topSurface.rotation.x = -Math.PI * 0.5;
topSurface.position.y = LIQUID_HEIGHT * 0.5;
scene.add(topSurface);

const containerMaterial = new THREE.MeshPhysicalMaterial({
  color: "#070809",
  roughness: 0.08,
  metalness: 0.2,
  reflectivity: 0.5,
  envMapIntensity: 0.6,
  transmission: 0.02,
  transparent: false,
  opacity: 0.86,
  clearcoat: 1,
  clearcoatRoughness: 0.08,
});
const containerBody = new THREE.Group();
const wallThickness = 0.08;
const sideOffset = HALF_SIZE + wallThickness * 0.5;
const sideSpecs = [
  { size: [LIQUID_SIZE, LIQUID_HEIGHT, wallThickness], position: [0, 0, sideOffset] },
  { size: [LIQUID_SIZE, LIQUID_HEIGHT, wallThickness], position: [0, 0, -sideOffset] },
  { size: [wallThickness, LIQUID_HEIGHT, LIQUID_SIZE], position: [sideOffset, 0, 0] },
  { size: [wallThickness, LIQUID_HEIGHT, LIQUID_SIZE], position: [-sideOffset, 0, 0] },
  { size: [LIQUID_SIZE, wallThickness, LIQUID_SIZE], position: [0, -LIQUID_HEIGHT * 0.5, 0] },
] as const;

for (const spec of sideSpecs) {
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(spec.size[0], spec.size[1], spec.size[2]),
    containerMaterial,
  );
  panel.position.set(spec.position[0], spec.position[1], spec.position[2]);
  containerBody.add(panel);
}
scene.add(containerBody);

const bevelLines = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(LIQUID_SIZE, LIQUID_HEIGHT, LIQUID_SIZE)),
  new THREE.LineBasicMaterial({ color: "#24282c", transparent: true, opacity: 0.38 }),
);
scene.add(bevelLines);

const rgbeLoader = new RGBELoader();
let activeHdrTexture: THREE.DataTexture | null = null;
let activeEnvironmentMap: THREE.Texture | null = null;
let activeReflectionCubeMap: THREE.Texture | null = null;

function loadEnvironment(key: EnvironmentKey): void {
  const environment = THREEJS_ENVIRONMENTS[key];

  rgbeLoader.load(environment.path, (hdrTexture) => {
    hdrTexture.mapping = THREE.EquirectangularReflectionMapping;

    const loadedEnvironmentMap = pmrem.fromEquirectangular(hdrTexture).texture;
    const loadedReflectionCubeMap = new THREE.WebGLCubeRenderTarget(512, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    }).fromEquirectangularTexture(renderer, hdrTexture).texture;

    activeHdrTexture?.dispose();
    activeEnvironmentMap?.dispose();
    activeReflectionCubeMap?.dispose();
    activeHdrTexture = hdrTexture;
    activeEnvironmentMap = loadedEnvironmentMap;
    activeReflectionCubeMap = loadedReflectionCubeMap;

    scene.environment = loadedEnvironmentMap;
    scene.background = hdrTexture;
    liquidUniforms.uEnvMap.value = loadedReflectionCubeMap;
    containerMaterial.envMap = loadedEnvironmentMap;
    containerMaterial.needsUpdate = true;
    environmentSphereMaterial.map = hdrTexture;
    environmentSphereMaterial.needsUpdate = true;
  });
}

loadEnvironment("spruit");

scene.add(new THREE.AmbientLight("#ffffff", 1.42));
scene.add(new THREE.HemisphereLight("#f4f7fb", "#202428", 0.95));
const keyLight = new THREE.DirectionalLight("#ffffff", 2.8);
keyLight.position.set(-4, 7, 5);
scene.add(keyLight);

const overheadFill = new THREE.PointLight("#f5f7fa", 4.8, 18, 1.4);
overheadFill.position.set(0, 4.8, 1.2);
scene.add(overheadFill);

const analyzer = new AudioAnalyzer();
let latestBands: AudioBands = { ...silentBands };
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const pointerRipple: PointerRipple = {
  active: false,
  uv: new THREE.Vector2(0.5, 0.5),
  velocity: 0,
};
let lastPointerUv = new THREE.Vector2(0.5, 0.5);
let lastPointerTime = performance.now();

const micButton = document.querySelector<HTMLButtonElement>("#micButton");
const micOverlay = document.querySelector<HTMLElement>("#micOverlay");
const environmentSelect = document.querySelector<HTMLSelectElement>("#environmentSelect");
const controlsPanel = document.querySelector<HTMLElement>("#controlsPanel");
const controlsToggle = document.querySelector<HTMLButtonElement>("#controlsToggle");

micButton?.addEventListener("click", async () => {
  try {
    micButton.disabled = true;
    micButton.textContent = "Listening";
    await analyzer.startMicrophone();
    micOverlay?.classList.add("is-hidden");
  } catch (error) {
    micButton.disabled = false;
    micButton.textContent = "Microphone Blocked";
    console.error(error);
  }
});

controlsToggle?.addEventListener("click", () => {
  const collapsed = controlsPanel?.classList.toggle("is-collapsed") ?? true;
  controlsToggle.setAttribute("aria-expanded", String(!collapsed));
});

environmentSelect?.addEventListener("change", () => {
  loadEnvironment(environmentSelect.value as EnvironmentKey);
});

function updatePointerRipple(clientX: number, clientY: number): void {
  pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
  pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = raycaster.intersectObject(topSurface, false)[0];

  if (!hit?.uv) {
    pointerRipple.active = false;
    return;
  }

  const now = performance.now();
  const elapsed = Math.max(16, now - lastPointerTime) / 1000;
  pointerRipple.uv.copy(hit.uv);
  pointerRipple.velocity = THREE.MathUtils.clamp(hit.uv.distanceTo(lastPointerUv) / elapsed, 0, 4.2);
  pointerRipple.active = true;
  lastPointerUv.copy(hit.uv);
  lastPointerTime = now;
}

renderer.domElement.addEventListener("pointermove", (event) => {
  updatePointerRipple(event.clientX, event.clientY);
});

renderer.domElement.addEventListener("pointerleave", () => {
  pointerRipple.active = false;
});

for (const key of [
  "viscosity",
  "mass",
  "damping",
  "waveSpeed",
  "resonanceStrength",
  "audioForceStrength",
  "speakerRadius",
  "speakerForce",
  "radialRippleStrength",
  "dropletLift",
] as const) {
  const input = document.querySelector<HTMLInputElement>(`#${key}`);
  const valueOutput = document.createElement("output");
  valueOutput.className = "control-value";
  valueOutput.value = Number(input?.value ?? liquidPhysics[key]).toFixed(2);
  input?.insertAdjacentElement("afterend", valueOutput);

  input?.addEventListener("input", () => {
    liquidPhysics[key] = Number(input.value);
    valueOutput.value = liquidPhysics[key].toFixed(2);
    console.log("liquid control", {
      key,
      value: liquidPhysics[key],
      physics: { ...liquidPhysics },
    });
  });
}

const bassMeter = document.querySelector<HTMLElement>("#bassMeter");
const midMeter = document.querySelector<HTMLElement>("#midMeter");
const trebleMeter = document.querySelector<HTMLElement>("#trebleMeter");

function updateMeters(bands: AudioBands): void {
  if (bassMeter) {
    bassMeter.style.width = `${Math.min(100, bands.bass * 230)}%`;
  }
  if (midMeter) {
    midMeter.style.width = `${Math.min(100, bands.mid * 180)}%`;
  }
  if (trebleMeter) {
    trebleMeter.style.width = `${Math.min(100, bands.treble * 230)}%`;
  }
}

function animate(): void {
  requestAnimationFrame(animate);
  const deltaTime = clock.getDelta();
  latestBands = analyzer.update();

  heightfield.update(deltaTime, latestBands, liquidPhysics, pointerRipple);
  pointerRipple.velocity *= Math.exp(-deltaTime * 7.5);
  if (pointerRipple.velocity < 0.002) {
    pointerRipple.active = false;
  }

  liquidUniforms.uTime.value += deltaTime;
  liquidUniforms.uTreble.value = latestBands.treblePeak;
  liquidUniforms.uDropletLift.value = liquidPhysics.dropletLift;
  liquidUniforms.uCameraPosition.value.copy(camera.position);
  topSurface.position.y = LIQUID_HEIGHT * 0.5 + 0.003;
  controls.update();
  updateMeters(latestBands);
  renderer.render(scene, camera);
}

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
animate();
