import * as THREE from 'three';
import { SvelteSet } from 'svelte/reactivity';

// Default extent of the buildable world, in metres (world units). The map is a
// finite diorama slab rather than an endless plane; overridable per SceneManager
// so a settings UI can resize the world later.
const DEFAULT_WORLD_SIZE = 5000;
// How deep the slab sits below the ground surface — only visible once the camera
// can tilt, but it gives the world a solid edge instead of a paper-thin plane.
const GROUND_DEPTH = 200;
// Matches the grass lane color in road-renderer's LAYER_COLORS — the slab's top
// face reads as the same grass.
const GROUND_COLOR = 0x52a06b;
// Earthy tone for the slab's sides and underside.
const SOIL_COLOR = 0x5c4a37;
// Vertical world units the viewport spans at zoom 1.
const BASE_FRUSTUM = 500;
// How far past the world edge you can zoom out — 1.1 leaves a slim margin of
// void around the diorama at full zoom-out so the whole slab stays framed.
const WORLD_VIEW_MARGIN = 1.1;
// Perspective camera. A narrow-ish field of view keeps distortion mild, so the
// near-top-down default still reads like the old flat map and tilting reveals
// depth. logarithmicDepthBuffer keeps the road layers' tiny Y-offsets from
// z-fighting across the much larger depth range a tilted perspective view spans.
const CAMERA_FOV = 45;
const CAMERA_NEAR = 1;
const CAMERA_FAR = 50000;
// Distance from the target at zoom 1, chosen so a top-down view frames the same
// BASE_FRUSTUM height the old orthographic camera did — zoom feel is unchanged.
const BASE_DISTANCE = BASE_FRUSTUM / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));
// Orbit tilt limits: a hair off straight-down (avoids the look-straight-down
// singularity) up to a steep oblique that keeps the horizon off-screen.
const MIN_POLAR = 0.001;
const MAX_POLAR = (70 * Math.PI) / 180;
// Start tilted so it reads as 3D right away, while staying comfortable to edit.
const DEFAULT_POLAR = (45 * Math.PI) / 180;
// Start rotated 45° as well, so the square diorama faces the viewer corner-on.
const DEFAULT_AZIMUTH = Math.PI / 4;
// Radians of orbit per pixel of middle-mouse drag.
const ORBIT_SPEED = 0.0035;
// Keyboard camera speeds: WASD pans by this fraction of the view height per
// second; Q/E orbit by this many radians per second.
const KEY_PAN_SPEED = 1.2;
const KEY_ORBIT_SPEED = 4.0;
// Keyboard motion uses a momentum model so it can ramp up fast yet coast a long
// way: velocity attacks its target with KEY_ATTACK_TIME and, on release, decays
// with the longer KEY_COAST_TIME (both smoothing time constants, in seconds).
const KEY_ATTACK_TIME = 0.05;
// Also how long a flicked drag-pan coasts after release.
const KEY_COAST_TIME = 0.2;
// Velocities below these thresholds snap to rest (world units/s, radians/s).
const PAN_VEL_EPSILON = 0.01;
const ORBIT_VEL_EPSILON = 0.0005;
// Middle-mouse orbit eases toward its goal with this time constant.
const DRAG_SMOOTH_TIME = 0.1;
// Each wheel notch scales zoom by this factor (reciprocal in/out, so zooming in
// and out feel symmetric in log-space); zoom then eases in with a little inertia.
const ZOOM_FACTOR = 1.12;
const ZOOM_SMOOTH_TIME = 0.08;
// Held keys that drive the camera (WASD pan, Q/E orbit).
const CAMERA_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

export class SceneManager {
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	renderer: THREE.WebGLRenderer;
	readonly worldSize: number;

	private container: HTMLElement;
	private animationFrameId: number | null = null;
	private onFps: ((fps: number) => void) | null = null;
	private frameCount = 0;
	private fpsWindowStart = 0;

