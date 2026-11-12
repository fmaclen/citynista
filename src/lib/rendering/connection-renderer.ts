import * as THREE from 'three';
import type { LaneConnection } from '../core/lane-connections';
import { sameLaneRef } from '../core/lane-connections';
import type { LaneRef } from '../core/types';
import { editorLineGeometry, createEditorLineMaterial } from './editor-line';
import {
	DANGER_COLOR,
	HANDLE_FILL,
	HOVER_COLOR,
	LANE_DOT_MAX_RADIUS,
	LANE_DOT_PX,
	VALID_COLOR,
	type HandleState
} from './editor-palette';
import {
	disposeHandleObject,
	dotShape,
	handleObject,
	setHandleState,
	type ScreenSized
} from './handle-shapes';

// Lane connectors drawn above everything in connector mode: every allowed
// movement is a beaded editor line (see editor-line.ts), plus a dot at each lane
// mouth — a filled disc where traffic enters the node (drag from here), a hollow
// ring where it leaves (a passive target). Both are handles (see
// handle-shapes.ts), sized on screen up to LANE_DOT_MAX_RADIUS. The hovered
// dot and its movements turn the hover colour; while dragging, the dot under
// the cursor turns green on a valid exit, red on an invalid one.
const CONNECTION_Y = 0.3;
const DOT_Y = 0.31;
const RING_INNER = 0.55;
const HOVER_SCALE = 1.35;
const ARC_SAMPLES = 30;
const ARC_ORDER = 4;
const RUBBER_ORDER = 5;
const DOT_ORDER = 9;

type RubberState = 'neutral' | 'valid' | 'invalid';

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const u = 1 - t;
	return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function arcGeometry(c: LaneConnection): THREE.BufferGeometry {
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
	return editorLineGeometry(curve, CONNECTION_Y);
}

export class ConnectionRenderer {
	private scene: THREE.Scene;
	private dotGroup: THREE.Group | null = null;
	private arcGroup: THREE.Group | null = null;
	private rubber: THREE.Mesh | null = null;
	private screenSized: ScreenSized;
	// Each dot: its screen-sized group, which grows on hover and is tinted
	// for its state.
	private dots: { ref: LaneRef; group: THREE.Group }[] = [];
	private arcs: { connection: LaneConnection; mesh: THREE.Mesh }[] = [];
	private hoveredRef: LaneRef | null = null;
	private dragTargetRef: LaneRef | null = null;
	private dragValid = false;
	private activeMaterial = createEditorLineMaterial(HANDLE_FILL);
	private highlightArcMaterial = createEditorLineMaterial(HOVER_COLOR);
	private rubberMaterial = createEditorLineMaterial(HANDLE_FILL);

	constructor(scene: THREE.Scene, screenSized: ScreenSized) {
		this.scene = scene;
		this.screenSized = screenSized;
	}

	show(
		connections: LaneConnection[],
		endpoints: { ref: LaneRef; point: { x: number; y: number }; flow: 'in' | 'out' | 'both' }[]
	) {
		this.clear();
		if (connections.length === 0 && endpoints.length === 0) return;

		const arcGroup = new THREE.Group();
		for (const c of connections) {
			if (!c.active) continue; // blocked movements simply aren't drawn
			const mesh = new THREE.Mesh(arcGeometry(c), this.activeMaterial);
			mesh.renderOrder = ARC_ORDER;
			arcGroup.add(mesh);
			this.arcs.push({ connection: c, mesh });
		}
		this.scene.add(arcGroup);
		this.arcGroup = arcGroup;

		const dotGroup = new THREE.Group();
		for (const endpoint of endpoints) {
			// Filled disc = incoming or either way (drag from here), hollow ring =
			// outgoing.
			const shape = dotShape(LANE_DOT_PX, endpoint.flow !== 'out' ? 0 : LANE_DOT_PX * RING_INNER);
			const group = handleObject(shape, endpoint.point, { x: 1, y: 0 }, DOT_Y, DOT_ORDER);
			this.screenSized.set(group, LANE_DOT_MAX_RADIUS / LANE_DOT_PX);
			dotGroup.add(group);
			this.dots.push({ ref: endpoint.ref, group });
		}
		this.scene.add(dotGroup);
		this.dotGroup = dotGroup;
		this.applyDotStates();
	}

	// Highlight an incoming dot under the cursor (hover tint, enlarged); pass null to
	// clear. Used when not dragging.
	setHovered(ref: LaneRef | null) {
		this.hoveredRef = ref;
		this.dragTargetRef = null;
		this.applyDotStates();
		this.applyArcStates();
	}

	// Movements that start or end at the hovered dot light up in the hover colour.
	private applyArcStates() {
		for (const arc of this.arcs) {
			const lit =
				this.hoveredRef !== null &&
				(sameLaneRef(arc.connection.from, this.hoveredRef) ||
					sameLaneRef(arc.connection.to, this.hoveredRef));
			arc.mesh.material = lit ? this.highlightArcMaterial : this.activeMaterial;
		}
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
			let state: HandleState = 'rest';
			let scale = 1;
			if (this.dragTargetRef && sameLaneRef(dot.ref, this.dragTargetRef)) {
				state = this.dragValid ? 'valid' : 'danger';
				scale = HOVER_SCALE;
			} else if (this.hoveredRef && sameLaneRef(dot.ref, this.hoveredRef)) {
				state = 'hover';
				scale = HOVER_SCALE;
			}
			setHandleState(dot.group, state);
			for (const mesh of dot.group.children) mesh.scale.setScalar(scale);
		}
	}

	showRubberBand(
		from: { x: number; y: number },
		to: { x: number; y: number },
		state: RubberState = 'neutral'
	) {
		this.hideRubberBand();
		this.rubberMaterial.color.setHex(
			state === 'valid' ? VALID_COLOR : state === 'invalid' ? DANGER_COLOR : HANDLE_FILL
		);
		const mesh = new THREE.Mesh(editorLineGeometry([from, to], DOT_Y), this.rubberMaterial);
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
		for (const dot of this.dots) this.screenSized.delete(dot.group);
		this.dots = [];
		this.arcs = [];
		this.hoveredRef = null;
		this.dragTargetRef = null;
		for (const g of [this.dotGroup, this.arcGroup]) {
			if (!g) continue;
			disposeHandleObject(g);
			this.scene.remove(g);
		}
		this.dotGroup = null;
		this.arcGroup = null;
	}

	dispose() {
		this.clear();
		this.activeMaterial.dispose();
		this.highlightArcMaterial.dispose();
		this.rubberMaterial.dispose();
	}
}
