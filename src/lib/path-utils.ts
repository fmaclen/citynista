import { Path } from 'fabric';
import { ROAD_WIDTH } from './constants';

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

export function createPath(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	controlX: number,
	controlY: number
): Path {
	const pathData = createCurvedPathData(x1, y1, x2, y2, controlX, controlY);
	return new Path(pathData, {
		stroke: '#ffffff',
		strokeWidth: ROAD_WIDTH,
		fill: '',
		selectable: false,
		evented: false,
		strokeLineCap: 'round',
		strokeLineJoin: 'round'
	});
}

export function updatePathData(
	path: Path,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	controlX: number,
	controlY: number
): void {
	const pathData = createCurvedPathData(x1, y1, x2, y2, controlX, controlY);
	path.set({ path: pathData });
	path.setCoords();
}

export function findLineSegmentIntersection(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x3: number,
	y3: number,
	x4: number,
	y4: number
): { x: number; y: number } | null {
	const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

	if (Math.abs(denom) < 0.0001) {
		return null;
	}

	const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
	const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

	if (t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99) {
		return {
			x: x1 + t * (x2 - x1),
			y: y1 + t * (y2 - y1)
		};
	}

	return null;
}

/**
 * Find intersection between a line and a quadratic bezier curve
 * Line: from (lineX1, lineY1) to (lineX2, lineY2)
 * Bezier: from (curveX1, curveY1) through control (controlX, controlY) to (curveX2, curveY2)
 */
export function findLineBezierIntersection(
	lineX1: number,
	lineY1: number,
	lineX2: number,
	lineY2: number,
	curveX1: number,
	curveY1: number,
	controlX: number,
	controlY: number,
	curveX2: number,
	curveY2: number
): { x: number; y: number; t: number } | null {
	// First check if it's actually a straight line (control point is on the line)
	const midX = (curveX1 + curveX2) / 2;
	const midY = (curveY1 + curveY2) / 2;
	const tolerance = 1;

	if (Math.abs(controlX - midX) < tolerance && Math.abs(controlY - midY) < tolerance) {
		return findLineSegmentIntersection(
			lineX1,
			lineY1,
			lineX2,
			lineY2,
			curveX1,
			curveY1,
			curveX2,
			curveY2
		);
	}

	// Convert line to implicit form: ax + by + c = 0
	const a = lineY2 - lineY1;
	const b = lineX1 - lineX2;
	const c = lineX2 * lineY1 - lineX1 * lineY2;

	// Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
	// Substitute into line equation and solve for t

	// Expand bezier and substitute into line equation
	// This gives us a quadratic equation in t: At² + Bt + C = 0
	const p0x = curveX1,
		p0y = curveY1;
	const p1x = controlX,
		p1y = controlY;
	const p2x = curveX2,
		p2y = curveY2;

	// Coefficients for the quadratic equation
	const A = a * (p0x - 2 * p1x + p2x) + b * (p0y - 2 * p1y + p2y);
	const B = 2 * (a * (p1x - p0x) + b * (p1y - p0y));
	const C = a * p0x + b * p0y + c;

	// Solve quadratic equation
	const discriminant = B * B - 4 * A * C;

	if (discriminant < 0) {
		return null;
	}

	const solutions: number[] = [];

	if (Math.abs(A) < 0.0001) {
		// Linear case
		if (Math.abs(B) > 0.0001) {
			solutions.push(-C / B);
		}
	} else {
		// Quadratic case
		const sqrt_discriminant = Math.sqrt(discriminant);
		solutions.push((-B + sqrt_discriminant) / (2 * A));
		solutions.push((-B - sqrt_discriminant) / (2 * A));
	}

	// Find valid intersection (t in [0,1] for bezier, and point on line segment)
	for (const t of solutions) {
		if (t >= 0 && t <= 1) {
			// Calculate point on bezier at parameter t
			const x = (1 - t) * (1 - t) * p0x + 2 * (1 - t) * t * p1x + t * t * p2x;
			const y = (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * p1y + t * t * p2y;

			// Check if point is on line segment
			const lineT =
				Math.abs(lineX2 - lineX1) > Math.abs(lineY2 - lineY1)
					? (x - lineX1) / (lineX2 - lineX1)
					: (y - lineY1) / (lineY2 - lineY1);

			if (lineT >= 0.01 && lineT <= 0.99) {
				return { x, y, t };
			}
		}
	}

	return null;
}

/**
 * Split a quadratic bezier curve at parameter t
 * Returns new control points for the two resulting curves
 */
export function splitBezierAtT(
	startX: number,
	startY: number,
	controlX: number,
	controlY: number,
	endX: number,
	endY: number,
	t: number
): {
	segment1: { controlX: number; controlY: number };
	segment2: { controlX: number; controlY: number };
	splitX: number;
	splitY: number;
} {
	// De Casteljau's algorithm for quadratic bezier
	// First level interpolation
	const q0x = (1 - t) * startX + t * controlX;
	const q0y = (1 - t) * startY + t * controlY;

	const q1x = (1 - t) * controlX + t * endX;
	const q1y = (1 - t) * controlY + t * endY;

	// Second level interpolation (split point)
	const splitX = (1 - t) * q0x + t * q1x;
	const splitY = (1 - t) * q0y + t * q1y;

	return {
		segment1: { controlX: q0x, controlY: q0y },
		segment2: { controlX: q1x, controlY: q1y },
		splitX,
		splitY
	};
}
