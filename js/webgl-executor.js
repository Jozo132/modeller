import { mat4LookAt, mat4Multiply, mat4Ortho, mat4TransformVec4 } from './render/render-math.js';

// WebGL command executor - processes batched commands from the WASM module

const CMD_END = 0;
const CMD_CLEAR = 1;
const CMD_SET_PROGRAM = 2;
const CMD_SET_MATRIX = 3;
const CMD_SET_COLOR = 4;
const CMD_DRAW_TRIANGLES = 5;
const CMD_DRAW_LINES = 6;
const CMD_DRAW_POINTS = 7;
const CMD_SET_LINE_DASH = 8;
const CMD_SET_DEPTH_TEST = 9;
const CMD_SET_LINE_WIDTH = 10;
const CMD_SET_DEPTH_WRITE = 11;
const SHADOW_MAP_SIZE = 1024;
const DEFAULT_SUN_TIME_HOURS = 16;
const SUN_TIME_MIN = 6;
const SUN_TIME_MAX = 20;

function normalizeVec3(value, fallback = [0, 0, 1]) {
  const x = value?.[0] ?? value?.x ?? fallback[0];
  const y = value?.[1] ?? value?.y ?? fallback[1];
  const z = value?.[2] ?? value?.z ?? fallback[2];
  const length = Math.hypot(x, y, z);
  if (length <= 1e-8) return [...fallback];
  return [x / length, y / length, z / length];
}

function sunDirectionFromTime(hours = DEFAULT_SUN_TIME_HOURS) {
  const clamped = Math.max(SUN_TIME_MIN, Math.min(SUN_TIME_MAX, Number.isFinite(hours) ? hours : DEFAULT_SUN_TIME_HOURS));
  const t = (clamped - SUN_TIME_MIN) / (SUN_TIME_MAX - SUN_TIME_MIN);
  const minElevation = 2 * Math.PI / 180;
  const elevation = minElevation + Math.max(0, Math.sin(t * Math.PI)) * (46 * Math.PI / 180);
  const southness = 0.35 + 0.65 * Math.sin(t * Math.PI);
  const horizontal = normalizeVec3([Math.cos(t * Math.PI), -southness, 0], [0, -1, 0]);
  const cosElevation = Math.cos(elevation);
  return normalizeVec3([
    horizontal[0] * cosElevation,
    horizontal[1] * cosElevation,
    Math.sin(elevation),
  ]);
}

const SUN_DIRECTION = sunDirectionFromTime(DEFAULT_SUN_TIME_HOURS);

function subtractVec3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addVec3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVec3(value, scalar) {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function crossVec3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dotVec3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function computeSolidBounds(data, vertexCount) {
  if (!data || vertexCount <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let index = 0; index < vertexCount * 6; index += 6) {
    const x = data[index];
    const y = data[index + 1];
    const z = data[index + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

function buildBoundsCorners(bounds) {
  const corners = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push([x, y, z]);
      }
    }
  }
  return corners;
}

function projectPointToPlane(point, planeZ, sunDir) {
  const castDir = [-sunDir[0], -sunDir[1], -sunDir[2]];
  if (Math.abs(castDir[2]) <= 1e-6) return [point[0], point[1], planeZ];
  const t = (planeZ - point[2]) / castDir[2];
  return [point[0] + castDir[0] * t, point[1] + castDir[1] * t, planeZ];
}

function buildProjectedShadowMesh(data, vertexCount, planeZ, sunDir) {
  if (!data || vertexCount <= 0) return null;
  const projected = new Float32Array(vertexCount * 3);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let target = 0;
  const shadowPlaneZ = planeZ + 0.0005;

  for (let index = 0; index < vertexCount * 6; index += 6) {
    const point = projectPointToPlane([data[index], data[index + 1], data[index + 2]], shadowPlaneZ, sunDir);
    projected[target++] = point[0];
    projected[target++] = point[1];
    projected[target++] = point[2];
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return {
    triangles: projected,
    bounds: {
      minX,
      minY,
      maxX,
      maxY,
      planeZ: shadowPlaneZ,
    },
  };
}

function buildShadowView(bounds, sunDir) {
  const center = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ) || 1;
  const eye = addVec3(center, scaleVec3(sunDir, diagonal * 2.2 + 4));
  let up = [0, 0, 1];
  if (Math.abs(dotVec3(up, sunDir)) > 0.92) {
    up = [0, 1, 0];
  }
  const view = mat4LookAt(eye[0], eye[1], eye[2], center[0], center[1], center[2], up[0], up[1], up[2]);
  if (!view) return null;
  return { view, diagonal };
}

function buildShadowLightMvp(view, corners, diagonal, padScale = 0.18, padOffset = 0.5) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const corner of corners) {
    const clip = mat4TransformVec4(view, corner[0], corner[1], corner[2], 1);
    minX = Math.min(minX, clip.x);
    minY = Math.min(minY, clip.y);
    minZ = Math.min(minZ, clip.z);
    maxX = Math.max(maxX, clip.x);
    maxY = Math.max(maxY, clip.y);
    maxZ = Math.max(maxZ, clip.z);
  }

  const pad = diagonal * padScale + padOffset;
  const near = Math.max(0.1, -maxZ - pad);
  const far = Math.max(near + 1, -minZ + pad);
  const proj = mat4Ortho(minX - pad, maxX + pad, minY - pad, maxY + pad, near, far);
  return mat4Multiply(proj, view);
}

const FISHEYE_VERTEX_UNIFORMS = `
uniform mediump vec3 uViewDir;
uniform mediump vec3 uViewUp;
uniform mediump vec3 uCameraPos;
uniform mediump float uAspect;
uniform mediump float uFisheyeFov;
uniform mediump float uFisheyeEnabled;
uniform mediump float uFisheyeStrength;
`;

const FISHEYE_VERTEX_HELPERS = `
vec3 fsSafeNormalize(vec3 value, vec3 fallback) {
  float len = length(value);
  return len > 1e-5 ? value / len : fallback;
}

vec4 projectFisheyeClip(vec3 worldPos, vec4 fallbackClip) {
  float strength = clamp(uFisheyeStrength, 0.0, 1.0);
  if (uFisheyeEnabled < 0.5 || strength <= 1e-5) {
    return fallbackClip;
  }

  vec3 forward = fsSafeNormalize(uViewDir, vec3(0.0, 0.0, -1.0));
  vec3 up = fsSafeNormalize(uViewUp, vec3(0.0, 0.0, 1.0));
  vec3 right = fsSafeNormalize(cross(forward, up), vec3(1.0, 0.0, 0.0));
  up = fsSafeNormalize(cross(right, forward), vec3(0.0, 0.0, 1.0));

  vec3 relative = worldPos - uCameraPos;
  float cx = dot(relative, right);
  float cy = dot(relative, up);
  float cz = dot(relative, forward);
  if (cz <= 1e-5) {
    return vec4(2.0, 2.0, 2.0, 1.0);
  }

  float dist = length(vec3(cx, cy, cz));
  vec2 fallbackNdc = fallbackClip.xy / max(fallbackClip.w, 1e-5);
  if (dist <= 1e-5) {
    vec2 ndc = mix(fallbackNdc, vec2(0.0, 0.0), strength);
    return vec4(ndc, fallbackClip.z / max(fallbackClip.w, 1e-5), 1.0);
  }

  float theta = acos(clamp(cz / dist, -1.0, 1.0));
  float maxTheta = radians(max(uFisheyeFov, 1.0)) * 0.5;
  if (theta > maxTheta + 1e-4 && strength >= 0.999) {
    return vec4(2.0, 2.0, 2.0, 1.0);
  }

  vec2 planar = vec2(cx, cy);
  vec2 radial = length(planar) > 1e-5 ? normalize(planar) : vec2(0.0, 0.0);
  float radius = min(theta / max(maxTheta, 1e-5), 1.0);
  vec2 fisheyeNdc = radial * radius;
  vec2 ndc = mix(fallbackNdc, fisheyeNdc, strength);
  float ndcZ = fallbackClip.z / max(fallbackClip.w, 1e-5);
  return vec4(ndc, ndcZ, 1.0);
}
`;

