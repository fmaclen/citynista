import * as THREE from 'three';
import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import { Graph } from '../core/graph.svelte';
import { buildRoadLayers } from '../core/road-geometry';
import { createLanesFrom } from '../core/lane-template';
import { splitSegment } from '../core/crossings';
import { closestPointOnQuadraticBezier } from '../geometry/bezier';
import { RoadRenderer } from '../rendering/road-renderer';

const GHOST_OPACITY = 0.45;
const GHOST_ELEVATION = 0.06;
const GHOST_NODE_RADIUS = 6;
const GHOST_NODE_COLOR = 0xf59e0b;
const GHOST_NODE_SNAPPED_COLOR = 0x4a9eff;
const GHOST_NODE_Y = 0.3;
const MIN_PREVIEW_LENGTH = 1;
const SEGMENT_SNAP_THRESHOLD = 12;
// A segment snap this close to one of its endpoints uses the node instead of
// splitting off a sliver.
const SEGMENT_END_SNAP_DISTANCE = 10;

interface SegmentSnap {
	segment: Segment;
	x: number;
	y: number;
	t: number;
}

type SnapResult =
	| { kind: 'node'; nodeId: string; x: number; y: number }
	| { kind: 'segment'; snap: SegmentSnap; x: number; y: number }
	| { kind: 'free'; x: number; y: number };

export function setupDrawMode(editor: Editor): ModeHandlers {
	let startNodeId: string | null = null;

	const ghostRenderer = new RoadRenderer(editor.sceneManager.scene, {
		opacity: GHOST_OPACITY,
		elevation: GHOST_ELEVATION
	});
	const previewGraph = new Graph();

	const cursorMaterial = new THREE.MeshBasicMaterial({
		color: GHOST_NODE_COLOR,
		transparent: true,
		opacity: 0.6
	});
	const cursorNode = new THREE.Mesh(
		new THREE.CircleGeometry(GHOST_NODE_RADIUS, 32),
		cursorMaterial
	);
	cursorNode.rotation.x = -Math.PI / 2;
	cursorNode.visible = false;
	editor.sceneManager.scene.add(cursorNode);

	const findSegmentSnap = (worldX: number, worldZ: number): SegmentSnap | null => {
		let best: SegmentSnap | null = null;
		let bestDistance = SEGMENT_SNAP_THRESHOLD;

		for (const segment of editor.graph.segments.values()) {
			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

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
			if (closest.distance >= bestDistance) continue;

			// Too close to an endpoint: treat as a node snap on that endpoint.
			if (
				Math.hypot(closest.x - startNode.x, closest.y - startNode.y) < SEGMENT_END_SNAP_DISTANCE ||
				Math.hypot(closest.x - endNode.x, closest.y - endNode.y) < SEGMENT_END_SNAP_DISTANCE
			) {
				continue;
			}

			bestDistance = closest.distance;
			best = { segment, x: closest.x, y: closest.y, t: closest.t };
		}

		return best;
	};

	const resolveSnap = (worldX: number, worldZ: number): SnapResult => {
		const node = editor.graph.findNodeAt(worldX, worldZ);
		if (node) {
			return { kind: 'node', nodeId: node.id, x: node.x, y: node.y };
		}

		const snap = findSegmentSnap(worldX, worldZ);
		if (snap) {
			return { kind: 'segment', snap, x: snap.x, y: snap.y };
		}

		return { kind: 'free', x: worldX, y: worldZ };
	};

	// Turn the snap into a real node to anchor the drawn segment: existing
	// node, a new node splitting the snapped segment (a T junction), or a
	// fresh node in open ground.
	const anchorNodeId = (snap: SnapResult): string => {
		if (snap.kind === 'node') return snap.nodeId;

		const node = editor.graph.createNode(snap.x, snap.y);
		editor.nodeRenderer.createNode(node);

		if (snap.kind === 'segment') {
			splitSegment(editor.graph, snap.snap.segment, snap.snap.t, node.id);
		}

		return node.id;
	};

	const discardOrphanStart = () => {
		if (startNodeId === null) return;

		const node = editor.graph.nodes.get(startNodeId);
		if (node && node.connectedSegments.length === 0) {
			editor.nodeRenderer.removeNode(node.id);
			editor.graph.deleteNode(node.id);
			editor.graph.save();
		}
		startNodeId = null;
	};

	const updatePreview = (worldX: number, worldZ: number) => {
		const snap = resolveSnap(worldX, worldZ);

		cursorNode.visible = true;
		cursorNode.position.set(snap.x, GHOST_NODE_Y, snap.y);
		cursorMaterial.color.setHex(snap.kind === 'free' ? GHOST_NODE_COLOR : GHOST_NODE_SNAPPED_COLOR);

		if (startNodeId === null) {
			ghostRenderer.clear();
			return;
		}

		const startNode = editor.graph.nodes.get(startNodeId);
		if (!startNode) return;

		if (Math.hypot(snap.x - startNode.x, snap.y - startNode.y) < MIN_PREVIEW_LENGTH) {
			ghostRenderer.clear();
			return;
		}

		previewGraph.clear();
		const previewStart = previewGraph.createNode(startNode.x, startNode.y);
		const previewEnd = previewGraph.createNode(snap.x, snap.y);
		previewGraph.createSegment(
			previewStart.id,
			previewEnd.id,
			createLanesFrom(editor.currentLaneTemplateId)
		);
		ghostRenderer.render(buildRoadLayers(previewGraph));
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const snap = resolveSnap(worldPos.x, worldPos.z);

		if (startNodeId === null) {
			startNodeId = anchorNodeId(snap);
			if (snap.kind === 'segment') {
				editor.rebuildRoads();
				editor.graph.save();
			}
		} else {
			const endNodeId = anchorNodeId(snap);

			if (startNodeId !== endNodeId) {
				editor.graph.createSegment(
					startNodeId,
					endNodeId,
					createLanesFrom(editor.currentLaneTemplateId)
				);
				editor.resolveSegmentCrossings();
			}

			editor.rebuildRoads();
			editor.graph.save();
			startNodeId = endNodeId;
			ghostRenderer.clear();
		}

		updatePreview(worldPos.x, worldPos.z);
	};

	const onMouseMove = (event: MouseEvent) => {
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		updatePreview(worldPos.x, worldPos.z);
	};

	// Escape is two-stage: first cancel the segment being drawn, then leave
	// draw mode entirely.
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;

		if (startNodeId !== null) {
			discardOrphanStart();
			ghostRenderer.clear();
		} else {
			editor.mode = 'select';
		}
	};

	const cleanup = () => {
		discardOrphanStart();
		ghostRenderer.dispose();
		editor.sceneManager.scene.remove(cursorNode);
		cursorNode.geometry.dispose();
		cursorMaterial.dispose();
	};

	return {
		onMouseDown,
		onMouseMove,
		onKeyDown,
		cleanup
	};
}
