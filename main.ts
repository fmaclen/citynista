import { Canvas, Line, Point } from 'fabric';
import type { TPointerEventInfo } from 'fabric';

const canvas = new Canvas('canvas', {
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#2a2a2a'
});

let isDrawing: boolean = false;
let currentLine: Line | null = null;

canvas.on('mouse:down', (options: TPointerEventInfo) => {
    isDrawing = true;
    const pointer = options.viewportPoint ?? new Point(0, 0);

    currentLine = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
        stroke: '#666666',
        strokeWidth: 8,
        selectable: false,
        evented: false,
        strokeLineCap: 'round'
    });

    canvas.add(currentLine);
});

canvas.on('mouse:move', (options: TPointerEventInfo) => {
    if (!isDrawing || !currentLine) return;

    const pointer = options.viewportPoint ?? new Point(0, 0);

    currentLine.set({
        x2: pointer.x,
        y2: pointer.y
    });
    canvas.renderAll();
});

canvas.on('mouse:up', () => {
    isDrawing = false;
    currentLine = null;
});

window.addEventListener('resize', () => {
    canvas.setDimensions({
        width: window.innerWidth,
        height: window.innerHeight
    });
    canvas.renderAll();
});