// Program 0: solid/triangle shader with lighting
const SOLID_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMVP;
uniform mat4 uLightMVP;
${FISHEYE_VERTEX_UNIFORMS}
out vec3 vNormal;
out vec3 vWorldPos;
out vec4 vLightClip;
${FISHEYE_VERTEX_HELPERS}
void main() {
  vNormal = aNormal;
  vWorldPos = aPosition;
  vLightClip = uLightMVP * vec4(aPosition, 1.0);
  vec4 clip = uMVP * vec4(aPosition, 1.0);
  gl_Position = projectFisheyeClip(aPosition, clip);
}`;

const SOLID_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform mediump vec3 uViewDir;
uniform mediump vec3 uViewUp;
uniform mediump vec3 uSunDir;
uniform highp sampler2DShadow uShadowMap;
uniform float uSelfShadowEnabled;
uniform float uSunLightEnabled;
in vec3 vNormal;
in vec3 vWorldPos;
in vec4 vLightClip;
out vec4 fragColor;

vec3 safeNormalize(vec3 value, vec3 fallback) {
  float len = length(value);
  return len > 1e-5 ? value / len : fallback;
}

vec3 sampleEnvironment(vec3 dir) {
  vec3 worldUp = vec3(0.0, 0.0, 1.0);
  float altitude = clamp(dot(dir, worldUp), -1.0, 1.0);
  float skyMask = smoothstep(-0.05, 0.08, altitude);
  float skyLift = smoothstep(0.02, 0.96, altitude * 0.5 + 0.5);

  vec3 groundNear = vec3(0.82, 0.83, 0.84);
  vec3 groundFar = vec3(0.58, 0.60, 0.62);
  vec3 ground = mix(groundNear, groundFar, smoothstep(-0.9, 0.18, altitude));

  vec3 horizon = vec3(0.86, 0.88, 0.89);
  vec3 skyLow = vec3(0.47, 0.63, 0.79);
  vec3 skyHigh = vec3(0.07, 0.20, 0.41);
  vec3 sky = mix(skyLow, skyHigh, skyLift);

  float azimuth = atan(dir.y, dir.x);
  float skySweep = 0.5 + 0.5 * cos(azimuth - 0.6);
  sky += vec3(0.02, 0.04, 0.06) * skySweep * smoothstep(0.10, 0.85, altitude);

  float horizonGlow = exp(-abs(altitude) * 20.0);
  vec3 env = mix(ground, sky, skyMask);
  env = mix(env, horizon, horizonGlow * 0.52);
  return env;
}

float sampleCameraLightRig(vec3 reflectedDir, vec3 forward) {
  vec3 worldUp = vec3(0.0, 0.0, 1.0);
  vec3 right = safeNormalize(cross(forward, worldUp), vec3(1.0, 0.0, 0.0));
  vec3 up = safeNormalize(cross(right, forward), worldUp);

  vec2 rigUv = vec2(dot(reflectedDir, right), dot(reflectedDir, up)) * 0.95;
  vec2 tiled = abs(fract((rigUv * 0.5 + 0.5) * 2.0) - 0.5);
  float panel = 1.0 - smoothstep(0.14, 0.32, max(tiled.x, tiled.y));
  float cross = exp(-48.0 * min(tiled.x * tiled.x, tiled.y * tiled.y));
  float rigMask = 1.0 - smoothstep(0.55, 1.15, length(rigUv));
  return panel * (0.25 + 0.75 * cross) * rigMask;
}

float sampleShadowVisibility(vec4 lightClip, vec3 normal, vec3 sunDir) {
  vec3 ndc = lightClip.xyz / max(lightClip.w, 1e-5);
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float compareDepth = ndc.z * 0.5 + 0.5;
  vec2 texel = 1.0 / vec2(textureSize(uShadowMap, 0));
  float ndl = clamp(dot(normal, sunDir), 0.0, 1.0);
  float bias = max(0.0030 * (1.0 - ndl), 0.0010);
  float receiverDepth = compareDepth - bias;
  float visibility = 0.0;
  visibility += texture(uShadowMap, vec3(uv, receiverDepth));
  visibility += texture(uShadowMap, vec3(uv + vec2(texel.x, 0.0), receiverDepth));
  visibility += texture(uShadowMap, vec3(uv + vec2(-texel.x, 0.0), receiverDepth));
  visibility += texture(uShadowMap, vec3(uv + vec2(0.0, texel.y), receiverDepth));
  visibility += texture(uShadowMap, vec3(uv + vec2(0.0, -texel.y), receiverDepth));
  return visibility / 5.0;
}

void main() {
  vec3 n = safeNormalize(vNormal, vec3(0.0, 0.0, 1.0));
  vec3 forward = safeNormalize(uViewDir, vec3(0.0, 0.0, -1.0));
  vec3 cameraUp = safeNormalize(uViewUp, vec3(0.0, 0.0, 1.0));
  vec3 cameraRight = safeNormalize(cross(forward, cameraUp), vec3(1.0, 0.0, 0.0));
  cameraUp = safeNormalize(cross(cameraRight, forward), vec3(0.0, 0.0, 1.0));
  vec3 eyeDir = -forward;
  vec3 sunDir = safeNormalize(uSunDir, vec3(0.0, -0.8, 0.6));
  float sunStrength = clamp(uSunLightEnabled, 0.0, 1.0);
  float shadowVisibility = (sunStrength > 0.0 && uSelfShadowEnabled > 0.5)
    ? sampleShadowVisibility(vLightClip, n, sunDir)
    : 1.0;

  float ndl = max(dot(n, sunDir), 0.0);
  float backLight = max(dot(n, -sunDir), 0.0);
  float nde = max(dot(n, eyeDir), 0.0);
  float grazing = pow(clamp(1.0 - nde, 0.0, 1.0), 3.4);

  float skyExposure = clamp(n.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 hemiUp = mix(vec3(0.30, 0.33, 0.37), vec3(0.42, 0.47, 0.53), skyExposure);
  vec3 hemiDown = vec3(0.16, 0.16, 0.15);
  vec3 ambientEnv = mix(hemiDown, hemiUp, 0.72);
  vec3 ambientColor = uColor.rgb * (ambientEnv * 0.18 + vec3(0.11, 0.12, 0.11));
  vec3 sunTint = vec3(1.0, 0.97, 0.92);
  vec3 sunDiffuse = uColor.rgb * sunTint * (ndl * 1.10 * sunStrength * shadowVisibility);
  vec3 bounceLight = uColor.rgb * vec3(0.12, 0.12, 0.10) * (backLight * 0.16);

  vec3 cameraLightAxis = safeNormalize(cameraRight + cameraUp, cameraRight);
  float cameraLightAngle = radians(15.0);
  vec3 cameraLightDir = safeNormalize(
    eyeDir * cos(cameraLightAngle) + cameraLightAxis * sin(cameraLightAngle),
    eyeDir
  );
  float cameraNdl = max(dot(n, cameraLightDir), 0.0);
  vec3 cameraHalfVector = safeNormalize(cameraLightDir + eyeDir, n);
  float cameraSpecular = pow(max(dot(n, cameraHalfVector), 0.0), 24.0);
  vec3 cameraLightColor = vec3(1.0, 0.98, 0.92);
  vec3 cameraDiffuse = uColor.rgb * cameraLightColor * (cameraNdl * 0.18);
  vec3 cameraHighlight = cameraLightColor * (cameraSpecular * 0.22);

  vec3 reflectionDir = safeNormalize(reflect(forward, n), n);
  vec3 roughReflectionDir = safeNormalize(mix(n, reflectionDir, 0.16), n);
  vec3 envColor = sampleEnvironment(roughReflectionDir);
  vec3 reflection = envColor * grazing * 0.02;

  vec3 halfVector = safeNormalize(sunDir + eyeDir, n);
  float specularTerm = pow(max(dot(n, halfVector), 0.0), 32.0);
  vec3 specular = sunTint * (specularTerm * 0.12 * sunStrength * shadowVisibility);

  float lightRig = sampleCameraLightRig(roughReflectionDir, forward) * grazing;
  vec3 boxLight = vec3(0.84, 0.88, 0.91) * lightRig * 0.03;
  vec3 rim = ambientEnv * grazing * 0.035;

  vec3 litColor = ambientColor + bounceLight + sunDiffuse + specular
    + cameraDiffuse + cameraHighlight + reflection + boxLight + rim;
  fragColor = vec4(litColor, uColor.a);
}`;

