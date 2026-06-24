import type { LaneConnectionRef, NodeData } from './types';

export class Node {
	id: string;
	x = $state(0);
	y = $state(0);
	connectedSegments: string[] = [];
	// Movements turned off here; undefined = all default movements allowed.
	disabledConnections = $state<LaneConnectionRef[] | undefined>(undefined);
	// Movements turned ON that are not in the default set — a U-turn or a break
	// across a median the default treats as a barrier.
	enabledConnections = $state<LaneConnectionRef[] | undefined>(undefined);
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
		if (this.disabledConnections && this.disabledConnections.length > 0) {
			data.disabledConnections = this.disabledConnections.map((c) => ({
				from: { ...c.from },
				to: { ...c.to }
			}));
		}
		if (this.enabledConnections && this.enabledConnections.length > 0) {
			data.enabledConnections = this.enabledConnections.map((c) => ({
				from: { ...c.from },
				to: { ...c.to }
			}));
		}
		if (this.label) {
			data.label = this.label;
		}
		return data;
	}

	static fromJSON(data: NodeData) {
		const node = new Node(data.id, data.x, data.y);
		if (data.disabledConnections && data.disabledConnections.length > 0) {
			node.disabledConnections = data.disabledConnections;
		}
		if (data.enabledConnections && data.enabledConnections.length > 0) {
			node.enabledConnections = data.enabledConnections;
		}
		if (data.label) {
			node.label = data.label;
		}
		return node;
	}
}
