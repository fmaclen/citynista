// A network's drawing: cached road and node descriptions that rebuild only
// when their keys (set by core/place.ts) or a road's end cuts change.
// core/networks.ts draws the car roads with one, and lays the footpaths
// (core/footpaths.ts) over them (overlay.ts); rendering/road-renderer.ts
// turns the descriptions into meshes.

import { APPROACH_REACH } from './approach';
import type { EndCut, NodeDescription, RoadDescription } from './description';
import { samplePath } from './geometry';
import { endsOf, type RoadGeo } from './ends';
import {
	addShare,
	type ApproachPlan,
	approachPlans,
	crossingHolds,
	type MeetingView,
	type Net,
	type Share,
	type Shares,
	type SidesView
} from './holds';
import { drawJunction, type Holds } from './node';
import { endKey, type Junction, type Place, type Surface } from './model';
import { type Box, BoxGrid, boxOf, type Crossed, overlap, pointsOf } from './overlay';
import { describeRoad } from './road';
import { fromPath, wholly } from './clip';

// A node is paved in the material that carries the most car-lane width
// across its arms, each arm counting its car lanes where it meets the node.
// It reads only lane widths and materials, so dragging a road never changes
// it. Ties go to the first material in this order, asphalt first.
const PAVING_ORDER: Surface[] = ['asphalt', 'pavement', 'concrete', 'dirt', 'grass', 'hatch'];

function pavingOf(junction: Junction, roads: Map<string, RoadGeo>) {
	const width = new Map<Surface, number>();
	for (const e of junction.ends) {
		for (const lane of roads.get(e.road)?.road.lanes ?? [])
			if (lane.kind === 'drive')
				width.set(lane.surface, (width.get(lane.surface) ?? 0) + lane.width);
	}
	let best: Surface = 'asphalt';
	for (const surface of PAVING_ORDER)
		if ((width.get(surface) ?? 0) > (width.get(best) ?? 0)) best = surface;
	return best;
}

// What a network laid over this one crosses on it near a box (overlay.ts):
// that ground, and a key that changes whenever it does ('' for none).
export type Over = (box: Box, id: string) => { ground: Crossed[]; key: string };

interface Piece<D> {
	key: string;
	description: D;
	box: Box;
}

// What a crossing's decision (holds.ts) read of the network, each read named
// with the key of what it found: a road (its key: its lanes, shape and own
// crossings), a node (its key: what it is, its own crossings and cuts), the
// node at a road end, a junction's approach plans, and the crossings laid
// over a piece near a box. A decision is kept from paint to paint while
// every read finds the same.
type Read =
	| { ask: 'road' | 'node' | 'end' | 'plan'; id: string }
	| { ask: 'laid'; id: string; box: Box };
interface Decision {
	shares: Shares;
	reads: (Read & { key: string })[];
}

// A token for an object, to key what was read of it where it has no key of
// its own: another object is another token.
const tokens = new WeakMap<object, number>();
let token = 0;
const tokenOf = (o: object) => {
	let known = tokens.get(o);
	if (known === undefined) tokens.set(o, (known = ++token));
	return known;
};

// How many pieces paint looks at, counted only while a test turns counting
// on (`on`): with it off nothing is written.
export const looked = { on: false, count: 0 };

// The cut of a road end at no node.
const FREE: EndCut = Object.freeze({ paint: 0, nose: null });

export class Drawing {
	place: Place;
	geos: Map<string, RoadGeo>;
	// Each piece as its own network draws it, and as painted with what a
	// network laid over it crosses on it (`paint`), which is the piece's own
	// description where nothing does.
	private roads = new Map<string, Piece<RoadDescription> & { cut: string }>();
	private nodes = new Map<
		string,
		Piece<NodeDescription> & {
			ends: Box;
			paint: (over: Crossed[], holds: Holds) => NodeDescription;
			view: SidesView | MeetingView;
		}
	>();
	// The node each road end is at, by end key.
	private endAt = new Map<string, string>();
	// Each painted piece with the key of the piece it was painted from
	// (`base`, a road's end cuts) and of its share of the lines held traffic
	// meets crossings at (`holds`, holds.ts).
	// With each, the crossings laid over it it was painted with (`laid`).
	private paintedRoads = new Map<
		string,
		Piece<RoadDescription> & { base: string; cut: string; holds: string; laid: Crossed[] }
	>();
	private paintedNodes = new Map<
		string,
		Piece<NodeDescription> & { base: string; holds: string; laid: Crossed[] }
	>();
	private painted = false;
	// Whether it drew since it last painted (build), and where each piece
	// lies, filed by the box its paint reads what is laid over it in (a
	// node's `ends`, a road's box), with each road and junction by its id.
	private redrawn = true;
	private nodeGrid = new BoxGrid<string>();
	private roadGrid = new BoxGrid<string>();
	private placed = {
		roads: new Map<string, Place['roads'][number]>(),
		junctions: new Map<string, Place['junctions'][number]>()
	};
	// Each crossing's decision as last made, and each junction's approach
	// plans with the key of what they were made from (its own key and what is
	// laid over it): kept from paint to paint while what they read stays the
	// same.
	private decisions = new WeakMap<Crossed, Decision>();
	private plans = new Map<
		string,
		{ key: string; plans: Map<string, ApproachPlan>; shares: Shares }
	>();