// Program 2: diagnostic solid shader with purple/yellow hatch overlay
const DIAG_SOLID_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMVP;
${FISHEYE_VERTEX_UNIFORMS}
out vec3 vNormal;
${FISHEYE_VERTEX_HELPERS}
void main() {
  vec3 n = normalize(aNormal);
  vNormal = n;
  vec3 worldPos = aPosition + n * 0.01;
  vec4 clip = uMVP * vec4(worldPos, 1.0);
  gl_Position = projectFisheyeClip(worldPos, clip);
}`;

const DIAG_SOLID_FS = `#version 300 es
precision mediump float;
uniform vec3 uViewDir;
in vec3 vNormal;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.3, 0.5, 0.8));
  float ambient = 0.35;
  float diffuse = abs(dot(n, lightDir)) * 0.65;
  float camLight = max(dot(n, uViewDir), 0.0) * 0.2;
  float shade = ambient + diffuse + camLight;

  vec3 purple = vec3(0.38, 0.10, 0.52);
  vec3 yellow = vec3(0.97, 0.90, 0.16);
  float stripe = step(fract((gl_FragCoord.x - gl_FragCoord.y) * 0.125), 0.13);
  vec3 color = mix(purple, yellow, stripe);
  fragColor = vec4(color * shade, 0.98);
}`;

// Program 3: normal-color debug shader — maps abs(normal) XYZ to soft RGB
const NORMAL_COLOR_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMVP;
${FISHEYE_VERTEX_UNIFORMS}
out vec3 vNormal;
${FISHEYE_VERTEX_HELPERS}
void main() {
  vNormal = aNormal;
  vec4 clip = uMVP * vec4(aPosition, 1.0);
  gl_Position = projectFisheyeClip(aPosition, clip);
}`;

const NORMAL_COLOR_FS = `#version 300 es
precision mediump float;
uniform vec3 uViewDir;
in vec3 vNormal;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 absN = abs(n);
  // Soft pastel mapping: blend toward grey to keep colors muted
  vec3 base = absN * 0.45 + 0.35;
  // Light directional shading to preserve depth cues
  vec3 lightDir = normalize(vec3(0.3, 0.5, 0.8));
  float ambient = 0.55;
  float diffuse = max(dot(n, lightDir), 0.0) * 0.35;
  float camLight = max(dot(n, uViewDir), 0.0) * 0.1;
  fragColor = vec4(base * (ambient + diffuse + camLight), 1.0);
}`;

// Program 1: line/point shader, no lighting
const LINE_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uMVP;
uniform float uPointSize;
uniform float uDepthBias;
${FISHEYE_VERTEX_UNIFORMS}
${FISHEYE_VERTEX_HELPERS}
void main() {
  vec4 clip = uMVP * vec4(aPosition, 1.0);
  clip.z -= uDepthBias * clip.w;
  gl_Position = projectFisheyeClip(aPosition, clip);
  gl_PointSize = uPointSize;
}`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  fragColor = uColor;
}`;

const BACKGROUND_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos;
  if (gl_VertexID == 0) {
    pos = vec2(-1.0, -1.0);
  } else if (gl_VertexID == 1) {
    pos = vec2(3.0, -1.0);
  } else {
    pos = vec2(-1.0, 3.0);
  }
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const BACKGROUND_FS = `#version 300 es
precision mediump float;
uniform vec3 uViewDir;
uniform vec3 uViewUp;
uniform float uAspect;
uniform float uFisheyeFov;
uniform float uFisheyeEnabled;
uniform float uFisheyeStrength;
uniform vec4 uColor;
in vec2 vUv;
out vec4 fragColor;

vec3 safeNormalize(vec3 value, vec3 fallback) {
  float len = length(value);
  return len > 1e-5 ? value / len : fallback;
}

vec3 sampleEnvironment(vec3 dir) {
  vec3 worldUp = vec3(0.0, 0.0, 1.0);
  float altitude = clamp(dot(dir, worldUp), -1.0, 1.0);
  float skyMask = smoothstep(-0.05, 0.08, altitude);
  float skyLift = smoothstep(0.02, 0.96, altitude * 0.5 + 0.5);

  vec3 groundNear = vec3(0.87, 0.88, 0.89);
  vec3 groundFar = vec3(0.60, 0.62, 0.64);
  vec3 ground = mix(groundNear, groundFar, smoothstep(-1.0, 0.15, altitude));

  vec3 horizon = vec3(0.88, 0.89, 0.90);
  vec3 skyLow = vec3(0.49, 0.64, 0.80);
  vec3 skyHigh = vec3(0.06, 0.18, 0.39);
  vec3 sky = mix(skyLow, skyHigh, skyLift);

  float azimuth = atan(dir.y, dir.x);
  float skyVariation = 0.5 + 0.5 * cos(azimuth - 0.6);
  sky += vec3(0.03, 0.05, 0.07) * skyVariation * smoothstep(0.10, 0.9, altitude);

  float horizonGlow = exp(-abs(altitude) * 18.0);
  vec3 env = mix(ground, sky, skyMask);
  env = mix(env, horizon, horizonGlow * 0.54);
  return env;
}

void main() {
  vec3 forward = safeNormalize(uViewDir, vec3(0.0, 1.0, 0.0));
  vec3 up = safeNormalize(uViewUp, vec3(0.0, 0.0, 1.0));
  vec3 right = safeNormalize(cross(forward, up), vec3(1.0, 0.0, 0.0));
  up = safeNormalize(cross(right, forward), vec3(0.0, 0.0, 1.0));

  vec2 screen = vUv * 2.0 - 1.0;
  vec2 perspectiveScreen = screen;
  perspectiveScreen.x *= max(uAspect, 0.001);
  vec3 perspectiveRay = safeNormalize(forward + right * perspectiveScreen.x * 0.92 + up * perspectiveScreen.y * 0.58, forward);

  vec3 ray = perspectiveRay;
  float strength = clamp(uFisheyeStrength, 0.0, 1.0);
  if (uFisheyeEnabled > 0.5 && strength > 1e-5) {
    vec2 lens = screen;
    float radius = length(lens);
    vec2 radial = radius > 1e-5 ? lens / radius : vec2(0.0, 0.0);
    float maxTheta = radians(max(uFisheyeFov, 1.0)) * 0.5;
    float theta = min(radius, 1.0) * maxTheta;
    vec3 fisheyeRay = safeNormalize(forward * cos(theta) + (right * radial.x + up * radial.y) * sin(theta), forward);
    ray = safeNormalize(mix(perspectiveRay, fisheyeRay, strength), perspectiveRay);
  }

  vec3 color = sampleEnvironment(ray);
  float altitude = clamp(ray.z, -1.0, 1.0);
  float horizonGlow = exp(-abs(altitude) * 26.0);
  color = mix(color, vec3(0.90, 0.91, 0.92), horizonGlow * 0.18);

  float zenithGlow = pow(max(dot(ray, safeNormalize(vec3(-0.32, -0.18, 0.93), vec3(0.0, 0.0, 1.0))), 0.0), 16.0);
  color += vec3(0.05, 0.08, 0.11) * zenithGlow * smoothstep(0.0, 0.55, altitude);

  float groundLift = smoothstep(-1.0, -0.04, altitude);
  color = mix(color, mix(color, vec3(0.90, 0.90, 0.91), clamp(-forward.z, 0.0, 1.0) * 0.35), 1.0 - groundLift);

  float vignette = 1.0 - smoothstep(0.40, 1.24, length(screen * vec2(0.86, 1.0)));
  color += vec3(0.03, 0.04, 0.05) * vignette * 0.14;
  color = mix(color, uColor.rgb * 0.35 + color * 0.65, 0.16);

  fragColor = vec4(color, uColor.a);
}`;

