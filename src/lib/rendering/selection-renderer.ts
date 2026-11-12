import * as THREE from 'three';
import type { Segment } from '../core/segment.svelte';
// Segment ends as drawn (an end attached at another road's edge moved
// there; see core/attach.ts).
interface Pt {
	x: number;
	y: number;
}
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';
import { editorLineGeometry, createEditorLineMaterial } from './editor-line';
import {
	HOVER_COLOR,
	SELECT_COLOR,
	DANGER_COLOR,
	HANDLE_FILL,
	type HandleState
} from './editor-palette';
import {
	CURVE_HANDLE,
	disposeHandleObject,
	handleObject,
	setHandleState,
	type ScreenSized
} from './handle-shapes';

// Segment highlights: a translucent full-width ribbon from node to node; the
// revealed node rings mark its ends (no end caps, which would double the tint
// where they overlap the ribbon). Hover, selection and delete-hover are the *same* highlight
// and differ only in color — cyan for hover, yellow for selection, red for
// delete. The fill sits just above the road and does not write depth, so it
// composites cleanly over the network at any camera tilt without z-fighting
// (an earlier LessDepth/depth-write trick relied on bit-equal coplanar depth,
// which the perspective + logarithmic depth buffer no longer guarantees).
// A selected road also shows its curvature handle: a square on the control
// point, on beaded guides from the road's ends (see handle-shapes.ts).
const HIGHLIGHT_OPACITY = 0.2;
const FILL_RENDER_ORDER = 1;
const GUIDE_RENDER_ORDER = 2;
const CONTROL_RENDER_ORDER = 8;
const CURVE_SAMPLES = 50;
const RIBBON_MARGIN = 1;
const HOVER_Y = 0.16;
const SELECT_Y = 0.17;
const GUIDE_Y = 0.21;
const CONTROL_Y = 0.22;
const LANE_Y = 0.18;
const LANE_OPACITY = 0.55;

interface Highlight {
	ribbon: THREE.Mesh;
	material: THREE.MeshBasicMaterial;
}

interface SegmentVisual {
	group: THREE.Group;
	fill: Highlight;
	lane: THREE.Mesh;
	handles: THREE.Mesh;
	control: THREE.Group;
}

// A point of the drawn line at t, moved by the segment's offset.
function shifted(segment: Segment, startNode: Pt, endNode: Pt, t: number) {
	const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
	const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;
	const p = getQuadraticBezierPoint(startNode.x, startNode.y, cx, cy, endNode.x, endNode.y, t);
	const d = getQuadraticBezierTangent(startNode.x, startNode.y, cx, cy, endNode.x, endNode.y, t);
	const l = Math.hypot(d.x, d.y) || 1;
	return { x: p.x - (d.y / l) * segment.offset, y: p.y + (d.x / l) * segment.offset };
}

// Where the curvature handle is drawn: the control point, moved by the
// road's offset (its normal half way along).
export function controlHandle(segment: Segment, startNode: Pt, endNode: Pt) {
	const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
	const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;
	const mid = shifted(segment, startNode, endNode, 0.5);
	const line = getQuadraticBezierPoint(startNode.x, startNode.y, cx, cy, endNode.x, endNode.y, 0.5);
	return { x: cx + mid.x - line.x, y: cy + mid.y - line.y };
}

function buildRibbonGeometry(
	segment: Segment,
	startNode: Pt,
	endNode: Pt,
	lo: number,
	hi: number,
	y: number
) {
	const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
	const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;
	const steps = segment.hasControlPoint ? CURVE_SAMPLES : 1;

	const positions = new Float32Array((steps + 1) * 6);
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const point = getQuadraticBezierPoint(
			startNode.x,
			startNode.y,
			cx,
			cy,
			endNode.x,
			endNode.y,
			t
		);
		const tangent = getQuadraticBezierTangent(
			startNode.x,
			startNode.y,
			cx,
			cy,
			endNode.x,
			endNode.y,
			t
		);
		const length = Math.hypot(tangent.x, tangent.y);
		const nx = length > 0.0001 ? -tangent.y / length : 0;
		const ny = length > 0.0001 ? tangent.x / length : 1;

		// Where the road is drawn: the line moved by the segment's offset.
		const px = point.x + nx * segment.offset;
		const py = point.y + ny * segment.offset;
		positions[i * 6] = px + nx * hi;
		positions[i * 6 + 1] = y;
		positions[i * 6 + 2] = py + ny * hi;
		positions[i * 6 + 3] = px + nx * lo;
		positions[i * 6 + 4] = y;
		positions[i * 6 + 5] = py + ny * lo;
	}

	const indices: number[] = [];
	for (let i = 0; i < steps; i++) {
		const a = i * 2;
		indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setIndex(indices);
	return geometry;
}

function createHighlight(color: number): Highlight {
	const material = new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity: HIGHLIGHT_OPACITY,
		// A transparent overlay over the road: skip depth entirely. The lane
		// layers now stack above this fill's Y, so depth-testing would let the
		// road occlude the highlight (it only peeked through at verges/gaps).
		// renderOrder keeps it beneath the guides and control handle.
		depthTest: false,
		depthWrite: false,
		side: THREE.DoubleSide
	});

	const ribbon = new THREE.Mesh(new THREE.BufferGeometry(), material);
	ribbon.renderOrder = FILL_RENDER_ORDER;

	return { ribbon, material };
}

