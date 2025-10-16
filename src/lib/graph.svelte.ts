import { SvelteMap } from 'svelte/reactivity';
import type { Canvas } from 'fabric';
import { Node, type NodeData } from './node.svelte';
import { Segment, type SegmentData } from './segment.svelte';

export interface SerializedGraph {
	nodes: NodeData[];
	segments: SegmentData[];
}

export class Graph {
	private static STORAGE_KEY = 'citynista-graph';

	nodes = new SvelteMap<string, Node>();
	segments = new SvelteMap<string, Segment>();

	private canvas: Canvas | null = null;

	constructor() {
		// Save when nodes or segments are added/removed
		$effect(() => {
			void this.nodes.size;
			void this.segments.size;

			requestAnimationFrame(() => {
				this.save();
				this.log();
			});
		});

		// Save and redraw when node positions change
		$effect(() => {
			for (const node of this.nodes.values()) {
				void node.x;
				void node.y;
				void node.isSelected;
				node.draw();
			}

			requestAnimationFrame(() => {
				this.save();
			});
		});

		// Save when segment control points or selection changes
		$effect(() => {
			for (const segment of this.segments.values()) {
				void segment.controlX;
				void segment.controlY;
				void segment.isSelected;
			}

			requestAnimationFrame(() => {
				this.save();
			});
		});

		// Trigger segment path updates
		$effect(() => {
			for (const segment of this.segments.values()) {
				// Access version to trigger pathVersion $derived.by
				void segment.version;
			}
		});

		// Show/hide segment handles based on selection
		$effect(() => {
			for (const segment of this.segments.values()) {
				void segment.isSelected;
				if (segment.isSelected) {
					this.showSegmentHandles(segment);
				} else {
					this.hideSegmentHandles(segment);
				}
			}
		});
	}

	setCanvas(canvas: Canvas) {
		this.canvas = canvas;
	}

	setNodesVisible(visible: boolean) {
		for (const node of this.nodes.values()) {
			if (node.circle) {
				node.circle.set({ visible });
			}
		}
		if (this.canvas) {
			this.canvas.renderAll();
		}
	}

	addNode(data: NodeData): Node {
		if (!this.canvas) throw new Error('Canvas not initialized');
		const node = new Node(data, this.canvas);
		this.nodes.set(node.id, node);
		return node;
	}

	addSegment(data: SegmentData): Segment {
		if (!this.canvas) throw new Error('Canvas not initialized');
		const segment = new Segment(data, this.canvas, this);
		this.segments.set(segment.id, segment);

		const startNode = this.nodes.get(data.startNodeId);
		const endNode = this.nodes.get(data.endNodeId);

		if (startNode && !startNode.connectedSegments.includes(segment.id)) {
			startNode.connectedSegments.push(segment.id);
		}
		if (endNode && !endNode.connectedSegments.includes(segment.id)) {
			endNode.connectedSegments.push(segment.id);
		}

		return segment;
	}

	deleteSegment(id: string) {
		const segment = this.segments.get(id);
		if (!segment || !this.canvas) return;

		const startNode = this.nodes.get(segment.startNodeId);
		const endNode = this.nodes.get(segment.endNodeId);

		if (startNode) {
			startNode.connectedSegments = startNode.connectedSegments.filter((s) => s !== id);
			if (startNode.connectedSegments.length === 0) {
				this.deleteNode(startNode.id);
			}
		}

		if (endNode && endNode.id !== segment.startNodeId) {
			endNode.connectedSegments = endNode.connectedSegments.filter((s) => s !== id);
			if (endNode.connectedSegments.length === 0) {
				this.deleteNode(endNode.id);
			}
		}

		segment.cleanup(this.canvas);
		this.segments.delete(id);
	}

	deleteNode(id: string) {
		const node = this.nodes.get(id);
		if (!this.canvas || !node) return;

		node.cleanup(this.canvas);
		this.nodes.delete(id);
	}

	findNearbyNode(x: number, y: number, threshold: number = 15): Node | undefined {
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

	clear() {
		if (!this.canvas) return;

		for (const segment of this.segments.values()) {
			segment.cleanup(this.canvas);
		}
		for (const node of this.nodes.values()) {
			node.cleanup(this.canvas);
		}

		this.nodes.clear();
		this.segments.clear();
	}

	serialize(): SerializedGraph {
		const nodes: NodeData[] = [];
		this.nodes.forEach((node) => {
			nodes.push(node.toJSON());
		});

		const segments: SegmentData[] = [];
		this.segments.forEach((segment) => {
			segments.push(segment.toJSON());
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

	private showSegmentHandles(segment: Segment) {
		segment.showHandles();
	}

	private hideSegmentHandles(segment: Segment) {
		segment.hideHandles();
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

		console.log(`Graph - Nodes: ${this.nodes.size}, Segments: ${this.segments.size}`, {
			nodes: nodesData,
			segments: segmentsData
		});
	}
}
