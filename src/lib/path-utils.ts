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
	(path as { path: string | (string | number)[][] }).path = pathData;
	path.setCoords();
}
