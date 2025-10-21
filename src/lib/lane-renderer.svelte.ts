import { Rect, Path, type Canvas } from 'fabric';
import { getBezierPoint, getBezierNormal } from './path-utils';
import type { Lane } from './lane-config.svelte';

// Scale factor: 1 meter = 10 pixels
const METERS_TO_PIXELS = 10;

export interface LaneRenderConfig {
	startX: number;
	startY: number;
	controlX: number;
	controlY: number;
	endX: number;
	endY: number;
	lanes: Lane[];
	centerOffset: number;
}

/**
 * Renders lanes along a straight segment
 */
export function renderStraightLanes(config: LaneRenderConfig, canvas: Canvas): Rect[] {
	const rects: Rect[] = [];
	const { startX, startY, endX, endY, lanes } = config;

	// Calculate segment direction and length
	const dx = endX - startX;
	const dy = endY - startY;
	const length = Math.sqrt(dx * dx + dy * dy);

	if (length === 0) return rects;

	// Normalize direction along the segment
	const dirX = dx / length;
	const dirY = dy / length;

	// Calculate perpendicular direction (90 degree rotation)
	const perpX = -dirY;
	const perpY = dirX;

	// Calculate total width to center the lane group (convert meters to pixels)
	const totalWidth = lanes.reduce((sum, lane) => sum + lane.width * METERS_TO_PIXELS, 0);
	const halfWidth = totalWidth / 2;

	// Calculate segment midpoint for positioning
	const midX = (startX + endX) / 2;
	const midY = (startY + endY) / 2;

	// Position each lane perpendicular to the segment
	let lanePosition = -halfWidth; // Start from one side

	for (const lane of lanes) {
		// Convert lane width from meters to pixels
		const laneWidthPx = lane.width * METERS_TO_PIXELS;

		// This lane's center offset from the segment centerline
		const edgeOffset = lanePosition + laneWidthPx / 2;

		// Offset perpendicular to segment from the midpoint
		const offsetX = perpX * edgeOffset;
		const offsetY = perpY * edgeOffset;

		const rect = new Rect({
			left: midX + offsetX,
			top: midY + offsetY,
			width: length,
			height: laneWidthPx,
			fill: lane.color,
			stroke: 'transparent',
			selectable: false,
			evented: false,
			originX: 'center',
			originY: 'center',
			angle: (Math.atan2(dirY, dirX) * 180) / Math.PI
		});

		rects.push(rect);
		canvas.add(rect);

		lanePosition += laneWidthPx;
	}

	// Send lanes to back so they render below segment lines
	for (const rect of rects) {
		canvas.sendObjectToBack(rect);
	}

	return rects;
}

/**
 * Calculates the number of sample points needed for smooth curve rendering
 */
function calculateSamplePoints(
	startX: number,
	startY: number,
	controlX: number,
	controlY: number,
	endX: number,
	endY: number
): number {
	// Approximate curve length using control polygon
	const d1 = Math.sqrt((controlX - startX) ** 2 + (controlY - startY) ** 2);
	const d2 = Math.sqrt((endX - controlX) ** 2 + (endY - controlY) ** 2);
	const approxLength = d1 + d2;

	// Use 1 sample point per 5 pixels, minimum 10, maximum 100
	const samples = Math.floor(approxLength / 5);
	return Math.max(10, Math.min(100, samples));
}

/**
 * Renders lanes along a curved bezier segment
 * Uses sampled points along parallel curves for accurate lane widths
 */
export function renderCurvedLanes(config: LaneRenderConfig, canvas: Canvas): (Rect | Path)[] {
	const objects: (Rect | Path)[] = [];
	const { startX, startY, controlX, controlY, endX, endY, lanes } = config;

	// Calculate total width to center the lane group (convert meters to pixels)
	const totalWidth = lanes.reduce((sum, lane) => sum + lane.width * METERS_TO_PIXELS, 0);
	const halfWidth = totalWidth / 2;

	// Calculate number of sample points based on curve length
	const numSamples = calculateSamplePoints(startX, startY, controlX, controlY, endX, endY);

	// Position each lane perpendicular to the curve
	let lanePosition = -halfWidth; // Start from one side

	for (const lane of lanes) {
		// Convert lane width from meters to pixels
		const laneWidthPx = lane.width * METERS_TO_PIXELS;

		// This lane's center offset from the segment centerline
		const edgeOffset = lanePosition + laneWidthPx / 2;

		// Sample points along the curve and offset them
		const pathPoints: { x: number; y: number }[] = [];

		for (let i = 0; i < numSamples; i++) {
			const t = i / (numSamples - 1);

			// Get point on original curve
			const point = getBezierPoint(startX, startY, controlX, controlY, endX, endY, t);

			// Get normal at this point
			const normal = getBezierNormal(startX, startY, controlX, controlY, endX, endY, t);

			// Offset the point perpendicular
			pathPoints.push({
				x: point.x + normal.x * edgeOffset,
				y: point.y + normal.y * edgeOffset
			});
		}

		// Create path data from sampled points
		let pathData = `M ${pathPoints[0].x} ${pathPoints[0].y}`;
		for (let i = 1; i < pathPoints.length; i++) {
			pathData += ` L ${pathPoints[i].x} ${pathPoints[i].y}`;
		}

		// Create a Path with stroke instead of fill
		const path = new Path(pathData, {
			stroke: lane.color,
			strokeWidth: laneWidthPx,
			fill: '',
			selectable: false,
			evented: false,
			strokeLineCap: 'butt',
			strokeLineJoin: 'round'
		});

		objects.push(path);
		canvas.add(path);

		lanePosition += laneWidthPx;
	}

	// Send lanes to back so they render below segment lines
	for (const obj of objects) {
		canvas.sendObjectToBack(obj);
	}

	return objects;
}

/**
 * Determine if a segment is straight or curved
 */
export function isSegmentStraight(
	startX: number,
	startY: number,
	controlX: number,
	controlY: number,
	endX: number,
	endY: number,
	tolerance: number = 1
): boolean {
	const midX = (startX + endX) / 2;
	const midY = (startY + endY) / 2;

	return Math.abs(controlX - midX) < tolerance && Math.abs(controlY - midY) < tolerance;
}