const SHADOW_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uLightMVP;
void main() {
  gl_Position = uLightMVP * vec4(aPosition, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision mediump float;
void main() {
}`;

const SHADOW_PLANE_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uMVP;
uniform mat4 uLightMVP;
${FISHEYE_VERTEX_UNIFORMS}
out vec4 vLightClip;
${FISHEYE_VERTEX_HELPERS}
void main() {
  vLightClip = uLightMVP * vec4(aPosition, 1.0);
  vec4 clip = uMVP * vec4(aPosition, 1.0);
  gl_Position = projectFisheyeClip(aPosition, clip);
}`;

const SHADOW_PLANE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
uniform sampler2D uShadowMap;
uniform float uProjectedShadowEnabled;
in vec4 vLightClip;
out vec4 fragColor;

float sampleShadowCoverage(vec4 lightClip) {
  vec3 ndc = lightClip.xyz / max(lightClip.w, 1e-5);
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z > 1.0) {
    return 0.0;
  }
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float currentDepth = ndc.z * 0.5 + 0.5;
  vec2 texel = 1.0 / vec2(textureSize(uShadowMap, 0));
  float shadow = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      float sampledDepth = texture(uShadowMap, uv + vec2(float(x), float(y)) * texel).r;
      shadow += currentDepth - 0.0007 > sampledDepth ? 1.0 : 0.0;
    }
  }
  return shadow / 9.0;
}

void main() {
  if (uProjectedShadowEnabled <= 0.0) {
    discard;
  }
  float coverage = sampleShadowCoverage(vLightClip);
  if (coverage <= 0.01) {
    discard;
  }
  fragColor = vec4(uColor.rgb, uColor.a * coverage);
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile error: ' + info);
  }
  return shader;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('Program link error: ' + info);
  }
  // Shaders can be detached after linking
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export function isLikelySamsungAndroidChrome(userAgent = globalThis.navigator?.userAgent || '') {
  return /Android/i.test(userAgent)
    && /Chrome\//i.test(userAgent)
    && /(SamsungBrowser|;\s*SM-|;\s*GT-|;\s*SCH-|;\s*SHV-|;\s*SHW-|;\s*SGH-|;\s*SPH-|;\s*SC-|;\s*SCV-)/i.test(userAgent);
}

export function getWebGL2ContextOptions(userAgent = globalThis.navigator?.userAgent || '') {
  const standardOptions = [
    { antialias: true, alpha: false, preserveDrawingBuffer: true, stencil: true },
    { antialias: true, alpha: false, preserveDrawingBuffer: false, stencil: true },
    { antialias: false, alpha: false, preserveDrawingBuffer: false, stencil: false },
    { antialias: false, alpha: true, preserveDrawingBuffer: false, stencil: false },
  ];

  if (!isLikelySamsungAndroidChrome(userAgent)) return standardOptions;

  return [
    { antialias: true, alpha: false, preserveDrawingBuffer: false, stencil: false },
    { antialias: true, alpha: false, preserveDrawingBuffer: false, stencil: true },
    { antialias: false, alpha: false, preserveDrawingBuffer: false, stencil: false },
    { antialias: false, alpha: true, preserveDrawingBuffer: false, stencil: false },
    { antialias: true, alpha: false, preserveDrawingBuffer: true, stencil: false },
  ];
}