function updateHighlight(
	highlight: Highlight,
	segment: Segment,
	startNode: Pt,
	endNode: Pt,
	y: number
) {
	const halfWidth = segment.totalWidth / 2 + RIBBON_MARGIN;

	highlight.ribbon.geometry.dispose();
	highlight.ribbon.geometry = buildRibbonGeometry(
		segment,
		startNode,
		endNode,
		-halfWidth,
		halfWidth,
		y
	);
}

function disposeHighlight(highlight: Highlight) {
	highlight.ribbon.geometry.dispose();
	highlight.material.dispose();
}

export class SelectionRenderer {
	private scene: THREE.Scene;
	private screenSized: ScreenSized;
	private visuals = new Map<string, SegmentVisual>();
	private hover: Highlight | null = null;
	private guideMaterial = createEditorLineMaterial(HANDLE_FILL);
	// The curvature handle under the pointer or in hand.
	private lit: { segmentId: string; state: HandleState } | null = null;
	// One lane of a selected road, lit while its row in the lane panel is hovered.
	private laneMaterial = new THREE.MeshBasicMaterial({
		color: HOVER_COLOR,
		transparent: true,
		opacity: LANE_OPACITY,
		depthTest: false,
		depthWrite: false,
		side: THREE.DoubleSide
	});

	constructor(scene: THREE.Scene, screenSized: ScreenSized) {
		this.scene = scene;
		this.screenSized = screenSized;
	}

	showHover(segment: Segment, startNode: Pt, endNode: Pt, danger = false) {
		if (!this.hover) {
			this.hover = createHighlight(HOVER_COLOR);
			this.scene.add(this.hover.ribbon);
		}

		this.hover.material.color.setHex(danger ? DANGER_COLOR : HOVER_COLOR);
		updateHighlight(this.hover, segment, startNode, endNode, HOVER_Y);
		this.hover.ribbon.visible = true;
	}

	hideHover() {
		if (this.hover) this.hover.ribbon.visible = false;
	}

	showSegment(segment: Segment, startNode: Pt, endNode: Pt, laneIndex: number | null = null) {
		let visual = this.visuals.get(segment.id);

		if (!visual) {
			const fill = createHighlight(SELECT_COLOR);

			const handles = new THREE.Mesh(new THREE.BufferGeometry(), this.guideMaterial);
			handles.renderOrder = GUIDE_RENDER_ORDER;

			const control = handleObject(
				CURVE_HANDLE,
				{ x: 0, y: 0 },
				{ x: 1, y: 0 },
				CONTROL_Y,
				CONTROL_RENDER_ORDER,
				this.lit?.segmentId === segment.id ? this.lit.state : 'rest'
			);
			this.screenSized.set(control, Infinity);

			const lane = new THREE.Mesh(new THREE.BufferGeometry(), this.laneMaterial);
			lane.renderOrder = FILL_RENDER_ORDER;

			const group = new THREE.Group();
			group.add(fill.ribbon);
			group.add(lane);
			group.add(handles);
			group.add(control);
			this.scene.add(group);

			visual = { group, fill, lane, handles, control };
			this.visuals.set(segment.id, visual);
		}

		updateHighlight(visual.fill, segment, startNode, endNode, SELECT_Y);

		// Lanes run left to right across the road as drawn, centred on it.
		const lit = laneIndex === null ? undefined : segment.lanes[laneIndex];
		visual.lane.visible = lit !== undefined;
		if (lit) {
			const lo =
				-segment.totalWidth / 2 +
				segment.lanes.slice(0, laneIndex ?? 0).reduce((sum, l) => sum + l.width, 0);
			visual.lane.geometry.dispose();
			visual.lane.geometry = buildRibbonGeometry(
				segment,
				startNode,
				endNode,
				lo,
				lo + lit.width,
				LANE_Y
			);
		}

		// The guides and the curvature handle move with the road's offset.
		const control = controlHandle(segment, startNode, endNode);
		visual.handles.geometry.dispose();
		visual.handles.geometry = editorLineGeometry(
			[shifted(segment, startNode, endNode, 0), control, shifted(segment, startNode, endNode, 1)],
			GUIDE_Y
		);

		visual.control.position.set(control.x, CONTROL_Y, control.y);
	}

	// Tints one road's curvature handle for its state and the rest back to
	// rest; null for none.
	lightControl(segmentId: string | null, state: HandleState = 'hover') {
		this.lit = segmentId === null ? null : { segmentId, state };
		for (const [id, visual] of this.visuals) {
			setHandleState(visual.control, id === segmentId ? state : 'rest');
		}
	}

	hideSegment(segmentId: string) {
		const visual = this.visuals.get(segmentId);
		if (!visual) return;

		disposeHighlight(visual.fill);
		visual.lane.geometry.dispose();
		visual.handles.geometry.dispose();
		disposeHandleObject(visual.control);
		this.screenSized.delete(visual.control);

		this.scene.remove(visual.group);
		this.visuals.delete(segmentId);
	}

	clear() {
		for (const segmentId of [...this.visuals.keys()]) {
			this.hideSegment(segmentId);
		}
	}

	dispose() {
		this.clear();
		this.guideMaterial.dispose();
		this.laneMaterial.dispose();
	}
}
