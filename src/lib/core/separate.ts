// A node holds roads of one network (core/networks.ts): car roads, or
// footpaths, never both. The Graph keeps it so on every edit (a segment
// added at a node of the other kind, or a segment's lanes turning it into
// the other kind, takes a node of its own there: `keepKinds`). A graph saved
// before that held (a footpath that met a street shared a node with it on
// the street's line) is split when it is read (`separateKinds`): the
// footpaths of such a node move to a node of their own at the same place
// (where a shifted street showed, if they were cut in on its line:
// shownThrough), so the drawing is as it was: each network is built from its
// own roads, and a footpath that carried on from a street's end still finds
// that end where both show (`deadEndAt` in core/networks.ts; a street
// shifted at its end shows it off the node, where a footpath split off
// there no longer meets it). A footpath node
// holds no junction edits: a strip has no setback, taper, connection,
// control or attachment for one to set (core/footpaths.ts), so the edits
// naming footpaths that leave a car node go nowhere, and a node left holding
// footpaths alone, or read so, drops its edits. A control a node once held
// for a crossing (under LEGACY_CROSSING) is dropped too: a crossing is
// paint, which nothing in the graph marks.

import type { GraphView } from './graph.svelte';
import { segmentEnds, type SegmentLike } from './attach';
import { shownAt } from './road-line';
import { carries } from './lane-types';
import type { JunctionData } from './types';

// What separating reads and changes: a graph's nodes and segments, as the
// editor's Graph holds them or a saved one read plainly (unit/model.ts).
interface NodeLike {
	id: string;
	x: number;
	y: number;
	junction?: JunctionData;
	readonly connectedSegments: readonly string[];
}
interface Separable {
	nodes: ReadonlyMap<string, NodeLike>;
	segments: ReadonlyMap<string, SegmentLike>;
	createNode(x: number, y: number): NodeLike;
	// Moves segment `id`'s ends at node `from` to node `to`, listing it there
	// and no longer at `from`.
	reattach(id: string, from: string, to: string): void;
}

// Moves the segments `moving` off node `id` onto a new node at `at` (the
// node's own place unless given), with the node's edits that name them
// where they are car roads; footpaths take none. Returns the new node.
function part(graph: Separable, id: string, moving: Set<string>, at?: { x: number; y: number }) {
	const node = graph.nodes.get(id)!;
	const own = graph.createNode(at?.x ?? node.x, at?.y ?? node.y);
	const cars = [...moving].some((s) => carries(graph.segments.get(s)?.lanes ?? []));
	for (const s of [...node.connectedSegments])
		if (graph.segments.has(s) && moving.has(s)) graph.reattach(s, id, own.id);
	const [stay, go] = split(node.junction, (road) => moving.has(road));
	// Where no edit goes, the node's edits stay as they are, to the byte.
	if (!Object.keys(go).length) return own;
	node.junction = Object.keys(stay).length ? stay : undefined;
	if (cars) own.junction = go;
	return own;
}

// Drops the edits of a node holding footpaths alone.
function walksOnly(graph: Separable, node: NodeLike) {
	if (!node.junction || !node.connectedSegments.length) return;
	const roads = node.connectedSegments.flatMap((s) => graph.segments.get(s) ?? []);
	if (roads.every((s) => !carries(s.lanes))) node.junction = undefined;
}

// Where the segments just added or given new lanes (`changed`) leave a node
// holding both kinds, the roads of the kind only changed roads have there
// take a node of their own at the same place, car roads with the edits that
// name them (`part`); where every road there changed, the footpaths go. So
// the roads that stood at a node are never moved off it, and no edit to
// footpaths moves, cuts or deletes a car node or segment. A node the changed
// roads leave holding footpaths alone drops its edits.
export function keepKinds(graph: Separable, changed: SegmentLike[]) {
	const ids = new Set(changed.map((s) => s.id));
	for (const nodeId of new Set(changed.flatMap((s) => [s.startNodeId, s.endNodeId]))) {
		const node = graph.nodes.get(nodeId);
		const roads = (node?.connectedSegments ?? []).flatMap((id) => graph.segments.get(id) ?? []);
		const [cars, walks] = [true, false].map((car) => roads.filter((s) => carries(s.lanes) === car));
		if (node && !cars.length) walksOnly(graph, node);
		if (!cars.length || !walks.length) continue;
		const onlyChanged = (group: SegmentLike[]) => group.every((s) => ids.has(s.id));
		const moving = onlyChanged(walks) ? walks : onlyChanged(cars) ? cars : walks;
		part(graph, nodeId, new Set(moving.map((s) => s.id)));
	}
}

