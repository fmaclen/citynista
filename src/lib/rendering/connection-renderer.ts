import * as THREE from 'three';
import type { LaneConnection, LaneEndpoint } from '../core/lane-connections';

// Lane connectors drawn above everything when a node is selected: one bezier
// per movement (bright = allowed, faint = disabled), plus a dot at each lane
// endpoint — drag from an incoming dot to an outgoing dot to route a movement.
// A throwaway-cheap overlay, rebuilt on each selection.
const CONNECTION_Y = 0.3;
const DOT_Y = 0.31;
const ACTIVE_COLOR = 0x22d3ee;
const ACTIVE_OPACITY = 0.95;
const DISABLED_COLOR = 0xcbd5e1;
const DISABLED_OPACITY = 0.5;
const SOURCE_COLOR = 0x22d3ee;
const TARGET_COLOR = 0xf8fafc;
const RUBBER_COLOR = 0xfacc15;
const DOT_RADIUS = 1.2;
const DOT_SEGMENTS = 16;
const RENDER_ORDER = 4;
const SAMPLES = 18;

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const u = 1 - t;
	return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export class ConnectionRenderer {
	private scene: THREE.Scene;
	private group: THREE.Group | null = null;
	private rubber: THREE.Line | null = null;
	private activeMaterial: THREE.LineBasicMaterial;
	private disabledMaterial: THREE.LineBasicMaterial;
	private sourceMaterial: THREE.MeshBasicMaterial;
	private targetMaterial: THREE.MeshBasicMaterial;
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
		this.sourceMaterial = new THREE.MeshBasicMaterial({
			color: SOURCE_COLOR,
			depthWrite: false
		});
		this.targetMaterial = new THREE.MeshBasicMaterial({
			color: TARGET_COLOR,
			depthWrite: false
		});
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
			const dot = new THREE.Mesh(
				new THREE.CircleGeometry(DOT_RADIUS, DOT_SEGMENTS),
				endpoint.flow === 'in' ? this.sourceMaterial : this.targetMaterial
			);
			dot.rotation.x = -Math.PI / 2;
			dot.position.set(endpoint.point.x, DOT_Y, endpoint.point.y);
			group.add(dot);
		}

		this.scene.add(group);
		this.group = group;
	}

	showRubberBand(from: { x: number; y: number }, to: { x: number; y: number }) {
		this.hideRubberBand();
		const geometry = new THREE.BufferGeometry().setFromPoints([
			new THREE.Vector3(from.x, DOT_Y, from.y),
			new THREE.Vector3(to.x, DOT_Y, to.y)
		]);
		const line = new THREE.Line(geometry, this.rubberMaterial);
		line.renderOrder = RENDER_ORDER + 1;
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
		this.sourceMaterial.dispose();
		this.targetMaterial.dispose();
		this.rubberMaterial.dispose();
	}
}
