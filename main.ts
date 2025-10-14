import { Canvas, Line, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';

const canvas = new Canvas('canvas', {
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#2a2a2a',
    selection: false
});

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

const ROAD_WIDTH = 8;
const NODE_RADIUS = ROAD_WIDTH;

interface NetworkNode {
    id: string;
    x: number;
    y: number;
    connectedSegments: string[];
    circle?: Circle;
}

interface NetworkSegment {
    id: string;
    startNodeId: string;
    endNodeId: string;
    line?: Line;
}

const nodes = new Map<string, NetworkNode>();
const segments = new Map<string, NetworkSegment>();

function generateId(): string {
    return Math.random().toString(36).substring(2, 11);
}

function logGraph(): void {
    console.log('=== Road Network ===');
    console.log('Nodes:', nodes.size);
    nodes.forEach((node, id) => {
        console.log(`  ${id}: (${node.x.toFixed(1)}, ${node.y.toFixed(1)}) - ${node.connectedSegments.length} segments`);
    });
    console.log('Segments:', segments.size);
    segments.forEach((segment, id) => {
        console.log(`  ${id}: ${segment.startNodeId} -> ${segment.endNodeId}`);
    });
}

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

let hoveredLine: Line | null = null;

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

        const segment = Array.from(segments.values()).find(s => s.line === selectedLine);
        if (segment) {
            const startNetNode = nodes.get(segment.startNodeId);
            const endNetNode = nodes.get(segment.endNodeId);

            if (startNetNode) {
                startNetNode.x = lineStartPos.x1 + dx;
                startNetNode.y = lineStartPos.y1 + dy;
            }

            if (endNetNode) {
                endNetNode.x = lineStartPos.x2 + dx;
                endNetNode.y = lineStartPos.y2 + dy;
            }
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

            const newStartNode: NetworkNode = {
                id: startNodeId,
                x: x1,
                y: y1,
                connectedSegments: [segmentId]
            };

            const newEndNode: NetworkNode = {
                id: endNodeId,
                x: x2,
                y: y2,
                connectedSegments: [segmentId]
            };

            const newSegment: NetworkSegment = {
                id: segmentId,
                startNodeId: startNodeId,
                endNodeId: endNodeId,
                line: currentLine
            };

            nodes.set(startNodeId, newStartNode);
            nodes.set(endNodeId, newEndNode);
            segments.set(segmentId, newSegment);
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

    logGraph();
});

canvas.on('object:moving', (options) => {
    const target = options.target;
    if (!target || !selectedLine) return;

    const left = target.left ?? 0;
    const top = target.top ?? 0;

    if (target === startNode) {
        selectedLine.set({ x1: left, y1: top });

        const segment = Array.from(segments.values()).find(s => s.line === selectedLine);
        if (segment) {
            const node = nodes.get(segment.startNodeId);
            if (node) {
                node.x = left;
                node.y = top;
            }
        }
    } else if (target === endNode) {
        selectedLine.set({ x2: left, y2: top });

        const segment = Array.from(segments.values()).find(s => s.line === selectedLine);
        if (segment) {
            const node = nodes.get(segment.endNodeId);
            if (node) {
                node.x = left;
                node.y = top;
            }
        }
    }

    canvas.renderAll();
});

window.addEventListener('resize', () => {
    canvas.setDimensions({
        width: window.innerWidth,
        height: window.innerHeight
    });
    canvas.renderAll();
});
