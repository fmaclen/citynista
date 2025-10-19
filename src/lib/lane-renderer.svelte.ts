import { Rect, type Canvas } from 'fabric';
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
 * Uses multiple small segments to approximate the curve
 */
export function renderCurvedLanes(
	config: LaneRenderConfig,
	canvas: Canvas,
	segmentCount: number = 20
): Rect[] {
	const rects: Rect[] = [];
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

		for (let i = 0; i < segmentCount; i++) {
			const t1 = i / segmentCount;
			const t2 = (i + 1) / segmentCount;

			// Get points on the curve
			const p1 = getBezierPoint(startX, startY, controlX, controlY, endX, endY, t1);
			const p2 = getBezierPoint(startX, startY, controlX, controlY, endX, endY, t2);

			// Get normal at start of this segment
			const n1 = getBezierNormal(startX, startY, controlX, controlY, endX, endY, t1);

			// Calculate segment length
			const segDx = p2.x - p1.x;
			const segDy = p2.y - p1.y;
			const segLength = Math.sqrt(segDx * segDx + segDy * segDy);

			if (segLength < 0.1) continue;

			// Position offset for this lane (perpendicular to curve)
			const offsetX = n1.x * edgeOffset;
			const offsetY = n1.y * edgeOffset;

			// Create rectangle for this curved segment
			const rect = new Rect({
				left: p1.x + offsetX,
				top: p1.y + offsetY,
				width: segLength,
				height: laneWidthPx,
				fill: lane.color,
				stroke: 'transparent',
				selectable: false,
				evented: false,
				originX: 'center',
				originY: 'center',
				angle: (Math.atan2(segDy, segDx) * 180) / Math.PI
			});

			rects.push(rect);
			canvas.add(rect);
		}

		lanePosition += laneWidthPx;
	}

	// Send lanes to back so they render below segment lines
	for (const rect of rects) {
		canvas.sendObjectToBack(rect);
	}

	return rects;
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
