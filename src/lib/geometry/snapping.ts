import type { RoadGraph } from '../graph/graph';
import type { SnapResult } from '../types';
import { SNAP_THRESHOLD } from '../types';
import { findNearestSegment } from './splitting';

export function findSnappingTarget(
	graph: RoadGraph,
	x: number,
	y: number,
	excludeNodeIds: string[] = [],
	excludeSegmentIds: string[] = []
): SnapResult {
	let closestNode = null;
	let closestNodeDistance = SNAP_THRESHOLD;

	// Find closest node
	for (const node of graph.getAllNodes().values()) {
		if (excludeNodeIds.includes(node.id)) continue;

		const dx = node.x - x;
		const dy = node.y - y;
		const distance = Math.sqrt(dx * dx + dy * dy);

		if (distance < closestNodeDistance) {
			closestNodeDistance = distance;
			closestNode = node;
		}
	}

	let closestSegment = null;
	let closestSegmentPoint = { x, y };
	let closestSegmentDistance = SNAP_THRESHOLD;

	// Find closest segment midpoint
	const nearestSegment = findNearestSegment(graph, x, y, excludeSegmentIds, SNAP_THRESHOLD);
	if (nearestSegment) {
		const dx = nearestSegment.splitX - x;
		const dy = nearestSegment.splitY - y;
		closestSegmentDistance = Math.sqrt(dx * dx + dy * dy);
		closestSegment = nearestSegment.segment;
		closestSegmentPoint = { x: nearestSegment.splitX, y: nearestSegment.splitY };
	}

	// Return closest target (nodes have priority if distances are equal)
	if (closestNode && closestNodeDistance <= closestSegmentDistance) {
		return {
			snappedX: closestNode.x,
			snappedY: closestNode.y,
			snappedNode: closestNode,
			snappedSegment: null
		};
	}

	if (closestSegment) {
		return {
			snappedX: closestSegmentPoint.x,
			snappedY: closestSegmentPoint.y,
			snappedNode: null,
			snappedSegment: closestSegment
		};
	}

	return {
		snappedX: x,
		snappedY: y,
		snappedNode: null,
		snappedSegment: null
	};
}
