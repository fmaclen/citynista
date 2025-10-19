import { type Canvas, type FabricObject } from 'fabric';
import type { Segment } from './segment.svelte';
import type { LaneConfiguration } from './lane-config.svelte';
import type { Graph } from './graph.svelte';
import { renderStraightLanes, renderCurvedLanes, isSegmentStraight } from './lane-renderer.svelte';

export class LaneGroup {
	private segment: Segment;
	private canvas: Canvas;
	private graph: Graph;
	private config: LaneConfiguration;

	private laneObjects: FabricObject[] = [];

	constructor(segment: Segment, canvas: Canvas, graph: Graph, config: LaneConfiguration) {
		this.segment = segment;
		this.canvas = canvas;
		this.graph = graph;
		this.config = config;

		this.createLaneGroup();
	}

	private createLaneGroup(): void {
		// Clear existing lanes
		for (const obj of this.laneObjects) {
			this.canvas.remove(obj);
		}
		this.laneObjects = [];

		const startNode = this.graph.nodes.get(this.segment.startNodeId);
		const endNode = this.graph.nodes.get(this.segment.endNodeId);

		if (!startNode || !endNode) return;

		const x1 = startNode.x;
		const y1 = startNode.y;
		const x2 = endNode.x;
		const y2 = endNode.y;

		// Render lanes using appropriate renderer
		const renderConfig = {
			startX: x1,
			startY: y1,
			controlX: this.segment.controlX,
			controlY: this.segment.controlY,
			endX: x2,
			endY: y2,
			lanes: this.config.lanes,
			centerOffset: this.config.getCenterOffset()
		};

		if (isSegmentStraight(x1, y1, this.segment.controlX, this.segment.controlY, x2, y2)) {
			this.laneObjects = renderStraightLanes(renderConfig, this.canvas);
		} else {
			this.laneObjects = renderCurvedLanes(renderConfig, this.canvas);
		}
	}

	update(): void {
		this.createLaneGroup();
	}

	cleanup(): void {
		for (const obj of this.laneObjects) {
			this.canvas.remove(obj);
		}
		this.laneObjects = [];
	}
}
