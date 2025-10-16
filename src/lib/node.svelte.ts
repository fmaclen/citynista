import { Circle, type Canvas } from 'fabric';
import { NODE_RADIUS } from './constants';

export interface NodeData {
	id: string;
	x: number;
	y: number;
	connectedSegments: string[];
}

export class Node {
	id: string;
	x = $state(0);
	y = $state(0);
	connectedSegments: string[] = [];
	isSelected = $state(false);

	private circle: Circle | null = null;
	private debugHitArea: Circle | null = null;
	private canvas: Canvas;

	constructor(data: NodeData, canvas: Canvas) {
		this.id = data.id;
		this.x = data.x;
		this.y = data.y;
		this.connectedSegments = data.connectedSegments || [];
		this.canvas = canvas;

		this.draw();
	}

	draw() {
		if (!this.circle) {
			this.circle = new Circle({
				left: this.x,
				top: this.y,
				radius: NODE_RADIUS,
				fill: this.isSelected ? '#4299E1' : '#ffffff',
				stroke: this.isSelected ? '#ffffff' : undefined,
				strokeWidth: this.isSelected ? 2 : 0,
				selectable: false,
				evented: false,
				originX: 'center',
				originY: 'center'
			});
			this.canvas.add(this.circle);
		} else {
			this.circle.set({
				left: this.x,
				top: this.y,
				fill: this.isSelected ? '#4299E1' : '#ffffff',
				stroke: this.isSelected ? '#ffffff' : undefined,
				strokeWidth: this.isSelected ? 2 : 0
			});
			this.circle.setCoords();
		}
		this.canvas.renderAll();
	}

	cleanup(canvas: Canvas) {
		if (this.circle) {
			canvas.remove(this.circle);
			this.circle = null;
		}
		if (this.debugHitArea) {
			canvas.remove(this.debugHitArea);
			this.debugHitArea = null;
		}
	}

	toJSON(): NodeData {
		return {
			id: this.id,
			x: this.x,
			y: this.y,
			connectedSegments: [...this.connectedSegments]
		};
	}
}
