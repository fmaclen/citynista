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
 * Renders lanes along a curved bezier segment
 * Uses parallel bezier curves for smooth continuous lanes
 */
export function renderCurvedLanes(
	config: LaneRenderConfig,
	canvas: Canvas
): (Rect | Path)[] {
	const objects: (Rect | Path)[] = [];
	const { startX, startY, controlX, controlY, endX, endY, lanes } = config;

	// Calculate total width to center the lane group (convert meters to pixels)
	const totalWidth = lanes.reduce((sum, lane) => sum + lane.width * METERS_TO_PIXELS, 0);
	const halfWidth = totalWidth / 2;

	// Position each lane perpendicular to the curve
	let lanePosition = -halfWidth; // Start from one side

	for (const lane of lanes) {
		// Convert lane width from meters to pixels
		const laneWidthPx = lane.width * METERS_TO_PIXELS;

		// This lane's center offset from the segment centerline
		const edgeOffset = lanePosition + laneWidthPx / 2;

		// Calculate offset control point for this lane's parallel curve
		const startNormal = getBezierNormal(startX, startY, controlX, controlY, endX, endY, 0);
		const endNormal = getBezierNormal(startX, startY, controlX, controlY, endX, endY, 1);
		const midNormal = getBezierNormal(startX, startY, controlX, controlY, endX, endY, 0.5);

		// Offset start, end, and control points
		const offsetStartX = startX + startNormal.x * edgeOffset;
		const offsetStartY = startY + startNormal.y * edgeOffset;
		const offsetEndX = endX + endNormal.x * edgeOffset;
		const offsetEndY = endY + endNormal.y * edgeOffset;
		const offsetControlX = controlX + midNormal.x * edgeOffset;
		const offsetControlY = controlY + midNormal.y * edgeOffset;

		// Create path data for this lane's curve
		const pathData = `M ${offsetStartX} ${offsetStartY} Q ${offsetControlX} ${offsetControlY} ${offsetEndX} ${offsetEndY}`;

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
