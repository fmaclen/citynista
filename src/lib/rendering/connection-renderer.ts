import * as THREE from 'three';
import type { LaneConnection, LaneEndpoint } from '../core/lane-connections';
import { sameLaneRef } from '../core/lane-connections';
import type { LaneRef } from '../core/types';

// Lane connectors drawn above everything in connector mode: a dot at each lane
// mouth — a filled disc where traffic enters the node, a hollow ring where it
// leaves. Hovering a dot reveals just that lane's movements (so a busy junction
// isn't a tangle of every arc at once); drag between an in dot and an out dot to
// toggle a movement. Everything reads as "editor mode": dots follow the editor
// palette (yellow = handle, blue = hover) and arcs are thick dashed ribbons
// (allowed = yellow, blocked = white 50%) so they're never mistaken for paint.
const CONNECTION_Y = 0.3;
const DOT_Y = 0.31;
const HANDLE_COLOR = 0xfacc15;
const HOVER_COLOR = 0x4a9eff;
const ACTIVE_COLOR = 0xfacc15;
const DISABLED_COLOR = 0xffffff;
const RUBBER_COLOR = 0xfacc15;
const DOT_RADIUS = 1.2;
const RING_INNER = 0.62;
const DOT_SEGMENTS = 20;
const HOVER_SCALE = 1.35;
// Arcs are ~half a dot wide and dashed, so an editor line is obvious next to
// the (thin, solid) road markings.
const ARC_WIDTH = 0.7;
const ARC_DASH = 1.6;
const ARC_GAP = 1.3;
const ARC_SAMPLES = 30;
const RENDER_ORDER = 4;

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const u = 1 - t;
	return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// A dashed flat ribbon along a polyline (XZ plane at height y): emit a quad per
// polyline segment whose arc-length midpoint lands in a dash, skip the gaps.
function dashedRibbon(
	curve: { x: number; y: number }[],
	width: number,
	y: number
): THREE.BufferGeometry {
	const positions: number[] = [];
	const half = width / 2;
	let acc = 0;
	for (let i = 0; i < curve.length - 1; i++) {
		const a = curve[i];
		const b = curve[i + 1];
		const dx = b.x - a.x;
		const dz = b.y - a.y;
		const len = Math.hypot(dx, dz);
		if (len < 1e-6) continue;
		const mid = acc + len / 2;
		acc += len;
		if (mid % (ARC_DASH + ARC_GAP) >= ARC_DASH) continue;
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
	private connections: LaneConnection[] = [];
	private dots: { ref: LaneRef; mesh: THREE.Mesh }[] = [];
	private hoveredRef: LaneRef | null = null;
	private activeMaterial: THREE.MeshBasicMaterial;
	private disabledMaterial: THREE.MeshBasicMaterial;
	private handleMaterial: THREE.MeshBasicMaterial;
	private hoverMaterial: THREE.MeshBasicMaterial;
	private rubberMaterial: THREE.MeshBasicMaterial;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
		this.activeMaterial = new THREE.MeshBasicMaterial({
			color: ACTIVE_COLOR,
			transparent: true,
			opacity: 0.95,
			side: THREE.DoubleSide,
			depthWrite: false
		});
		this.disabledMaterial = new THREE.MeshBasicMaterial({
			color: DISABLED_COLOR,
			transparent: true,
			opacity: 0.5,
			side: THREE.DoubleSide,
			depthWrite: false
		});
		this.handleMaterial = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthWrite: false });
		this.hoverMaterial = new THREE.MeshBasicMaterial({ color: HOVER_COLOR, depthWrite: false });
		this.rubberMaterial = new THREE.MeshBasicMaterial({
			color: RUBBER_COLOR,
			transparent: true,
			opacity: 0.95,
			side: THREE.DoubleSide,
			depthWrite: false
		});
	}

	show(connections: LaneConnection[], endpoints: LaneEndpoint[]) {
		this.clear();
		this.connections = connections;
		if (endpoints.length === 0) return;

		const group = new THREE.Group();
		group.renderOrder = RENDER_ORDER;
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
		this.dotGroup = group;
	}

	// Highlight the dot under the cursor (blue, enlarged) and reveal its
	// movements; pass null to clear.
	setHovered(ref: LaneRef | null) {
		const changed =
			(this.hoveredRef === null) !== (ref === null) ||
			(this.hoveredRef !== null && ref !== null && !sameLaneRef(this.hoveredRef, ref));
		if (!changed) return;
		this.hoveredRef = ref;
		for (const dot of this.dots) {
			const hovered = ref !== null && sameLaneRef(dot.ref, ref);
			dot.mesh.material = hovered ? this.hoverMaterial : this.handleMaterial;
			dot.mesh.scale.setScalar(hovered ? HOVER_SCALE : 1);
		}
		this.rebuildArcs();
	}

	private rebuildArcs() {
		if (this.arcGroup) {
			this.arcGroup.traverse((o) => {
				if (o instanceof THREE.Mesh) o.geometry.dispose();
			});
			this.scene.remove(this.arcGroup);
			this.arcGroup = null;
		}
		const ref = this.hoveredRef;
		if (!ref) return;

		const group = new THREE.Group();
		group.renderOrder = RENDER_ORDER;
		for (const c of this.connections) {
			if (!sameLaneRef(c.from, ref) && !sameLaneRef(c.to, ref)) continue;
			const mesh = new THREE.Mesh(
				arcRibbon(c),
				c.active ? this.activeMaterial : this.disabledMaterial
			);
			group.add(mesh);
		}
		this.scene.add(group);
		this.arcGroup = group;
	}

	showRubberBand(from: { x: number; y: number }, to: { x: number; y: number }) {
		this.hideRubberBand();
		// Subdivide so the dash pattern shows along the straight band.
		const len = Math.hypot(to.x - from.x, to.y - from.y);
		const steps = Math.max(2, Math.ceil(len / 0.5));
		const curve: { x: number; y: number }[] = [];
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			curve.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
		}
		const mesh = new THREE.Mesh(dashedRibbon(curve, ARC_WIDTH, DOT_Y), this.rubberMaterial);
		mesh.renderOrder = RENDER_ORDER + 2;
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
		this.connections = [];
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
		this.disabledMaterial.dispose();
		this.handleMaterial.dispose();
		this.hoverMaterial.dispose();
		this.rubberMaterial.dispose();
	}
}
