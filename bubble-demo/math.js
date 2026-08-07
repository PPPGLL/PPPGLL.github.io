export const PI = Math.PI;

export const v3 = {
  create: (x = 0, y = 0, z = 0) => [x, y, z],
  clone: (a) => [a[0], a[1], a[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  madd: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ],
  lengthSq: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize(a) {
    const length = Math.hypot(a[0], a[1], a[2]);
    return length > 1e-12 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
  },
  clampLength(a, maximum) {
    const length = Math.hypot(a[0], a[1], a[2]);
    return length > maximum && length > 1e-12
      ? [a[0] * maximum / length, a[1] * maximum / length, a[2] * maximum / length]
      : [a[0], a[1], a[2]];
  },
  distance: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  lerp: (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ]
};

export const m3 = {
  identity: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  zero: () => [0, 0, 0, 0, 0, 0, 0, 0, 0],
  clone: (a) => a.slice(0, 9),
  add: (a, b) => a.map((value, index) => value + b[index]),
  sub: (a, b) => a.map((value, index) => value - b[index]),
  scale: (a, scalar) => a.map((value) => value * scalar),
  multiply(a, b) {
    const out = new Array(9).fill(0);
    for (let column = 0; column < 3; column += 1) {
      for (let row = 0; row < 3; row += 1) {
        out[column * 3 + row] =
          a[0 * 3 + row] * b[column * 3 + 0] +
          a[1 * 3 + row] * b[column * 3 + 1] +
          a[2 * 3 + row] * b[column * 3 + 2];
      }
    }
    return out;
  },
  transform(a, vector) {
    return [
      a[0] * vector[0] + a[3] * vector[1] + a[6] * vector[2],
      a[1] * vector[0] + a[4] * vector[1] + a[7] * vector[2],
      a[2] * vector[0] + a[5] * vector[1] + a[8] * vector[2]
    ];
  },
  transpose: (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]],
  determinant: (a) =>
    a[0] * (a[4] * a[8] - a[7] * a[5]) -
    a[3] * (a[1] * a[8] - a[7] * a[2]) +
    a[6] * (a[1] * a[5] - a[4] * a[2]),
  inverse(a) {
    const determinant =
      a[0] * (a[4] * a[8] - a[7] * a[5]) -
      a[3] * (a[1] * a[8] - a[7] * a[2]) +
      a[6] * (a[1] * a[5] - a[4] * a[2]);
    if (Math.abs(determinant) < 1e-12) return m3.identity();
    const inverseDeterminant = 1 / determinant;
    return [
      (a[4] * a[8] - a[7] * a[5]) * inverseDeterminant,
      (a[7] * a[2] - a[1] * a[8]) * inverseDeterminant,
      (a[1] * a[5] - a[4] * a[2]) * inverseDeterminant,
      (a[6] * a[5] - a[3] * a[8]) * inverseDeterminant,
      (a[0] * a[8] - a[6] * a[2]) * inverseDeterminant,
      (a[3] * a[2] - a[0] * a[5]) * inverseDeterminant,
      (a[3] * a[7] - a[6] * a[4]) * inverseDeterminant,
      (a[6] * a[1] - a[0] * a[7]) * inverseDeterminant,
      (a[0] * a[4] - a[3] * a[1]) * inverseDeterminant
    ];
  },
  frobenius: (a) => Math.hypot(...a),
  projectQuadrupole(a) {
    const transposed = m3.transpose(a);
    const symmetric = a.map((value, index) => .5 * (value + transposed[index]));
    const traceThird = (symmetric[0] + symmetric[4] + symmetric[8]) / 3;
    symmetric[0] -= traceThird;
    symmetric[4] -= traceThird;
    symmetric[8] -= traceThird;
    return symmetric;
  },
  axisQuadrupole(axis, strain) {
    const n = v3.normalize(axis);
    const scale = 1.5 * strain;
    return [
      scale * (n[0] * n[0] - 1 / 3),
      scale * n[1] * n[0],
      scale * n[2] * n[0],
      scale * n[0] * n[1],
      scale * (n[1] * n[1] - 1 / 3),
      scale * n[2] * n[1],
      scale * n[0] * n[2],
      scale * n[1] * n[2],
      scale * (n[2] * n[2] - 1 / 3)
    ];
  },
  exponentialQuadrupole(q) {
    let result = m3.identity();
    let term = m3.identity();
    for (let order = 1; order <= 8; order += 1) {
      term = m3.scale(m3.multiply(term, q), 1 / order);
      result = m3.add(result, term);
    }
    const determinant = m3.determinant(result);
    if (determinant > 1e-6) {
      result = m3.scale(result, 1 / Math.cbrt(determinant));
    }
    return result;
  }
};

