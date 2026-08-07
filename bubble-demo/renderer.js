import { v3, m3 } from "./math.js?v=20260807-7";
import {
  createThinFilmLut,
  createFlowNoiseTexture,
  loadHdrTexture
} from "./optics.js?v=20260807-7";

const ENVIRONMENTS = [
  "assets/envmap/sunny_vondelpark_4k.hdr"
];

const fullScreenVertex = `#version 300 es
precision highp float;
const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);
out vec2 vUv;
void main() {
  vec2 p = POSITIONS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const sphereVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProjection;
uniform mat3 uShape;
uniform mat3 uNormalMatrix;
uniform vec3 uCenter;
out vec3 vWorldPosition;
out vec3 vWorldNormal;
void main() {
  vec3 offset = uShape * aPosition;
  vWorldPosition = uCenter + offset;
  vWorldNormal = normalize(uNormalMatrix * aNormal);
  gl_Position = uViewProjection * vec4(vWorldPosition, 1.0);
}`;

const opticalFunctions = `
const float PI = 3.14159265358979323846;
uniform sampler2D uEnvironment;
uniform sampler2D uFlowNoise;
uniform sampler2D uThinFilmLut;
uniform bool uWhiteFurnace;
uniform bool uFlowEnabled;
uniform float uFlowNoiseScale;
uniform float uFlowSpeed;
uniform float uFlowAmplitude;
uniform float uTime;
uniform float uFilmThickness;
uniform float uEta2;

vec2 directionToEquirectUv(vec3 direction) {
  direction = normalize(direction);
  return vec2(
    atan(direction.z, direction.x) / (2.0 * PI) + 0.5,
    0.5 - asin(clamp(direction.y, -1.0, 1.0)) / PI
  );
}

vec3 sampleEnvironment(vec3 direction) {
  if (uWhiteFurnace) return vec3(0.5);
  return min(texture(uEnvironment, directionToEquirectUv(direction)).rgb, vec3(60000.0));
}

float safeProjectionDenominator(float value) {
  return value >= 0.0 ? max(value, 0.001) : min(value, -0.001);
}

float sampleFlowNoise(vec3 surfaceDirection) {
  float projectionScale = 0.1 * uFlowNoiseScale;
  float flowTime = uTime * uFlowSpeed;
  float dx = safeProjectionDenominator(surfaceDirection.x);
  float dy = safeProjectionDenominator(surfaceDirection.y);
  float dz = safeProjectionDenominator(surfaceDirection.z);
  float noiseX = texture(uFlowNoise, 0.5 + projectionScale * surfaceDirection.yz / dx +
    vec2(flowTime * 0.23, flowTime * 0.07)).r;
  float noiseY = texture(uFlowNoise, 0.5 + projectionScale * surfaceDirection.zx / dy +
    vec2(-flowTime * 0.11, flowTime * 0.19)).r;
  float noiseZ = texture(uFlowNoise, 0.5 + projectionScale * surfaceDirection.xy / dz +
    vec2(flowTime * 0.05, -flowTime * 0.17)).r;
  vec3 weights = surfaceDirection * surfaceDirection;
  return dot(vec3(noiseX, noiseY, noiseZ), weights) /
    max(weights.x + weights.y + weights.z, 0.0001);
}

vec3 evaluateThinFilm(vec3 eye, vec3 opticalNormal, vec3 outwardNormal) {
  float cosTheta = clamp(dot(-eye, opticalNormal), 0.0, 1.0);
  float thickness = uFilmThickness;
  if (uFlowEnabled) {
    thickness += (sampleFlowNoise(outwardNormal) * 2.0 - 1.0) * uFlowAmplitude;
  }
  thickness = clamp(thickness, 0.0, 1200.0);
  vec2 parameters = vec2(thickness / 1200.0, cosTheta);
  vec2 uv = (parameters * 255.0 + 0.5) / 256.0;
  return texture(uThinFilmLut, uv).rgb;
}
`;

