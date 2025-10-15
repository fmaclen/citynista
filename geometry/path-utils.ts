export interface PathCoordinates {
    x1: number;
    y1: number;
    cx: number;
    cy: number;
    x2: number;
    y2: number;
}

export function parsePathData(pathData: string | any[]): PathCoordinates | null {
    if (typeof pathData === 'string') {
        const match = pathData.match(/M\s+([\d.]+)\s+([\d.]+)\s+Q\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (!match) return null;
        return {
            x1: parseFloat(match[1]!),
            y1: parseFloat(match[2]!),
            cx: parseFloat(match[3]!),
            cy: parseFloat(match[4]!),
            x2: parseFloat(match[5]!),
            y2: parseFloat(match[6]!)
        };
    } else if (Array.isArray(pathData) && pathData.length >= 2) {
        const moveCmd = pathData[0];
        const quadCmd = pathData[1];
        if (!Array.isArray(moveCmd) || !Array.isArray(quadCmd)) return null;
        return {
            x1: moveCmd[1] as number,
            y1: moveCmd[2] as number,
            cx: quadCmd[1] as number,
            cy: quadCmd[2] as number,
            x2: quadCmd[3] as number,
            y2: quadCmd[4] as number
        };
    }
    return null;
}

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

export function getRelativeControlPoint(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    cx: number,
    cy: number
): { t: number; offset: number } {
    // Calculate the parametric position along the line (0 to 1)
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    if (lineLength === 0) {
        return { t: 0.5, offset: 0 };
    }

    // Project control point onto the line to get t
    const dotProduct = ((cx - x1) * dx + (cy - y1) * dy) / (lineLength * lineLength);
    const t = Math.max(0, Math.min(1, dotProduct));

    // Get the point on the line
    const lineX = x1 + t * dx;
    const lineY = y1 + t * dy;

    // Calculate perpendicular offset
    const offsetX = cx - lineX;
    const offsetY = cy - lineY;
    const offset = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

    // Determine sign of offset (which side of the line)
    const cross = dx * (cy - y1) - dy * (cx - x1);
    const signedOffset = cross >= 0 ? offset : -offset;

    return { t, offset: signedOffset };
}

export function applyRelativeControlPoint(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    t: number,
    offset: number
): { x: number; y: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    if (lineLength === 0) {
        return { x: x1, y: y1 };
    }

    // Point on the line at parameter t
    const lineX = x1 + t * dx;
    const lineY = y1 + t * dy;

    // Perpendicular direction (rotate 90 degrees)
    const perpX = -dy / lineLength;
    const perpY = dx / lineLength;

    // Apply offset perpendicular to the line
    return {
        x: lineX + perpX * offset,
        y: lineY + perpY * offset
    };
}
