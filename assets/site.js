/* Gaole Pan — homepage behaviour
   1. A rough microfacet surface with wet patches, shaded in WebGL (GGX).
      The pointer is the light. Without a pointer, the light drifts.
   2. The same light position drives CSS highlights on text and frames.
   3. Images clear bucket by bucket, like a renderer finishing a frame. */
(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;

  /* ---------------- navigation ---------------- */

  const menuButton = document.querySelector("#menu-button");
  const navLinks = document.querySelector("#nav-links");

  const setMenu = (open) => {
    navLinks.classList.toggle("open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.textContent = open ? "Close" : "Menu";
  };
  menuButton.addEventListener("click", () => setMenu(!navLinks.classList.contains("open")));
  navLinks.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

  document.querySelector("#year").textContent = new Date().getFullYear();

  // highlight the section being read
  const navMap = new Map();
  navLinks.querySelectorAll("a[href^='#']").forEach((a) => {
    const target = document.querySelector(a.getAttribute("href"));
    if (target) navMap.set(target, a);
  });
  if ("IntersectionObserver" in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navMap.forEach((a) => a.removeAttribute("aria-current"));
        navMap.get(entry.target).setAttribute("aria-current", "true");
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    navMap.forEach((_, section) => spy.observe(section));
  }

  /* ---------------- the light ---------------- */

  const light = { x: innerWidth * 0.3, y: innerHeight * 0.25, tx: innerWidth * 0.3, ty: innerHeight * 0.25 };
  let pointerActive = false;
  let lastPointer = 0;

  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    light.tx = e.clientX;
    light.ty = e.clientY;
    pointerActive = true;
    lastPointer = performance.now();
  }, { passive: true });

  const litElements = Array.from(document.querySelectorAll(".lit, .lit-text"));
  let litRects = [];
  const measureLit = () => { litRects = litElements.map((el) => el.getBoundingClientRect()); };

  const applyLight = () => {
    for (let i = 0; i < litElements.length; i++) {
      const r = litRects[i];
      if (r.bottom < -400 || r.top > innerHeight + 400) continue;
      litElements[i].style.setProperty("--ex", (light.x - r.left).toFixed(1) + "px");
      litElements[i].style.setProperty("--ey", (light.y - r.top).toFixed(1) + "px");
    }
  };

  /* ---------------- reading progress ---------------- */

  let scrollY = window.scrollY;
  const updateProgress = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    root.style.setProperty("--progress", max > 0 ? Math.min(1, scrollY / max).toFixed(4) : "0");
  };

  /* ---------------- WebGL surface ---------------- */

  const VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";

  const FRAG = `
precision highp float;
uniform vec2  uRes;     // viewport, css px
uniform float uScale;   // css px per buffer px
uniform float uTime;
uniform float uScroll;
uniform vec2  uLight;   // css px, origin top-left

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s;
}
float ggx(float ndh, float alpha) {
  float a2 = alpha * alpha;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}

void main() {
  vec2 px = gl_FragCoord.xy * uScale;
  px.y = uRes.y - px.y;
  vec2 world = px + vec2(0.0, uScroll * 0.4);

  // height field of the rough surface
  vec2 q = world / 70.0;
  float e = 0.045;
  float h  = fbm(q);
  float hx = fbm(q + vec2(e, 0.0));
  float hy = fbm(q + vec2(0.0, e));
  vec3 n = normalize(vec3((h - hx) / e * 1.25, (h - hy) / e * 1.25, 1.0));

  // water collects where the surface is low
  float level = 0.40 + 0.24 * noise(world / 460.0 + vec2(uTime * 0.012, -uTime * 0.008));
  float wet = smoothstep(0.0, 0.07, level - h);
  n = normalize(mix(n, vec3(0.0, 0.0, 1.0), wet * 0.94));
  float alpha = mix(0.46, 0.085, wet);

  vec3 V = vec3(0.0, 0.0, 1.0);

  // the pointer light, hovering above the page
  vec3 toL = vec3(uLight - px, 240.0);
  float d2 = dot(toL, toL);
  vec3 L = toL * inversesqrt(d2);
  float reach = min(300.0, 0.42 * min(uRes.x, uRes.y));   // smaller pool on phones
  float atten = 1.0 / (1.0 + d2 / (reach * reach));
  atten *= atten;
  float ndl = max(dot(n, L), 0.0);
  float ndh = max(dot(n, normalize(L + V)), 0.0);

  vec3 albedo = mix(vec3(0.050, 0.150, 0.095), vec3(0.012, 0.050, 0.032), wet);
  vec3 col = albedo * ndl * atten * 1.25;
  col += vec3(0.72, 1.0, 0.84) * min(ggx(ndh, alpha), 30.0) * ndl * atten * 0.07;

  // a fixed grazing light so the surface never goes dead
  vec3 L2 = normalize(vec3(0.62, -0.50, 0.34));
  float ndl2 = max(dot(n, L2), 0.0);
  float ndh2 = max(dot(n, normalize(L2 + V)), 0.0);
  col += albedo * ndl2 * 0.011;
  col += vec3(0.50, 0.95, 0.70) * min(ggx(ndh2, alpha), 12.0) * ndl2 * 0.0022;

  // keep the edges quiet for text
  vec2 uv = px / uRes;
  col *= mix(0.72, 1.0, smoothstep(1.25, 0.25, length(uv - vec2(0.5, 0.35))));

  col = col / (1.0 + col);                       // tone map
  col = pow(col, vec3(0.4545));
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;  // dither
  gl_FragColor = vec4(col, 1.0);
}`;

  const canvas = document.querySelector("#surface");
  let gl = null;
  let uniforms = null;
  let bufferScale = 1;

  const initGL = () => {
    try {
      gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    } catch (err) { gl = null; }
    if (!gl) return false;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uniforms = {};
      ["uRes", "uScale", "uTime", "uScroll", "uLight"].forEach((n) => { uniforms[n] = gl.getUniformLocation(prog, n); });
    } catch (err) {
      console.warn("Surface shader unavailable:", err.message);
      gl = null;
      return false;
    }
    return true;
  };

  const resizeGL = () => {
    if (!gl) return;
    // cap the buffer so large screens stay cheap
    const maxPixels = 900000;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let scale = dpr;
    if (innerWidth * innerHeight * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (innerWidth * innerHeight));
    canvas.width = Math.max(1, Math.round(innerWidth * scale));
    canvas.height = Math.max(1, Math.round(innerHeight * scale));
    bufferScale = innerWidth / canvas.width;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const drawGL = (t) => {
    if (!gl) return;
    gl.uniform2f(uniforms.uRes, innerWidth, innerHeight);
    gl.uniform1f(uniforms.uScale, bufferScale);
    gl.uniform1f(uniforms.uTime, t);
    gl.uniform1f(uniforms.uScroll, scrollY);
    gl.uniform2f(uniforms.uLight, light.x, light.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  if (!initGL()) document.body.classList.add("no-gl");
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); gl = null; document.body.classList.add("no-gl"); });

  /* ---------------- frame loop ---------------- */

  let running = false;
  let lastDraw = 0;
  const start = performance.now();

  const frame = (now) => {
    if (!running) return;
    requestAnimationFrame(frame);

    // without a pointer (touch, or idle for a while) the light wanders
    if (!pointerActive || now - lastPointer > 6000) {
      const t = (now - start) / 1000;
      light.tx = innerWidth * (0.5 + 0.34 * Math.sin(t * 0.21));
      light.ty = innerHeight * (0.38 + 0.24 * Math.sin(t * 0.33 + 1.3));
    }
    const k = 0.085;
    light.x += (light.tx - light.x) * k;
    light.y += (light.ty - light.y) * k;

    applyLight();
    if (now - lastDraw > 30) {           // ~30 fps is plenty for a backdrop
      lastDraw = now;
      drawGL((now - start) / 1000);
    }
  };

  const setRunning = (on) => {
    if (on === running) return;
    running = on;
    if (on) requestAnimationFrame(frame);
  };

  const onResize = () => { resizeGL(); measureLit(); updateProgress(); if (!running) { applyLight(); drawGL(0); } };
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", () => {
    scrollY = window.scrollY;
    measureLit();
    updateProgress();
    if (!running) drawGL(0);
  }, { passive: true });
  window.addEventListener("load", () => { measureLit(); updateProgress(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureLit);
  document.addEventListener("visibilitychange", () => setRunning(!document.hidden && !reduceMotion));

  onResize();
  if (reduceMotion) { applyLight(); drawGL(0); } else setRunning(!document.hidden);

  /* ---------------- bucket reveal ---------------- */

  // spiral outward from the centre, the order most renderers use
  const spiralOrder = (cols, rows) => {
    const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
    const cells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const dx = x - cx, dy = (y - cy) * (cols / rows);
      cells.push({ i: y * cols + x, ring: Math.round(Math.max(Math.abs(dx), Math.abs(dy))), ang: Math.atan2(dy, dx) });
    }
    cells.sort((a, b) => a.ring - b.ring || a.ang - b.ang);
    return cells.map((c) => c.i);
  };

  const frames = Array.from(document.querySelectorAll(".frame"));

  if (!reduceMotion && "IntersectionObserver" in window) {
    frames.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const cols = rect.width > 300 ? 8 : 6;
      const rows = Math.max(2, Math.round(cols * rect.height / Math.max(rect.width, 1)));
      const grid = document.createElement("span");
      grid.className = "buckets";
      grid.setAttribute("aria-hidden", "true");
      grid.style.setProperty("--cols", cols);
      grid.style.setProperty("--rows", rows);
      for (let i = 0; i < cols * rows; i++) {
        const b = document.createElement("span");
        b.className = "bucket";
        grid.appendChild(b);
      }
      el.appendChild(grid);
      el._buckets = { grid, order: spiralOrder(cols, rows) };
    });

    const renderFrame = (el) => {
      const { grid, order } = el._buckets;
      const img = el.querySelector("img");
      const tiles = grid.children;
      const step = Math.max(26, Math.min(60, 1500 / order.length));
      const go = () => {
        order.forEach((idx, n) => {
          setTimeout(() => tiles[idx].classList.add("active"), n * step);
          setTimeout(() => { tiles[idx].classList.remove("active"); tiles[idx].classList.add("done"); }, n * step + step * 2.2);
        });
        setTimeout(() => grid.remove(), order.length * step + 900);
      };
      if (!img || img.complete) go();
      else { img.addEventListener("load", go, { once: true }); img.addEventListener("error", () => grid.remove(), { once: true }); }
    };

    const seen = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        seen.unobserve(entry.target);
        renderFrame(entry.target);
      });
    }, { threshold: 0.35 });
    frames.forEach((el) => seen.observe(el));
  }

  /* ---------------- research diagrams ---------------- */

  const glyphs = document.querySelectorAll(".glyph");
  if (!reduceMotion && "IntersectionObserver" in window) {
    const draw = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        draw.unobserve(entry.target);
        entry.target.classList.add("in");
      });
    }, { threshold: 0.6 });
    glyphs.forEach((g) => draw.observe(g));
  } else {
    glyphs.forEach((g) => g.classList.add("in"));
  }
})();
