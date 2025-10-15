import { Canvas, Path, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';
import type { RoadGraph } from '../graph/graph';
import { generateId } from '../graph/graph';
import { findSnappingTarget } from '../geometry/snapping';
import { finalizeNodeConnection } from '../geometry/connections';
import { createNode } from '../canvas-utils';
import { ROAD_WIDTH } from '../types';
import { createCurvedPathData, getDefaultControlPoint } from '../geometry/path-utils';

let isDrawing: boolean = false;
let currentPath: Path | null = null;
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

            const pathData = createCurvedPathData(startX, startY, startX, startY, startX, startY);
            currentPath = new Path(pathData);
            currentPath.set({
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

            startNode = createNode(startX, startY, false);
            endNode = createNode(startX, startY, false);

            canvas.add(currentPath);
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

            if (isDrawing && currentPath && endNode && startNode) {
                const snapResult = findSnappingTarget(graph, pointer.x, pointer.y);

                const x1 = startNode.left ?? 0;
                const y1 = startNode.top ?? 0;
                const x2 = snapResult.snappedX;
                const y2 = snapResult.snappedY;

                // Remove old path and create new one
                canvas.remove(currentPath);

                const control = getDefaultControlPoint(x1, y1, x2, y2);
                const newPathData = createCurvedPathData(x1, y1, x2, y2, control.x, control.y);

                currentPath = new Path(newPathData);
                currentPath.set({
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

                canvas.add(currentPath);

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

            if (currentPath) {
                const pathData: string | any[] = currentPath.path as any;

                let x1: number, y1: number, x2: number, y2: number;

                // Parse the path (can be string or array)
                if (typeof pathData === 'string') {
                    const match = pathData.match(/M\s+([\d.]+)\s+([\d.]+)\s+Q\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
                    if (!match) {
                        canvas.remove(currentPath);
                        currentPath = null;
                        if (startNode) canvas.remove(startNode);
                        if (endNode) canvas.remove(endNode);
                        startNode = null;
                        endNode = null;
                        if (cursorNode) cursorNode.set({ opacity: 0.5 });
                        return;
                    }
                    x1 = parseFloat(match[1]!);
                    y1 = parseFloat(match[2]!);
                    x2 = parseFloat(match[5]!);
                    y2 = parseFloat(match[6]!);
                } else if (Array.isArray(pathData) && pathData.length >= 2) {
                    const moveCmd = pathData[0];
                    const quadCmd = pathData[1];
                    if (!Array.isArray(moveCmd) || !Array.isArray(quadCmd)) {
                        canvas.remove(currentPath);
                        currentPath = null;
                        if (startNode) canvas.remove(startNode);
                        if (endNode) canvas.remove(endNode);
                        startNode = null;
                        endNode = null;
                        if (cursorNode) cursorNode.set({ opacity: 0.5 });
                        return;
                    }
                    x1 = moveCmd[1] as number;
                    y1 = moveCmd[2] as number;
                    x2 = quadCmd[3] as number;
                    y2 = quadCmd[4] as number;
                } else {
                    canvas.remove(currentPath);
                    currentPath = null;
                    if (startNode) canvas.remove(startNode);
                    if (endNode) canvas.remove(endNode);
                    startNode = null;
                    endNode = null;
                    if (cursorNode) cursorNode.set({ opacity: 0.5 });
                    return;
                }

                const dx = x2 - x1;
                const dy = y2 - y1;
                const length = Math.sqrt(dx * dx + dy * dy);

                if (length < 50) {
                    canvas.remove(currentPath);
                } else {
                    const segmentId = generateId();
                    const control = getDefaultControlPoint(x1, y1, x2, y2);

                    const startNodeId = finalizeNodeConnection(graph, x1, y1, segmentId);
                    const endNodeId = finalizeNodeConnection(graph, x2, y2, segmentId, [startNodeId]);

                    graph.addSegment({
                        id: segmentId,
                        startNodeId: startNodeId,
                        endNodeId: endNodeId,
                        path: currentPath,
                        controlX: control.x,
                        controlY: control.y
                    });
                }

                canvas.renderAll();
            }

            currentPath = null;

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
            if (currentPath) {
                canvas.remove(currentPath);
                currentPath = null;
            }
            isDrawing = false;
        }
    };
}