	// Camera state: the camera orbits a target point on the ground (y=0). Each
	// rendered value eases toward its goal* counterpart every frame for inertia —
	// input writes the goals, the render loop smooths and applies them.
	private zoom = 1;
	private targetX = 0;
	private targetZ = 0;
	private azimuth = DEFAULT_AZIMUTH; // rotation around Y
	private polar = DEFAULT_POLAR; // tilt from straight-down
	private goalZoom = 1;
	private goalTargetX = 0;
	private goalTargetZ = 0;
	private goalAzimuth = DEFAULT_AZIMUTH;
	private goalPolar = DEFAULT_POLAR;
	// Keyboard momentum velocities (world units/s for pan, radians/s for orbit).
	private panVelX = 0;
	private panVelZ = 0;
	private orbitVel = 0;
	// Pan-drag flick tracking: recent drag velocity (world units/s) and timestamp.
	private dragVelX = 0;
	private dragVelZ = 0;
	private lastMoveTime = 0;
	// Test/deep-link mode (?topdown) snaps instantly instead of easing.
	private instantCamera = false;

	// Interaction state
	private isPanning = false;
	private isOrbiting = false;
	private spaceDown = false;
	private heldKeys = new SvelteSet<string>();
	private lastMouseX = 0;
	private lastMouseY = 0;
	private lastFrameTime = 0;
	private raycaster = new THREE.Raycaster();
	private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

	constructor(
		container: HTMLElement,
		onFps?: (fps: number) => void,
		worldSize = DEFAULT_WORLD_SIZE
	) {
		this.container = container;
		this.onFps = onFps ?? null;
		this.worldSize = worldSize;

		// Create scene
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x1a1a1a);

