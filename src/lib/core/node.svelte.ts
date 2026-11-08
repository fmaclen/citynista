import type { JunctionData, NodeData } from './types';

export class Node {
	id: string;
	x = $state(0);
	y = $state(0);
	connectedSegments: string[] = [];
	// The junction this node's segment ends form: stored connections and
	// placed islands (see JunctionData).
	junction = $state<JunctionData | undefined>(undefined);
	// Optional debug annotation, drawn by the dev-only node label overlay.
	label: string | undefined;

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
		const data: NodeData = {
			id: this.id,
			x: this.x,
			y: this.y
		};
		if (this.label) {
			data.label = this.label;
		}
		if (this.junction) data.junction = $state.snapshot(this.junction);
		return data;
	}

	static fromJSON(data: NodeData) {
		const node = new Node(data.id, data.x, data.y);
		if (data.label) {
			node.label = data.label;
		}
		if (data.junction) node.junction = data.junction;
		return node;
	}
}
