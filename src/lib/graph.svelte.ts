import { SvelteMap } from 'svelte/reactivity';
import type { Canvas } from 'fabric';
import { Node, type NodeData } from './node.svelte';
import { Segment, type SegmentData } from './segment.svelte';
import type { Editor } from './editor.svelte';
import { splitBezierAtT } from './path-utils';
import { LaneConfiguration, type LaneConfigData, LaneConfigManager } from './lane-config.svelte';

export interface SerializedGraph {
	nodes: NodeData[];
	segments: SegmentData[];
	laneConfigs?: LaneConfigData[];
}

export class Graph {
	private static STORAGE_KEY = 'citynista-graph';

	nodes = new SvelteMap<string, Node>();
	segments = new SvelteMap<string, Segment>();
	laneConfigs = new SvelteMap<string, LaneConfiguration>();

	private canvas: Canvas | null = null;
	private editor: Editor | null = null;

	private saveScheduled = false;
	private renderScheduled = false;

	constructor() {
		this.initializeLaneConfigs();

		// Save when nodes or segments are added/removed
		$effect(() => {
			void this.nodes.size;
			void this.segments.size;
			void this.laneConfigs.size;

			this.scheduleSave();
			this.log();
		});

		// Redraw when node positions change
		$effect(() => {
			for (const node of this.nodes.values()) {
				void node.x;
				void node.y;
				void node.isSelected;
				node.updatePosition();
			}

			this.scheduleSave();
			this.scheduleRender();
		});

		// Save when segment control points or selection changes
		$effect(() => {
			for (const segment of this.segments.values()) {
				void segment.controlX;
				void segment.controlY;
				void segment.isSelected;
			}

			this.scheduleSave();
		});

		// Trigger segment path updates
		$effect(() => {
			for (const segment of this.segments.values()) {
				// Access version to trigger pathVersion $derived.by
				void segment.version;
			}
			this.scheduleRender();
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
			this.scheduleRender();
		});
	}

	private initializeLaneConfigs(): void {
		const configManager = LaneConfigManager.getInstance();
		for (const config of configManager.getAll()) {
			this.laneConfigs.set(config.id, config);
		}
	}

	private scheduleSave() {
		if (this.saveScheduled) return;
		this.saveScheduled = true;

		requestAnimationFrame(() => {
			this.saveScheduled = false;
			this.save();
		});
	}

	private scheduleRender() {
		if (this.renderScheduled || !this.canvas) return;
		this.renderScheduled = true;

		requestAnimationFrame(() => {
			this.renderScheduled = false;
			if (this.canvas) {
				this.canvas.renderAll();
			}
		});
	}

	setCanvas(canvas: Canvas) {
		this.canvas = canvas;
	}

	setEditor(editor: Editor) {
		this.editor = editor;
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
		if (!this.editor) throw new Error('Editor not initialized');
		const segment = new Segment(data, this.canvas, this, this.editor);
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

	splitSegment(segmentId: string, newNodeId: string, x: number, y: number, t?: number): void {
		const segment = this.segments.get(segmentId);
		if (!segment) return;

		const startNode = this.nodes.get(segment.startNodeId);
		const endNode = this.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) return;

		const startNodeId = segment.startNodeId;
		const endNodeId = segment.endNodeId;

		// Use the actual split point coordinates
		this.addNode({
			id: newNodeId,
			x,
			y,
			connectedSegments: []
		});

		let controlPoint1, controlPoint2;

		if (t !== undefined && t >= 0 && t <= 1) {
			// Use proper bezier splitting when we have the t parameter
			const splitResult = splitBezierAtT(
				startNode.x,
				startNode.y,
				segment.controlX,
				segment.controlY,
				endNode.x,
				endNode.y,
				t
			);

			controlPoint1 = splitResult.segment1;
			controlPoint2 = splitResult.segment2;
		} else {
			// Fallback to midpoint (shouldn't happen with our new code)
			controlPoint1 = {
				controlX: (startNode.x + x) / 2,
				controlY: (startNode.y + y) / 2
			};
			controlPoint2 = {
				controlX: (x + endNode.x) / 2,
				controlY: (y + endNode.y) / 2
			};
		}

		this.addSegment({
			id: `${segmentId}-1`,
			startNodeId: startNodeId,
			endNodeId: newNodeId,
			controlX: controlPoint1.controlX,
			controlY: controlPoint1.controlY
		});

		this.addSegment({
			id: `${segmentId}-2`,
			startNodeId: newNodeId,
			endNodeId: endNodeId,
			controlX: controlPoint2.controlX,
			controlY: controlPoint2.controlY
		});

		this.deleteSegment(segmentId);
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

		const laneConfigs: LaneConfigData[] = [];
		this.laneConfigs.forEach((config) => {
			laneConfigs.push(config.toJSON());
		});

		return { nodes, segments, laneConfigs };
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