const sphereFragment = `#version 300 es
precision highp float;
precision highp int;
${opticalFunctions}
uniform vec3 uCameraPosition;
uniform vec3 uCenter;
uniform mat3 uInverseShape;
uniform bool uBackTransmission;
uniform bool uBackReflection;
uniform bool uFrontTransmission;
uniform bool uFrontReflection;
uniform int uClipPlaneCount;
uniform vec4 uClipPlanes[6];
uniform int uBlendChannel;
uniform float uNormalBlendWidth;
uniform float uNormalBlendStrength;
uniform bool uSelected;
in vec3 vWorldPosition;
in vec3 vWorldNormal;
out vec4 fragColor;

bool clipped(vec3 position) {
  for (int i = 0; i < 6; ++i) {
    if (i >= uClipPlaneCount) break;
    if (dot(vec4(position, 1.0), uClipPlanes[i]) > 0.0) return true;
  }
  return false;
}

vec3 resolveSurfaceNormal(vec3 position, vec3 normal) {
  vec3 target = normal;
  float totalWeight = 1.0;
  float edgeWeight = 0.0;
  for (int i = 0; i < 6; ++i) {
    if (i >= uClipPlaneCount) break;
    vec4 plane = uClipPlanes[i];
    float weight = 1.0 - smoothstep(0.0, max(uNormalBlendWidth, 0.0001),
      max(-dot(vec4(position, 1.0), plane), 0.0));
    vec3 planeNormal = normalize(plane.xyz);
    if (dot(planeNormal, normal) < 0.0) planeNormal = -planeNormal;
    target += planeNormal * weight;
    totalWeight += weight;
    edgeWeight = max(edgeWeight, weight);
  }
  return normalize(mix(normal, normalize(target / totalWeight), edgeWeight * uNormalBlendStrength));
}

void main() {
  if (clipped(vWorldPosition)) discard;
  vec3 eye = normalize(vWorldPosition - uCameraPosition);
  vec3 frontOutward = resolveSurfaceNormal(vWorldPosition, normalize(vWorldNormal));
  if (dot(frontOutward, -eye) <= 0.0) discard;
  vec3 frontF = evaluateThinFilm(eye, frontOutward, frontOutward);

  vec3 localOrigin = uInverseShape * (vWorldPosition - uCenter);
  vec3 localDirection = uInverseShape * eye;
  float a = dot(localDirection, localDirection);
  float b = 2.0 * dot(localOrigin, localDirection);
  float c = dot(localOrigin, localOrigin) - 1.0;
  float discriminant = max(b * b - 4.0 * a * c, 0.0);
  float backDistance = (-b + sqrt(discriminant)) / max(2.0 * a, 0.000001);
  vec3 backPosition = vWorldPosition + eye * max(backDistance, 0.0);
  vec3 backLocal = uInverseShape * (backPosition - uCenter);
  vec3 backOutward = normalize(transpose(uInverseShape) * backLocal);
  bool backPresent = !clipped(backPosition);
  vec3 backF = backPresent
    ? evaluateThinFilm(eye, -backOutward, backOutward)
    : vec3(0.0);

  vec3 backT = backPresent && uBackTransmission ? vec3(1.0) - backF : vec3(0.0);
  vec3 frontT = uFrontTransmission ? vec3(1.0) - frontF : vec3(0.0);
  if (!backPresent) backT = vec3(1.0);
  vec3 totalT = backT * frontT;

  vec3 emitted = vec3(0.0);
  if (backPresent && uBackReflection && uFrontTransmission) {
    vec3 reflectedBack = sampleEnvironment(reflect(eye, -backOutward));
    emitted += reflectedBack * backF * frontT;
  }
  if (uFrontReflection) {
    vec3 reflectedFront = sampleEnvironment(reflect(eye, frontOutward));
    emitted += reflectedFront * frontF;
  }
  if (uSelected) {
    float outline = pow(1.0 - clamp(dot(-eye, frontOutward), 0.0, 1.0), 8.0);
    emitted += vec3(0.18, 0.58, 1.0) * outline * 1.8;
  }
  int channel = clamp(uBlendChannel, 0, 2);
  fragColor = vec4(emitted, 1.0 - totalT[channel]);
}`;

const backgroundFragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uEnvironment;
uniform bool uWhiteFurnace;
uniform bool uBubbleOnly;
uniform vec3 uCameraForward;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform float uTanHalfFov;
uniform float uAspect;
const float PI = 3.14159265358979323846;
vec2 directionToUv(vec3 direction) {
  direction = normalize(direction);
  return vec2(
    atan(direction.z, direction.x) / (2.0 * PI) + 0.5,
    0.5 - asin(clamp(direction.y, -1.0, 1.0)) / PI
  );
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 ray = normalize(
    uCameraForward +
    uCameraRight * (p.x * uTanHalfFov * uAspect) +
    uCameraUp * (p.y * uTanHalfFov)
  );
  vec3 color = uBubbleOnly ? vec3(1.0) :
    (uWhiteFurnace ? vec3(0.5) : min(texture(uEnvironment, directionToUv(ray)).rgb, vec3(60000.0)));
  fragColor = vec4(color, 0.0);
}`;

const connectionVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec2 aUv;
uniform mat4 uViewProjection;
uniform vec3 uCenter;
uniform vec3 uTangent;
uniform vec3 uBitangent;
uniform vec3 uAxis;
uniform float uRadius;
uniform float uSagittaRatio;
uniform float uBorderRatio;
uniform bool uPlateauMode;
uniform float uNormalBlendStrength;
uniform float uPlateauBorderStrength;
out vec3 vWorldPosition;
out vec3 vWorldNormal;

void main() {
  vec3 localPosition;
  vec3 localNormal;
  if (uPlateauMode) {
    float ringAngle = aUv.x * 6.28318530718;
    vec2 radial = vec2(cos(ringAngle), sin(ringAngle));
    float segmentPosition = min(aUv.y * 3.0, 2.999999);
    float arcIndex = floor(segmentPosition);
    float arcParameter = fract(segmentPosition);
    float centerAngle = -arcIndex * 2.09439510239;
    float circleAngle = centerAngle + 3.14159265359 +
      mix(-0.52359877559, 0.52359877559, arcParameter);
    vec2 circleCenter = 2.0 * vec2(cos(centerAngle), sin(centerAngle));
    vec2 circleDirection = vec2(cos(circleAngle), sin(circleAngle));
    vec2 crossSection = circleCenter + 1.73205080757 * circleDirection;
    vec2 crossNormal = -circleDirection;
    float radialDistance = uRadius * (1.0 + uBorderRatio * crossSection.x);
    float axialDistance = uRadius * uBorderRatio * crossSection.y;
    localPosition = vec3(radial * radialDistance, axialDistance);
    localNormal = normalize(vec3(radial * crossNormal.x, crossNormal.y));
  } else {
    vec2 xy = aPosition.xy * uRadius;
    float z = 0.0;
    localNormal = vec3(0.0, 0.0, 1.0);
    if (abs(uSagittaRatio) > 0.0001) {
      float center = (uSagittaRatio * uSagittaRatio - 1.0) / (2.0 * uSagittaRatio);
      float sphereRadius = abs((uSagittaRatio * uSagittaRatio + 1.0) / (2.0 * uSagittaRatio));
      vec2 normalized = aPosition.xy;
      float normalizedZ = center + sign(uSagittaRatio) *
        sqrt(max(sphereRadius * sphereRadius - dot(normalized, normalized), 0.0));
      z = normalizedZ * uRadius;
      localNormal = normalize(vec3(normalized, normalizedZ - center));
    }
    localPosition = vec3(xy, z);
  }
  vWorldPosition = uCenter +
    uTangent * localPosition.x +
    uBitangent * localPosition.y +
    uAxis * localPosition.z;
  vWorldNormal = normalize(
    uTangent * localNormal.x +
    uBitangent * localNormal.y +
    uAxis * localNormal.z
  );
  gl_Position = uViewProjection * vec4(vWorldPosition, 1.0);
}`;

