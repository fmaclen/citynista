import { Canvas, Path, Point, Circle } from 'fabric';
import type { TPointerEventInfo } from 'fabric';
import type { Graph } from '../graph/graph.svelte';
import { generateId } from '../graph/graph.svelte';
import { findSnappingTarget } from '../geometry/snapping';
import { finalizeNodeConnection } from '../geometry/connections';
import { createNode, createSegmentPath } from '../canvas-utils';
import {
	createCurvedPathData,
	getDefaultControlPoint,
	parsePathData
} from '../geometry/path-utils';
import { SNAP_THRESHOLD } from '../types';

let isDrawing: boolean = false;
let currentPath: Path | null = null;
let startNode: Circle | null = null;
let endNode: Circle | null = null;
let debugCircles: Circle[] = [];

function showDebugHitAreas(canvas: Canvas, graph: Graph): void {
	// Clear existing debug visuals
	debugCircles.forEach((circle) => canvas.remove(circle));
	debugCircles = [];

	// Show all node hit areas
	graph.getAllNodes().forEach((node) => {
		const hitArea = new Circle({
			left: node.x,
			top: node.y,
			radius: SNAP_THRESHOLD,
			fill: 'rgba(255, 255, 0, 0.25)',
			originX: 'center',
			originY: 'center',
			selectable: false,
			evented: false
		});
		canvas.add(hitArea);
		debugCircles.push(hitArea);
	});

	// Show all segment midpoint hit areas
	graph.getAllSegments().forEach((segment) => {
		if (segment.path) {
			const coords = parsePathData(segment.path.path);
			if (coords) {
				const { x1, y1, cx, cy, x2, y2 } = coords;
				const t = 0.5;
				const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
				const y = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;

				const hitArea = new Circle({
					left: x,
					top: y,
					radius: SNAP_THRESHOLD / 2,
					fill: 'rgba(0, 255, 255, 0.25)',
					originX: 'center',
					originY: 'center',
					selectable: false,
					evented: false
				});
				canvas.add(hitArea);
				debugCircles.push(hitArea);
			}
		}
	});

	canvas.renderAll();
}

export function setupDrawMode(canvas: Canvas, graph: Graph) {
	canvas.defaultCursor = 'crosshair';

	// Show all debug hit areas in draw mode
	showDebugHitAreas(canvas, graph);

	return {
		onMouseDown: (options: TPointerEventInfo) => {
			isDrawing = true;
			const pointer = options.viewportPoint ?? new Point(0, 0);

			const snapResult = findSnappingTarget(graph, pointer.x, pointer.y);
			const startX = snapResult.snappedX;
			const startY = snapResult.snappedY;

			const pathData = createCurvedPathData(startX, startY, startX, startY, startX, startY);
			currentPath = createSegmentPath(pathData, canvas);

			startNode = createNode(startX, startY, false);
			endNode = createNode(startX, startY, false);

			canvas.add(startNode);
			canvas.add(endNode);
		},

		onMouseMove: (options: TPointerEventInfo) => {
			const pointer = options.viewportPoint ?? new Point(0, 0);

			if (isDrawing && currentPath && endNode && startNode) {
				const snapResult = findSnappingTarget(graph, pointer.x, pointer.y);

				const x1 = startNode.left ?? 0;
				const y1 = startNode.top ?? 0;
				const x2 = snapResult.snappedX;
				const y2 = snapResult.snappedY;

				// Remove old path and create new one
				canvas.remove(currentPath);

				const control = getDefaultControlPoint(x1, y1, x2, y2);
				const newPathData = createCurvedPathData(x1, y1, x2, y2, control.x, control.y);

				currentPath = createSegmentPath(newPathData, canvas);

				endNode.set({
					left: snapResult.snappedX,
					top: snapResult.snappedY,
					opacity: 1.0
				});

				canvas.renderAll();
			}
		},

		onMouseUp: () => {
			if (!isDrawing) return;

			isDrawing = false;

			if (currentPath) {
				const pathData = currentPath.path;
				const coords = parsePathData(pathData);

				if (!coords) {
					canvas.remove(currentPath);
					currentPath = null;
					if (startNode) canvas.remove(startNode);
					if (endNode) canvas.remove(endNode);
					startNode = null;
					endNode = null;
					return;
				}

				const { x1, y1, x2, y2 } = coords;

				const dx = x2 - x1;
				const dy = y2 - y1;
				const length = Math.sqrt(dx * dx + dy * dy);

				if (length < 50) {
					canvas.remove(currentPath);
				} else {
					const segmentId = generateId();
					const control = getDefaultControlPoint(x1, y1, x2, y2);

					const startNodeId = finalizeNodeConnection(graph, x1, y1, segmentId);
					const endNodeId = finalizeNodeConnection(graph, x2, y2, segmentId, [startNodeId]);

					graph.addSegment({
						id: segmentId,
						startNodeId: startNodeId,
						endNodeId: endNodeId,
						path: currentPath,
						controlX: control.x,
						controlY: control.y
					});

					// Refresh debug hit areas to include the new segment
					showDebugHitAreas(canvas, graph);
				}

				canvas.renderAll();
			}

			currentPath = null;

			if (startNode) {
				canvas.remove(startNode);
				startNode = null;
			}
			if (endNode) {
				canvas.remove(endNode);
				endNode = null;
			}
		},

		cleanup: () => {
			canvas.defaultCursor = 'default';

			// Clear debug circles
			debugCircles.forEach((circle) => canvas.remove(circle));
			debugCircles = [];

			if (startNode) {
				canvas.remove(startNode);
				startNode = null;
			}
			if (endNode) {
				canvas.remove(endNode);
				endNode = null;
			}
			if (currentPath) {
				canvas.remove(currentPath);
				currentPath = null;
			}
			isDrawing = false;
		}
	};
}