	// `geos` are the place's roads with their paths sampled (core/place.ts
	// hands them over; a place read back without them samples its own).
	constructor(place: Place, geos?: Map<string, RoadGeo>) {
		this.place = place;
		this.geos =
			geos ??
			new Map(
				[...place.roads, ...place.hidden].map((r) => [r.id, { road: r, path: samplePath(r) }])
			);
	}

	// The place and roads the last build drew from.
	private drawn: [Place, Map<string, RoadGeo>] | null = null;

	// Nodes first: each says where the paint of the roads ending at it stops.
	// The same place and roads (one object each while nothing in them
	// changed: PlaceBuilder.build) draw as they did. Whether it drew.
	build() {
		this.painted = false;
		if (this.drawn?.[0] === this.place && this.drawn[1] === this.geos) return false;
		this.drawn = [this.place, this.geos];
		const live = new Set<string>();
		const cuts = new Map<string, EndCut>();
		this.endAt.clear();
		for (const j of this.place.junctions) {
			live.add(j.id);
			for (const e of j.ends) this.endAt.set(endKey(e), j.id);
			let node = this.nodes.get(j.id);
			if (node?.key !== j.key) {
				this.nodeGrid.remove(j.id);
				const ends = endsOf(j, this.geos);
				const { description, paint, view } = drawJunction(
					j,
					ends,
					pavingOf(j, this.geos),
					j.parts?.map((ends) => endsOf({ ends }, this.geos))
				);
				node = {
					key: j.key,
					description,
					paint,
					view,
					box: boxOf(pointsOf(description)),
					// Its paint reaches back along its roads as far as an
					// approach's does.
					ends: boxOf(
						ends.flatMap((e) => e.lanes.map((l) => l.point)),
						APPROACH_REACH
					)
				};
				this.nodes.set(j.id, node);
				this.nodeGrid.add(node.ends, j.id);
			}
			for (const [end, cut] of node.description.cuts) cuts.set(end, cut);
		}
		for (const id of [...this.nodes.keys()])
			if (!live.has(id)) {
				this.nodes.delete(id);
				this.plans.delete(id);
				this.nodeGrid.remove(id);
			}
		// Only the roads drawn now are kept for next time.
		const roads: typeof this.roads = new Map();
		for (const road of this.place.roads) {
			const c = this.cutsOf(road.id, cuts);
			const cut = this.cutKey(c);
			const key = `${road.key}|${cut}`;
			const known = this.roads.get(road.id);
			if (known?.key === key) roads.set(road.id, known);
			else {
				const path = this.geos.get(road.id)?.path ?? samplePath(road);
				const description = describeRoad(road, path, c);
				const box = boxOf(pointsOf(description));
				roads.set(road.id, { key, description, box, cut });
				this.roadGrid.remove(road.id);
				this.roadGrid.add(box, road.id);
			}
		}
		for (const id of this.roads.keys()) if (!roads.has(id)) this.roadGrid.remove(id);
		this.roads = roads;
		this.placed = {
			roads: new Map(this.place.roads.map((r) => [r.id, r])),
			junctions: new Map(this.place.junctions.map((j) => [j.id, j]))
		};
		this.redrawn = true;
		return true;
	}

