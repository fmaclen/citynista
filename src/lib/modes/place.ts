import * as THREE from 'three';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { ClipboardNodeSnapshot, Editor } from '../editor.svelte';
import type { SegmentClipboard } from '../editor.svelte';
import { cloneLanes } from '../core/lane-template';
import { Graph } from '../core/graph.svelte';
import { buildRoadLayers } from '../core/road-geometry';
import { findCrossingsBetweenSegments } from '../core/crossings';
import { RoadRenderer } from '../rendering/road-renderer';
import { NODE_Y_OFFSET } from '../rendering/node-renderer';

const GHOST_OPACITY = 0.45;
const GHOST_ELEVATION = 0.06;
const NODE_SNAP_PX = 20;
const MARKER_COLOR = 0xfacc15;
const MARKER_THICKNESS = 1.2;
const MARKER_Y = NODE_Y_OFFSET;

interface Translation {
	dx: number;
	dy: number;
}

interface PlacementSnap {
	clipboardNodeId: string;
	existingNodeId: string;
}

interface Placement {
	translation: Translation;
	snap: PlacementSnap | null;
}

export function setupPlaceMode(editor: Editor) {
	const clipboard = editor.pendingPlacement;
	if (!clipboard) return {};

	const centroid = clipboardCentroid(clipboard);
	const ghostRenderer = new RoadRenderer(editor.sceneManager.scene, {
		opacity: GHOST_OPACITY,
		elevation: GHOST_ELEVATION
	});
	const previewGraph = new Graph();
	const markerMaterial = new THREE.MeshBasicMaterial({
		color: MARKER_COLOR,
		transparent: true,
		opacity: 0.9
	});
	const crossingMarkers: THREE.Mesh[] = [];
	let lastPlacement: Placement | null = null;

	const worldPerPixel = () => editor.sceneManager.worldPerPixel();

	const translatedNode = (node: ClipboardNodeSnapshot, translation: Translation) => ({
		x: node.x + translation.dx,
		y: node.y + translation.dy
	});

	const findNodeSnap = (translation: Translation) => {
		const floor = NODE_SNAP_PX * worldPerPixel();
		let best: (PlacementSnap & { distance: number; correction: Translation }) | null = null;

		for (const clipboardNode of clipboard.nodes) {
			const translated = translatedNode(clipboardNode, translation);
			for (const existingNode of editor.graph.nodes.values()) {
				const radius = Math.max(editor.nodeRingRadius(existingNode), floor);
				const distance = Math.hypot(existingNode.x - translated.x, existingNode.y - translated.y);
				if (distance >= radius) continue;
				if (best && distance >= best.distance) continue;

				best = {
					clipboardNodeId: clipboardNode.id,
					existingNodeId: existingNode.id,
					distance,
					correction: {
						dx: existingNode.x - translated.x,
						dy: existingNode.y - translated.y
					}
				};
			}
		}

		return best;
	};

	const resolvePlacement = (worldX: number, worldZ: number): Placement => {
		const base = { dx: worldX - centroid.x, dy: worldZ - centroid.y };
		const snap = findNodeSnap(base);
		if (!snap) return { translation: base, snap: null };

		return {
			translation: {
				dx: base.dx + snap.correction.dx,
				dy: base.dy + snap.correction.dy
			},
			snap: {
				clipboardNodeId: snap.clipboardNodeId,
				existingNodeId: snap.existingNodeId
			}
		};
	};

	const clearCrossingMarkers = () => {
		for (const marker of crossingMarkers) {
			editor.sceneManager.scene.remove(marker);
			marker.geometry.dispose();
		}
		crossingMarkers.length = 0;
	};

	const showCrossingMarkers = () => {
		clearCrossingMarkers();
		const crossings = findCrossingsBetweenSegments(
			previewGraph,
			previewGraph.segments.values(),
			editor.graph,
			editor.graph.segments.values()
		);

		for (const crossing of crossings) {
			const radius = Math.max(4, editor.nodeRingRadius({ connectedSegments: [crossing.segmentB.id] }));
			const marker = new THREE.Mesh(
				new THREE.RingGeometry(radius - MARKER_THICKNESS, radius, 48),
				markerMaterial
			);
			marker.rotation.x = -Math.PI / 2;
			marker.position.set(crossing.x, MARKER_Y, crossing.y);
			editor.sceneManager.scene.add(marker);
			crossingMarkers.push(marker);
		}
	};

	const buildPreview = (placement: Placement) => {
		previewGraph.clear();
		const nodeIds = new SvelteMap<string, string>();

		for (const snapshot of clipboard.nodes) {
			const translated = translatedNode(snapshot, placement.translation);
			const node = previewGraph.createNode(translated.x, translated.y);
			nodeIds.set(snapshot.id, node.id);
		}

		for (const snapshot of clipboard.segments) {
			const startNodeId = nodeIds.get(snapshot.startNodeId);
			const endNodeId = nodeIds.get(snapshot.endNodeId);
			if (!startNodeId || !endNodeId) continue;

			const segment = previewGraph.createSegment(startNodeId, endNodeId, cloneLanes(snapshot.lanes));
			if (snapshot.controlX !== undefined && snapshot.controlY !== undefined) {
				segment.setControlPoint(
					snapshot.controlX + placement.translation.dx,
					snapshot.controlY + placement.translation.dy
				);
			}
		}

		ghostRenderer.render(buildRoadLayers(previewGraph));
		showCrossingMarkers();
	};

	const updatePreview = (worldX: number, worldZ: number) => {
		const placement = resolvePlacement(worldX, worldZ);
		lastPlacement = placement;
		editor.setHoveredNode(placement.snap?.existingNodeId ?? null);
		buildPreview(placement);
	};

	const commitPlacement = (placement: Placement) => {
		const nodeIds = new SvelteMap<string, string>();
		const segmentIds = new SvelteMap<string, string>();
		const newNodeIds = new SvelteSet<string>();

		for (const snapshot of clipboard.nodes) {
			if (placement.snap?.clipboardNodeId === snapshot.id) {
				nodeIds.set(snapshot.id, placement.snap.existingNodeId);
				continue;
			}

			const translated = translatedNode(snapshot, placement.translation);
			const node = editor.graph.createNode(translated.x, translated.y);
			nodeIds.set(snapshot.id, node.id);
			newNodeIds.add(node.id);
			editor.nodeRenderer.createNode(node);
		}

		for (const snapshot of clipboard.segments) {
			const startNodeId = nodeIds.get(snapshot.startNodeId);
			const endNodeId = nodeIds.get(snapshot.endNodeId);
			if (!startNodeId || !endNodeId || startNodeId === endNodeId) continue;

			const segment = editor.graph.createSegment(startNodeId, endNodeId, cloneLanes(snapshot.lanes));
			segmentIds.set(snapshot.id, segment.id);
			if (snapshot.controlX !== undefined && snapshot.controlY !== undefined) {
				segment.setControlPoint(
					snapshot.controlX + placement.translation.dx,
					snapshot.controlY + placement.translation.dy
				);
			}
		}

		for (const snapshot of clipboard.nodes) {
			const nodeId = nodeIds.get(snapshot.id);
			if (!nodeId || !newNodeIds.has(nodeId)) continue;
			const node = editor.graph.nodes.get(nodeId);
			if (!node) continue;
			node.disabledConnections = editor.remapConnectionRefs(snapshot.disabledConnections, segmentIds);
			node.enabledConnections = editor.remapConnectionRefs(snapshot.enabledConnections, segmentIds);
		}

		editor.resolveSegmentCrossings();
		editor.rebuildRoads();
		editor.graph.save();
		editor.pendingPlacement = null;
		editor.setHoveredNode(null);
		editor.mode = 'select';
	};

	const cancelPlacement = () => {
		editor.pendingPlacement = null;
		editor.setHoveredNode(null);
		editor.mode = 'select';
	};

	const onMouseMove = (event: MouseEvent) => {
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		updatePreview(worldPos.x, worldPos.z);
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		updatePreview(worldPos.x, worldPos.z);
		if (lastPlacement) commitPlacement(lastPlacement);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') cancelPlacement();
	};

	const cleanup = () => {
		editor.setHoveredNode(null);
		ghostRenderer.dispose();
		clearCrossingMarkers();
		markerMaterial.dispose();
	};

	return { onMouseDown, onMouseMove, onKeyDown, cleanup };
}

function clipboardCentroid(clipboard: SegmentClipboard) {
	let x = 0;
	let y = 0;
	for (const node of clipboard.nodes) {
		x += node.x;
		y += node.y;
	}
	const count = clipboard.nodes.length || 1;
	return { x: x / count, y: y / count };
}
