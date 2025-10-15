import type { Graph, NetworkSegment } from '../graph/graph.svelte';
import { generateId } from '../graph/graph.svelte';
import { createCurvedPathData, parsePathData } from './path-utils';
import { createSegmentPath } from '../canvas-utils';

export function findNearestSegment(
	graph: Graph,
	x: number,
	y: number,
	excludeSegmentIds: string[] = [],
	threshold: number = 15
): { segment: NetworkSegment; splitX: number; splitY: number } | null {
	let closestSegment: NetworkSegment | null = null;
	let closestDistance = threshold;
	let closestPoint = { x, y };

	for (const [segmentId, segment] of Array.from(graph.getAllSegments().entries())) {
		if (excludeSegmentIds.includes(segmentId)) continue;
		if (!segment.path) continue;

		const coords = parsePathData(segment.path.path);
		if (!coords) continue;

		const { x1, y1, cx, cy, x2, y2 } = coords;

		// Only check midpoint (t=0.5)
		const t = 0.5;
		const qx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
		const qy = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;

		const dx = x - qx;
		const dy = y - qy;
		const dist = Math.sqrt(dx * dx + dy * dy);

		if (dist < closestDistance) {
			closestDistance = dist;
			closestSegment = segment;
			closestPoint = { x: qx, y: qy };
		}
	}

	if (closestSegment) {
		return {
			segment: closestSegment,
			splitX: closestPoint.x,
			splitY: closestPoint.y
		};
	}

	return null;
}

export function splitSegmentAtPoint(
	graph: Graph,
	segment: NetworkSegment,
	x: number,
	y: number
): string {
	const newNodeId = generateId();
	const newSegmentId = generateId();

	const originalEndNodeId = segment.endNodeId;

	graph.addNode({
		id: newNodeId,
		x: x,
		y: y,
		connectedSegments: [segment.id, newSegmentId]
	});

	segment.endNodeId = newNodeId;

	const originalEndNode = graph.getNode(originalEndNodeId);
	if (originalEndNode) {
		originalEndNode.connectedSegments = originalEndNode.connectedSegments.filter(
			(id) => id !== segment.id
		);
		originalEndNode.connectedSegments.push(newSegmentId);
		graph.updateNode(originalEndNodeId, originalEndNode);
	}

	if (segment.path) {
		const canvas = segment.path.canvas;
		const coords = parsePathData(segment.path.path);

		if (coords && canvas) {
			const { x1, y1, cx, cy, x2, y2 } = coords;

			// Find the t parameter where we're splitting the curve
			let bestT = 0.5;
			let minDist = Infinity;
			for (let t = 0; t <= 1; t += 0.01) {
				const qx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
				const qy = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
				const dist = Math.sqrt((x - qx) * (x - qx) + (y - qy) * (y - qy));
				if (dist < minDist) {
					minDist = dist;
					bestT = t;
				}
			}

			// Use De Casteljau's algorithm to split the bezier curve at t
			// This preserves the curve shape perfectly
			const t = bestT;

			// First subdivision: from 0 to t
			const q0x = (1 - t) * x1 + t * cx;
			const q0y = (1 - t) * y1 + t * cy;
			const q1x = (1 - t) * cx + t * x2;
			const q1y = (1 - t) * cy + t * y2;

			// Control point for first segment
			const control1x = q0x;
			const control1y = q0y;

			// Control point for second segment
			const control2x = q1x;
			const control2y = q1y;

			// Update first segment: remove old path and create new one
			canvas.remove(segment.path);

			const pathData1 = createCurvedPathData(x1, y1, x, y, control1x, control1y);
			segment.path = createSegmentPath(pathData1, canvas);
			graph.updateSegment(segment.id, { controlX: control1x, controlY: control1y });

			// Create second segment
			const endX = originalEndNode?.x ?? 0;
			const endY = originalEndNode?.y ?? 0;

			const pathData2 = createCurvedPathData(x, y, endX, endY, control2x, control2y);
			const newPath2 = createSegmentPath(pathData2, canvas);

			graph.addSegment({
				id: newSegmentId,
				startNodeId: newNodeId,
				endNodeId: originalEndNodeId,
				path: newPath2,
				controlX: control2x,
				controlY: control2y
			});
		}
	}

	return newNodeId;
}
