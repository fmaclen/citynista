import { type Canvas, type FabricObject } from 'fabric';
import type { Node } from './node.svelte';
import type { Segment } from './segment.svelte';
import type { Graph } from './graph.svelte';
import { LaneConfigManager } from './lane-config.svelte';
import { renderCurvedLanes } from './lane-renderer.svelte';

interface VirtualSegment {
	fromSegmentId: string;
	toSegmentId: string;
	startX: number;
	startY: number;
	controlX: number;
	controlY: number;
	endX: number;
	endY: number;
	laneConfigId: string;
}

export class IntersectionConnectionManager {
	private virtualSegments: VirtualSegment[] = [];
	private connectionObjects: FabricObject[] = [];
	private canvas: Canvas;
	private graph: Graph;

	constructor(canvas: Canvas, graph: Graph) {
		this.canvas = canvas;
		this.graph = graph;
	}

	/**
	 * Generate connections for an intersection node
	 * Note: This method does NOT clear existing connections - that should be done at a higher level
	 */
	generateConnectionsForNode(nodeId: string): void {
		const node = this.graph.nodes.get(nodeId);
		if (!node) return;

		// Get all segments connected to this node
		const segments = this.getConnectedSegments(node);
		if (segments.length < 2) return;

		// For now, handle 2-way intersections (can extend to more later)
		if (segments.length === 2) {
			this.createTwoWayConnection(segments[0], segments[1], node);
		}

		// Render the virtual segments for this node
		this.renderVirtualSegments();
	}

	/**
	 * Create a virtual segment connecting two road segments at an intersection
	 */
	private createTwoWayConnection(segment1: Segment, segment2: Segment, node: Node): void {
		// Determine if each segment starts or ends at this node
		const seg1StartsAtNode = segment1.startNodeId === node.id;
		const seg2StartsAtNode = segment2.startNodeId === node.id;

		// Get the other nodes
		const seg1OtherNode = this.graph.nodes.get(
			seg1StartsAtNode ? segment1.endNodeId : segment1.startNodeId
		);
		const seg2OtherNode = this.graph.nodes.get(
			seg2StartsAtNode ? segment2.endNodeId : segment2.startNodeId
		);

		if (!seg1OtherNode || !seg2OtherNode) return;

		// Get lane configurations
		const configManager = LaneConfigManager.getInstance();
		const config1 = configManager.getOrDefault(segment1.laneConfigId);
		const config2 = configManager.getOrDefault(segment2.laneConfigId);

		// Calculate pull-back distances based on lane widths
		const pullback1 = config1.getTotalWidth() * 12; // Scale factor for visibility
		const pullback2 = config2.getTotalWidth() * 12;

		// Calculate angles of segments pointing TOWARDS the intersection
		// (direction from other node to intersection node)
		const angle1 = Math.atan2(
			node.y - seg1OtherNode.y,
			node.x - seg1OtherNode.x
		);

		const angle2 = Math.atan2(
			node.y - seg2OtherNode.y,
			node.x - seg2OtherNode.x
		);

		// Calculate start and end points (pulled back from intersection)
		// We move backwards along the incoming direction
		const startX = node.x - Math.cos(angle1) * pullback1;
		const startY = node.y - Math.sin(angle1) * pullback1;
		const endX = node.x - Math.cos(angle2) * pullback2;
		const endY = node.y - Math.sin(angle2) * pullback2;

		// Calculate control point for smooth curve
		// The control point should be at the intersection for a smooth transition
		const controlX = node.x;
		const controlY = node.y;

		// Create virtual segment
		this.virtualSegments.push({
			fromSegmentId: segment1.id,
			toSegmentId: segment2.id,
			startX,
			startY,
			controlX,
			controlY,
			endX,
			endY,
			laneConfigId: segment1.laneConfigId // Use first segment's config for now
		});
	}

	/**
	 * Get all segments connected to a node
	 */
	private getConnectedSegments(node: Node): Segment[] {
		return node.connectedSegments
			.map(segId => this.graph.segments.get(segId))
			.filter((seg): seg is Segment => seg !== undefined);
	}


	/**
	 * Render all virtual segments using the same lane rendering as regular segments
	 */
	private renderVirtualSegments(): void {
		const configManager = LaneConfigManager.getInstance();

		for (const virtualSeg of this.virtualSegments) {
			const config = configManager.getOrDefault(virtualSeg.laneConfigId);

			// Use the same lane renderer as regular segments
			const renderConfig = {
				startX: virtualSeg.startX,
				startY: virtualSeg.startY,
				controlX: virtualSeg.controlX,
				controlY: virtualSeg.controlY,
				endX: virtualSeg.endX,
				endY: virtualSeg.endY,
				lanes: config.lanes,
				centerOffset: config.getCenterOffset()
			};

			// Render lanes for this virtual segment
			const laneObjects = renderCurvedLanes(renderConfig, this.canvas);
			this.connectionObjects.push(...laneObjects);

			// Send to back to ensure they render below segment lanes
			for (const obj of laneObjects) {
				this.canvas.sendObjectToBack(obj);
			}
		}
	}

	/**
	 * Clear all connections
	 */
	clearConnections(): void {
		for (const obj of this.connectionObjects) {
			this.canvas.remove(obj);
		}
		this.connectionObjects = [];
		this.virtualSegments = [];
	}


	/**
	 * Cleanup
	 */
	cleanup(): void {
		this.clearConnections();
	}
}