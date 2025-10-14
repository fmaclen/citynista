import { Canvas, Line, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';
import { RoadGraph, generateId } from './graph';

const ROAD_WIDTH = 8;
const NODE_RADIUS = ROAD_WIDTH;

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
        } else {
            drawBtn?.classList.remove('active');
        }
    }

    drawBtn?.addEventListener('click', toggleMode);

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

            isDrawing = true;
            const pointer = options.viewportPoint ?? new Point(0, 0);

            currentLine = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
                stroke: '#666666',
                strokeWidth: ROAD_WIDTH,
                selectable: false,
                evented: true,
                strokeLineCap: 'round',
                hoverCursor: 'default',
                strokeUniform: true
            });

            startNode = createNode(pointer.x, pointer.y, false);
            endNode = createNode(pointer.x, pointer.y, false);

            canvas.add(currentLine);
            canvas.add(startNode);
            canvas.add(endNode);
        }
    });

    canvas.on('mouse:move', (options: TPointerEventInfo) => {
        const pointer = options.viewportPoint ?? new Point(0, 0);

        if (isDrawing && currentLine && endNode) {
            currentLine.set({
                x2: pointer.x,
                y2: pointer.y
            });

            endNode.set({
                left: pointer.x,
                top: pointer.y
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
                graph.updateNode(segment.startNodeId, {
                    x: lineStartPos.x1 + dx,
                    y: lineStartPos.y1 + dy
                });

                graph.updateNode(segment.endNodeId, {
                    x: lineStartPos.x2 + dx,
                    y: lineStartPos.y2 + dy
                });
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
                const startNodeId = generateId();
                const endNodeId = generateId();
                const segmentId = generateId();

                graph.addNode({
                    id: startNodeId,
                    x: x1,
                    y: y1,
                    connectedSegments: [segmentId]
                });

                graph.addNode({
                    id: endNodeId,
                    x: x2,
                    y: y2,
                    connectedSegments: [segmentId]
                });

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
    });

    canvas.on('object:moving', (options) => {
        const target = options.target;
        if (!target || !selectedLine) return;

        isMovingObject = true;

        const left = target.left ?? 0;
        const top = target.top ?? 0;

        if (target === startNode) {
            selectedLine.set({ x1: left, y1: top });

            const segment = graph.findSegmentByLine(selectedLine);
            if (segment) {
                graph.updateNode(segment.startNodeId, { x: left, y: top });
            }
        } else if (target === endNode) {
            selectedLine.set({ x2: left, y2: top });

            const segment = graph.findSegmentByLine(selectedLine);
            if (segment) {
                graph.updateNode(segment.endNodeId, { x: left, y: top });
            }
        }

        canvas.renderAll();
    });

    canvas.on('object:modified', () => {
        if (isMovingObject) {
            isMovingObject = false;
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
