import { Canvas, Line, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';
import type { RoadGraph } from '../graph/graph';
import { findSnappingTarget } from '../geometry/snapping';
import { updateConnectedSegments } from '../geometry/connections';
import { splitSegmentAtPoint } from '../geometry/splitting';
import { createNode, isPointNearLine } from '../canvas-utils';

let selectedLine: Line | null = null;
let startNode: Circle | null = null;
let endNode: Circle | null = null;
let isDraggingLine: boolean = false;
let dragStartPoint: Point | null = null;
let lineStartPos: { x1: number; y1: number; x2: number; y2: number } | null = null;
let hoveredLine: Line | null = null;
let isMovingObject = false;

function clearNodes(canvas: Canvas): void {
    if (startNode) {
        canvas.remove(startNode);
        startNode = null;
    }
    if (endNode) {
        canvas.remove(endNode);
        endNode = null;
    }
    if (selectedLine) {
        selectedLine.set({ stroke: '#666666' });
    }
    selectedLine = null;
}

function showNodesForLine(canvas: Canvas, line: Line): void {
    if (selectedLine === line && startNode && endNode) {
        return;
    }

    if (selectedLine) {
        selectedLine.set({ stroke: '#666666' });
    }

    clearNodes(canvas);
    selectedLine = line;
    line.set({ stroke: '#999999' });

    const x1 = line.x1 ?? 0;
    const y1 = line.y1 ?? 0;
    const x2 = line.x2 ?? 0;
    const y2 = line.y2 ?? 0;

    startNode = createNode(x1, y1, true);
    endNode = createNode(x2, y2, true);

    canvas.add(startNode);
    canvas.add(endNode);
    canvas.renderAll();
}

export function setupEditMode(canvas: Canvas, graph: RoadGraph) {
    return {
        onMouseDown: (options: TPointerEventInfo) => {
            const target = options.target;
            const pointer = options.viewportPoint ?? new Point(0, 0);

            if (target && (target === startNode || target === endNode)) {
                return;
            }

            if (selectedLine && isPointNearLine(pointer, selectedLine, 15)) {
                isDraggingLine = true;
                dragStartPoint = new Point(pointer.x, pointer.y);
                lineStartPos = {
                    x1: selectedLine.x1 ?? 0,
                    y1: selectedLine.y1 ?? 0,
                    x2: selectedLine.x2 ?? 0,
                    y2: selectedLine.y2 ?? 0
                };
                return;
            }

            if (target && target instanceof Line) {
                showNodesForLine(canvas, target);
                return;
            }

            const allObjects = canvas.getObjects();
            for (const obj of allObjects) {
                if (obj instanceof Line && isPointNearLine(pointer, obj, 15)) {
                    showNodesForLine(canvas, obj);
                    return;
                }
            }

            clearNodes(canvas);
        },

        onMouseMove: (options: TPointerEventInfo) => {
            const pointer = options.viewportPoint ?? new Point(0, 0);

            if (isDraggingLine && selectedLine && dragStartPoint && lineStartPos) {
                const dx = pointer.x - dragStartPoint.x;
                const dy = pointer.y - dragStartPoint.y;

                selectedLine.set({
                    x1: lineStartPos.x1 + dx,
                    y1: lineStartPos.y1 + dy,
                    x2: lineStartPos.x2 + dx,
                    y2: lineStartPos.y2 + dy
                });

                if (startNode) {
                    startNode.set({
                        left: lineStartPos.x1 + dx,
                        top: lineStartPos.y1 + dy
                    });
                }

                if (endNode) {
                    endNode.set({
                        left: lineStartPos.x2 + dx,
                        top: lineStartPos.y2 + dy
                    });
                }

                const segment = graph.findSegmentByLine(selectedLine);
                if (segment) {
                    const newStartX = lineStartPos.x1 + dx;
                    const newStartY = lineStartPos.y1 + dy;
                    const newEndX = lineStartPos.x2 + dx;
                    const newEndY = lineStartPos.y2 + dy;

                    updateConnectedSegments(graph, segment.startNodeId, newStartX, newStartY);
                    updateConnectedSegments(graph, segment.endNodeId, newEndX, newEndY);
                }

                canvas.renderAll();
                return;
            }

            const target = options.target;

            if (target && (target === startNode || target === endNode)) {
                canvas.defaultCursor = 'move';
                return;
            }

            const allObjects = canvas.getObjects();
            let foundLine: Line | null = null;

            for (const obj of allObjects) {
                if (obj instanceof Line && isPointNearLine(pointer, obj, 15)) {
                    if (obj !== selectedLine) {
                        foundLine = obj;
                    }
                    break;
                }
            }

            if (foundLine !== hoveredLine) {
                if (hoveredLine && hoveredLine !== selectedLine) {
                    hoveredLine.set({ stroke: '#666666' });
                }
                if (foundLine && foundLine !== selectedLine) {
                    foundLine.set({ stroke: '#999999' });
                }
                hoveredLine = foundLine;
                canvas.renderAll();
            }

            if (selectedLine && isPointNearLine(pointer, selectedLine, 15)) {
                canvas.defaultCursor = 'move';
            } else if (foundLine) {
                canvas.defaultCursor = 'pointer';
            } else {
                canvas.defaultCursor = 'default';
            }
        },

        onMouseUp: () => {
            if (isDraggingLine) {
                isDraggingLine = false;
                dragStartPoint = null;
                lineStartPos = null;

                if (startNode) {
                    startNode.setCoords();
                }
                if (endNode) {
                    endNode.setCoords();
                }

                canvas.renderAll();
            }
        },

        onObjectMoving: (options: any) => {
            const target = options.target;
            if (!target || !selectedLine) return;

            isMovingObject = true;

            let left = target.left ?? 0;
            let top = target.top ?? 0;

            const segment = graph.findSegmentByLine(selectedLine);
            if (!segment) return;

            const currentNodeId = target === startNode ? segment.startNodeId : segment.endNodeId;
            const otherNodeId = target === startNode ? segment.endNodeId : segment.startNodeId;

            const snapResult = findSnappingTarget(graph, left, top, [currentNodeId, otherNodeId]);
            left = snapResult.snappedX;
            top = snapResult.snappedY;
            target.set({ left, top });

            if (target === startNode) {
                selectedLine.set({ x1: left, y1: top });
            } else if (target === endNode) {
                selectedLine.set({ x2: left, y2: top });
            }

            updateConnectedSegments(graph, currentNodeId, left, top);

            canvas.renderAll();
        },

        onObjectModified: (options: any) => {
            if (isMovingObject) {
                isMovingObject = false;

                const target = options.target;
                if (!target || !selectedLine) return;

                const segment = graph.findSegmentByLine(selectedLine);
                if (!segment) return;

                const left = target.left ?? 0;
                const top = target.top ?? 0;

                const isStartNode = target === startNode;
                const currentNodeId = isStartNode ? segment.startNodeId : segment.endNodeId;
                const otherNodeId = isStartNode ? segment.endNodeId : segment.startNodeId;

                const snapResult = findSnappingTarget(graph, left, top, [currentNodeId, otherNodeId], [segment.id]);

                if (snapResult.snappedNode) {
                    const oldNodeId = currentNodeId;
                    const newNodeId = snapResult.snappedNode.id;

                    if (isStartNode) {
                        segment.startNodeId = newNodeId;
                    } else {
                        segment.endNodeId = newNodeId;
                    }

                    const oldNode = graph.getNode(oldNodeId);
                    if (oldNode) {
                        oldNode.connectedSegments = oldNode.connectedSegments.filter(id => id !== segment.id);
                        if (oldNode.connectedSegments.length === 0) {
                            graph.deleteNode(oldNodeId);
                        } else {
                            graph.updateNode(oldNodeId, oldNode);
                        }
                    }

                    if (!snapResult.snappedNode.connectedSegments.includes(segment.id)) {
                        snapResult.snappedNode.connectedSegments.push(segment.id);
                    }

                    graph.updateNode(newNodeId, snapResult.snappedNode);
                } else if (snapResult.snappedSegment) {
                    const oldNodeId = currentNodeId;

                    const splitNodeId = splitSegmentAtPoint(
                        graph,
                        snapResult.snappedSegment,
                        snapResult.snappedX,
                        snapResult.snappedY
                    );

                    if (isStartNode) {
                        segment.startNodeId = splitNodeId;
                    } else {
                        segment.endNodeId = splitNodeId;
                    }

                    const oldNode = graph.getNode(oldNodeId);
                    if (oldNode) {
                        oldNode.connectedSegments = oldNode.connectedSegments.filter(id => id !== segment.id);
                        if (oldNode.connectedSegments.length === 0) {
                            graph.deleteNode(oldNodeId);
                        } else {
                            graph.updateNode(oldNodeId, oldNode);
                        }
                    }

                    const splitNode = graph.getNode(splitNodeId);
                    if (splitNode && !splitNode.connectedSegments.includes(segment.id)) {
                        splitNode.connectedSegments.push(segment.id);
                        graph.updateNode(splitNodeId, splitNode);
                    }
                } else {
                    const currentNode = graph.getNode(currentNodeId);
                    if (currentNode) {
                        for (const segmentId of currentNode.connectedSegments) {
                            const connectedSegment = graph.getSegment(segmentId);
                            if (!connectedSegment) continue;

                            if (connectedSegment.startNodeId === currentNodeId) {
                                graph.updateNode(currentNodeId, { x: left, y: top });
                            } else if (connectedSegment.endNodeId === currentNodeId) {
                                graph.updateNode(currentNodeId, { x: left, y: top });
                            }
                        }
                    }
                }
            }
        },

        onKeyDown: (event: KeyboardEvent) => {
            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedLine) {
                const segment = graph.findSegmentByLine(selectedLine);

                if (segment) {
                    const startNetNode = graph.getNode(segment.startNodeId);
                    const endNetNode = graph.getNode(segment.endNodeId);

                    if (startNetNode) {
                        startNetNode.connectedSegments = startNetNode.connectedSegments.filter(id => id !== segment.id);
                        if (startNetNode.connectedSegments.length === 0) {
                            graph.deleteNode(segment.startNodeId);
                        }
                    }

                    if (endNetNode) {
                        endNetNode.connectedSegments = endNetNode.connectedSegments.filter(id => id !== segment.id);
                        if (endNetNode.connectedSegments.length === 0) {
                            graph.deleteNode(segment.endNodeId);
                        }
                    }

                    graph.deleteSegment(segment.id);
                }

                canvas.remove(selectedLine);
                clearNodes(canvas);
            }
        },

        cleanup: () => {
            clearNodes(canvas);
            if (hoveredLine) {
                hoveredLine.set({ stroke: '#666666' });
                hoveredLine = null;
            }
            isDraggingLine = false;
            dragStartPoint = null;
            lineStartPos = null;
            isMovingObject = false;
        }
    };
}
