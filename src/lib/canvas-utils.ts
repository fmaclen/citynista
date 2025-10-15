import { Circle, Path, Point, Canvas } from 'fabric';
import { NODE_RADIUS, ROAD_WIDTH } from './types';

export function createNode(x: number, y: number, selectable: boolean = true): Circle {
	return new Circle({
		left: x,
		top: y,
		radius: NODE_RADIUS * 1.2,
		fill: 'white',
		originX: 'center',
		originY: 'center',
		selectable: selectable,
		evented: selectable,
		hasControls: false,
		hasBorders: false,
		strokeUniform: true
	});
}

export function createBezierHandle(x: number, y: number): Circle {
	return new Circle({
		left: x,
		top: y,
		radius: NODE_RADIUS * 1.2,
		fill: 'transparent',
		stroke: 'white',
		strokeWidth: 2,
		originX: 'center',
		originY: 'center',
		selectable: true,
		evented: true,
		hasControls: false,
		hasBorders: false,
		strokeUniform: true
	});
}

export function isPointNearPath(pointer: Point, path: Path, threshold: number = 24): boolean {
	const pathArray = path.path;
	if (!pathArray || pathArray.length === 0) return false;

	const moveCmd = pathArray[0];
	const quadCmd = pathArray[1];
	if (!moveCmd || !quadCmd || !Array.isArray(moveCmd) || !Array.isArray(quadCmd)) return false;

	const x1 = moveCmd[1] as number;
	const y1 = moveCmd[2] as number;
	const cx = quadCmd[1] as number;
	const cy = quadCmd[2] as number;
	const x2 = quadCmd[3] as number;
	const y2 = quadCmd[4] as number;

	let minDistance = Infinity;
	for (let t = 0; t <= 1; t += 0.05) {
		const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
		const y = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;

		const dx = pointer.x - x;
		const dy = pointer.y - y;
		const distance = Math.sqrt(dx * dx + dy * dy);

		if (distance < minDistance) {
			minDistance = distance;
		}
	}

	return minDistance <= threshold;
}

export interface SegmentPathOptions {
	selected?: boolean;
	stroke?: string;
	strokeWidth?: number;
}

export function createSegmentPath(
	pathData: string,
	canvas: Canvas,
	options: SegmentPathOptions = {}
): Path {
	const { selected = false, stroke = '#666666', strokeWidth = ROAD_WIDTH } = options;

	const path = new Path(pathData);
	path.set({
		stroke: selected ? '#999999' : stroke,
		strokeWidth: selected ? 5 : strokeWidth,
		fill: '',
		selectable: false,
		evented: false,
		strokeLineCap: 'round',
		hoverCursor: 'default',
		strokeUniform: true,
		objectCaching: false,
		perPixelTargetFind: false
	});
	canvas.add(path);
	return path;
}