	// The pieces drawn again with what a network laid over this one crosses
	// on them (`over`): each node with the crossings on it and on its roads
	// near it, then each road with its own crossings and its nodes' cuts, and
	// each with its share of where the traffic meeting those crossings is
	// held (holds.ts), decided once for each crossing and each junction's
	// approaches, and kept from paint to paint while what the decision read
	// reads the same. A piece nothing is laid over near keeps its own
	// drawing.
	//
	// Only pieces drawn afresh, or near ground crossed that came or went
	// since the last paint (`changed`, by the boxes round it), read what is
	// laid over them again. A decision hands its shares only to the pieces
	// its crossing is drawn on (Crossed.on), so wherever one may have come,
	// changed or gone, every one of those pieces has its share read again,
	// and is drawn again where that changed: for each crossing laid over a
	// piece read again, or over the nodes at its ends, now or when it was last
	// painted (one gone since takes its lines and clearing from all of them),
	// and for each junction such a piece is or ends at, the junction and its
	// roads.
	paint(over: Over, changed: Box[]) {
		const near = (box: Box) => changed.some((b) => overlap(b, box));
		const laidOn = new Map<string, ReturnType<Over>>();
		const laid = (id: string) => {
			let known = laidOn.get(id);
			if (!known) {
				const node = this.nodes.get(id);
				const box = node ? node.ends : this.roads.get(id)?.box;
				known = box ? over(box, id) : { ground: [], key: '' };
				laidOn.set(id, known);
			}
			return known;
		};
		// What is laid over a piece near a box.
		const laidNear = new Map<string, ReturnType<Over>>();
		const nearOn = (id: string, box: Box) => {
			const k = `${id}|${box.join()}`;
			let known = laidNear.get(k);
			if (!known) laidNear.set(k, (known = over(box, id)));
			return known;
		};
		// Each junction's approaches, made again only where it or what is laid
		// over it changed.
		const planOf = (id: string) => {
			const node = this.nodes.get(id);
			if (node?.view.kind !== 'meeting') return undefined;
			const on = laid(id);
			const key = `${node.key}|${on.key}`;
			let known = this.plans.get(id);
			if (known?.key !== key) {
				known = {
					key,
					...approachPlans(
						node.view,
						on.ground.filter((c) => c.traffic)
					)
				};
				this.plans.set(id, known);
			}
			return known;
		};
		const keyOf = (r: Read) => {
			if (r.ask === 'laid') return nearOn(r.id, r.box).key;
			if (r.ask === 'road') {
				const geo = this.geos.get(r.id);
				return geo ? (geo.road.key ?? `#${tokenOf(geo)}`) : '';
			}
			if (r.ask === 'node') return this.nodes.get(r.id)?.key ?? '';
			if (r.ask === 'end') return this.endAt.get(r.id) ?? '';
			return planOf(r.id)?.key ?? '';
		};
		// The network as a decision reads it, each read noted with its key.
		const netFor = (reads: Map<string, Read & { key: string }>): Net => {
			const note = (r: Read) => {
				const k = `${r.ask}|${r.id}${r.ask === 'laid' ? `|${r.box.join()}` : ''}`;
				if (!reads.has(k)) reads.set(k, { ...r, key: keyOf(r) });
			};
			const at = (end: string) => {
				note({ ask: 'end', id: end });
				return this.endAt.get(end);
			};
			return {
				geo: (id) => {
					note({ ask: 'road', id });
					return this.geos.get(id);
				},
				sides: (id) => {
					note({ ask: 'node', id });
					const view = this.nodes.get(id)?.view;
					return view?.kind === 'sides' ? view : undefined;
				},
				at,
				laid: (id, box) => {
					note({ ask: 'laid', id, box });
					return nearOn(id, box).ground;
				},
				own: (id) => {
					note({ ask: 'node', id });
					return this.nodes.get(id)?.description.crossings.flatMap((c) => c.body) ?? [];
				},
				stop: (end) => {
					const node = at(end);
					if (!node) return null;
					note({ ask: 'node', id: node });
					const cut = this.nodes.get(node)?.description.cuts.get(end);
					return cut ? { paint: cut.paint, carried: cut.nose !== null } : null;
				},
				takes: (end) => {
					const node = at(end);
					if (!node) return undefined;
					note({ ask: 'plan', id: node });
					return planOf(node)?.plans.get(end)?.takes;
				}
			};
		};
		const piecesOf = (c: Crossed) =>
			c.on ??
			[
				...[...this.roads].filter(([, r]) => overlap(r.box, boxOf(c.rings.flatMap(fromPath)))),
				...[...this.nodes].filter(([, n]) => overlap(n.ends, boxOf(c.rings.flatMap(fromPath))))
			].map(([id]) => id);
		// Each crossing's decision, made again only where something it read
		// reads otherwise now.
		const decided = new Set<Crossed>();
		const decide = (c: Crossed) => {
			let known = this.decisions.get(c);
			if (known && decided.has(c)) return known.shares;
			decided.add(c);
			if (!known || !known.reads.every((r) => keyOf(r) === r.key)) {
				const reads = new Map<string, Read & { key: string }>();
				const shares = crossingHolds(c, piecesOf(c), netFor(reads));
				known = { shares, reads: [...reads.values()] };
				this.decisions.set(c, known);
			}
			return known.shares;
		};
		// What a piece is handed of the decisions: of the lines for the
		// crossings laid over it, those falling on it and the ground they
		// clear there, and of the junctions it is a road of or is, their
		// approaches'.
		const junctionsOf = (id: string) =>
			this.nodes.has(id)
				? [id]
				: (['start', 'end'] as const).flatMap((end) => {
						const at = this.endAt.get(endKey({ road: id, end }));
						return at ? [at] : [];
					});
		const shares = new Map<string, { share: Share; key: string }>();
		// The crossings whose lines may fall on a piece: those laid over it,
		// and over the nodes at a road's ends (whose ground, reaching as far
		// back along their roads as an approach's paint does, holds every
		// crossing a line on the road can stand for).
		const sourcesOf = (id: string) =>
			new Set([
				...laid(id).ground,
				...(this.nodes.has(id) ? [] : junctionsOf(id).flatMap((j) => laid(j).ground))
			]);
		const shareOf = (id: string) => {
			let known = shares.get(id);
			if (!known) {
				const into: Shares = new Map();
				for (const c of sourcesOf(id)) {
					if (!c.traffic) continue;
					const mine = decide(c).get(id);
					if (mine) addShare(into, id, mine);
				}
				for (const j of junctionsOf(id)) {
					const mine = planOf(j)?.shares.get(id);
					if (mine) addShare(into, id, mine);
				}
				const share = into.get(id) ?? { signs: [], cleared: [] };
				known = {
					share,
					key: share.signs.length || share.cleared.length ? JSON.stringify(share) : ''
				};
				shares.set(id, known);
			}
			return known;
		};
		const paintedOf = (id: string) => this.paintedNodes.get(id) ?? this.paintedRoads.get(id);
		// The pieces to draw again: those drawn afresh or near ground crossed
		// that came or went, and every piece whose share of a decision they
		// read changed with it.
		// Where nothing was drawn since the last paint, every piece was
		// painted from its own drawing as it is, so only those near what came
		// or went are looked at, found in the grids; otherwise every piece.
		const whole = this.redrawn;
		const dirty = new Set<string>();
		if (whole) {
			for (const j of this.place.junctions) {
				if (looked.on) looked.count++;
				const own = this.nodes.get(j.id)!;
				const node = this.paintedNodes.get(j.id);
				if (node?.base !== own.key || near(own.ends)) dirty.add(j.id);
			}
			for (const road of this.place.roads) {
				if (looked.on) looked.count++;
				const own = this.roads.get(road.id)!;
				const piece = this.paintedRoads.get(road.id);
				if (piece?.base !== own.key || near(own.box)) dirty.add(road.id);
			}
		} else
			for (const b of changed)
				for (const id of [...this.nodeGrid.near(b), ...this.roadGrid.near(b)]) {
					if (looked.on) looked.count++;
					dirty.add(id);
				}
		const queue = [...dirty];
		const read = new Set<Crossed | string>();
		const check = (ids: Iterable<string>) => {
			for (const q of ids)
				if (!dirty.has(q) && (this.nodes.has(q) || this.roads.has(q)))
					if (shareOf(q).key !== (paintedOf(q)?.holds ?? '')) {
						dirty.add(q);
						queue.push(q);
					}
		};
		// Every piece a crossing's decision may hand a share.
		const follow = (c: Crossed) => {
			if (read.has(c) || !c.traffic) return;
			read.add(c);
			check(piecesOf(c));
		};
		// What was laid over pieces painted last time and drawn no more.
		if (whole)
			for (const [id, piece] of [...this.paintedRoads, ...this.paintedNodes])
				if (!this.roads.has(id) && !this.nodes.has(id)) piece.laid.forEach(follow);
		while (queue.length) {
			const id = queue.pop()!;
			for (const c of sourcesOf(id)) follow(c);
			for (const c of paintedOf(id)?.laid ?? []) follow(c);
			for (const j of junctionsOf(id)) {
				if (read.has(j)) continue;
				read.add(j);
				const view = this.nodes.get(j)?.view;
				check([j, ...(view?.kind === 'meeting' ? view.junction.ends.map((e) => e.road) : [])]);
			}
		}
		// Each piece painted: the last paint's where it was not drawn again
		// and stays the same, its own drawing where nothing is laid over it.
		const paintNode = (id: string) => {
			if (looked.on) looked.count++;
			const own = this.nodes.get(id)!;
			const node = this.paintedNodes.get(id);
			if (node && !dirty.has(id)) return node;
			const on = laid(id);
			const { share, key: holds } = shareOf(id);
			const plan = planOf(id);
			const key = on.key || holds ? `${own.key}|${on.key}|${holds}` : own.key;
			if (node?.key === key) return node;
			return {
				key,
				base: own.key,
				holds,
				laid: on.ground,
				description:
					on.key || holds
						? wholly(() => own.paint(on.ground, { share, plans: plan?.plans }))
						: own.description,
				box: own.box
			};
		};
		// A road's end cuts, as the node painted at each end cuts it.
		const cutAt = {
			get: (end: string) => {
				const node = this.endAt.get(end);
				return node === undefined
					? undefined
					: this.paintedNodes.get(node)?.description.cuts.get(end);
			}
		};
		const paintRoad = (road: Place['roads'][number]) => {
			if (looked.on) looked.count++;
			const own = this.roads.get(road.id)!;
			const c = this.cutsOf(road.id, cutAt);
			const cut = this.cutKey(c);
			const piece = this.paintedRoads.get(road.id);
			if (piece && !dirty.has(road.id) && piece.cut === cut) return piece;
			const on = laid(road.id);
			const { share, key: holds } = shareOf(road.id);
			const key = `${own.key}|${cut}|${on.key}|${holds}`;
			if (piece?.key === key) return piece;
			const description =
				!on.key && !holds && cut === own.cut
					? own.description
					: wholly(() =>
							describeRoad(
								road,
								this.geos.get(road.id)?.path ?? samplePath(road),
								c,
								on.ground,
								share
							)
						);
			return { key, base: own.key, cut, holds, laid: on.ground, description, box: own.box };
		};
		if (whole) {
			const nodes: typeof this.paintedNodes = new Map();
			for (const j of this.place.junctions) nodes.set(j.id, paintNode(j.id));
			this.paintedNodes = nodes;
			const roads: typeof this.paintedRoads = new Map();
			for (const road of this.place.roads) roads.set(road.id, paintRoad(road));
			this.paintedRoads = roads;
		} else {
			// Only the pieces looked at, and the roads ending at a node painted
			// afresh, whose cuts may have changed with it.
			const recut = new Set<string>();
			for (const id of dirty) {
				const junction = this.placed.junctions.get(id);
				if (!junction) continue;
				const node = paintNode(id);
				if (node === this.paintedNodes.get(id)) continue;
				this.paintedNodes.set(id, node);
				for (const e of junction.ends) recut.add(e.road);
			}
			for (const id of new Set([...dirty, ...recut])) {
				const road = this.placed.roads.get(id);
				if (road) this.paintedRoads.set(id, paintRoad(road));
			}
		}
		this.redrawn = false;
		this.painted = true;
	}

