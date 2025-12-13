import type { NodeData } from './types';

export class Node {
	id: string;
	x = $state(0);
	y = $state(0);
	connectedSegments: string[] = [];

	constructor(id: string, x: number, y: number) {
		this.id = id;
		this.x = x;
		this.y = y;
	}

	addSegment(segmentId: string) {
		if (!this.connectedSegments.includes(segmentId)) {
			this.connectedSegments.push(segmentId);
		}
	}

	removeSegment(segmentId: string) {
		const index = this.connectedSegments.indexOf(segmentId);
		if (index !== -1) {
			this.connectedSegments.splice(index, 1);
		}
	}

	toJSON(): NodeData {
		return {
			id: this.id,
			x: this.x,
			y: this.y
		};
	}

	static fromJSON(data: NodeData) {
		return new Node(data.id, data.x, data.y);
	}
}
