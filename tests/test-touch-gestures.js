// tests/test-touch-gestures.js — Tests for mobile touch gesture interaction
// Validates: touch state management, gesture detection, orbit/pan/zoom logic

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ---------- Helpers to simulate touch gesture state logic ----------

/**
 * Simulate the WasmRenderer touch state machine (extracted from _bind3DControls).
 * This tests the gesture classification and camera math without requiring DOM/WASM.
 */
class TouchGestureState {
  constructor() {
    // Orbit camera state
    this._orbitTheta = Math.PI / 4;
    this._orbitPhi = Math.PI / 3;
    this._orbitRadius = 25;
    this._orbitTarget = { x: 0, y: 0, z: 0 };
    this._orbitDirty = false;

    // Touch state
    this._touchCount = 0;
    this._touchOrbiting = false;
    this._touchPanning = false;
    this._lastTouchX = 0;
    this._lastTouchY = 0;
    this._lastPinchDist = 0;

    // Interaction records
    this.interactions = [];
  }

  onCameraInteraction(type) {
    this.interactions.push(type);
  }

  touchStart(touches) {
    this._touchCount = touches.length;
    if (touches.length === 1) {
      this._touchOrbiting = true;
      this._touchPanning = false;
      this._lastTouchX = touches[0].clientX;
      this._lastTouchY = touches[0].clientY;
      this.onCameraInteraction('orbit_start');
    } else if (touches.length === 2) {
      this._touchOrbiting = false;
      this._touchPanning = true;
      const t0 = touches[0], t1 = touches[1];
      this._lastTouchX = (t0.clientX + t1.clientX) / 2;
      this._lastTouchY = (t0.clientY + t1.clientY) / 2;
      this._lastPinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      this.onCameraInteraction('pan_start');
    }
  }

  touchMove(touches) {
    if (touches.length === 1 && this._touchOrbiting) {
      const dx = touches[0].clientX - this._lastTouchX;
      const dy = touches[0].clientY - this._lastTouchY;
      this._lastTouchX = touches[0].clientX;
      this._lastTouchY = touches[0].clientY;
      this._orbitTheta -= dx * 0.005;
      this._orbitPhi -= dy * 0.005;
      this._orbitPhi = Math.max(0.05, Math.min(Math.PI - 0.05, this._orbitPhi));
      this._orbitDirty = true;
    } else if (touches.length === 2) {
      const t0 = touches[0], t1 = touches[1];
      const cx = (t0.clientX + t1.clientX) / 2;
      const cy = (t0.clientY + t1.clientY) / 2;
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);

      if (this._lastPinchDist > 0 && dist > 0) {
        const scale = this._lastPinchDist / dist;
        this._orbitRadius *= scale;
        this._orbitRadius = Math.max(10, Math.min(5000, this._orbitRadius));
        this._orbitDirty = true;
      }

      const dx = cx - this._lastTouchX;
      const dy = cy - this._lastTouchY;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        const panSpeed = this._orbitRadius * 0.001;
        const theta = this._orbitTheta;
        const phi = this._orbitPhi;
        const rightX = -Math.sin(theta);
        const rightY = Math.cos(theta);
        const upX = -Math.cos(theta) * Math.cos(phi);
        const upY = -Math.sin(theta) * Math.cos(phi);
        const upZ = Math.sin(phi);
        this._orbitTarget.x += (-dx * rightX + dy * upX) * panSpeed;
        this._orbitTarget.y += (-dx * rightY + dy * upY) * panSpeed;
        this._orbitTarget.z += dy * upZ * panSpeed;
        this._orbitDirty = true;
      }

      this._lastTouchX = cx;
      this._lastTouchY = cy;
      this._lastPinchDist = dist;
    }
  }

  touchEnd(remainingTouches) {
    const wasTouching = this._touchOrbiting || this._touchPanning;
    if (remainingTouches.length === 0) {
      this._touchOrbiting = false;
      this._touchPanning = false;
      this._touchCount = 0;
      if (wasTouching) this.onCameraInteraction('orbit_end');
    } else if (remainingTouches.length === 1) {
      this._touchPanning = false;
      this._touchOrbiting = true;
      this._touchCount = 1;
      this._lastTouchX = remainingTouches[0].clientX;
      this._lastTouchY = remainingTouches[0].clientY;
    }
  }

  touchCancel() {
    this._touchOrbiting = false;
    this._touchPanning = false;
    this._touchCount = 0;
    this._lastPinchDist = 0;
  }
}

