import { BubbleSimulation } from "./physics.js?v=20260807-13";
import { BubbleRenderer } from "./renderer.js?v=20260807-13";
import { rayFromScreen } from "./math.js?v=20260807-13";

const canvas = document.querySelector("#scene");
const errorScreen = document.querySelector("#error");
const loadingLabel = document.querySelector("#loading-label");
const fpsLabel = document.querySelector("#fps");
const countLabel = document.querySelector("#counts");
const controlPanel = document.querySelector(".control-panel");
const simulation = new BubbleSimulation();

document.querySelector("#panel-collapse").addEventListener("click", (event) => {
  const collapsed = controlPanel.classList.toggle("collapsed");
  event.currentTarget.textContent = collapsed ? "+" : "−";
  event.currentTarget.setAttribute("aria-label", collapsed ? "展开参数面板" : "收起参数面板");
});

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
  if (input.dataset.format === "percent") {
    output.textContent = `${Math.round(value * 100)}%`;
    return;
  }
  const precision = Number(input.dataset.precision ?? 2);
  const suffix = input.dataset.suffix ?? "";
  if (input.dataset.param === "depthOfFieldMode") {
    output.textContent = value === 0 ? "单次" : "逐层";
    return;
  }
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

const staticButton = document.querySelector("#workspace-static");
const realtimeButton = document.querySelector("#workspace-realtime");
const browseButton = document.querySelector("#tool-browse");
const editButton = document.querySelector("#tool-edit");

function updateModeButtons() {
  staticButton.classList.toggle("active", simulation.params.workspaceMode === "static");
  realtimeButton.classList.toggle("active", simulation.params.workspaceMode === "realtime");
  browseButton.classList.toggle("active", simulation.params.toolMode === "browse");
  editButton.classList.toggle("active", simulation.params.toolMode === "edit");
  const previewInput = document.querySelector('[data-param="singlePreview"]');
  previewInput.checked = simulation.params.singlePreview;
  updateSelectionPanel();
}

staticButton.addEventListener("click", () => {
  simulation.setWorkspaceMode("static");
  updateModeButtons();
});

realtimeButton.addEventListener("click", () => {
  simulation.setWorkspaceMode("realtime");
  updateModeButtons();
});

browseButton.addEventListener("click", () => {
  simulation.setToolMode("browse");
  updateModeButtons();
});

