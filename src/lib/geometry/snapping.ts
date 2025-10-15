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
    const nearbyNode = graph.findNearbyNode(x, y, SNAP_THRESHOLD);

    if (nearbyNode && !excludeNodeIds.includes(nearbyNode.id)) {
        return {
            snappedX: nearbyNode.x,
            snappedY: nearbyNode.y,
            snappedNode: nearbyNode,
            snappedSegment: null
        };
    }

    const nearestSegment = findNearestSegment(graph, x, y, excludeSegmentIds, SNAP_THRESHOLD);
    if (nearestSegment) {
        return {
            snappedX: nearestSegment.splitX,
            snappedY: nearestSegment.splitY,
            snappedNode: null,
            snappedSegment: nearestSegment.segment
        };
    }

    return {
        snappedX: x,
        snappedY: y,
        snappedNode: null,
        snappedSegment: null
    };
}
