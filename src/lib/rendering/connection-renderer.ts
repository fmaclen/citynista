import * as THREE from 'three';
import type { LaneConnection, LaneEndpoint } from '../core/lane-connections';
import { sameLaneRef } from '../core/lane-connections';
import type { LaneRef } from '../core/types';

// Lane connectors drawn above everything in connector mode: one bezier per
// movement (visible when allowed, faint when blocked) plus a dot at each lane
// mouth — a filled disc where traffic enters the node, a hollow ring where it
// leaves. Drag between an in dot and an out dot to toggle that movement. Colours
// follow the editor convention: yellow = an interactive handle, blue = hover.
const CONNECTION_Y = 0.3;
const DOT_Y = 0.31;
const HANDLE_COLOR = 0xfacc15;
const HOVER_COLOR = 0x4a9eff;
const ACTIVE_COLOR = 0xe2e8f0;
const ACTIVE_OPACITY = 0.8;
const DISABLED_COLOR = 0x64748b;
const DISABLED_OPACITY = 0.4;
const RUBBER_COLOR = 0xfacc15;
const DOT_RADIUS = 1.2;
const RING_INNER = 0.62;
const DOT_SEGMENTS = 20;
const HOVER_SCALE = 1.35;
const RENDER_ORDER = 4;
const SAMPLES = 18;

interface DotHandle {
	ref: LaneRef;
	mesh: THREE.Mesh;
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const u = 1 - t;
	return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export class ConnectionRenderer {
	private scene: THREE.Scene;
	private group: THREE.Group | null = null;
	private rubber: THREE.Line | null = null;
	private dots: DotHandle[] = [];
	private hoveredRef: LaneRef | null = null;
	private activeMaterial: THREE.LineBasicMaterial;
	private disabledMaterial: THREE.LineBasicMaterial;
	private handleMaterial: THREE.MeshBasicMaterial;
	private hoverMaterial: THREE.MeshBasicMaterial;
	private rubberMaterial: THREE.LineBasicMaterial;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
		this.activeMaterial = new THREE.LineBasicMaterial({
			color: ACTIVE_COLOR,
			transparent: true,
			opacity: ACTIVE_OPACITY,
			depthWrite: false
		});
		this.disabledMaterial = new THREE.LineBasicMaterial({
			color: DISABLED_COLOR,
			transparent: true,
			opacity: DISABLED_OPACITY,
			depthWrite: false
		});
		this.handleMaterial = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthWrite: false });
		this.hoverMaterial = new THREE.MeshBasicMaterial({ color: HOVER_COLOR, depthWrite: false });
		this.rubberMaterial = new THREE.LineBasicMaterial({
			color: RUBBER_COLOR,
			transparent: true,
			opacity: 0.95,
			depthWrite: false
		});
	}

	show(connections: LaneConnection[], endpoints: LaneEndpoint[]) {
		this.clear();
		if (connections.length === 0 && endpoints.length === 0) return;

		const group = new THREE.Group();
		group.renderOrder = RENDER_ORDER;

		for (const c of connections) {
			const reach = Math.hypot(c.toPoint.x - c.fromPoint.x, c.toPoint.y - c.fromPoint.y) * 0.4;
			const c1x = c.fromPoint.x + c.fromDir.x * reach;
			const c1y = c.fromPoint.y + c.fromDir.y * reach;
			const c2x = c.toPoint.x - c.toDir.x * reach;
			const c2y = c.toPoint.y - c.toDir.y * reach;

			const points: THREE.Vector3[] = [];
			for (let i = 0; i <= SAMPLES; i++) {
				const t = i / SAMPLES;
				points.push(
					new THREE.Vector3(
						cubic(c.fromPoint.x, c1x, c2x, c.toPoint.x, t),
						CONNECTION_Y,
						cubic(c.fromPoint.y, c1y, c2y, c.toPoint.y, t)
					)
				);
			}
			const geometry = new THREE.BufferGeometry().setFromPoints(points);
			group.add(new THREE.Line(geometry, c.active ? this.activeMaterial : this.disabledMaterial));
		}

		for (const endpoint of endpoints) {
			// Filled disc = incoming (drag from here), hollow ring = outgoing.
			const geometry =
				endpoint.flow === 'in'
					? new THREE.CircleGeometry(DOT_RADIUS, DOT_SEGMENTS)
					: new THREE.RingGeometry(RING_INNER, DOT_RADIUS, DOT_SEGMENTS);
			const mesh = new THREE.Mesh(geometry, this.handleMaterial);
			mesh.rotation.x = -Math.PI / 2;
			mesh.position.set(endpoint.point.x, DOT_Y, endpoint.point.y);
			mesh.renderOrder = RENDER_ORDER + 1;
			group.add(mesh);
			this.dots.push({ ref: endpoint.ref, mesh });
		}

		this.scene.add(group);
		this.group = group;
		this.applyHover();
	}

	// Highlight the dot under the cursor (blue, enlarged); pass null to clear.
	setHovered(ref: LaneRef | null) {
		const changed =
			(this.hoveredRef === null) !== (ref === null) ||
			(this.hoveredRef !== null && ref !== null && !sameLaneRef(this.hoveredRef, ref));
		if (!changed) return;
		this.hoveredRef = ref;
		this.applyHover();
	}

	private applyHover() {
		for (const dot of this.dots) {
			const hovered = this.hoveredRef !== null && sameLaneRef(dot.ref, this.hoveredRef);
			dot.mesh.material = hovered ? this.hoverMaterial : this.handleMaterial;
			dot.mesh.scale.setScalar(hovered ? HOVER_SCALE : 1);
		}
	}

	showRubberBand(from: { x: number; y: number }, to: { x: number; y: number }) {
		this.hideRubberBand();
		const geometry = new THREE.BufferGeometry().setFromPoints([
			new THREE.Vector3(from.x, DOT_Y, from.y),
			new THREE.Vector3(to.x, DOT_Y, to.y)
		]);
		const line = new THREE.Line(geometry, this.rubberMaterial);
		line.renderOrder = RENDER_ORDER + 2;
		this.scene.add(line);
		this.rubber = line;
	}

	hideRubberBand() {
		if (!this.rubber) return;
		this.rubber.geometry.dispose();
		this.scene.remove(this.rubber);
		this.rubber = null;
	}

	clear() {
		this.hideRubberBand();
		this.dots = [];
		this.hoveredRef = null;
		if (!this.group) return;
		this.group.traverse((object) => {
			if (object instanceof THREE.Line || object instanceof THREE.Mesh) object.geometry.dispose();
		});
		this.scene.remove(this.group);
		this.group = null;
	}

	dispose() {
		this.clear();
		this.activeMaterial.dispose();
		this.disabledMaterial.dispose();
		this.handleMaterial.dispose();
		this.hoverMaterial.dispose();
		this.rubberMaterial.dispose();
	}
}