const connectionFragment = `#version 300 es
precision highp float;
${opticalFunctions}
uniform vec3 uCameraPosition;
uniform bool uPlateauMode;
uniform vec3 uCenter;
uniform vec3 uAxis;
uniform float uRadius;
uniform float uNormalBlendStrength;
uniform float uPlateauBorderStrength;
in vec3 vWorldPosition;
in vec3 vWorldNormal;
layout(location=0) out vec4 outOpticalDepth;
layout(location=1) out vec4 outWeightedReflection;
void main() {
  vec3 eye = normalize(vWorldPosition - uCameraPosition);
  vec3 normal = normalize(vWorldNormal);
  float edge = uPlateauMode ? 1.0 : smoothstep(0.68, 1.0, length(vWorldPosition - uCenter) / max(uRadius, 0.0001));
  vec3 seamNormal = normalize(mix(normal, uPlateauMode ? normal : uAxis, edge * uNormalBlendStrength));
  normal = seamNormal;
  if (dot(normal, -eye) < 0.0) normal = -normal;
  vec3 reflectance;
  if (uPlateauMode) {
    float cosine = clamp(dot(-eye, normal), 0.0, 1.0);
    float f0Amplitude = (1.0 - uEta2) / (1.0 + uEta2);
    float f0 = f0Amplitude * f0Amplitude;
    float interfaceF = f0 + (1.0 - f0) * pow(1.0 - cosine, 5.0);
    reflectance = vec3(2.0 * interfaceF / (1.0 + interfaceF)) * uPlateauBorderStrength;
  } else {
    reflectance = evaluateThinFilm(eye, normal, normal);
  }
  vec3 transmittance = max(vec3(1.0) - reflectance, vec3(0.0001));
  vec3 opticalDepth = -log(transmittance);
  vec3 reflected = sampleEnvironment(reflect(eye, normal));
  outOpticalDepth = vec4(opticalDepth, 0.0);
  outWeightedReflection = vec4(reflected * opticalDepth, 0.0);
}`;

const finalFragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uOpticalDepth;
uniform sampler2D uWeightedReflection;
uniform bool uWhiteFurnace;
uniform bool uConnectionTransmission;
uniform bool uConnectionReflection;
uniform vec4 uTouchIndicator;
uniform vec2 uResolution;
uniform bool uBubbleOnly;
uniform bool uDepthOfFieldEnabled;
uniform int uDepthOfFieldMode;
uniform float uDepthOfFieldFocusDistance;
uniform float uDepthOfFieldBackgroundDistance;
uniform float uDepthOfFieldStrength;
vec3 acesToneMap(vec3 color) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  color = clamp(color, vec3(0.0), vec3(60000.0));
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);
}
void main() {
  vec4 sceneSample = texture(uScene, vUv);
  vec3 scene = sceneSample.rgb;
  vec3 tau = texture(uOpticalDepth, vUv).rgb;
  vec3 weighted = texture(uWeightedReflection, vUv).rgb;
  vec3 transmission = exp(-tau);
  vec3 averageEnvironment = vec3(0.0);
  averageEnvironment.r = tau.r > 0.00001 ? weighted.r / tau.r : 0.0;
  averageEnvironment.g = tau.g > 0.00001 ? weighted.g / tau.g : 0.0;
  averageEnvironment.b = tau.b > 0.00001 ? weighted.b / tau.b : 0.0;
  vec3 color = scene;
  if (uConnectionTransmission) color *= transmission;
  else color *= vec3(0.0);
  if (uConnectionReflection) color += averageEnvironment * (vec3(1.0) - transmission);
  if (uDepthOfFieldEnabled && uDepthOfFieldStrength > 0.001) {
    float bubbleMask = clamp(sceneSample.a + dot(vec3(0.3333), 1.0 - transmission), 0.0, 1.0);
    float bubbleDefocus = abs(54.0 - uDepthOfFieldFocusDistance) / max(uDepthOfFieldFocusDistance, 1.0);
    float backgroundDefocus = abs(uDepthOfFieldBackgroundDistance - uDepthOfFieldFocusDistance) /
      max(uDepthOfFieldFocusDistance, 1.0);
    float radius = clamp(mix(backgroundDefocus, bubbleDefocus, bubbleMask) *
      18.0 * uDepthOfFieldStrength, 0.0, 10.0);
    vec3 blur = vec3(0.0);
    float samples = uDepthOfFieldMode == 1 ? 8.0 : 16.0;
    for (int i = 0; i < 16; ++i) {
      if (float(i) >= samples) break;
      float angle = float(i) * 2.39996323;
      float ring = sqrt((float(i) + 0.5) / samples);
      vec2 offset = vec2(cos(angle), sin(angle)) * ring * radius / uResolution;
      blur += texture(uScene, clamp(vUv + offset, vec2(0.0), vec2(1.0))).rgb;
    }
    blur /= samples;
    color = mix(color, blur, smoothstep(0.5, 2.0, radius) * 0.82);
  }
  if (!uWhiteFurnace) color = acesToneMap(color);
  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
  if (uBubbleOnly && sceneSample.a < 0.001 && dot(tau, tau) < 0.000001) color = vec3(1.0);
  if (uTouchIndicator.w > 0.5) {
    vec2 pixel = vUv * uResolution;
    float distanceToTouch = length(pixel - uTouchIndicator.xy);
    float ring = smoothstep(uTouchIndicator.z + 2.0, uTouchIndicator.z, distanceToTouch) *
      smoothstep(uTouchIndicator.z - 4.0, uTouchIndicator.z - 1.0, distanceToTouch);
    color = mix(color, vec3(0.55, 0.78, 1.0), ring * 0.7);
  }
  fragColor = vec4(color, 1.0);
}`;

const fxaaFragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform vec2 uInverseResolution;
uniform bool uEnabled;

float luminance(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec3 rgbM = texture(uColor, vUv).rgb;
  if (!uEnabled) {
    fragColor = vec4(rgbM, 1.0);
    return;
  }
  vec3 rgbNW = texture(uColor, vUv + vec2(-1.0,  1.0) * uInverseResolution).rgb;
  vec3 rgbNE = texture(uColor, vUv + vec2( 1.0,  1.0) * uInverseResolution).rgb;
  vec3 rgbSW = texture(uColor, vUv + vec2(-1.0, -1.0) * uInverseResolution).rgb;
  vec3 rgbSE = texture(uColor, vUv + vec2( 1.0, -1.0) * uInverseResolution).rgb;
  float lumaM = luminance(rgbM);
  float lumaNW = luminance(rgbNW);
  float lumaNE = luminance(rgbNE);
  float lumaSW = luminance(rgbSW);
  float lumaSE = luminance(rgbSE);
  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  if (lumaMax - lumaMin < max(0.0312, lumaMax * 0.063)) {
    fragColor = vec4(rgbM, 1.0);
    return;
  }
  vec2 direction;
  direction.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
  direction.y =  ((lumaNW + lumaSW) - (lumaNE + lumaSE));
  float reduction = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
  float inverseMinimum = 1.0 / (min(abs(direction.x), abs(direction.y)) + reduction);
  direction = clamp(direction * inverseMinimum, vec2(-8.0), vec2(8.0)) * uInverseResolution;
  vec3 rgbA = 0.5 * (
    texture(uColor, vUv + direction * (1.0 / 3.0 - 0.5)).rgb +
    texture(uColor, vUv + direction * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture(uColor, vUv + direction * -0.5).rgb +
    texture(uColor, vUv + direction * 0.5).rgb);
  float lumaB = luminance(rgbB);
  fragColor = vec4((lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB, 1.0);
}`;

function compileProgram(gl, vertexSource, fragmentSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  return program;
}

function uniformLocations(gl, program, names) {
  const result = {};
  names.forEach((name) => {
    result[name] = gl.getUniformLocation(program, name);
  });
  return result;
}

function createSphereMesh(gl, longitudeSegments = 64, latitudeSegments = 32) {
  const vertices = [];
  const indices = [];
  for (let latitude = 0; latitude <= latitudeSegments; latitude += 1) {
    const theta = latitude / latitudeSegments * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    for (let longitude = 0; longitude <= longitudeSegments; longitude += 1) {
      const phi = longitude / longitudeSegments * Math.PI * 2;
      const x = sinTheta * Math.cos(phi);
      const y = cosTheta;
      const z = sinTheta * Math.sin(phi);
      vertices.push(x, y, z, x, y, z);
    }
  }
  for (let latitude = 0; latitude < latitudeSegments; latitude += 1) {
    for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
      const first = latitude * (longitudeSegments + 1) + longitude;
      const second = first + longitudeSegments + 1;
      indices.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }
  return createIndexedMesh(gl, vertices, indices, 6, [
    { location: 0, size: 3, offset: 0 },
    { location: 1, size: 3, offset: 3 }
  ]);
}