export class WebGLExecutor {
  constructor(canvas) {
    const contextOptions = getWebGL2ContextOptions();
    let gl = null;
    for (const options of contextOptions) {
      gl = canvas.getContext('webgl2', options);
      if (gl) break;
    }
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;

    // Create shader programs
    this.programs = [
      createProgram(gl, SOLID_VS, SOLID_FS),
      createProgram(gl, LINE_VS, LINE_FS),
      createProgram(gl, DIAG_SOLID_VS, DIAG_SOLID_FS),
      createProgram(gl, NORMAL_COLOR_VS, NORMAL_COLOR_FS),
      createProgram(gl, BACKGROUND_VS, BACKGROUND_FS),
      createProgram(gl, SHADOW_VS, SHADOW_FS),
      createProgram(gl, SHADOW_PLANE_VS, SHADOW_PLANE_FS),
    ];

    // Cache uniform locations for each program
    this.uniforms = this.programs.map(p => ({
      uMVP: gl.getUniformLocation(p, 'uMVP'),
      uColor: gl.getUniformLocation(p, 'uColor'),
      uPointSize: gl.getUniformLocation(p, 'uPointSize'),
      uDepthBias: gl.getUniformLocation(p, 'uDepthBias'),
      uViewDir: gl.getUniformLocation(p, 'uViewDir'),
      uViewUp: gl.getUniformLocation(p, 'uViewUp'),
      uCameraPos: gl.getUniformLocation(p, 'uCameraPos'),
      uAspect: gl.getUniformLocation(p, 'uAspect'),
      uFisheyeFov: gl.getUniformLocation(p, 'uFisheyeFov'),
      uFisheyeEnabled: gl.getUniformLocation(p, 'uFisheyeEnabled'),
      uFisheyeStrength: gl.getUniformLocation(p, 'uFisheyeStrength'),
      uLightMVP: gl.getUniformLocation(p, 'uLightMVP'),
      uShadowMap: gl.getUniformLocation(p, 'uShadowMap'),
      uSunDir: gl.getUniformLocation(p, 'uSunDir'),
      uSelfShadowEnabled: gl.getUniformLocation(p, 'uSelfShadowEnabled'),
      uSunLightEnabled: gl.getUniformLocation(p, 'uSunLightEnabled'),
      uProjectedShadowEnabled: gl.getUniformLocation(p, 'uProjectedShadowEnabled'),
    }));

    // Default view direction (will be updated each frame)
    this._viewDir = [0, 0, 1];
    this._viewUp = [0, 0, 1];
    this._cameraPos = [0, 0, 0];
    this._fovDegrees = 45;
    this._fisheyeEnabled = true;
    this._fisheyeStrength = 1;
    this._projectedShadowEnabled = true;
    this._selfShadowEnabled = true;
    this._sunLightEnabled = true;
    this._backgroundEnabled = true;
    this._sunTimeHours = DEFAULT_SUN_TIME_HOURS;
    this._sunDirection = [...SUN_DIRECTION];
    this._shadowFramebuffer = null;
    this._shadowTexture = null;
    this._selfShadowFramebuffer = null;
    this._selfShadowTexture = null;
    this._hasStencil = !!gl.getContextAttributes()?.stencil;

    // Dynamic VBO shared across draw calls
    this.vbo = gl.createBuffer();

    // VAO for program 0 (position + normal, stride 24)
    this.vaoSolid = gl.createVertexArray();
    gl.bindVertexArray(this.vaoSolid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);

    // VAO for program 1 (position only, stride 12)
    this.vaoLine = gl.createVertexArray();
    gl.bindVertexArray(this.vaoLine);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    this.vaoFullscreen = gl.createVertexArray();

    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this._ownedStaticBuffers = new Set();

    // Software GL state shadow — avoids expensive getParameter/isEnabled GPU stalls
    this._st = {
      blend: false,
      depthTest: false,
      depthWrite: true,
      depthFunc: gl.LESS,
      cullFace: false,
      polygonOffset: false,
    };

    // Default state
    gl.enable(gl.DEPTH_TEST);
    this._st.depthTest = true;
    gl.enable(gl.BLEND);
    this._st.blend = true;
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.currentProgram = -1;
    this._ensureShadowResources();
  }

  createStaticSolidBuffer(data) {
    return this._createStaticBuffer(data, 'solid');
  }

  createStaticLineBuffer(data) {
    return this._createStaticBuffer(data, 'line');
  }

  _createStaticBuffer(data, layout) {
    if (!data || data.length === 0) return null;
    const gl = this.gl;
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    if (layout === 'solid') {
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    } else {
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const resource = {
      buffer,
      vao,
      layout,
      vertexCount: layout === 'solid' ? data.length / 6 : data.length / 3,
    };
    this._ownedStaticBuffers.add(resource);
    return resource;
  }

  deleteStaticBuffer(resource) {
    if (!resource) return;
    const gl = this.gl;
    if (resource.vao) gl.deleteVertexArray(resource.vao);
    if (resource.buffer) gl.deleteBuffer(resource.buffer);
    this._ownedStaticBuffers.delete(resource);
  }

  // --- State management (updates shadow + GL, skips redundant calls) ---
  setBlend(on) {
    if (this._st.blend !== on) {
      this._st.blend = on;
      if (on) this.gl.enable(this.gl.BLEND);
      else this.gl.disable(this.gl.BLEND);
    }
  }
  setDepthTest(on) {
    if (this._st.depthTest !== on) {
      this._st.depthTest = on;
      if (on) this.gl.enable(this.gl.DEPTH_TEST);
      else this.gl.disable(this.gl.DEPTH_TEST);
    }
  }
  setDepthWrite(on) {
    if (this._st.depthWrite !== on) {
      this._st.depthWrite = on;
      this.gl.depthMask(on);
    }
  }
  setDepthFunc(fn) {
    if (this._st.depthFunc !== fn) {
      this._st.depthFunc = fn;
      this.gl.depthFunc(fn);
    }
  }
  setCullFace(on) {
    if (this._st.cullFace !== on) {
      this._st.cullFace = on;
      if (on) this.gl.enable(this.gl.CULL_FACE);
      else this.gl.disable(this.gl.CULL_FACE);
    }
  }
  setPolygonOffset(on) {
    if (this._st.polygonOffset !== on) {
      this._st.polygonOffset = on;
      if (on) this.gl.enable(this.gl.POLYGON_OFFSET_FILL);
      else this.gl.disable(this.gl.POLYGON_OFFSET_FILL);
    }
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  setViewDir(x, y, z) {
    this._viewDir[0] = x;
    this._viewDir[1] = y;
    this._viewDir[2] = z;
  }

  setViewUp(x, y, z) {
    this._viewUp[0] = x;
    this._viewUp[1] = y;
    this._viewUp[2] = z;
  }

  setCameraPosition(x, y, z) {
    this._cameraPos[0] = x;
    this._cameraPos[1] = y;
    this._cameraPos[2] = z;
  }

  setProjectionMode({
    fovDegrees = this._fovDegrees,
    fisheyeEnabled = this._fisheyeEnabled,
    fisheyeStrength = this._fisheyeStrength,
  } = {}) {
    this._fovDegrees = Number.isFinite(fovDegrees) ? fovDegrees : this._fovDegrees;
    this._fisheyeEnabled = fisheyeEnabled !== false;
    this._fisheyeStrength = Math.max(0, Math.min(1, Number.isFinite(fisheyeStrength) ? fisheyeStrength : this._fisheyeStrength));
  }

  _applyGlobalUniforms(index) {
    const gl = this.gl;
    const uniforms = this.uniforms[index];
    if (!uniforms) return;
    if (uniforms.uViewDir) {
      gl.uniform3fv(uniforms.uViewDir, this._viewDir);
    }
    if (uniforms.uViewUp) {
      gl.uniform3fv(uniforms.uViewUp, this._viewUp);
    }
    if (uniforms.uCameraPos) {
      gl.uniform3fv(uniforms.uCameraPos, this._cameraPos);
    }
    if (uniforms.uAspect) {
      gl.uniform1f(uniforms.uAspect, this.height > 0 ? this.width / this.height : 1);
    }
    if (uniforms.uFisheyeFov) {
      gl.uniform1f(uniforms.uFisheyeFov, this._fovDegrees);
    }
    if (uniforms.uFisheyeEnabled) {
      gl.uniform1f(uniforms.uFisheyeEnabled, this._fisheyeEnabled ? 1 : 0);
    }
    if (uniforms.uFisheyeStrength) {
      gl.uniform1f(uniforms.uFisheyeStrength, this._fisheyeStrength);
    }
    if (uniforms.uSunDir) {
      gl.uniform3fv(uniforms.uSunDir, this._sunDirection);
    }
  }

  setProjectedShadowEnabled(enabled) {
    this._projectedShadowEnabled = enabled !== false;
  }

  setSelfShadowEnabled(enabled) {
    this._selfShadowEnabled = enabled !== false;
  }

  setSunLightEnabled(enabled) {
    this._sunLightEnabled = enabled !== false;
  }

  setSunTimeHours(hours) {
    const clamped = Math.max(SUN_TIME_MIN, Math.min(SUN_TIME_MAX, Number.isFinite(hours) ? hours : DEFAULT_SUN_TIME_HOURS));
    this._sunTimeHours = clamped;
    this._sunDirection = sunDirectionFromTime(clamped);
  }

  setBackgroundEnabled(enabled) {
    this._backgroundEnabled = enabled !== false;
  }

  _ensureShadowResources() {
    if (this._shadowFramebuffer && this._shadowTexture && this._selfShadowFramebuffer && this._selfShadowTexture) return;
    const gl = this.gl;
    const createDepthTarget = ({ compare = false } = {}) => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, compare ? gl.LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, compare ? gl.LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (compare) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
      }

      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return { framebuffer, texture };
    };

    if (!this._shadowFramebuffer || !this._shadowTexture) {
      const groundTarget = createDepthTarget({ compare: false });
      this._shadowFramebuffer = groundTarget.framebuffer;
      this._shadowTexture = groundTarget.texture;
    }
    if (!this._selfShadowFramebuffer || !this._selfShadowTexture) {
      const selfTarget = createDepthTarget({ compare: true });
      this._selfShadowFramebuffer = selfTarget.framebuffer;
      this._selfShadowTexture = selfTarget.texture;
    }
  }

