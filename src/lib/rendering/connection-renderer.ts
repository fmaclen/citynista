import * as THREE from 'three';
import type { LaneConnection, LaneEndpoint } from '../core/lane-connections';
import { sameLaneRef } from '../core/lane-connections';
import type { LaneRef } from '../core/types';

// Lane connectors drawn above everything in connector mode: every allowed
// movement is a thin dashed yellow arc, plus a dot at each lane mouth — a filled
// disc where traffic enters the node (drag from here), a hollow ring where it
// leaves (a passive target). While dragging, the dot under the cursor turns
// green on a valid exit, red on an invalid one. Dots/arcs follow the editor
// palette (yellow = handle, blue = hover) and read as "editor mode" — dashed,
// never mistaken for road paint.
const CONNECTION_Y = 0.3;
const DOT_Y = 0.31;
const HANDLE_COLOR = 0xfacc15;
const HOVER_COLOR = 0x4a9eff;
const ACTIVE_COLOR = 0xfacc15;
const VALID_COLOR = 0x22c55e;
const INVALID_COLOR = 0xef4444;
const RUBBER_COLOR = 0xfacc15;
const DOT_RADIUS = 1.2;
const RING_INNER = 0.62;
const DOT_SEGMENTS = 20;
const HOVER_SCALE = 1.35;
const ARC_WIDTH = 0.35;
const ARC_DASH = 1.2;
const ARC_GAP = 0.9;
const ARC_RESAMPLE = 0.3;
const ARC_SAMPLES = 30;
const ARC_ORDER = 4;
const RUBBER_ORDER = 5;
const DOT_ORDER = 7;

type RubberState = 'neutral' | 'valid' | 'invalid';

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const u = 1 - t;
	return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// A dashed flat ribbon along a polyline (XZ plane at height y). The polyline is
// first resampled to a roughly uniform spacing — a bezier sampled in t is not
// uniform in arc length, which left dashes ragged — then a quad is emitted for
// every step whose midpoint lands in a dash.
function dashedRibbon(
	curve: { x: number; y: number }[],
	width: number,
	y: number
): THREE.BufferGeometry {
	const pts: { x: number; y: number }[] = [curve[0]];
	for (let i = 0; i < curve.length - 1; i++) {
		const a = curve[i];
		const b = curve[i + 1];
		const len = Math.hypot(b.x - a.x, b.y - a.y);
		const n = Math.max(1, Math.round(len / ARC_RESAMPLE));
		for (let k = 1; k <= n; k++) {
			pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
		}
	}

	const positions: number[] = [];
	const half = width / 2;
	const cycle = ARC_DASH + ARC_GAP;
	let acc = 0;
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		const dx = b.x - a.x;
		const dz = b.y - a.y;
		const len = Math.hypot(dx, dz);
		if (len < 1e-6) continue;
		const mid = acc + len / 2;
		acc += len;
		if (mid % cycle >= ARC_DASH) continue;
		const nx = (-dz / len) * half;
		const nz = (dx / len) * half;
		positions.push(
			a.x + nx,
			y,
			a.y + nz,
			b.x + nx,
			y,
			b.y + nz,
			a.x - nx,
			y,
			a.y - nz,
			a.x - nx,
			y,
			a.y - nz,
			b.x + nx,
			y,
			b.y + nz,
			b.x - nx,
			y,
			b.y - nz
		);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	return geometry;
}

function arcRibbon(c: LaneConnection): THREE.BufferGeometry {
	const reach = Math.hypot(c.toPoint.x - c.fromPoint.x, c.toPoint.y - c.fromPoint.y) * 0.4;
	const c1x = c.fromPoint.x + c.fromDir.x * reach;
	const c1y = c.fromPoint.y + c.fromDir.y * reach;
	const c2x = c.toPoint.x - c.toDir.x * reach;
	const c2y = c.toPoint.y - c.toDir.y * reach;
	const curve: { x: number; y: number }[] = [];
	for (let i = 0; i <= ARC_SAMPLES; i++) {
		const t = i / ARC_SAMPLES;
		curve.push({
			x: cubic(c.fromPoint.x, c1x, c2x, c.toPoint.x, t),
			y: cubic(c.fromPoint.y, c1y, c2y, c.toPoint.y, t)
		});
	}
	return dashedRibbon(curve, ARC_WIDTH, CONNECTION_Y);
}

