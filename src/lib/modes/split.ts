import * as THREE from 'three';
import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { ModeHandlers } from './types';
import { segmentHitAt } from './picking';
import { splitSegment } from '../core/crossings';
import { closestOnRoad, roadAt } from '../core/road-line';
import { NODE_Y_OFFSET, nodeRingGeometry } from '../rendering/node-renderer';

const MARKER_COLOR = 0xfacc15;
// Sit the marker at the node ring's exact height so it doesn't drift on screen
// against the node that replaces it once a tilted camera projects them.
const MARKER_Y = NODE_Y_OFFSET;

export function setupSplitMode(editor: Editor): ModeHandlers {
	const markerMaterial = new THREE.MeshBasicMaterial({
		color: MARKER_COLOR,
		transparent: true,
		opacity: 0.9
	});
	// Previews the node the cut makes: a node ring, sized on screen like one.
	const marker = new THREE.Mesh(nodeRingGeometry(), markerMaterial);
	marker.rotation.x = -Math.PI / 2;
	marker.position.y = MARKER_Y;
	marker.visible = false;
	editor.sceneManager.scene.add(marker);
	editor.sceneManager.screenSized.set(marker, Infinity);

	let target: { segment: Segment; x: number; y: number; t: number } | null = null;

	const updateTarget = (worldX: number, worldZ: number) => {
		target = null;
		marker.visible = false;
		editor.setHoveredSegment(null);

		const { segment, score } = segmentHitAt(editor, worldX, worldZ);
		if (!segment || score >= 1) return;
		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) return;

		// Where along the road the pointer is (the road as drawn, offset and
		// all); the cut itself lands on the segment's line, where nodes live.
		const closest = closestOnRoad(editor.graph, segment, worldX, worldZ);
		const on = roadAt(editor.graph, segment, closest.t);
		if (!on) return;
		if (closest.t < 0.02 || closest.t > 0.98) return;

		// Too close to an endpoint would stack nodes — also stops a second click
		// landing right beside a node just placed (it is now an endpoint here).
		// The gap is the road's half width plus 2 m, half again; zoomed in far
		// enough that a node ring is smaller, the ring sets it instead, so a
		// cut can land as close as you can aim.
		const gap = 1.5 * Math.min(segment.totalWidth / 2 + 2, editor.nodeRingRadius());
		const nearStart = Math.hypot(on.line.x - startNode.x, on.line.y - startNode.y);
		const nearEnd = Math.hypot(on.line.x - endNode.x, on.line.y - endNode.y);
		if (Math.min(nearStart, nearEnd) < gap) return;

		editor.setHoveredSegment(segment.id);
		marker.position.set(on.point.x, MARKER_Y, on.point.y);
		marker.visible = true;
		target = { segment, x: on.line.x, y: on.line.y, t: closest.t };
	};

	const onMouseMove = (event: MouseEvent) => {
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		updateTarget(worldPos.x, worldPos.z);
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		updateTarget(worldPos.x, worldPos.z);
		if (!target) return;

		const node = editor.graph.createNode(target.x, target.y);
		editor.nodeRenderer.createNode(node);
		splitSegment(editor.graph, target.segment, target.t, node.id);
		marker.visible = false;
		target = null;
		editor.setHoveredSegment(null);
		editor.rebuildRoads();
		// Select the fresh node so the cut reads as confirmed.
		editor.clearSelection();
		editor.selectNode(node.id);
		editor.graph.save();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') editor.mode = 'select';
	};

	const cleanup = () => {
		editor.setHoveredSegment(null);
		editor.sceneManager.scene.remove(marker);
		editor.sceneManager.screenSized.delete(marker);
		marker.geometry.dispose();
		markerMaterial.dispose();
	};

	return { onMouseDown, onMouseMove, onKeyDown, cleanup };
}
