import type { Editor } from '../editor.svelte';
import type { TPointerEventInfo } from 'fabric';
import type { Segment } from '../segment.svelte';
import type { Node } from '../node.svelte';

type DragTarget =
	| { type: 'node'; node: Node }
	| { type: 'nodes'; nodes: Node[] }
	| { type: 'bezier'; segment: Segment }
	| null;

export function setupSelect(editor: Editor) {
	if (!editor.canvas) throw new Error('Canvas not initialized');

	editor.canvas.defaultCursor = 'default';

	let isDragging = false;
	let dragTarget: DragTarget = null;
	let dragStartX = 0;
	let dragStartY = 0;
	let nodeStartX = 0;
	let nodeStartY = 0;
	const nodesStartPositions: Map<string, { x: number; y: number }> = new Map();

	// Store the proportional position of control points (t value along the line)
	type SegmentControlInfo = {
		startNodeId: string;
		endNodeId: string;
		startNodeX: number;
		startNodeY: number;
		endNodeX: number;
		endNodeY: number;
		controlX: number;
		controlY: number;
	};
	const segmentControlStarts: Map<string, SegmentControlInfo> = new Map();

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			if (editor.selectedSegments.size > 0 || editor.selectedNodes.size > 0) {
				editor.clearSelection();
			} else {
				editor.mode = undefined;
			}
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			editor.deleteSelected();
		}
	};

	return {
		onMouseDown(e: TPointerEventInfo) {
			const pointer = e.viewportPoint;
			if (!pointer) return;

			dragStartX = pointer.x;
			dragStartY = pointer.y;

			// Check if clicking on a node
			const clickedNode = editor.graph.findNearbyNode(pointer.x, pointer.y, 8);
			if (clickedNode) {
				// Check if this node is already part of a multi-node selection
				const isPartOfSelection = editor.selectedNodes.has(clickedNode.id);

				if (isPartOfSelection && editor.selectedNodes.size > 1) {
					// Dragging multiple selected nodes
					isDragging = true;
					const selectedNodesList: Node[] = [];
					nodesStartPositions.clear();

					for (const nodeId of editor.selectedNodes) {
						const node = editor.graph.nodes.get(nodeId);
						if (node) {
							selectedNodesList.push(node);
							nodesStartPositions.set(nodeId, { x: node.x, y: node.y });
						}
					}

					dragTarget = { type: 'nodes', nodes: selectedNodesList };

					// Store starting positions for all segments connected to any selected node
					segmentControlStarts.clear();
					const processedSegments = new Set<string>();

					for (const node of selectedNodesList) {
						for (const segmentId of node.connectedSegments) {
							if (processedSegments.has(segmentId)) continue;
							processedSegments.add(segmentId);

							const segment = editor.graph.segments.get(segmentId);
							if (segment) {
								const startNode = editor.graph.nodes.get(segment.startNodeId);
								const endNode = editor.graph.nodes.get(segment.endNodeId);
								if (startNode && endNode) {
									segmentControlStarts.set(segmentId, {
										startNodeId: segment.startNodeId,
										endNodeId: segment.endNodeId,
										startNodeX: startNode.x,
										startNodeY: startNode.y,
										endNodeX: endNode.x,
										endNodeY: endNode.y,
										controlX: segment.controlX,
										controlY: segment.controlY
									});
								}
							}
						}
					}
				} else {
					// Select and drag single node
					editor.clearSelection();
					editor.selectNode(clickedNode.id);

					isDragging = true;
					dragTarget = { type: 'node', node: clickedNode };
					nodeStartX = clickedNode.x;
					nodeStartY = clickedNode.y;

					// Store starting positions of nodes and control points for connected segments
					segmentControlStarts.clear();
					for (const segmentId of clickedNode.connectedSegments) {
						const segment = editor.graph.segments.get(segmentId);
						if (segment) {
							const startNode = editor.graph.nodes.get(segment.startNodeId);
							const endNode = editor.graph.nodes.get(segment.endNodeId);
							if (startNode && endNode) {
								segmentControlStarts.set(segmentId, {
									startNodeId: segment.startNodeId,
									endNodeId: segment.endNodeId,
									startNodeX: startNode.x,
									startNodeY: startNode.y,
									endNodeX: endNode.x,
									endNodeY: endNode.y,
									controlX: segment.controlX,
									controlY: segment.controlY
								});
							}
						}
					}
				}

				editor.canvas!.defaultCursor = 'grabbing';
				return;
			}

			// Check if clicking on bezier handle of selected segment
			for (const segmentId of editor.selectedSegments) {
				const segment = editor.graph.segments.get(segmentId);
				if (!segment) continue;

				const dx = pointer.x - segment.controlX;
				const dy = pointer.y - segment.controlY;
				const dist = Math.sqrt(dx * dx + dy * dy);

				if (dist < 10) {
					isDragging = true;
					dragTarget = { type: 'bezier', segment };
					editor.canvas!.defaultCursor = 'grabbing';
					return;
				}
			}

			// Check if clicking on a segment
			const clickedSegment = findSegmentAtPoint(editor, pointer);
			if (clickedSegment) {
				editor.clearSelection();
				editor.selectSegment(clickedSegment.id);

				// Prepare for dragging the segment (both nodes)
				isDragging = true;
				const selectedNodesList: Node[] = [];
				nodesStartPositions.clear();

				for (const nodeId of editor.selectedNodes) {
					const node = editor.graph.nodes.get(nodeId);
					if (node) {
						selectedNodesList.push(node);
						nodesStartPositions.set(nodeId, { x: node.x, y: node.y });
					}
				}

				dragTarget = { type: 'nodes', nodes: selectedNodesList };

				// Store starting positions for all segments connected to any selected node
				segmentControlStarts.clear();
				const processedSegments = new Set<string>();

				for (const node of selectedNodesList) {
					for (const segmentId of node.connectedSegments) {
						if (processedSegments.has(segmentId)) continue;
						processedSegments.add(segmentId);

						const segment = editor.graph.segments.get(segmentId);
						if (segment) {
							const startNode = editor.graph.nodes.get(segment.startNodeId);
							const endNode = editor.graph.nodes.get(segment.endNodeId);
							if (startNode && endNode) {
								segmentControlStarts.set(segmentId, {
									startNodeId: segment.startNodeId,
									endNodeId: segment.endNodeId,
									startNodeX: startNode.x,
									startNodeY: startNode.y,
									endNodeX: endNode.x,
									endNodeY: endNode.y,
									controlX: segment.controlX,
									controlY: segment.controlY
								});
							}
						}
					}
				}

				editor.canvas!.defaultCursor = 'grabbing';
			} else {
				editor.clearSelection();
			}
		},

		onMouseMove(e: TPointerEventInfo) {
			const pointer = e.viewportPoint;
			if (!pointer || !editor.canvas) return;

			if (isDragging && dragTarget) {
				const dx = pointer.x - dragStartX;
				const dy = pointer.y - dragStartY;

				if (dragTarget.type === 'node') {
					const newX = nodeStartX + dx;
					const newY = nodeStartY + dy;
					dragTarget.node.x = newX;
					dragTarget.node.y = newY;

					// Reposition control points proportionally for all connected segments
					for (const segmentId of dragTarget.node.connectedSegments) {
						const segment = editor.graph.segments.get(segmentId);
						const info = segmentControlStarts.get(segmentId);
						if (!segment || !info) continue;

						// Get current node positions
						const startNode = editor.graph.nodes.get(info.startNodeId);
						const endNode = editor.graph.nodes.get(info.endNodeId);
						if (!startNode || !endNode) continue;

						// Calculate the proportional position of the control point
						// along the original line from start to end
						const oldLineX = info.endNodeX - info.startNodeX;
						const oldLineY = info.endNodeY - info.startNodeY;

						// Avoid division by zero for very short segments
						const oldLineLen = Math.sqrt(oldLineX * oldLineX + oldLineY * oldLineY);
						if (oldLineLen < 0.001) {
							// For degenerate segments, just use midpoint
							segment.controlX = (startNode.x + endNode.x) / 2;
							segment.controlY = (startNode.y + endNode.y) / 2;
							continue;
						}

						// Vector from start to control point
						const controlVecX = info.controlX - info.startNodeX;
						const controlVecY = info.controlY - info.startNodeY;

						// Project control point onto the line to get t (parametric position)
						const dotProduct =
							(controlVecX * oldLineX + controlVecY * oldLineY) / (oldLineLen * oldLineLen);

						// Perpendicular offset from the line
						const perpX = controlVecX - dotProduct * oldLineX;
						const perpY = controlVecY - dotProduct * oldLineY;

						// Apply the same t and perpendicular offset to the new line
						const newLineX = endNode.x - startNode.x;
						const newLineY = endNode.y - startNode.y;

						segment.controlX = startNode.x + dotProduct * newLineX + perpX;
						segment.controlY = startNode.y + dotProduct * newLineY + perpY;
					}
				} else if (dragTarget.type === 'nodes') {
					// Move all selected nodes together
					for (const node of dragTarget.nodes) {
						const startPos = nodesStartPositions.get(node.id);
						if (startPos) {
							node.x = startPos.x + dx;
							node.y = startPos.y + dy;
						}
					}

					// Reposition control points proportionally for all connected segments
					for (const [segmentId, info] of segmentControlStarts) {
						const segment = editor.graph.segments.get(segmentId);
						if (!segment) continue;

						// Get current node positions
						const startNode = editor.graph.nodes.get(info.startNodeId);
						const endNode = editor.graph.nodes.get(info.endNodeId);
						if (!startNode || !endNode) continue;

						// Calculate the proportional position of the control point
						// along the original line from start to end
						const oldLineX = info.endNodeX - info.startNodeX;
						const oldLineY = info.endNodeY - info.startNodeY;

						// Avoid division by zero for very short segments
						const oldLineLen = Math.sqrt(oldLineX * oldLineX + oldLineY * oldLineY);
						if (oldLineLen < 0.001) {
							// For degenerate segments, just use midpoint
							segment.controlX = (startNode.x + endNode.x) / 2;
							segment.controlY = (startNode.y + endNode.y) / 2;
							continue;
						}

						// Vector from start to control point
						const controlVecX = info.controlX - info.startNodeX;
						const controlVecY = info.controlY - info.startNodeY;

						// Project control point onto the line to get t (parametric position)
						const dotProduct =
							(controlVecX * oldLineX + controlVecY * oldLineY) / (oldLineLen * oldLineLen);

						// Perpendicular offset from the line
						const perpX = controlVecX - dotProduct * oldLineX;
						const perpY = controlVecY - dotProduct * oldLineY;

						// Apply the same t and perpendicular offset to the new line
						const newLineX = endNode.x - startNode.x;
						const newLineY = endNode.y - startNode.y;

						segment.controlX = startNode.x + dotProduct * newLineX + perpX;
						segment.controlY = startNode.y + dotProduct * newLineY + perpY;
					}
				} else if (dragTarget.type === 'bezier') {
					dragTarget.segment.controlX = dragTarget.segment.controlX + dx;
					dragTarget.segment.controlY = dragTarget.segment.controlY + dy;

					dragStartX = pointer.x;
					dragStartY = pointer.y;
				}
			} else {
				// Show hover cursor for interactive elements
				const hoverNode = editor.graph.findNearbyNode(pointer.x, pointer.y, 8);
				if (hoverNode) {
					editor.canvas.defaultCursor = 'grab';
					return;
				}

				// Check bezier handles
				for (const segmentId of editor.selectedSegments) {
					const segment = editor.graph.segments.get(segmentId);
					if (!segment) continue;

					const dx = pointer.x - segment.controlX;
					const dy = pointer.y - segment.controlY;
					const dist = Math.sqrt(dx * dx + dy * dy);

					if (dist < 10) {
						editor.canvas.defaultCursor = 'grab';
						return;
					}
				}

				const hoverSegment = findSegmentAtPoint(editor, pointer);
				if (hoverSegment) {
					editor.canvas.defaultCursor = 'grab';
				} else {
					editor.canvas.defaultCursor = 'default';
				}
			}
		},

		onMouseUp() {
			isDragging = false;
			dragTarget = null;
			segmentControlStarts.clear();
			nodesStartPositions.clear();
			if (editor.canvas) {
				editor.canvas.defaultCursor = 'default';
			}
		},

		onKeyDown: handleKeyDown,

		cleanup() {
			editor.clearSelection();
			isDragging = false;
			dragTarget = null;
			segmentControlStarts.clear();
			nodesStartPositions.clear();
		}
	};
}

function findSegmentAtPoint(editor: Editor, point: { x: number; y: number }): Segment | undefined {
	const threshold = 10; // Half of the 20px hit area stroke width

	for (const segment of editor.graph.segments.values()) {
		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);

		if (!startNode || !endNode) continue;

		// Calculate minimum distance from point to the bezier curve
		const distance = distanceToQuadraticBezier(
			point.x,
			point.y,
			startNode.x,
			startNode.y,
			segment.controlX,
			segment.controlY,
			endNode.x,
			endNode.y
		);

		if (distance < threshold) {
			return segment;
		}
	}

	return undefined;
}

function distanceToQuadraticBezier(
	px: number,
	py: number,
	x1: number,
	y1: number,
	cx: number,
	cy: number,
	x2: number,
	y2: number
): number {
	let minDist = Infinity;
	const steps = 100; // Increased from 20 to 100 for better coverage

	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
		const y = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;

		const dx = px - x;
		const dy = py - y;
		const dist = Math.sqrt(dx * dx + dy * dy);

		if (dist < minDist) {
			minDist = dist;
		}
	}

	return minDist;
}