// The key a footpath's node once kept its crossing's control under, which a
// city saved then may still hold.
const LEGACY_CROSSING = 'crossing';

// Splits every node of a graph read from storage that holds both kinds of
// road, drops any crossing control a node holds, and the edits of every
// node of footpaths.
export function separateKinds(graph: Separable) {
	for (const id of [...graph.nodes.keys()]) {
		const node = graph.nodes.get(id)!;
		if (node.junction?.control && LEGACY_CROSSING in node.junction.control) {
			const control = { ...node.junction.control };
			delete control[LEGACY_CROSSING];
			const kept: JunctionData = { ...node.junction, control };
			if (!Object.keys(control).length) delete kept.control;
			node.junction = Object.keys(kept).length ? kept : undefined;
		}
		const roads = node.connectedSegments.flatMap((s) => graph.segments.get(s) ?? []);
		const walks = roads.filter((s) => !carries(s.lanes));
		walksOnly(graph, node);
		if (!walks.length || walks.length === roads.length) continue;
		const cars = roads.filter((s) => carries(s.lanes));
		part(graph, id, new Set(walks.map((s) => s.id)), shownThrough(graph, id, cars) ?? node);
	}
}

// Where footpaths cut in on a shifted street's line drew their ends: where
// the street shows there, the node being one it only runs on through, its
// shift the same either side. Null at any other node.
function shownThrough(graph: Separable, nodeId: string, cars: SegmentLike[]) {
	if (cars.length !== 2) return null;
	const [x, y] = cars[0].endNodeId === nodeId ? cars : [cars[1], cars[0]];
	if (x === y || x.endNodeId !== nodeId || y.startNodeId !== nodeId) return null;
	if (!x.offsetEnd || x.offsetEnd !== y.offsetStart) return null;
	const view = graph as unknown as GraphView;
	const [ex, ey] = [segmentEnds(view, x), segmentEnds(view, y)];
	if (!ex || !ey) return null;
	const [p, q] = [shownAt(x, ex.a, ex.b, 1).point, shownAt(y, ey.a, ey.b, 0).point];
	return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

// A node's edits parted by whether they name a road `moves` takes: a
// connection naming one of those goes with them, as does every other edit
// keyed by one of those roads. Of the edits staying, a kind none of which
// goes is kept as stored (an empty list too), in the order stored.
function split(data: JunctionData | undefined, moves: (road: string) => boolean) {
	if (!data) return [{}, {}] as const;
	const [left, go] = parted(data, moves);
	const stay: JunctionData = {};
	for (const key of Object.keys(data) as (keyof JunctionData)[]) {
		const kept = key in go ? left[key] : data[key];
		if (kept !== undefined) Object.assign(stay, { [key]: kept });
	}
	return [stay, go] as const;
}

function parted(data: JunctionData, moves: (road: string) => boolean) {
	const stay: JunctionData = {};
	const go: JunctionData = {};
	const to = (moving: boolean) => (moving ? go : stay);
	for (const kind of ['added', 'removed'] as const)
		for (const c of data[kind] ?? []) {
			const out = to(moves(c.from.road) || moves(c.to.road));
			(out[kind] ??= []).push(c);
		}
	for (const c of data.crossings ?? []) (to(moves(c.road)).crossings ??= []).push(c);
	for (const [key, value] of Object.entries(data.control ?? {}))
		(to(moves(key.slice(0, key.lastIndexOf(':')))).control ??= {})[key] = value;
	for (const field of ['setbacks', 'sides'] as const)
		for (const [road, value] of Object.entries(data[field] ?? {}))
			Object.assign((to(moves(road))[field] ??= {}), { [road]: value });
	return [stay, go] as const;
}
