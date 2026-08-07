import {
  PI,
  v3,
  m3,
  buildCamera,
  intersectRayPlane,
  distancePointToSegment2D
} from "./math.js?v=20260807-14";

export const WORLD_UNITS_PER_METER = 50;
const AIR_DENSITY = 1.225;
const LIQUID_DENSITY = 1000;
const GRAVITY = 9.81;
const MAX_BUBBLES = 64;
const MAX_EDITOR_BUBBLES = 128;
const COLLISION_ITERATIONS = 6;
const MAX_SPEED = 10;
// Bonded bubbles may overlap to form a shared film, but the overlap depth must
// not exceed half of the smaller radius. For equal bubbles this keeps their
// center distance at or above 1.5 radii instead of allowing it to fall to one.
const MAXIMUM_BOND_OVERLAP_TO_MINIMUM_RADIUS = .5;
const CONTAINER_VIEWPORT_FILL = .9;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteArray(values, fallback = 0) {
  return values.map((value) => Number.isFinite(value) ? value : fallback);
}

function capVolume(radius, height) {
  const h = clamp(height, 0, 2 * radius);
  return PI * h * h * (radius - h / 3);
}

function deterministicNormal(firstIndex, secondIndex) {
  const seed = ((firstIndex + 1) * 73856093) ^ ((secondIndex + 1) * 19349663);
  const angle = (seed >>> 0) / 0xffffffff * PI * 2;
  return v3.normalize([Math.cos(angle), .35, Math.sin(angle)]);
}

export class BubbleSimulation {
  constructor() {
    this.params = {
      backTransmission: true,
      backReflection: true,
      frontTransmission: true,
      frontReflection: true,
      whiteFurnace: false,
      eta2: 1.33,
      filmThickness: 400,
      eta3: 1,
      kappa3: 0,
      flowEnabled: true,
      flowNoiseScale: 1,
      flowSpeed: .03,
      flowAmplitude: 150,
      deformationEnabled: true,
      radiusCentimeters: 3,
      surfaceTensionMilliNewtons: 25,
      dampingRatio: .08,
      motionSpeed: 1,
      dragCoefficient: .47,
      gravityScale: .64,
      ambientAirflow: true,
      verticalAirflowSpeed: .21,
      randomize: false,
      randomBubbleMinCount: 3,
      randomBubbleMaxCount: 9,
      randomBubbleDepthScatterScale: 2,
      adhesion: true,
      wetness: .65,
      singlePreview: false,
      interactionMode: true,
      workspaceMode: "static",
      toolMode: "edit",
      cameraDistance: 54,
      cameraFov: 60,
      renderResolutionScale: 1,
      fxaaEnabled: false,
      bubbleOnlyOutput: false,
      plateauBorderStrength: 1,
      normalBlendWidthScale: .055,
      normalBlendMinWidth: .035,
      normalBlendMaxWidth: .18,
      bubbleNormalBlendStrength: .35,
      sharedFilmNormalBlendStrength: .55,
      plateauBorderNormalBlendStrength: .28,
      depthOfFieldEnabled: false,
      depthOfFieldMode: 2,
      depthOfFieldFocusDistance: 54,
      depthOfFieldBackgroundDistance: 120,
      depthOfFieldStrength: .45
    };
    this.bubbles = [];
    this.bonds = [];
    this.nextBubbleId = 1;
    this.randomState = 0x6d2b79f5;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
    this.cameraTarget = [0, 0, 0];
    this.initialContainerBounds = null;
    this.elapsed = 0;
    this.fps = 0;
    this.interaction = this.createInteractionState();
    this.selectedIds = [];
    this.previewBubble = this.createBubble(false);
    this.previewBubble.position = [0, 0, 0];
    this.previewBubble.velocity = [0, this.params.motionSpeed, 0];
  }

  createInteractionState() {
    return {
      selectedId: 0,
      dragPlanePoint: [0, 0, 0],
      dragPlaneNormal: [0, 0, 1],
      targetPosition: [0, 0, 0],
      targetVelocity: [0, 0, 0],
      previousTarget: [0, 0, 0],
      lastEventTime: 0,
      movedPixels: 0,
      previousScreen: null,
      lastClickId: 0,
      lastClickTime: -10,
      bondCandidateId: 0,
      bondCandidateTime: 0,
      emptyGesture: false,
      grabOffset: [0, 0, 0],
      groupDragIds: [],
      groupDragOffsets: []
    };
  }

  nextRandom() {
    this.randomState = (Math.imul(1664525, this.randomState) + 1013904223) >>> 0;
    return (this.randomState >>> 8) / 0xffffff;
  }

  createBubble(randomize = this.params.randomize) {
    const bubble = {
      id: this.nextBubbleId++,
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      physicalRadius: this.params.radiusCentimeters * .01,
      filmThickness: this.params.filmThickness,
      surfaceTension: this.params.surfaceTensionMilliNewtons * .001,
      dampingRatio: this.params.dampingRatio,
      flowEnabled: this.params.flowEnabled,
      flowNoiseScale: this.params.flowNoiseScale,
      flowSpeed: this.params.flowSpeed,
      flowAmplitude: this.params.flowAmplitude,
      quadrupole: m3.zero(),
      quadrupoleVelocity: m3.zero(),
      activeBondCount: 0,
      volumeScale: 1,
      popped: false,
      moving: true,
      clipPlanes: []
    };
    if (randomize) {
      bubble.physicalRadius = .015 + .045 * this.nextRandom();
      bubble.filmThickness = 120 + 880 * this.nextRandom();
      bubble.surfaceTension = .018 + .014 * this.nextRandom();
      bubble.dampingRatio = .03 + .19 * this.nextRandom();
      bubble.flowNoiseScale = .35 + 2.85 * this.nextRandom();
      bubble.flowSpeed = .01 + .15 * this.nextRandom();
      bubble.flowAmplitude = 60 + 420 * this.nextRandom();
    }
    return bubble;
  }

