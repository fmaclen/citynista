import { SvelteMap } from 'svelte/reactivity';
import { Node, type NodeWrites } from './node.svelte';
import { Segment, type SegmentWrites } from './segment.svelte';
import type {
	CrossingControl,
	GraphData,
	JunctionData,
	Lane,
	NodeData,
	SegmentData
} from './types';
import { keepKinds, separateKinds } from './separate';
import { carries } from './lane-types';
import { carryControls, sameIds } from './crossing-controls';

// What reading a graph needs: its nodes and segments. A Graph is one; so is
// a part of one (core/networks.ts reads each network's segments alone).
export interface GraphView {
	nodes: ReadonlyMap<string, NodeView>;
	segments: ReadonlyMap<string, Segment>;
}

// A node as reading a graph needs it.
export type NodeView = Pick<Node, 'id' | 'x' | 'y' | 'connectedSegments' | 'junction'>;

// What was written to a graph since a reader last read it (Graph.changesSince):
// the ids of the nodes and segments written, made or removed (each once for
// every write, but that the same write again with none between and no
// reader since is logged once), and of the segments put in another place in
// its order (`reordered`, putAt), the rest keeping theirs among themselves.
export interface Changes {
	nodes: readonly string[];
	segments: readonly string[];
	reordered: readonly string[];
}

// How many writes a graph keeps for its readers at least (Graph.changesSince).
const LOG_KEEP = 4096;

// The edits two nodes held, as one node's: each road end's own kept, the
// lists joined.
function joinedEdits(a: JunctionData | undefined, b: JunctionData | undefined) {
	if (!a || !b) return a ?? b;
	const list = <T>(p?: T[], q?: T[]) => (p || q ? [...(p ?? []), ...(q ?? [])] : undefined);
	const map = <T>(p?: Record<string, T>, q?: Record<string, T>) =>
		p || q ? { ...p, ...q } : undefined;
	const out: JunctionData = {
		added: list(a.added, b.added),
		removed: list(a.removed, b.removed),
		setbacks: map(a.setbacks, b.setbacks),
		crossings: list(a.crossings, b.crossings),
		control: map(a.control, b.control),
		sides: map(a.sides, b.sides)
	};
	for (const key of Object.keys(out) as (keyof JunctionData)[])
		if (out[key] === undefined) delete out[key];
	return out;
}

// Entries carried along with the footpaths' (Graph.carrying).
export type Carried = { controls: readonly CrossingControl[] | undefined };

// A node's list of roads with one more at its end, if not there already.
const listing = (id: string) => (ids: readonly string[]) => (ids.includes(id) ? ids : [...ids, id]);

// A map read through, never written: what a Graph shows of its nodes and
// segments, so they change only through its mutators.
class ReadOnly<K, V> implements ReadonlyMap<K, V> {
	#map: Map<K, V>;
	constructor(map: Map<K, V>) {
		this.#map = map;
	}
	get(key: K) {
		return this.#map.get(key);
	}
	has(key: K) {
		return this.#map.has(key);
	}
	get size() {
		return this.#map.size;
	}
	keys() {
		return this.#map.keys();
	}
	values() {
		return this.#map.values();
	}
	entries() {
		return this.#map.entries();
	}
	forEach(f: (value: V, key: K, map: ReadonlyMap<K, V>) => void) {
		this.#map.forEach((v, k) => f(v, k, this));
	}
	[Symbol.iterator]() {
		return this.#map[Symbol.iterator]();
	}
}