  _computeShadowSetup(data, vertexCount) {
    const bounds = computeSolidBounds(data, vertexCount);
    if (!bounds) return null;

    const sunDir = this._sunDirection || SUN_DIRECTION;
    const baseCorners = buildBoundsCorners(bounds);
    const planeZ = bounds.min[2];
    const projectedCorners = baseCorners.map((corner) => projectPointToPlane(corner, planeZ, sunDir));
    const allCorners = baseCorners.concat(projectedCorners);
    const projectedShadow = buildProjectedShadowMesh(data, vertexCount, planeZ, sunDir);
    const lightFrame = buildShadowView(bounds, sunDir);
    if (!lightFrame) return null;
    const groundLightMVP = buildShadowLightMvp(lightFrame.view, allCorners, lightFrame.diagonal, 0.18, 0.5);
    const selfLightMVP = buildShadowLightMvp(lightFrame.view, baseCorners, lightFrame.diagonal, 0.08, 0.2);

    return {
      lightMVP: groundLightMVP,
      groundLightMVP,
      selfLightMVP,
      projectedShadow,
    };
  }

  prepareSunShadow(data, vertexCount) {
    if ((!this._projectedShadowEnabled && !this._selfShadowEnabled) || !this._sunLightEnabled) {
      return null;
    }
    this._ensureShadowResources();
    const setup = this._computeShadowSetup(data, vertexCount);
    if (!setup) return null;

    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthWrite = this._st.depthWrite;
    const prevCull = this._st.cullFace;
    const prevDepthFunc = this._st.depthFunc;
    const prevPolyOff = this._st.polygonOffset;
    const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);

    const renderShadowMap = (framebuffer, lightMVP, cullMode, factor, units) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.colorMask(false, false, false, false);
      this.setBlend(false);
      this.setDepthTest(true);
      this.setDepthWrite(true);
      this.setDepthFunc(gl.LESS);
      this.setCullFace(true);
      gl.cullFace(cullMode);
      this.setPolygonOffset(true);
      gl.polygonOffset(factor, units);

