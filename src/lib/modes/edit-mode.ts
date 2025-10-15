import { Canvas, Path, Point, Circle, FabricObject } from 'fabric';
import type { TPointerEventInfo, BasicTransformEvent, ModifiedEvent } from 'fabric';
import type { RoadGraph } from '../graph/graph';
import { findSnappingTarget } from '../geometry/snapping';
import { updateConnectedSegments } from '../geometry/connections';
import { splitSegmentAtPoint } from '../geometry/splitting';
import { createNode, createBezierHandle, isPointNearPath } from '../canvas-utils';
import {
	getRelativeControlPoint,
	applyRelativeControlPoint,
	parsePathData
} from '../geometry/path-utils';
import { SNAP_THRESHOLD } from '../types';

let selectedPath: Path | null = null;
let startNode: Circle | null = null;
let endNode: Circle | null = null;
let bezierHandle: Circle | null = null;
let isDraggingPath: boolean = false;
let dragStartPoint: Point | null = null;
let pathStartPos: {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	cx: number;
	cy: number;
} | null = null;
let hoveredPath: Path | null = null;
let isMovingObject = false;
let debugCircles: Circle[] = [];

function clearDebugVisuals(canvas: Canvas): void {
	debugCircles.forEach((circle) => canvas.remove(circle));
	debugCircles = [];
}

function showDebugHitAreas(canvas: Canvas, graph: RoadGraph): void {
	clearDebugVisuals(canvas);

	// Show node hit areas
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
		// Store reference on the node for updates
		node.debugHitArea = hitArea;
	});

	// Show segment hit areas - only midpoint (t=0.5)
	graph.getAllSegments().forEach((segment) => {
		if (segment.path) {
			const coords = parsePathData(segment.path.path);
			if (coords) {
				const { x1, y1, cx, cy, x2, y2 } = coords;

				// Only show midpoint snap circle
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
				segment.path.debugHitArea = hitArea;
			}
		}
	});

	canvas.renderAll();
}

function clearNodes(canvas: Canvas): void {
	if (startNode) {
		canvas.remove(startNode);
		startNode = null;
	}
	if (endNode) {
		canvas.remove(endNode);
		endNode = null;
	}
	if (bezierHandle) {
		canvas.remove(bezierHandle);
		bezierHandle = null;
	}
	if (selectedPath) {
		selectedPath.set({ stroke: '#666666' });
	}
	selectedPath = null;
}

function showNodesForPath(canvas: Canvas, _graph: RoadGraph, path: Path): void {
	if (selectedPath === path && startNode && endNode && bezierHandle) {
		return;
	}

	if (selectedPath) {
		selectedPath.set({ stroke: '#666666' });
	}

	clearNodes(canvas);
	selectedPath = path;
	path.set({ stroke: '#999999' });

	const coords = parsePathData(path.path);
	if (!coords) return;

	const { x1, y1, cx, cy, x2, y2 } = coords;

	startNode = createNode(x1, y1, true);
	endNode = createNode(x2, y2, true);
	bezierHandle = createBezierHandle(cx, cy);

	canvas.add(startNode);
	canvas.add(endNode);
	canvas.add(bezierHandle);
	canvas.renderAll();
}

