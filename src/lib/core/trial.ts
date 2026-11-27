// Trying an edit before making it: the edit made in a copy of the few roads
// it changes (copyAround), and the graph read as that edit would leave it
// (laidOver), nothing of the rest copied, so a try costs what it edits
// (modes/select.ts: a dead end held over a drop marker).

import type { Graph, GraphView, NodeView } from './graph.svelte';
import type { Segment } from './segment.svelte';

// A copy of some roads of `graph` and every road at their nodes, in the
// graph's order, so each end there lies as it does in the graph and an edit
// made in the copy lists roads as it would in the graph. Only those roads and
// their nodes are read (the order off `Graph.inOrder`), whatever the graph's
// size.
export function copyAround(graph: Graph, seeds: Iterable<string>) {
	const ids = new Set<string>();
	for (const id of seeds) {
		const s = graph.segments.get(id);
		for (const n of s ? [s.startNodeId, s.endNodeId] : [])
			for (const r of graph.nodes.get(n)?.connectedSegments ?? []) ids.add(r);
	}
	const segments = graph.inOrder(ids).flatMap((id) => graph.segments.get(id) ?? []);
	const nodes = new Set(segments.flatMap((s) => [s.startNodeId, s.endNodeId]));
	return graph.part({
		nodes: [...nodes].flatMap((id) => graph.nodes.get(id)?.toJSON() ?? []),
		segments: segments.map((s) => s.toJSON())
	});
}

// A map read as `base` with some keys read off `over` instead (`taken`: the
// keys `over` speaks for, gone where it has none), and the keys `over` holds
// that `base` does not added after `base`'s. Nothing is copied: a read costs
// what it reads, whatever the size of `base`.
class Overlaid<V> implements ReadonlyMap<string, V> {
	constructor(
		private base: ReadonlyMap<string, V>,
		private over: ReadonlyMap<string, V>,
		private taken: (key: string) => boolean
	) {}
	get(key: string) {
		return this.base.has(key) && !this.taken(key) ? this.base.get(key) : this.over.get(key);
	}
	has(key: string) {
		return this.get(key) !== undefined;
	}
	get size() {
		return [...this.keys()].length;
	}
	*entries(): MapIterator<[string, V]> {
		for (const [key, value] of this.base) {
			const now = this.taken(key) ? this.over.get(key) : value;
			if (now !== undefined) yield [key, now];
		}
		for (const [key, value] of this.over) if (!this.base.has(key)) yield [key, value];
	}
	*keys(): MapIterator<string> {
		for (const [key] of this.entries()) yield key;
	}
	*values(): MapIterator<V> {
		for (const [, value] of this.entries()) yield value;
	}
	[Symbol.iterator]() {
		return this.entries();
	}
	forEach(each: (value: V, key: string, map: ReadonlyMap<string, V>) => void) {
		for (const [key, value] of this.entries()) each(value, key, this);
	}
}

// `graph` as edits made in `copy` (made by copyAround, with the roads
// `known`) leave it: the copy's roads in place of those it was made with,
// those it made added, its nodes in place of those it holds every road of
// (the only ones an edit there can change), the rest of the graph as it is.
export function laidOver(graph: Graph, copy: Graph, known: Set<string>): GraphView {
	const whole = (id: string) => {
		const roads = graph.nodes.get(id)?.connectedSegments ?? [];
		return roads.length > 0 && roads.every((r) => known.has(r));
	};
	return {
		nodes: new Overlaid<NodeView>(graph.nodes, copy.nodes, whole),
		segments: new Overlaid<Segment>(graph.segments, copy.segments, (id) => known.has(id))
	};
}
