const PI = Math.PI;
const LUT_SIZE = 256;

function square(value) {
  return value * value;
}

function fresnelDielectric(cosTheta1, n1, n2) {
  const sinTheta1Squared = 1 - cosTheta1 * cosTheta1;
  const ratio = n1 / n2;
  if (ratio * ratio * sinTheta1Squared > 1) {
    const root = Math.sqrt(sinTheta1Squared - 1 / (ratio * ratio));
    return {
      reflectance: [1, 1],
      phase: [
        2 * Math.atan2(-ratio * ratio * root / cosTheta1, 1),
        2 * Math.atan2(-root / cosTheta1, 1)
      ]
    };
  }

  const cosTheta2 = Math.sqrt(Math.max(0, 1 - ratio * ratio * sinTheta1Squared));
  const rp = (n2 * cosTheta1 - n1 * cosTheta2) / (n2 * cosTheta1 + n1 * cosTheta2);
  const rs = (n1 * cosTheta1 - n2 * cosTheta2) / (n1 * cosTheta1 + n2 * cosTheta2);
  return {
    reflectance: [rp * rp, rs * rs],
    phase: [rp < 0 ? PI : 0, rs < 0 ? PI : 0]
  };
}

function fresnelConductor(cosTheta1, n1, n2, kappa) {
  if (kappa === 0) return fresnelDielectric(cosTheta1, n1, n2);

  const a = square(n2) * (1 - square(kappa)) - square(n1) * (1 - square(cosTheta1));
  const b = Math.sqrt(square(a) + square(2 * square(n2) * kappa));
  const u = Math.sqrt(Math.max(0, (a + b) * .5));
  const v = Math.sqrt(Math.max(0, (b - a) * .5));
  const rs = (square(n1 * cosTheta1 - u) + square(v)) /
    (square(n1 * cosTheta1 + u) + square(v));
  const phaseS = Math.atan2(
    2 * n1 * v * cosTheta1,
    square(u) + square(v) - square(n1 * cosTheta1)
  ) + PI;
  const rp = (
    square(square(n2) * (1 - square(kappa)) * cosTheta1 - n1 * u) +
    square(2 * square(n2) * kappa * cosTheta1 - n1 * v)
  ) / (
    square(square(n2) * (1 - square(kappa)) * cosTheta1 + n1 * u) +
    square(2 * square(n2) * kappa * cosTheta1 + n1 * v)
  );
  const phaseP = Math.atan2(
    2 * n1 * square(n2) * cosTheta1 * (2 * kappa * u - (1 - square(kappa)) * v),
    square(square(n2) * (1 + square(kappa)) * cosTheta1) -
      square(n1) * (square(u) + square(v))
  );
  return { reflectance: [rp, rs], phase: [phaseP, phaseS] };
}

function evaluateSensitivity(opticalPathDifference, phaseShift) {
  const phase = 2 * PI * opticalPathDifference * 1e-9;
  const amplitude = [5.4856e-13, 4.4201e-13, 5.2481e-13];
  const position = [1.6810e6, 1.7953e6, 2.2084e6];
  const variance = [4.3278e9, 9.3046e9, 6.6121e9];
  const xyz = amplitude.map((value, index) =>
    value * Math.sqrt(2 * PI * variance[index]) *
    Math.cos(position[index] * phase + phaseShift) *
    Math.exp(-variance[index] * phase * phase)
  );
  xyz[0] += 9.7470e-14 * Math.sqrt(2 * PI * 4.5282e9) *
    Math.cos(2.2399e6 * phase + phaseShift) *
    Math.exp(-4.5282e9 * phase * phase);
  return xyz.map((value) => value / 1.0685e-7);
}