// The graph keeps its rule, that a node holds car roads or footpaths and
// never both (core/separate.ts), through every edit: what it rests on (the
// nodes each segment ends at, the roads each node lists, each segment's
// lanes) is written only here, through the writes each node and segment
// hands its maker (SegmentWrites), and each mutator changes nothing until
// what it was given has been read whole, so one that fails leaves the graph
// as it was.
export class Graph {
	#nodes = new SvelteMap<string, Node>();
	#segments = new SvelteMap<string, Segment>();
	readonly nodes: ReadonlyMap<string, Node> = new ReadOnly(this.#nodes);
	readonly segments: ReadonlyMap<string, Segment> = new ReadOnly(this.#segments);
	#nodeWrites = new WeakMap<Node, NodeWrites>();
	#segmentWrites = new WeakMap<Segment, SegmentWrites>();
	// Each segment's place in the graph's order, as a number rising along it
	// (gaps where segments went), so the order of a few is read without
	// walking the rest (`inOrder`).
	#rank = new WeakMap<Segment, number>();
	#ranked = 0;
	// Crossing-control entries held outside the graph, carried through every
	// replacement of a car segment as the footpaths' own are
	// (carryControls): the editor's opened badge names its carriageway so,
	// and so stays on it as its control does.
	readonly carrying: Carried[] = [];
	// Each node's place in the graph's order, as #rank is each segment's.
	#nodeRank = new WeakMap<Node, number>();
	#nodesRanked = 0;
	// Every write to a node or segment, in order (`n` or `s` and its id), for
	// a reader to read only what changed since it last read the graph
	// (changesSince); the oldest go once LOG_KEEP more have come. `#reset`
	// is where the whole graph was last put anew (clear, fromJSON); `o` and
	// an id is a segment put in another place in the order (putAt).
	#log: string[] = [];
	#logStart = 0;
	// How much of the log was written when a reader last took the stamp.
	#read = 0;
	#reset = 0;

	private nodeIdCounter = 0;
	private segmentIdCounter = 0;

	// Where the log of writes stands now: a reader keeps it to ask next time
	// what changed since (changesSince).
	get stamp() {
		this.#read = this.#log.length;
		return this.#now;
	}
	get #now() {
		return this.#logStart + this.#log.length;
	}

	// What was written since `stamp`, or null where that is no longer known
	// (the graph was put anew since, or the writes since are more than it
	// keeps): then everything may have changed.
	changesSince(stamp: number): Changes | null {
		if (stamp < this.#logStart || stamp < this.#reset || stamp > this.#now) return null;
		const nodes: string[] = [];
		const segments: string[] = [];
		const reordered: string[] = [];
		for (let k = stamp - this.#logStart; k < this.#log.length; k++) {
			const entry = this.#log[k];
			if (entry[0] === 'n') nodes.push(entry.slice(1));
			else if (entry[0] === 's') segments.push(entry.slice(1));
			else if (entry[0] === 'o') reordered.push(entry.slice(1));
		}
		return { nodes, segments, reordered };
	}

	// Where a node or a segment stands in the graph's order: a number rising
	// along it, with gaps where others went.
	nodeRank(id: string) {
		const node = this.#nodes.get(id);
		return node && this.#nodeRank.get(node);
	}
	segmentRank(id: string) {
		const segment = this.#segments.get(id);
		return segment && this.#rank.get(segment);
	}

	#write(entry: string) {
		// The same write again, unread since, is already logged.
		if (this.#log.length > this.#read && this.#log[this.#log.length - 1] === entry) return;
		this.#log.push(entry);
		if (this.#log.length >= 2 * LOG_KEEP) {
			this.#log.splice(0, LOG_KEEP);
			this.#logStart += LOG_KEEP;
			this.#read = Math.max(0, this.#read - LOG_KEEP);
		}
	}

	createNode(x: number, y: number) {
		const node = this.#node({ id: `node-${this.nodeIdCounter}`, x, y });
		this.nodeIdCounter++;
		this.#nodes.set(node.id, node);
		this.#nodeRank.set(node, this.#nodesRanked++);
		this.#write(`n${node.id}`);
		return node;
	}

	// Adds a road between two nodes. At a node holding roads of the other
	// kind it takes a node of its own at the same place (keepKinds): read its
	// ends off the segment returned.
	createSegment(startNodeId: string, endNodeId: string, lanes: readonly Lane[]) {
		const segment = this.#segment({
			id: `segment-${this.segmentIdCounter}`,
			startNodeId,
			endNodeId,
			lanes: [...lanes]
		});
		this.segmentIdCounter++;
		this.#segments.set(segment.id, segment);
		this.#rank.set(segment, this.#ranked++);
		this.#write(`s${segment.id}`);
		for (const id of [startNodeId, endNodeId]) this.#list(id, listing(segment.id));
		this.#keepKinds([segment]);
		return segment;
	}

