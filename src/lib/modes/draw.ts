import * as THREE from 'three';
import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { Graph } from '../core/graph.svelte';
import { buildRoadLayers } from '../core/road-geometry';
import { cloneLanes, getTotalWidth } from '../core/lane-template';
import { splitSegment } from '../core/crossings';
import { closestPointOnQuadraticBezier, getQuadraticBezierTangent } from '../geometry/bezier';
import { RoadRenderer } from '../rendering/road-renderer';

const GHOST_OPACITY = 0.45;
const GHOST_ELEVATION = 0.06;
// Matches NodeRenderer's ring style and palette — blue while free (hover),
// yellow once snapped (committed) — sized to the active preset's width.
const GHOST_RING_THICKNESS = 1.2;
const GHOST_NODE_COLOR = 0x4a9eff;
const GHOST_NODE_SNAPPED_COLOR = 0xfacc15;
const GHOST_NODE_Y = 0.3;
const MIN_PREVIEW_LENGTH = 1;
// Snap radii are sized in screen pixels and converted to world units at the
// current zoom, so snapping feels the same at any zoom and zooming in lets
// clicks land between close nodes.
const NODE_SNAP_PX = 20;
const SEGMENT_SNAP_PX = 17;
// A segment snap this close to one of its endpoints uses the node instead of
// splitting off a sliver.
const SEGMENT_END_SNAP_PX = 14;
// Shift snaps the pending direction to 22.5° increments — or exactly onto
// the tangent of the road being extended when that is closer.
const ANGLE_SNAP_INCREMENT = Math.PI / 8;

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

// Intersection of ray (a + j·u) and ray (b + k·v), j,k > 0; null if parallel,
// behind a ray, or unreasonably far (a near-straight join curves gently instead).
const tangentIntersection = (
	ax: number,
	ay: number,
	ux: number,
	uy: number,
	bx: number,
	by: number,
	vx: number,
	vy: number
) => {
	const uv = ux * vy - uy * vx;
	if (Math.abs(uv) < 1e-6) return null;
	const ex = bx - ax;
	const ey = by - ay;
	const j = (ex * vy - ey * vx) / uv;
	const k = (ex * uy - ey * ux) / uv;
	if (j <= 0 || k <= 0) return null;
	const chord = Math.hypot(ex, ey);
	if (j > chord * 1.5 || k > chord * 1.5) return null;
	return { x: ax + ux * j, y: ay + uy * j };
};

