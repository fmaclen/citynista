import type { Editor } from '../editor.svelte';
import type { TPointerEventInfo } from 'fabric';
import { Path, Circle } from 'fabric';
import { generateId } from '../constants';
import { getDefaultControlPoint, findLineBezierIntersection } from '../path-utils';
import type { NodeData } from '../node.svelte';
import type { SegmentData } from '../segment.svelte';

export function setupDraw(editor: Editor) {
	if (!editor.canvas) throw new Error('Canvas not initialized');

	editor.canvas.defaultCursor = 'crosshair';

	let isDrawing = false;
	let currentStartNodeId: string | null = null;
	let startX = 0;
	let startY = 0;
	let draftPath: Path | null = null;
	let draftStartNode: Circle | null = null;
	let draftEndNode: Circle | null = null;
	let snapIndicator: Circle | null = null;

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			if (isDrawing) {
				cleanupDraft();
			} else {
				editor.mode = undefined;
			}
		}
	};

	const cleanupDraft = () => {
		if (editor.canvas) {
			if (draftPath) editor.canvas.remove(draftPath);
			if (draftStartNode) editor.canvas.remove(draftStartNode);
			if (draftEndNode) editor.canvas.remove(draftEndNode);
			if (snapIndicator) editor.canvas.remove(snapIndicator);
			editor.canvas.renderAll();
		}

		// Remove the start node if it has no segments connected
		if (currentStartNodeId) {
			const startNode = editor.graph.nodes.get(currentStartNodeId);
			if (startNode && startNode.connectedSegments.length === 0) {
				editor.graph.deleteNode(currentStartNodeId);
			}
		}

		isDrawing = false;
		currentStartNodeId = null;
		draftPath = null;
		draftStartNode = null;
		draftEndNode = null;
		snapIndicator = null;
	};

	return {
		onMouseDown(e: TPointerEventInfo) {
			const pointer = e.viewportPoint;
			if (!pointer || !editor.canvas) return;

			if (!isDrawing) {
				const snapTarget = editor.graph.findNearbyNode(pointer.x, pointer.y, 15);
				startX = snapTarget ? snapTarget.x : pointer.x;
				startY = snapTarget ? snapTarget.y : pointer.y;

				if (snapTarget) {
					currentStartNodeId = snapTarget.id;
				} else {
					currentStartNodeId = generateId();
					const nodeData: NodeData = {
						id: currentStartNodeId,
						x: startX,
						y: startY,
						connectedSegments: []
					};
					editor.graph.addNode(nodeData);
				}

				const controlPoint = getDefaultControlPoint(startX, startY, startX, startY);
				draftPath = new Path(
					`M ${startX} ${startY} Q ${controlPoint.x} ${controlPoint.y} ${startX} ${startY}`,
					{
						stroke: '#4299E1',
						strokeWidth: 4,
						fill: '',
						selectable: false,
						evented: false,
						strokeLineCap: 'round',
						strokeLineJoin: 'round',
						opacity: 0.8
					}
				);

				draftStartNode = new Circle({
					left: startX,
					top: startY,
					radius: 6,
					fill: '#4299E1',
					stroke: '#ffffff',
					strokeWidth: 2,
					selectable: false,
					evented: false,
					originX: 'center',
					originY: 'center',
					opacity: 0.8
				});

				draftEndNode = new Circle({
					left: startX,
					top: startY,
					radius: 6,
					fill: '#4299E1',
					stroke: '#ffffff',
					strokeWidth: 2,
					selectable: false,
					evented: false,
					originX: 'center',
					originY: 'center',
					opacity: 0.8
				});

				editor.canvas.add(draftPath);
				editor.canvas.add(draftStartNode);
				editor.canvas.add(draftEndNode);
				editor.canvas.renderAll();

				isDrawing = true;
			} else {
				const endX = pointer.x;
				const endY = pointer.y;
				const dx = endX - startX;
				const dy = endY - startY;
				const length = Math.sqrt(dx * dx + dy * dy);

				if (length >= 10) {
					const snapEnd = editor.graph.findNearbyNode(endX, endY, 15);
					const endNodeId = snapEnd?.id ?? generateId();
					const finalEndX = snapEnd ? snapEnd.x : endX;
					const finalEndY = snapEnd ? snapEnd.y : endY;

					const intersections: Array<{
						segmentId: string;
						x: number;
						y: number;
						t: number;
						distance: number;
					}> = [];

					for (const segment of editor.graph.segments.values()) {
						if (
							segment.startNodeId === currentStartNodeId ||
							segment.endNodeId === currentStartNodeId
						) {
							continue;
						}

						const segmentStartNode = editor.graph.nodes.get(segment.startNodeId);
						const segmentEndNode = editor.graph.nodes.get(segment.endNodeId);

						if (!segmentStartNode || !segmentEndNode) continue;

						const intersection = findLineBezierIntersection(
							startX,
							startY,
							finalEndX,
							finalEndY,
							segmentStartNode.x,
							segmentStartNode.y,
							segment.controlX,
							segment.controlY,
							segmentEndNode.x,
							segmentEndNode.y
						);

						if (intersection) {
							const distFromStart = Math.sqrt(
								(intersection.x - startX) ** 2 + (intersection.y - startY) ** 2
							);
							intersections.push({
								segmentId: segment.id,
								x: intersection.x,
								y: intersection.y,
								t: intersection.t,
								distance: distFromStart
							});
						}
					}

					intersections.sort((a, b) => a.distance - b.distance);

					let currentNodeId = currentStartNodeId!;
					let currentX = startX;
					let currentY = startY;

					for (const intersection of intersections) {
						const intersectionNodeId = generateId();
						editor.graph.splitSegment(
							intersection.segmentId,
							intersectionNodeId,
							intersection.x,
							intersection.y,
							intersection.t
						);

						const controlPoint = getDefaultControlPoint(
							currentX,
							currentY,
							intersection.x,
							intersection.y
						);
						const segmentData: SegmentData = {
							id: generateId(),
							startNodeId: currentNodeId,
							endNodeId: intersectionNodeId,
							controlX: controlPoint.x,
							controlY: controlPoint.y
						};
						editor.graph.addSegment(segmentData);

						currentNodeId = intersectionNodeId;
						currentX = intersection.x;
						currentY = intersection.y;
					}

					if (!snapEnd) {
						const nodeData: NodeData = {
							id: endNodeId,
							x: finalEndX,
							y: finalEndY,
							connectedSegments: []
						};
						editor.graph.addNode(nodeData);
					}

					const controlPoint = getDefaultControlPoint(currentX, currentY, finalEndX, finalEndY);
					const segmentData: SegmentData = {
						id: generateId(),
						startNodeId: currentNodeId,
						endNodeId: endNodeId,
						controlX: controlPoint.x,
						controlY: controlPoint.y
					};

					editor.graph.addSegment(segmentData);

					currentStartNodeId = endNodeId;
					startX = finalEndX;
					startY = finalEndY;

					if (draftStartNode) {
						draftStartNode.set({ left: startX, top: startY });
						draftStartNode.setCoords();
					}
				}
			}
		},

		onMouseMove(e: TPointerEventInfo) {
			const pointer = e.viewportPoint;
			if (!pointer || !editor.canvas) return;

			if (!isDrawing) {
				// Show snap indicator when hovering near nodes
				const snapTarget = editor.graph.findNearbyNode(pointer.x, pointer.y, 15);

				if (snapTarget) {
					if (!snapIndicator) {
						snapIndicator = new Circle({
							left: snapTarget.x,
							top: snapTarget.y,
							radius: 10,
							fill: '',
							stroke: '#4299E1',
							strokeWidth: 2,
							selectable: false,
							evented: false,
							originX: 'center',
							originY: 'center',
							opacity: 0.6
						});
						editor.canvas.add(snapIndicator);
					} else {
						snapIndicator.set({ left: snapTarget.x, top: snapTarget.y });
						snapIndicator.setCoords();
					}
					editor.canvas.renderAll();
				} else if (snapIndicator) {
					editor.canvas.remove(snapIndicator);
					snapIndicator = null;
					editor.canvas.renderAll();
				}
				return;
			}

			if (!draftPath || !draftEndNode) return;

			const snapTarget = editor.graph.findNearbyNode(pointer.x, pointer.y, 15);
			const endX = snapTarget ? snapTarget.x : pointer.x;
			const endY = snapTarget ? snapTarget.y : pointer.y;

			editor.canvas.remove(draftPath);
			const controlPoint = getDefaultControlPoint(startX, startY, endX, endY);
			draftPath = new Path(
				`M ${startX} ${startY} Q ${controlPoint.x} ${controlPoint.y} ${endX} ${endY}`,
				{
					stroke: '#4299E1',
					strokeWidth: 4,
					fill: '',
					selectable: false,
					evented: false,
					strokeLineCap: 'round',
					strokeLineJoin: 'round',
					opacity: 0.8
				}
			);
			editor.canvas.add(draftPath);

			draftEndNode.set({ left: endX, top: endY });
			draftEndNode.setCoords();

			editor.canvas.renderAll();
		},

		onMouseUp() {},

		onKeyDown: handleKeyDown,

		cleanup() {
			cleanupDraft();
			if (editor.canvas) {
				editor.canvas.defaultCursor = 'default';
			}
		}
	};
}