	// Gives each segment its new lanes as one edit: only once all are set is
	// any node holding both kinds parted (keepKinds), so roads turned into the
	// other kind together stay joined to each other. Every change is read
	// before any is made, and a lane list refused puts back those already set.
	// A lane of the new list is the lane of the same id it had, unless the
	// lanes are `pasted`: another road's, none of them its own.
	setLanes(changes: Iterable<readonly [Segment, readonly Lane[]]>, pasted = false) {
		const list = [...changes];
		for (const [segment] of list)
			if (this.#segments.get(segment.id) !== segment)
				throw new Error(`setLanes: ${segment.id} is not a segment of this graph`);
		const was = list.map(([segment]) => [segment, segment.lanes] as const);
		try {
			for (const [segment, lanes] of list) this.#segmentWrites.get(segment)!.lanes(lanes);
		} catch (error) {
			for (const [segment, lanes] of was) this.#segmentWrites.get(segment)!.lanes(lanes);
			throw error;
		}
		// The crossing controls naming a car road given new lanes name the
		// carriageways holding the lanes theirs named, and a road made a car
		// road keeps none of its own (core/crossing-controls.ts).
		carryControls(
			this,
			was.flatMap(([segment, lanes]) =>
				carries(lanes)
					? [
							{
								from: { id: segment.id, lanes },
								to: [
									{
										id: segment.id,
										lanes: segment.lanes,
										same: pasted ? undefined : sameIds(lanes, segment.lanes)
									}
								]
							}
						]
					: []
			)
		);
		for (const [segment] of list) if (carries(segment.lanes)) segment.controls = undefined;
		this.#keepKinds(list.map(([segment]) => segment));
	}

	// A node made with its writes kept, every write to it logged.
	#node(data: NodeData) {
		let writes: NodeWrites | null = null;
		const node = Node.fromJSON(data, (w) => (writes = w));
		const own = writes! as NodeWrites;
		own.watch(() => this.#write(`n${node.id}`));
		this.#nodeWrites.set(node, own);
		return node;
	}

	// A segment made with its writes kept, every write to it logged.
	#segment(data: SegmentData) {
		let writes: SegmentWrites | null = null;
		const segment = Segment.fromJSON(data, (w) => (writes = w));
		const own = writes! as SegmentWrites;
		own.watch(() => this.#write(`s${segment.id}`));
		this.#segmentWrites.set(segment, own);
		return segment;
	}

	// Rewrites the list of roads node `id` holds.
	#list(id: string, change: (ids: readonly string[]) => readonly string[]) {
		const node = this.#nodes.get(id);
		if (node) this.#nodeWrites.get(node)!.segments(change(node.connectedSegments));
	}

