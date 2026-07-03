# Addendum / Updated Direction: Reflective Black Liquid Cube Reacting to Microphone Sound

## Revised Project Goal

We are building a Three.js + TypeScript project that visualizes **surface alterations of liquid when affected by sound waves or music**.

The visual object should look like a **black reflective cube or block of liquid-like material**. It should feel dense, glossy, and physical, with an environment map reflected on its surface.

The system should read live sound from the **microphone** and deform the liquid surface in a way that approximates how an actual liquid with configurable **viscosity, mass, density, damping, and resonance** would respond to sound pressure waves.

This should be a visually convincing, physically inspired simulation rather than a purely decorative audio visualizer.

---

## Updated Visual Concept

The main object is not just a flat water plane.

It should look like a **cube of black reflective liquid material**:

* A dark glossy cube or rectangular block
* Reflective black material
* Environment map reflections
* The top surface is deformable
* The sides remain mostly solid/contained, like a block of liquid in an invisible or dark container
* The liquid surface reacts to microphone input
* The result should feel like sound waves are physically disturbing a dense viscous liquid

Visual mood:

* Black liquid metal / oil / dense water
* Reflective, premium, cinematic
* Environment highlights visible on deformation
* Not colorful by default
* Suitable for an AI / engineering conference visual
* Minimal, dark, serious, high-end

---

## Rendering Requirements

Use Three.js with:

* `WebGLRenderer`
* `PerspectiveCamera`
* `OrbitControls`
* `Scene`
* `PMREMGenerator`
* Environment map
* Custom shader material for the deforming top surface
* Separate materials for cube sides if needed

The object should have:

1. **Deformable top liquid surface**
2. **Reflective black material**
3. **Environment map reflections**
4. **Fresnel edge reflection**
5. **Specular highlights**
6. **Visible surface normals reacting to deformation**
7. **Optional subtle transparency or subsurface darkness**

The cube can be represented as:

* A box mesh for the sides/base
* A high-resolution plane mesh for the top liquid surface
* The top plane should align perfectly with the cube’s upper face

Suggested dimensions:

```ts id="a3kq7h"
const LIQUID_SIZE = 6;
const LIQUID_HEIGHT = 2;

const topSurface = new THREE.PlaneGeometry(
  LIQUID_SIZE,
  LIQUID_SIZE,
  256,
  256
);

const containerBody = new THREE.BoxGeometry(
  LIQUID_SIZE,
  LIQUID_HEIGHT,
  LIQUID_SIZE
);
```

The top surface should be positioned at the upper face of the cube.

---

## Material Direction

The material should look like black reflective liquid.

Use:

```ts id="l1s7xv"
const materialSettings = {
  baseColor: new THREE.Color("#020202"),
  roughness: 0.08,
  metalness: 0.2,
  reflectivity: 1.0,
  envMapIntensity: 1.5,
  fresnelPower: 3.0
};
```

The surface should not look like blue water. It should look closer to:

* Black oil
* Liquid obsidian
* Liquid metal
* Dense dark fluid
* Reflective acoustic membrane

---

## Microphone-First Audio Input

The primary input should be the microphone.

The app should request microphone permission and use live audio to drive the simulation.

Required UI:

```html id="bc2y32"
<div class="ui">
  <button id="micButton">Use Microphone</button>
  <button id="pauseButton">Pause Simulation</button>
</div>
```

Optional local audio-file loading can remain as a secondary feature, but microphone input is the main requirement.

---

## Physically Inspired Liquid Deformation

The surface should not be driven only by raw sine waves.

Implement a simplified physical model based on a damped liquid surface heightfield.

The surface can be represented as a heightfield:

```ts id="hbbvjk"
height[x, y]
velocity[x, y]
```

Each frame, update the surface using a damped wave equation approximation:

```txt id="svympt"
acceleration =
  waveSpeed² * laplacian(height)
  - damping * velocity
  + externalAudioForce
  - restoringForce * height

velocity += acceleration * deltaTime
height += velocity * deltaTime
```

This approximates how a liquid surface responds to pressure, inertia, viscosity, and resonance.

---

## Liquid Physical Parameters

Expose liquid parameters in the GUI:

```ts id="usfif9"
const liquidPhysics = {
  density: 1.0,
  viscosity: 0.35,
  mass: 1.0,
  surfaceTension: 0.5,
  damping: 0.08,
  waveSpeed: 1.0,
  restoringForce: 0.7,
  resonanceStrength: 1.0,
  audioForceStrength: 1.0
};
```

Parameter meaning:

* `density` affects how heavy the liquid feels
* `mass` affects inertia and response delay
* `viscosity` increases damping and smooths fast deformation
* `surfaceTension` helps restore fine ripples
* `damping` controls energy loss over time
* `waveSpeed` controls how fast disturbances travel
* `restoringForce` pulls the surface back toward flat
* `resonanceStrength` amplifies frequencies close to natural modes
* `audioForceStrength` controls how strongly microphone sound pushes the surface

The goal is not perfect computational fluid dynamics. The goal is a **credible physical approximation** that feels like a real viscous liquid responding to sound.

---

## Resonance Model

The cube/block should have natural resonance modes.

Implement several standing-wave modes across the square surface:

```glsl id="tlz2gn"
mode =
  sin(n * PI * x / size) *
  sin(m * PI * y / size);
```

Use microphone FFT bands to excite these modes.

Example mapping:

```txt id="3lmt3z"
bass     → low-order standing waves, large slow deformation
lowMid   → container resonance modes
mid      → circular ripples and interference
highMid  → smaller surface detail
treble   → fine shimmer, normal perturbation only
```

The surface should look like it is resonating inside the cube boundaries rather than randomly wobbling.

---

## Audio Force Model

The microphone input should be converted into pressure-like forces.

Create an `AudioAnalyzer` that returns:

```ts id="xvsyp2"
type AudioBands = {
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;
  overall: number;
  beat: number;
};
```

Use these bands as physical excitation:

```ts id="4rwqui"
const audioForce =
  bass * lowModePattern +
  lowMid * resonancePattern +
  mid * ripplePattern +
  beat * impulsePattern;
```

The force should be smoothed before being sent into the simulation.

Avoid direct raw audio jitter.

---

## Simulation Implementation Options

### Preferred Approach: GPU Heightfield Simulation

Use ping-pong render targets:

```txt id="a7v2za"
heightTexturePrevious
heightTextureCurrent
heightTextureNext
```

Each frame:

1. Render a simulation shader into the next height texture
2. Swap textures
3. Use the height texture in the liquid surface vertex shader
4. Use height differences to compute normals

This allows more realistic wave propagation and damping.

### Simpler MVP Approach

If Codex cannot implement GPU ping-pong immediately, use a CPU-side grid simulation:

```ts id="j9pud5"
const size = 128;
const height = new Float32Array(size * size);
const velocity = new Float32Array(size * size);
```

Update the grid each frame, then upload it as a `DataTexture` to the shader.

This is acceptable for MVP if performance remains smooth.

---

## Shader Requirements

The top surface shader should:

1. Sample the simulated heightfield
2. Displace vertices vertically
3. Compute normals from neighboring height samples
4. Apply black reflective material shading
5. Use environment map reflection
6. Add Fresnel highlights
7. Add subtle treble-driven normal shimmer

The deformation should look like real liquid mass moving, not like a music equalizer.

---

## Cube Body Requirements

The cube body should visually support the illusion of a dense material block.

Options:

1. Black glossy box sides with slight transparency
2. Dark solid sides with strong reflections
3. A container-like cube where only the top liquid surface visibly deforms

The top surface should visually blend with the sides so it feels like one object.

Avoid showing a separate floating plane.

---

## Updated Acceptance Criteria

The project is complete when:

1. The app starts as a Three.js + TypeScript Vite project.
2. The scene contains a black reflective cube/block of liquid-like material.
3. The cube uses an environment map or generated environment reflection.
4. The top surface is visibly deformable.
5. The primary audio input is microphone input.
6. Microphone sound affects the surface in real time.
7. Bass creates large, slow, heavy deformation.
8. Mids create resonance and visible wave interference.
9. Treble creates fine shimmer mostly through normal perturbation.
10. Beats or loud impulses create stronger surface disturbances.
11. The surface motion has inertia, damping, and delayed response.
12. GUI controls expose viscosity, mass, damping, wave speed, resonance, and audio force.
13. The visual result feels like a real viscous liquid responding to sound pressure.
14. The object looks premium, dark, reflective, and cinematic.
15. The implementation avoids purely decorative equalizer-style motion.

---

## Updated Visual Target

The final result should feel like:

```txt id="sa56z0"
A cube of black reflective liquid is sitting in a dark studio.
The environment reflects across its glossy surface.
When music or voice hits the microphone, the top surface starts to resonate.
Bass makes the whole liquid mass breathe and roll.
Mid frequencies create standing wave patterns.
Sharp sounds create fine shimmering disturbances.
The motion is damped, heavy, and physical, as if the liquid has real viscosity and mass.
```

---

## Important Implementation Note

Do not claim the simulation is scientifically exact.

Use the phrase:

```txt id="mtr8a6"
physically inspired real-time heightfield simulation
```

The goal is believable real-time behavior, not full fluid/acoustic CFD.