function thinFilmReflectance(cosTheta1, thicknessNanometers, eta2, eta3, kappa3) {
  cosTheta1 = Math.max(.001, Math.min(1, cosTheta1));
  eta2 = Math.max(eta2, 1.001);
  eta3 = Math.max(eta3, 1.001);
  kappa3 = Math.max(kappa3, 0);
  const cosTheta2 = Math.sqrt(Math.max(
    0,
    1 - square(1 / eta2) * (1 - square(cosTheta1))
  ));
  const interface12 = fresnelDielectric(cosTheta1, 1, eta2);
  const interface23 = fresnelConductor(cosTheta2, eta2, eta3, kappa3);
  const opticalPathDifference = 2 * eta2 * thicknessNanometers * cosTheta2;
  const result = [0, 0, 0];
  const r12 = interface12.reflectance;
  const r23 = interface23.reflectance;
  const t121 = [1 - r12[0], 1 - r12[1]];
  const phase21 = [PI - interface12.phase[0], PI - interface12.phase[1]];
  const totalPhase = [
    phase21[0] + interface23.phase[0],
    phase21[1] + interface23.phase[1]
  ];
  const r123 = [r12[0] * r23[0], r12[1] * r23[1]];
  const rootR123 = [Math.sqrt(Math.max(r123[0], 0)), Math.sqrt(Math.max(r123[1], 0))];
  const rs = [
    t121[0] * t121[0] * r23[0] / Math.max(.001, 1 - r123[0]),
    t121[1] * t121[1] * r23[1] / Math.max(.001, 1 - r123[1])
  ];
  const c0 = [r12[0] + rs[0], r12[1] + rs[1]];
  const s0 = evaluateSensitivity(0, 0);
  const depolarizedC0 = .5 * (c0[0] + c0[1]);
  for (let channel = 0; channel < 3; channel += 1) {
    result[channel] += depolarizedC0 * s0[channel];
  }

  const coefficient = [rs[0] - t121[0], rs[1] - t121[1]];
  for (let order = 1; order <= 3; order += 1) {
    coefficient[0] *= rootR123[0];
    coefficient[1] *= rootR123[1];
    const sensitivityP = evaluateSensitivity(
      order * opticalPathDifference,
      order * totalPhase[0]
    );
    const sensitivityS = evaluateSensitivity(
      order * opticalPathDifference,
      order * totalPhase[1]
    );
    for (let channel = 0; channel < 3; channel += 1) {
      result[channel] += coefficient[0] * sensitivityP[channel] +
        coefficient[1] * sensitivityS[channel];
    }
  }

  const rgb = [
    2.3706743 * result[0] - .9000405 * result[1] - .4706338 * result[2],
    -.5138850 * result[0] + 1.4253036 * result[1] + .0885814 * result[2],
    .0052982 * result[0] - .0146949 * result[1] + 1.0093968 * result[2]
  ];
  return rgb.map((value) => Math.max(0, Math.min(1, value)));
}

export function createThinFilmLut(gl, eta2, eta3, kappa3) {
  const data = new Float32Array(LUT_SIZE * LUT_SIZE * 4);
  for (let y = 0; y < LUT_SIZE; y += 1) {
    const cosine = y / (LUT_SIZE - 1);
    for (let x = 0; x < LUT_SIZE; x += 1) {
      const thickness = 1200 * x / (LUT_SIZE - 1);
      const rgb = thinFilmReflectance(cosine, thickness, eta2, eta3, kappa3);
      const offset = (y * LUT_SIZE + x) * 4;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = 1;
    }
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA16F,
    LUT_SIZE,
    LUT_SIZE,
    0,
    gl.RGBA,
    gl.FLOAT,
    data
  );
  return texture;
}

function nextLcg(state) {
  return (Math.imul(1664525, state) + 1013904223) >>> 0;
}