function createDiskMesh(gl, segments = 48) {
  const vertices = [0, 0, 0, .5, .5];
  const indices = [];
  for (let segment = 0; segment <= segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    vertices.push(x, y, 0, x * .5 + .5, y * .5 + .5);
  }
  for (let segment = 0; segment < segments; segment += 1) {
    indices.push(0, segment + 1, segment + 2);
  }
  return createIndexedMesh(gl, vertices, indices, 5, [
    { location: 0, size: 3, offset: 0 },
    { location: 1, size: 2, offset: 3 }
  ]);
}

function createPlateauMesh(gl, ringSegments = 48, crossSegments = 24) {
  const vertices = [];
  const indices = [];
  for (let ring = 0; ring <= ringSegments; ring += 1) {
    for (let cross = 0; cross <= crossSegments; cross += 1) {
      vertices.push(0, 0, 0, ring / ringSegments, cross / crossSegments);
    }
  }
  for (let ring = 0; ring < ringSegments; ring += 1) {
    for (let cross = 0; cross < crossSegments; cross += 1) {
      const first = ring * (crossSegments + 1) + cross;
      const second = first + crossSegments + 1;
      indices.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }
  return createIndexedMesh(gl, vertices, indices, 5, [
    { location: 0, size: 3, offset: 0 },
    { location: 1, size: 2, offset: 3 }
  ]);
}

function createIndexedMesh(gl, vertices, indices, strideFloats, attributes) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  attributes.forEach((attribute) => {
    gl.enableVertexAttribArray(attribute.location);
    gl.vertexAttribPointer(
      attribute.location,
      attribute.size,
      gl.FLOAT,
      false,
      strideFloats * 4,
      attribute.offset * 4
    );
  });
  gl.bindVertexArray(null);
  return { vao, count: indices.length };
}

function createColorTexture(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  return texture;
}

function createDisplayTexture(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return texture;
}

function setTexture(gl, location, unit, texture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(location, unit);
}

