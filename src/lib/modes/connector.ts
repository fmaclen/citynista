import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { LaneEndpoint } from '../core/lane-connections';

// The lane connector: a transient mode scoped to one junction (entered by
// double-clicking it). Each travel lane shows a dot at its mouth — cyan where
// traffic enters the node, white where it leaves. Drag from an incoming dot to
// an outgoing dot on another arm to toggle that movement; the junction pavement
// recarves to drop a corner whose movements are all gone. Click empty ground or
// press Escape to leave.
export function setupConnectorMode(editor: Editor): ModeHandlers {
	editor.refreshConnectors();

	let dragSource: LaneEndpoint | null = null;
	// A mousedown that missed every source dot becomes an exit on mouseup,
	// unless it turned into a drag.
	let pendingExit = false;

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		dragSource = editor.connectorEndpointAt(world.x, world.z, 'in');
		pendingExit = dragSource === null;
	};

	const onMouseMove = (event: MouseEvent) => {
		if (!dragSource) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		editor.connectionRenderer.showRubberBand(dragSource.point, { x: world.x, y: world.z });
	};

	const onMouseUp = (event: MouseEvent) => {
		editor.connectionRenderer.hideRubberBand();
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (dragSource) {
			const target = editor.connectorEndpointAt(world.x, world.z, 'out');
			if (target && target.ref.segmentId !== dragSource.ref.segmentId) {
				editor.toggleConnection(dragSource.ref, target.ref);
			}
			dragSource = null;
			return;
		}

		if (pendingExit) {
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
		dragSource = null;
		editor.connectionRenderer.clear();
	};

	return { onMouseDown, onMouseMove, onMouseUp, onKeyDown, cleanup };
}
