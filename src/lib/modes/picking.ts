import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { distanceToQuadraticBezier } from '../geometry/bezier';

// Hit radii are the geometry itself — the node's ring, the road's own half
// width — with a screen-pixel floor for when the geometry is smaller than
// a finger. Zoomed in, the whole road body is hoverable; zoomed out,
// targets keep a clickable minimum.
export const NODE_HIT_PX = 20;
export const SEGMENT_HIT_PX = 14;

export function nodeHitAt(editor: Editor, worldX: number, worldZ: number) {
	const floor = NODE_HIT_PX * editor.sceneManager.worldPerPixel();
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
	return { node: best, score: bestScore };
}

export function segmentHitAt(editor: Editor, worldX: number, worldZ: number) {
	const floor = SEGMENT_HIT_PX * editor.sceneManager.worldPerPixel();
	let best: Segment | null = null;
	let bestScore = 1;
	for (const segment of editor.graph.segments.values()) {
		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) continue;

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

		const dist = distanceToQuadraticBezier(
			worldX,
			worldZ,
			startNode.x,
			startNode.y,
			cx,
			cy,
			endNode.x,
			endNode.y
		);
		const score = dist / Math.max(segment.totalWidth / 2, floor);
		if (score < bestScore) {
			bestScore = score;
			best = segment;
		}
	}
	return { segment: best, score: bestScore };
}

// Inside a node's ring the node wins outright — roads pass through their
// nodes, so any distance-based tiebreak hands the disc to the segment.
// Hit radii are geometry-true, so the visible gap between two rings is
// exactly where the segment is picked.
export function pickAt(
	editor: Editor,
	worldX: number,
	worldZ: number
): { node: Node | null; segment: Segment | null } {
	const nodeHit = nodeHitAt(editor, worldX, worldZ);
	if (nodeHit.node) return { node: nodeHit.node, segment: null };
	return { node: null, segment: segmentHitAt(editor, worldX, worldZ).segment };
}

// Convex-quad containment: a point is inside when it sits on the same side of
// every edge. A degenerate (zero-area) quad has no consistent side and selects
// nothing, which is the right answer for a click that never dragged.
function pointInQuad(px: number, py: number, quad: { x: number; y: number }[]) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = quad[i];
		const b = quad[(i + 1) % 4];
		const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
		if (cross === 0) continue;
		const s = cross > 0 ? 1 : -1;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return sign !== 0;
}

// Everything inside the marquee quad: nodes by position, segments when both
// endpoints fall inside. The quad is the marquee's on-screen rectangle
// projected onto the ground, so it tracks the camera instead of the world axes.
export function quadContents(
	editor: Editor,
	quad: { x: number; y: number }[]
): { nodeIds: string[]; segmentIds: string[] } {
	const nodeIds: string[] = [];
	const segmentIds: string[] = [];
	if (quad.length < 4) return { nodeIds, segmentIds };

	for (const node of editor.graph.nodes.values()) {
		if (pointInQuad(node.x, node.y, quad)) nodeIds.push(node.id);
	}
	for (const segment of editor.graph.segments.values()) {
		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);
		if (
			startNode &&
			endNode &&
			pointInQuad(startNode.x, startNode.y, quad) &&
			pointInQuad(endNode.x, endNode.y, quad)
		) {
			segmentIds.push(segment.id);
		}
	}
	return { nodeIds, segmentIds };
}