export class BubbleRenderer {
  constructor(canvas, simulation, callbacks = {}) {
    this.canvas = canvas;
    this.simulation = simulation;
    this.callbacks = callbacks;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      powerPreference: "high-performance"
    });
    if (!this.gl) throw new Error("WebGL2 is unavailable");
    const gl = this.gl;
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("EXT_color_buffer_float is unavailable");
    }
    gl.getExtension("OES_texture_float_linear");
    this.programs = this.createPrograms();
    this.meshes = {
      sphere: createSphereMesh(gl),
      disk: createDiskMesh(gl),
      plateau: createPlateauMesh(gl)
    };
    this.fullScreenVao = gl.createVertexArray();
    this.flowTexture = createFlowNoiseTexture(gl);
    this.lutTexture = createThinFilmLut(
      gl,
      simulation.params.eta2,
      simulation.params.eta3,
      simulation.params.kappa3
    );
    this.environmentTextures = new Array(ENVIRONMENTS.length).fill(null);
    this.environmentIndex = 0;
    this.environmentTexture = this.createFallbackEnvironment();
    this.framebuffers = null;
    this.width = 0;
    this.height = 0;
    this.touch = [0, 0, 22, 0];
    this.setEnvironment(0);
  }

  createFallbackEnvironment() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      1,
      1,
      0,
      gl.RGBA,
      gl.FLOAT,
      new Float32Array([.12, .18, .25, 1])
    );
    return texture;
  }

  createPrograms() {
    const gl = this.gl;
    const sphere = compileProgram(gl, sphereVertex, sphereFragment);
    const background = compileProgram(gl, fullScreenVertex, backgroundFragment);
    const connection = compileProgram(gl, connectionVertex, connectionFragment);
    const final = compileProgram(gl, fullScreenVertex, finalFragment);
    const fxaa = compileProgram(gl, fullScreenVertex, fxaaFragment);
    return {
      sphere: {
        program: sphere,
        uniforms: uniformLocations(gl, sphere, [
          "uViewProjection", "uShape", "uNormalMatrix", "uInverseShape", "uCenter",
          "uCameraPosition", "uEnvironment", "uFlowNoise", "uThinFilmLut",
          "uWhiteFurnace", "uFlowEnabled", "uFlowNoiseScale", "uFlowSpeed",
          "uFlowAmplitude", "uTime", "uFilmThickness", "uEta2",
          "uBackTransmission", "uBackReflection", "uFrontTransmission",
          "uFrontReflection", "uClipPlaneCount", "uClipPlanes[0]", "uBlendChannel",
          "uNormalBlendWidth", "uNormalBlendStrength", "uSelected"
        ])
      },
      background: {
        program: background,
        uniforms: uniformLocations(gl, background, [
          "uEnvironment", "uWhiteFurnace", "uBubbleOnly", "uCameraForward", "uCameraRight",
          "uCameraUp", "uTanHalfFov", "uAspect"
        ])
      },
      connection: {
        program: connection,
        uniforms: uniformLocations(gl, connection, [
          "uViewProjection", "uCenter", "uTangent", "uBitangent", "uAxis",
          "uRadius", "uSagittaRatio", "uBorderRatio", "uPlateauMode",
          "uCameraPosition", "uEnvironment", "uFlowNoise", "uThinFilmLut",
          "uWhiteFurnace", "uFlowEnabled", "uFlowNoiseScale", "uFlowSpeed",
          "uFlowAmplitude", "uTime", "uFilmThickness", "uEta2",
          "uNormalBlendStrength", "uPlateauBorderStrength"
        ])
      },
      final: {
        program: final,
        uniforms: uniformLocations(gl, final, [
          "uScene", "uOpticalDepth", "uWeightedReflection", "uWhiteFurnace",
          "uConnectionTransmission", "uConnectionReflection", "uTouchIndicator",
          "uResolution", "uBubbleOnly", "uDepthOfFieldEnabled", "uDepthOfFieldMode",
          "uDepthOfFieldFocusDistance", "uDepthOfFieldBackgroundDistance", "uDepthOfFieldStrength"
        ])
      },
      fxaa: {
        program: fxaa,
        uniforms: uniformLocations(gl, fxaa, ["uColor", "uInverseResolution", "uEnabled"])
      }
    };
  }

  resize() {
    const gl = this.gl;
    const nativeDpr = Math.max(window.devicePixelRatio || 1, 1);
    const dpr = nativeDpr * Math.max(.5, Math.min(1, this.simulation.params.renderResolutionScale));
    const cssWidth = Math.max(this.canvas.clientWidth, 1);
    const cssHeight = Math.max(this.canvas.clientHeight, 1);
    const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const requestedWidth = Math.max(1, Math.round(cssWidth * dpr));
    const requestedHeight = Math.max(1, Math.round(cssHeight * dpr));
    const hardwareScale = Math.min(1, maximumTextureSize / requestedWidth, maximumTextureSize / requestedHeight);
    const width = Math.max(1, Math.round(requestedWidth * hardwareScale));
    const height = Math.max(1, Math.round(requestedHeight * hardwareScale));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.framebuffers) {
      gl.deleteFramebuffer(this.framebuffers.sceneFbo);
      gl.deleteFramebuffer(this.framebuffers.connectionFbo);
      gl.deleteFramebuffer(this.framebuffers.compositeFbo);
      gl.deleteTexture(this.framebuffers.sceneTexture);
      gl.deleteTexture(this.framebuffers.opticalDepthTexture);
      gl.deleteTexture(this.framebuffers.weightedTexture);
      gl.deleteTexture(this.framebuffers.compositeTexture);
    }
    const sceneTexture = createColorTexture(gl, width, height);
    const sceneFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTexture, 0);

    const opticalDepthTexture = createColorTexture(gl, width, height);
    const weightedTexture = createColorTexture(gl, width, height);
    const connectionFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, connectionFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      opticalDepthTexture,
      0
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      weightedTexture,
      0
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Floating-point framebuffer is incomplete");
    }

    const compositeTexture = createDisplayTexture(gl, width, height);
    const compositeFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, compositeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, compositeTexture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Display framebuffer is incomplete");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.framebuffers = {
      sceneTexture,
      sceneFbo,
      opticalDepthTexture,
      weightedTexture,
      connectionFbo,
      compositeTexture,
      compositeFbo
    };
  }

  async setEnvironment(index) {
    this.environmentIndex = index;
    if (this.environmentTextures[index]) {
      this.environmentTexture = this.environmentTextures[index];
      this.callbacks.onEnvironmentLoaded?.(index);
      return;
    }
    this.callbacks.onEnvironmentLoading?.(index, 0);
    try {
      const texture = await loadHdrTexture(
        this.gl,
        ENVIRONMENTS[index],
        (progress) => this.callbacks.onEnvironmentLoading?.(index, progress)
      );
      this.environmentTextures[index] = texture;
      if (this.environmentIndex === index) this.environmentTexture = texture;
      this.callbacks.onEnvironmentLoaded?.(index);
    } catch (error) {
      console.error(error);
      this.callbacks.onEnvironmentError?.(index, error);
    }
  }

  updateThinFilmLut() {
    const gl = this.gl;
    const previous = this.lutTexture;
    this.lutTexture = createThinFilmLut(
      gl,
      this.simulation.params.eta2,
      this.simulation.params.eta3,
      this.simulation.params.kappa3
    );
    gl.deleteTexture(previous);
  }

  setTouch(x, y, active) {
    const rect = this.canvas.getBoundingClientRect();
    this.touch = [
      x / Math.max(rect.width, 1) * this.width,
      (rect.height - y) / Math.max(rect.height, 1) * this.height,
      22 * this.width / Math.max(rect.width, 1),
      active ? 1 : 0
    ];
  }

  bindOpticalTextures(uniforms) {
    const gl = this.gl;
    setTexture(gl, uniforms.uEnvironment, 0, this.environmentTexture);
    setTexture(gl, uniforms.uFlowNoise, 1, this.flowTexture);
    setTexture(gl, uniforms.uThinFilmLut, 2, this.lutTexture);
  }

  setOpticalUniforms(uniforms, filmThickness, settings = null) {
    const gl = this.gl;
    const params = this.simulation.params;
    gl.uniform1i(uniforms.uWhiteFurnace, params.whiteFurnace);
    gl.uniform1i(uniforms.uFlowEnabled, settings?.flowEnabled ?? params.flowEnabled);
    gl.uniform1f(uniforms.uFlowNoiseScale, settings?.flowNoiseScale ?? params.flowNoiseScale);
    gl.uniform1f(uniforms.uFlowSpeed, settings?.flowSpeed ?? params.flowSpeed);
    gl.uniform1f(uniforms.uFlowAmplitude, settings?.flowAmplitude ?? params.flowAmplitude);
    gl.uniform1f(uniforms.uTime, this.simulation.elapsed);
    gl.uniform1f(uniforms.uFilmThickness, filmThickness);
    gl.uniform1f(uniforms.uEta2, params.eta2);
  }

  renderBackground(camera) {
    const gl = this.gl;
    const entry = this.programs.background;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.sceneFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(entry.program);
    gl.bindVertexArray(this.fullScreenVao);
    setTexture(gl, entry.uniforms.uEnvironment, 0, this.environmentTexture);
    gl.uniform1i(entry.uniforms.uWhiteFurnace, this.simulation.params.whiteFurnace);
    gl.uniform1i(entry.uniforms.uBubbleOnly, this.simulation.params.bubbleOnlyOutput);
    gl.uniform3fv(entry.uniforms.uCameraForward, camera.forward);
    gl.uniform3fv(entry.uniforms.uCameraRight, camera.right);
    gl.uniform3fv(entry.uniforms.uCameraUp, camera.up);
    gl.uniform1f(entry.uniforms.uTanHalfFov, camera.tanHalfFov);
    gl.uniform1f(entry.uniforms.uAspect, camera.aspect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  renderBubbles(camera) {
    const gl = this.gl;
    const entry = this.programs.sphere;
    const params = this.simulation.params;
    const bubbles = [...this.simulation.renderBubbles()].sort((first, second) => {
      const firstDepth = v3.distance(first.position, camera.position);
      const secondDepth = v3.distance(second.position, camera.position);
      return secondDepth - firstDepth;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.sceneFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(entry.program);
    gl.bindVertexArray(this.meshes.sphere.vao);
    this.bindOpticalTextures(entry.uniforms);
    gl.uniformMatrix4fv(entry.uniforms.uViewProjection, false, camera.viewProjection);
    gl.uniform3fv(entry.uniforms.uCameraPosition, camera.position);
    gl.uniform1i(entry.uniforms.uBackTransmission, params.backTransmission);
    gl.uniform1i(entry.uniforms.uBackReflection, params.backReflection);
    gl.uniform1i(entry.uniforms.uFrontTransmission, params.frontTransmission);
      gl.uniform1i(entry.uniforms.uFrontReflection, params.frontReflection);
    bubbles.forEach((bubble) => {
      const scale = this.simulation.getWorldRadius(bubble);
      const shape = m3.scale(this.simulation.shapeMatrix(bubble), scale);
      const inverseShape = m3.inverse(shape);
      const normalMatrix = m3.transpose(inverseShape);
      gl.uniformMatrix3fv(entry.uniforms.uShape, false, shape);
      gl.uniformMatrix3fv(entry.uniforms.uInverseShape, false, inverseShape);
      gl.uniformMatrix3fv(entry.uniforms.uNormalMatrix, false, normalMatrix);
      gl.uniform3fv(entry.uniforms.uCenter, bubble.position);
      this.setOpticalUniforms(entry.uniforms, bubble.filmThickness, bubble);
      const planes = new Float32Array(24);
      bubble.clipPlanes.slice(0, 6).forEach((plane, index) => planes.set(plane, index * 4));
      gl.uniform1i(entry.uniforms.uClipPlaneCount, Math.min(bubble.clipPlanes.length, 6));
      gl.uniform4fv(entry.uniforms["uClipPlanes[0]"], planes);
      const blendWidth = Math.max(
        Math.min(
          scale * params.normalBlendWidthScale,
          Math.max(params.normalBlendMinWidth, params.normalBlendMaxWidth)
        ),
        Math.min(params.normalBlendMinWidth, params.normalBlendMaxWidth)
      );
      gl.uniform1f(entry.uniforms.uNormalBlendWidth, blendWidth);
      gl.uniform1f(entry.uniforms.uNormalBlendStrength, params.bubbleNormalBlendStrength);
      gl.uniform1i(entry.uniforms.uSelected, this.simulation.selectedIds.includes(bubble.id));
      for (let channel = 0; channel < 3; channel += 1) {
        gl.colorMask(channel === 0, channel === 1, channel === 2, true);
        gl.uniform1i(entry.uniforms.uBlendChannel, channel);
        gl.drawElements(gl.TRIANGLES, this.meshes.sphere.count, gl.UNSIGNED_SHORT, 0);
      }
    });
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
  }

  renderConnectionPiece(entry, camera, geometry, plateauMode) {
    const gl = this.gl;
    const mesh = plateauMode ? this.meshes.plateau : this.meshes.disk;
    if (plateauMode) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    } else {
      gl.disable(gl.CULL_FACE);
    }
    gl.bindVertexArray(mesh.vao);
    gl.uniformMatrix4fv(entry.uniforms.uViewProjection, false, camera.viewProjection);
    gl.uniform3fv(entry.uniforms.uCameraPosition, camera.position);
    gl.uniform3fv(entry.uniforms.uCenter, geometry.center);
    gl.uniform3fv(entry.uniforms.uTangent, geometry.tangent);
    gl.uniform3fv(entry.uniforms.uBitangent, geometry.bitangent);
    gl.uniform3fv(entry.uniforms.uAxis, geometry.normal);
    gl.uniform1f(entry.uniforms.uRadius, plateauMode ? geometry.circleRadius : geometry.radius);
    gl.uniform1f(entry.uniforms.uSagittaRatio, geometry.sagittaRatio);
    gl.uniform1f(entry.uniforms.uBorderRatio, geometry.borderRatio);
    gl.uniform1i(entry.uniforms.uPlateauMode, plateauMode);
    gl.uniform1f(entry.uniforms.uNormalBlendStrength, plateauMode
      ? this.simulation.params.plateauBorderNormalBlendStrength
      : this.simulation.params.sharedFilmNormalBlendStrength);
    gl.uniform1f(entry.uniforms.uPlateauBorderStrength, this.simulation.params.plateauBorderStrength);
    this.setOpticalUniforms(entry.uniforms, geometry.filmThickness, geometry);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  renderConnections(camera) {
    const gl = this.gl;
    const entry = this.programs.connection;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.connectionFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 0]));
    gl.clearBufferfv(gl.COLOR, 1, new Float32Array([0, 0, 0, 0]));
    if (this.simulation.params.singlePreview || !this.simulation.bonds.length) return;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(entry.program);
    this.bindOpticalTextures(entry.uniforms);
    this.simulation.bonds.forEach((bond) => {
      const geometry = this.simulation.calculateBondGeometry(bond);
      if (!geometry) return;
      this.renderConnectionPiece(entry, camera, geometry, false);
      this.renderConnectionPiece(entry, camera, geometry, true);
    });
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  renderFinal() {
    const gl = this.gl;
    const entry = this.programs.final;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.compositeFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(entry.program);
    gl.bindVertexArray(this.fullScreenVao);
    setTexture(gl, entry.uniforms.uScene, 0, this.framebuffers.sceneTexture);
    setTexture(gl, entry.uniforms.uOpticalDepth, 1, this.framebuffers.opticalDepthTexture);
    setTexture(gl, entry.uniforms.uWeightedReflection, 2, this.framebuffers.weightedTexture);
    gl.uniform1i(entry.uniforms.uWhiteFurnace, this.simulation.params.whiteFurnace);
    gl.uniform1i(entry.uniforms.uConnectionTransmission, this.simulation.params.frontTransmission);
    gl.uniform1i(entry.uniforms.uConnectionReflection, this.simulation.params.frontReflection);
    gl.uniform4fv(entry.uniforms.uTouchIndicator, this.touch);
    gl.uniform2f(entry.uniforms.uResolution, this.width, this.height);
    gl.uniform1i(entry.uniforms.uBubbleOnly, this.simulation.params.bubbleOnlyOutput);
    gl.uniform1i(entry.uniforms.uDepthOfFieldEnabled, this.simulation.params.depthOfFieldEnabled);
    gl.uniform1i(entry.uniforms.uDepthOfFieldMode, this.simulation.params.depthOfFieldMode);
    gl.uniform1f(entry.uniforms.uDepthOfFieldFocusDistance, this.simulation.params.depthOfFieldFocusDistance);
    gl.uniform1f(entry.uniforms.uDepthOfFieldBackgroundDistance, this.simulation.params.depthOfFieldBackgroundDistance);
    gl.uniform1f(entry.uniforms.uDepthOfFieldStrength, this.simulation.params.depthOfFieldStrength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  renderPresent() {
    const gl = this.gl;
    const entry = this.programs.fxaa;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(entry.program);
    gl.bindVertexArray(this.fullScreenVao);
    setTexture(gl, entry.uniforms.uColor, 0, this.framebuffers.compositeTexture);
    gl.uniform2f(entry.uniforms.uInverseResolution, 1 / this.width, 1 / this.height);
    gl.uniform1i(entry.uniforms.uEnabled, this.simulation.params.fxaaEnabled);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render() {
    this.resize();
    const camera = this.simulation.getCamera(this.width / this.height);
    this.renderBackground(camera);
    this.renderBubbles(camera);
    this.renderConnections(camera);
    this.renderFinal();
    this.renderPresent();
    return camera;
  }
}