  setParameter(name, value) {
    this.params[name] = value;
    if (name === "singlePreview" && value) this.params.interactionMode = false;
    if (name === "radiusCentimeters" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.physicalRadius = value * .01; });
      this.updateBondRestDistances();
    }
    if (name === "filmThickness" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.filmThickness = value; });
    }
    if (name === "surfaceTensionMilliNewtons" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.surfaceTension = value * .001; });
    }
    if (name === "dampingRatio" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.dampingRatio = value; });
    }
    if (name === "flowEnabled" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.flowEnabled = value; });
    }
    if (name === "flowNoiseScale" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.flowNoiseScale = value; });
    }
    if (name === "flowSpeed" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.flowSpeed = value; });
    }
    if (name === "flowAmplitude" && !this.params.randomize) {
      this.bubbles.forEach((bubble) => { bubble.flowAmplitude = value; });
    }
    if (name === "motionSpeed") {
      this.previewBubble.velocity = [0, value, 0];
    }
    if (name === "adhesion" && !value) this.bonds.length = 0;
    if (name === "adhesion" && this.params.workspaceMode === "static") this.rebuildEditorOverlapBonds();
  }

  setInteractionMode(enabled) {
    this.params.interactionMode = enabled;
    if (enabled) this.params.singlePreview = false;
    this.interaction = this.createInteractionState();
  }

  setWorkspaceMode(mode) {
    this.params.workspaceMode = mode === "realtime" ? "realtime" : "static";
    this.params.interactionMode = true;
    this.interaction = this.createInteractionState();
    this.selectedIds = [];
    this.bubbles.forEach((bubble) => {
      bubble.moving = this.params.workspaceMode === "realtime"
        && this.params.toolMode !== "edit";
      if (!bubble.moving) bubble.velocity = [0, 0, 0];
    });
    if (this.params.workspaceMode === "static") {
      this.rebuildEditorOverlapBonds();
    } else {
      // Editor overlap bonds become ordinary live constraints after entering
      // realtime mode and may stretch or break like native bonds.
      this.bonds.forEach((bond) => { bond.editorGenerated = false; });
    }
  }

  setToolMode(mode) {
    this.params.toolMode = mode === "browse" ? "browse" : "edit";
    if (this.params.toolMode === "edit") {
      this.bubbles.forEach((bubble) => {
        bubble.velocity = [0, 0, 0];
        bubble.moving = false;
      });
    } else if (this.params.workspaceMode === "realtime") {
      this.bubbles.forEach((bubble) => { bubble.moving = true; });
    }
    this.interaction = this.createInteractionState();
    this.selectedIds = [];
  }

  getCamera(aspect) {
    const distance = this.params.singlePreview ? 8 : this.params.cameraDistance;
    return buildCamera(
      this.cameraYaw,
      distance,
      aspect,
      this.params.cameraFov,
      this.cameraPitch,
      this.cameraTarget
    );
  }

  getWorldRadius(bubble) {
    return bubble.physicalRadius * WORLD_UNITS_PER_METER * bubble.volumeScale;
  }

  getPhysicalWorldRadius(bubble) {
    return bubble.physicalRadius * WORLD_UNITS_PER_METER;
  }

  calculateMass(bubble) {
    const radius = bubble.physicalRadius;
    const volume = 4 * PI * radius ** 3 / 3;
    const area = 4 * PI * radius * radius;
    const thicknessMeters = Math.max(0, bubble.filmThickness) * 1e-9;
    return Math.max(AIR_DENSITY * volume + LIQUID_DENSITY * area * thicknessMeters, 1e-8);
  }

  calculateAerodynamicQuadrupole(velocity, radius, surfaceTension) {
    const speed = v3.length(velocity);
    if (speed < 1e-5) return m3.zero();
    const weber = AIR_DENSITY * speed * speed * (2 * radius) /
      Math.max(2 * surfaceTension, 1e-6);
    const flattening = .35 * weber / (weber + 10);
    const axialScale = Math.max(1 - flattening, .65);
    return m3.axisQuadrupole(v3.scale(velocity, 1 / speed), Math.log(axialScale));
  }

  quadrupoleFrequency(bubble) {
    const radiusCubed = Math.max(bubble.physicalRadius ** 3, 1e-9);
    return Math.sqrt(
      (2 * bubble.surfaceTension * 24) /
      (radiusCubed * (3 * AIR_DENSITY + 2 * AIR_DENSITY))
    );
  }

  integrateQuadrupole(bubble, target, deltaTime) {
    const omega = Math.max(this.quadrupoleFrequency(bubble), .001);
    const damping = clamp(bubble.dampingRatio, .001, .95);
    const gamma = damping * omega;
    const dampedOmega = omega * Math.sqrt(Math.max(1 - damping * damping, 1e-6));
    const exponential = Math.exp(-gamma * deltaTime);
    const cosine = Math.cos(dampedOmega * deltaTime);
    const sineOverOmega = Math.sin(dampedOmega * deltaTime) / dampedOmega;
    const displacement = m3.sub(bubble.quadrupole, target);
    const velocity = bubble.quadrupoleVelocity;
    bubble.quadrupole = m3.add(target, m3.scale(m3.add(
      m3.scale(displacement, cosine),
      m3.scale(m3.add(velocity, m3.scale(displacement, gamma)), sineOverOmega)
    ), exponential));
    bubble.quadrupoleVelocity = m3.scale(m3.sub(
      m3.scale(velocity, cosine),
      m3.scale(m3.add(
        m3.scale(displacement, omega * omega),
        m3.scale(velocity, gamma)
      ), sineOverOmega)
    ), exponential);
    bubble.quadrupole = m3.projectQuadrupole(bubble.quadrupole);
    bubble.quadrupoleVelocity = m3.projectQuadrupole(bubble.quadrupoleVelocity);
    const norm = m3.frobenius(bubble.quadrupole);
    if (norm > .6) bubble.quadrupole = m3.scale(bubble.quadrupole, .6 / norm);
  }

  exciteQuadrupole(bubble, normal, impactSpeed) {
    if (!this.params.deformationEnabled) return;
    const strainRate = -.35 * impactSpeed / Math.max(bubble.physicalRadius, .001);
    bubble.quadrupoleVelocity = m3.projectQuadrupole(m3.add(
      bubble.quadrupoleVelocity,
      m3.axisQuadrupole(normal, strainRate)
    ));
  }

  shapeMatrix(bubble) {
    if (!this.params.deformationEnabled) return m3.identity();
    return m3.exponentialQuadrupole(bubble.quadrupole);
  }

  launchBubble() {
    this.params.singlePreview = false;
    const maximum = MAX_BUBBLES;
    while (this.bubbles.length >= maximum) {
      const removedId = this.bubbles.shift().id;
      this.bonds = this.bonds.filter((bond) => bond.firstId !== removedId && bond.secondId !== removedId);
    }
    const bubble = this.createBubble();
    const container = this.containerBounds(1);
    const radius = this.getWorldRadius(bubble);
    const launchOffset = Math.max(6 * radius, .36 * container.halfHeight);
    bubble.position = [
      0,
      clamp(-container.halfHeight + launchOffset, -container.halfHeight + radius, container.halfHeight - radius),
      0
    ];
    const minimumCosine = Math.cos(15 * PI / 180);
    const cosine = minimumCosine + (1 - minimumCosine) * this.nextRandom();
    const azimuth = 2 * PI * this.nextRandom();
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    const direction = [sine * Math.cos(azimuth), cosine, sine * Math.sin(azimuth)];
    bubble.velocity = v3.scale(direction, this.params.motionSpeed);
    bubble.quadrupole = this.calculateAerodynamicQuadrupole(
      bubble.velocity,
      bubble.physicalRadius,
      bubble.surfaceTension
    );
    this.bubbles.push(bubble);
    return bubble;
  }

  clear() {
    this.bubbles.length = 0;
    this.bonds.length = 0;
    this.interaction = this.createInteractionState();
    this.selectedIds = [];
  }

  addBubblesAtRay(ray, camera, requestedCount = 0) {
    if (this.params.workspaceMode !== "static" || this.params.toolMode !== "edit") return 0;
    const center = intersectRayPlane(ray, [0, 0, 0], camera.forward);
    if (!center) return 0;
    const minimum = Math.round(clamp(this.params.randomBubbleMinCount, 1, 16));
    const maximum = Math.round(clamp(this.params.randomBubbleMaxCount, minimum, 16));
    const count = requestedCount > 0
      ? Math.round(clamp(requestedCount, 1, 16))
      : (this.params.randomize
        ? minimum + Math.floor(this.nextRandom() * (maximum - minimum + 1))
        : 1);
    const targetCount = Math.min(count, MAX_EDITOR_BUBBLES - this.bubbles.length);
    const created = Array.from({ length: targetCount }, () => this.createBubble(this.params.randomize));
    const radii = created.map((bubble) => this.getPhysicalWorldRadius(bubble));
    const remaining = created.map((_, index) => index);
    for (let index = remaining.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.min(index, Math.floor(this.nextRandom() * (index + 1)));
      [remaining[index], remaining[swapIndex]] = [remaining[swapIndex], remaining[index]];
    }
    const groups = [];
    let clusteredRemaining = 0;
    if (this.params.randomize && targetCount >= 2 && this.nextRandom() >= .15) {
      clusteredRemaining = clamp(
        Math.round((.55 + .2 * this.nextRandom()) * targetCount),
        2,
        targetCount
      );
    }
    while (clusteredRemaining >= 2 && remaining.length >= 2) {
      const roll = this.nextRandom();
      let size = roll < .1 ? 2 : (roll < .55 ? 3 : 4);
      size = Math.min(size, clusteredRemaining, remaining.length);
      if (clusteredRemaining - size === 1 && size > 2) size -= 1;
      if (size < 2) break;
      groups.push(remaining.splice(0, size));
      clusteredRemaining -= size;
    }
    while (remaining.length) groups.push([remaining.shift()]);

    const depthScale = clamp(this.params.randomBubbleDepthScatterScale, 1, 4);
    const placedGroups = [];
    groups.forEach((indices, groupIndex) => {
      const offsets = [[0, 0, 0]];
      for (let member = 1; member < indices.length; member += 1) {
        const bubbleIndex = indices[member];
        let best = [0, 0, 0];
        let bestClearance = -Infinity;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const anchorMember = Math.min(member - 1, Math.floor(this.nextRandom() * member));
          const anchorIndex = indices[anchorMember];
          const angle = 2 * PI * this.nextRandom();
          const direction = v3.normalize([
            Math.cos(angle),
            Math.sin(angle),
            (2 * this.nextRandom() - 1) * depthScale
          ]);
          const contact = radii[bubbleIndex] + radii[anchorIndex];
          const candidate = v3.madd(
            offsets[anchorMember],
            direction,
            contact * (.84 + .14 * this.nextRandom())
          );
          let clearance = Infinity;
          for (let previous = 0; previous < member; previous += 1) {
            const previousIndex = indices[previous];
            const minimumDistance = .62 * (radii[bubbleIndex] + radii[previousIndex]);
            clearance = Math.min(clearance, v3.distance(candidate, offsets[previous]) - minimumDistance);
          }
          if (clearance > bestClearance) {
            best = candidate;
            bestClearance = clearance;
          }
          if (clearance >= 0) break;
        }
        offsets.push(best);
      }
      const localCenter = offsets.reduce((sum, offset) => v3.add(sum, offset), [0, 0, 0]);
      const centered = offsets.map((offset) => v3.sub(offset, v3.scale(localCenter, 1 / offsets.length)));
      const groupRadius = Math.max(...centered.map((offset, index) =>
        v3.length(offset) + radii[indices[index]]));
      const angle = groupIndex * 2.39996323 + this.nextRandom() * .35;
      const ring = groupIndex === 0 ? 0 : Math.sqrt(groupIndex) *
        (groupRadius + placedGroups.reduce((maximum, group) => Math.max(maximum, group.radius), 0)) * 1.12;
      const groupCenter = v3.add(center, v3.add(
        v3.scale(camera.right, Math.cos(angle) * ring),
        v3.add(
          v3.scale(camera.up, Math.sin(angle) * ring),
          v3.scale(camera.forward, (2 * this.nextRandom() - 1) * groupRadius * depthScale)
        )
      ));
      indices.forEach((bubbleIndex, member) => {
        const offset = centered[member];
        created[bubbleIndex].position = v3.add(groupCenter, v3.add(
          v3.scale(camera.right, offset[0]),
          v3.add(v3.scale(camera.up, offset[1]), v3.scale(camera.forward, offset[2]))
        ));
      });
      placedGroups.push({ radius: groupRadius, center: groupCenter });
    });
    created.forEach((bubble) => {
      bubble.velocity = [0, 0, 0];
      bubble.moving = false;
      this.bubbles.push(bubble);
    });
    this.selectedIds = created.length ? [created.at(-1).id] : [];
    this.interaction.selectedId = this.selectedIds[0] ?? 0;
    this.rebuildEditorOverlapBonds();
    return created.length;
  }

  deleteSelected() {
    const ids = new Set(this.selectedIds);
    if (!ids.size) return false;
    this.bubbles = this.bubbles.filter((bubble) => !ids.has(bubble.id));
    this.bonds = this.bonds.filter((bond) => !ids.has(bond.firstId) && !ids.has(bond.secondId));
    this.selectedIds = [];
    this.interaction.selectedId = 0;
    this.rebuildConnectionGeometry();
    return true;
  }

  duplicateSelected() {
    const sources = this.selectedIds.map((id) => this.findBubble(id)).filter(Boolean);
    if (!sources.length || this.bubbles.length >= MAX_EDITOR_BUBBLES) return false;
    const copies = [];
    const maximumRadius = Math.max(...sources.map((bubble) => this.getWorldRadius(bubble)));
    const offset = [maximumRadius * .9, maximumRadius * .9, 0];
    sources.slice(0, MAX_EDITOR_BUBBLES - this.bubbles.length).forEach((source) => {
      const copy = {
        ...source,
        id: this.nextBubbleId++,
        position: v3.add(source.position, offset),
        velocity: [0, 0, 0],
        quadrupole: [...source.quadrupole],
        quadrupoleVelocity: m3.zero(),
        clipPlanes: []
      };
      this.bubbles.push(copy);
      copies.push(copy.id);
    });
    this.selectedIds = copies;
    this.interaction.selectedId = copies[0] ?? 0;
    this.rebuildEditorOverlapBonds();
    return true;
  }

  scaleSelected(factor) {
    const selected = this.selectedIds.map((id) => this.findBubble(id)).filter(Boolean);
    if (!selected.length) return false;
    selected.forEach((bubble) => {
      bubble.physicalRadius = clamp(bubble.physicalRadius * factor, .01, .08);
    });
    this.rebuildEditorOverlapBonds();
    return true;
  }

  setSelection(ids, primaryId = 0) {
    const valid = new Set(this.bubbles.map((bubble) => bubble.id));
    this.selectedIds = [...new Set(ids)].filter((id) => valid.has(id));
    this.interaction.selectedId = this.selectedIds.includes(primaryId)
      ? primaryId
      : (this.selectedIds[0] ?? 0);
    return this.selectedIds.length;
  }

  clearSelection() {
    this.selectedIds = [];
    this.interaction.selectedId = 0;
  }

  selectedBubbles() {
    return this.selectedIds.map((id) => this.findBubble(id)).filter(Boolean);
  }

  selectBubblesInScreenRect(start, end, camera, viewport) {
    const minimumX = Math.min(start[0], end[0]);
    const maximumX = Math.max(start[0], end[0]);
    const minimumY = Math.min(start[1], end[1]);
    const maximumY = Math.max(start[1], end[1]);
    const selected = [];
    this.bubbles.forEach((bubble) => {
      const center = this.projectToScreen(bubble.position, camera, viewport);
      if (!center) return;
      const radius = this.getWorldRadius(bubble);
      const right = this.projectToScreen(v3.madd(bubble.position, camera.right, radius), camera, viewport);
      const up = this.projectToScreen(v3.madd(bubble.position, camera.up, radius), camera, viewport);
      const screenRadius = Math.max(
        right ? Math.hypot(right[0] - center[0], right[1] - center[1]) : 0,
        up ? Math.hypot(up[0] - center[0], up[1] - center[1]) : 0,
        8
      );
      if (
        center[0] + screenRadius >= minimumX && center[0] - screenRadius <= maximumX &&
        center[1] + screenRadius >= minimumY && center[1] - screenRadius <= maximumY
      ) selected.push(bubble.id);
    });
    return this.setSelection(selected, selected[0] ?? 0);
  }

  updateSelectedProperties(patch) {
    const selected = this.selectedBubbles();
    if (selected.length !== 1) return false;
    const bubble = selected[0];
    if (patch.physicalRadius !== undefined) bubble.physicalRadius = clamp(patch.physicalRadius, .01, .08);
    if (patch.filmThickness !== undefined) bubble.filmThickness = clamp(patch.filmThickness, 0, 1200);
    if (patch.surfaceTension !== undefined) bubble.surfaceTension = clamp(patch.surfaceTension, .015, .04);
    if (patch.dampingRatio !== undefined) bubble.dampingRatio = clamp(patch.dampingRatio, .01, .5);
    if (patch.flowEnabled !== undefined) bubble.flowEnabled = Boolean(patch.flowEnabled);
    if (patch.flowNoiseScale !== undefined) bubble.flowNoiseScale = clamp(patch.flowNoiseScale, .1, 4);
    if (patch.flowSpeed !== undefined) bubble.flowSpeed = clamp(patch.flowSpeed, 0, .5);
    if (patch.flowAmplitude !== undefined) bubble.flowAmplitude = clamp(patch.flowAmplitude, 0, 600);
    this.rebuildEditorOverlapBonds();
    return true;
  }

  exportScene() {
    return {
      version: 5,
      params: { ...this.params },
      cameraYaw: this.cameraYaw,
      cameraPitch: this.cameraPitch,
      cameraTarget: [...this.cameraTarget],
      nextBubbleId: this.nextBubbleId,
      randomState: this.randomState,
      elapsed: this.elapsed,
      bubbles: this.bubbles.map((bubble) => ({
        ...bubble,
        position: [...bubble.position],
        velocity: [...bubble.velocity],
        quadrupole: [...bubble.quadrupole],
        quadrupoleVelocity: [...bubble.quadrupoleVelocity],
        clipPlanes: []
      })),
      bonds: this.bonds.map((bond) => ({ ...bond }))
    };
  }

  importScene(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.bubbles) || !Array.isArray(snapshot.bonds)) return false;
    Object.assign(this.params, snapshot.params || {});
    delete this.params.showcaseMode;
    this.cameraYaw = Number(snapshot.cameraYaw) || 0;
    this.cameraPitch = clamp(Number(snapshot.cameraPitch) || 0, -85 * PI / 180, 85 * PI / 180);
    this.cameraTarget = Array.isArray(snapshot.cameraTarget) && snapshot.cameraTarget.length === 3
      ? snapshot.cameraTarget.map((value) => Number(value) || 0)
      : [0, 0, 0];
    this.randomState = Number.isFinite(snapshot.randomState)
      ? (Number(snapshot.randomState) >>> 0)
      : 0x6d2b79f5;
    this.elapsed = Number.isFinite(snapshot.elapsed) ? Math.max(0, Number(snapshot.elapsed)) : 0;
    this.bubbles = snapshot.bubbles.slice(0, MAX_EDITOR_BUBBLES).map((bubble) => ({
      ...bubble,
      position: [...bubble.position],
      velocity: [...bubble.velocity],
      quadrupole: [...bubble.quadrupole],
      quadrupoleVelocity: [...bubble.quadrupoleVelocity],
      clipPlanes: []
    }));
    if (this.params.workspaceMode === "static") {
      this.bubbles.forEach((bubble) => {
        bubble.velocity = [0, 0, 0];
        bubble.moving = false;
      });
    }
    const validIds = new Set(this.bubbles.map((bubble) => bubble.id));
    this.bonds = snapshot.bonds.filter((bond) => validIds.has(bond.firstId) && validIds.has(bond.secondId));
    this.nextBubbleId = Math.max(
      Math.max(0, ...validIds) + 1,
      Number.isFinite(snapshot.nextBubbleId) ? Math.floor(snapshot.nextBubbleId) : 1
    );
    this.interaction = this.createInteractionState();
    this.selectedIds = [];
    this.rebuildConnectionGeometry();
    return true;
  }

  rebuildEditorOverlapBonds() {
    if (this.params.workspaceMode !== "static") return;
    this.bonds.length = 0;
    if (!this.params.adhesion) {
      this.rebuildConnectionGeometry();
      return;
    }
    for (let firstIndex = 0; firstIndex < this.bubbles.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < this.bubbles.length; secondIndex += 1) {
        const first = this.bubbles[firstIndex];
        const second = this.bubbles[secondIndex];
        const distance = v3.distance(first.position, second.position);
        if (distance > 1.08 * (this.getWorldRadius(first) + this.getWorldRadius(second))) continue;
        this.createBond(first, second, true);
        const bond = this.findBond(first.id, second.id);
        if (bond) {
          bond.editorGenerated = true;
          const minimumRestDistance = this.minimumBondCenterDistance(first, second);
          const maximumRestDistance = Math.max(
            minimumRestDistance,
            this.getWorldRadius(first) + this.getWorldRadius(second) - 1e-4
          );
          bond.restDistance = clamp(
            distance,
            minimumRestDistance,
            maximumRestDistance
          );
        }
      }
    }
    this.rebuildConnectionGeometry();
  }

  findBubble(id) {
    return this.bubbles.find((bubble) => bubble.id === id) || null;
  }

  findBond(firstId, secondId) {
    return this.bonds.find((bond) =>
      (bond.firstId === firstId && bond.secondId === secondId) ||
      (bond.firstId === secondId && bond.secondId === firstId)
    ) || null;
  }

  countBonds(id) {
    return this.bonds.reduce(
      (count, bond) => count + (bond.firstId === id || bond.secondId === id ? 1 : 0),
      0
    );
  }

  bondRestDistance(first, second) {
    const r1 = this.getWorldRadius(first);
    const r2 = this.getWorldRadius(second);
    const wetness = this.params.wetness;
    const wetnessDistance = Math.sqrt(Math.max(
      r1 * r1 + r2 * r2 + (3 * wetness - 1) * r1 * r2,
      1e-8
    ));
    return Math.max(wetnessDistance, this.minimumBondCenterDistance(first, second));
  }

  minimumBondCenterDistance(first, second) {
    const r1 = this.getWorldRadius(first);
    const r2 = this.getWorldRadius(second);
    return Math.max(
      r1 + r2 - MAXIMUM_BOND_OVERLAP_TO_MINIMUM_RADIUS * Math.min(r1, r2),
      Math.abs(r1 - r2) + 1e-4
    );
  }

  updateBondRestDistances() {
    this.bonds.forEach((bond) => {
      const first = this.findBubble(bond.firstId);
      const second = this.findBubble(bond.secondId);
      if (!first || !second) return;
      if (bond.editorGenerated) {
        const minimumRestDistance = this.minimumBondCenterDistance(first, second);
        const maximumRestDistance = Math.max(
          minimumRestDistance,
          this.getWorldRadius(first) + this.getWorldRadius(second) - 1e-4
        );
        bond.restDistance = clamp(
          bond.restDistance,
          minimumRestDistance,
          maximumRestDistance
        );
      } else {
        bond.restDistance = this.bondRestDistance(first, second);
      }
      bond.constraintLambda = 0;
    });
  }

  constrainEditorDraggedBubbles() {
    const draggedIds = new Set(this.interaction.groupDragIds);
    if (!draggedIds.size) return;
    const isDragged = (bubble) => draggedIds.has(bubble.id);
    const separationIterations = 4;
    for (let iteration = 0; iteration < separationIterations; iteration += 1) {
      for (let firstIndex = 0; firstIndex < this.bubbles.length; firstIndex += 1) {
        const first = this.bubbles[firstIndex];
        if (first.popped) continue;
        for (let secondIndex = firstIndex + 1; secondIndex < this.bubbles.length; secondIndex += 1) {
          const second = this.bubbles[secondIndex];
          if (second.popped) continue;
          const firstDragged = isDragged(first);
          const secondDragged = isDragged(second);
          if (firstDragged === secondDragged) continue;
          const minimumDistance = this.minimumBondCenterDistance(first, second);
          const centerDelta = v3.sub(second.position, first.position);
          const distance = v3.length(centerDelta);
          if (distance >= minimumDistance) continue;
          const normal = distance > 1e-6
            ? v3.scale(centerDelta, 1 / distance)
            : deterministicNormal(firstIndex, secondIndex);
          const correction = minimumDistance - distance;
          const selectionCorrection = v3.scale(
            normal,
            firstDragged ? -correction : correction
          );
          this.bubbles.forEach((bubble) => {
            if (isDragged(bubble)) {
              bubble.position = v3.add(bubble.position, selectionCorrection);
            }
          });
        }
      }
    }
  }

  createBond(first, second, deterministic = false) {
    if (
      !this.params.adhesion ||
      this.findBond(first.id, second.id) ||
      this.countBonds(first.id) >= 6 ||
      this.countBonds(second.id) >= 6
    ) return false;
    const averageThickness = .5 * (first.filmThickness + second.filmThickness);
    const thicknessScore = clamp((averageThickness - 120) / 880, 0, 1);
    this.bonds.push({
      firstId: first.id,
      secondId: second.id,
      restDistance: this.bondRestDistance(first, second),
      breakSpeed: 1.1 + .8 * thicknessScore,
      age: deterministic ? .08 : 0,
      constraintLambda: 0
    });
    return true;
  }

  tryCollisionBond(first, second, impactSpeed) {
    if (
      !this.params.adhesion ||
      impactSpeed > .65 ||
      this.findBond(first.id, second.id) ||
      this.countBonds(first.id) >= 6 ||
      this.countBonds(second.id) >= 6
    ) return false;
    const averageThickness = .5 * (first.filmThickness + second.filmThickness);
    const velocityScore = 1 - impactSpeed / .65;
    const thicknessScore = clamp((averageThickness - 120) / 880, 0, 1);
    const radiusRatio = Math.min(first.physicalRadius, second.physicalRadius) /
      Math.max(first.physicalRadius, second.physicalRadius);
    const probability = clamp(
      .12 + .68 * velocityScore * (.65 + .35 * thicknessScore) * (.75 + .25 * radiusRatio),
      .05,
      .8
    );
    return this.nextRandom() < probability && this.createBond(first, second);
  }

  maximumBubbleWorldRadius() {
    let referenceRadius = this.params.radiusCentimeters * .01;
    if (this.params.randomize) referenceRadius = Math.max(referenceRadius, .06);
    this.bubbles.forEach((bubble) => {
      referenceRadius = Math.max(referenceRadius, bubble.physicalRadius);
    });
    return referenceRadius * WORLD_UNITS_PER_METER;
  }

  containerBounds(aspect = 1) {
    if (!this.initialContainerBounds) {
      const verticalHalfAngle = .5 * this.params.cameraFov * PI / 180;
      const verticalTangent = Math.tan(verticalHalfAngle);
      const horizontalHalfAngle = Math.atan(verticalTangent * Math.max(aspect, .1));
      const maximumBubbleRadius = this.maximumBubbleWorldRadius();
      const initialCameraDistance = this.params.cameraDistance;
      const radius = Math.max(
        CONTAINER_VIEWPORT_FILL * initialCameraDistance * Math.sin(horizontalHalfAngle),
        1.5 * maximumBubbleRadius
      );
      // Keep the taller landscape framing already used by the web adaptation,
      // while deriving it from the initial camera instead of fixed constants.
      const verticalDepthAllowance = Math.min(radius, .32 * initialCameraDistance);
      const halfHeight = Math.max(
        CONTAINER_VIEWPORT_FILL * verticalTangent *
          (initialCameraDistance - verticalDepthAllowance),
        2 * maximumBubbleRadius
      );
      this.initialContainerBounds = { radius, halfHeight };
    }
    return this.initialContainerBounds;
  }

  solveCollision(first, second, firstIndex, secondIndex, firstIteration) {
    if (this.findBond(first.id, second.id)) return;
    const delta = v3.sub(second.position, first.position);
    const distance = v3.length(delta);
    const normal = distance > 1e-6 ? v3.scale(delta, 1 / distance) : deterministicNormal(firstIndex, secondIndex);
    const collisionDistance = this.getPhysicalWorldRadius(first) + this.getPhysicalWorldRadius(second);
    if (distance >= collisionDistance) return;
    const firstInverseMass = 1 / this.calculateMass(first);
    const secondInverseMass = 1 / this.calculateMass(second);
    const inverseMassSum = firstInverseMass + secondInverseMass;
    if (firstIteration) {
      const correction = Math.min(.5 * Math.max(collisionDistance - distance - .01, 0), .15);
      first.position = v3.madd(first.position, normal, -correction * firstInverseMass / inverseMassSum);
      second.position = v3.madd(second.position, normal, correction * secondInverseMass / inverseMassSum);
    }
    const relativeNormalVelocity = v3.dot(v3.sub(second.velocity, first.velocity), normal);
    if (relativeNormalVelocity >= 0) return;
    const impactSpeed = -relativeNormalVelocity;
    const bonded = firstIteration && this.tryCollisionBond(first, second, impactSpeed);
    const restitution = bonded ? 0 : (impactSpeed >= .25 ? .7 : 0);
    const impulseMagnitude = -(1 + restitution) * relativeNormalVelocity / inverseMassSum;
    const impulse = v3.scale(normal, impulseMagnitude);
    first.velocity = v3.madd(first.velocity, impulse, -firstInverseMass);
    second.velocity = v3.madd(second.velocity, impulse, secondInverseMass);
    if (firstIteration && impactSpeed >= .25) {
      this.exciteQuadrupole(first, normal, impactSpeed);
      this.exciteQuadrupole(second, v3.scale(normal, -1), impactSpeed);
    }
    if (firstIteration) {
      if (impactSpeed > .75) {
        const normalizedImpact = (impactSpeed - .75) / 2.5;
        const probability = 1 - Math.exp(-normalizedImpact * normalizedImpact);
        if (this.nextRandom() < probability) first.popped = true;
        if (this.nextRandom() < probability) second.popped = true;
      }
    }
  }

  solveBond(bond, deltaTime) {
    const first = this.findBubble(bond.firstId);
    const second = this.findBubble(bond.secondId);
    if (!first || !second) return;
    const delta = v3.sub(second.position, first.position);
    const rawDistance = v3.length(delta);
    const normal = rawDistance > 1e-6 ? v3.scale(delta, 1 / rawDistance) : [1, 0, 0];
    const inverseMassFirst = 1 / this.calculateMass(first);
    const inverseMassSecond = 1 / this.calculateMass(second);
    const inverseMassSum = inverseMassFirst + inverseMassSecond;
    const weightFirst = inverseMassFirst / inverseMassSum;
    const weightSecond = inverseMassSecond / inverseMassSum;
    const minimumBondDistance = this.minimumBondCenterDistance(first, second);
    const constrainedDistance = Math.max(rawDistance, minimumBondDistance);
    if (rawDistance < minimumBondDistance) {
      const separation = minimumBondDistance - rawDistance;
      first.position = v3.madd(first.position, normal, -separation * weightFirst);
      second.position = v3.madd(second.position, normal, separation * weightSecond);
    }
    const safeDeltaTime = Math.max(deltaTime, 1 / 240);
    const compliance = 1e-5 / (safeDeltaTime * safeDeltaTime);
    const constraint = constrainedDistance - Math.max(bond.restDistance, minimumBondDistance);
    const minimumRadius = Math.min(
      this.getPhysicalWorldRadius(first),
      this.getPhysicalWorldRadius(second)
    );
    const deltaLambda = clamp(
      (-constraint - compliance * bond.constraintLambda) / (1 + compliance),
      -.15 * minimumRadius,
      .15 * minimumRadius
    );
    bond.constraintLambda += deltaLambda;
    first.position = v3.madd(first.position, normal, -deltaLambda * weightFirst);
    second.position = v3.madd(second.position, normal, deltaLambda * weightSecond);
    const relativeNormalVelocity = v3.dot(v3.sub(second.velocity, first.velocity), normal);
    const dampingImpulse = -.65 * relativeNormalVelocity / inverseMassSum;
    first.velocity = v3.madd(first.velocity, normal, -inverseMassFirst * dampingImpulse);
    second.velocity = v3.madd(second.velocity, normal, inverseMassSecond * dampingImpulse);
  }

  solveContainer(bubble, aspect, firstIteration) {
    const bounds = this.containerBounds(aspect);
    const radius = this.getPhysicalWorldRadius(bubble);
    const radial = [bubble.position[0], 0, bubble.position[2]];
    const radialLength = v3.length(radial);
    const maximumRadial = Math.max(bounds.radius - radius, 0);
    if (radialLength > maximumRadial) {
      const outward = radialLength > 1e-6 ? v3.scale(radial, 1 / radialLength) : [1, 0, 0];
      bubble.position[0] = outward[0] * maximumRadial;
      bubble.position[2] = outward[2] * maximumRadial;
      const outwardSpeed = v3.dot(bubble.velocity, outward);
      if (outwardSpeed > 0) {
        const restitution = outwardSpeed >= .25 ? .8 : 0;
        bubble.velocity = v3.madd(bubble.velocity, outward, -(1 + restitution) * outwardSpeed);
        if (firstIteration) this.exciteQuadrupole(bubble, v3.scale(outward, -1), outwardSpeed);
      }
    }
    const verticalLimit = Math.max(bounds.halfHeight - radius, 0);
    if (bubble.position[1] < -verticalLimit) {
      bubble.position[1] = -verticalLimit;
      if (bubble.velocity[1] < 0) {
        const impactSpeed = -bubble.velocity[1];
        bubble.velocity[1] = impactSpeed * (impactSpeed >= .25 ? .8 : 0);
        if (firstIteration) this.exciteQuadrupole(bubble, [0, 1, 0], impactSpeed);
      }
    } else if (bubble.position[1] > verticalLimit) {
      bubble.position[1] = verticalLimit;
      if (bubble.velocity[1] > 0) {
        const impactSpeed = bubble.velocity[1];
        bubble.velocity[1] = -impactSpeed * (impactSpeed >= .25 ? .8 : 0);
        if (firstIteration) this.exciteQuadrupole(bubble, [0, -1, 0], impactSpeed);
      }
    }
  }

  applyDrag(deltaTime) {
    const bubble = this.findBubble(this.interaction.selectedId);
    if (!bubble) return;
    const positionErrorMeters = v3.scale(
      v3.sub(this.interaction.targetPosition, bubble.position),
      1 / WORLD_UNITS_PER_METER
    );
    const acceleration = v3.add(
      v3.scale(positionErrorMeters, 11 * 11),
      v3.scale(v3.sub(this.interaction.targetVelocity, bubble.velocity), 2 * .92 * 11)
    );
    bubble.velocity = v3.clampLength(v3.madd(bubble.velocity, acceleration, deltaTime), MAX_SPEED);
  }

  update(deltaTime, aspect) {
    const dt = clamp(deltaTime, 0, .05);
    this.elapsed += dt;
    // Capture the viewport-dependent container exactly once, before any early
    // return from static/edit/preview modes. Later camera changes are visual only.
    this.containerBounds(aspect);
    if (this.params.singlePreview) {
      const target = this.calculateAerodynamicQuadrupole(
        [0, this.params.motionSpeed, 0],
        this.params.radiusCentimeters * .01,
        this.params.surfaceTensionMilliNewtons * .001
      );
      this.previewBubble.physicalRadius = this.params.radiusCentimeters * .01;
      this.previewBubble.filmThickness = this.params.filmThickness;
      this.previewBubble.surfaceTension = this.params.surfaceTensionMilliNewtons * .001;
      this.previewBubble.dampingRatio = this.params.dampingRatio;
      this.integrateQuadrupole(this.previewBubble, target, dt);
      return;
    }

    if (this.params.workspaceMode === "static" || this.params.toolMode === "edit") {
      this.bubbles.forEach((bubble) => {
        bubble.velocity = [0, 0, 0];
        bubble.moving = false;
      });
      this.rebuildConnectionGeometry();
      return;
    }

    this.bonds = this.bonds.filter((bond) => {
      const first = this.findBubble(bond.firstId);
      const second = this.findBubble(bond.secondId);
      if (!first || !second) return false;
      bond.age += dt;
      bond.constraintLambda = 0;
      if (bond.editorGenerated) return true;
      if (bond.age <= .08) return true;
      const distance = v3.distance(first.position, second.position);
      const minimumRadius = Math.min(
        this.getPhysicalWorldRadius(first),
        this.getPhysicalWorldRadius(second)
      );
      const relativeSpeed = v3.length(v3.sub(second.velocity, first.velocity));
      return distance <= bond.restDistance + .45 * minimumRadius && relativeSpeed <= bond.breakSpeed;
    });

    this.applyDrag(dt);
    this.bubbles.forEach((bubble) => {
      if (!bubble.moving || bubble.popped) return;
      const radius = bubble.physicalRadius;
      const realtimeEditing = this.params.toolMode === "edit";
      const ambientVelocity = this.params.ambientAirflow && !realtimeEditing
        ? [0, this.params.verticalAirflowSpeed, 0]
        : [0, 0, 0];
      const relativeVelocity = v3.sub(bubble.velocity, ambientVelocity);
      if (!realtimeEditing) {
        const mass = this.calculateMass(bubble);
        const speed = v3.length(relativeVelocity);
        const crossSection = PI * radius * radius;
        const quadraticDrag = AIR_DENSITY * this.params.dragCoefficient * crossSection / (2 * mass);
        const dampedRelativeVelocity = v3.scale(relativeVelocity, 1 / (1 + quadraticDrag * speed * dt));
        bubble.velocity = v3.add(ambientVelocity, dampedRelativeVelocity);
        const volume = 4 * PI * radius ** 3 / 3;
        const effectiveGravity = GRAVITY * this.params.gravityScale;
        const verticalAcceleration = (AIR_DENSITY * volume * effectiveGravity - mass * effectiveGravity) / mass;
        bubble.velocity[1] += verticalAcceleration * dt;
      }
      bubble.position = v3.madd(bubble.position, bubble.velocity, WORLD_UNITS_PER_METER * dt);
      const targetScale = this.countBonds(bubble.id) > 0 ? .35 : 1;
      const target = m3.scale(this.calculateAerodynamicQuadrupole(
        relativeVelocity,
        bubble.physicalRadius,
        bubble.surfaceTension
      ), targetScale);
      this.integrateQuadrupole(bubble, target, dt);
      bubble.position = finiteArray(bubble.position);
      bubble.velocity = finiteArray(bubble.velocity);
      bubble.quadrupole = finiteArray(bubble.quadrupole);
      bubble.quadrupoleVelocity = finiteArray(bubble.quadrupoleVelocity);
    });
    this.interaction.targetVelocity = v3.scale(
      this.interaction.targetVelocity,
      Math.exp(-8 * dt)
    );

    for (let iteration = 0; iteration < COLLISION_ITERATIONS; iteration += 1) {
      for (let firstIndex = 0; firstIndex < this.bubbles.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < this.bubbles.length; secondIndex += 1) {
          this.solveCollision(
            this.bubbles[firstIndex],
            this.bubbles[secondIndex],
            firstIndex,
            secondIndex,
            iteration === 0
          );
        }
      }
      this.bonds.forEach((bond) => this.solveBond(bond, dt));
      this.bubbles.forEach((bubble) => this.solveContainer(bubble, aspect, iteration === 0));
    }

    this.updateInteractiveBondCandidate(dt);
    const poppedIds = new Set(this.bubbles.filter((bubble) => bubble.popped).map((bubble) => bubble.id));
    if (poppedIds.size) {
      this.bubbles = this.bubbles.filter((bubble) => !poppedIds.has(bubble.id));
      this.bonds = this.bonds.filter(
        (bond) => !poppedIds.has(bond.firstId) && !poppedIds.has(bond.secondId)
      );
    }
    this.rebuildConnectionGeometry();
  }

  rebuildConnectionGeometry() {
    this.bubbles.forEach((bubble) => {
      bubble.activeBondCount = this.countBonds(bubble.id);
      bubble.volumeScale = 1;
      bubble.clipPlanes = [];
    });
    this.bubbles.forEach((bubble) => {
      const radius = bubble.physicalRadius * WORLD_UNITS_PER_METER;
      const sphereVolume = 4 * PI * radius ** 3 / 3;
      let removedVolume = 0;
      this.bonds.forEach((bond) => {
        const otherId = bond.firstId === bubble.id
          ? bond.secondId
          : (bond.secondId === bubble.id ? bond.firstId : 0);
        if (!otherId) return;
        const other = this.findBubble(otherId);
        if (!other) return;
        const otherRadius = other.physicalRadius * WORLD_UNITS_PER_METER;
        const distance = clamp(
          bond.restDistance,
          Math.abs(radius - otherRadius) + 1e-4,
          radius + otherRadius - 1e-4
        );
        const x = (distance * distance + radius * radius - otherRadius * otherRadius) / (2 * distance);
        removedVolume += capVolume(radius, radius - x);
      });
      const removedFraction = clamp(removedVolume / Math.max(sphereVolume, 1e-8), 0, .45);
      bubble.volumeScale = Math.cbrt(1 / (1 - removedFraction));
    });
    const geometryByBond = new Map();
    this.bonds.forEach((bond) => {
      const geometry = this.calculateBondGeometry(bond, true);
      bond.connectionClipPlanes = [];
      if (geometry) geometryByBond.set(bond, geometry);
    });
    this.bonds.forEach((bond) => {
      const planes = bond.connectionClipPlanes;
      [bond.firstId, bond.secondId].forEach((bubbleId) => {
        this.bonds.forEach((otherBond) => {
          if (otherBond === bond || planes.length >= 16) return;
          const usesFirst = otherBond.firstId === bubbleId;
          const usesSecond = otherBond.secondId === bubbleId;
          if (!usesFirst && !usesSecond) return;
          const other = geometryByBond.get(otherBond);
          if (!other) return;
          const normal = usesFirst ? other.normal : v3.scale(other.normal, -1);
          planes.push([
            normal[0], normal[1], normal[2],
            -v3.dot(normal, other.center) - .01
          ]);
        });
      });
    });
  }

  calculateBondGeometry(bond, updateClipPlanes = false) {
    const first = this.findBubble(bond.firstId);
    const second = this.findBubble(bond.secondId);
    if (!first || !second) return null;
    const axisVector = v3.sub(second.position, first.position);
    const currentDistance = v3.length(axisVector);
    if (currentDistance < 1e-5) return null;
    const normal = v3.scale(axisVector, 1 / currentDistance);
    const r1 = this.getWorldRadius(first);
    const r2 = this.getWorldRadius(second);
    const useCurrentDistance = this.params.workspaceMode !== "realtime" || bond.editorGenerated;
    const sourceDistance = useCurrentDistance ? currentDistance : bond.restDistance;
    const distance = clamp(
      sourceDistance,
      Math.abs(r1 - r2) + 1e-4,
      r1 + r2 - 1e-4
    );
    const x = (distance * distance + r1 * r1 - r2 * r2) / (2 * distance);
    const x2 = distance - x;
    const circleRadius = Math.sqrt(Math.max(r1 * r1 - x * x, 0));
    if (circleRadius < .01) return null;
    const borderRatio = .025 * (1 - this.params.wetness) + .11 * this.params.wetness;
    const borderSize = circleRadius * borderRatio;
    const filmRadius = Math.max(circleRadius - borderSize, .005);
    let sagittaRatio = 0;
    if (Math.abs(r1 - r2) > 1e-4 * Math.max(r1, r2)) {
      const curvatureRadius = Math.max(r1 * r2 / Math.abs(r1 - r2), circleRadius + 1e-4);
      const sagitta = curvatureRadius - Math.sqrt(Math.max(curvatureRadius ** 2 - circleRadius ** 2, 0));
      const rawRatio = Math.sign(r2 - r1) * clamp(sagitta / circleRadius, 0, .95);
      if (Math.abs(rawRatio) > 1e-4) {
        const preservedRadius = circleRadius * (rawRatio * rawRatio + 1) / (2 * Math.abs(rawRatio));
        const filmSagitta = preservedRadius - Math.sqrt(Math.max(preservedRadius ** 2 - filmRadius ** 2, 0));
        sagittaRatio = Math.sign(rawRatio) * filmSagitta / filmRadius;
      }
    }
    const center = v3.madd(first.position, normal, x);
    let tangent = v3.cross(Math.abs(normal[1]) < .9 ? [0, 1, 0] : [1, 0, 0], normal);
    tangent = v3.normalize(tangent);
    const bitangent = v3.normalize(v3.cross(normal, tangent));
    const averageThickness = .5 * (first.filmThickness + second.filmThickness);
    const geometry = {
      first,
      second,
      center,
      normal,
      tangent,
      bitangent,
      radius: filmRadius,
      circleRadius,
      borderRatio,
      sagittaRatio,
      filmThickness: clamp(.75 * averageThickness, 80, 1000),
      flowEnabled: first.flowEnabled || second.flowEnabled,
      flowNoiseScale: .5 * (first.flowNoiseScale + second.flowNoiseScale),
      flowSpeed: .5 * (first.flowSpeed + second.flowSpeed),
      flowAmplitude: .5 * (first.flowAmplitude + second.flowAmplitude),
      clipPlanes: bond.connectionClipPlanes || []
    };
    if (updateClipPlanes) {
      // The body and Plateau ring are composited in separate WebGL targets.
      // Keep the body slightly under the ring instead of meeting at an exact
      // zero-width boundary, which can expose background pixels at oblique views.
      const outerRadius = Math.min(circleRadius + .35 * borderSize, .999 * Math.min(r1, r2));
      const x1Outer = Math.sign(x || 1) * Math.sqrt(Math.max(r1 * r1 - outerRadius * outerRadius, 0));
      const x2Outer = Math.sign(x2 || 1) * Math.sqrt(Math.max(r2 * r2 - outerRadius * outerRadius, 0));
      const firstOffset = x - x1Outer;
      const secondOffset = x2 - x2Outer;
      if (first.clipPlanes.length < 16) {
        // Match the native plane exactly:
        // dot(n, p - sharedCenter) + firstClearance > 0 is clipped.
        // The previous port incorrectly measured firstClearance from the
        // bubble center, which moved the plane deep inside the sphere.
        first.clipPlanes.push([
          normal[0],
          normal[1],
          normal[2],
          -v3.dot(normal, center) + firstOffset
        ]);
      }
      if (second.clipPlanes.length < 16) {
        const inverseNormal = v3.scale(normal, -1);
        second.clipPlanes.push([
          inverseNormal[0],
          inverseNormal[1],
          inverseNormal[2],
          v3.dot(normal, center) + secondOffset
        ]);
      }
    }
    return geometry;
  }

  renderBubbles() {
    if (this.params.singlePreview) return [this.previewBubble];
    return this.bubbles;
  }

  pickBubble(ray) {
    let closest = Infinity;
    let selected = null;
    this.renderBubbles().forEach((bubble) => {
      const shape = m3.scale(this.shapeMatrix(bubble), this.getWorldRadius(bubble) * 1.1);
      const inverseShape = m3.inverse(shape);
      const localOrigin = m3.transform(inverseShape, v3.sub(ray.origin, bubble.position));
      const localDirection = m3.transform(inverseShape, ray.direction);
      const a = v3.dot(localDirection, localDirection);
      const b = v3.dot(localOrigin, localDirection);
      const c = v3.dot(localOrigin, localOrigin) - 1;
      const discriminant = b * b - a * c;
      if (discriminant < 0) return;
      const root = Math.sqrt(discriminant);
      const first = (-b - root) / a;
      const second = (-b + root) / a;
      const distance = first > 0 ? first : (second > 0 ? second : Infinity);
      if (distance < closest) {
        closest = distance;
        selected = bubble;
      }
    });
    return selected ? { bubble: selected, distance: closest } : null;
  }

  pointerDown(ray, screen, timestamp, camera) {
    if (!this.params.interactionMode || this.params.singlePreview) return false;
    const hit = this.pickBubble(ray);
    this.interaction.previousScreen = screen;
    this.interaction.lastEventTime = timestamp;
    this.interaction.movedPixels = 0;
    if (!hit) {
      this.interaction.emptyGesture = true;
      return false;
    }
    const bubble = hit.bubble;
    if (
      this.params.workspaceMode === "realtime" &&
      this.interaction.lastClickId === bubble.id &&
      timestamp - this.interaction.lastClickTime <= .35
    ) {
      bubble.popped = true;
      this.interaction.lastClickId = 0;
      return true;
    }
    this.interaction.lastClickId = bubble.id;
    this.interaction.lastClickTime = timestamp;
    if (!this.selectedIds.includes(bubble.id)) this.setSelection([bubble.id], bubble.id);
    else this.interaction.selectedId = bubble.id;
    this.interaction.dragPlanePoint = v3.clone(bubble.position);
    this.interaction.dragPlaneNormal = v3.clone(camera.forward);
    const planeTarget = intersectRayPlane(ray, bubble.position, camera.forward) || bubble.position;
    const grabOffset = v3.sub(bubble.position, planeTarget);
    this.interaction.grabOffset = grabOffset;
    const target = v3.add(planeTarget, grabOffset);
    this.interaction.targetPosition = v3.clone(target);
    this.interaction.previousTarget = v3.clone(target);
    this.interaction.groupDragIds = [...this.selectedIds];
    this.interaction.groupDragOffsets = this.selectedBubbles().map((selected) =>
      v3.sub(selected.position, bubble.position));
    this.interaction.targetVelocity = v3.clone(bubble.velocity);
    this.interaction.emptyGesture = false;
    return true;
  }

  pointerMove(ray, screen, timestamp, camera, viewport) {
    const previousScreen = this.interaction.previousScreen;
    if (!previousScreen) return;
    const eventDelta = clamp(timestamp - this.interaction.lastEventTime, 1 / 240, .05);
    this.interaction.movedPixels += Math.hypot(screen[0] - previousScreen[0], screen[1] - previousScreen[1]);
    if (this.interaction.selectedId) {
      const planeTarget = intersectRayPlane(
        ray,
        this.interaction.dragPlanePoint,
        this.interaction.dragPlaneNormal
      );
      if (planeTarget) {
        const target = v3.add(planeTarget, this.interaction.grabOffset);
        const rawVelocity = v3.clampLength(v3.scale(
          v3.sub(target, this.interaction.previousTarget),
          1 / (WORLD_UNITS_PER_METER * eventDelta)
        ), MAX_SPEED);
        this.interaction.targetVelocity = v3.add(
          v3.scale(this.interaction.targetVelocity, .35),
          v3.scale(rawVelocity, .65)
        );
        this.interaction.previousTarget = v3.clone(target);
        this.interaction.targetPosition = target;
        if (this.params.toolMode === "edit") {
          this.interaction.groupDragIds.forEach((id, index) => {
            const bubble = this.findBubble(id);
            if (!bubble) return;
            bubble.position = v3.add(target, this.interaction.groupDragOffsets[index] || [0, 0, 0]);
            bubble.velocity = [0, 0, 0];
          });
          this.constrainEditorDraggedBubbles();
          if (this.params.workspaceMode === "static") this.rebuildEditorOverlapBonds();
          else this.rebuildConnectionGeometry();
        }
      }
    } else {
      this.applyAirflowAndCut(previousScreen, screen, eventDelta, camera, viewport);
    }
    this.interaction.previousScreen = screen;
    this.interaction.lastEventTime = timestamp;
  }

  pointerUp() {
    const selected = this.findBubble(this.interaction.selectedId);
    if (this.params.toolMode !== "edit" && selected && this.interaction.movedPixels >= 14) {
      selected.velocity = v3.clampLength(v3.add(
        selected.velocity,
        v3.scale(this.interaction.targetVelocity, .35)
      ), MAX_SPEED);
    }
    if (this.params.workspaceMode !== "static" && this.params.toolMode !== "edit") {
      this.interaction.selectedId = 0;
      this.selectedIds = [];
    }
    this.interaction.previousScreen = null;
    this.interaction.bondCandidateId = 0;
    this.interaction.bondCandidateTime = 0;
    this.interaction.emptyGesture = false;
  }

  projectToScreen(position, camera, viewport) {
    const relative = v3.sub(position, camera.position);
    const depth = v3.dot(relative, camera.forward);
    if (depth <= .001) return null;
    const normalizedX = v3.dot(relative, camera.right) /
      (depth * camera.tanHalfFov * camera.aspect);
    const normalizedY = v3.dot(relative, camera.up) / (depth * camera.tanHalfFov);
    return [
      (normalizedX * .5 + .5) * viewport.width,
      (.5 - normalizedY * .5) * viewport.height
    ];
  }

  applyAirflowAndCut(start, end, eventDelta, camera, viewport) {
    const screenVelocity = [
      (end[0] - start[0]) / Math.max(viewport.width, 1),
      -(end[1] - start[1]) / Math.max(viewport.height, 1)
    ];
    const worldGesture = v3.add(
      v3.scale(camera.right, screenVelocity[0] * 2 * camera.tanHalfFov * camera.aspect * 54),
      v3.scale(camera.up, screenVelocity[1] * 2 * camera.tanHalfFov * 54)
    );
    const gestureVelocity = v3.clampLength(
      v3.scale(worldGesture, 1 / (WORLD_UNITS_PER_METER * eventDelta)),
      8
    );
    const sigma = Math.max(36, .08 * Math.min(viewport.width, viewport.height));
    this.bubbles.forEach((bubble) => {
      const projected = this.projectToScreen(bubble.position, camera, viewport);
      if (!projected) return;
      const distance = distancePointToSegment2D(projected, start, end);
      const weight = Math.exp(-(distance * distance) / (2 * sigma * sigma));
      if (weight < .01) return;
      const velocityDelta = v3.scale(gestureVelocity, 3 * eventDelta * weight);
      bubble.velocity = v3.clampLength(v3.add(bubble.velocity, velocityDelta), MAX_SPEED);
      this.exciteQuadrupole(
        bubble,
        v3.normalize(velocityDelta),
        .4 * v3.length(velocityDelta)
      );
    });
    this.bonds = this.bonds.filter((bond) => {
      const first = this.findBubble(bond.firstId);
      const second = this.findBubble(bond.secondId);
      if (!first || !second) return false;
      const firstScreen = this.projectToScreen(first.position, camera, viewport);
      const secondScreen = this.projectToScreen(second.position, camera, viewport);
      if (!firstScreen || !secondScreen) return true;
      const samples = 8;
      for (let sample = 0; sample <= samples; sample += 1) {
        const point = [
          start[0] + (end[0] - start[0]) * sample / samples,
          start[1] + (end[1] - start[1]) * sample / samples
        ];
        if (distancePointToSegment2D(point, firstScreen, secondScreen) <= 14) return false;
      }
      return true;
    });
  }

  updateInteractiveBondCandidate(deltaTime) {
    const selected = this.findBubble(this.interaction.selectedId);
    if (!selected || !this.params.adhesion) {
      this.interaction.bondCandidateId = 0;
      this.interaction.bondCandidateTime = 0;
      return;
    }
    let candidate = null;
    let closest = Infinity;
    this.bubbles.forEach((other) => {
      if (other.id === selected.id || this.findBond(selected.id, other.id)) return;
      const distance = v3.distance(selected.position, other.position);
      const threshold = 1.08 * (this.getWorldRadius(selected) + this.getWorldRadius(other));
      const relativeSpeed = v3.length(v3.sub(selected.velocity, other.velocity));
      if (distance <= threshold && relativeSpeed <= .9 && distance < closest) {
        candidate = other;
        closest = distance;
      }
    });
    if (!candidate) {
      this.interaction.bondCandidateId = 0;
      this.interaction.bondCandidateTime = 0;
      return;
    }
    if (this.interaction.bondCandidateId !== candidate.id) {
      this.interaction.bondCandidateId = candidate.id;
      this.interaction.bondCandidateTime = 0;
    }
    this.interaction.bondCandidateTime += deltaTime;
    if (this.interaction.bondCandidateTime >= .25) {
      this.createBond(selected, candidate, true);
      this.interaction.bondCandidateId = 0;
      this.interaction.bondCandidateTime = 0;
    }
  }
}