export function setupEditMode(canvas: Canvas, graph: RoadGraph) {
	showDebugHitAreas(canvas, graph);

	return {
		onMouseDown: (options: TPointerEventInfo) => {
			const target = options.target;
			const pointer = options.viewportPoint ?? new Point(0, 0);

			if (target && (target === startNode || target === endNode || target === bezierHandle)) {
				return;
			}

			if (selectedPath && isPointNearPath(pointer, selectedPath, 15)) {
				isDraggingPath = true;
				dragStartPoint = new Point(pointer.x, pointer.y);

				const pathArray = selectedPath.path;
				if (pathArray && pathArray.length > 0) {
					const moveCmd = pathArray[0];
					const quadCmd = pathArray[1];
					if (moveCmd && quadCmd && Array.isArray(moveCmd) && Array.isArray(quadCmd)) {
						pathStartPos = {
							x1: moveCmd[1] as number,
							y1: moveCmd[2] as number,
							cx: quadCmd[1] as number,
							cy: quadCmd[2] as number,
							x2: quadCmd[3] as number,
							y2: quadCmd[4] as number
						};
					}
				}
				return;
			}

			if (target && target instanceof Path) {
				showNodesForPath(canvas, graph, target);
				return;
			}

			const allObjects = canvas.getObjects();
			for (const obj of allObjects) {
				if (obj instanceof Path && isPointNearPath(pointer, obj, 24)) {
					showNodesForPath(canvas, graph, obj);
					return;
				}
			}

			clearNodes(canvas);
		},

		onMouseMove: (options: TPointerEventInfo) => {
			const pointer = options.viewportPoint ?? new Point(0, 0);

			if (isDraggingPath && selectedPath && dragStartPoint && pathStartPos) {
				const dx = pointer.x - dragStartPoint.x;
				const dy = pointer.y - dragStartPoint.y;

				const newX1 = pathStartPos.x1 + dx;
				const newY1 = pathStartPos.y1 + dy;
				const newX2 = pathStartPos.x2 + dx;
				const newY2 = pathStartPos.y2 + dy;
				const newCX = pathStartPos.cx + dx;
				const newCY = pathStartPos.cy + dy;

				// Update path in-place
				const segment = graph.findSegmentByPath(selectedPath);
				const pathArray = selectedPath.path;
				if (Array.isArray(pathArray) && pathArray.length >= 2) {
					pathArray[0] = ['M', newX1, newY1];
					pathArray[1] = ['Q', newCX, newCY, newX2, newY2];
					selectedPath.set({ path: pathArray, dirty: true });
				}

				if (startNode) {
					startNode.set({
						left: newX1,
						top: newY1
					});
				}

				if (endNode) {
					endNode.set({
						left: newX2,
						top: newY2
					});
				}

				if (bezierHandle) {
					bezierHandle.set({
						left: newCX,
						top: newCY
					});
				}

				if (segment) {
					updateConnectedSegments(graph, segment.startNodeId, newX1, newY1, segment.id);
					updateConnectedSegments(graph, segment.endNodeId, newX2, newY2, segment.id);
				}

				// Update debug hit area for the segment midpoint
				if (selectedPath && selectedPath.debugHitArea) {
					const t = 0.5;
					const midX = (1 - t) * (1 - t) * newX1 + 2 * (1 - t) * t * newCX + t * t * newX2;
					const midY = (1 - t) * (1 - t) * newY1 + 2 * (1 - t) * t * newCY + t * t * newY2;
					selectedPath.debugHitArea.set({
						left: midX,
						top: midY
					});
				}

				canvas.renderAll();
				return;
			}

			const target = options.target;

			if (target && (target === startNode || target === endNode || target === bezierHandle)) {
				canvas.defaultCursor = 'move';
				return;
			}

			const allObjects = canvas.getObjects();
			let foundPath: Path | null = null;

			for (const obj of allObjects) {
				if (obj instanceof Path && isPointNearPath(pointer, obj, 24)) {
					if (obj !== selectedPath) {
						foundPath = obj;
					}
					break;
				}
			}

			if (foundPath !== hoveredPath) {
				if (hoveredPath && hoveredPath !== selectedPath) {
					hoveredPath.set({ stroke: '#666666' });
				}
				if (foundPath && foundPath !== selectedPath) {
					foundPath.set({ stroke: '#999999' });
				}
				hoveredPath = foundPath;
				canvas.renderAll();
			}

			if (selectedPath && isPointNearPath(pointer, selectedPath, 24)) {
				canvas.defaultCursor = 'move';
			} else if (foundPath) {
				canvas.defaultCursor = 'pointer';
			} else {
				canvas.defaultCursor = 'default';
			}
		},

		onMouseUp: () => {
			if (isDraggingPath) {
				isDraggingPath = false;
				dragStartPoint = null;
				pathStartPos = null;

				if (startNode) {
					startNode.setCoords();
				}
				if (endNode) {
					endNode.setCoords();
				}
				if (bezierHandle) {
					bezierHandle.setCoords();
				}

				canvas.renderAll();
			}
		},

		onObjectMoving: (options: BasicTransformEvent & { target: FabricObject }) => {
			const target = options.target;
			if (!target || !selectedPath) return;

			isMovingObject = true;

			let left = target.left ?? 0;
			let top = target.top ?? 0;

			const segment = graph.findSegmentByPath(selectedPath);
			if (!segment) return;

			const coords = parsePathData(selectedPath.path);
			if (!coords) return;

			let { x1, y1, cx, cy, x2, y2 } = coords;

			if (target === bezierHandle) {
				cx = left;
				cy = top;
				graph.updateSegment(segment.id, { controlX: left, controlY: top });
			} else {
				const currentNodeId = target === startNode ? segment.startNodeId : segment.endNodeId;
				const otherNodeId = target === startNode ? segment.endNodeId : segment.startNodeId;

				// Get all segments connected to the current node to exclude them from snapping
				const currentNode = graph.getNode(currentNodeId);
				const excludeSegments = currentNode ? currentNode.connectedSegments : [];

				const snapResult = findSnappingTarget(
					graph,
					left,
					top,
					[currentNodeId, otherNodeId],
					excludeSegments
				);
				left = snapResult.snappedX;
				top = snapResult.snappedY;
				target.set({ left, top });

				// Calculate relative position of control point before moving
				const relativeControl = getRelativeControlPoint(x1, y1, x2, y2, cx, cy);

				if (target === startNode) {
					x1 = left;
					y1 = top;
				} else if (target === endNode) {
					x2 = left;
					y2 = top;
				}

				// Recalculate control point to maintain relative position
				const newControl = applyRelativeControlPoint(
					x1,
					y1,
					x2,
					y2,
					relativeControl.t,
					relativeControl.offset
				);
				cx = newControl.x;
				cy = newControl.y;
				graph.updateSegment(segment.id, { controlX: cx, controlY: cy });

				updateConnectedSegments(graph, currentNodeId, left, top, segment.id);
			}

			// Update path in-place by modifying the path array directly
			const pathArray = selectedPath.path;
			if (Array.isArray(pathArray) && pathArray.length >= 2) {
				pathArray[0] = ['M', x1, y1];
				pathArray[1] = ['Q', cx, cy, x2, y2];
				selectedPath.set({ path: pathArray, dirty: true });
			}

			// Update bezier handle position
			if (bezierHandle && target !== bezierHandle) {
				bezierHandle.set({
					left: cx,
					top: cy
				});
			}

			// Update debug hit area for the current segment midpoint using updated coordinates
			if (selectedPath && selectedPath.debugHitArea) {
				const t = 0.5;
				const midX = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
				const midY = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
				selectedPath.debugHitArea.set({
					left: midX,
					top: midY
				});
			}

			// Only update node debug circles if we're moving a node (not bezier handle)
			if (target !== bezierHandle) {
				const currentNode = graph.getNode(
					target === startNode ? segment.startNodeId : segment.endNodeId
				);
				if (currentNode && currentNode.debugHitArea) {
					currentNode.debugHitArea.set({
						left: left,
						top: top
					});
				}

				// Update debug hit areas for all OTHER connected segments' midpoints
				if (currentNode) {
					currentNode.connectedSegments.forEach((segId) => {
						if (segId === segment.id) return; // Skip current segment, already updated above

						const seg = graph.getSegment(segId);
						if (seg && seg.path && seg.path.debugHitArea) {
							const coords = parsePathData(seg.path.path);
							if (coords) {
								const t = 0.5;
								const midX =
									(1 - t) * (1 - t) * coords.x1 +
									2 * (1 - t) * t * coords.cx +
									t * t * coords.x2;
								const midY =
									(1 - t) * (1 - t) * coords.y1 +
									2 * (1 - t) * t * coords.cy +
									t * t * coords.y2;
								seg.path.debugHitArea.set({
									left: midX,
									top: midY
								});
							}
						}
					});
				}
			}

			canvas.renderAll();
		},

		onObjectModified: (options: ModifiedEvent & { target: FabricObject }) => {
			if (isMovingObject) {
				isMovingObject = false;

				const target = options.target;
				if (!target || !selectedPath) return;

				const segment = graph.findSegmentByPath(selectedPath);
				if (!segment) return;

				if (target === bezierHandle) {
					return;
				}

				const left = target.left ?? 0;
				const top = target.top ?? 0;

				const isStartNode = target === startNode;
				const currentNodeId = isStartNode ? segment.startNodeId : segment.endNodeId;
				const otherNodeId = isStartNode ? segment.endNodeId : segment.startNodeId;

				const snapResult = findSnappingTarget(
					graph,
					left,
					top,
					[currentNodeId, otherNodeId],
					[segment.id]
				);

				if (snapResult.snappedNode) {
					const oldNodeId = currentNodeId;
					const newNodeId = snapResult.snappedNode.id;

					if (isStartNode) {
						segment.startNodeId = newNodeId;
					} else {
						segment.endNodeId = newNodeId;
					}

					const oldNode = graph.getNode(oldNodeId);
					if (oldNode) {
						oldNode.connectedSegments = oldNode.connectedSegments.filter((id) => id !== segment.id);
						if (oldNode.connectedSegments.length === 0) {
							graph.deleteNode(oldNodeId);
						} else {
							graph.updateNode(oldNodeId, oldNode);
						}
					}

					if (!snapResult.snappedNode.connectedSegments.includes(segment.id)) {
						snapResult.snappedNode.connectedSegments.push(segment.id);
					}

					graph.updateNode(newNodeId, snapResult.snappedNode);
				} else if (snapResult.snappedSegment) {
					const oldNodeId = currentNodeId;

					const splitNodeId = splitSegmentAtPoint(
						graph,
						snapResult.snappedSegment,
						snapResult.snappedX,
						snapResult.snappedY
					);

					if (isStartNode) {
						segment.startNodeId = splitNodeId;
					} else {
						segment.endNodeId = splitNodeId;
					}

					const oldNode = graph.getNode(oldNodeId);
					if (oldNode) {
						oldNode.connectedSegments = oldNode.connectedSegments.filter((id) => id !== segment.id);
						if (oldNode.connectedSegments.length === 0) {
							graph.deleteNode(oldNodeId);
						} else {
							graph.updateNode(oldNodeId, oldNode);
						}
					}

					const splitNode = graph.getNode(splitNodeId);
					if (splitNode && !splitNode.connectedSegments.includes(segment.id)) {
						splitNode.connectedSegments.push(segment.id);
						graph.updateNode(splitNodeId, splitNode);
					}
				} else {
					const currentNode = graph.getNode(currentNodeId);
					if (currentNode) {
						for (const segmentId of currentNode.connectedSegments) {
							const connectedSegment = graph.getSegment(segmentId);
							if (!connectedSegment) continue;

							if (connectedSegment.startNodeId === currentNodeId) {
								graph.updateNode(currentNodeId, { x: left, y: top });
							} else if (connectedSegment.endNodeId === currentNodeId) {
								graph.updateNode(currentNodeId, { x: left, y: top });
							}
						}
					}
				}
			}
		},

		onKeyDown: (event: KeyboardEvent) => {
			if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPath) {
				const segment = graph.findSegmentByPath(selectedPath);

				if (segment) {
					const startNetNode = graph.getNode(segment.startNodeId);
					const endNetNode = graph.getNode(segment.endNodeId);

					if (startNetNode) {
						startNetNode.connectedSegments = startNetNode.connectedSegments.filter(
							(id) => id !== segment.id
						);
						if (startNetNode.connectedSegments.length === 0) {
							graph.deleteNode(segment.startNodeId);
						}
					}

					if (endNetNode) {
						endNetNode.connectedSegments = endNetNode.connectedSegments.filter(
							(id) => id !== segment.id
						);
						if (endNetNode.connectedSegments.length === 0) {
							graph.deleteNode(segment.endNodeId);
						}
					}

					graph.deleteSegment(segment.id);
				}

				canvas.remove(selectedPath);
				clearNodes(canvas);
			}
		},

		cleanup: () => {
			clearNodes(canvas);
			clearDebugVisuals(canvas);
			if (hoveredPath) {
				hoveredPath.set({ stroke: '#666666' });
				hoveredPath = null;
			}
			isDraggingPath = false;
			dragStartPoint = null;
			pathStartPos = null;
			isMovingObject = false;
		}
	};
}
