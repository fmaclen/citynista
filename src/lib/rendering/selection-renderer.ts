import * as THREE from 'three';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';

// Cities-Skylines-style highlights: segments get a translucent full-width
// ribbon in the interaction accent, hover is a fainter version of selection.
// White marks grabbable things — the bezier guides and curvature handle.
const ACCENT_COLOR = 0x4a9eff;
const SELECT_OPACITY = 0.35;
const HOVER_OPACITY = 0.18;
const GUIDE_COLOR = 0xffffff;
const GUIDE_OPACITY = 0.6;
const CONTROL_COLOR = 0xffffff;
const CONTROL_SIZE = 4.5;
const CURVE_SAMPLES = 50;
const RIBBON_MARGIN = 1;
const HOVER_Y = 0.16;
const SELECT_Y = 0.17;
const GUIDE_Y = 0.21;
const CONTROL_Y = 0.22;

interface SegmentVisual {
	group: THREE.Group;
	ribbon: THREE.Mesh;
	handles: THREE.Line;
	control: THREE.Mesh;
}

function buildRibbonGeometry(segment: Segment, startNode: Node, endNode: Node, y: number) {
	const halfWidth = segment.totalWidth / 2 + RIBBON_MARGIN;
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

export class SelectionRenderer {
	private scene: THREE.Scene;
	private visuals = new Map<string, SegmentVisual>();
	private hoverRibbon: THREE.Mesh | null = null;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	showHover(segment: Segment, startNode: Node, endNode: Node) {
		if (!this.hoverRibbon) {
			this.hoverRibbon = new THREE.Mesh(
				new THREE.BufferGeometry(),
				new THREE.MeshBasicMaterial({
					color: ACCENT_COLOR,
					transparent: true,
					opacity: HOVER_OPACITY,
					side: THREE.DoubleSide
				})
			);
			this.scene.add(this.hoverRibbon);
		}

		this.hoverRibbon.geometry.dispose();
		this.hoverRibbon.geometry = buildRibbonGeometry(segment, startNode, endNode, HOVER_Y);
		this.hoverRibbon.visible = true;
	}

	hideHover() {
		if (this.hoverRibbon) {
			this.hoverRibbon.visible = false;
		}
	}

	showSegment(segment: Segment, startNode: Node, endNode: Node) {
		let visual = this.visuals.get(segment.id);

		if (!visual) {
			const ribbon = new THREE.Mesh(
				new THREE.BufferGeometry(),
				new THREE.MeshBasicMaterial({
					color: ACCENT_COLOR,
					transparent: true,
					opacity: SELECT_OPACITY,
					side: THREE.DoubleSide
				})
			);

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
			group.add(ribbon);
			group.add(handles);
			group.add(control);
			this.scene.add(group);

			visual = { group, ribbon, handles, control };
			this.visuals.set(segment.id, visual);
		}

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

		visual.ribbon.geometry.dispose();
		visual.ribbon.geometry = buildRibbonGeometry(segment, startNode, endNode, SELECT_Y);

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

		visual.ribbon.geometry.dispose();
		(visual.ribbon.material as THREE.Material).dispose();
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
