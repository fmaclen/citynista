import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { LaneEndpoint } from '../core/lane-connections';
import { nodeHitAt, segmentHitAt } from './picking';

// The lane connector: a transient mode scoped to one junction (entered by
// double-clicking it). Each travel lane shows a dot at its mouth — a filled
// disc where traffic enters the node, a hollow ring where it leaves. Drag
// between an in dot and an out dot on different arms to toggle that movement
// (either direction works); the junction pavement recarves when a corner's
// movements are all gone.
//
// The mode is modal: while it's open nothing else hovers or selects. Clicking a
// road or node is ignored (so you can't accidentally grab the road next door);
// leave with Escape or a click on empty ground.
export function setupConnectorMode(editor: Editor): ModeHandlers {
	editor.refreshConnectors();
	const canvas = editor.sceneManager.getCanvas();

	let dragStart: LaneEndpoint | null = null;
	// A mousedown on empty ground becomes an exit on mouseup, unless it turned
	// into a drag.
	let pendingExit = false;

	const setCursor = (cursor: string) => {
		canvas.style.cursor = cursor;
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		dragStart = editor.connectorEndpointNear(world.x, world.z);
		if (dragStart) {
			pendingExit = false;
			setCursor('grabbing');
			return;
		}
		// Only empty ground leaves the mode; clicking a road or node is ignored.
		const onSomething =
			!!nodeHitAt(editor, world.x, world.z).node ||
			!!segmentHitAt(editor, world.x, world.z).segment;
		pendingExit = !onSomething;
	};

	const onMouseMove = (event: MouseEvent) => {
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (dragStart) {
			// Keep the source lit and its movements shown; the rubber band tracks
			// the cursor toward whichever target you drop on.
			editor.connectionRenderer.setHovered(dragStart.ref);
			editor.connectionRenderer.showRubberBand(dragStart.point, { x: world.x, y: world.z });
			return;
		}

		const over = editor.connectorEndpointNear(world.x, world.z);
		editor.connectionRenderer.setHovered(over?.ref ?? null);
		setCursor(over ? 'grab' : 'default');
	};

	const onMouseUp = (event: MouseEvent) => {
		editor.connectionRenderer.hideRubberBand();
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (dragStart) {
			const end = editor.connectorEndpointNear(world.x, world.z);
			// One end must enter the node and the other leave it, on different arms;
			// drag direction doesn't matter.
			if (end && end.flow !== dragStart.flow && end.ref.segmentId !== dragStart.ref.segmentId) {
				const incoming = dragStart.flow === 'in' ? dragStart : end;
				const outgoing = dragStart.flow === 'in' ? end : dragStart;
				editor.toggleConnection(incoming.ref, outgoing.ref);
			}
			dragStart = null;
			setCursor(end ? 'grab' : 'default');
			return;
		}

		if (pendingExit) {
			pendingExit = false;
			editor.exitConnectorMode();
		}
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			editor.exitConnectorMode();
		}
	};

	const cleanup = () => {
		dragStart = null;
		setCursor('default');
		editor.connectionRenderer.clear();
	};

	return { onMouseDown, onMouseMove, onMouseUp, onKeyDown, cleanup };
}
