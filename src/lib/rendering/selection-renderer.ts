import * as THREE from 'three';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';

// Cities-Skylines-style highlights: a translucent full-width ribbon with
// round end caps sized to the node rings, wrapped in a solid stroke. Blue
// means hover, yellow means selected — everywhere in the editor. Fill
// pieces share one elevation, write depth, and use LessDepth so overlaps
// (caps over the ribbon, neighboring selections over a shared node) render
// exactly once; strokes render after all fills and survive only outside
// them, which outlines the union of the highlighted area without any
// boundary math.
const HOVER_COLOR = 0x4a9eff;
const SELECT_COLOR = 0xfacc15;
const SELECT_OPACITY = 0.18;
const HOVER_OPACITY = 0.12;
const STROKE_WIDTH = 1.2;
const STROKE_OPACITY = 0.85;
const FILL_RENDER_ORDER = 1;
const STROKE_RENDER_ORDER = 2;
const GUIDE_COLOR = 0xfacc15;
const GUIDE_OPACITY = 0.7;
const CONTROL_COLOR = 0xfacc15;
const CONTROL_SIZE = 4.5;
const CURVE_SAMPLES = 50;
const CAP_SEGMENTS = 48;
const RIBBON_MARGIN = 1;
const HOVER_Y = 0.16;
const SELECT_Y = 0.17;
const GUIDE_Y = 0.21;
const CONTROL_Y = 0.22;

interface Highlight {
	ribbon: THREE.Mesh;
	startCap: THREE.Mesh;
	endCap: THREE.Mesh;
	material: THREE.MeshBasicMaterial;
}

interface SegmentVisual {
	group: THREE.Group;
	fill: Highlight;
	stroke: Highlight;
	handles: THREE.Line;
	control: THREE.Mesh;
}

function buildRibbonGeometry(
	segment: Segment,
	startNode: Node,
	endNode: Node,
	halfWidth: number,
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

		positions[i * 6] = point.x + nx * halfWidth;
		positions[i * 6 + 1] = y;
		positions[i * 6 + 2] = point.y + ny * halfWidth;
		positions[i * 6 + 3] = point.x - nx * halfWidth;
		positions[i * 6 + 4] = y;
		positions[i * 6 + 5] = point.y - ny * halfWidth;
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

function createHighlight(color: number, opacity: number, renderOrder: number): Highlight {
	const material = new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity,
		depthWrite: true,
		// Equal-depth fragments are discarded, so same-elevation overlaps
		// within the highlight never double-blend.
		depthFunc: THREE.LessDepth,
		side: THREE.DoubleSide
	});

	const ribbon = new THREE.Mesh(new THREE.BufferGeometry(), material);
	const startCap = new THREE.Mesh(new THREE.BufferGeometry(), material);
	const endCap = new THREE.Mesh(new THREE.BufferGeometry(), material);
	startCap.rotation.x = -Math.PI / 2;
	endCap.rotation.x = -Math.PI / 2;
	for (const mesh of [ribbon, startCap, endCap]) {
		mesh.renderOrder = renderOrder;
	}

	return { ribbon, startCap, endCap, material };
}

function updateHighlight(
	highlight: Highlight,
	segment: Segment,
	startNode: Node,
	endNode: Node,
	startRadius: number,
	endRadius: number,
	y: number,
	outset: number
) {
	const halfWidth = segment.totalWidth / 2 + RIBBON_MARGIN + outset;

	highlight.ribbon.geometry.dispose();
	highlight.ribbon.geometry = buildRibbonGeometry(segment, startNode, endNode, halfWidth, y);

	highlight.startCap.geometry.dispose();
	highlight.startCap.geometry = new THREE.CircleGeometry(startRadius + outset, CAP_SEGMENTS);
	highlight.startCap.position.set(startNode.x, y, startNode.y);

	highlight.endCap.geometry.dispose();
	highlight.endCap.geometry = new THREE.CircleGeometry(endRadius + outset, CAP_SEGMENTS);
	highlight.endCap.position.set(endNode.x, y, endNode.y);
}