// ---------- App-level sketch touch state machine ----------

class SketchTouchState {
  constructor() {
    this.touchWasMulti = false;
    this.touchStartedDrawing = false;
    this.sketchingOnPlane = true;
    this.toolEvents = [];
  }

  handleTouchStart(touchCount) {
    if (touchCount >= 2) {
      this.touchWasMulti = true;
      this.touchStartedDrawing = false;
      return 'multi-gesture';
    }
    if (!this.sketchingOnPlane) {
      this.touchWasMulti = false;
      this.touchStartedDrawing = false;
      return '3d-orbit';
    }
    if (this.touchWasMulti) {
      return 'suppressed';
    }
    this.touchStartedDrawing = true;
    this.toolEvents.push('mouseDown', 'click');
    return 'sketch-draw';
  }

  handleTouchMove(touchCount) {
    if (touchCount >= 2) return 'multi-gesture';
    if (!this.sketchingOnPlane) return '3d-orbit';
    if (!this.touchStartedDrawing) return 'suppressed';
    this.toolEvents.push('mouseMove');
    return 'sketch-draw';
  }

  handleTouchEnd(remainingCount) {
    if (remainingCount === 0) {
      if (this.touchStartedDrawing && this.sketchingOnPlane) {
        this.toolEvents.push('mouseUp');
      }
      this.touchWasMulti = false;
      this.touchStartedDrawing = false;
      return 'end';
    }
    if (remainingCount === 1 && this.touchWasMulti) {
      return 'gesture-continuing';
    }
    return 'partial';
  }
}

// ============================================================
// Tests
// ============================================================

// ---- Test 1: Single finger orbit ----
{
  const g = new TouchGestureState();
  g.touchStart([{ clientX: 100, clientY: 200 }]);

  assert(g._touchOrbiting === true, 'Single touch starts orbit');
  assert(g._touchPanning === false, 'Not panning with single touch');
  assert(g._touchCount === 1, 'Touch count = 1');
  assert(g.interactions[0] === 'orbit_start', 'orbit_start fired');

  // Move finger
  const oldTheta = g._orbitTheta;
  const oldPhi = g._orbitPhi;
  g.touchMove([{ clientX: 120, clientY: 210 }]);
  assert(g._orbitDirty === true, 'Orbit dirty after move');
  assert(g._orbitTheta !== oldTheta, 'Theta changed after finger move');
  assert(g._orbitPhi !== oldPhi, 'Phi changed after finger move');

  // End
  g.touchEnd([]);
  assert(g._touchOrbiting === false, 'Orbit ended');
  assert(g._touchCount === 0, 'Touch count = 0 after end');
  assert(g.interactions.includes('orbit_end'), 'orbit_end fired');
}

// ---- Test 2: Two-finger pinch zoom ----
{
  const g = new TouchGestureState();
  g.touchStart([
    { clientX: 100, clientY: 200 },
    { clientX: 200, clientY: 200 },
  ]);

  assert(g._touchPanning === true, 'Two-touch starts pan/zoom');
  assert(g._touchOrbiting === false, 'Not orbiting with two touches');
  assert(g._lastPinchDist > 0, 'Pinch distance recorded');
  assert(g.interactions[0] === 'pan_start', 'pan_start fired');

  const oldRadius = g._orbitRadius;
  // Pinch in: fingers move closer → zoom out (radius increases)
  g.touchMove([
    { clientX: 130, clientY: 200 },
    { clientX: 170, clientY: 200 },
  ]);
  assert(g._orbitRadius > oldRadius, `Pinch in → radius increased (${oldRadius} → ${g._orbitRadius})`);

  // Pinch out: fingers move apart → zoom in (radius decreases)
  const radiusBefore = g._orbitRadius;
  g.touchMove([
    { clientX: 50, clientY: 200 },
    { clientX: 250, clientY: 200 },
  ]);
  assert(g._orbitRadius < radiusBefore, `Pinch out → radius decreased (${radiusBefore} → ${g._orbitRadius})`);
}

