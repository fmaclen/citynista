import * as THREE from 'three';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { getQuadraticBezierPoint } from '../geometry/bezier';

const PATH_COLOR = 0x4a9eff;
const CONTROL_COLOR = 0xff6b6b;
const HANDLE_COLOR = 0xffffff;
const CURVE_SAMPLES = 50;
const PATH_Y = 0.18;
const HOVER_Y = 0.17;
const CONTROL_Y = 0.22;
const CONTROL_RADIUS = 4;
const HOVER_OPACITY = 0.5;

interface SegmentVisual {
	group: THREE.Group;
	path: THREE.Line;
	handles: THREE.Line;
	control: THREE.Mesh;
}

export class SelectionRenderer {
	private scene: THREE.Scene;
	private visuals = new Map<string, SegmentVisual>();
	private hoverPath: THREE.Line | null = null;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	private pathPoints(segment: Segment, startNode: Node, endNode: Node, y: number) {
		const points: THREE.Vector3[] = [];
		if (segment.hasControlPoint) {
			for (let i = 0; i <= CURVE_SAMPLES; i++) {
				const point = getQuadraticBezierPoint(
					startNode.x,
					startNode.y,
					segment.controlX!,
					segment.controlY!,
					endNode.x,
					endNode.y,
					i / CURVE_SAMPLES
				);
				points.push(new THREE.Vector3(point.x, y, point.y));
			}
		} else {
			points.push(new THREE.Vector3(startNode.x, y, startNode.y));
			points.push(new THREE.Vector3(endNode.x, y, endNode.y));
		}
		return points;
	}

	showHover(segment: Segment, startNode: Node, endNode: Node) {
		if (!this.hoverPath) {
			this.hoverPath = new THREE.Line(
				new THREE.BufferGeometry(),
				new THREE.LineBasicMaterial({
					color: PATH_COLOR,
					transparent: true,
					opacity: HOVER_OPACITY
				})
			);
			this.scene.add(this.hoverPath);
		}

		this.hoverPath.geometry.dispose();
		this.hoverPath.geometry = new THREE.BufferGeometry().setFromPoints(
			this.pathPoints(segment, startNode, endNode, HOVER_Y)
		);
		this.hoverPath.visible = true;
	}

	hideHover() {
		if (this.hoverPath) {
			this.hoverPath.visible = false;
		}
	}

	showSegment(segment: Segment, startNode: Node, endNode: Node) {
		let visual = this.visuals.get(segment.id);

		if (!visual) {
			const path = new THREE.Line(
				new THREE.BufferGeometry(),
				new THREE.LineBasicMaterial({ color: PATH_COLOR })
			);

			const handles = new THREE.Line(
				new THREE.BufferGeometry(),
				new THREE.LineDashedMaterial({
					color: HANDLE_COLOR,
					transparent: true,
					opacity: 0.6,
					dashSize: 3,
					gapSize: 2
				})
			);

			const control = new THREE.Mesh(
				new THREE.CircleGeometry(CONTROL_RADIUS, 24),
				new THREE.MeshBasicMaterial({ color: CONTROL_COLOR })
			);
			control.rotation.x = -Math.PI / 2;
			control.userData = { type: 'controlPoint', segmentId: segment.id };

			const group = new THREE.Group();
			group.add(path);
			group.add(handles);
			group.add(control);
			this.scene.add(group);

			visual = { group, path, handles, control };
			this.visuals.set(segment.id, visual);
		}

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

		visual.path.geometry.dispose();
		visual.path.geometry = new THREE.BufferGeometry().setFromPoints(
			this.pathPoints(segment, startNode, endNode, PATH_Y)
		);

		visual.handles.geometry.dispose();
		visual.handles.geometry = new THREE.BufferGeometry().setFromPoints([
			new THREE.Vector3(startNode.x, PATH_Y, startNode.y),
			new THREE.Vector3(cx, PATH_Y, cy),
			new THREE.Vector3(endNode.x, PATH_Y, endNode.y)
		]);
		visual.handles.computeLineDistances();

		visual.control.position.set(cx, CONTROL_Y, cy);
	}

	hideSegment(segmentId: string) {
		const visual = this.visuals.get(segmentId);
		if (!visual) return;

		visual.path.geometry.dispose();
		(visual.path.material as THREE.Material).dispose();
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
