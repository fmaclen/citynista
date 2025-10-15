import type { Path, Circle } from 'fabric';
import { SvelteMap } from 'svelte/reactivity';

export interface NetworkNode {
	id: string;
	x: number;
	y: number;
	connectedSegments: string[];
	circle?: Circle;
	debugHitArea?: Circle;
}

export interface NetworkSegment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	path?: Path;
	controlX: number;
	controlY: number;
}

export interface SerializedNode {
	id: string;
	x: number;
	y: number;
	connectedSegments: string[];
}

export interface SerializedSegment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX: number;
	controlY: number;
}

export interface SerializedGraph {
	nodes: SerializedNode[];
	segments: SerializedSegment[];
}

export function generateId(): string {
	return Math.random().toString(36).substring(2, 11);
}

export class Graph {
	private static STORAGE_KEY = 'citynista-graph';

	nodes = $state<SvelteMap<string, NetworkNode>>(new SvelteMap());
	segments = $state<SvelteMap<string, NetworkSegment>>(new SvelteMap());

	constructor() {
		// Auto-save and log on changes
		$effect(() => {
			// Track changes to nodes and segments
			void this.nodes.size;
			void this.segments.size;

			// Schedule save and log
			requestAnimationFrame(() => {
				this.save();
				this.log();
			});
		});
	}

	addNode(node: NetworkNode): void {
		this.nodes.set(node.id, node);
	}

	getNode(id: string): NetworkNode | undefined {
		return this.nodes.get(id);
	}

	updateNode(id: string, updates: Partial<Omit<NetworkNode, 'id'>>): void {
		const node = this.nodes.get(id);
		if (node) {
			Object.assign(node, updates);
		}
	}

	deleteNode(id: string): void {
		this.nodes.delete(id);
	}

	addSegment(segment: NetworkSegment): void {
		this.segments.set(segment.id, segment);
	}

	getSegment(id: string): NetworkSegment | undefined {
		return this.segments.get(id);
	}

	updateSegment(id: string, updates: Partial<Omit<NetworkSegment, 'id'>>): void {
		const segment = this.segments.get(id);
		if (segment) {
			Object.assign(segment, updates);
		}
	}

	deleteSegment(id: string): void {
		const segment = this.segments.get(id);
		if (segment) {
			// Clean up node connections
			const startNode = this.nodes.get(segment.startNodeId);
			const endNode = this.nodes.get(segment.endNodeId);

			if (startNode) {
				startNode.connectedSegments = startNode.connectedSegments.filter((s) => s !== id);
				// Delete node if it has no more connections
				if (startNode.connectedSegments.length === 0) {
					this.deleteNode(startNode.id);
				}
			}

			if (endNode && endNode.id !== segment.startNodeId) {
				endNode.connectedSegments = endNode.connectedSegments.filter((s) => s !== id);
				// Delete node if it has no more connections
				if (endNode.connectedSegments.length === 0) {
					this.deleteNode(endNode.id);
				}
			}
		}

		this.segments.delete(id);
	}

	findNearbyNode(x: number, y: number, threshold: number = 15): NetworkNode | undefined {
		for (const node of this.nodes.values()) {
			const dx = node.x - x;
			const dy = node.y - y;
			const distance = Math.sqrt(dx * dx + dy * dy);
			if (distance <= threshold) {
				return node;
			}
		}
		return undefined;
	}

	findSegmentByPath(path: Path): NetworkSegment | undefined {
		return Array.from(this.segments.values()).find((s) => s.path === path);
	}

	getAllSegments(): SvelteMap<string, NetworkSegment> {
		return this.segments;
	}

	getAllNodes(): SvelteMap<string, NetworkNode> {
		return this.nodes;
	}

	serialize(): SerializedGraph {
		const nodes: SerializedNode[] = [];
		this.nodes.forEach((node) => {
			nodes.push({
				id: node.id,
				x: node.x,
				y: node.y,
				connectedSegments: [...node.connectedSegments]
			});
		});

		const segments: SerializedSegment[] = [];
		this.segments.forEach((segment) => {
			segments.push({
				id: segment.id,
				startNodeId: segment.startNodeId,
				endNodeId: segment.endNodeId,
				controlX: segment.controlX,
				controlY: segment.controlY
			});
		});

		return { nodes, segments };
	}

	save(): void {
		try {
			const data = this.serialize();
			localStorage.setItem(Graph.STORAGE_KEY, JSON.stringify(data));
		} catch (error) {
			console.error('Failed to save graph to localStorage:', error);
		}
	}

	static load(): SerializedGraph | null {
		try {
			const data = localStorage.getItem(Graph.STORAGE_KEY);
			if (!data) return null;
			return JSON.parse(data);
		} catch (error) {
			console.error('Failed to load graph from localStorage:', error);
			return null;
		}
	}

	loadFromSerialized(data: SerializedGraph): void {
		this.clear();

		// Load nodes
		for (const nodeData of data.nodes) {
			this.addNode(nodeData);
		}

		// Load segments
		for (const segmentData of data.segments) {
			this.addSegment(segmentData);
		}
	}

	clear(): void {
		this.nodes.clear();
		this.segments.clear();
	}

	log(): void {
		const nodesData: Record<string, { coords: string; segments: string[] }> = {};
		this.nodes.forEach((node, id) => {
			nodesData[id] = {
				coords: `(${node.x.toFixed(1)}, ${node.y.toFixed(1)})`,
				segments: node.connectedSegments
			};
		});

		const segmentsData: Record<string, { from: string; to: string }> = {};
		this.segments.forEach((segment, id) => {
			const startNode = this.nodes.get(segment.startNodeId);
			const endNode = this.nodes.get(segment.endNodeId);
			segmentsData[id] = {
				from: startNode
					? `${segment.startNodeId}: (${startNode.x.toFixed(1)}, ${startNode.y.toFixed(1)})`
					: segment.startNodeId,
				to: endNode
					? `${segment.endNodeId}: (${endNode.x.toFixed(1)}, ${endNode.y.toFixed(1)})`
					: segment.endNodeId
			};
		});

		console.log(`Road Network - Nodes: ${this.nodes.size}, Segments: ${this.segments.size}`, {
			nodes: nodesData,
			segments: segmentsData
		});
	}
}
