import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { LaneEndpoint } from '../core/lane-connections';
import { nodeHitAt, segmentHitAt } from './picking';

// The lane connector: a transient mode scoped to one junction (entered by
// double-clicking it). Each travel lane shows a dot at its mouth — a filled
// disc where traffic enters the node, a hollow ring where it leaves. Only the
// incoming discs are interactive: drag from one to an outgoing ring on another
// arm to toggle that movement; the junction pavement recarves when a corner's
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

		const near = editor.connectorEndpointNear(world.x, world.z);
		if (near) {
			// Only incoming dots are grabbable; an outgoing ring is a passive target.
			dragStart = near.flow === 'in' ? near : null;
			pendingExit = false;
			if (dragStart) setCursor('grabbing');
			return;
		}

		// No dot: leave only from empty ground; clicking a road or node is ignored.
		const onSomething =
			!!nodeHitAt(editor, world.x, world.z).node ||
			!!segmentHitAt(editor, world.x, world.z).segment;
		pendingExit = !onSomething;
	};

	const onMouseMove = (event: MouseEvent) => {
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (dragStart) {
			editor.connectionRenderer.setHovered(dragStart.ref);
			editor.connectionRenderer.showRubberBand(dragStart.point, { x: world.x, y: world.z });
			return;
		}

		const near = editor.connectorEndpointNear(world.x, world.z);
		const hoverIn = near && near.flow === 'in' ? near : null;
		editor.connectionRenderer.setHovered(hoverIn ? hoverIn.ref : null);
		setCursor(hoverIn ? 'grab' : 'default');
	};

	const onMouseUp = (event: MouseEvent) => {
		editor.connectionRenderer.hideRubberBand();

		if (dragStart) {
			const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
			const near = editor.connectorEndpointNear(world.x, world.z);
			if (near && near.flow === 'out' && near.ref.segmentId !== dragStart.ref.segmentId) {
				editor.toggleConnection(dragStart.ref, near.ref);
			}
			dragStart = null;
			setCursor('default');
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
