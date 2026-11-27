// The setback handles: on a single selected node of two or more roads, an
// arrow on each road where it stops short of the node. Where two roads meet
// that is where its side of the taper ends; at a junction of more, where the
// junction ends on it. Dragging one sets that road's setback; with Shift,
// every road's at the node.
// Dashed guides go with them: across each road's full width where it stops
// short, and, where the node's ring sits off a road (a road with a large
// offset), from the ring to where that road shows at the node.

import type { Editor } from '../editor.svelte';
import { nodePoint, roadLine, type Pt } from '../core/road-line';
import { TAPER_HANDLE, hitsHandle } from '../rendering/handle-shapes';

export interface SetbackHandle {
	// Its place among the node's handles.
	index: number;
	nodeId: string;
	segmentId: string;
	node: Pt;
	handle: Pt;
	// Along the road at the handle, away from the node.
	dir: Pt;
	// The road's line from the node out, for reading the drag as a distance
	// along it.
	centerline: Pt[];
}

// Setback handles sit at least this far from their node, so the node itself
// can always be grabbed.
const HANDLE_REACH = 4;

// The point a distance along a polyline.
function pointAlong(points: Pt[], distance: number): Pt {
	let run = 0;
	for (let i = 1; i < points.length; i++) {
		const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
		if (run + l >= distance) {
			const f = l > 0 ? (distance - run) / l : 0;
			return {
				x: points[i - 1].x + (points[i].x - points[i - 1].x) * f,
				y: points[i - 1].y + (points[i].y - points[i - 1].y) * f
			};
		}
		run += l;
	}
	const last = points[points.length - 1];
	return { x: last.x, y: last.y };
}

// The unit direction a polyline runs at a distance along it.
function directionAlong(points: Pt[], distance: number): Pt {
	const a = pointAlong(points, Math.max(0, distance - 0.5));
	const b = pointAlong(points, distance + 0.5);
	const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
	return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

// The handles and guides on the selected node, or null when there is no
// single selected node with setbacks to set.
export function setbackHandles(editor: Editor) {
	const nodeId = editor.selectedNodes.size === 1 ? [...editor.selectedNodes][0] : null;
	const node = nodeId ? editor.graph.nodes.get(nodeId) : undefined;
	const limits = node && editor.roadRenderer?.taperLimits(node.id);
	const derived = editor.roadRenderer?.derived;
	if (!node || !limits || !derived) return null;
	const { spans, units } = derived;
	const handles: SetbackHandle[] = [];
	const guides: [Pt, Pt][] = [];
	const ring = nodePoint(editor.graph, node);
	for (const segmentId of node.connectedSegments) {
		const segment = editor.graph.segments.get(segmentId);
		const span = spans.get(segmentId);
		if (!segment || !span || !limits.has(segmentId)) continue;
		const atStart = segment.startNodeId === node.id;
		// Along the road as it shows (offset and all), from the node out: the
		// whole road where it is cut through nodes it only carries on through
		// (Derived.units), so its end can be set past them.
		let centerline: Pt[] = (units.get(segmentId) ?? [segmentId]).flatMap((id, i) => {
			const piece = editor.graph.segments.get(id);
			const line = piece ? roadLine(editor.graph, piece) : [];
			return i ? line.slice(1) : line;
		});
		if (!atStart) centerline = [...centerline].reverse();
		const trim = atStart ? span.d0 : span.total - span.d0 - span.length;
		// Where the road stops short, but never on the node itself.
		const reach = Math.max(trim, HANDLE_REACH);
		const end = pointAlong(centerline, trim);
		const along = directionAlong(centerline, trim);
		const half = segment.totalWidth / 2;
		guides.push([
			{ x: end.x - along.y * half, y: end.y + along.x * half },
			{ x: end.x + along.y * half, y: end.y - along.x * half }
		]);
		const at = centerline[0];
		if (Math.hypot(ring.x - at.x, ring.y - at.y) > half) guides.push([ring, at]);
		handles.push({
			index: handles.length,
			nodeId: node.id,
			segmentId,
			node: centerline[0],
			handle: pointAlong(centerline, reach),
			dir: directionAlong(centerline, reach),
			centerline
		});
	}
	return { handles, guides };
}

export function setbackHandleAt(editor: Editor, worldX: number, worldZ: number) {
	const scale = editor.sceneManager.worldPerPixel();
	let best: SetbackHandle | null = null;
	let bestDistance = Infinity;
	for (const handle of editor.currentTaperHandles) {
		if (!hitsHandle(TAPER_HANDLE, handle.handle, handle.dir, worldX, worldZ, scale)) continue;
		const distance = Math.hypot(handle.handle.x - worldX, handle.handle.y - worldZ);
		// Nearer the node than the handle: that's the node.
		const toNode = Math.hypot(handle.node.x - worldX, handle.node.y - worldZ);
		if (toNode < distance) continue;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = handle;
		}
	}
	return best;
}

// While dragging a setback handle: its road stops as far along from the
// node as the pointer; with `every` (Shift held) every road at the node
// does, each within its own limits.
export function dragSetback(
	editor: Editor,
	handle: SetbackHandle,
	worldX: number,
	worldZ: number,
	every: boolean
) {
	const points = handle.centerline;
	let accumulated = 0;
	let bestArc = 0;
	let bestDistance = Infinity;
	for (let i = 1; i < points.length; i++) {
		const ax = points[i - 1].x;
		const ay = points[i - 1].y;
		const dx = points[i].x - ax;
		const dy = points[i].y - ay;
		const lengthSq = dx * dx + dy * dy;
		const t =
			lengthSq > 0
				? Math.max(0, Math.min(1, ((worldX - ax) * dx + (worldZ - ay) * dy) / lengthSq))
				: 0;
		const distance = Math.hypot(ax + dx * t - worldX, ay + dy * t - worldZ);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestArc = accumulated + t * Math.sqrt(lengthSq);
		}
		accumulated += Math.sqrt(lengthSq);
	}
	const node = editor.graph.nodes.get(handle.nodeId);
	if (!node) return;
	// Within each road's limits: a taper no steeper than the lanes' shift
	// allows, a junction no smaller than its curb corners need, and never
	// into the far node's setback. Moved together (Shift), every road
	// stops at the tightest of their limits, so the setbacks stay equal;
	// limits that leave no common range fall back to each road's own.
	const limits = editor.roadRenderer.taperLimits(node.id);
	const setbacks = { ...node.junction?.setbacks };
	const roads = every ? editor.currentTaperHandles.map((h) => h.segmentId) : [handle.segmentId];
	const range = (ids: string[]) => ({
		min: Math.max(0, ...ids.map((id) => limits?.get(id)?.min ?? 0)),
		max: Math.min(...ids.map((id) => limits?.get(id)?.max ?? Infinity))
	});
	const shared = range(roads);
	for (const road of roads) {
		const { min, max } = shared.min <= shared.max ? shared : range([road]);
		setbacks[road] = Math.min(max, Math.max(min, bestArc));
	}
	node.junction = { ...node.junction, setbacks };
	editor.rebuildRoads();
}
