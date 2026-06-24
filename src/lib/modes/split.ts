import * as THREE from 'three';
import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { ModeHandlers } from './types';
import { segmentHitAt } from './picking';
import { splitSegment } from '../core/crossings';
import { closestPointOnQuadraticBezier } from '../geometry/bezier';
import { NODE_Y_OFFSET } from '../rendering/node-renderer';

const MARKER_COLOR = 0xfacc15;
const MARKER_THICKNESS = 1.2;
// Sit the marker at the node ring's exact height so it doesn't drift on screen
// against the node that replaces it once a tilted camera projects them.
const MARKER_Y = NODE_Y_OFFSET;

export function setupSplitMode(editor: Editor): ModeHandlers {
	const markerMaterial = new THREE.MeshBasicMaterial({
		color: MARKER_COLOR,
		transparent: true,
		opacity: 0.9
	});
	const marker = new THREE.Mesh(new THREE.BufferGeometry(), markerMaterial);
	marker.rotation.x = -Math.PI / 2;
	marker.position.y = MARKER_Y;
	marker.visible = false;
	editor.sceneManager.scene.add(marker);

	let markerRadius = 0;
	const setMarkerRadius = (radius: number) => {
		if (radius === markerRadius) return;
		markerRadius = radius;
		marker.geometry.dispose();
		marker.geometry = new THREE.RingGeometry(radius - MARKER_THICKNESS, radius, 48);
	};

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

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;
		const closest = closestPointOnQuadraticBezier(
			worldX,
			worldZ,
			startNode.x,
			startNode.y,
			cx,
			cy,
			endNode.x,
			endNode.y
		);
		if (closest.t < 0.02 || closest.t > 0.98) return;

		// Too close to an endpoint would stack nodes — also stops a second click
		// landing right beside a node just placed (it is now an endpoint here).
		const radius = editor.nodeRingRadius({ connectedSegments: [segment.id] });
		const nearStart = Math.hypot(closest.x - startNode.x, closest.y - startNode.y);
		const nearEnd = Math.hypot(closest.x - endNode.x, closest.y - endNode.y);
		if (Math.min(nearStart, nearEnd) < radius * 1.5) return;

		editor.setHoveredSegment(segment.id);
		setMarkerRadius(radius);
		marker.position.set(closest.x, MARKER_Y, closest.y);
		marker.visible = true;
		target = { segment, x: closest.x, y: closest.y, t: closest.t };
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
		marker.geometry.dispose();
		markerMaterial.dispose();
	};

	return { onMouseDown, onMouseMove, onKeyDown, cleanup };
}
