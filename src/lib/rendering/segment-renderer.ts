import * as THREE from 'three';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { getQuadraticBezierPoint } from '../geometry/bezier';

const SEGMENT_COLOR = 0xcccccc;
const SEGMENT_SELECTED_COLOR = 0x4a9eff;
const SEGMENT_WIDTH = 3;
const CURVE_SEGMENTS = 50;

const CONTROL_POINT_RADIUS = 5;
const CONTROL_POINT_COLOR = 0xff6b6b;

export class SegmentRenderer {
	private scene: THREE.Scene;
	private meshes = new Map<string, THREE.Line>();
	private controlPoints = new Map<string, THREE.Mesh>();
	private selectedSegments = new Set<string>();

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	createSegment(segment: Segment, startNode: Node, endNode: Node) {
		const points = this.getSegmentPoints(segment, startNode, endNode);
		const geometry = new THREE.BufferGeometry().setFromPoints(points);
		const material = new THREE.LineBasicMaterial({
			color: SEGMENT_COLOR,
			linewidth: SEGMENT_WIDTH
		});
		const line = new THREE.Line(geometry, material);
		line.userData = { type: 'segment', id: segment.id };

		this.scene.add(line);
		this.meshes.set(segment.id, line);

		return line;
	}

	updateSegment(segment: Segment, startNode: Node, endNode: Node) {
		const line = this.meshes.get(segment.id);
		if (line) {
			const points = this.getSegmentPoints(segment, startNode, endNode);
			line.geometry.setFromPoints(points);
		}

		if (this.selectedSegments.has(segment.id)) {
			this.updateControlPoint(segment, startNode, endNode);
		}
	}

	private getSegmentPoints(segment: Segment, startNode: Node, endNode: Node): THREE.Vector3[] {
		const start = new THREE.Vector3(startNode.x, 0.05, startNode.y);
		const end = new THREE.Vector3(endNode.x, 0.05, endNode.y);

		if (!segment.hasControlPoint) {
			return [start, end];
		}

		const points: THREE.Vector3[] = [];
		for (let i = 0; i <= CURVE_SEGMENTS; i++) {
			const t = i / CURVE_SEGMENTS;
			const point = getQuadraticBezierPoint(
				startNode.x,
				startNode.y,
				segment.controlX!,
				segment.controlY!,
				endNode.x,
				endNode.y,
				t
			);
			points.push(new THREE.Vector3(point.x, 0.05, point.y));
		}
		return points;
	}

	removeSegment(segmentId: string) {
		const line = this.meshes.get(segmentId);
		if (line) {
			this.scene.remove(line);
			line.geometry.dispose();
			(line.material as THREE.Material).dispose();
			this.meshes.delete(segmentId);
		}
		this.removeControlPoint(segmentId);
		this.selectedSegments.delete(segmentId);
	}

	setSelected(
		segmentId: string,
		selected: boolean,
		segment?: Segment,
		startNode?: Node,
		endNode?: Node
	) {
		const line = this.meshes.get(segmentId);
		if (line) {
			const material = line.material as THREE.LineBasicMaterial;
			material.color.setHex(selected ? SEGMENT_SELECTED_COLOR : SEGMENT_COLOR);
		}

		if (selected) {
			this.selectedSegments.add(segmentId);
			if (segment && startNode && endNode) {
				this.showControlPoint(segment, startNode, endNode);
			}
		} else {
			this.selectedSegments.delete(segmentId);
			this.removeControlPoint(segmentId);
		}
	}

	private showControlPoint(segment: Segment, startNode: Node, endNode: Node) {
		let controlMesh = this.controlPoints.get(segment.id);

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

		if (!controlMesh) {
			const geometry = new THREE.CircleGeometry(CONTROL_POINT_RADIUS, 16);
			const material = new THREE.MeshBasicMaterial({ color: CONTROL_POINT_COLOR });
			controlMesh = new THREE.Mesh(geometry, material);
			controlMesh.rotation.x = -Math.PI / 2;
			controlMesh.userData = { type: 'controlPoint', segmentId: segment.id };
			this.scene.add(controlMesh);
			this.controlPoints.set(segment.id, controlMesh);
		}

		controlMesh.position.set(cx, 0.15, cy);
	}

	private updateControlPoint(segment: Segment, startNode: Node, endNode: Node) {
		const controlMesh = this.controlPoints.get(segment.id);
		if (controlMesh) {
			const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
			const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;
			controlMesh.position.set(cx, 0.15, cy);
		}
	}

	private removeControlPoint(segmentId: string) {
		const controlMesh = this.controlPoints.get(segmentId);
		if (controlMesh) {
			this.scene.remove(controlMesh);
			controlMesh.geometry.dispose();
			(controlMesh.material as THREE.Material).dispose();
			this.controlPoints.delete(segmentId);
		}
	}

	clearSelection() {
		for (const segmentId of this.selectedSegments) {
			const line = this.meshes.get(segmentId);
			if (line) {
				const material = line.material as THREE.LineBasicMaterial;
				material.color.setHex(SEGMENT_COLOR);
			}
			this.removeControlPoint(segmentId);
		}
		this.selectedSegments.clear();
	}

	clear() {
		for (const [segmentId] of this.meshes) {
			this.removeSegment(segmentId);
		}
	}

	getMesh(segmentId: string) {
		return this.meshes.get(segmentId);
	}

	getControlPointMesh(segmentId: string) {
		return this.controlPoints.get(segmentId);
	}
}
