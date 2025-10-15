import { Circle, Line, Point } from 'fabric';
import { NODE_RADIUS } from './types';

export function createNode(x: number, y: number, selectable: boolean = true): Circle {
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

export function isPointNearLine(pointer: Point, line: Line, threshold: number = 10): boolean {
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
