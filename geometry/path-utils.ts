export function createCurvedPathData(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    controlX: number,
    controlY: number
): string {
    return `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`;
}

export function getDefaultControlPoint(
    x1: number,
    y1: number,
    x2: number,
    y2: number
): { x: number; y: number } {
    return {
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2
    };
}