export function setupDrawMode(editor: Editor): ModeHandlers {
	let startNodeId: string | null = null;
	let shiftHeld = false;
	let lastWorld: { x: number; z: number } | null = null;

	const ghostRenderer = new RoadRenderer(editor.sceneManager.scene, {
		opacity: GHOST_OPACITY,
		elevation: GHOST_ELEVATION
	});
	const previewGraph = new Graph();

	const cursorMaterial = new THREE.MeshBasicMaterial({
		color: GHOST_NODE_COLOR,
		transparent: true,
		opacity: 0.8
	});
	const cursorNode = new THREE.Mesh(new THREE.BufferGeometry(), cursorMaterial);
	cursorNode.rotation.x = -Math.PI / 2;
	cursorNode.visible = false;
	editor.sceneManager.scene.add(cursorNode);

	let cursorRadius = 0;
	const updateCursorRadius = () => {
		const brush = editor.activeBrush;
		const radius = (brush ? getTotalWidth(brush.lanes) / 2 : 4) + 2;
		if (radius === cursorRadius) return;

		cursorRadius = radius;
		cursorNode.geometry.dispose();
		cursorNode.geometry = new THREE.RingGeometry(radius - GHOST_RING_THICKNESS, radius, 48);
	};
	updateCursorRadius();

	const worldPerPixel = () => editor.sceneManager.worldPerPixel();

	const findSegmentSnap = (worldX: number, worldZ: number): SegmentSnap | null => {
		let best: SegmentSnap | null = null;
		let bestDistance = SEGMENT_SNAP_PX * worldPerPixel();
		const endSnapDistance = SEGMENT_END_SNAP_PX * worldPerPixel();

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
				Math.hypot(closest.x - startNode.x, closest.y - startNode.y) < endSnapDistance ||
				Math.hypot(closest.x - endNode.x, closest.y - endNode.y) < endSnapDistance
			) {
				continue;
			}

			bestDistance = closest.distance;
			best = { segment, x: closest.x, y: closest.y, t: closest.t };
		}

		return best;
	};

	// The direction a smooth continuation of the roads already attached to
	// the node would leave with, headed roughly toward the cursor. With
	// several neighbors the one closest to a straight-through continuation
	// of the pending chord wins.
	const continuationTangentAt = (
		nodeId: string,
		towardX: number,
		towardY: number
	): { x: number; y: number } | null => {
		const node = editor.graph.nodes.get(nodeId);
		if (!node) return null;
		const chordLength = Math.hypot(towardX - node.x, towardY - node.y);
		if (chordLength < 0.0001) return null;
		const chordX = (towardX - node.x) / chordLength;
		const chordY = (towardY - node.y) / chordLength;

		let best: { x: number; y: number } | null = null;
		let bestDot = Infinity;
		for (const segmentId of node.connectedSegments) {
			const adjacent = editor.graph.segments.get(segmentId);
			if (!adjacent) continue;
			const adjacentStart = editor.graph.nodes.get(adjacent.startNodeId);
			const adjacentEnd = editor.graph.nodes.get(adjacent.endNodeId);
			if (!adjacentStart || !adjacentEnd) continue;

			const atStart = adjacent.startNodeId === nodeId;
			const cx = adjacent.controlX ?? (adjacentStart.x + adjacentEnd.x) / 2;
			const cy = adjacent.controlY ?? (adjacentStart.y + adjacentEnd.y) / 2;
			const tangent = getQuadraticBezierTangent(
				adjacentStart.x,
				adjacentStart.y,
				cx,
				cy,
				adjacentEnd.x,
				adjacentEnd.y,
				atStart ? 0 : 1
			);
			const length = Math.hypot(tangent.x, tangent.y);
			if (length < 0.0001) continue;

			const outX = (atStart ? tangent.x : -tangent.x) / length;
			const outY = (atStart ? tangent.y : -tangent.y) / length;
			const dot = outX * chordX + outY * chordY;
			if (dot < bestDot) {
				bestDot = dot;
				best = { x: -outX, y: -outY };
			}
		}
		return best;
	};

	const normalizeAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

	// Shift: snap the direction from the anchor to 22.5° steps, or exactly
	// onto the continuation tangent when that is the closer candidate.
	const angleSnap = (
		anchorX: number,
		anchorY: number,
		x: number,
		y: number,
		tangent: { x: number; y: number } | null
	) => {
		const dx = x - anchorX;
		const dy = y - anchorY;
		const distance = Math.hypot(dx, dy);
		if (distance < 0.0001) return { x, y };

		const angle = Math.atan2(dy, dx);
		let best = Math.round(angle / ANGLE_SNAP_INCREMENT) * ANGLE_SNAP_INCREMENT;
		if (tangent) {
			const tangentAngle = Math.atan2(tangent.y, tangent.x);
			if (Math.abs(normalizeAngle(angle - tangentAngle)) < Math.abs(normalizeAngle(angle - best))) {
				best = tangentAngle;
			}
		}
		return { x: anchorX + Math.cos(best) * distance, y: anchorY + Math.sin(best) * distance };
	};

	// Automatic curves put the control point on a continuation tangent ray
	// where it meets the chord's perpendicular bisector — an arc-like curve
	// that leaves the previous road without a kink. Too sharp an angle falls
	// back to straight.
	const smoothControl = (
		sx: number,
		sy: number,
		tangent: { x: number; y: number },
		ex: number,
		ey: number
	) => {
		const dx = ex - sx;
		const dy = ey - sy;
		const chord = Math.hypot(dx, dy);
		if (chord < 0.0001) return null;
		const along = dx * tangent.x + dy * tangent.y;
		if (along < chord * 0.1) return null;
		const reach = Math.min((chord * chord) / (2 * along), chord * 1.5);
		return { x: sx + tangent.x * reach, y: sy + tangent.y * reach };
	};

	const solveControl = (startNode: { x: number; y: number }, target: SnapResult) => {
		if (shiftHeld) return null;
		const startTangent = startNodeId
			? continuationTangentAt(startNodeId, target.x, target.y)
			: null;
		const endTangent =
			target.kind === 'node' ? continuationTangentAt(target.nodeId, startNode.x, startNode.y) : null;
		if (startTangent && endTangent) {
			const both = tangentIntersection(
				startNode.x,
				startNode.y,
				startTangent.x,
				startTangent.y,
				target.x,
				target.y,
				endTangent.x,
				endTangent.y
			);
			if (both) return both;
		}
		if (startTangent) return smoothControl(startNode.x, startNode.y, startTangent, target.x, target.y);
		if (endTangent) return smoothControl(target.x, target.y, endTangent, startNode.x, startNode.y);
		return null;
	};

	// Node snapping covers the node's visible ring, pixel-floored — over a
	// wide junction the whole disc snaps, zoomed out a minimum remains.
	const findNodeSnap = (worldX: number, worldZ: number) => {
		const floor = NODE_SNAP_PX * worldPerPixel();
		let best: Node | null = null;
		let bestScore = 1;
		for (const node of editor.graph.nodes.values()) {
			const radius = Math.max(editor.nodeRingRadius(node), floor);
			const score = Math.hypot(node.x - worldX, node.y - worldZ) / radius;
			if (score < bestScore) {
				bestScore = score;
				best = node;
			}
		}
		return best;
	};

	const resolveSnap = (worldX: number, worldZ: number): SnapResult => {
		const node = findNodeSnap(worldX, worldZ);
		if (node) {
			return { kind: 'node', nodeId: node.id, x: node.x, y: node.y };
		}

		const snap = findSegmentSnap(worldX, worldZ);
		if (snap) {
			return { kind: 'segment', snap, x: snap.x, y: snap.y };
		}

		return { kind: 'free', x: worldX, y: worldZ };
	};

	// Where the next click would land: positional snaps (nodes, segments)
	// win; otherwise shift applies the angle snap from the current anchor.
	const resolveTarget = (worldX: number, worldZ: number): SnapResult => {
		const snap = resolveSnap(worldX, worldZ);
		if (snap.kind !== 'free' || !shiftHeld || startNodeId === null) return snap;

		const startNode = editor.graph.nodes.get(startNodeId);
		if (!startNode) return snap;

		const tangent = continuationTangentAt(startNodeId, worldX, worldZ);
		const snapped = angleSnap(startNode.x, startNode.y, worldX, worldZ, tangent);
		return { kind: 'free', x: snapped.x, y: snapped.y };
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
		const target = resolveTarget(worldX, worldZ);

		updateCursorRadius();
		cursorNode.visible = true;
		cursorNode.position.set(target.x, GHOST_NODE_Y, target.y);
		cursorMaterial.color.setHex(
			target.kind === 'free' ? GHOST_NODE_COLOR : GHOST_NODE_SNAPPED_COLOR
		);

		if (startNodeId === null) {
			ghostRenderer.clear();
			return;
		}

		const startNode = editor.graph.nodes.get(startNodeId);
		if (!startNode) return;

		if (Math.hypot(target.x - startNode.x, target.y - startNode.y) < MIN_PREVIEW_LENGTH) {
			ghostRenderer.clear();
			return;
		}

		previewGraph.clear();
		const previewStart = previewGraph.createNode(startNode.x, startNode.y);
		const previewEnd = previewGraph.createNode(target.x, target.y);
		const preview = previewGraph.createSegment(
			previewStart.id,
			previewEnd.id,
			cloneLanes(editor.activeBrush?.lanes ?? [])
		);
		const control = startNodeId ? solveControl(startNode, target) : null;
		if (control) {
			preview.setControlPoint(control.x, control.y);
		}
		ghostRenderer.render(buildRoadLayers(previewGraph));
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;
		shiftHeld = event.shiftKey;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		lastWorld = { x: worldPos.x, z: worldPos.z };
		const target = resolveTarget(worldPos.x, worldPos.z);

		if (startNodeId === null) {
			startNodeId = anchorNodeId(target);
			if (target.kind === 'segment') {
				editor.rebuildRoads();
				editor.graph.save();
			}
		} else {
			const startNode = editor.graph.nodes.get(startNodeId);
			const control = startNode ? solveControl(startNode, target) : null;
			const endNodeId = anchorNodeId(target);

			if (startNodeId !== endNodeId) {
				const segment = editor.graph.createSegment(
					startNodeId,
					endNodeId,
					cloneLanes(editor.activeBrush?.lanes ?? [])
				);
				if (control) {
					segment.setControlPoint(control.x, control.y);
				}
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
		shiftHeld = event.shiftKey;
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		lastWorld = { x: worldPos.x, z: worldPos.z };
		updatePreview(worldPos.x, worldPos.z);
	};

	// Escape unwinds one stage at a time: pending segment, then draw mode itself.
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Shift' && lastWorld) {
			shiftHeld = true;
			updatePreview(lastWorld.x, lastWorld.z);
			return;
		}
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
