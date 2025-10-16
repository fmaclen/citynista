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
