import * as THREE from 'three';
import type { Editor } from '../editor.svelte';
import type { SegmentClipboard } from '../clipboard';
import type { Graph } from '../core/graph.svelte';
import type { NodeData } from '../core/types';
import { cloneLanes } from '../core/lane-template';
import { findCrossingsBetweenSegments } from '../core/crossings';
import { mapJunction } from '../core/junction-data';
import { NODE_Y_OFFSET, nodeRingGeometry } from '../rendering/node-renderer';
import { SELECT_COLOR } from '../rendering/editor-palette';
import { roadGhost } from './ghost';

const MARKER_COLOR = SELECT_COLOR;
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

const translatedNode = (node: NodeData, translation: Translation) => ({
	x: node.x + translation.dx,
	y: node.y + translation.dy
});

// Lays the copied roads into `graph` where the placement puts them, a copied
// node it snaps onto taking the existing node's place. Returns the new id of
// each copied node and road.
function layPaste(graph: Graph, clipboard: SegmentClipboard, placement: Placement) {
	const nodeIds = new Map<string, string>();
	const segmentIds = new Map<string, string>();
	for (const snapshot of clipboard.nodes) {
		if (placement.snap?.clipboardNodeId === snapshot.id) {
			nodeIds.set(snapshot.id, placement.snap.existingNodeId);
			continue;
		}
		const at = translatedNode(snapshot, placement.translation);
		nodeIds.set(snapshot.id, graph.createNode(at.x, at.y).id);
	}
	for (const snapshot of clipboard.segments) {
		const startNodeId = nodeIds.get(snapshot.startNodeId);
		const endNodeId = nodeIds.get(snapshot.endNodeId);
		if (!startNodeId || !endNodeId || startNodeId === endNodeId) continue;
		const segment = graph.createSegment(startNodeId, endNodeId, cloneLanes(snapshot.lanes));
		segmentIds.set(snapshot.id, segment.id);
		segment.offsetStart = snapshot.offsetStart ?? 0;
		segment.offsetEnd = snapshot.offsetEnd ?? 0;
		if (snapshot.controlX !== undefined && snapshot.controlY !== undefined) {
			segment.setControlPoint(
				snapshot.controlX + placement.translation.dx,
				snapshot.controlY + placement.translation.dy
			);
		}
	}
	return { nodeIds, segmentIds };
}

export function setupPlaceMode(editor: Editor) {
	const clipboard = editor.pendingPlacement;
	if (!clipboard) return {};

	const centroid = clipboardCentroid(clipboard);
	const ghost = roadGhost(editor);
	const markerMaterial = new THREE.MeshBasicMaterial({
		color: MARKER_COLOR,
		transparent: true,
		opacity: 0.9
	});
	// Crossing markers preview the nodes a paste makes: node rings, one shape.
	const markerGeometry = nodeRingGeometry();
	const crossingMarkers: THREE.Mesh[] = [];
	let lastPlacement: Placement | null = null;

	const findNodeSnap = (translation: Translation) => {
		// A pasted node snaps inside an existing node's ring.
		const radius = editor.nodeRingRadius();
		let best: (PlacementSnap & { distance: number; correction: Translation }) | null = null;

		for (const clipboardNode of clipboard.nodes) {
			const translated = translatedNode(clipboardNode, translation);
			for (const existingNode of editor.graph.nodes.values()) {
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
			editor.sceneManager.screenSized.delete(marker);
		}
		crossingMarkers.length = 0;
	};

	const showCrossingMarkers = (preview: Graph) => {
		clearCrossingMarkers();
		const crossings = findCrossingsBetweenSegments(
			preview,
			preview.segments.values(),
			editor.graph,
			editor.graph.segments.values()
		);

		for (const crossing of crossings) {
			const marker = new THREE.Mesh(markerGeometry, markerMaterial);
			marker.rotation.x = -Math.PI / 2;
			marker.position.set(crossing.x, MARKER_Y, crossing.y);
			editor.sceneManager.scene.add(marker);
			editor.sceneManager.screenSized.set(marker, Infinity);
			crossingMarkers.push(marker);
		}
	};

	// The preview lays every copied node anew, the one it snaps onto included.
	const updatePreview = (worldX: number, worldZ: number) => {
		const placement = resolvePlacement(worldX, worldZ);
		lastPlacement = placement;
		editor.setHoveredNode(placement.snap?.existingNodeId ?? null);
		ghost.show((graph) => {
			layPaste(graph, clipboard, { ...placement, snap: null });
			showCrossingMarkers(graph);
		});
	};

	const commitPlacement = (placement: Placement) => {
		const { nodeIds, segmentIds } = layPaste(editor.graph, clipboard, placement);
		// Each new node keeps its junction edits on the copied roads.
		for (const snapshot of clipboard.nodes) {
			const node = editor.graph.nodes.get(nodeIds.get(snapshot.id) ?? '');
			if (!node || !snapshot.junction || placement.snap?.clipboardNodeId === snapshot.id) continue;
			node.junction = mapJunction(snapshot.junction, (road, end) => {
				const id = segmentIds.get(road);
				return id ? { road: id, end } : null;
			});
		}

		editor.resolveSegmentCrossings(segmentIds.values());
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
		ghost.destroy();
		clearCrossingMarkers();
		markerGeometry.dispose();
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
