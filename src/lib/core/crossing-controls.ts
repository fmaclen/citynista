// The controls of the crossings a footpath makes over car roads, set by hand.
//
// A crossing is paint (core/runs.ts): no node, no cut, nothing in the graph
// marks it. It is the footpath, the car road and the carriageway of it the
// footpath lies across (a street with a walkway down its middle has two,
// each crossed on its own). A control is stored for a footpath segment and
// a carriageway (SegmentData.controls): the car road by that road's
// segments as it carries on (`roads`: through every node it only carries on
// through, round a loop once: chainThrough in core/place.ts) and the
// carriageway by the ids of its car lanes (`lanes`, stable across edits).
// Never by the road as drawn: a loop is drawn as two roads parted at nodes
// picked by their ids (roadThrough), a parting the user never made and
// cannot see, which a cut, a bend past straight, a setback, a side street
// or a paste moves. Read whole, a loop is one road, so where it is parted
// never matters to which control a crossing reads, to what a save writes
// or to where an open badge stays. Every crossing that segment makes of
// that carriageway takes it, however many there are (a footpath bowed
// across one carriageway twice crosses it twice under one control): nothing
// tells crossings apart by order or place along the footpath, so a control
// cannot pass from one crossing to another as roads move. A user who wants
// two such crossings to differ splits the footpath between them. Nothing of
// it is stored on a car road, so no footpath edit ever writes a car segment.
//
// An entry names a carriageway whose road holds one of its segments and
// whose car lanes hold one of its lanes, and its lanes are lanes of each
// road it names (a carry that would break that writes one entry per set of
// lanes: `carryControls`); one stored without lanes (as cities
// saved before carriageways were told apart store them) names every
// carriageway of its road. A segment's control for a carriageway is the
// strongest of its entries naming it, give-way where none does (`controlOf`),
// and a crossing laid over pieces of several footpath segments joined inside
// the roadway takes the strongest of theirs. An entry always names lanes of
// the roads it names: whatever replaces a car segment (a cut, a draw's cut,
// a join, a lane edit or lanes pasted, Graph.setLanes) carries each entry
// naming it to the carriageways of the replacement holding the car lanes it
// named, wherever they now lie, or, where the replacement holds none of the
// old lanes (lanes pasted), to the one counted the same from the road's
// edge (`carryControls`), so a control stays on its carriageway, and goes
// with a carriageway taken off. A paste keeps it on the copy (layPaste in
// clipboard.ts, the lanes copied with their ids). A footpath cut gives both
// pieces all its entries and a join gives the joined one all the pieces'
// (`joinedControls`), the stronger where they differ.
//
// Entries are written again only as part of an edit the user saves
// (Networks.settle, written by the editor; never on selecting, opening or
// loading): one per carriageway the segment's crossings lie on now, naming
// its road's segments and car lanes now, and none where it gives way, so an
// entry no crossing of its segment lies on is dropped and never comes back
// on a crossing made later (`settled`). That changes no crossing's control.

import { type Control, strongest } from '../road-model/model';
import { carriagewaysOf } from './attach';
import type { CrossingControl, Lane } from './types';

// A carriageway crossed: its car road's segments as it carries on, before
// any parting, and its car lanes.
export interface Carriageway {
	roads: readonly string[];
	lanes: readonly string[];
}

const names = (e: CrossingControl, k: Carriageway) =>
	e.roads.some((r) => k.roads.includes(r)) &&
	(!e.lanes || e.lanes.some((l) => k.lanes.includes(l)));

// A footpath segment's control for a carriageway: the strongest of the
// entries naming it, give-way where none does.
export function controlOf(stored: readonly CrossingControl[] | undefined, k: Carriageway) {
	const named = (stored ?? []).filter((e) => names(e, k));
	return named.length ? strongest(named.map((e) => e.control)) : 'yield';
}

const keyOf = (k: Carriageway) => JSON.stringify([[...k.roads].sort(), k.lanes]);

// What a footpath segment stores, given the carriageways its crossings lie
// on now: one entry for each whose control is other than give-way, each
// control as it reads now, with `set` (one carriageway's control) applied.
export function settled(
	stored: readonly CrossingControl[] | undefined,
	carriageways: readonly Carriageway[],
	set?: { at: Carriageway; control: Control }
) {
	const byKey = new Map(carriageways.map((k) => [keyOf(k), k]));
	if (set) byKey.set(keyOf(set.at), set.at);
	const out = [...byKey]
		.sort(([p], [q]) => (p < q ? -1 : 1))
		.flatMap(([key, k]) => {
			const control = set && key === keyOf(set.at) ? set.control : controlOf(stored, k);
			return control === 'yield'
				? []
				: [{ roads: [...k.roads].sort(), lanes: [...k.lanes], control }];
		});
	return out.length ? out : undefined;
}

// Whether two lists of entries are the same, to the byte.
export const sameControls = (
	a: readonly CrossingControl[] | undefined,
	b: readonly CrossingControl[] | undefined
) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

// A stored control, copied as it was stored, any field it holds beyond
// these included (an entry may also hold where along the footpath it lay,
// which decides nothing and goes when the entry is written again:
// `settled`).
export const copyControl = (c: CrossingControl): CrossingControl => ({
	...c,
	roads: [...c.roads],
	...(c.lanes && { lanes: [...c.lanes] })
});