      gl.useProgram(this.programs[5]);
      gl.uniformMatrix4fv(this.uniforms[5].uLightMVP, false, lightMVP);
      gl.bindVertexArray(this.vaoSolid);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
      gl.bindVertexArray(null);
    };

    if (this._projectedShadowEnabled) {
      renderShadowMap(this._shadowFramebuffer, setup.groundLightMVP, gl.BACK, 1.5, 4.0);
    }
    if (this._selfShadowEnabled) {
      renderShadowMap(this._selfShadowFramebuffer, setup.selfLightMVP, gl.BACK, 1.5, 4.0);
    }

    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    this.setPolygonOffset(prevPolyOff);
    this.setDepthFunc(prevDepthFunc);
    this.setCullFace(prevCull);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthTest(prevDepthTest);
    this.setBlend(prevBlend);
    return setup;
  }

  drawProjectedShadowPlane(options = {}) {
    const setup = options.shadowSetup;
    if (!setup || !this._projectedShadowEnabled || !this._sunLightEnabled) return;
    const projected = setup.projectedShadow;
    const bounds = projected?.bounds;
    if (!bounds || !projected?.triangles || projected.triangles.length === 0) return;

    const shadowQuad = new Float32Array([
      bounds.minX, bounds.minY, bounds.planeZ,
      bounds.maxX, bounds.minY, bounds.planeZ,
      bounds.maxX, bounds.maxY, bounds.planeZ,
      bounds.minX, bounds.minY, bounds.planeZ,
      bounds.maxX, bounds.maxY, bounds.planeZ,
      bounds.minX, bounds.maxY, bounds.planeZ,
    ]);

    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthWrite = this._st.depthWrite;
    const prevDepthFunc = this._st.depthFunc;
    const prevCull = this._st.cullFace;
    const prevPolyOff = this._st.polygonOffset;
    const prevStencilTest = this._hasStencil ? gl.isEnabled(gl.STENCIL_TEST) : false;

    gl.viewport(0, 0, this.width, this.height);
    this.setBlend(true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.setDepthTest(true);
    this.setDepthFunc(gl.LEQUAL);
    this.setDepthWrite(false);
    this.setCullFace(true);
    gl.cullFace(gl.BACK);
    this.setPolygonOffset(true);
    gl.polygonOffset(-1, -2);

    if (this._hasStencil) {
      gl.enable(gl.STENCIL_TEST);
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilMask(0xFF);
      gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.colorMask(false, false, false, false);

      gl.useProgram(this.programs[1]);
      gl.uniformMatrix4fv(this.uniforms[1].uMVP, false, options.mvp);
      gl.uniform4f(this.uniforms[1].uColor, 0, 0, 0, 0);
      gl.uniform1f(this.uniforms[1].uDepthBias, 0);
      this._applyGlobalUniforms(1);

      gl.bindVertexArray(this.vaoLine);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, projected.triangles, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, projected.triangles.length / 3);
      gl.bindVertexArray(null);

      gl.colorMask(true, true, true, true);
      gl.stencilMask(0x00);
      gl.stencilFunc(gl.EQUAL, 1, 0xFF);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    }

    gl.useProgram(this.programs[6]);
    gl.uniformMatrix4fv(this.uniforms[6].uMVP, false, options.mvp);
    gl.uniformMatrix4fv(this.uniforms[6].uLightMVP, false, setup.lightMVP);
    gl.uniform4f(this.uniforms[6].uColor, 0.17, 0.20, 0.23, 0.24);
    if (this.uniforms[6].uProjectedShadowEnabled) {
      gl.uniform1f(this.uniforms[6].uProjectedShadowEnabled, 1);
    }
    this._applyGlobalUniforms(6);
    if (this.uniforms[6].uShadowMap) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTexture);
      gl.uniform1i(this.uniforms[6].uShadowMap, 1);
      gl.activeTexture(gl.TEXTURE0);
    }

    gl.bindVertexArray(this.vaoLine);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, shadowQuad, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, shadowQuad.length / 3);
    gl.bindVertexArray(null);
    if (this.uniforms[6].uShadowMap) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }
    if (this._hasStencil) {
      gl.stencilMask(0xFF);
      gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      if (!prevStencilTest) {
        gl.disable(gl.STENCIL_TEST);
      }
    }

    this.setPolygonOffset(prevPolyOff);
    this.setCullFace(prevCull);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
    this.setDepthTest(prevDepthTest);
    this.setBlend(prevBlend);
  }

  _drawAngleBackground(color) {
    if (!this._backgroundEnabled) return;
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthWrite = this._st.depthWrite;
    const prevCull = this._st.cullFace;

    this.setBlend(false);
    this.setDepthTest(false);
    this.setDepthWrite(false);
    this.setCullFace(false);

    gl.useProgram(this.programs[4]);
    if (this.uniforms[4].uColor) {
      gl.uniform4f(this.uniforms[4].uColor, ...(color || [0.15, 0.15, 0.15, 1]));
    }
    this._applyGlobalUniforms(4);
    gl.bindVertexArray(this.vaoFullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    this.setCullFace(prevCull);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthTest(prevDepthTest);
    this.setBlend(prevBlend);
  }

  _setDepthFuncOption(depthFunc, fallback = 'lequal') {
    const selected = depthFunc || fallback;
    if (selected === 'greater') {
      this.setDepthFunc(this.gl.GREATER);
    } else if (selected === 'less') {
      this.setDepthFunc(this.gl.LESS);
    } else if (selected === 'equal') {
      this.setDepthFunc(this.gl.EQUAL);
    } else if (selected === 'gequal') {
      this.setDepthFunc(this.gl.GEQUAL);
    } else if (selected === 'always') {
      this.setDepthFunc(this.gl.ALWAYS);
    } else {
      this.setDepthFunc(this.gl.LEQUAL);
    }
  }

  drawTriangleDepthPrepass(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthFunc = this._st.depthFunc;
    const prevCull = this._st.cullFace;
    const prevDepthWrite = this._st.depthWrite;
    const prevPolyOff = this._st.polygonOffset;

    gl.viewport(0, 0, this.width, this.height);
    this.setBlend(false);
    this.setDepthTest(true);
    this.setDepthFunc(gl.LESS);
    this.setCullFace(true);
    gl.cullFace(gl.BACK);
    this.setDepthWrite(true);
    if (options.polygonOffset) {
      this.setPolygonOffset(true);
      gl.polygonOffset(options.polygonOffset[0], options.polygonOffset[1]);
    } else {
      this.setPolygonOffset(false);
    }

    gl.colorMask(false, false, false, false);
    gl.useProgram(this.programs[0]);
    gl.uniformMatrix4fv(this.uniforms[0].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[0].uColor, 0, 0, 0, 0);
    this._applyGlobalUniforms(0);

    gl.bindVertexArray(this.vaoSolid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);

    this.setPolygonOffset(prevPolyOff);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
    this.setDepthTest(prevDepthTest);
    this.setCullFace(prevCull);
    this.setBlend(prevBlend);
  }

  drawTriangleBuffer(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthFunc = this._st.depthFunc;
    const prevDepthWrite = this._st.depthWrite;
    const prevCull = this._st.cullFace;
    const prevPolyOff = this._st.polygonOffset;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    this.setDepthTest(options.depthTest !== false);
    this._setDepthFuncOption(options.depthFunc, 'lequal');
    if (Object.prototype.hasOwnProperty.call(options, 'depthWrite')) {
      this.setDepthWrite(!!options.depthWrite);
    }
    this.setCullFace(true);
    gl.cullFace(gl.BACK);

    if (options.polygonOffset) {
      this.setPolygonOffset(true);
      gl.polygonOffset(options.polygonOffset[0], options.polygonOffset[1]);
    }

    gl.useProgram(this.programs[0]);
    gl.uniformMatrix4fv(this.uniforms[0].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[0].uColor, ...(options.color || [1, 1, 1, 1]));
    this._applyGlobalUniforms(0);
    if (this.uniforms[0].uLightMVP) {
      gl.uniformMatrix4fv(this.uniforms[0].uLightMVP, false, options.shadowSetup?.selfLightMVP || options.shadowSetup?.lightMVP || options.mvp);
    }
    if (this.uniforms[0].uSunLightEnabled) {
      gl.uniform1f(this.uniforms[0].uSunLightEnabled, options.sunLightEnabled !== false && this._sunLightEnabled ? 1 : 0);
    }
    if (this.uniforms[0].uSelfShadowEnabled) {
      gl.uniform1f(this.uniforms[0].uSelfShadowEnabled, options.shadowSetup && options.selfShadowEnabled !== false && this._selfShadowEnabled ? 1 : 0);
    }
    if (this.uniforms[0].uShadowMap) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, options.shadowSetup ? (this._selfShadowTexture || this._shadowTexture) : null);
      gl.uniform1i(this.uniforms[0].uShadowMap, 1);
      gl.activeTexture(gl.TEXTURE0);
    }

    gl.bindVertexArray(this.vaoSolid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);
    if (this.uniforms[0].uShadowMap) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }

    this.setPolygonOffset(prevPolyOff);
    this.setCullFace(prevCull);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
    this.setDepthTest(prevDepthTest);
    this.setBlend(prevBlend);
  }

  drawStaticTriangleBuffer(resource, options) {
    if (!resource || resource.vertexCount <= 0) return;
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthFunc = this._st.depthFunc;
    const prevDepthWrite = this._st.depthWrite;
    const prevCull = this._st.cullFace;
    const prevPolyOff = this._st.polygonOffset;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    this.setDepthTest(options.depthTest !== false);
    this._setDepthFuncOption(options.depthFunc, 'lequal');
    if (Object.prototype.hasOwnProperty.call(options, 'depthWrite')) {
      this.setDepthWrite(!!options.depthWrite);
    }
    this.setCullFace(true);
    gl.cullFace(gl.BACK);

    if (options.polygonOffset) {
      this.setPolygonOffset(true);
      gl.polygonOffset(options.polygonOffset[0], options.polygonOffset[1]);
    }

    gl.useProgram(this.programs[0]);
    gl.uniformMatrix4fv(this.uniforms[0].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[0].uColor, ...(options.color || [1, 1, 1, 1]));
    this._applyGlobalUniforms(0);

    gl.bindVertexArray(resource.vao);
    gl.drawArrays(gl.TRIANGLES, 0, resource.vertexCount);
    gl.bindVertexArray(null);

    this.setPolygonOffset(prevPolyOff);
    this.setCullFace(prevCull);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
    this.setDepthTest(prevDepthTest);
    this.setBlend(prevBlend);
  }

  drawTriangleBufferNormalColor(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthFunc = this._st.depthFunc;
    const prevDepthWrite = this._st.depthWrite;
    const prevCull = this._st.cullFace;
    const prevPolyOff = this._st.polygonOffset;

    gl.viewport(0, 0, this.width, this.height);
    this.setBlend(false);
    this.setDepthTest(options.depthTest !== false);
    this._setDepthFuncOption(options.depthFunc, 'lequal');
    if (Object.prototype.hasOwnProperty.call(options, 'depthWrite')) {
      this.setDepthWrite(!!options.depthWrite);
    }
    this.setCullFace(true);
    gl.cullFace(gl.BACK);

    if (options.polygonOffset) {
      this.setPolygonOffset(true);
      gl.polygonOffset(options.polygonOffset[0], options.polygonOffset[1]);
    }

    gl.useProgram(this.programs[3]);
    gl.uniformMatrix4fv(this.uniforms[3].uMVP, false, options.mvp);
    this._applyGlobalUniforms(3);

    gl.bindVertexArray(this.vaoSolid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);

    this.setPolygonOffset(prevPolyOff);
    this.setCullFace(prevCull);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
    this.setDepthTest(prevDepthTest);
    this.setBlend(prevBlend);
  }

  drawLineBuffer(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthWrite = this._st.depthWrite;
    const prevDepthFunc = this._st.depthFunc;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    this.setDepthTest(options.depthTest !== false);

    this._setDepthFuncOption(options.depthFunc, 'lequal');

    if (Object.prototype.hasOwnProperty.call(options, 'depthWrite')) {
      this.setDepthWrite(!!options.depthWrite);
    }

    gl.useProgram(this.programs[1]);
    gl.uniformMatrix4fv(this.uniforms[1].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[1].uColor, ...(options.color || [1, 1, 1, 1]));
    gl.uniform1f(this.uniforms[1].uDepthBias, options.depthBias || 0);
    this._applyGlobalUniforms(1);
    gl.lineWidth(options.lineWidth || 1);

    gl.bindVertexArray(this.vaoLine);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINES, 0, vertexCount);
    gl.bindVertexArray(null);
    gl.uniform1f(this.uniforms[1].uDepthBias, 0);

    this.setBlend(prevBlend);
    this.setDepthTest(prevDepthTest);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
  }

  drawStaticLineBuffer(resource, options) {
    if (!resource || resource.vertexCount <= 0) return;
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthWrite = this._st.depthWrite;
    const prevDepthFunc = this._st.depthFunc;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    this.setDepthTest(options.depthTest !== false);
    this._setDepthFuncOption(options.depthFunc, 'lequal');
    if (Object.prototype.hasOwnProperty.call(options, 'depthWrite')) {
      this.setDepthWrite(!!options.depthWrite);
    }

    gl.useProgram(this.programs[1]);
    gl.uniformMatrix4fv(this.uniforms[1].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[1].uColor, ...(options.color || [1, 1, 1, 1]));
    gl.uniform1f(this.uniforms[1].uDepthBias, options.depthBias || 0);
    this._applyGlobalUniforms(1);
    gl.lineWidth(options.lineWidth || 1);

    gl.bindVertexArray(resource.vao);
    gl.drawArrays(gl.LINES, 0, resource.vertexCount);
    gl.bindVertexArray(null);
    gl.uniform1f(this.uniforms[1].uDepthBias, 0);

    this.setBlend(prevBlend);
    this.setDepthTest(prevDepthTest);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
  }

  drawPointBuffer(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.useProgram(this.programs[1]);
    gl.uniformMatrix4fv(this.uniforms[1].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[1].uColor, ...(options.color || [1, 1, 1, 1]));
    gl.uniform1f(this.uniforms[1].uPointSize, options.pointSize || 1);
    gl.uniform1f(this.uniforms[1].uDepthBias, 0);
    this._applyGlobalUniforms(1);

    gl.bindVertexArray(this.vaoLine);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, vertexCount);
    gl.bindVertexArray(null);

    this.setBlend(prevBlend);
  }

  execute(commandBuffer, length) {
    const gl = this.gl;
    const i32View = new Int32Array(commandBuffer.buffer, commandBuffer.byteOffset, length);

    gl.viewport(0, 0, this.width, this.height);

    let pos = 0;
    while (pos < length) {
      const cmd = i32View[pos];
      pos++;

      switch (cmd) {
        case CMD_END:
          return;

        case CMD_CLEAR: {
          const r = this._backgroundEnabled ? commandBuffer[pos] : 1;
          const g = this._backgroundEnabled ? commandBuffer[pos + 1] : 1;
          const b = this._backgroundEnabled ? commandBuffer[pos + 2] : 1;
          const a = commandBuffer[pos + 3];
          pos += 4;
          gl.clearColor(r, g, b, a);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          this._drawAngleBackground([r, g, b, a]);
          break;
        }

        case CMD_SET_PROGRAM: {
          const idx = i32View[pos];
          pos++;
          this.currentProgram = idx;
          gl.useProgram(this.programs[idx]);
          this._applyGlobalUniforms(idx);
          if (this.uniforms[idx].uSunLightEnabled) {
            gl.uniform1f(this.uniforms[idx].uSunLightEnabled, idx === 0 && this._sunLightEnabled ? 1 : 0);
          }
          if (this.uniforms[idx].uSelfShadowEnabled) {
            gl.uniform1f(this.uniforms[idx].uSelfShadowEnabled, 0);
          }
          break;
        }

        case CMD_SET_MATRIX: {
          const mat = commandBuffer.subarray(pos, pos + 16);
          pos += 16;
          if (this.currentProgram >= 0) {
            gl.uniformMatrix4fv(this.uniforms[this.currentProgram].uMVP, false, mat);
          }
          break;
        }

        case CMD_SET_COLOR: {
          const r = commandBuffer[pos];
          const g = commandBuffer[pos + 1];
          const b = commandBuffer[pos + 2];
          const a = commandBuffer[pos + 3];
          pos += 4;
          if (this.currentProgram >= 0) {
            gl.uniform4f(this.uniforms[this.currentProgram].uColor, r, g, b, a);
          }
          break;
        }

        case CMD_DRAW_TRIANGLES: {
          const vertexCount = i32View[pos];
          pos++;
          const floatCount = vertexCount * 6;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;

          gl.bindVertexArray(this.vaoSolid);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
          gl.bindVertexArray(null);
          break;
        }

        case CMD_DRAW_LINES: {
          const vertexCount = i32View[pos];
          pos++;
          const floatCount = vertexCount * 3;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;

          gl.bindVertexArray(this.vaoLine);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.LINES, 0, vertexCount);
          gl.bindVertexArray(null);
          break;
        }

        case CMD_DRAW_POINTS: {
          const vertexCount = i32View[pos];
          pos++;
          const ptSize = commandBuffer[pos];
          pos++;
          const floatCount = vertexCount * 3;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;

          if (this.currentProgram >= 0) {
            gl.uniform1f(this.uniforms[this.currentProgram].uPointSize, ptSize);
          }
          gl.bindVertexArray(this.vaoLine);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.POINTS, 0, vertexCount);
          gl.bindVertexArray(null);
          break;
        }

        case CMD_SET_LINE_DASH: {
          // Line dash is not natively supported in WebGL; skip the parameters.
          pos += 2;
          break;
        }

        case CMD_SET_DEPTH_TEST: {
          const enabled = i32View[pos];
          pos++;
          this.setDepthTest(!!enabled);
          break;
        }

        case CMD_SET_LINE_WIDTH: {
          const w = commandBuffer[pos];
          pos++;
          gl.lineWidth(w);
          break;
        }

        case CMD_SET_DEPTH_WRITE: {
          const enabled = i32View[pos];
          pos++;
          this.setDepthWrite(!!enabled);
          break;
        }

        default:
          // Unknown command; stop processing to avoid corrupt reads
          console.warn('WebGLExecutor: unknown command', cmd, 'at offset', pos - 1);
          return;
      }
    }
  }

  dispose() {
    const gl = this.gl;
    for (const resource of [...this._ownedStaticBuffers]) {
      this.deleteStaticBuffer(resource);
    }
    if (this._shadowFramebuffer) gl.deleteFramebuffer(this._shadowFramebuffer);
    if (this._shadowTexture) gl.deleteTexture(this._shadowTexture);
    gl.deleteVertexArray(this.vaoFullscreen);
    gl.deleteVertexArray(this.vaoSolid);
    gl.deleteVertexArray(this.vaoLine);
    gl.deleteBuffer(this.vbo);
    for (const p of this.programs) {
      gl.deleteProgram(p);
    }
    this.programs = [];
    this.uniforms = [];
    this.currentProgram = -1;
  }
}
