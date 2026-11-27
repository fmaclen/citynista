import type { JunctionData, NodeData } from './types';

// The write a node's list of roads takes, held as a segment's ends are
// (SegmentWrites in segment.svelte.ts): only whoever made the node, a Graph
// keeping it to itself. Read from outside, the list is frozen. With it, who
// made the node hears of every write to it (`watch`): its place, its edits
// and its list of roads (Graph.changesSince).
export interface NodeWrites {
	segments(ids: readonly string[]): void;
	watch(written: () => void): void;
}

export class Node {
	readonly id: string;
	#x = $state(0);
	#y = $state(0);
	#segments: readonly string[] = Object.freeze([]);
	// The user's edits to the junction this node's segment ends form (see
	// JunctionData), replaced whole on every edit, never changed in place, so
	// every edit is a write its graph logs.
	#junction = $state<JunctionData | undefined>(undefined);
	#written: (() => void) | undefined;

	constructor(id: string, x: number, y: number, claim?: (writes: NodeWrites) => void) {
		this.id = id;
		this.x = x;
		this.y = y;
		claim?.({
			segments: (ids) => {
				this.#segments = Object.freeze([...ids]);
				this.#written?.();
			},
			watch: (written) => (this.#written = written)
		});
	}

	get x() {
		return this.#x;
	}
	set x(x: number) {
		this.#x = x;
		this.#written?.();
	}
	get y() {
		return this.#y;
	}
	set y(y: number) {
		this.#y = y;
		this.#written?.();
	}
	get junction() {
		return this.#junction;
	}
	set junction(junction: JunctionData | undefined) {
		this.#junction = junction;
		this.#written?.();
	}

	get connectedSegments() {
		return this.#segments;
	}

	toJSON(): NodeData {
		const data: NodeData = {
			id: this.id,
			x: this.x,
			y: this.y
		};
		if (this.junction) data.junction = $state.snapshot(this.junction);
		return data;
	}

	static fromJSON(data: NodeData, claim?: (writes: NodeWrites) => void) {
		const node = new Node(data.id, data.x, data.y, claim);
		if (data.junction) node.junction = data.junction;
		return node;
	}
}