// The entries of footpaths joined into one: all of each one's, the stronger
// read where two name one carriageway (`controlOf`).
export function joinedControls(...parts: (readonly CrossingControl[] | undefined)[]) {
	const out = parts.flatMap((p) => (p ?? []).map(copyControl));
	return out.length ? out : undefined;
}

// A car segment replaced by others: its replacement (`to`), as a cut gives
// its halves, a join the joined road, or a lane edit the segment itself with
// its new cross-section (Graph.setLanes). Each replacement comes with its
// lanes and which of them are the old segment's lanes (`same`, old lane id
// to its own: every lane of a cut half, the lanes a lane edit keeps, every
// lane of the joined road, by its place in the flow through the node; none
// of lanes pasted, which are another road's).
export interface Replaced {
	from: { id: string; lanes: readonly Lane[] };
	to: { id: string; lanes: readonly Lane[]; same?: ReadonlyMap<string, string> }[];
}

// The lanes of a replacement that are the old segment's own, by id: all
// those it holds of the same ids (a cut half, or a lane edit's segment).
export const sameIds = (from: readonly Lane[], to: readonly Lane[]) =>
	new Map(
		to.flatMap((l) => (l.id && from.some((o) => o.id === l.id) ? [[l.id, l.id] as const] : []))
	);

// Every footpath's entries naming a car segment replaced name its
// replacements instead, each carriageway it named carried to its
// counterparts on each replacement. An entry follows the car lanes it
// names: where a replacement holds any of the old segment's car lanes
// (`same`), an old carriageway's counterparts are the carriageways now
// holding any of its lanes, wherever they lie across the road, so a lane
// edit that widens, narrows, retypes or moves a carriageway keeps its
// control on it, two carriageways merged into one take both entries (the
// stronger reads: controlOf) and one split in two gives each its entry; an
// old carriageway none of whose lanes the replacement holds has none, and
// its entry goes, never handed to a carriageway holding another's lanes.
// Only where a replacement holds none of them (lanes pasted) does place
// decide: the carriageways counted in order from the road's left edge (the
// lanes pasted onto the segment run its way), an old one's counterpart the
// new one counted the same, if there is one. An entry naming no lanes names
// every carriageway of each replacement. One with no counterpart on any
// replacement, and naming no other road, goes: no crossing of its footpath
// can take it. Only footpaths storing an entry changed get a new list (the
// drawing reads a new list as an edit). Entries the graph carries for
// others (Graph.carrying) are carried alike.
type Holds = { controls: readonly CrossingControl[] | undefined };
export function carryControls(
	graph: { segments: ReadonlyMap<string, Holds>; carrying?: Iterable<Holds> },
	replaced: readonly Replaced[]
) {
	const byId = new Map(replaced.map((r) => [r.from.id, r]));
	if (!byId.size) return;
	// The carriageways of a replacement that are counterparts of the old
	// carriageways holding any of `named`.
	const counterparts = (from: Replaced['from'], t: Replaced['to'][number], named: string[]) => {
		const was = carriagewaysOf(from.lanes);
		const now = carriagewaysOf(t.lanes);
		const same = t.same ?? new Map<string, string>();
		if (was.some((o) => o.lanes.some((l) => same.has(l)))) {
			const mine = named.flatMap((l) => same.get(l) ?? []);
			return now.filter((k) => k.lanes.some((l) => mine.includes(l)));
		}
		return now.filter((_, i) => was[i]?.lanes.some((l) => named.includes(l)));
	};
	// Each entry is carried once, every replaced road it names read against
	// the lanes it named, so lanes one replacement brings are never read as
	// lanes another replaced road had. An entry's lanes are lanes of every
	// road it names (`names` reads them pooled), so where the roads it comes
	// to name hold different lanes for it, it is carried as one entry for
	// each set of lanes, naming the roads holding that set: a road not
	// replaced keeps the lanes it named, and each replacement the lanes its
	// counterparts hold.
	const carried = (e: CrossingControl): CrossingControl[] => {
		const replacing = e.roads.flatMap((r) => byId.get(r) ?? []);
		const others = e.roads.filter((r) => !byId.has(r));
		if (!e.lanes)
			return [
				{
					...e,
					roads: [...new Set([...others, ...replacing.flatMap((r) => r.to.map((t) => t.id))])]
				}
			];
		const named = e.lanes;
		const onto = replacing.flatMap(({ from, to }) =>
			to.flatMap((t) => {
				const lying = counterparts(from, t, named);
				return lying.length ? [{ id: t.id, lanes: lying.flatMap((k) => k.lanes) }] : [];
			})
		);
		const byLanes = new Map<string, { roads: Set<string>; lanes: string[] }>();
		for (const { id, lanes } of [...others.map((id) => ({ id, lanes: named })), ...onto]) {
			const key = JSON.stringify([...new Set(lanes)]);
			const here = byLanes.get(key);
			if (here) here.roads.add(id);
			else byLanes.set(key, { roads: new Set([id]), lanes: [...new Set(lanes)] });
		}
		return [...byLanes.values()].map(({ roads, lanes }) => ({ ...e, roads: [...roads], lanes }));
	};
	for (const s of [...graph.segments.values(), ...(graph.carrying ?? [])]) {
		if (!s.controls?.some((c) => c.roads.some((r) => byId.has(r)))) continue;
		const now = s.controls.flatMap(carried);
		if (!sameControls(now, s.controls)) s.controls = now.length ? now : undefined;
	}
}
