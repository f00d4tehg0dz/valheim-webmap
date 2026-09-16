// Sky, sun, moon and fog for the 3D view, driven by the game's time of day.
//
// A sky dome (gradient + sun disc + stars) follows the camera; a warm sun and a cool
// hemisphere light track the same position; at night a faint moon takes over. The
// dome is also baked into a small environment map so water and metal catch the sky.
// Day fraction is the game's: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.

import * as THREE from 'three';

const skyVert = `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;   // always at the far plane
}`;

const skyFrag = `
varying vec3 vDir;
uniform vec3 uSun; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunTint; uniform float uNight; uniform float uSunDisc;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.5));
  float sd = max(dot(d, uSun), 0.0);
  col += uSunTint * (pow(sd, 400.0) * uSunDisc + pow(sd, 10.0) * 0.22 + pow(sd, 2.5) * 0.06);
  if (uNight > 0.001) {
    vec3 p = floor(d * 260.0);
    float s = hash(p);
    float star = smoothstep(0.992, 1.0, s) * uNight * smoothstep(0.02, 0.25, d.y);
    col += vec3(star * 0.8);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const c = (hex) => new THREE.Color(hex);
const NIGHT = { zenith: c(0x05081a), horizon: c(0x0e1730) };
const DAY = { zenith: c(0x3d7ad4), horizon: c(0xb9d3ee) };
const DUSK = { zenith: c(0x3a4f8e), horizon: c(0xf3a457) };
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Lighting {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.frac = 0.5;
    this.shadows = false;

    this.hemi = new THREE.HemisphereLight(0xdde9ff, 0x4a5a3a, 1);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
    this.moon = new THREE.DirectionalLight(0x8fa8ff, 0);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    const cam = this.sun.shadow.camera;
    cam.near = 50; cam.far = 4500;
    scene.add(this.hemi, this.sun, this.sun.target, this.moon);

    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uZenith: { value: DAY.zenith.clone() }, uHorizon: { value: DAY.horizon.clone() },
      uSunTint: { value: new THREE.Color(1, 0.95, 0.85) }, uNight: { value: 0 }, uSunDisc: { value: 1.6 },
    };
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
    this.dome.scale.setScalar(20000);
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    scene.fog = new THREE.Fog(DAY.horizon.clone(), 2500, 9500);
    scene.background = DAY.horizon.clone();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(this.dome.geometry, this.dome.material);
    this.envDome.scale.setScalar(100);
    this.envScene.add(this.envDome);
    this.envTarget = null;
    this.setTime(0.5);
  }

  // sun direction for a day fraction: rises east, arcs over the north-west (the side the map
  // tiles are shaded from), sets west
  sunDir(frac) {
    const a = (frac - 0.25) * Math.PI * 2;
    const elev = Math.sin(a), along = Math.cos(a);
    return new THREE.Vector3(along * 0.95, elev, -0.35 * Math.max(0, elev) - 0.12).normalize();
  }

  setTime(frac) {
    this.frac = ((frac % 1) + 1) % 1;
    const dir = this.sunDir(this.frac), e = dir.y;
    const day = smooth(-0.06, 0.22, e), dusk = 1 - smooth(0, 0.3, Math.abs(e)), night = 1 - smooth(-0.25, 0.02, e);
    const zenith = NIGHT.zenith.clone().lerp(DAY.zenith, day).lerp(DUSK.zenith, dusk * 0.7);
    const horizon = NIGHT.horizon.clone().lerp(DAY.horizon, day).lerp(DUSK.horizon, dusk * 0.85);
    this.uniforms.uSun.value.copy(dir);
    this.uniforms.uZenith.value.copy(zenith);
    this.uniforms.uHorizon.value.copy(horizon);
    this.uniforms.uNight.value = night;
    this.uniforms.uSunDisc.value = e > -0.05 ? 1.6 : 0;
    this.uniforms.uSunTint.value.set(1, lerp(0.55, 0.95, smooth(0, 0.3, e)), lerp(0.25, 0.82, smooth(0, 0.35, e))).multiplyScalar(smooth(-0.1, 0.02, e));

    this.sun.color.set(1, lerp(0.6, 0.95, smooth(0, 0.3, e)), lerp(0.3, 0.86, smooth(0, 0.35, e)));
    this.sun.intensity = 2.6 * smooth(-0.02, 0.2, e);
    this.sunDirection = dir;
    this.hemi.color.copy(zenith).lerp(new THREE.Color(0xffffff), 0.35);
    this.hemi.groundColor.set(0x4a5a3a).lerp(new THREE.Color(0x0a0c12), night);
    this.hemi.intensity = lerp(0.32, 1.0, day);
    this.moon.intensity = 0.55 * night;
    this.moonDirection = new THREE.Vector3(-dir.x, Math.max(0.35, -dir.y), -dir.z).normalize();
    this.sun.castShadow = this.shadows && this.sun.intensity > 0.05;
    this.moon.castShadow = this.shadows && this.sun.intensity <= 0.05;

    this.scene.fog.color.copy(horizon);
    this.scene.background.copy(horizon);
    this.envDirty = true;
  }

  // Bake the sky into an environment map (reflections on water, sheen on metal). Cheap; done
  // only when the time of day changed.
  updateEnvironment() {
    if (!this.envDirty) return;
    this.envDirty = false;
    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.04, 10, 200);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = lerp(0.35, 1.0, this.hemi.intensity);
    if (old) old.dispose();
  }

  setShadows(on) {
    this.shadows = on;
    this.renderer.shadowMap.enabled = on;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.setTime(this.frac);
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }

  // Per frame: keep the dome on the camera and the shadow box around the point of interest, sized
  // to the view distance so close-ups get sharp shadows and overviews still get some.
  update(camera, target) {
    this.dome.position.copy(camera.position);
    const dist = camera.position.distanceTo(target);
    const half = Math.min(1400, Math.max(120, dist * 0.9));
    for (const [light, dir] of [[this.sun, this.sunDirection], [this.moon, this.moonDirection]]) {
      light.target.position.copy(target);
      light.position.copy(target).addScaledVector(dir, 2200);
      light.target.updateMatrixWorld();
      const sc = light.shadow.camera;
      if (sc.left !== -half) { sc.left = sc.bottom = -half; sc.right = sc.top = half; sc.updateProjectionMatrix(); }
    }
    this.updateEnvironment();
  }
}
