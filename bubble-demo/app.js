import { BubbleSimulation } from "./physics.js";
import { BubbleRenderer } from "./renderer.js";
import { rayFromScreen } from "./math.js";

const canvas = document.querySelector("#scene");
const errorScreen = document.querySelector("#error");
const loadingLabel = document.querySelector("#loading-label");
const fpsLabel = document.querySelector("#fps");
const countLabel = document.querySelector("#counts");
const simulation = new BubbleSimulation();

let renderer;
try {
  renderer = new BubbleRenderer(canvas, simulation, {
    onEnvironmentLoading(index, progress) {
      loadingLabel.hidden = false;
      loadingLabel.textContent = progress > 0
        ? `HDR ${index + 1} · ${Math.round(progress * 100)}%`
        : `正在载入 HDR ${index + 1}`;
    },
    onEnvironmentLoaded() {
      loadingLabel.hidden = true;
    },
    onEnvironmentError() {
      loadingLabel.hidden = false;
      loadingLabel.textContent = "HDR 载入失败，使用后备环境";
    }
  });
} catch (error) {
  console.error(error);
  errorScreen.classList.add("visible");
  document.querySelector("#error-detail").textContent = error.message;
  throw error;
}

const parameterInputs = [...document.querySelectorAll("[data-param]")];
const materialParameters = new Set(["eta2", "eta3", "kappa3"]);
let lutTimer = 0;

function inputValue(input) {
  return input.type === "checkbox" ? input.checked : Number(input.value);
}

function updateOutput(input) {
  const output = document.querySelector(`[data-output="${input.dataset.param}"]`);
  if (!output) return;
  const value = Number(input.value);
  const precision = Number(input.dataset.precision ?? 2);
  const suffix = input.dataset.suffix ?? "";
  output.textContent = `${value.toFixed(precision)}${suffix}`;
}

function scheduleLutUpdate() {
  clearTimeout(lutTimer);
  loadingLabel.hidden = false;
  loadingLabel.textContent = "正在重建薄膜 LUT";
  lutTimer = window.setTimeout(() => {
    renderer.updateThinFilmLut();
    loadingLabel.hidden = true;
  }, 120);
}

parameterInputs.forEach((input) => {
  const name = input.dataset.param;
  const sync = () => {
    simulation.setParameter(name, inputValue(input));
    updateOutput(input);
    if (materialParameters.has(name)) scheduleLutUpdate();
    if (name === "singlePreview") updateModeButtons();
    if (name === "wetness") {
      simulation.updateBondRestDistances();
      simulation.rebuildConnectionGeometry();
    }
  };
  input.addEventListener("input", sync);
  input.addEventListener("change", sync);
  updateOutput(input);
});

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === button);
      candidate.setAttribute("aria-selected", String(candidate === button));
    });
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
  });
});

const observeButton = document.querySelector("#mode-observe");
const interactButton = document.querySelector("#mode-interact");

function updateModeButtons() {
  observeButton.classList.toggle("active", !simulation.params.interactionMode);
  interactButton.classList.toggle("active", simulation.params.interactionMode);
  observeButton.setAttribute("aria-pressed", String(!simulation.params.interactionMode));
  interactButton.setAttribute("aria-pressed", String(simulation.params.interactionMode));
  const previewInput = document.querySelector('[data-param="singlePreview"]');
  previewInput.checked = simulation.params.singlePreview;
}

observeButton.addEventListener("click", () => {
  simulation.setInteractionMode(false);
  updateModeButtons();
});

interactButton.addEventListener("click", () => {
  simulation.setInteractionMode(true);
  updateModeButtons();
});

const environmentButtons = [...document.querySelectorAll("[data-environment]")];
let selectedEnvironment = 0;

function selectEnvironment(index) {
  selectedEnvironment = index;
  environmentButtons.forEach((button, buttonIndex) => {
    button.classList.toggle("active", buttonIndex === index);
    button.setAttribute("aria-pressed", String(buttonIndex === index));
  });
  renderer.setEnvironment(index);
}

environmentButtons.forEach((button, index) => {
  button.addEventListener("click", () => selectEnvironment(index));
});

let showcaseEnvironmentTimer = 0;
let showcaseLaunchTimer = 0;

function stopShowcaseTimers() {
  clearInterval(showcaseEnvironmentTimer);
  clearInterval(showcaseLaunchTimer);
  showcaseEnvironmentTimer = 0;
  showcaseLaunchTimer = 0;
}

