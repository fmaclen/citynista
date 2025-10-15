import { Canvas, Line, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';
import { RoadGraph, generateId } from './graph';

const ROAD_WIDTH = 8;
const NODE_RADIUS = ROAD_WIDTH;
const SNAP_THRESHOLD = 15;

interface SnapResult {
    snappedX: number;
    snappedY: number;
    snappedNode: import('./graph').NetworkNode | null;
}

function findSnappingTarget(
    graph: RoadGraph,
    x: number,
    y: number,
    excludeNodeIds: string[] = []
): SnapResult {
    const nearbyNode = graph.findNearbyNode(x, y, SNAP_THRESHOLD);

    if (nearbyNode && !excludeNodeIds.includes(nearbyNode.id)) {
        return {
            snappedX: nearbyNode.x,
            snappedY: nearbyNode.y,
            snappedNode: nearbyNode
        };
    }

    return {
        snappedX: x,
        snappedY: y,
        snappedNode: null
    };
}

function updateConnectedSegments(
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

function findNearestSegment(
    graph: RoadGraph,
    x: number,
    y: number,
    excludeSegmentIds: string[] = [],
    threshold: number = 15
): { segment: import('./graph').NetworkSegment; splitX: number; splitY: number } | null {
    let closestSegment: import('./graph').NetworkSegment | null = null;
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

function splitSegmentAtPoint(
    graph: RoadGraph,
    segment: import('./graph').NetworkSegment,
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

function finalizeNodeConnection(
    graph: RoadGraph,
    x: number,
    y: number,
    segmentId: string,
    excludeNodeIds: string[] = []
): string {
    const snapResult = findSnappingTarget(graph, x, y, excludeNodeIds);

    if (snapResult.snappedNode) {
        const existingNode = snapResult.snappedNode;
        existingNode.connectedSegments.push(segmentId);
        graph.updateNode(existingNode.id, existingNode);
        return existingNode.id;
    }

    const nearestSegment = findNearestSegment(graph, x, y, [segmentId]);
    if (nearestSegment) {
        const splitNodeId = splitSegmentAtPoint(
            graph,
            nearestSegment.segment,
            nearestSegment.splitX,
            nearestSegment.splitY
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

type Mode = 'draw' | 'edit';
let currentMode: Mode = 'draw';
let isDrawing: boolean = false;
let currentLine: Line | null = null;
let startNode: Circle | null = null;
let endNode: Circle | null = null;
let selectedLine: Line | null = null;
let isDraggingLine: boolean = false;
let dragStartPoint: Point | null = null;
let lineStartPos: { x1: number; y1: number; x2: number; y2: number } | null = null;
let hoveredLine: Line | null = null;
let isMovingObject = false;
let cursorNode: Circle | null = null;

export function setupCanvas(graph: RoadGraph): Canvas {
    const canvas = new Canvas('canvas', {
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: '#2a2a2a',
        selection: false
    });

    const drawBtn = document.getElementById('draw-btn');

    function toggleMode(): void {
        currentMode = currentMode === 'draw' ? 'edit' : 'draw';
        clearNodes();

        if (currentMode === 'draw') {
            drawBtn?.classList.add('active');
            if (!cursorNode) {
                cursorNode = createNode(0, 0, false);
                cursorNode.set({ opacity: 0.5 });
                canvas.add(cursorNode);
            }
        } else {
            drawBtn?.classList.remove('active');
            if (cursorNode) {
                canvas.remove(cursorNode);
                cursorNode = null;
            }
        }
    }

    drawBtn?.addEventListener('click', toggleMode);

    if (currentMode === 'draw') {
        cursorNode = createNode(0, 0, false);
        cursorNode.set({ opacity: 0.5 });
        canvas.add(cursorNode);
    }

    function createNode(x: number, y: number, selectable: boolean = true): Circle {
        return new Circle({
            left: x,
            top: y,
            radius: NODE_RADIUS,
            fill: 'white',
            originX: 'center',
            originY: 'center',
            selectable: selectable,
            evented: selectable,
            hasControls: false,
            hasBorders: false
        });
    }

    function clearNodes(): void {
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

    function showNodesForLine(line: Line): void {
        if (selectedLine === line && startNode && endNode) {
            return;
        }

        if (selectedLine) {
            selectedLine.set({ stroke: '#666666' });
        }

        clearNodes();
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

    function isPointNearLine(pointer: Point, line: Line, threshold: number = 10): boolean {
        const x1 = line.x1 ?? 0;
        const y1 = line.y1 ?? 0;
        const x2 = line.x2 ?? 0;
        const y2 = line.y2 ?? 0;

        const A = pointer.x - x1;
        const B = pointer.y - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;

        if (lenSq !== 0) {
            param = dot / lenSq;
        }

        let xx: number, yy: number;

        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        const dx = pointer.x - xx;
        const dy = pointer.y - yy;
        const distance = Math.sqrt(dx * dx + dy * dy);

        return distance <= threshold;
    }

    canvas.on('mouse:down', (options: TPointerEventInfo) => {
        const target = options.target;
        const pointer = options.viewportPoint ?? new Point(0, 0);

        if (currentMode === 'edit') {
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
                showNodesForLine(target);
                return;
            }

            const allObjects = canvas.getObjects();
            for (const obj of allObjects) {
                if (obj instanceof Line && isPointNearLine(pointer, obj, 15)) {
                    showNodesForLine(obj);
                    return;
                }
            }

            clearNodes();
            return;
        }

        if (currentMode === 'draw') {
            clearNodes();

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
        }
    });

    canvas.on('mouse:move', (options: TPointerEventInfo) => {
        const pointer = options.viewportPoint ?? new Point(0, 0);

        if (currentMode === 'draw' && cursorNode && !isDrawing) {
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
            return;
        }

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

        if (currentMode === 'edit') {
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

            return;
        }

        if (hoveredLine) {
            hoveredLine.set({ stroke: '#666666' });
            hoveredLine = null;
            canvas.renderAll();
        }
    });

    canvas.on('mouse:up', () => {
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
            return;
        }

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
    });

    canvas.on('object:moving', (options) => {
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
    });

    canvas.on('object:modified', (options) => {
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
            const nearbyNode = graph.findNearbyNode(left, top, 15);

            if (nearbyNode && nearbyNode.id !== currentNodeId && nearbyNode.id !== otherNodeId) {
                const oldNodeId = currentNodeId;
                const newNodeId = nearbyNode.id;

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

                if (!nearbyNode.connectedSegments.includes(segment.id)) {
                    nearbyNode.connectedSegments.push(segment.id);
                }

                graph.updateNode(newNodeId, nearbyNode);
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
    });

    window.addEventListener('resize', () => {
        canvas.setDimensions({
            width: window.innerWidth,
            height: window.innerHeight
        });
        canvas.renderAll();
    });

    window.addEventListener('keydown', (event) => {
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
            clearNodes();
        }
    });

    return canvas;
}