	// What core/separate.ts parts a node with: this graph's maps, its node
	// maker, and a segment's ends at one node moved to another.
	#separable = {
		nodes: this.#nodes,
		segments: this.#segments,
		createNode: (x: number, y: number) => this.createNode(x, y),
		reattach: (id: string, from: string, to: string) => {
			const segment = this.#segments.get(id);
			if (!segment) return;
			const moved = (end: string) => (end === from ? to : end);
			this.#segmentWrites.get(segment)!.ends(moved(segment.startNodeId), moved(segment.endNodeId));
			this.#list(from, (ids) => ids.filter((s) => s !== id));
			this.#list(to, listing(id));
		}
	};

	// A node holds car roads or footpaths, never both (core/networks.ts):
	// where the segments just added or given new lanes leave a node holding
	// both, those take a node of their own there (`keepKinds` in
	// core/separate.ts).
	#keepKinds(changed: Segment[]) {
		keepKinds(this.#separable, changed);
	}

	// Joins node `from` into node `to` (an end dropped on a node): every road
	// ending at `from` ends at `to` instead, its edits there going with it
	// (they name those roads, which keep their ids), and `from` goes. `to`
	// lists its roads in the graph's order, as a saved graph reads back.
	// Refused, changing nothing, where a road would end at `to` twice or lie
	// a second time between two nodes: whether it joined.
	merge(fromId: string, toId: string) {
		const [from, to] = [this.#nodes.get(fromId), this.#nodes.get(toId)];
		if (!from || !to || from === to) return false;
		const far = (s: Segment, id: string) => (s.startNodeId === id ? s.endNodeId : s.startNodeId);
		const moved = from.connectedSegments.map((id) => this.#segments.get(id)!);
		const joined = to.connectedSegments.map((id) => far(this.#segments.get(id)!, toId));
		if (moved.some((s) => far(s, fromId) === toId || joined.includes(far(s, fromId)))) return false;
		const edits = joinedEdits(to.junction, from.junction);
		for (const s of moved) this.#separable.reattach(s.id, fromId, toId);
		this.#list(toId, (ids) => this.inOrder(ids));
		to.junction = edits;
		this.#nodes.delete(fromId);
		this.#write(`n${fromId}`);
		this.#keepKinds(moved);
		return true;
	}

	deleteNode(nodeId: string) {
		const node = this.nodes.get(nodeId);
		if (!node) return;

		const segmentsToDelete = [...node.connectedSegments];
		for (const segmentId of segmentsToDelete) {
			this.deleteSegment(segmentId);
		}

		this.#nodes.delete(nodeId);
		this.#write(`n${nodeId}`);
	}

	deleteSegment(segmentId: string) {
		const segment = this.segments.get(segmentId);
		if (!segment) return;

		for (const id of [segment.startNodeId, segment.endNodeId])
			this.#list(id, (ids) => ids.filter((s) => s !== segmentId));

		this.#segments.delete(segmentId);
		this.#write(`s${segmentId}`);
	}

	// Where a segment is listed among the graph's segments. Nodes list their
	// roads in the graph's order (fromJSON reads them so, and every edit keeps
	// them so), and that order picks the road one attached at an edge joins
	// (core/attach.ts).
	slotOf(segmentId: string) {
		return [...this.segments.keys()].indexOf(segmentId);
	}

	// Lists segments where one gone stood (its slotOf), and so at their nodes:
	// a road cut in two reads at its nodes, and after saving, as it did whole.
	putAt(index: number, segmentIds: string[]) {
		if (index < 0) return;
		const entries = [...this.segments].filter(([id]) => !segmentIds.includes(id));
		entries.splice(
			index,
			0,
			...segmentIds.flatMap((id): [string, Segment][] => {
				const s = this.segments.get(id);
				return s ? [[id, s]] : [];
			})
		);
		this.#segments.clear();
		for (const [id, s] of entries) this.#segments.set(id, s);
		this.#reRank();
		for (const id of segmentIds) {
			this.#write(`s${id}`);
			this.#write(`o${id}`);
		}
		for (const id of segmentIds) {
			const s = this.#segments.get(id);
			for (const nodeId of s ? [s.startNodeId, s.endNodeId] : [])
				this.#list(nodeId, (ids) => this.inOrder(ids));
		}
	}

	// Some of this graph's segment ids in the graph's order, its own left out,
	// whatever the graph's size.
	inOrder(ids: Iterable<string>) {
		const rank = (id: string) => this.#rank.get(this.#segments.get(id)!)!;
		return [...ids].filter((id) => this.#segments.has(id)).sort((a, b) => rank(a) - rank(b));
	}

	#reRank() {
		this.#ranked = 0;
		for (const segment of this.#segments.values()) this.#rank.set(segment, this.#ranked++);
	}

	clear() {
		this.#nodes.clear();
		this.#segments.clear();
		this.#reRank();
		this.#nodesRanked = 0;
		this.nodeIdCounter = 0;
		this.segmentIdCounter = 0;
		this.#putAnew();
	}

	// Every reader reads the whole graph again (changesSince).
	#putAnew() {
		this.#write('r');
		this.#reset = this.#now;
	}

	toJSON(): GraphData {
		return {
			nodes: Array.from(this.nodes.values()).map((n) => n.toJSON()),
			segments: Array.from(this.segments.values()).map((s) => s.toJSON())
		};
	}

	// Reads a saved graph in place of this one: all of it read first, so a
	// graph that fails to read leaves this one as it was.
	fromJSON(data: GraphData) {
		const counter = (prefix: string, ids: string[]) =>
			Math.max(
				0,
				...ids.map((id) => parseInt(id.replace(prefix, ''), 10) + 1).filter((n) => !isNaN(n))
			);
		const nodes = data.nodes.map((n) => this.#node(n));
		const segments = data.segments.map((s) => this.#segment(s));
		// Each node's roads, in the graph's order.
		const lists: Record<string, readonly string[]> = Object.create(null);
		for (const node of nodes) lists[node.id] = [];
		for (const s of segments)
			for (const id of [s.startNodeId, s.endNodeId])
				if (lists[id]) lists[id] = listing(s.id)(lists[id]);

		this.clear();
		for (const node of nodes) {
			this.#nodes.set(node.id, node);
			this.#nodeRank.set(node, this.#nodesRanked++);
			this.#nodeWrites.get(node)!.segments(lists[node.id]);
		}
		for (const segment of segments) this.#segments.set(segment.id, segment);
		this.#reRank();
		this.nodeIdCounter = counter('node-', [...this.#nodes.keys()]);
		this.segmentIdCounter = counter('segment-', [...this.#segments.keys()]);
		// A graph saved with a node holding both car roads and footpaths reads
		// as it drew, each kind on a node of its own.
		separateKinds(this.#separable);
		this.#putAnew();
	}

	// A graph of some of this one's nodes and segments (`data`), naming the
	// nodes and segments it makes as this one would make them next, so none
	// it makes shares an id with one of this graph's it left out.
	part(data: GraphData) {
		const graph = new Graph();
		graph.fromJSON(data);
		graph.nodeIdCounter = this.nodeIdCounter;
		graph.segmentIdCounter = this.segmentIdCounter;
		return graph;
	}

	// Called after every operation that ends a user action. The editor hooks its
	// undo history and unsaved-changes tracking here; storage only happens when
	// the user saves the city.
	onSaved?: (serialized: string) => void;

	save() {
		this.onSaved?.(JSON.stringify(this.toJSON()));
	}
}
