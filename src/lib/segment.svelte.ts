import { Path, Circle, type Canvas } from 'fabric';
import { createPath, updatePathData } from './path-utils';
import type { Graph } from './graph.svelte';

export interface SegmentData {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX: number;
	controlY: number;
}

export class Segment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX = $state(0);
	controlY = $state(0);

	isSelected = $state(false);
	isDraft = $state(false);

	private path: Path | null = null;
	private startHandle: Circle | null = null;
	private endHandle: Circle | null = null;
	private bezierHandle: Circle | null = null;
	private canvas: Canvas;
	private graph: Graph;

	constructor(data: SegmentData, canvas: Canvas, graph: Graph) {
		this.id = data.id;
		this.startNodeId = data.startNodeId;
		this.endNodeId = data.endNodeId;
		this.controlX = data.controlX;
		this.controlY = data.controlY;
		this.canvas = canvas;
		this.graph = graph;

		this.updatePath();
	}

	updatePath() {
		const startNode = this.graph.nodes.get(this.startNodeId);
		const endNode = this.graph.nodes.get(this.endNodeId);

		if (!startNode || !endNode) return;

		const x1 = startNode.x;
		const y1 = startNode.y;
		const x2 = endNode.x;
		const y2 = endNode.y;

		if (!this.path) {
			this.path = createPath(x1, y1, x2, y2, this.controlX, this.controlY);
			this.canvas.add(this.path);
		} else {
			updatePathData(this.path, x1, y1, x2, y2, this.controlX, this.controlY);
		}
		this.canvas.renderAll();
	}

	showHandles() {
		const startNode = this.graph.nodes.get(this.startNodeId);
		const endNode = this.graph.nodes.get(this.endNodeId);
		if (!startNode || !endNode) return;

		if (!this.startHandle) {
			this.startHandle = new Circle({
				left: startNode.x,
				top: startNode.y,
				radius: 8,
				fill: 'rgba(255, 255, 255, 0.3)',
				stroke: '#ffffff',
				strokeWidth: 2,
				selectable: false,
				evented: false,
				originX: 'center',
				originY: 'center'
			});
			this.canvas.add(this.startHandle);
		}

		if (!this.endHandle) {
			this.endHandle = new Circle({
				left: endNode.x,
				top: endNode.y,
				radius: 8,
				fill: 'rgba(255, 255, 255, 0.3)',
				stroke: '#ffffff',
				strokeWidth: 2,
				selectable: false,
				evented: false,
				originX: 'center',
				originY: 'center'
			});
			this.canvas.add(this.endHandle);
		}

		if (!this.bezierHandle) {
			this.bezierHandle = new Circle({
				left: this.controlX,
				top: this.controlY,
				radius: 8,
				fill: 'rgba(66, 153, 225, 0.5)',
				stroke: '#4299E1',
				strokeWidth: 2,
				selectable: false,
				evented: false,
				originX: 'center',
				originY: 'center'
			});
			this.canvas.add(this.bezierHandle);
		}

		this.canvas.renderAll();
	}

	hideHandles() {
		if (this.startHandle) {
			this.canvas.remove(this.startHandle);
			this.startHandle = null;
		}
		if (this.endHandle) {
			this.canvas.remove(this.endHandle);
			this.endHandle = null;
		}
		if (this.bezierHandle) {
			this.canvas.remove(this.bezierHandle);
			this.bezierHandle = null;
		}
		this.canvas.renderAll();
	}

	cleanup(canvas: Canvas) {
		if (this.path) {
			canvas.remove(this.path);
			this.path = null;
		}
		this.hideHandles();
	}

	toJSON(): SegmentData {
		return {
			id: this.id,
			startNodeId: this.startNodeId,
			endNodeId: this.endNodeId,
			controlX: this.controlX,
			controlY: this.controlY
		};
	}
}
