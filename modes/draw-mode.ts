import { Canvas, Line, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';
import type { RoadGraph } from '../graph/graph';
import { generateId } from '../graph/graph';
import { findSnappingTarget } from '../geometry/snapping';
import { finalizeNodeConnection } from '../geometry/connections';
import { createNode } from '../canvas-utils';
import { ROAD_WIDTH } from '../types';

let isDrawing: boolean = false;
let currentLine: Line | null = null;
let startNode: Circle | null = null;
let endNode: Circle | null = null;
let cursorNode: Circle | null = null;

export function setupDrawMode(canvas: Canvas, graph: RoadGraph) {
    if (!cursorNode) {
        cursorNode = createNode(0, 0, false);
        cursorNode.set({ opacity: 0.5 });
        canvas.add(cursorNode);
    }

    return {
        onMouseDown: (options: TPointerEventInfo) => {
            if (cursorNode) {
                cursorNode.set({ opacity: 0 });
            }

            isDrawing = true;
            const pointer = options.viewportPoint ?? new Point(0, 0);

            const snapResult = findSnappingTarget(graph, pointer.x, pointer.y);
            const startX = snapResult.snappedX;
            const startY = snapResult.snappedY;

            currentLine = new Line([startX, startY, startX, startY], {
                stroke: '#666666',
                strokeWidth: ROAD_WIDTH,
                selectable: false,
                evented: true,
                strokeLineCap: 'round',
                hoverCursor: 'default',
                strokeUniform: true
            });

            startNode = createNode(startX, startY, false);
            endNode = createNode(startX, startY, false);

            canvas.add(currentLine);
            canvas.add(startNode);
            canvas.add(endNode);
        },

        onMouseMove: (options: TPointerEventInfo) => {
            const pointer = options.viewportPoint ?? new Point(0, 0);

            if (cursorNode && !isDrawing) {
                const snapResult = findSnappingTarget(graph, pointer.x, pointer.y);
                cursorNode.set({
                    left: snapResult.snappedX,
                    top: snapResult.snappedY,
                    opacity: snapResult.snappedNode ? 1.0 : 0.5
                });
                canvas.renderAll();
            }

            if (isDrawing && currentLine && endNode) {
                const snapResult = findSnappingTarget(graph, pointer.x, pointer.y);

                currentLine.set({
                    x2: snapResult.snappedX,
                    y2: snapResult.snappedY
                });

                endNode.set({
                    left: snapResult.snappedX,
                    top: snapResult.snappedY,
                    opacity: 1.0
                });

                canvas.renderAll();
            }
        },

        onMouseUp: () => {
            if (!isDrawing) return;

            isDrawing = false;

            if (currentLine) {
                const x1 = currentLine.x1 ?? 0;
                const y1 = currentLine.y1 ?? 0;
                const x2 = currentLine.x2 ?? 0;
                const y2 = currentLine.y2 ?? 0;

                const dx = x2 - x1;
                const dy = y2 - y1;
                const length = Math.sqrt(dx * dx + dy * dy);

                if (length < 50) {
                    canvas.remove(currentLine);
                } else {
                    const segmentId = generateId();

                    const startNodeId = finalizeNodeConnection(graph, x1, y1, segmentId);
                    const endNodeId = finalizeNodeConnection(graph, x2, y2, segmentId, [startNodeId]);

                    graph.addSegment({
                        id: segmentId,
                        startNodeId: startNodeId,
                        endNodeId: endNodeId,
                        line: currentLine
                    });
                }
            }

            currentLine = null;

            if (startNode) {
                canvas.remove(startNode);
                startNode = null;
            }
            if (endNode) {
                canvas.remove(endNode);
                endNode = null;
            }

            if (cursorNode) {
                cursorNode.set({ opacity: 0.5 });
            }
        },

        cleanup: () => {
            if (cursorNode) {
                canvas.remove(cursorNode);
                cursorNode = null;
            }
            if (startNode) {
                canvas.remove(startNode);
                startNode = null;
            }
            if (endNode) {
                canvas.remove(endNode);
                endNode = null;
            }
            if (currentLine) {
                canvas.remove(currentLine);
                currentLine = null;
            }
            isDrawing = false;
        }
    };
}
