import type { RoadGraph } from '../graph/graph';
import { generateId } from '../graph/graph';
import { findSnappingTarget } from './snapping';
import { splitSegmentAtPoint } from './splitting';
import { getRelativeControlPoint, applyRelativeControlPoint } from './path-utils';

export function updateConnectedSegments(
    graph: RoadGraph,
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

        const pathData: string | any[] = segment.path.path as any;
        let x1: number, y1: number, cx: number, cy: number, x2: number, y2: number;

        // Parse current path
        if (typeof pathData === 'string') {
            const match = pathData.match(/M\s+([\d.]+)\s+([\d.]+)\s+Q\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
            if (!match) continue;
            x1 = parseFloat(match[1]!);
            y1 = parseFloat(match[2]!);
            cx = parseFloat(match[3]!);
            cy = parseFloat(match[4]!);
            x2 = parseFloat(match[5]!);
            y2 = parseFloat(match[6]!);
        } else if (Array.isArray(pathData) && pathData.length >= 2) {
            const moveCmd = pathData[0];
            const quadCmd = pathData[1];
            if (!Array.isArray(moveCmd) || !Array.isArray(quadCmd)) continue;
            x1 = moveCmd[1] as number;
            y1 = moveCmd[2] as number;
            cx = quadCmd[1] as number;
            cy = quadCmd[2] as number;
            x2 = quadCmd[3] as number;
            y2 = quadCmd[4] as number;
        } else {
            continue;
        }

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
        const newControl = applyRelativeControlPoint(x1, y1, x2, y2, relativeControl.t, relativeControl.offset);
        cx = newControl.x;
        cy = newControl.y;
        segment.controlX = cx;
        segment.controlY = cy;

        // Update path in-place by modifying the path array directly
        const pathArray = segment.path.path as any[];
        if (Array.isArray(pathArray) && pathArray.length >= 2) {
            pathArray[0] = ['M', x1, y1];
            pathArray[1] = ['Q', cx, cy, x2, y2];
            segment.path.set({ path: pathArray, dirty: true });
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
