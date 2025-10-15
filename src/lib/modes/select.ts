import type { Editor } from '../editor.svelte';
import type { TPointerEventInfo } from 'fabric';
import type { Segment } from '../segment.svelte';

export function setupSelect(editor: Editor) {
	if (!editor.canvas) throw new Error('Canvas not initialized');

	editor.canvas.defaultCursor = 'default';

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Delete' || e.key === 'Backspace') {
			editor.deleteSelected();
		}
	};

	return {
		onMouseDown(e: TPointerEventInfo) {
			const pointer = e.viewportPoint;
			if (!pointer) return;

			const clickedSegment = findSegmentAtPoint(editor, pointer);

			if (clickedSegment) {
				editor.clearSelection();
				editor.selectSegment(clickedSegment.id);
			} else {
				editor.clearSelection();
			}
		},

		onMouseMove() {},

		onMouseUp() {},

		onKeyDown: handleKeyDown,

		cleanup() {
			editor.clearSelection();
		}
	};
}

function findSegmentAtPoint(editor: Editor, point: { x: number; y: number }): Segment | undefined {
	const threshold = 10;

	for (const segment of editor.graph.segments.values()) {
		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);

		if (!startNode || !endNode) continue;

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
	const steps = 20;

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