editButton.addEventListener("click", () => {
  simulation.setToolMode("edit");
  updateModeButtons();
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
  if (simulation.params.workspaceMode !== "realtime") {
    simulation.setWorkspaceMode("realtime");
    simulation.setToolMode("browse");
    updateModeButtons();
  }
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

document.querySelector("#clear").addEventListener("click", () => {
  simulation.clear();
  updateSelectionPanel();
});
document.querySelector("#clear-top").addEventListener("click", () => {
  simulation.clear();
  updateSelectionPanel();
});

function centerRay() {
  const rect = canvas.getBoundingClientRect();
  return rayFromScreen(camera, rect.width * .5, rect.height * .5, rect.width, rect.height);
}

document.querySelector("#random-place").addEventListener("click", () => {
  if (simulation.params.workspaceMode !== "static" || simulation.params.toolMode !== "edit") {
    simulation.setWorkspaceMode("static");
    simulation.setToolMode("edit");
    updateModeButtons();
  }
  const previousRandomize = simulation.params.randomize;
  simulation.params.randomize = true;
  simulation.addBubblesAtRay(centerRay(), camera, 0);
  simulation.params.randomize = previousRandomize;
  updateSelectionPanel();
});
document.querySelector("#duplicate-selected").addEventListener("click", () => {
  simulation.duplicateSelected();
  updateSelectionPanel();
});
document.querySelector("#shrink-selected").addEventListener("click", () => {
  simulation.scaleSelected(.9);
  updateSelectionPanel();
});
document.querySelector("#grow-selected").addEventListener("click", () => {
  simulation.scaleSelected(1.1);
  updateSelectionPanel();
});
document.querySelector("#delete-selected").addEventListener("click", () => {
  simulation.deleteSelected();
  updateSelectionPanel();
});

const selectedPanel = document.querySelector("#selected-panel");
const selectedProperties = document.querySelector("#selected-properties");
const selectedCount = document.querySelector("#selected-count");
const selectedInputs = [...document.querySelectorAll("[data-selected-prop]")];
const selectedModeRows = [...document.querySelectorAll("[data-selected-mode]")];
const multiEditActions = document.querySelector("#multi-edit-actions");

const selectedFieldFormat = {
  physicalRadius: { get: (bubble) => bubble.physicalRadius * 100, patch: (value) => value * .01, digits: 1, suffix: " cm" },
  filmThickness: { get: (bubble) => bubble.filmThickness, patch: (value) => value, digits: 0, suffix: " nm" },
  flowEnabled: { get: (bubble) => bubble.flowEnabled, patch: (value) => value },
  flowNoiseScale: { get: (bubble) => bubble.flowNoiseScale, patch: (value) => value, digits: 2, suffix: "" },
  flowSpeed: { get: (bubble) => bubble.flowSpeed, patch: (value) => value, digits: 2, suffix: "" },
  flowAmplitude: { get: (bubble) => bubble.flowAmplitude, patch: (value) => value, digits: 0, suffix: " nm" },
  surfaceTension: { get: (bubble) => bubble.surfaceTension * 1000, patch: (value) => value * .001, digits: 1, suffix: " mN/m" },
  dampingRatio: { get: (bubble) => bubble.dampingRatio, patch: (value) => value, digits: 2, suffix: "" }
};

function updateSelectionPanel() {
  const selected = simulation.selectedBubbles();
  const visible = simulation.params.toolMode === "edit" && selected.length > 0;
  selectedPanel.hidden = !visible;
  if (!visible) return;
  selectedCount.textContent = `${selected.length} 个`;
  selectedProperties.hidden = selected.length !== 1;
  selectedModeRows.forEach((row) => {
    row.hidden = row.dataset.selectedMode !== simulation.params.workspaceMode;
  });
  multiEditActions.hidden = simulation.params.workspaceMode !== "static";
  if (selected.length !== 1) return;
  const bubble = selected[0];
  selectedInputs.forEach((input) => {
    const configuration = selectedFieldFormat[input.dataset.selectedProp];
    const value = configuration.get(bubble);
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
    const output = document.querySelector(`[data-selected-output="${input.dataset.selectedProp}"]`);
    if (output) output.textContent = `${Number(value).toFixed(configuration.digits)}${configuration.suffix}`;
  });
}

selectedInputs.forEach((input) => {
  input.addEventListener("input", () => {
    const name = input.dataset.selectedProp;
    const configuration = selectedFieldFormat[name];
    const rawValue = input.type === "checkbox" ? input.checked : Number(input.value);
    simulation.updateSelectedProperties({ [name]: configuration.patch(rawValue) });
    updateSelectionPanel();
  });
  input.addEventListener("change", updateSelectionPanel);
});

const snapshotPanel = document.querySelector("#snapshot-panel");
const snapshotSlots = document.querySelector("#snapshot-slots");
const snapshotPreview = document.querySelector("#snapshot-preview");
let selectedSnapshotSlot = 1;

function snapshotKey(slot, kind = "scene") {
  return `bubble-demo-v6-${kind}-${slot}`;
}

function showTransientStatus(message, duration = 1400) {
  loadingLabel.hidden = false;
  loadingLabel.textContent = message;
  window.setTimeout(() => { loadingLabel.hidden = true; }, duration);
}

function syncParameterInputs() {
  parameterInputs.forEach((input) => {
    const value = simulation.params[input.dataset.param];
    if (value === undefined) return;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
    updateOutput(input);
  });
}

function updateSnapshotSlots() {
  [...snapshotSlots.children].forEach((button, index) => {
    const slot = index + 1;
    button.classList.toggle("active", slot === selectedSnapshotSlot);
    button.classList.toggle("saved", localStorage.getItem(snapshotKey(slot)) !== null);
  });
  const thumbnail = localStorage.getItem(snapshotKey(selectedSnapshotSlot, "thumbnail"));
  snapshotPreview.hidden = !thumbnail;
  if (thumbnail) snapshotPreview.src = thumbnail;
  else snapshotPreview.removeAttribute("src");
}

for (let slot = 1; slot <= 6; slot += 1) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "snapshot-slot";
  button.textContent = String(slot);
  button.addEventListener("click", () => {
    selectedSnapshotSlot = slot;
    updateSnapshotSlots();
  });
  snapshotSlots.append(button);
}

document.querySelector("#snapshot-toggle").addEventListener("click", () => {
  snapshotPanel.hidden = !snapshotPanel.hidden;
  if (!snapshotPanel.hidden) updateSnapshotSlots();
});

function captureSnapshotThumbnail() {
  renderer.render();
  const thumbnailCanvas = document.createElement("canvas");
  thumbnailCanvas.width = 240;
  thumbnailCanvas.height = 135;
  thumbnailCanvas.getContext("2d").drawImage(canvas, 0, 0, 240, 135);
  return thumbnailCanvas.toDataURL("image/jpeg", .72);
}

document.querySelector("#snapshot-save").addEventListener("click", () => {
  const key = snapshotKey(selectedSnapshotSlot);
  if (localStorage.getItem(key) !== null &&
      !window.confirm(`快照槽位 ${selectedSnapshotSlot} 已有场景，是否覆盖？`)) return;
  localStorage.setItem(key, JSON.stringify(simulation.exportScene()));
  try {
    localStorage.setItem(
      snapshotKey(selectedSnapshotSlot, "thumbnail"),
      captureSnapshotThumbnail()
    );
  } catch {
    localStorage.removeItem(snapshotKey(selectedSnapshotSlot, "thumbnail"));
  }
  updateSnapshotSlots();
  showTransientStatus(`场景已保存到快照槽位 ${selectedSnapshotSlot}`);
});

document.querySelector("#snapshot-load").addEventListener("click", () => {
  try {
    const snapshot = JSON.parse(localStorage.getItem(snapshotKey(selectedSnapshotSlot)) || "null");
    if (!simulation.importScene(snapshot)) throw new Error("empty");
    syncParameterInputs();
    updateModeButtons();
    updateSelectionPanel();
    showTransientStatus(`快照槽位 ${selectedSnapshotSlot} 读取完成`, 1200);
  } catch {
    showTransientStatus(`快照槽位 ${selectedSnapshotSlot} 还没有场景`, 1500);
  }
});

let pointerActive = false;
let pointerId = -1;
let previousPointerX = 0;
let previousPointerY = 0;
let camera = simulation.getCamera(1);
let pointerMode = "none";
const activePointers = new Map();
let gesturePreviousMidpoint = [0, 0];
let gesturePreviousDistance = 0;
let fovOverlayTimer = 0;
const fovOverlay = document.querySelector("#fov-overlay");
let boxTimer = 0;
let bubbleLongPressTimer = 0;
let boxStart = [0, 0];
let boxCurrent = [0, 0];
let bubbleLongPressStart = [0, 0];
let bubbleLongPressEvent = null;
let lastBlankTap = { time: -1000, x: 0, y: 0 };
const selectionBox = document.querySelector("#selection-box");

function localPointer(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    width: rect.width,
    height: rect.height
  };
}

