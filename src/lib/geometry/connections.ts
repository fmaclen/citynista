import type { ReactiveGraph } from '../graph/graph.svelte';
import { generateId } from '../graph/graph.svelte';
import { findSnappingTarget } from './snapping';
import { splitSegmentAtPoint } from './splitting';
import { getRelativeControlPoint, applyRelativeControlPoint, parsePathData } from './path-utils';

export function updateConnectedSegments(
	graph: ReactiveGraph,
	nodeId: string,
	newX: number,
	newY: number,
	excludeSegmentId?: string
): void {
	const node = graph.getNode(nodeId);
	if (!node) return;

	for (const segmentId of node.connectedSegments) {
		if (excludeSegmentId && segmentId === excludeSegmentId) {
			continue;
		}

		const segment = graph.getSegment(segmentId);
		if (!segment || !segment.path) continue;

		const canvas = segment.path.canvas;
		if (!canvas) continue;

		const coords = parsePathData(segment.path.path);
		if (!coords) continue;

		let { x1, y1, cx, cy, x2, y2 } = coords;

		// Calculate relative position of control point before moving
		const relativeControl = getRelativeControlPoint(x1, y1, x2, y2, cx, cy);

		// Update coordinates
		if (segment.startNodeId === nodeId) {
			x1 = newX;
			y1 = newY;
		}
		if (segment.endNodeId === nodeId) {
			x2 = newX;
			y2 = newY;
		}

		// Recalculate control point to maintain relative position
		const newControl = applyRelativeControlPoint(
			x1,
			y1,
			x2,
			y2,
			relativeControl.t,
			relativeControl.offset
		);
		cx = newControl.x;
		cy = newControl.y;

		// Update segment with new control points
		graph.updateSegment(segmentId, { controlX: cx, controlY: cy });

		// Update path in-place by modifying the path array directly
		const pathArray = segment.path.path;
		if (Array.isArray(pathArray) && pathArray.length >= 2) {
			pathArray[0] = ['M', x1, y1];
			pathArray[1] = ['Q', cx, cy, x2, y2];
			segment.path.set({ path: pathArray, dirty: true });
		}

		// Update debug hit area for this segment's midpoint
		if (segment.path.debugHitArea) {
			const t = 0.5;
			const midX = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
			const midY = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
			segment.path.debugHitArea.set({
				left: midX,
				top: midY
			});
		}
	}

	graph.updateNode(nodeId, { x: newX, y: newY });

	// Update debug hit area for the node
	if (node.debugHitArea) {
		node.debugHitArea.set({
			left: newX,
			top: newY
		});
	}
}

export function finalizeNodeConnection(
	graph: ReactiveGraph,
	x: number,
	y: number,
	segmentId: string,
	excludeNodeIds: string[] = []
): string {
	const snapResult = findSnappingTarget(graph, x, y, excludeNodeIds, [segmentId]);

	if (snapResult.snappedNode) {
		const existingNode = snapResult.snappedNode;
		existingNode.connectedSegments.push(segmentId);
		graph.updateNode(existingNode.id, existingNode);
		return existingNode.id;
	}

	if (snapResult.snappedSegment) {
		const splitNodeId = splitSegmentAtPoint(
			graph,
			snapResult.snappedSegment,
			snapResult.snappedX,
			snapResult.snappedY
		);

		const splitNode = graph.getNode(splitNodeId);
		if (splitNode) {
			splitNode.connectedSegments.push(segmentId);
			graph.updateNode(splitNodeId, splitNode);
		}

		return splitNodeId;
	}

	const newNodeId = generateId();
	graph.addNode({
		id: newNodeId,
		x: snapResult.snappedX,
		y: snapResult.snappedY,
		connectedSegments: [segmentId]
	});
	return newNodeId;
}
