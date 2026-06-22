import * as THREE from 'three';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';
import { editorLineGeometry, createEditorLineMaterial } from './editor-line';

// Segment highlights: a translucent full-width ribbon with round end caps sized
// to the node rings. Hover, selection and delete-hover are the *same* highlight
// and differ only in color — blue for hover, yellow for selection, red for
// delete. The fill sits just above the road and does not write depth, so it
// composites cleanly over the network at any camera tilt without z-fighting
// (an earlier LessDepth/depth-write trick relied on bit-equal coplanar depth,
// which the perspective + logarithmic depth buffer no longer guarantees).
const HOVER_COLOR = 0x4a9eff;
const DANGER_COLOR = 0xef4444;
const SELECT_COLOR = 0xfacc15;
const HIGHLIGHT_OPACITY = 0.2;
const FILL_RENDER_ORDER = 1;
const GUIDE_RENDER_ORDER = 2;
const CONTROL_RENDER_ORDER = 3;
const CONTROL_COLOR = 0xfacc15;
export const CONTROL_SIZE = 4.5;
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
	handles: THREE.Mesh;
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

function createHighlight(color: number): Highlight {
	const material = new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity: HIGHLIGHT_OPACITY,
		// A transparent overlay above the road: don't write depth, so coplanar
		// pieces composite over the network without z-fighting.
		depthWrite: false,
		side: THREE.DoubleSide
	});

	const ribbon = new THREE.Mesh(new THREE.BufferGeometry(), material);
	const startCap = new THREE.Mesh(new THREE.BufferGeometry(), material);
	const endCap = new THREE.Mesh(new THREE.BufferGeometry(), material);
	startCap.rotation.x = -Math.PI / 2;
	endCap.rotation.x = -Math.PI / 2;
	for (const mesh of [ribbon, startCap, endCap]) {
		mesh.renderOrder = FILL_RENDER_ORDER;
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
	y: number
) {
	const halfWidth = segment.totalWidth / 2 + RIBBON_MARGIN;

	highlight.ribbon.geometry.dispose();
	highlight.ribbon.geometry = buildRibbonGeometry(segment, startNode, endNode, halfWidth, y);

	highlight.startCap.geometry.dispose();
	highlight.startCap.geometry = new THREE.CircleGeometry(startRadius, CAP_SEGMENTS);
	highlight.startCap.position.set(startNode.x, y, startNode.y);

	highlight.endCap.geometry.dispose();
	highlight.endCap.geometry = new THREE.CircleGeometry(endRadius, CAP_SEGMENTS);
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
		endRadius: number,
		danger = false
	) {
		if (!this.hover) {
			this.hover = createHighlight(HOVER_COLOR);
			this.scene.add(this.hover.ribbon, this.hover.startCap, this.hover.endCap);
		}

		this.hover.material.color.setHex(danger ? DANGER_COLOR : HOVER_COLOR);
		updateHighlight(this.hover, segment, startNode, endNode, startRadius, endRadius, HOVER_Y);
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
			const fill = createHighlight(SELECT_COLOR);

			const handles = new THREE.Mesh(new THREE.BufferGeometry(), createEditorLineMaterial());
			handles.renderOrder = GUIDE_RENDER_ORDER;

			const control = new THREE.Mesh(
				new THREE.PlaneGeometry(CONTROL_SIZE, CONTROL_SIZE),
				new THREE.MeshBasicMaterial({ color: CONTROL_COLOR, depthWrite: false })
			);
			control.rotation.x = -Math.PI / 2;
			control.rotation.z = Math.PI / 4;
			control.renderOrder = CONTROL_RENDER_ORDER;
			control.userData = { type: 'controlPoint', segmentId: segment.id };

			const group = new THREE.Group();
			group.add(fill.ribbon, fill.startCap, fill.endCap);
			group.add(handles);
			group.add(control);
			this.scene.add(group);

			visual = { group, fill, handles, control };
			this.visuals.set(segment.id, visual);
		}

		updateHighlight(visual.fill, segment, startNode, endNode, startRadius, endRadius, SELECT_Y);

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

		visual.handles.geometry.dispose();
		visual.handles.geometry = editorLineGeometry(
			[
				{ x: startNode.x, y: startNode.y },
				{ x: cx, y: cy },
				{ x: endNode.x, y: endNode.y }
			],
			GUIDE_Y
		);

		visual.control.position.set(cx, CONTROL_Y, cy);
	}

	hideSegment(segmentId: string) {
		const visual = this.visuals.get(segmentId);
		if (!visual) return;

		disposeHighlight(visual.fill);
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
