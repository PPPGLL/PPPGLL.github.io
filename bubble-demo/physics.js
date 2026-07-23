import {
  PI,
  v3,
  m3,
  buildCamera,
  intersectRayPlane,
  distancePointToSegment2D
} from "./math.js";

export const WORLD_UNITS_PER_METER = 50;
const AIR_DENSITY = 1.225;
const LIQUID_DENSITY = 1000;
const GRAVITY = 9.81;
const MAX_BUBBLES = 64;
const SHOWCASE_MAX_BUBBLES = 32;
const COLLISION_ITERATIONS = 6;
const MAX_SPEED = 10;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
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
      flowSpeed: .5,
      flowAmplitude: 150,
      deformationEnabled: true,
      radiusCentimeters: 3,
      surfaceTensionMilliNewtons: 25,
      dampingRatio: .08,
      motionSpeed: 1,
      dragCoefficient: .47,
      randomize: true,
      adhesion: true,
      wetness: .65,
      singlePreview: true,
      interactionMode: false,
      showcaseMode: false
    };
    this.bubbles = [];
    this.bonds = [];
    this.nextBubbleId = 1;
    this.randomState = 0x6d2b79f5;
    this.cameraYaw = 0;
    this.elapsed = 0;
    this.fps = 0;
    this.interaction = this.createInteractionState();
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
      emptyGesture: false
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
    if (name === "motionSpeed") {
      this.previewBubble.velocity = [0, value, 0];
    }
    if (name === "adhesion" && !value) this.bonds.length = 0;
  }

  setInteractionMode(enabled) {
    this.params.interactionMode = enabled;
    if (enabled) this.params.singlePreview = false;
    this.interaction = this.createInteractionState();
  }

  setShowcaseMode(enabled) {
    this.params.showcaseMode = enabled;
    if (enabled && this.bubbles.length > SHOWCASE_MAX_BUBBLES) {
      const removed = new Set(
        this.bubbles.splice(0, this.bubbles.length - SHOWCASE_MAX_BUBBLES)
          .map((bubble) => bubble.id)
      );
      this.bonds = this.bonds.filter(
        (bond) => !removed.has(bond.firstId) && !removed.has(bond.secondId)
      );
    }
  }

  getCamera(aspect) {
    const distance = this.params.singlePreview ? 8 : 54;
    return buildCamera(this.cameraYaw, distance, aspect);
  }

  getWorldRadius(bubble) {
    return bubble.physicalRadius * WORLD_UNITS_PER_METER * bubble.volumeScale;
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
    const maximum = this.params.showcaseMode ? SHOWCASE_MAX_BUBBLES : MAX_BUBBLES;
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
    return Math.sqrt(Math.max(
      r1 * r1 + r2 * r2 + (3 * wetness - 1) * r1 * r2,
      (Math.abs(r1 - r2) + 1e-4) ** 2
    ));
  }

  updateBondRestDistances() {
    this.bonds.forEach((bond) => {
      const first = this.findBubble(bond.firstId);
      const second = this.findBubble(bond.secondId);
      if (first && second) bond.restDistance = this.bondRestDistance(first, second);
    });
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

  containerBounds(aspect) {
    const distance = 54;
    const halfVertical = 22.5 * PI / 180;
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
    const maximumPhysicalRadius = Math.max(
      this.params.radiusCentimeters * .01,
      this.params.randomize ? .06 : 0
    ) * WORLD_UNITS_PER_METER;
    const radius = Math.max(.9 * distance * Math.sin(halfHorizontal), 1.5 * maximumPhysicalRadius);
    const halfHeight = Math.max(
      .9 * Math.tan(halfVertical) * (distance - radius),
      2 * maximumPhysicalRadius
    );
    return { radius, halfHeight };
  }

  solveCollision(first, second, firstIndex, secondIndex, firstIteration) {
    if (this.findBond(first.id, second.id)) return;
    const delta = v3.sub(second.position, first.position);
    const distance = v3.length(delta);
    const normal = distance > 1e-6 ? v3.scale(delta, 1 / distance) : deterministicNormal(firstIndex, secondIndex);
    const collisionDistance = this.getWorldRadius(first) + this.getWorldRadius(second);
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
    if (firstIteration) {
      this.exciteQuadrupole(first, normal, impactSpeed);
      this.exciteQuadrupole(second, v3.scale(normal, -1), impactSpeed);
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
    const distance = Math.max(v3.length(delta), 1e-6);
    const normal = v3.scale(delta, 1 / distance);
    const inverseMassFirst = 1 / this.calculateMass(first);
    const inverseMassSecond = 1 / this.calculateMass(second);
    const inverseMassSum = inverseMassFirst + inverseMassSecond;
    const weightFirst = inverseMassFirst / inverseMassSum;
    const weightSecond = inverseMassSecond / inverseMassSum;
    const safeDeltaTime = Math.max(deltaTime, 1 / 240);
    const compliance = 1e-5 / (safeDeltaTime * safeDeltaTime);
    const constraint = distance - bond.restDistance;
    const minimumRadius = Math.min(this.getWorldRadius(first), this.getWorldRadius(second));
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
    const radius = this.getWorldRadius(bubble);
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
    if (this.params.showcaseMode) this.cameraYaw += 12 * PI / 180 * dt;
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

    this.bonds = this.bonds.filter((bond) => {
      const first = this.findBubble(bond.firstId);
      const second = this.findBubble(bond.secondId);
      if (!first || !second) return false;
      bond.age += dt;
      bond.constraintLambda = 0;
      if (bond.age <= .08) return true;
      const distance = v3.distance(first.position, second.position);
      const minimumRadius = Math.min(this.getWorldRadius(first), this.getWorldRadius(second));
      const relativeSpeed = v3.length(v3.sub(second.velocity, first.velocity));
      return distance <= bond.restDistance + .45 * minimumRadius && relativeSpeed <= bond.breakSpeed;
    });

    this.applyDrag(dt);
    this.bubbles.forEach((bubble) => {
      const radius = bubble.physicalRadius;
      const mass = this.calculateMass(bubble);
      const speed = v3.length(bubble.velocity);
      const crossSection = PI * radius * radius;
      const quadraticDrag = AIR_DENSITY * this.params.dragCoefficient * crossSection / (2 * mass);
      bubble.velocity = v3.scale(bubble.velocity, 1 / (1 + quadraticDrag * speed * dt));
      const volume = 4 * PI * radius ** 3 / 3;
      const verticalAcceleration = (AIR_DENSITY * volume * GRAVITY - mass * GRAVITY) / mass;
      bubble.velocity[1] += verticalAcceleration * dt;
      bubble.position = v3.madd(bubble.position, bubble.velocity, WORLD_UNITS_PER_METER * dt);
      const targetScale = this.countBonds(bubble.id) > 0 ? .35 : 1;
      const target = m3.scale(this.calculateAerodynamicQuadrupole(
        bubble.velocity,
        bubble.physicalRadius,
        bubble.surfaceTension
      ), targetScale);
      this.integrateQuadrupole(bubble, target, dt);
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
    this.bonds.forEach((bond) => this.calculateBondGeometry(bond, true));
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
    const distance = clamp(
      bond.restDistance,
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
      filmThickness: clamp(.75 * averageThickness, 80, 1000)
    };
    if (updateClipPlanes) {
      const outerRadius = Math.min(circleRadius + .5 * borderSize, .999 * Math.min(r1, r2));
      const x1Outer = Math.sign(x || 1) * Math.sqrt(Math.max(r1 * r1 - outerRadius * outerRadius, 0));
      const x2Outer = Math.sign(x2 || 1) * Math.sqrt(Math.max(r2 * r2 - outerRadius * outerRadius, 0));
      const firstOffset = x - x1Outer;
      const secondOffset = x2 - x2Outer;
      if (first.clipPlanes.length < 6) {
        const point = v3.madd(first.position, normal, firstOffset);
        first.clipPlanes.push([normal[0], normal[1], normal[2], -v3.dot(normal, point)]);
      }
      if (second.clipPlanes.length < 6) {
        const inverseNormal = v3.scale(normal, -1);
        const point = v3.madd(second.position, inverseNormal, secondOffset);
        second.clipPlanes.push([
          inverseNormal[0],
          inverseNormal[1],
          inverseNormal[2],
          -v3.dot(inverseNormal, point)
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
      this.interaction.lastClickId === bubble.id &&
      timestamp - this.interaction.lastClickTime <= .35
    ) {
      bubble.popped = true;
      this.interaction.lastClickId = 0;
      return true;
    }
    this.interaction.lastClickId = bubble.id;
    this.interaction.lastClickTime = timestamp;
    this.interaction.selectedId = bubble.id;
    this.interaction.dragPlanePoint = v3.clone(bubble.position);
    this.interaction.dragPlaneNormal = v3.clone(camera.forward);
    const target = intersectRayPlane(ray, bubble.position, camera.forward) || bubble.position;
    this.interaction.targetPosition = v3.clone(target);
    this.interaction.previousTarget = v3.clone(target);
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
      const target = intersectRayPlane(
        ray,
        this.interaction.dragPlanePoint,
        this.interaction.dragPlaneNormal
      );
      if (target) {
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
      }
    } else {
      this.applyAirflowAndCut(previousScreen, screen, eventDelta, camera, viewport);
    }
    this.interaction.previousScreen = screen;
    this.interaction.lastEventTime = timestamp;
  }

  pointerUp() {
    const selected = this.findBubble(this.interaction.selectedId);
    if (selected && this.interaction.movedPixels >= 14) {
      selected.velocity = v3.clampLength(v3.add(
        selected.velocity,
        v3.scale(this.interaction.targetVelocity, .35)
      ), MAX_SPEED);
    }
    this.interaction.selectedId = 0;
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
