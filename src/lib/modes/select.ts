import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import { distanceToQuadraticBezier } from '../geometry/bezier';

const NODE_HIT_THRESHOLD = 15;
const SEGMENT_HIT_THRESHOLD = 10;
const CONTROL_POINT_HIT_THRESHOLD = 12;

type DragTarget =
	| { type: 'node'; nodeId: string }
	| { type: 'controlPoint'; segmentId: string }
	| null;

export function setupSelectMode(editor: Editor): ModeHandlers {
	let isDragging = false;
	let dragTarget: DragTarget = null;
	let dragStartX = 0;
	let dragStartZ = 0;

	const findNodeAt = (worldX: number, worldZ: number) => {
		return editor.graph.findNodeAt(worldX, worldZ, NODE_HIT_THRESHOLD);
	};

	const findSegmentAt = (worldX: number, worldZ: number) => {
		for (const segment of editor.graph.segments.values()) {
			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
			const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

			const dist = distanceToQuadraticBezier(
				worldX,
				worldZ,
				startNode.x,
				startNode.y,
				cx,
				cy,
				endNode.x,
				endNode.y
			);

			if (dist < SEGMENT_HIT_THRESHOLD) {
				return segment;
			}
		}
		return null;
	};

	const findControlPointAt = (worldX: number, worldZ: number) => {
		for (const segmentId of editor.selectedSegments) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) continue;

			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
			const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

			const dx = worldX - cx;
			const dz = worldZ - cy;
			if (Math.sqrt(dx * dx + dz * dz) < CONTROL_POINT_HIT_THRESHOLD) {
				return segment;
			}
		}
		return null;
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.shiftKey) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		dragStartX = worldPos.x;
		dragStartZ = worldPos.z;

		const controlPointSegment = findControlPointAt(worldPos.x, worldPos.z);
		if (controlPointSegment) {
			isDragging = true;
			dragTarget = { type: 'controlPoint', segmentId: controlPointSegment.id };
			return;
		}

		const node = findNodeAt(worldPos.x, worldPos.z);
		if (node) {
			if (!editor.selectedNodes.has(node.id)) {
				editor.clearSelection();
				editor.selectNode(node.id);
			}
			isDragging = true;
			dragTarget = { type: 'node', nodeId: node.id };
			return;
		}

		const segment = findSegmentAt(worldPos.x, worldPos.z);
		if (segment) {
			editor.clearSelection();
			editor.selectSegment(segment.id);
			editor.selectNode(segment.startNodeId);
			editor.selectNode(segment.endNodeId);
			return;
		}

		editor.clearSelection();
	};

	const onMouseMove = (event: MouseEvent) => {
		if (!isDragging || !dragTarget) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const dx = worldPos.x - dragStartX;
		const dz = worldPos.z - dragStartZ;

		if (dragTarget.type === 'node') {
			for (const nodeId of editor.selectedNodes) {
				const node = editor.graph.nodes.get(nodeId);
				if (node) {
					node.x += dx;
					node.y += dz;
					editor.nodeRenderer.updateNode(node);

					for (const segmentId of node.connectedSegments) {
						const segment = editor.graph.segments.get(segmentId);
						if (segment) {
							const startNode = editor.graph.nodes.get(segment.startNodeId);
							const endNode = editor.graph.nodes.get(segment.endNodeId);
							if (startNode && endNode) {
								editor.segmentRenderer.updateSegment(segment, startNode, endNode);
							}
						}
					}
				}
			}
		} else if (dragTarget.type === 'controlPoint') {
			const segment = editor.graph.segments.get(dragTarget.segmentId);
			if (segment) {
				const startNode = editor.graph.nodes.get(segment.startNodeId);
				const endNode = editor.graph.nodes.get(segment.endNodeId);
				if (startNode && endNode) {
					const currentCx = segment.controlX ?? (startNode.x + endNode.x) / 2;
					const currentCy = segment.controlY ?? (startNode.y + endNode.y) / 2;
					segment.setControlPoint(currentCx + dx, currentCy + dz);
					editor.segmentRenderer.updateSegment(segment, startNode, endNode);
				}
			}
		}

		dragStartX = worldPos.x;
		dragStartZ = worldPos.z;
	};

	const onMouseUp = () => {
		if (isDragging) {
			editor.graph.save();
		}
		isDragging = false;
		dragTarget = null;
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Delete' || event.key === 'Backspace') {
			if (editor.selectedNodes.size > 0 || editor.selectedSegments.size > 0) {
				event.preventDefault();
				editor.deleteSelected();
			}
		} else if (event.key === 'Escape') {
			editor.clearSelection();
		}
	};

	const cleanup = () => {
		isDragging = false;
		dragTarget = null;
	};

	return {
		onMouseDown,
		onMouseMove,
		onMouseUp,
		onKeyDown,
		cleanup
	};
}