// ---- Test 3: Two-finger pan ----
{
  const g = new TouchGestureState();
  const oldTarget = { ...g._orbitTarget };
  g.touchStart([
    { clientX: 100, clientY: 200 },
    { clientX: 200, clientY: 200 },
  ]);

  // Move both fingers in same direction (pan)
  g.touchMove([
    { clientX: 130, clientY: 230 },
    { clientX: 230, clientY: 230 },
  ]);

  const moved =
    g._orbitTarget.x !== oldTarget.x ||
    g._orbitTarget.y !== oldTarget.y ||
    g._orbitTarget.z !== oldTarget.z;
  assert(moved, 'Two-finger drag moves orbit target (pan)');
}

// ---- Test 4: Orbit phi clamping ----
{
  const g = new TouchGestureState();
  g._orbitPhi = 0.06;
  g.touchStart([{ clientX: 100, clientY: 200 }]);
  // Move up a lot → try to go below min phi
  g.touchMove([{ clientX: 100, clientY: 0 }]);
  assert(g._orbitPhi >= 0.05, `Phi clamped at minimum: ${g._orbitPhi}`);

  g._orbitPhi = Math.PI - 0.06;
  g.touchMove([{ clientX: 100, clientY: 400 }]);
  assert(g._orbitPhi <= Math.PI - 0.05, `Phi clamped at maximum: ${g._orbitPhi}`);
}

// ---- Test 5: Orbit radius clamping during pinch ----
{
  const g = new TouchGestureState();
  g._orbitRadius = 15;
  g.touchStart([
    { clientX: 100, clientY: 200 },
    { clientX: 101, clientY: 200 },
  ]);
  // Extreme pinch in (fingers very close → very apart): should clamp at min
  g._lastPinchDist = 1;
  g.touchMove([
    { clientX: 0, clientY: 200 },
    { clientX: 10000, clientY: 200 },
  ]);
  assert(g._orbitRadius >= 10, 'Radius clamped at minimum during extreme pinch');

  g._orbitRadius = 4000;
  g._lastPinchDist = 10000;
  g.touchMove([
    { clientX: 100, clientY: 200 },
    { clientX: 101, clientY: 200 },
  ]);
  assert(g._orbitRadius <= 5000, 'Radius clamped at maximum during extreme pinch');
}

// ---- Test 6: Two-to-one finger transition (end) ----
{
  const g = new TouchGestureState();
  g.touchStart([
    { clientX: 100, clientY: 200 },
    { clientX: 200, clientY: 200 },
  ]);
  assert(g._touchPanning === true, 'Started panning');

  // Lift one finger → should switch to orbit
  g.touchEnd([{ clientX: 100, clientY: 200 }]);
  assert(g._touchOrbiting === true, 'Switched to orbit after lifting one finger');
  assert(g._touchPanning === false, 'Panning stopped');
  assert(g._touchCount === 1, 'Touch count = 1 after transition');
}

// ---- Test 7: Touch cancel clears state ----
{
  const g = new TouchGestureState();
  g.touchStart([{ clientX: 100, clientY: 200 }]);
  assert(g._touchOrbiting === true, 'Orbiting before cancel');
  g.touchCancel();
  assert(g._touchOrbiting === false, 'Orbiting cleared after cancel');
  assert(g._touchPanning === false, 'Panning cleared after cancel');
  assert(g._touchCount === 0, 'Touch count reset after cancel');
}

// ---- Test 8: Sketch touch — single-finger drawing flow ----
{
  const s = new SketchTouchState();
  const r1 = s.handleTouchStart(1);
  assert(r1 === 'sketch-draw', 'Single touch in sketch = draw');
  assert(s.touchStartedDrawing === true, 'Drawing started');
  assert(s.toolEvents.includes('mouseDown'), 'mouseDown fired');
  assert(s.toolEvents.includes('click'), 'click fired');

  const r2 = s.handleTouchMove(1);
  assert(r2 === 'sketch-draw', 'Move in sketch = draw');
  assert(s.toolEvents.includes('mouseMove'), 'mouseMove fired');

  const r3 = s.handleTouchEnd(0);
  assert(r3 === 'end', 'End = all fingers lifted');
  assert(s.toolEvents.includes('mouseUp'), 'mouseUp fired on end');
  assert(s.touchWasMulti === false, 'touchWasMulti reset');
  assert(s.touchStartedDrawing === false, 'touchStartedDrawing reset');
}