function clearBoxTimer() {
  clearTimeout(boxTimer);
  boxTimer = 0;
}

function clearBubbleLongPressTimer() {
  clearTimeout(bubbleLongPressTimer);
  bubbleLongPressTimer = 0;
  bubbleLongPressEvent = null;
}

function drawSelectionBox() {
  const rect = canvas.getBoundingClientRect();
  const left = Math.min(boxStart[0], boxCurrent[0]) + rect.left;
  const top = Math.min(boxStart[1], boxCurrent[1]) + rect.top;
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${Math.abs(boxCurrent[0] - boxStart[0])}px`;
  selectionBox.style.height = `${Math.abs(boxCurrent[1] - boxStart[1])}px`;
}

function cancelBoxSelection() {
  clearBoxTimer();
  clearBubbleLongPressTimer();
  selectionBox.classList.remove("active");
}

function syncCameraDistanceInput() {
  const input = document.querySelector('[data-param="cameraDistance"]');
  input.value = String(simulation.params.cameraDistance);
  updateOutput(input);
}

function syncCameraFovInput(showOverlay = false) {
  const input = document.querySelector('[data-param="cameraFov"]');
  input.value = String(simulation.params.cameraFov);
  updateOutput(input);
  if (!showOverlay) return;
  clearTimeout(fovOverlayTimer);
  fovOverlay.textContent = `FOV ${Math.round(simulation.params.cameraFov)}°`;
  fovOverlay.hidden = false;
  fovOverlayTimer = window.setTimeout(() => { fovOverlay.hidden = true; }, 700);
}

function orbitCamera(deltaX, deltaY) {
  simulation.cameraYaw += deltaX * .5 * Math.PI / 180;
  const pitchLimit = 85 * Math.PI / 180;
  simulation.cameraPitch = Math.max(-pitchLimit, Math.min(pitchLimit,
    simulation.cameraPitch + deltaY * .5 * Math.PI / 180));
}

function panCamera(deltaX, deltaY, viewportHeight) {
  const worldPerPixel = 2 * simulation.params.cameraDistance * camera.tanHalfFov /
    Math.max(viewportHeight, 1);
  const target = simulation.cameraTarget;
  for (let axis = 0; axis < 3; axis += 1) {
    target[axis] += camera.right[axis] * (-deltaX * worldPerPixel) +
      camera.up[axis] * (deltaY * worldPerPixel);
  }
}

function beginTwoPointerGesture() {
  const points = [...activePointers.values()];
  if (points.length < 2) return false;
  if (pointerMode === "bubble-edit") simulation.pointerUp();
  cancelBoxSelection();
  pointerMode = "camera-gesture";
  gesturePreviousMidpoint = [
    (points[0].x + points[1].x) * .5,
    (points[0].y + points[1].y) * .5
  ];
  gesturePreviousDistance = Math.max(Math.hypot(
    points[1].x - points[0].x,
    points[1].y - points[0].y
  ), 1);
  renderer.setTouch(0, 0, false);
  return true;
}

canvas.addEventListener("pointerdown", (event) => {
  const point = localPointer(event);
  activePointers.set(event.pointerId, point);
  canvas.setPointerCapture(event.pointerId);
  if (activePointers.size >= 2 && beginTwoPointerGesture()) {
    event.preventDefault();
    return;
  }
  pointerActive = true;
  pointerId = event.pointerId;
  previousPointerX = point.x;
  previousPointerY = point.y;
  renderer.setTouch(point.x, point.y, true);
  if (event.shiftKey || event.button === 1 || event.button === 2) {
    pointerMode = "camera-pan";
    event.preventDefault();
    return;
  }
  pointerMode = simulation.params.toolMode === "edit" ? "edit" : "browse";
  if (simulation.params.toolMode === "edit") {
    const ray = rayFromScreen(camera, point.x, point.y, point.width, point.height);
    const picked = simulation.pickBubble(ray);
    if (!picked) {
      if (simulation.params.workspaceMode === "static") {
        pointerMode = "box-candidate";
        boxStart = [point.x, point.y];
        boxCurrent = [point.x, point.y];
        clearBoxTimer();
        boxTimer = window.setTimeout(() => {
          if (pointerMode !== "box-candidate") return;
          pointerMode = "box-select";
          simulation.clearSelection();
          selectionBox.classList.add("active");
          drawSelectionBox();
          updateSelectionPanel();
        }, 250);
      } else {
        // Realtime edit pauses external interaction; blank drag orbits the camera.
        pointerMode = "browse";
      }
    } else if (simulation.selectedIds.includes(picked.bubble.id)) {
      pointerMode = "bubble-edit";
      simulation.pointerDown(
        ray,
        [point.x, point.y],
        event.timeStamp / 1000,
        camera
      );
      updateSelectionPanel();
    } else {
      pointerMode = "bubble-candidate";
      bubbleLongPressStart = [point.x, point.y];
      bubbleLongPressEvent = {
        ray,
        screen: [point.x, point.y],
        timestamp: event.timeStamp / 1000
      };
      clearTimeout(bubbleLongPressTimer);
      bubbleLongPressTimer = window.setTimeout(() => {
        if (pointerMode !== "bubble-candidate" || !bubbleLongPressEvent) return;
        const pending = bubbleLongPressEvent;
        pointerMode = "bubble-edit";
        simulation.pointerDown(pending.ray, pending.screen, pending.timestamp, camera);
        bubbleLongPressTimer = 0;
        bubbleLongPressEvent = null;
        updateSelectionPanel();
      }, 250);
    }
  } else if (simulation.params.workspaceMode === "realtime") {
    // Native realtime browse uses the primary pointer for bubble dragging,
    // double-tap popping, airflow and exposed-bond cutting. Camera movement
    // remains available through right/middle/Shift drag and multitouch.
    const ray = rayFromScreen(camera, point.x, point.y, point.width, point.height);
    pointerMode = "live-interaction";
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
  if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, point);
  if (pointerMode === "camera-gesture" && activePointers.size >= 2) {
    const points = [...activePointers.values()];
    const midpoint = [
      (points[0].x + points[1].x) * .5,
      (points[0].y + points[1].y) * .5
    ];
    const distance = Math.max(Math.hypot(
      points[1].x - points[0].x,
      points[1].y - points[0].y
    ), 1);
    panCamera(
      midpoint[0] - gesturePreviousMidpoint[0],
      midpoint[1] - gesturePreviousMidpoint[1],
      point.height
    );
    simulation.params.cameraFov = Math.max(25, Math.min(90,
      simulation.params.cameraFov * gesturePreviousDistance / distance));
    gesturePreviousMidpoint = midpoint;
    gesturePreviousDistance = distance;
    syncCameraFovInput(true);
    event.preventDefault();
    return;
  }
  if (!pointerActive || event.pointerId !== pointerId) return;
  renderer.setTouch(point.x, point.y, true);
  if (pointerMode === "box-select") {
    boxCurrent = [point.x, point.y];
    drawSelectionBox();
  } else if (pointerMode === "box-candidate") {
    boxCurrent = [point.x, point.y];
    if (Math.hypot(point.x - boxStart[0], point.y - boxStart[1]) > 10) {
      clearBoxTimer();
      pointerMode = "browse";
      orbitCamera(point.x - previousPointerX, point.y - previousPointerY);
      previousPointerX = point.x;
      previousPointerY = point.y;
    }
  } else if (pointerMode === "bubble-candidate") {
    if (Math.hypot(
      point.x - bubbleLongPressStart[0],
      point.y - bubbleLongPressStart[1]
    ) > 10) {
      clearBubbleLongPressTimer();
      pointerMode = "browse";
      orbitCamera(point.x - previousPointerX, point.y - previousPointerY);
      previousPointerX = point.x;
      previousPointerY = point.y;
    }
  } else if (pointerMode === "bubble-edit" || pointerMode === "live-interaction") {
    const ray = rayFromScreen(camera, point.x, point.y, point.width, point.height);
    simulation.pointerMove(
      ray,
      [point.x, point.y],
      event.timeStamp / 1000,
      camera,
      { width: point.width, height: point.height }
    );
  } else if (pointerMode === "browse") {
    orbitCamera(point.x - previousPointerX, point.y - previousPointerY);
    previousPointerX = point.x;
    previousPointerY = point.y;
  } else if (pointerMode === "camera-pan") {
    panCamera(point.x - previousPointerX, point.y - previousPointerY, point.height);
    previousPointerX = point.x;
    previousPointerY = point.y;
  }
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  simulation.params.cameraDistance = Math.max(20, Math.min(120,
    simulation.params.cameraDistance * Math.exp(event.deltaY * .001)));
  syncCameraDistanceInput();
}, { passive: false });

function endPointer(event) {
  activePointers.delete(event.pointerId);
  if (pointerMode === "camera-gesture") {
    if (activePointers.size < 2) {
      pointerActive = false;
      pointerId = -1;
      pointerMode = "none";
      renderer.setTouch(0, 0, false);
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    return;
  }
  if (!pointerActive || event.pointerId !== pointerId) return;
  const point = localPointer(event);
  const endingMode = pointerMode;
  pointerActive = false;
  pointerId = -1;
  pointerMode = "none";
  if (endingMode === "box-select") {
    boxCurrent = [point.x, point.y];
    const width = Math.abs(boxCurrent[0] - boxStart[0]);
    const height = Math.abs(boxCurrent[1] - boxStart[1]);
    if (event.type === "pointerup" && width >= 8 && height >= 8) {
      simulation.selectBubblesInScreenRect(
        boxStart,
        boxCurrent,
        camera,
        { width: point.width, height: point.height }
      );
    }
    cancelBoxSelection();
    updateSelectionPanel();
  } else if (endingMode === "box-candidate") {
    clearBoxTimer();
    if (event.type === "pointerup") {
      const elapsed = event.timeStamp - lastBlankTap.time;
      const close = Math.hypot(point.x - lastBlankTap.x, point.y - lastBlankTap.y) <= 14;
      if (elapsed <= 350 && close) {
        const ray = rayFromScreen(camera, point.x, point.y, point.width, point.height);
        simulation.addBubblesAtRay(ray, camera, 0);
        lastBlankTap.time = -1000;
      } else {
        simulation.clearSelection();
        lastBlankTap = { time: event.timeStamp, x: point.x, y: point.y };
      }
      updateSelectionPanel();
    }
  } else if (endingMode === "bubble-candidate") {
    clearBubbleLongPressTimer();
  } else if (endingMode === "bubble-edit" || endingMode === "live-interaction") {
    simulation.pointerUp();
    updateSelectionPanel();
  }
  renderer.setTouch(0, 0, false);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("blur", cancelBoxSelection);

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
      : `${simulation.params.workspaceMode === "static" ? "静态" : "动态"} · ${simulation.bubbles.length} 泡泡 · ${simulation.bonds.length} 连接`;
    fpsAccumulator = 0;
    fpsFrameCount = 0;
    fpsUpdateTime = now;
  }
  requestAnimationFrame(frame);
}

updateModeButtons();
requestAnimationFrame(frame);