export class ConnectionRenderer {
	private scene: THREE.Scene;
	private dotGroup: THREE.Group | null = null;
	private arcGroup: THREE.Group | null = null;
	private rubber: THREE.Mesh | null = null;
	private dots: { ref: LaneRef; mesh: THREE.Mesh }[] = [];
	private hoveredRef: LaneRef | null = null;
	private dragTargetRef: LaneRef | null = null;
	private dragValid = false;
	private activeMaterial: THREE.MeshBasicMaterial;
	private handleMaterial: THREE.MeshBasicMaterial;
	private hoverMaterial: THREE.MeshBasicMaterial;
	private validMaterial: THREE.MeshBasicMaterial;
	private invalidMaterial: THREE.MeshBasicMaterial;
	private rubberMaterial: THREE.MeshBasicMaterial;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
		const dot = (color: number) =>
			new THREE.MeshBasicMaterial({
				color,
				transparent: true,
				depthTest: false,
				depthWrite: false
			});
		this.activeMaterial = new THREE.MeshBasicMaterial({
			color: ACTIVE_COLOR,
			transparent: true,
			opacity: 0.95,
			side: THREE.DoubleSide,
			depthTest: false,
			depthWrite: false
		});
		this.handleMaterial = dot(HANDLE_COLOR);
		this.hoverMaterial = dot(HOVER_COLOR);
		this.validMaterial = dot(VALID_COLOR);
		this.invalidMaterial = dot(INVALID_COLOR);
		this.rubberMaterial = new THREE.MeshBasicMaterial({
			color: RUBBER_COLOR,
			transparent: true,
			opacity: 0.95,
			side: THREE.DoubleSide,
			depthTest: false,
			depthWrite: false
		});
	}

	show(connections: LaneConnection[], endpoints: LaneEndpoint[]) {
		this.clear();
		if (connections.length === 0 && endpoints.length === 0) return;

		const arcGroup = new THREE.Group();
		for (const c of connections) {
			if (!c.active) continue; // blocked movements simply aren't drawn
			const mesh = new THREE.Mesh(arcRibbon(c), this.activeMaterial);
			mesh.renderOrder = ARC_ORDER;
			arcGroup.add(mesh);
		}
		this.scene.add(arcGroup);
		this.arcGroup = arcGroup;

		const dotGroup = new THREE.Group();
		for (const endpoint of endpoints) {
			// Filled disc = incoming (drag from here), hollow ring = outgoing.
			const geometry =
				endpoint.flow === 'in'
					? new THREE.CircleGeometry(DOT_RADIUS, DOT_SEGMENTS)
					: new THREE.RingGeometry(RING_INNER, DOT_RADIUS, DOT_SEGMENTS);
			const mesh = new THREE.Mesh(geometry, this.handleMaterial);
			mesh.rotation.x = -Math.PI / 2;
			mesh.position.set(endpoint.point.x, DOT_Y, endpoint.point.y);
			mesh.renderOrder = DOT_ORDER;
			dotGroup.add(mesh);
			this.dots.push({ ref: endpoint.ref, mesh });
		}
		this.scene.add(dotGroup);
		this.dotGroup = dotGroup;
		this.applyDotStates();
	}

	// Highlight an incoming dot under the cursor (blue, enlarged); pass null to
	// clear. Used when not dragging.
	setHovered(ref: LaneRef | null) {
		this.hoveredRef = ref;
		this.dragTargetRef = null;
		this.applyDotStates();
	}

	// While dragging from `sourceRef`, mark the dot under the cursor green (valid
	// exit) or red (invalid).
	setDragFeedback(sourceRef: LaneRef, targetRef: LaneRef | null, valid: boolean) {
		this.hoveredRef = sourceRef;
		this.dragTargetRef = targetRef;
		this.dragValid = valid;
		this.applyDotStates();
	}

	private applyDotStates() {
		for (const dot of this.dots) {
			let material = this.handleMaterial;
			let scale = 1;
			if (this.dragTargetRef && sameLaneRef(dot.ref, this.dragTargetRef)) {
				material = this.dragValid ? this.validMaterial : this.invalidMaterial;
				scale = HOVER_SCALE;
			} else if (this.hoveredRef && sameLaneRef(dot.ref, this.hoveredRef)) {
				material = this.hoverMaterial;
				scale = HOVER_SCALE;
			}
			dot.mesh.material = material;
			dot.mesh.scale.setScalar(scale);
		}
	}

	showRubberBand(
		from: { x: number; y: number },
		to: { x: number; y: number },
		state: RubberState = 'neutral'
	) {
		this.hideRubberBand();
		this.rubberMaterial.color.setHex(
			state === 'valid' ? VALID_COLOR : state === 'invalid' ? INVALID_COLOR : RUBBER_COLOR
		);
		const mesh = new THREE.Mesh(dashedRibbon([from, to], ARC_WIDTH, DOT_Y), this.rubberMaterial);
		mesh.renderOrder = RUBBER_ORDER;
		this.scene.add(mesh);
		this.rubber = mesh;
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
		this.dragTargetRef = null;
		for (const g of [this.dotGroup, this.arcGroup]) {
			if (!g) continue;
			g.traverse((o) => {
				if (o instanceof THREE.Mesh) o.geometry.dispose();
			});
			this.scene.remove(g);
		}
		this.dotGroup = null;
		this.arcGroup = null;
	}

	dispose() {
		this.clear();
		this.activeMaterial.dispose();
		this.handleMaterial.dispose();
		this.hoverMaterial.dispose();
		this.validMaterial.dispose();
		this.invalidMaterial.dispose();
		this.rubberMaterial.dispose();
	}
}