function disposeHighlight(highlight: Highlight) {
	highlight.ribbon.geometry.dispose();
	highlight.startCap.geometry.dispose();
	highlight.endCap.geometry.dispose();
	highlight.material.dispose();
}

export class SelectionRenderer {
	private scene: THREE.Scene;
	private visuals = new Map<string, SegmentVisual>();
	private hover: Highlight | null = null;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	showHover(
		segment: Segment,
		startNode: Node,
		endNode: Node,
		startRadius: number,
		endRadius: number
	) {
		if (!this.hover) {
			this.hover = createHighlight(HOVER_COLOR, HOVER_OPACITY, 0);
			this.scene.add(this.hover.ribbon, this.hover.startCap, this.hover.endCap);
		}

		updateHighlight(this.hover, segment, startNode, endNode, startRadius, endRadius, HOVER_Y, 0);
		this.hover.ribbon.visible = true;
		this.hover.startCap.visible = true;
		this.hover.endCap.visible = true;
	}

	hideHover() {
		if (this.hover) {
			this.hover.ribbon.visible = false;
			this.hover.startCap.visible = false;
			this.hover.endCap.visible = false;
		}
	}

	showSegment(
		segment: Segment,
		startNode: Node,
		endNode: Node,
		startRadius: number,
		endRadius: number
	) {
		let visual = this.visuals.get(segment.id);

		if (!visual) {
			const fill = createHighlight(SELECT_COLOR, SELECT_OPACITY, FILL_RENDER_ORDER);
			const stroke = createHighlight(SELECT_COLOR, STROKE_OPACITY, STROKE_RENDER_ORDER);

			const handles = new THREE.Line(
				new THREE.BufferGeometry(),
				new THREE.LineDashedMaterial({
					color: GUIDE_COLOR,
					transparent: true,
					opacity: GUIDE_OPACITY,
					dashSize: 3,
					gapSize: 2
				})
			);

			const control = new THREE.Mesh(
				new THREE.PlaneGeometry(CONTROL_SIZE, CONTROL_SIZE),
				new THREE.MeshBasicMaterial({ color: CONTROL_COLOR })
			);
			control.rotation.x = -Math.PI / 2;
			control.rotation.z = Math.PI / 4;
			control.userData = { type: 'controlPoint', segmentId: segment.id };

			const group = new THREE.Group();
			group.add(fill.ribbon, fill.startCap, fill.endCap);
			group.add(stroke.ribbon, stroke.startCap, stroke.endCap);
			group.add(handles);
			group.add(control);
			this.scene.add(group);

			visual = { group, fill, stroke, handles, control };
			this.visuals.set(segment.id, visual);
		}

		updateHighlight(visual.fill, segment, startNode, endNode, startRadius, endRadius, SELECT_Y, 0);
		updateHighlight(
			visual.stroke,
			segment,
			startNode,
			endNode,
			startRadius,
			endRadius,
			SELECT_Y,
			STROKE_WIDTH
		);

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

		visual.handles.geometry.dispose();
		visual.handles.geometry = new THREE.BufferGeometry().setFromPoints([
			new THREE.Vector3(startNode.x, GUIDE_Y, startNode.y),
			new THREE.Vector3(cx, GUIDE_Y, cy),
			new THREE.Vector3(endNode.x, GUIDE_Y, endNode.y)
		]);
		visual.handles.computeLineDistances();

		visual.control.position.set(cx, CONTROL_Y, cy);
	}

	hideSegment(segmentId: string) {
		const visual = this.visuals.get(segmentId);
		if (!visual) return;

		disposeHighlight(visual.fill);
		disposeHighlight(visual.stroke);
		visual.handles.geometry.dispose();
		(visual.handles.material as THREE.Material).dispose();
		visual.control.geometry.dispose();
		(visual.control.material as THREE.Material).dispose();

		this.scene.remove(visual.group);
		this.visuals.delete(segmentId);
	}

	clear() {
		for (const segmentId of [...this.visuals.keys()]) {
			this.hideSegment(segmentId);
		}
	}
}
