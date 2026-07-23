(() => {
  "use strict";

  const canvas = document.querySelector("#scene");
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    depth: false,
    powerPreference: "high-performance"
  });

  if (!gl) {
    document.querySelector("#error").classList.add("visible");
    return;
  }

  const MAX_BUBBLES = 18;
  const vertexSource = `#version 300 es
    precision highp float;
    const vec2 POSITIONS[3] = vec2[3](
      vec2(-1.0, -1.0),
      vec2(3.0, -1.0),
      vec2(-1.0, 3.0)
    );
    out vec2 vUv;
    void main() {
      vec2 position = POSITIONS[gl_VertexID];
      vUv = position * 0.5 + 0.5;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;
    #define MAX_BUBBLES ${MAX_BUBBLES}
    const float PI = 3.14159265359;

    in vec2 vUv;
    out vec4 fragColor;

    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uThickness;
    uniform float uFlow;
    uniform float uTension;
    uniform int uBubbleCount;
    uniform vec4 uBubbles[MAX_BUBBLES];
    uniform vec4 uBubbleData[MAX_BUBBLES];

    float hash31(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }

    float noise3(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
            mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
        mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
            mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y),
        f.z
      );
    }

    float fbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.55;
      for (int i = 0; i < 4; ++i) {
        value += amplitude * noise3(p);
        p = p * 2.03 + vec3(17.1, 9.2, 13.7);
        amplitude *= 0.48;
      }
      return value;
    }

    vec3 sky(vec3 ray) {
      float horizon = pow(1.0 - abs(ray.y), 5.0);
      float dusk = smoothstep(-0.65, 0.45, ray.y);
      vec3 low = mix(vec3(0.025, 0.052, 0.085), vec3(0.10, 0.18, 0.25), dusk);
      vec3 color = low + horizon * vec3(0.08, 0.13, 0.17);
      vec3 lightDir = normalize(vec3(-0.48, 0.62, 0.54));
      float sun = pow(max(dot(ray, lightDir), 0.0), 360.0);
      float bloom = pow(max(dot(ray, lightDir), 0.0), 16.0);
      color += sun * vec3(5.0, 4.0, 3.1) + bloom * vec3(0.34, 0.28, 0.25);
      float bands = smoothstep(.74, .78, sin(ray.x * 11.0 + ray.z * 8.0 + ray.y * 4.0));
      color += bands * smoothstep(-.2, .8, ray.y) * .018;
      return color;
    }

    vec3 thinFilm(float cosTheta, float thicknessNm) {
      vec3 lambda = vec3(650.0, 530.0, 455.0);
      float filmIor = 1.333;
      float sin2 = max(0.0, 1.0 - cosTheta * cosTheta) / (filmIor * filmIor);
      float cosFilm = sqrt(max(0.0, 1.0 - sin2));
      vec3 phase = (4.0 * PI * filmIor * thicknessNm * cosFilm) / lambda;
      vec3 interference = 0.5 + 0.5 * cos(phase + vec3(0.15, 0.0, -0.12));
      float f0 = pow((filmIor - 1.0) / (filmIor + 1.0), 2.0);
      float fresnel = f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);
      vec3 spectral = mix(vec3(0.018), 0.12 + 0.72 * interference, 0.72);
      return clamp(spectral * (0.24 + 2.8 * fresnel), 0.0, 0.92);
    }

    bool hitSphere(vec3 ro, vec3 rd, vec3 center, float radius, out float nearT, out float farT) {
      vec3 oc = ro - center;
      float b = dot(oc, rd);
      float c = dot(oc, oc) - radius * radius;
      float h = b * b - c;
      if (h < 0.0) return false;
      h = sqrt(h);
      nearT = -b - h;
      farT = -b + h;
      return farT > 0.0;
    }

    void main() {
      vec2 pixel = (gl_FragCoord.xy * 2.0 - uResolution.xy) / uResolution.y;
      vec3 ro = vec3(0.0, 0.0, 8.2);
      vec3 rd = normalize(vec3(pixel, -2.35));
      vec3 base = sky(rd);

      float nearest = 1e5;
      float exitT = 0.0;
      int hitIndex = -1;

      for (int i = 0; i < MAX_BUBBLES; ++i) {
        if (i >= uBubbleCount) break;
        float t0;
        float t1;
        vec3 center = uBubbles[i].xyz;
        float radius = uBubbles[i].w;
        if (hitSphere(ro, rd, center, radius, t0, t1)) {
          t0 = max(t0, 0.0);
          if (t0 < nearest) {
            nearest = t0;
            exitT = t1;
            hitIndex = i;
          }
        }
      }

      if (hitIndex >= 0) {
        vec4 bubble = uBubbles[hitIndex];
        vec3 position = ro + rd * nearest;
        vec3 normal = normalize(position - bubble.xyz);
        float wobblePhase = uBubbleData[hitIndex].x;
        float deformation = (1.0 - uTension) * 0.055;
        normal = normalize(normal + deformation * vec3(
          sin(position.y * 7.0 + uTime * 2.2 + wobblePhase),
          sin(position.z * 8.0 - uTime * 1.7 + wobblePhase),
          sin(position.x * 7.0 + uTime * 1.3)
        ));

        float ndv = clamp(dot(normal, -rd), 0.0, 1.0);
        float flowNoise = fbm(normal * 2.7 + vec3(0.0, uTime * .13, -uTime * .08));
        float gravityDrain = (normal.y * -0.5 + 0.5);
        float localThickness = uThickness
          + uFlow * ((flowNoise - .48) * 310.0 + gravityDrain * 145.0)
          + uBubbleData[hitIndex].y;
        vec3 reflectance = thinFilm(ndv, clamp(localThickness, 80.0, 1200.0));

        vec3 reflected = sky(reflect(rd, normal));
        vec3 backPosition = ro + rd * exitT;
        vec3 backNormal = normalize(backPosition - bubble.xyz);
        float backNdotV = clamp(abs(dot(backNormal, rd)), 0.0, 1.0);
        vec3 backFilm = thinFilm(backNdotV, clamp(localThickness * .96, 80.0, 1200.0));

        vec2 refractedOffset = normal.xy * (0.035 + 0.09 * (1.0 - ndv)) * bubble.w;
        vec3 throughRay = normalize(vec3(pixel + refractedOffset, -2.35));
        vec3 transmitted = sky(throughRay) * (vec3(1.0) - backFilm);
        vec3 color = transmitted * (vec3(1.0) - reflectance) + reflected * reflectance;

        float rim = pow(1.0 - ndv, 5.0);
        float highlight = pow(max(dot(reflect(rd, normal), normalize(vec3(-.48, .62, .54))), 0.0), 96.0);
        color += rim * reflectance * 0.7 + highlight * vec3(1.5, 1.25, 1.05);
        base = color;
      }

      float vignette = 1.0 - 0.17 * dot(pixel * .36, pixel * .36);
      base *= vignette;
      base = base / (base + vec3(1.0));
      base = pow(max(base, 0.0), vec3(1.0 / 2.2));
      fragColor = vec4(base, 1.0);
    }
  `;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram() {
    const program = gl.createProgram();
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    return program;
  }

  let program;
  try {
    program = createProgram();
  } catch (error) {
    console.error(error);
    document.querySelector("#error").classList.add("visible");
    return;
  }

  const uniforms = {};
  [
    "uResolution", "uTime", "uThickness", "uFlow", "uTension",
    "uBubbleCount", "uBubbles", "uBubbleData"
  ].forEach((name) => {
    const uniformName = name === "uBubbles" || name === "uBubbleData"
      ? `${name}[0]`
      : name;
    uniforms[name] = gl.getUniformLocation(program, uniformName);
  });

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.useProgram(program);

  const thicknessInput = document.querySelector("#thickness");
  const flowInput = document.querySelector("#flow");
  const tensionInput = document.querySelector("#tension");
  const thicknessOutput = document.querySelector("#thickness-value");
  const flowOutput = document.querySelector("#flow-value");
  const tensionOutput = document.querySelector("#tension-value");
  const countOutput = document.querySelector("#bubble-count");
  const pauseButton = document.querySelector("#pause");

  let bubbles = [];
  let paused = false;
  let lastTime = performance.now();
  let animationTime = 0;
  let selected = -1;
  let pointerOffset = { x: 0, y: 0 };

  function makeBubble(x, y, radius, vx = 0, vy = 0) {
    return {
      x, y,
      z: (Math.random() - .5) * 1.5,
      radius,
      vx, vy,
      phase: Math.random() * Math.PI * 2,
      thicknessOffset: (Math.random() - .5) * 70
    };
  }

  function resetScene() {
    bubbles = [
      makeBubble(-2.35, -1.15, .82, .18, .28),
      makeBubble(-.82, .65, 1.12, -.12, .14),
      makeBubble(1.15, -1.15, .72, -.2, .34),
      makeBubble(2.35, .72, .94, -.16, .2),
      makeBubble(.64, 1.7, .58, .12, -.1)
    ];
    updateCount();
  }

  function addBubble(x = null, y = null) {
    if (bubbles.length >= MAX_BUBBLES) bubbles.shift();
    const radius = .48 + Math.random() * .47;
    bubbles.push(makeBubble(
      x ?? ((Math.random() - .5) * 4.8),
      y ?? -2.55,
      radius,
      (Math.random() - .5) * .7,
      .65 + Math.random() * .55
    ));
    updateCount();
  }

  function updateCount() {
    countOutput.textContent = `${bubbles.length} 个泡泡`;
  }

  function worldBounds() {
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    return {
      halfWidth: 3.49 * aspect,
      halfHeight: 3.49
    };
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const bounds = worldBounds();
    return {
      x: ((clientX - rect.left) / rect.width * 2 - 1) * bounds.halfWidth,
      y: (1 - (clientY - rect.top) / rect.height * 2) * bounds.halfHeight
    };
  }

  function updatePhysics(dt) {
    const bounds = worldBounds();
    const tension = Number(tensionInput.value) / 100;

    bubbles.forEach((bubble, index) => {
      if (index !== selected) {
        bubble.vy += .075 * dt;
        bubble.vx *= Math.pow(.993, dt * 60);
        bubble.vy *= Math.pow(.996, dt * 60);
        bubble.x += bubble.vx * dt;
        bubble.y += bubble.vy * dt;
      }

      const horizontal = bounds.halfWidth - bubble.radius;
      const vertical = bounds.halfHeight - bubble.radius;
      if (bubble.x < -horizontal || bubble.x > horizontal) {
        bubble.x = Math.max(-horizontal, Math.min(horizontal, bubble.x));
        bubble.vx *= -.82;
      }
      if (bubble.y < -vertical || bubble.y > vertical) {
        bubble.y = Math.max(-vertical, Math.min(vertical, bubble.y));
        bubble.vy *= -.74;
      }
    });

    for (let i = 0; i < bubbles.length; i += 1) {
      for (let j = i + 1; j < bubbles.length; j += 1) {
        const a = bubbles[i];
        const b = bubbles[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || .001;
        const target = (a.radius + b.radius) * .91;
        if (distance >= target) continue;

        const nx = dx / distance;
        const ny = dy / distance;
        const overlap = target - distance;
        const stiffness = .35 + tension * .5;
        a.x -= nx * overlap * .5 * stiffness;
        a.y -= ny * overlap * .5 * stiffness;
        b.x += nx * overlap * .5 * stiffness;
        b.y += ny * overlap * .5 * stiffness;

        const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (relative < 0) {
          const impulse = -(1.45 * relative) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
        }
      }
    }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function render(now) {
    resize();
    const dt = Math.min((now - lastTime) / 1000, .033);
    lastTime = now;
    if (!paused) {
      animationTime += dt;
      updatePhysics(dt);
    }

    const bubbleValues = new Float32Array(MAX_BUBBLES * 4);
    const bubbleData = new Float32Array(MAX_BUBBLES * 4);
    bubbles.forEach((bubble, index) => {
      bubbleValues.set([bubble.x, bubble.y, bubble.z, bubble.radius], index * 4);
      bubbleData.set([bubble.phase, bubble.thicknessOffset, 0, 0], index * 4);
    });

    gl.useProgram(program);
    gl.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.uTime, animationTime);
    gl.uniform1f(uniforms.uThickness, Number(thicknessInput.value));
    gl.uniform1f(uniforms.uFlow, Number(flowInput.value) / 100);
    gl.uniform1f(uniforms.uTension, Number(tensionInput.value) / 100);
    gl.uniform1i(uniforms.uBubbleCount, bubbles.length);
    gl.uniform4fv(uniforms.uBubbles, bubbleValues);
    gl.uniform4fv(uniforms.uBubbleData, bubbleData);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(render);
  }

  function updateLabels() {
    thicknessOutput.textContent = `${thicknessInput.value} nm`;
    flowOutput.textContent = `${flowInput.value}%`;
    tensionOutput.textContent = `${tensionInput.value}%`;
  }

  [thicknessInput, flowInput, tensionInput].forEach((input) => {
    input.addEventListener("input", updateLabels);
  });

  document.querySelector("#add").addEventListener("click", () => addBubble());
  document.querySelector("#reset").addEventListener("click", resetScene);
  pauseButton.addEventListener("click", () => {
    paused = !paused;
    pauseButton.textContent = paused ? "▶" : "Ⅱ";
    pauseButton.setAttribute("aria-pressed", String(paused));
    pauseButton.setAttribute("aria-label", paused ? "继续动画" : "暂停动画");
  });

  canvas.addEventListener("pointerdown", (event) => {
    const point = screenToWorld(event.clientX, event.clientY);
    let best = Infinity;
    bubbles.forEach((bubble, index) => {
      const distance = Math.hypot(point.x - bubble.x, point.y - bubble.y);
      if (distance < bubble.radius * 1.12 && distance < best) {
        best = distance;
        selected = index;
      }
    });
    if (selected >= 0) {
      pointerOffset.x = bubbles[selected].x - point.x;
      pointerOffset.y = bubbles[selected].y - point.y;
      bubbles[selected].vx = 0;
      bubbles[selected].vy = 0;
      canvas.classList.add("dragging");
      canvas.setPointerCapture(event.pointerId);
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (selected < 0) return;
    const point = screenToWorld(event.clientX, event.clientY);
    const bubble = bubbles[selected];
    const previousX = bubble.x;
    const previousY = bubble.y;
    bubble.x = point.x + pointerOffset.x;
    bubble.y = point.y + pointerOffset.y;
    bubble.vx = (bubble.x - previousX) * 18;
    bubble.vy = (bubble.y - previousY) * 18;
  });

  function releasePointer(event) {
    if (selected < 0) return;
    selected = -1;
    canvas.classList.remove("dragging");
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener("pointerup", releasePointer);
  canvas.addEventListener("pointercancel", releasePointer);
  canvas.addEventListener("dblclick", (event) => {
    const point = screenToWorld(event.clientX, event.clientY);
    addBubble(point.x, point.y);
  });

  window.addEventListener("resize", resize);
  resetScene();
  updateLabels();
  requestAnimationFrame(render);
})();
