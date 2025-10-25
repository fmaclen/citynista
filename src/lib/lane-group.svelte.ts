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

		let x1 = startNode.x;
		let y1 = startNode.y;
		let x2 = endNode.x;
		let y2 = endNode.y;

		// Check if nodes are intersections and calculate pull-back if needed
		const startIsIntersection = startNode.connectedSegments.length >= 2;
		const endIsIntersection = endNode.connectedSegments.length >= 2;

		if (startIsIntersection || endIsIntersection) {
			const totalWidth = this.config.getTotalWidth() * 12; // Scale factor

			// Calculate segment direction
			const dx = x2 - x1;
			const dy = y2 - y1;
			const length = Math.sqrt(dx * dx + dy * dy);

			if (length > 0) {
				const dirX = dx / length;
				const dirY = dy / length;

				// Pull back from start node if it's an intersection
				if (startIsIntersection) {
					x1 = x1 + dirX * totalWidth;
					y1 = y1 + dirY * totalWidth;
				}

				// Pull back from end node if it's an intersection
				if (endIsIntersection) {
					x2 = x2 - dirX * totalWidth;
					y2 = y2 - dirY * totalWidth;
				}
			}
		}

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