// ---- Test 9: Sketch touch — multi-touch suppresses drawing ----
{
  const s = new SketchTouchState();
  // Start with 2 fingers → marks as multi
  const r1 = s.handleTouchStart(2);
  assert(r1 === 'multi-gesture', 'Two-touch = multi-gesture');
  assert(s.touchWasMulti === true, 'Multi-touch flagged');
  assert(s.touchStartedDrawing === false, 'Drawing not started');

  // Move with 2 fingers
  const r2 = s.handleTouchMove(2);
  assert(r2 === 'multi-gesture', 'Two-finger move = multi-gesture');

  // Lift to 1 finger → should NOT start drawing
  const r3 = s.handleTouchEnd(1);
  assert(r3 === 'gesture-continuing', 'Gesture continues after lifting one finger');

  // Try single-finger start again (from the remaining finger perspective)
  const r4 = s.handleTouchStart(1);
  assert(r4 === 'suppressed', 'Drawing suppressed after multi-touch');

  // Lift all fingers → resets
  const r5 = s.handleTouchEnd(0);
  assert(r5 === 'end', 'All fingers lifted');
  assert(s.touchWasMulti === false, 'Multi flag reset after all fingers lifted');
}

// ---- Test 10: Sketch touch — non-sketch mode delegates to 3D ----
{
  const s = new SketchTouchState();
  s.sketchingOnPlane = false;
  const r1 = s.handleTouchStart(1);
  assert(r1 === '3d-orbit', 'Non-sketch single touch = 3d-orbit');
  assert(s.touchStartedDrawing === false, 'Not drawing in 3D mode');

  const r2 = s.handleTouchMove(1);
  assert(r2 === '3d-orbit', 'Non-sketch move = 3d-orbit');
}

// ---- Test 11: Orbit direction — theta and phi signs ----
{
  const g = new TouchGestureState();
  const origTheta = g._orbitTheta;
  const origPhi = g._orbitPhi;

  g.touchStart([{ clientX: 200, clientY: 200 }]);

  // Move right → theta should decrease (dx positive → theta -= dx*0.005)
  g.touchMove([{ clientX: 250, clientY: 200 }]);
  assert(g._orbitTheta < origTheta, 'Moving right decreases theta (clockwise orbit)');

  // Move down → phi should decrease (dy positive → phi -= dy*0.005)
  const thetaAfterRight = g._orbitTheta;
  g.touchMove([{ clientX: 250, clientY: 250 }]);
  assert(g._orbitPhi < origPhi, 'Moving down decreases phi');
  assert(Math.abs(g._orbitTheta - thetaAfterRight) < 1e-10, 'Theta unchanged when moving vertically');
}

// ---- Test 12: Complete gesture sequence ----
{
  const g = new TouchGestureState();
  // 1) Start orbit
  g.touchStart([{ clientX: 100, clientY: 100 }]);
  assert(g.interactions.length === 1, '1 interaction after orbit start');

  // 2) Move orbit
  g.touchMove([{ clientX: 150, clientY: 150 }]);

  // 3) End orbit
  g.touchEnd([]);
  assert(g.interactions.length === 2, '2 interactions after orbit end');
  assert(g.interactions[0] === 'orbit_start', 'First = orbit_start');
  assert(g.interactions[1] === 'orbit_end', 'Second = orbit_end');

  // 4) Start pinch
  g.touchStart([
    { clientX: 100, clientY: 100 },
    { clientX: 200, clientY: 100 },
  ]);
  assert(g.interactions[2] === 'pan_start', 'pan_start for pinch');

  // 5) End pinch
  g.touchEnd([]);
  assert(g.interactions[3] === 'orbit_end', 'orbit_end for pinch release');
}

// ---- Summary ----
console.log(`Touch Gesture Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
