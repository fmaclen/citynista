import * as THREE from 'three';
import type { Editor } from '../editor.svelte';
import {
	carRoads,
	layPaste,
	type Placement,
	roadsAt,
	roadsOf,
	type SegmentClipboard,
	showsWith,
	shownOffsets,
	type Translation
} from '../clipboard';
import type { Graph } from '../core/graph.svelte';
import { findCrossingsBetweenSegments } from '../core/crossings';
import { NODE_Y_OFFSET, nodeRingGeometry } from '../rendering/node-renderer';
import { SELECT_COLOR } from '../rendering/editor-palette';
import { roadGhost } from './ghost';

const MARKER_COLOR = SELECT_COLOR;
const MARKER_Y = NODE_Y_OFFSET;

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

	// Whether each copied node holds car roads.
	const copiedCars = new Map(
		clipboard.nodes.map((n) => [n.id, carRoads(roadsOf(clipboard, n.id))])
	);

	const offsets = shownOffsets(clipboard);

	const findNodeSnap = (translation: Translation) => {
		// A pasted node snaps inside the ring of an existing node holding the
		// same kind of road; one of footpaths only onto a node it would show
		// at the spot of, as it lands (layPaste).
		const radius = editor.nodeRingRadius();
		let best:
			| (NonNullable<Placement['snap']> & { distance: number; correction: Translation })
			| null = null;

		for (const clipboardNode of clipboard.nodes) {
			const translated = {
				x: clipboardNode.x + translation.dx,
				y: clipboardNode.y + translation.dy
			};
			for (const existingNode of editor.graph.nodes.values()) {
				const distance = Math.hypot(existingNode.x - translated.x, existingNode.y - translated.y);
				if (distance >= radius) continue;
				if (best && distance >= best.distance) continue;
				const roads = roadsAt(editor.graph, existingNode.id);
				if (roads.length && carRoads(roads) !== copiedCars.get(clipboardNode.id)) continue;
				const off = offsets.get(clipboardNode.id);
				if (off && !showsWith(editor.graph, existingNode, off)) continue;

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
		const { segmentIds } = layPaste(editor.graph, clipboard, placement, true);
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
