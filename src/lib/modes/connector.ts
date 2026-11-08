import type { ModeHandlers } from './types';
import type { ConnectorEndpoint, Editor } from '../editor.svelte';
import { nodeHitAt, segmentHitAt } from './picking';

// The lane connector: a transient mode scoped to one node (entered by
// double-clicking it). Each lane shows a dot at its mouth: a filled disc where
// traffic enters the node, a hollow ring where it leaves, and a filled disc on
// lanes that connect either way (medians, grass, sidewalks). Drag from a disc
// to a dot of the same kind on another road to add that connection, or to
// remove it if it is there; the drawing follows the connections. Every
// crossing at the node shows as a line straight across its road with a
// handle: drag the handle to slide it along the road, double-click it to
// switch the crossing off (a hollow handle) or on again. Dragging between
// the two sidewalk dots of one road adds a crossing there.
//
// The mode is modal: while it's open nothing else hovers or selects. Clicking a
// road or node is ignored (so you can't accidentally grab the road next door);
// leave with Escape or a click on empty ground.
export function setupConnectorMode(editor: Editor): ModeHandlers {
	editor.refreshConnectors();
	const canvas = editor.sceneManager.getCanvas();

	let dragStart: ConnectorEndpoint | null = null;
	// A crosswalk being slid along its road (by its index on the node).
	let crossingDrag: number | null = null;
	// A mousedown on empty ground becomes an exit on mouseup, unless it turned
	// into a drag.
	let pendingExit = false;

	const setCursor = (cursor: string) => {
		canvas.style.cursor = cursor;
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		const crossing = editor.crossingHandleAt(world.x, world.z);
		if (crossing) {
			crossingDrag = crossing.index;
			pendingExit = false;
			setCursor('grabbing');
			return;
		}

		const near = editor.connectorEndpointNear(world.x, world.z);
		if (near) {
			// Only discs are grabbable; an outgoing ring is a passive target.
			dragStart = near.flow !== 'out' ? near : null;
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

		if (crossingDrag !== null) {
			editor.moveCrossing(crossingDrag, world.x, world.z);
			return;
		}

		if (dragStart) {
			// Feedback: green over a lane it can connect to, red over anything
			// else under the cursor.
			const near = editor.connectorEndpointNear(world.x, world.z);
			const over = near && near !== dragStart ? near : null;
			const valid = !!over && editor.canConnect(dragStart, over);
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
		setCursor(near ? (near.flow !== 'out' ? 'grab' : 'pointer') : 'default');
	};

	const onMouseUp = (event: MouseEvent) => {
		editor.connectionRenderer.hideRubberBand();

		if (crossingDrag !== null) {
			crossingDrag = null;
			setCursor('default');
			editor.graph.save();
			return;
		}

		if (dragStart) {
			const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
			const near = editor.connectorEndpointNear(world.x, world.z);
			if (near && near !== dragStart) editor.toggleConnection(dragStart, near);
			dragStart = null;
			setCursor('default');
			return;
		}

		if (pendingExit) {
			pendingExit = false;
			editor.exitConnectorMode();
		}
	};

	// Double-clicking a lane dot drops all of its connections; double-clicking
	// a crossing's handle switches the crossing off or back on.
	const onDoubleClick = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const crossing = editor.crossingHandleAt(world.x, world.z);
		if (crossing) {
			editor.switchCrossing(crossing.index);
			return;
		}
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
		crossingDrag = null;
		setCursor('default');
		editor.connectionRenderer.clear();
	};

	return { onMouseDown, onMouseMove, onMouseUp, onDoubleClick, onKeyDown, cleanup };
}