export function createFlowNoiseTexture(gl) {
  const latticeSize = 8;
  const textureSize = 64;
  let state = 0x7f4a7c15;
  const lattice = new Float32Array(latticeSize * latticeSize);
  for (let index = 0; index < lattice.length; index += 1) {
    state = nextLcg(state);
    lattice[index] = (state >>> 8) / 0xffffff;
  }
  const sample = (x, y) => {
    const wrappedX = (x + latticeSize) % latticeSize;
    const wrappedY = (y + latticeSize) % latticeSize;
    return lattice[wrappedY * latticeSize + wrappedX];
  };
  const data = new Uint8Array(textureSize * textureSize);
  for (let y = 0; y < textureSize; y += 1) {
    for (let x = 0; x < textureSize; x += 1) {
      const latticeX = x / textureSize * latticeSize;
      const latticeY = y / textureSize * latticeSize;
      const x0 = Math.floor(latticeX);
      const y0 = Math.floor(latticeY);
      const fx = latticeX - x0;
      const fy = latticeY - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const top = sample(x0, y0) * (1 - sx) + sample(x0 + 1, y0) * sx;
      const bottom = sample(x0, y0 + 1) * (1 - sx) + sample(x0 + 1, y0 + 1) * sx;
      data[y * textureSize + x] = Math.round(255 * (top * (1 - sy) + bottom * sy));
    }
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, textureSize, textureSize, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  return texture;
}

function readLine(bytes, cursor) {
  const start = cursor.offset;
  while (cursor.offset < bytes.length && bytes[cursor.offset] !== 10) cursor.offset += 1;
  const line = new TextDecoder().decode(bytes.subarray(start, cursor.offset)).replace(/\r$/, "");
  cursor.offset += 1;
  return line;
}

export function decodeRadianceHdr(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const cursor = { offset: 0 };
  const signature = readLine(bytes, cursor);
  if (!signature.startsWith("#?RADIANCE") && !signature.startsWith("#?RGBE")) {
    throw new Error("Unsupported HDR signature");
  }

  let line = "";
  do {
    line = readLine(bytes, cursor);
  } while (line.length > 0 && cursor.offset < bytes.length);
  const resolutionLine = readLine(bytes, cursor);
  const match = resolutionLine.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (!match) throw new Error(`Unsupported HDR orientation: ${resolutionLine}`);
  const height = Number(match[1]);
  const width = Number(match[2]);
  const rgbe = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    if (
      bytes[cursor.offset] !== 2 ||
      bytes[cursor.offset + 1] !== 2 ||
      (bytes[cursor.offset + 2] & 0x80)
    ) {
      throw new Error("Legacy non-RLE HDR scanlines are not supported");
    }
    const scanlineWidth = (bytes[cursor.offset + 2] << 8) | bytes[cursor.offset + 3];
    cursor.offset += 4;
    if (scanlineWidth !== width) throw new Error("HDR scanline width mismatch");
    const channels = new Uint8Array(width * 4);
    for (let channel = 0; channel < 4; channel += 1) {
      let x = 0;
      while (x < width) {
        const code = bytes[cursor.offset++];
        if (code > 128) {
          const count = code - 128;
          const value = bytes[cursor.offset++];
          channels.fill(value, channel * width + x, channel * width + x + count);
          x += count;
        } else {
          const count = code;
          channels.set(bytes.subarray(cursor.offset, cursor.offset + count), channel * width + x);
          cursor.offset += count;
          x += count;
        }
      }
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      rgbe[target] = channels[x];
      rgbe[target + 1] = channels[width + x];
      rgbe[target + 2] = channels[width * 2 + x];
      rgbe[target + 3] = channels[width * 3 + x];
    }
  }

  const data = new Float32Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const exponent = rgbe[index * 4 + 3];
    const scale = exponent ? Math.pow(2, exponent - 136) : 0;
    data[index * 4] = rgbe[index * 4] * scale;
    data[index * 4 + 1] = rgbe[index * 4 + 1] * scale;
    data[index * 4 + 2] = rgbe[index * 4 + 2] * scale;
    data[index * 4 + 3] = 1;
  }
  return { width, height, data };
}

export async function loadHdrTexture(gl, url, onProgress = () => {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HDR load failed: ${response.status} ${url}`);
  const reader = response.body?.getReader();
  let arrayBuffer;
  if (reader) {
    const chunks = [];
    let received = 0;
    const total = Number(response.headers.get("content-length")) || 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(total > 0 ? received / total : 0);
    }
    const combined = new Uint8Array(received);
    let offset = 0;
    chunks.forEach((chunk) => {
      combined.set(chunk, offset);
      offset += chunk.length;
    });
    arrayBuffer = combined.buffer;
  } else {
    arrayBuffer = await response.arrayBuffer();
  }

  const image = decodeRadianceHdr(arrayBuffer);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA16F,
    image.width,
    image.height,
    0,
    gl.RGBA,
    gl.FLOAT,
    image.data
  );
  return texture;
}
