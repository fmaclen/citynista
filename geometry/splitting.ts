import { Line } from 'fabric';
import type { RoadGraph, NetworkSegment } from '../graph/graph';
import { generateId } from '../graph/graph';
import { ROAD_WIDTH } from '../types';

export function findNearestSegment(
    graph: RoadGraph,
    x: number,
    y: number,
    excludeSegmentIds: string[] = [],
    threshold: number = 15
): { segment: NetworkSegment; splitX: number; splitY: number } | null {
    let closestSegment: NetworkSegment | null = null;
    let closestDistance = threshold;
    let closestPoint = { x, y };

    for (const [segmentId, segment] of Array.from(graph.getAllSegments().entries())) {
        if (excludeSegmentIds.includes(segmentId)) continue;
        if (!segment.line) continue;

        const x1 = segment.line.x1 ?? 0;
        const y1 = segment.line.y1 ?? 0;
        const x2 = segment.line.x2 ?? 0;
        const y2 = segment.line.y2 ?? 0;

        const A = x - x1;
        const B = y - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;

        if (lenSq === 0) continue;

        const param = dot / lenSq;

        if (param < 0.1 || param > 0.9) continue;

        const projX = x1 + param * C;
        const projY = y1 + param * D;

        const dx = x - projX;
        const dy = y - projY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < closestDistance) {
            closestDistance = distance;
            closestSegment = segment;
            closestPoint = { x: projX, y: projY };
        }
    }

    if (closestSegment) {
        return {
            segment: closestSegment,
            splitX: closestPoint.x,
            splitY: closestPoint.y
        };
    }

    return null;
}

export function splitSegmentAtPoint(
    graph: RoadGraph,
    segment: NetworkSegment,
    x: number,
    y: number
): string {
    const newNodeId = generateId();
    const newSegmentId = generateId();

    const originalEndNodeId = segment.endNodeId;

    graph.addNode({
        id: newNodeId,
        x: x,
        y: y,
        connectedSegments: [segment.id, newSegmentId]
    });

    segment.endNodeId = newNodeId;

    const originalEndNode = graph.getNode(originalEndNodeId);
    if (originalEndNode) {
        originalEndNode.connectedSegments = originalEndNode.connectedSegments.filter(
            id => id !== segment.id
        );
        originalEndNode.connectedSegments.push(newSegmentId);
        graph.updateNode(originalEndNodeId, originalEndNode);
    }

    if (segment.line) {
        segment.line.set({ x2: x, y2: y });

        const newLine = new Line([x, y, segment.line.x2 ?? 0, segment.line.y2 ?? 0], {
            stroke: '#666666',
            strokeWidth: ROAD_WIDTH,
            selectable: false,
            evented: true,
            strokeLineCap: 'round',
            hoverCursor: 'default',
            strokeUniform: true
        });

        const canvas = segment.line.canvas;
        if (canvas) {
            canvas.add(newLine);
        }

        const endX = originalEndNode?.x ?? (segment.line.x2 ?? 0);
        const endY = originalEndNode?.y ?? (segment.line.y2 ?? 0);
        newLine.set({ x2: endX, y2: endY });

        graph.addSegment({
            id: newSegmentId,
            startNodeId: newNodeId,
            endNodeId: originalEndNodeId,
            line: newLine
        });
    }

    return newNodeId;
}
