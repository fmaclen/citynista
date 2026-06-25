import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { LaneEndpoint } from '../core/lane-connections';
import { sameLaneRef } from '../core/lane-connections';
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
			// Feedback: green over a valid exit (an outgoing ring on another arm),
			// red over anything else under the cursor.
			const near = editor.connectorEndpointNear(world.x, world.z);
			const over = near && !sameLaneRef(near.ref, dragStart.ref) ? near : null;
			// Any outgoing dot is a valid drop — a different arm (a turn/through),
			// or the same arm (a U-turn). Cross-median moves and U-turns are added
			// as explicit extras.
			const valid = !!over && over.flow === 'out';
			editor.connectionRenderer.setDragFeedback(dragStart.ref, over ? over.ref : null, valid);
			editor.connectionRenderer.showRubberBand(
				dragStart.point,
				{ x: world.x, y: world.z },
				over ? (valid ? 'valid' : 'invalid') : 'neutral'
			);
			return;
		}

		// Hovering ANY dot (incoming or outgoing) highlights it and every movement
		// that starts or ends there; only incoming dots are grabbable for a drag.
		const near = editor.connectorEndpointNear(world.x, world.z);
		editor.connectionRenderer.setHovered(near ? near.ref : null);
		setCursor(near ? (near.flow === 'in' ? 'grab' : 'pointer') : 'default');
	};

	const onMouseUp = (event: MouseEvent) => {
		editor.connectionRenderer.hideRubberBand();

		if (dragStart) {
			const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
			const near = editor.connectorEndpointNear(world.x, world.z);
			if (near && near.flow === 'out' && !sameLaneRef(near.ref, dragStart.ref)) {
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

	// Double-clicking a lane dot toggles all of its movements off (a dead-end) or,
	// if they're already all off, back on.
	const onDoubleClick = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const near = editor.connectorEndpointNear(world.x, world.z);
		if (near) editor.toggleAllConnections(near);
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

	return { onMouseDown, onMouseMove, onMouseUp, onDoubleClick, onKeyDown, cleanup };
}