export const m4 = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        out[column * 4 + row] =
          a[row] * b[column * 4] +
          a[4 + row] * b[column * 4 + 1] +
          a[8 + row] * b[column * 4 + 2] +
          a[12 + row] * b[column * 4 + 3];
      }
    }
    return out;
  },
  perspective(fovyRadians, aspect, near, far) {
    const f = 1 / Math.tan(fovyRadians / 2);
    const rangeInverse = 1 / (near - far);
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (near + far) * rangeInverse, -1,
      0, 0, near * far * 2 * rangeInverse, 0
    ];
  },
  lookAt(eye, target, up) {
    const z = v3.normalize(v3.sub(eye, target));
    const x = v3.normalize(v3.cross(up, z));
    const y = v3.cross(z, x);
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1
    ];
  }
};

export function buildCamera(
  yaw,
  distance,
  aspect,
  fovDegrees = 60,
  pitch = 0,
  target = [0, 0, 0]
) {
  const cosinePitch = Math.cos(pitch);
  const orbitOffset = [
    distance * Math.sin(yaw) * cosinePitch,
    distance * Math.sin(pitch),
    distance * Math.cos(yaw) * cosinePitch
  ];
  const position = v3.add(target, orbitOffset);
  const forward = v3.normalize(v3.sub(target, position));
  const right = v3.normalize(v3.cross(forward, [0, 1, 0]));
  const up = v3.normalize(v3.cross(right, forward));
  const view = m4.lookAt(position, target, up);
  const projection = m4.perspective(fovDegrees * PI / 180, aspect, .1, 180);
  return {
    position,
    forward,
    right,
    up,
    viewProjection: m4.multiply(projection, view),
    tanHalfFov: Math.tan(fovDegrees * PI / 360),
    aspect,
    target: v3.clone(target)
  };
}

export function rayFromScreen(camera, x, y, width, height) {
  const normalizedX = x / width * 2 - 1;
  const normalizedY = 1 - y / height * 2;
  const direction = v3.normalize(v3.add(
    camera.forward,
    v3.add(
      v3.scale(camera.right, normalizedX * camera.tanHalfFov * camera.aspect),
      v3.scale(camera.up, normalizedY * camera.tanHalfFov)
    )
  ));
  return { origin: v3.clone(camera.position), direction };
}

export function intersectRayPlane(ray, point, normal) {
  const denominator = v3.dot(ray.direction, normal);
  if (Math.abs(denominator) < 1e-5) return null;
  const distance = v3.dot(v3.sub(point, ray.origin), normal) / denominator;
  if (distance <= 0) return null;
  return v3.madd(ray.origin, ray.direction, distance);
}

export function distancePointToSegment2D(point, a, b) {
  const abX = b[0] - a[0];
  const abY = b[1] - a[1];
  const denominator = abX * abX + abY * abY;
  const t = denominator > 1e-8
    ? Math.max(0, Math.min(1, ((point[0] - a[0]) * abX + (point[1] - a[1]) * abY) / denominator))
    : 0;
  return Math.hypot(point[0] - (a[0] + abX * t), point[1] - (a[1] + abY * t));
}
