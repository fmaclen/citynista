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

// Everything inside the rectangle: nodes by position, segments when both
// endpoints fall inside.
export function rectContents(
	editor: Editor,
	ax: number,
	az: number,
	bx: number,
	bz: number
): { nodeIds: string[]; segmentIds: string[] } {
	const minX = Math.min(ax, bx);
	const maxX = Math.max(ax, bx);
	const minZ = Math.min(az, bz);
	const maxZ = Math.max(az, bz);
	const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minZ && y <= maxZ;

	const nodeIds: string[] = [];
	for (const node of editor.graph.nodes.values()) {
		if (inside(node.x, node.y)) nodeIds.push(node.id);
	}
	const segmentIds: string[] = [];
	for (const segment of editor.graph.segments.values()) {
		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);
		if (startNode && endNode && inside(startNode.x, startNode.y) && inside(endNode.x, endNode.y)) {
			segmentIds.push(segment.id);
		}
	}
	return { nodeIds, segmentIds };
}
