import { Canvas, Line, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';

const canvas = new Canvas('canvas', {
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#2a2a2a',
    selection: false
});

let isDrawing: boolean = false;
let currentLine: Line | null = null;
let startNode: Circle | null = null;
let endNode: Circle | null = null;

const ROAD_WIDTH = 8;
const NODE_RADIUS = ROAD_WIDTH;

canvas.on('mouse:down', (options: TPointerEventInfo) => {
    isDrawing = true;
    const pointer = options.viewportPoint ?? new Point(0, 0);

    currentLine = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
        stroke: '#666666',
        strokeWidth: ROAD_WIDTH,
        selectable: false,
        evented: false,
        strokeLineCap: 'round'
    });

    startNode = new Circle({
        left: pointer.x,
        top: pointer.y,
        radius: NODE_RADIUS,
        fill: 'white',
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false
    });

    endNode = new Circle({
        left: pointer.x,
        top: pointer.y,
        radius: NODE_RADIUS,
        fill: 'white',
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false
    });

    canvas.add(currentLine);
    canvas.add(startNode);
    canvas.add(endNode);
});

canvas.on('mouse:move', (options: TPointerEventInfo) => {
    if (!isDrawing || !currentLine || !endNode) return;

    const pointer = options.viewportPoint ?? new Point(0, 0);

    currentLine.set({
        x2: pointer.x,
        y2: pointer.y
    });

    endNode.set({
        left: pointer.x,
        top: pointer.y
    });

    canvas.renderAll();
});

canvas.on('mouse:up', () => {
    isDrawing = false;
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

window.addEventListener('resize', () => {
    canvas.setDimensions({
        width: window.innerWidth,
        height: window.innerHeight
    });
    canvas.renderAll();
});