		// Create perspective camera orbiting a ground target
		const aspect = container.clientWidth / container.clientHeight;
		this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, CAMERA_NEAR, CAMERA_FAR);
		this.camera.up.set(0, 1, 0);

		// Create renderer
		this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
		this.renderer.setSize(container.clientWidth, container.clientHeight);
		this.renderer.setPixelRatio(window.devicePixelRatio);
		container.appendChild(this.renderer.domElement);

		// Create ground plane
		this.createGround();

		// Set up event listeners
		this.setupEventListeners();

		// Position the camera from the initial orbit state
		this.updateCamera();

		// Start render loop
		this.animate();
	}

	private createGround() {
		// A finite slab: the top face is grass at y=0 (where all road geometry sits
		// just above), the sides and underside are soil so the world reads as a
		// diorama block once the camera tilts. BoxGeometry face order is
		// [+X, -X, +Y, -Y, +Z, -Z], so index 2 is the top.
		const geometry = new THREE.BoxGeometry(this.worldSize, GROUND_DEPTH, this.worldSize);
		const grass = new THREE.MeshBasicMaterial({ color: GROUND_COLOR });
		const soil = new THREE.MeshBasicMaterial({ color: SOIL_COLOR });
		const ground = new THREE.Mesh(geometry, [soil, soil, grass, soil, soil, soil]);
		ground.position.y = -GROUND_DEPTH / 2;
		ground.name = 'ground';
		this.scene.add(ground);
	}

	private setupEventListeners() {
		const canvas = this.renderer.domElement;

		canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
		canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
		canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
		canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
		canvas.addEventListener('mouseleave', this.handleMouseUp.bind(this));
		// The editor canvas has no use for the browser context menu.
		canvas.addEventListener('contextmenu', (event) => event.preventDefault());

		window.addEventListener('resize', this.handleResize.bind(this));
		window.addEventListener('keydown', this.handleKeyDown);
		window.addEventListener('keyup', this.handleKeyUp);
		window.addEventListener('blur', this.handleBlur);
	}

	private handleKeyDown = (event: KeyboardEvent) => {
		const target = event.target;
		if (target instanceof HTMLElement && target.tagName !== 'BODY') return;

		if (event.code === 'Space') {
			if (event.repeat) return;
			event.preventDefault();
			this.spaceDown = true;
			this.updateCursor();
			return;
		}
		if (CAMERA_KEYS.has(event.code)) {
			this.heldKeys.add(event.code);
		}
	};

	private handleKeyUp = (event: KeyboardEvent) => {
		if (event.code === 'Space') {
			this.spaceDown = false;
			this.updateCursor();
			return;
		}
		this.heldKeys.delete(event.code);
	};

	private handleBlur = () => {
		// Losing focus (tab switch, alt-tab) would otherwise leave keys stuck down.
		this.heldKeys.clear();
		this.spaceDown = false;
		this.updateCursor();
	};

	private handleWheel(event: WheelEvent) {
		event.preventDefault();

		const factor = event.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
		this.goalZoom = Math.max(this.minZoom(), Math.min(10, this.goalZoom * factor));
	}

	private handleMouseDown(event: MouseEvent) {
		if (event.button === 1) {
			// Middle mouse orbits.
			event.preventDefault();
			this.isOrbiting = true;
			this.lastMouseX = event.clientX;
			this.lastMouseY = event.clientY;
			this.updateCursor();
			return;
		}
		if (event.button === 0 && (event.altKey || this.spaceDown)) {
			this.isPanning = true;
			this.lastMouseX = event.clientX;
			this.lastMouseY = event.clientY;
			// Reset flick tracking and cancel any existing coast.
			this.panVelX = 0;
			this.panVelZ = 0;
			this.dragVelX = 0;
			this.dragVelZ = 0;
			this.lastMoveTime = performance.now();
			this.updateCursor();
		}
	}

	private handleMouseMove(event: MouseEvent) {
		const dx = event.clientX - this.lastMouseX;
		const dy = event.clientY - this.lastMouseY;

		if (this.isOrbiting) {
			this.goalAzimuth -= dx * ORBIT_SPEED;
			this.goalPolar = Math.max(MIN_POLAR, Math.min(MAX_POLAR, this.goalPolar - dy * ORBIT_SPEED));
			this.lastMouseX = event.clientX;
			this.lastMouseY = event.clientY;
			return;
		}

		if (this.isPanning) {
			// Drag the grabbed ground point 1:1 with the cursor — direct manipulation
			// must track exactly, so move both rendered and goal with no smoothing lag.
			// Directions are the camera's screen-right/forward projected onto the
			// ground, so panning follows the current orbit angle.
			const wpp = this.worldPerPixel();
			const rightX = Math.cos(this.azimuth);
			const rightZ = -Math.sin(this.azimuth);
			const upX = -Math.sin(this.azimuth);
			const upZ = -Math.cos(this.azimuth);
			const moveX = -(dx * rightX - dy * upX) * wpp;
			const moveZ = -(dx * rightZ - dy * upZ) * wpp;
			this.goalTargetX += moveX;
			this.targetX += moveX;
			this.goalTargetZ += moveZ;
			this.targetZ += moveZ;
			this.clampTarget();

			// Track drag velocity so releasing throws the pan into a coast.
			const now = performance.now();
			const dt = (now - this.lastMoveTime) / 1000;
			if (dt > 0) {
				this.dragVelX = moveX / dt;
				this.dragVelZ = moveZ / dt;
			}
			this.lastMoveTime = now;

			this.lastMouseX = event.clientX;
			this.lastMouseY = event.clientY;
		}
	}

	private handleMouseUp() {
		if (this.isPanning) {
			// Throw the pan into a coast using the recent drag velocity, unless the
			// cursor was held still just before release.
			const stillFor = (performance.now() - this.lastMoveTime) / 1000;
			if (stillFor < 0.05) {
				this.panVelX = this.dragVelX;
				this.panVelZ = this.dragVelZ;
			}
			this.dragVelX = 0;
			this.dragVelZ = 0;
		}
		if (this.isPanning || this.isOrbiting) {
			this.isPanning = false;
			this.isOrbiting = false;
			this.updateCursor();
		}
	}

	private updateCursor() {
		const canvas = this.renderer.domElement;
		if (this.isOrbiting) canvas.style.cursor = 'move';
		else if (this.isPanning) canvas.style.cursor = 'grabbing';
		else if (this.spaceDown) canvas.style.cursor = 'grab';
		else canvas.style.cursor = 'default';
	}

	isCameraPanning() {
		return this.isPanning || this.isOrbiting;
	}

	// Force a flat top-down view (heading reset, no tilt) and disable inertia, so
	// the e2e harness and deep links get a deterministic, linear screen-to-world
	// mapping with no easing settling time.
	setTopDown() {
		this.instantCamera = true;
		this.goalAzimuth = this.azimuth = 0;
		this.goalPolar = this.polar = MIN_POLAR;
		this.updateCamera();
	}

	private handleResize() {
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;

		this.renderer.setSize(width, height);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.updateCamera();
	}

	private getFrustumWidth() {
		return BASE_FRUSTUM / this.zoom;
	}

	// Lowest zoom: frames the whole world plus a slim margin of void around it.
	private minZoom() {
		return BASE_FRUSTUM / (this.worldSize * WORLD_VIEW_MARGIN);
	}

	// Keep the look-at target within the world so you can't pan off into the void
	// around the diorama. Clamps both rendered and goal so they stay in lock-step.
	private clampTarget() {
		const half = this.worldSize / 2;
		this.goalTargetX = Math.max(-half, Math.min(half, this.goalTargetX));
		this.goalTargetZ = Math.max(-half, Math.min(half, this.goalTargetZ));
		this.targetX = Math.max(-half, Math.min(half, this.targetX));
		this.targetZ = Math.max(-half, Math.min(half, this.targetZ));
	}

	private integrateKeyboardMomentum(dt: number) {
		// Pan: derive a target velocity from WASD (screen-relative, follows the
		// heading), ramp the velocity toward it fast, and coast on release.
		let forward = 0;
		let strafe = 0;
		if (this.heldKeys.has('KeyW')) forward += 1;
		if (this.heldKeys.has('KeyS')) forward -= 1;
		if (this.heldKeys.has('KeyD')) strafe += 1;
		if (this.heldKeys.has('KeyA')) strafe -= 1;
		let targetVelX = 0;
		let targetVelZ = 0;
		if (forward !== 0 || strafe !== 0) {
			const rightX = Math.cos(this.azimuth);
			const rightZ = -Math.sin(this.azimuth);
			const upX = -Math.sin(this.azimuth);
			const upZ = -Math.cos(this.azimuth);
			const inv = 1 / Math.hypot(forward, strafe); // normalise diagonals
			const speed = KEY_PAN_SPEED * this.getFrustumWidth();
			targetVelX = (strafe * rightX + forward * upX) * inv * speed;
			targetVelZ = (strafe * rightZ + forward * upZ) * inv * speed;
		}
		const panMoving = targetVelX !== 0 || targetVelZ !== 0;
		const panK = 1 - Math.exp(-dt / (panMoving ? KEY_ATTACK_TIME : KEY_COAST_TIME));
		this.panVelX += (targetVelX - this.panVelX) * panK;
		this.panVelZ += (targetVelZ - this.panVelZ) * panK;
		if (Math.abs(this.panVelX) < PAN_VEL_EPSILON) this.panVelX = 0;
		if (Math.abs(this.panVelZ) < PAN_VEL_EPSILON) this.panVelZ = 0;

		// Orbit: the same momentum treatment for Q/E.
		let orbitDir = 0;
		if (this.heldKeys.has('KeyE')) orbitDir += 1;
		if (this.heldKeys.has('KeyQ')) orbitDir -= 1;
		const targetOrbitVel = orbitDir * KEY_ORBIT_SPEED;
		const orbitK = 1 - Math.exp(-dt / (orbitDir !== 0 ? KEY_ATTACK_TIME : KEY_COAST_TIME));
		this.orbitVel += (targetOrbitVel - this.orbitVel) * orbitK;
		if (Math.abs(this.orbitVel) < ORBIT_VEL_EPSILON) this.orbitVel = 0;

		// Apply the velocities to both rendered and goal, so the drag-smoothing pass
		// sees only drag error, never the keyboard motion.
		if (this.panVelX !== 0 || this.panVelZ !== 0) {
			this.goalTargetX += this.panVelX * dt;
			this.goalTargetZ += this.panVelZ * dt;
			this.targetX += this.panVelX * dt;
			this.targetZ += this.panVelZ * dt;
			this.clampTarget();
		}
		if (this.orbitVel !== 0) {
			const da = this.orbitVel * dt;
			this.azimuth += da;
			this.goalAzimuth += da;
		}
	}

	private stepCamera(dt: number) {
		if (this.instantCamera) {
			this.zoom = this.goalZoom;
			this.targetX = this.goalTargetX;
			this.targetZ = this.goalTargetZ;
			this.azimuth = this.goalAzimuth;
			this.polar = this.goalPolar;
			this.panVelX = this.panVelZ = this.orbitVel = 0;
			this.updateCamera();
			return;
		}

		if (dt > 0) this.integrateKeyboardMomentum(dt);

		// Drag-driven axes ease toward their goals; zoom settles faster so it
		// doesn't keep drifting after the wheel stops.
		const kDrag = dt > 0 ? 1 - Math.exp(-dt / DRAG_SMOOTH_TIME) : 1;
		const kZoom = dt > 0 ? 1 - Math.exp(-dt / ZOOM_SMOOTH_TIME) : 1;
		this.zoom += (this.goalZoom - this.zoom) * kZoom;
		this.targetX += (this.goalTargetX - this.targetX) * kDrag;
		this.targetZ += (this.goalTargetZ - this.targetZ) * kDrag;
		this.azimuth += (this.goalAzimuth - this.azimuth) * kDrag;
		this.polar += (this.goalPolar - this.polar) * kDrag;

		this.updateCamera();
	}

	private updateCamera() {
		// Place the camera on a sphere around the target: zoom sets the distance,
		// azimuth the heading, polar the tilt from straight-down.
		const distance = BASE_DISTANCE / this.zoom;
		const sinPolar = Math.sin(this.polar);
		const offsetX = distance * sinPolar * Math.sin(this.azimuth);
		const offsetZ = distance * sinPolar * Math.cos(this.azimuth);
		const offsetY = distance * Math.cos(this.polar);

		this.camera.position.set(this.targetX + offsetX, offsetY, this.targetZ + offsetZ);
		this.camera.lookAt(this.targetX, 0, this.targetZ);
	}

	private animate() {
		this.animationFrameId = requestAnimationFrame(this.animate.bind(this));

		const now = performance.now();
		// Clamp dt so a backgrounded tab doesn't resume with a huge camera jump.
		const dt = this.lastFrameTime === 0 ? 0 : Math.min(0.1, (now - this.lastFrameTime) / 1000);
		this.lastFrameTime = now;
		this.stepCamera(dt);

		this.renderer.render(this.scene, this.camera);

		if (this.onFps) {
			this.frameCount++;
			if (this.fpsWindowStart === 0) {
				this.fpsWindowStart = now;
			} else if (now - this.fpsWindowStart >= 500) {
				this.onFps(Math.round((this.frameCount * 1000) / (now - this.fpsWindowStart)));
				this.frameCount = 0;
				this.fpsWindowStart = now;
			}
		}
	}

	// World units per screen pixel at the current zoom — hit areas and snap
	// radii are sized in pixels and converted through this, so they stay a
	// constant finger-size on screen at any zoom.
	worldPerPixel(): number {
		const height = this.container.clientHeight;
		if (height <= 0) return 1;
		return this.getFrustumWidth() / height;
	}

	screenToWorld(screenX: number, screenY: number): { x: number; z: number } {
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
		const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

		// Cast a ray through the pixel and intersect the ground plane (y=0) — under
		// a tilted perspective the screen no longer maps linearly to the ground.
		this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
		const hit = new THREE.Vector3();
		if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
			return { x: hit.x, z: hit.z };
		}

		// Ray points above the horizon (only possible at a steep tilt) — fall back
		// to the look-at target so drawing and snapping still get an in-world point.
		return { x: this.targetX, z: this.targetZ };
	}

	getCanvas() {
		return this.renderer.domElement;
	}

	dispose() {
		if (this.animationFrameId !== null) {
			cancelAnimationFrame(this.animationFrameId);
		}

		window.removeEventListener('keydown', this.handleKeyDown);
		window.removeEventListener('keyup', this.handleKeyUp);
		window.removeEventListener('blur', this.handleBlur);

		this.renderer.domElement.remove();
		this.renderer.dispose();

		this.scene.traverse((object) => {
			if (object instanceof THREE.Mesh) {
				object.geometry.dispose();
				const material = object.material;
				if (Array.isArray(material)) {
					material.forEach((m) => m.dispose());
				} else if (material instanceof THREE.Material) {
					material.dispose();
				}
			}
		});
	}
}