	private cutsOf(id: string, cuts: Pick<Map<string, EndCut>, 'get'>) {
		return {
			start: cuts.get(endKey({ road: id, end: 'start' })) ?? FREE,
			end: cuts.get(endKey({ road: id, end: 'end' })) ?? FREE
		};
	}

	// What a road's end cuts read as, to tell them from the last ones: each
	// cut's JSON, read once per object (a node drawn again makes new ones,
	// and never changes one it made).
	private cutTexts = new WeakMap<EndCut, string>();
	private cutKey(c: { start: EndCut; end: EndCut }) {
		const text = (cut: EndCut) => {
			let known = this.cutTexts.get(cut);
			if (known === undefined) this.cutTexts.set(cut, (known = JSON.stringify(cut)));
			return known;
		};
		return `${text(c.start)}|${text(c.end)}`;
	}

	// Each piece as its own network draws it, before anything is laid over
	// it, with its key and the box round it: what overlay.ts lays a network
	// over.
	pieces() {
		return [
			...[...this.roads].map(([id, r]) => ({
				id,
				key: r.key,
				description: r.description,
				box: r.box
			})),
			...[...this.nodes].map(([id, n]) => ({
				id,
				key: n.key,
				description: n.description,
				box: n.box
			}))
		];
	}

	// A road's or node's piece as its own network draws it, and the box round
	// it.
	own(id: string, node = false) {
		const piece = (node ? this.nodes : this.roads).get(id);
		return piece && { description: piece.description, box: piece.box };
	}

	// Whether a node piece is a junction where roads meet, not a node of two
	// sides.
	meets(id: string) {
		return this.nodes.get(id)?.view.kind === 'meeting';
	}

	road(id: string) {
		return (this.painted ? this.paintedRoads : this.roads).get(id)?.description;
	}

	node(id: string) {
		return (this.painted ? this.paintedNodes : this.nodes).get(id)?.description;
	}
}
