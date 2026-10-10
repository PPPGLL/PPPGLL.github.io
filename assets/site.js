/* Gaole Pan — homepage behaviour
   1. A small ray-traced scene in WebGL: spheres on a glossy floor under a
      green sky. The pointer moves the sun. Without a pointer, it drifts.
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

  // the corner link only appears once the hero has scrolled away
  const header = document.querySelector(".site-header");
  const hero = document.querySelector(".hero");
  const markScrolled = () => header.classList.toggle("scrolled", window.scrollY > hero.offsetHeight * 0.6);
  window.addEventListener("scroll", markScrolled, { passive: true });
  markScrolled();

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

// A small ray-traced still life: four spheres on a glossy checkered floor
// under a green sky. The pointer moves the sun; scrolling tilts the camera
// up into the sky so the text further down sits on a calm backdrop.

vec3 L;                 // sun direction
vec4 S0, S1, S2, S3;    // spheres: xyz centre, w radius

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

vec3 sky(vec3 d) {
  float h = d.y;
  vec3 zenith  = vec3(0.012, 0.085, 0.072);
  vec3 horizon = vec3(0.110, 0.340, 0.255);
  vec3 c = mix(horizon, zenith, smoothstep(-0.08, 0.70, h));
  float s = max(dot(d, L), 0.0);
  c += vec3(1.00, 0.93, 0.76) * pow(s, 90.0) * 1.6;      // sun
  c += vec3(0.45, 0.85, 0.60) * pow(s, 6.0) * 0.30;      // its halo
  // slow ribbons of light high in the sky
  float a = atan(d.x, -d.z);
  float n = noise(vec2(a * 2.2 + uTime * 0.02, h * 2.6 - uTime * 0.013))
          + 0.5 * noise(vec2(a * 5.0 - uTime * 0.03, h * 6.0));
  c += vec3(0.10, 0.62, 0.44) * smoothstep(0.75, 1.25, n) * smoothstep(0.10, 0.55, h) * 0.55;
  return c;
}

float hitSphere(vec3 ro, vec3 rd, vec4 s) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - s.w * s.w;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  return -b - sqrt(h);
}

// soft shadow of one sphere along a ray towards the sun
float shade1(vec3 p, vec4 s) {
  vec3 oc = s.xyz - p;
  float t = dot(oc, L);
  if (t < 0.0) return 1.0;
  float d = length(oc - L * t);
  return smoothstep(s.w * 0.80, s.w * 1.30, d);
}
float shadow(vec3 p) {
  return shade1(p, S0) * shade1(p, S1) * shade1(p, S2);
}
float occ1(vec3 p, vec3 n, vec4 s) {
  vec3 d = s.xyz - p;
  float l = length(d);
  return 1.0 - max(dot(n, d / l), 0.0) * (s.w * s.w) / (l * l) * 0.9;
}

void main() {
  vec2 frag = gl_FragCoord.xy * uScale;
  float aspect = uRes.x / uRes.y;
  vec2 uv = (frag - 0.5 * uRes) / uRes.y;
  uv *= clamp(1.3 / aspect, 1.0, 2.4);                    // pull back on tall screens
  uv.x -= 0.20 * clamp(aspect - 0.9, 0.0, 1.0);
  uv.y += 0.17;          // sit the scene right of the text

  vec2 m = uLight / uRes;                                 // 0..1, y down
  L = normalize(vec3((m.x - 0.5) * 2.4, 0.95 + (0.5 - m.y) * 0.9, 0.85));

  float t = uTime;
  S0 = vec4( 0.00, 1.00 + 0.03 * sin(t * 0.6),        0.00, 1.00);   // chrome
  S1 = vec4(-1.80, 0.62 + 0.04 * sin(t * 0.7 + 1.0),  0.80, 0.60);   // emerald
  S2 = vec4(-0.75, 0.47 + 0.04 * sin(t * 0.8 + 2.0),  2.30, 0.45);   // porcelain
  S3 = vec4( 0.55, 0.24 + 0.03 * sin(t * 0.9 + 3.0),  2.10, 0.22);   // lamp

  float pitch = -0.26 + min(uScroll / uRes.y, 1.5) * 0.95;
  vec3 ro = vec3((m.x - 0.5) * 0.5, 2.35 + (0.5 - m.y) * 0.2, 11.5);
  vec3 f = vec3(0.0, sin(pitch), -cos(pitch));
  vec3 u = vec3(0.0, cos(pitch), sin(pitch));
  vec3 rd = normalize(f * 1.9 + uv.x * vec3(1.0, 0.0, 0.0) + uv.y * u);

  vec3 col = vec3(0.0);
  vec3 thr = vec3(1.0);
  vec3 lamp = vec3(1.00, 0.78, 0.42);

  for (int bounce = 0; bounce < 3; bounce++) {
    float tm = 1e9; int id = -1;
    float h;
    h = hitSphere(ro, rd, S0); if (h > 0.001 && h < tm) { tm = h; id = 0; }
    h = hitSphere(ro, rd, S1); if (h > 0.001 && h < tm) { tm = h; id = 1; }
    h = hitSphere(ro, rd, S2); if (h > 0.001 && h < tm) { tm = h; id = 2; }
    h = hitSphere(ro, rd, S3); if (h > 0.001 && h < tm) { tm = h; id = 3; }
    if (rd.y < 0.0) { h = -ro.y / rd.y; if (h > 0.001 && h < tm) { tm = h; id = 4; } }

    if (id < 0) { col += thr * sky(rd); thr = vec3(0.0); break; }

    vec3 p = ro + rd * tm;
    vec3 n;
    if (id == 0) n = (p - S0.xyz) / S0.w;
    else if (id == 1) n = (p - S1.xyz) / S1.w;
    else if (id == 2) n = (p - S2.xyz) / S2.w;
    else if (id == 3) n = (p - S3.xyz) / S3.w;
    else n = vec3(0.0, 1.0, 0.0);

    float ndv = max(dot(n, -rd), 0.0);
    float fres = pow(1.0 - ndv, 5.0);
    float ndl = max(dot(n, L), 0.0);
    float sh = shadow(p + n * 0.002);
    vec3 amb = mix(vec3(0.04, 0.12, 0.09), vec3(0.11, 0.28, 0.22), 0.5 + 0.5 * n.y);
    float spec = pow(max(dot(n, normalize(L - rd)), 0.0), 70.0) * sh;

    // warm fill from the little lamp
    vec3 toLamp = S3.xyz - p;
    float ld = dot(toLamp, toLamp);
    vec3 fill = lamp * max(dot(n, toLamp * inversesqrt(ld)), 0.0) / (1.0 + ld * 2.2) * 1.3;

    vec3 base; vec3 tint; float k;
    if (id == 0) {                      // chrome
      base = vec3(0.0); tint = vec3(0.90, 0.97, 0.93); k = 0.92;
    } else if (id == 1) {               // emerald, glossy
      vec3 alb = vec3(0.04, 0.58, 0.33);
      base = alb * (ndl * sh * 1.25 + amb + fill) + vec3(1.0) * spec * 0.9;
      tint = vec3(1.0); k = 0.05 + 0.6 * fres;
    } else if (id == 2) {               // white porcelain
      vec3 alb = vec3(0.90, 0.94, 0.91);
      base = alb * (ndl * sh * 0.95 + amb * 1.2 + fill) + vec3(1.0) * spec * 0.8;
      tint = vec3(1.0); k = 0.05 + 0.55 * fres;
    } else if (id == 3) {               // lamp
      base = lamp * (1.6 + 1.6 * ndv); tint = vec3(0.0); k = 0.0;
    } else {                            // floor
      vec2 c = floor(p.xz * 0.9);
      float chk = mod(c.x + c.y, 2.0);
      chk = mix(chk, 0.5, smoothstep(5.0, 20.0, tm));     // fade the pattern before it aliases
      vec3 alb = mix(vec3(0.020, 0.115, 0.085), vec3(0.036, 0.170, 0.125), chk);
      float ao = occ1(p, n, S0) * occ1(p, n, S1) * occ1(p, n, S2) * occ1(p, n, S3);
      base = alb * (ndl * sh * 1.2 + amb * ao + fill * 1.6);
      tint = vec3(1.0); k = 0.07 + 0.5 * fres;
    }

    // distance haze so the floor melts into the horizon
    float fog = 1.0 - exp(-max(tm - 6.0, 0.0) * 0.05);
    vec3 hz = sky(normalize(vec3(rd.x, 0.02, rd.z)));
    col += thr * mix(base * (1.0 - k), hz, fog);
    thr *= tint * k * (1.0 - fog);

    ro = p + n * 0.002;
    rd = reflect(rd, n);
  }
  col += thr * sky(rd);

  col *= 0.78;
  col = col * (2.51 * col + 0.03) / (col * (2.43 * col + 0.59) + 0.14);   // filmic
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
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
    const maxPixels = 1400000;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
