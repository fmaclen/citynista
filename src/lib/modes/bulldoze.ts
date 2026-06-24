import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import { pickAt } from './picking';
import { createMarquee } from './marquee';

const DANGER_COLOR = 0xef4444;

// Bulldoze: click demolishes a node (with its segments) or a segment;
// dragging from open ground draws a red marquee that demolishes everything
// contained. Deletion goes through the selection so orphan cleanup, saving,
// and undo all behave exactly like Delete in select mode.
export function setupBulldozeMode(editor: Editor): ModeHandlers {
	const marquee = createMarquee(editor, DANGER_COLOR, 0.15);

	const demolishSelection = () => {
		if (editor.selectedNodes.size === 0 && editor.selectedSegments.size === 0) return;
		editor.deleteSelected();
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const { node, segment } = pickAt(editor, worldPos.x, worldPos.z);

		if (node || segment) {
			editor.clearSelection();
			if (node) editor.selectNode(node.id);
			if (segment) editor.selectSegment(segment.id);
			demolishSelection();
			return;
		}

		marquee.begin(event.clientX, event.clientY);
	};

	const onMouseMove = (event: MouseEvent) => {
		if (marquee.active) {
			marquee.update(event.clientX, event.clientY);
			return;
		}

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const { node, segment } = pickAt(editor, worldPos.x, worldPos.z);
		editor.setHoveredNode(node?.id ?? null);
		editor.setHoveredSegment(segment?.id ?? null);
	};

	const onMouseUp = (event: MouseEvent) => {
		if (!marquee.active) return;

		marquee.update(event.clientX, event.clientY);
		const contents = marquee.contents();
		marquee.end();

		editor.clearSelection();
		for (const nodeId of contents.nodeIds) {
			editor.selectNode(nodeId);
		}
		for (const segmentId of contents.segmentIds) {
			editor.selectSegment(segmentId);
		}
		demolishSelection();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			editor.mode = 'select';
		}
	};

	const cleanup = () => {
		editor.setHoveredNode(null);
		editor.setHoveredSegment(null);
		marquee.dispose();
	};

	return {
		onMouseDown,
		onMouseMove,
		onMouseUp,
		onKeyDown,
		cleanup
	};
}
