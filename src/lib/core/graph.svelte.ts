import { SvelteMap } from 'svelte/reactivity';
import { Node } from './node.svelte';
import { Segment } from './segment.svelte';
import type { GraphData } from './types';

const STORAGE_KEY = 'citynista-graph-v2';

export class Graph {
	nodes = new SvelteMap<string, Node>();
	segments = new SvelteMap<string, Segment>();

	private nodeIdCounter = 0;
	private segmentIdCounter = 0;

	createNode(x: number, y: number) {
		const id = `node-${this.nodeIdCounter++}`;
		const node = new Node(id, x, y);
		this.nodes.set(id, node);
		return node;
	}

	createSegment(startNodeId: string, endNodeId: string, laneTemplateId: string = 'default') {
		const id = `segment-${this.segmentIdCounter++}`;
		const segment = new Segment(id, startNodeId, endNodeId, laneTemplateId);
		this.segments.set(id, segment);

		const startNode = this.nodes.get(startNodeId);
		const endNode = this.nodes.get(endNodeId);
		startNode?.addSegment(id);
		endNode?.addSegment(id);

		return segment;
	}

	deleteNode(nodeId: string) {
		const node = this.nodes.get(nodeId);
		if (!node) return;

		const segmentsToDelete = [...node.connectedSegments];
		for (const segmentId of segmentsToDelete) {
			this.deleteSegment(segmentId);
		}

		this.nodes.delete(nodeId);
	}

	deleteSegment(segmentId: string) {
		const segment = this.segments.get(segmentId);
		if (!segment) return;

		const startNode = this.nodes.get(segment.startNodeId);
		const endNode = this.nodes.get(segment.endNodeId);
		startNode?.removeSegment(segmentId);
		endNode?.removeSegment(segmentId);

		this.segments.delete(segmentId);
	}

	findNodeAt(x: number, y: number, threshold: number = 15) {
		for (const node of this.nodes.values()) {
			const dx = node.x - x;
			const dy = node.y - y;
			if (Math.sqrt(dx * dx + dy * dy) < threshold) {
				return node;
			}
		}
		return null;
	}

	clear() {
		this.nodes.clear();
		this.segments.clear();
		this.nodeIdCounter = 0;
		this.segmentIdCounter = 0;
	}

	toJSON(): GraphData {
		return {
			nodes: Array.from(this.nodes.values()).map((n) => n.toJSON()),
			segments: Array.from(this.segments.values()).map((s) => s.toJSON())
		};
	}

	fromJSON(data: GraphData) {
		this.clear();

		for (const nodeData of data.nodes) {
			const node = Node.fromJSON(nodeData);
			this.nodes.set(node.id, node);

			const idNum = parseInt(node.id.replace('node-', ''), 10);
			if (!isNaN(idNum) && idNum >= this.nodeIdCounter) {
				this.nodeIdCounter = idNum + 1;
			}
		}

		for (const segmentData of data.segments) {
			const segment = Segment.fromJSON(segmentData);
			this.segments.set(segment.id, segment);

			const startNode = this.nodes.get(segment.startNodeId);
			const endNode = this.nodes.get(segment.endNodeId);
			startNode?.addSegment(segment.id);
			endNode?.addSegment(segment.id);

			const idNum = parseInt(segment.id.replace('segment-', ''), 10);
			if (!isNaN(idNum) && idNum >= this.segmentIdCounter) {
				this.segmentIdCounter = idNum + 1;
			}
		}
	}

	save() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
		} catch (e) {
			console.error('Failed to save graph:', e);
		}
	}

	load() {
		try {
			const data = localStorage.getItem(STORAGE_KEY);
			if (data) {
				this.fromJSON(JSON.parse(data));
				return true;
			}
		} catch (e) {
			console.error('Failed to load graph:', e);
		}
		return false;
	}
}
