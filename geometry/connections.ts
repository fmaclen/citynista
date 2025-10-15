import type { RoadGraph } from '../graph/graph';
import { generateId } from '../graph/graph';
import { findSnappingTarget } from './snapping';
import { splitSegmentAtPoint } from './splitting';

export function updateConnectedSegments(
    graph: RoadGraph,
    nodeId: string,
    newX: number,
    newY: number
): void {
    const node = graph.getNode(nodeId);
    if (!node) return;

    for (const segmentId of node.connectedSegments) {
        const segment = graph.getSegment(segmentId);
        if (!segment || !segment.line) continue;

        if (segment.startNodeId === nodeId) {
            segment.line.set({ x1: newX, y1: newY });
        } else if (segment.endNodeId === nodeId) {
            segment.line.set({ x2: newX, y2: newY });
        }
    }

    graph.updateNode(nodeId, { x: newX, y: newY });
}

export function finalizeNodeConnection(
    graph: RoadGraph,
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