document.querySelector("#showcase").addEventListener("change", (event) => {
  simulation.setShowcaseMode(event.target.checked);
  stopShowcaseTimers();
  if (!event.target.checked) return;
  simulation.params.singlePreview = false;
  document.querySelector('[data-param="singlePreview"]').checked = false;
  simulation.launchBubble();
  showcaseEnvironmentTimer = window.setInterval(() => {
    selectEnvironment((selectedEnvironment + 1) % environmentButtons.length);
  }, 1500);
  showcaseLaunchTimer = window.setInterval(() => simulation.launchBubble(), 66);
});

const launchButton = document.querySelector("#launch");
let launchTimer = 0;
let launchHeld = false;

["selectstart", "contextmenu", "dragstart"].forEach((eventName) => {
  launchButton.addEventListener(eventName, (event) => event.preventDefault());
});
document.addEventListener("selectstart", (event) => {
  if (launchHeld) event.preventDefault();
});

function stopLaunching() {
  clearInterval(launchTimer);
  launchTimer = 0;
  launchHeld = false;
  launchButton.classList.remove("held");
}

launchButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  launchHeld = true;
  window.getSelection()?.removeAllRanges();
  simulation.launchBubble();
  launchButton.classList.add("held");
  launchButton.setPointerCapture(event.pointerId);
  launchTimer = window.setInterval(() => simulation.launchBubble(), 50);
});
launchButton.addEventListener("pointerup", stopLaunching);
launchButton.addEventListener("pointercancel", stopLaunching);
launchButton.addEventListener("lostpointercapture", stopLaunching);
window.addEventListener("blur", stopLaunching);

document.querySelector("#clear").addEventListener("click", () => simulation.clear());

let pointerActive = false;
let pointerId = -1;
let previousPointerX = 0;
let camera = simulation.getCamera(1);

function localPointer(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    width: rect.width,
    height: rect.height
  };
}

canvas.addEventListener("pointerdown", (event) => {
  const point = localPointer(event);
  pointerActive = true;
  pointerId = event.pointerId;
  previousPointerX = point.x;
  canvas.setPointerCapture(event.pointerId);
  renderer.setTouch(point.x, point.y, true);
  if (simulation.params.interactionMode) {
    const ray = rayFromScreen(camera, point.x, point.y, point.width, point.height);
    simulation.pointerDown(
      ray,
      [point.x, point.y],
      event.timeStamp / 1000,
      camera
    );
  }
});

canvas.addEventListener("pointermove", (event) => {
  const point = localPointer(event);
  if (!pointerActive || event.pointerId !== pointerId) return;
  renderer.setTouch(point.x, point.y, true);
  if (simulation.params.interactionMode) {
    const ray = rayFromScreen(camera, point.x, point.y, point.width, point.height);
    simulation.pointerMove(
      ray,
      [point.x, point.y],
      event.timeStamp / 1000,
      camera,
      { width: point.width, height: point.height }
    );
  } else {
    simulation.cameraYaw += (point.x - previousPointerX) * .5 * Math.PI / 180;
    previousPointerX = point.x;
  }
});

function endPointer(event) {
  if (!pointerActive || event.pointerId !== pointerId) return;
  pointerActive = false;
  pointerId = -1;
  simulation.pointerUp();
  renderer.setTouch(0, 0, false);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

let previousFrame = performance.now();
let fpsAccumulator = 0;
let fpsFrameCount = 0;
let fpsUpdateTime = previousFrame;

function frame(now) {
  const deltaTime = Math.min((now - previousFrame) / 1000, .05);
  previousFrame = now;
  const aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
  simulation.update(deltaTime, aspect);
  camera = renderer.render();

  fpsAccumulator += deltaTime;
  fpsFrameCount += 1;
  if (now - fpsUpdateTime >= 500) {
    simulation.fps = fpsFrameCount / Math.max(fpsAccumulator, .001);
    fpsLabel.textContent = `${simulation.fps.toFixed(1)} FPS`;
    countLabel.textContent = simulation.params.singlePreview
      ? "单泡泡预览"
      : `${simulation.bubbles.length} 泡泡 · ${simulation.bonds.length} 连接`;
    fpsAccumulator = 0;
    fpsFrameCount = 0;
    fpsUpdateTime = now;
  }
  requestAnimationFrame(frame);
}

window.addEventListener("beforeunload", stopShowcaseTimers);
updateModeButtons();
requestAnimationFrame(frame);
