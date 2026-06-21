import * as THREE from 'three';

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

export class SceneManager {
	scene: THREE.Scene;
	camera: THREE.OrthographicCamera;
	renderer: THREE.WebGLRenderer;
	readonly worldSize: number;

	private container: HTMLElement;
	private animationFrameId: number | null = null;
	private onFps: ((fps: number) => void) | null = null;
	private frameCount = 0;
	private fpsWindowStart = 0;

	// Camera state
	private zoom = $state(1);
	private panX = $state(0);
	private panY = $state(0);

	// Interaction state
	private isPanning = false;
	private spaceDown = false;
	private lastMouseX = 0;
	private lastMouseY = 0;

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

		// Create orthographic camera (looking down at XZ plane)
		const aspect = container.clientWidth / container.clientHeight;
		const frustumSize = BASE_FRUSTUM;
		this.camera = new THREE.OrthographicCamera(
			(-frustumSize * aspect) / 2,
			(frustumSize * aspect) / 2,
			frustumSize / 2,
			-frustumSize / 2,
			0.1,
			10000
		);
		this.camera.position.set(0, 1000, 0);
		this.camera.up.set(0, 0, -1);
		this.camera.lookAt(0, 0, 0);

		// Create renderer
		this.renderer = new THREE.WebGLRenderer({ antialias: true });
		this.renderer.setSize(container.clientWidth, container.clientHeight);
		this.renderer.setPixelRatio(window.devicePixelRatio);
		container.appendChild(this.renderer.domElement);

		// Create ground plane
		this.createGround();

		// Set up event listeners
		this.setupEventListeners();

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

		window.addEventListener('resize', this.handleResize.bind(this));
		window.addEventListener('keydown', this.handleKeyDown);
		window.addEventListener('keyup', this.handleKeyUp);
	}

	private handleKeyDown = (event: KeyboardEvent) => {
		if (event.code !== 'Space' || event.repeat) return;
		const target = event.target;
		if (target instanceof HTMLElement && target.tagName !== 'BODY') return;

		event.preventDefault();
		this.spaceDown = true;
		this.updateCursor();
	};

	private handleKeyUp = (event: KeyboardEvent) => {
		if (event.code !== 'Space') return;
		this.spaceDown = false;
		this.updateCursor();
	};

	private handleWheel(event: WheelEvent) {
		event.preventDefault();

		const zoomSpeed = 0.1;
		const delta = event.deltaY > 0 ? -zoomSpeed : zoomSpeed;
		this.zoom = Math.max(this.minZoom(), Math.min(10, this.zoom * (1 + delta)));

		this.updateCamera();
	}

	private handleMouseDown(event: MouseEvent) {
		if (event.button === 1 || (event.button === 0 && (event.altKey || this.spaceDown))) {
			this.isPanning = true;
			this.lastMouseX = event.clientX;
			this.lastMouseY = event.clientY;
			this.updateCursor();
		}
	}

	private handleMouseMove(event: MouseEvent) {
		if (this.isPanning) {
			const dx = event.clientX - this.lastMouseX;
			const dy = event.clientY - this.lastMouseY;

			// World units per screen pixel: the base frustum spans the viewport
			// height, so this keeps the grabbed point under the cursor.
			const scale = this.getFrustumWidth() / this.container.clientHeight;
			this.panX -= dx * scale;
			this.panY += dy * scale;
			this.clampPan();

			this.lastMouseX = event.clientX;
			this.lastMouseY = event.clientY;

			this.updateCamera();
		}
	}

	private handleMouseUp() {
		if (this.isPanning) {
			this.isPanning = false;
			this.updateCursor();
		}
	}

	private updateCursor() {
		this.renderer.domElement.style.cursor = this.isPanning
			? 'grabbing'
			: this.spaceDown
				? 'grab'
				: 'default';
	}

	isCameraPanning() {
		return this.isPanning;
	}

	private handleResize() {
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;

		this.renderer.setSize(width, height);
		this.updateCamera();
	}

	private getFrustumWidth() {
		return BASE_FRUSTUM / this.zoom;
	}

	// Lowest zoom: frames the whole world plus a slim margin of void around it.
	private minZoom() {
		return BASE_FRUSTUM / (this.worldSize * WORLD_VIEW_MARGIN);
	}

	// Keep the camera centred within the world so you can't pan off into the void
	// around the diorama.
	private clampPan() {
		const half = this.worldSize / 2;
		this.panX = Math.max(-half, Math.min(half, this.panX));
		this.panY = Math.max(-half, Math.min(half, this.panY));
	}

	private updateCamera() {
		const aspect = this.container.clientWidth / this.container.clientHeight;
		const frustumSize = this.getFrustumWidth();

		this.camera.left = (-frustumSize * aspect) / 2 + this.panX;
		this.camera.right = (frustumSize * aspect) / 2 + this.panX;
		this.camera.top = frustumSize / 2 + this.panY;
		this.camera.bottom = -frustumSize / 2 + this.panY;
		this.camera.updateProjectionMatrix();
	}

	private animate() {
		this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
		this.renderer.render(this.scene, this.camera);

		if (this.onFps) {
			this.frameCount++;
			const now = performance.now();
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
		const x = ((screenX - rect.left) / rect.width) * 2 - 1;
		const y = -((screenY - rect.top) / rect.height) * 2 + 1;

		const vector = new THREE.Vector3(x, y, 0);
		vector.unproject(this.camera);

		return { x: vector.x, z: vector.z };
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
