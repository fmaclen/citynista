import { Path } from 'fabric';
import type { RoadGraph, NetworkSegment } from '../graph/graph';
import { generateId } from '../graph/graph';
import { ROAD_WIDTH } from '../types';
import { createCurvedPathData } from './path-utils';

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
        if (!segment.path) continue;

        const pathArray = segment.path.path;
        if (!pathArray || pathArray.length === 0) continue;

        const moveCmd = pathArray[0];
        const quadCmd = pathArray[1];
        if (!moveCmd || !quadCmd || !Array.isArray(moveCmd) || !Array.isArray(quadCmd)) continue;

        const x1 = moveCmd[1] as number;
        const y1 = moveCmd[2] as number;
        const cx = quadCmd[1] as number;
        const cy = quadCmd[2] as number;
        const x2 = quadCmd[3] as number;
        const y2 = quadCmd[4] as number;

        let minDist = Infinity;
        let bestPoint = { x, y };
        let bestParam = 0;

        for (let t = 0.1; t <= 0.9; t += 0.05) {
            const qx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
            const qy = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;

            const dx = x - qx;
            const dy = y - qy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < minDist) {
                minDist = dist;
                bestPoint = { x: qx, y: qy };
                bestParam = t;
            }
        }

        if (minDist < closestDistance && bestParam >= 0.1 && bestParam <= 0.9) {
            closestDistance = minDist;
            closestSegment = segment;
            closestPoint = bestPoint;
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

    if (segment.path) {
        const canvas = segment.path.canvas;
        const pathArray = segment.path.path;
        if (pathArray && pathArray.length > 0 && canvas) {
            const moveCmd = pathArray[0];
            const quadCmd = pathArray[1];
            if (moveCmd && quadCmd && Array.isArray(moveCmd) && Array.isArray(quadCmd)) {
                const x1 = moveCmd[1] as number;
                const y1 = moveCmd[2] as number;
                const cx = quadCmd[1] as number;
                const cy = quadCmd[2] as number;
                const x2 = quadCmd[3] as number;
                const y2 = quadCmd[4] as number;

                // Find the t parameter where we're splitting the curve
                let bestT = 0.5;
                let minDist = Infinity;
                for (let t = 0; t <= 1; t += 0.01) {
                    const qx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
                    const qy = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
                    const dist = Math.sqrt((x - qx) * (x - qx) + (y - qy) * (y - qy));
                    if (dist < minDist) {
                        minDist = dist;
                        bestT = t;
                    }
                }

                // Use De Casteljau's algorithm to split the bezier curve at t
                // This preserves the curve shape perfectly
                const t = bestT;

                // First subdivision: from 0 to t
                const q0x = (1 - t) * x1 + t * cx;
                const q0y = (1 - t) * y1 + t * cy;
                const q1x = (1 - t) * cx + t * x2;
                const q1y = (1 - t) * cy + t * y2;

                // Control point for first segment
                const control1x = q0x;
                const control1y = q0y;

                // Control point for second segment
                const control2x = q1x;
                const control2y = q1y;

                // Update first segment: remove old path and create new one
                canvas.remove(segment.path);

                const pathData1 = createCurvedPathData(x1, y1, x, y, control1x, control1y);
                const newPath1 = new Path(pathData1);
                newPath1.set({
                    stroke: '#666666',
                    strokeWidth: ROAD_WIDTH,
                    fill: '',
                    selectable: false,
                    evented: true,
                    strokeLineCap: 'round',
                    hoverCursor: 'default',
                    strokeUniform: true,
                    objectCaching: false
                });
                canvas.add(newPath1);
                segment.path = newPath1;
                graph.updateSegment(segment.id, { controlX: control1x, controlY: control1y });

                // Create second segment
                const endX = originalEndNode?.x ?? 0;
                const endY = originalEndNode?.y ?? 0;

                const pathData2 = createCurvedPathData(x, y, endX, endY, control2x, control2y);
                const newPath2 = new Path(pathData2);
                newPath2.set({
                    stroke: '#666666',
                    strokeWidth: ROAD_WIDTH,
                    fill: '',
                    selectable: false,
                    evented: true,
                    strokeLineCap: 'round',
                    hoverCursor: 'default',
                    strokeUniform: true,
                    objectCaching: false
                });

                canvas.add(newPath2);

                graph.addSegment({
                    id: newSegmentId,
                    startNodeId: newNodeId,
                    endNodeId: originalEndNodeId,
                    path: newPath2,
                    controlX: control2x,
                    controlY: control2y
                });
            }
        }
    }

    return newNodeId;
}
