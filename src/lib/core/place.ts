// The editor's graph read as the road model the drawing runs on (src/lib/road-model,
// docs/road-model.md): every segment is a road with one cross-section, every
// node two or more segments meet at is a junction of their ends. Roads stop short of
// their junctions by a setback worked out here, so the junction has room for
// its curb corners or for lanes to find their way across; the junction's
// connections are the defaults plus the user's edits stored on the node.

import { APPROACH_PAINT, CROSSING_FROM_END } from '../road-model/approach';
import { kindOf } from '../road-model/connect';
import { defaultCrossings, defaults, SHORT_LINK } from '../road-model/defaults';
import { endsOf, type RoadGeo } from '../road-model/ends';
import { type PathSample, samplePath, TAPER, dot } from '../road-model/geometry';
import { effectiveJunctions } from '../road-model/merge';
import {
	type Connection,
	type DrawnJunction,
	type End,
	endKey,
	type Junction,
	type Lane,
	type Place,
	type Pt,
	type Road
} from '../road-model/model';
import { segmentEnds } from './attach';

import type { Graph } from './graph.svelte';
import { offsetAt } from './road-line';
import { type Curve, curveOf, headingFrom, outward, piece, pointAt, STEPS } from './segment-curve';
import type { Segment } from './segment.svelte';
import { type Arm, linkSetbacks, setbacks, taperFor } from './setbacks';
import type { JunctionCrossing, JunctionData, Lane as EditorLane } from './types';

// The role says what a lane carries, the material what it is made of. A
// buffer's material also decides its shape: asphalt is a painted (hatched)
// median, concrete or grass a raised one.
export function modelLane(lane: EditorLane, fallbackId: string): Lane {
	const id = lane.id ?? fallbackId;
	const buffer = lane.role === 'buffer';
	const surface =
		lane.material === 'asphalt'
			? buffer
				? 'hatch'
				: 'asphalt'
			: lane.material === 'concrete'
				? buffer
					? 'concrete'
					: 'pavement'
				: lane.material;
	if (lane.role === 'vehicle') {
		const dir =
			lane.direction === 'forward' ? 'fwd' : lane.direction === 'backward' ? 'back' : 'both';
		return { id, kind: 'drive', width: lane.width, dir, surface };
	}
	if (lane.role === 'pedestrian') {
		return { id, kind: 'walk', width: lane.width, dir: 'none', surface };
	}
	return { id, kind: 'buffer', width: lane.width, dir: 'none', surface };
}

// A segment's road from d0 past its start to d1 short of its end. The shift
// blends from one end's to the other's with distance along the whole segment
// (road-line.ts); the road starts d0 in.
function roadOf(segment: Segment, curve: Curve, d0: number, d1: number) {
	const lean = (segment.offsetEnd - segment.offsetStart) / (curve.length || 1);
	const road: Road = {
		id: segment.id,
		points: piece(curve, d0, curve.length - d1),
		lanes: segment.lanes.map((l, i) => modelLane(l, `l${i}`)),
		offset: segment.offsetStart + lean * d0
	};
	if (lean) road.lean = lean;
	return road;
}

// A taper never eats the last of its road: at least this much is left beyond
// it before the road's far end (or the far node's own setback).
const ROAD_LEFT = 5;

// Where a cross-section's roadway lies across it, from its centre.
function curbOf(lanes: EditorLane[]) {
	const total = lanes.reduce((sum, l) => sum + l.width, 0);
	let x = -total / 2;
	let lo = Infinity;
	let hi = -Infinity;
	for (const lane of lanes) {
		if (lane.role === 'vehicle') {
			lo = Math.min(lo, x);
			hi = Math.max(hi, x + lane.width);
		}
		x += lane.width;
	}
	if (lo > hi) return { total, lo: -total / 2, hi: total / 2, walks: false, foot: true };
	const walks = lo > -total / 2 + 0.05 || hi < total / 2 - 0.05;
	return { total, lo, hi, walks, foot: false };
}

const laneSig = (lane: EditorLane, flip: boolean) => {
	const dir =
		lane.direction === 'bidirectional' ? 'b' : (lane.direction === 'forward') !== flip ? 'o' : 'i';
	return `${lane.role}:${lane.material}:${lane.width}:${lane.role === 'vehicle' ? dir : ''}`;
};

function armKey(segment: Segment, end: End) {
	const lanes = end === 'start' ? segment.lanes : [...segment.lanes].reverse();
	return lanes.map((l) => laneSig(l, end === 'end')).join(',');
}

const mirror = (key: string) =>
	key
		.split(',')
		.reverse()
		.map((s) => s.replace(/:o$/, ':x').replace(/:i$/, ':o').replace(/:x$/, ':i'))
		.join(',');

// Whether two roads meeting at a node carry the same lanes on through it (a
// plain bend or continuation rather than a change of cross-section).
export const carriesOn = (a: Segment, aEnd: End, b: Segment, bEnd: End) =>
	mirror(armKey(a, aEnd)) === armKey(b, bEnd);

// The way a road attached at an edge heads off from its node, which decides
// the side of the node it goes with: its heading where it has got clear of
// the node, the first point out along it where none of its width lies over
// what stands side by side at the node (the roads it joins, `hosts`, carried
// straight on along `lead`, and its own place beside them). A curve arriving
// across the road it joins can point either way before that; from there on
// it has settled which way it came from. A road that never gets clear is
// read where it leaves the node. Only the roads' lines and widths are read, never a
// trim or a picked distance: the trims follow from the connections this
// decides, and the answer is the same at any scale.
function wayOf(arm: Arm, lead: Arm, hosts: Arm[]) {
	const { curve, end } = arm;
	if (!curve.c) return arm.out;
	const at = lead.end === 'start' ? lead.curve.a : lead.curve.b;
	const across = (p: Pt) => (p.x - at.x) * lead.n.x + (p.y - at.y) * lead.n.y;
	const half = (arm.full.hi - arm.full.lo) / 2;
	const own = across(end === 'start' ? curve.a : curve.b);
	let lo = own - half;
	let hi = own + half;
	for (const host of hosts) {
		const same = dot(host.n, lead.n) >= 0;
		lo = Math.min(lo, same ? host.full.lo : -host.full.hi);
		hi = Math.max(hi, same ? host.full.hi : -host.full.lo);
	}
	for (let i = 1; i < STEPS; i++) {
		const u = i / STEPS;
		const x = across(pointAt(curve, end === 'start' ? u : 1 - u));
		if (x - half > hi || x + half < lo) return headingFrom(curve, end, u);
	}
	return arm.out;
}

// How far a node reaches along each of its two sides (`groups`) at least,
// for the roads attached there beside roads carrying on through it: as far
// along each as it lies over a road it joins, that road's sidewalks and
// verges included, to the point where none of its width does (give or take
// 5 cm). A road it joins lies along its own line out of the node, from where
// it stops short of it at the least (TAPER.THROUGH_GAP), so the attached road
// is over it where it reaches that far to that road's side of the node,
// within its width. So wherever an attached road's lanes cut through the
// sidewalk or verge of the road it joins, they do so across the node, where
// a car lane comes first and a sidewalk carries on as a crossing
// (road-model/node.ts); two roads' own surfaces never lie over each other
// beyond it. A road that never gets clear counts whole.
function clearOf(groups: [Arm[], Arm[]], attached: Record<string, string>) {
	const hosts = groups.flat().filter((a) => !attached[a.segment.id]);
	if (!groups.every((g) => g.some((a) => hosts.includes(a)))) return [0, 0];
	return groups.map((group) => {
		let reach = 0;
		for (const arm of group) {
			if (hosts.includes(arm)) continue;
			const { curve, end } = arm;
			const half = (arm.full.hi - arm.full.lo) / 2;
			// Whether it lies over a road it joins, a fraction u of the way
			// along it from the node.
			const over = (u: number) => {
				const p = pointAt(curve, end === 'start' ? u : 1 - u);
				const heading = headingFrom(curve, end, u);
				return hosts.some((host) => {
					const at = host.end === 'start' ? host.curve.a : host.curve.b;
					const off = { x: p.x - at.x, y: p.y - at.y };
					// Its width as it lies along and across that road there.
					const along = half * Math.abs(dot(heading, host.n));
					const across = half * Math.abs(dot(heading, host.out));
					const x = dot(off, host.n);
					return (
						dot(off, host.out) + along > TAPER.THROUGH_GAP &&
						x + across > host.full.lo + 0.05 &&
						x - across < host.full.hi - 0.05
					);
				});
			};
			// How far along it from the node a fraction u of it is.
			const distance = (u: number) => {
				const t = (end === 'start' ? u : 1 - u) * STEPS;
				const k = Math.min(STEPS - 1, Math.floor(t));
				const d = curve.arc[k] + (curve.arc[k + 1] - curve.arc[k]) * (t - k);
				return end === 'start' ? d : curve.length - d;
			};
			// Its sampled points from the node on: the first that lies over a
			// road (within its own width or so of the node, or it never does),
			// then the first after that which is clear, then the point between
			// that one and the one before where it gets clear.
			let i = 0;
			while (i < STEPS && !over(i / STEPS) && distance(i / STEPS) <= 2 * half + 1) i++;
			if (!over(i / STEPS)) continue;
			while (i <= STEPS && over(i / STEPS)) i++;
			let u = 1;
			if (i <= STEPS) {
				let [lo, hi] = [(i - 1) / STEPS, i / STEPS];
				for (let k = 0; k < 12; k++) {
					const mid = (lo + hi) / 2;
					if (over(mid)) lo = mid;
					else hi = mid;
				}
				u = hi;
			}
			reach = Math.max(reach, distance(u));
		}
		return reach;
	});
}

// A node's two sides, when its lanes find their way across it from one to
// the other instead of meeting at a junction: two roads, or roads attached
// at an edge (`sides`) beside the ones they join, each with the road going
// its way. Each side is led by a road not attached at an edge where there is
// one. This is the one place the sides are decided: the junction carries
// them (`Junction.link`) to its connections and its drawing.
function linkGroups(arms: Arm[], sides: Record<string, string> | undefined): [Arm[], Arm[]] | null {
	if (arms.length === 2) return [[arms[0]], [arms[1]]];
	const attached = (a: Arm) => !!sides?.[a.segment.id];
	if (!arms.some(attached)) return null;
	const mains = arms.filter((a) => !attached(a));
	if (mains.length > 2) return null;
	const lead = mains[0] ?? arms[0];
	const hosts = mains.length ? mains : [lead];
	const a = arms.filter(
		(x) => x === lead || (x !== mains[1] && attached(x) && dot(wayOf(x, lead, hosts), lead.out) > 0)
	);
	const b = arms.filter((x) => !a.includes(x));
	if (!b.length) return null;
	// The other side led by its own road where it has one.
	b.sort((x, y) => Number(attached(x)) - Number(attached(y)));
	return [a, b];
}

// A node's junction: its ends, its connections (the defaults, less those
// removed by hand, plus those added by hand) and its approaches, read off
// the roads in `geos`. Roads attached at an edge are anchored where their
// drawn ends lie. A node of two sides (`groups`) carries them, so its
// connections here and its drawing later sort its roads the same way.
function junctionOf(
	nodeId: string,
	arms: Arm[],
	stored: JunctionData | undefined,
	geos: Map<string, RoadGeo>,
	curves: Map<string, Curve>,
	groups?: [Arm[], Arm[]]
) {
	const ends = arms.map((a) => ({ road: a.segment.id, end: a.end }));
	const junction: Junction = {
		id: nodeId,
		ends,
		connections: [],
		walkways: [],
		control: {}
	};
	const keys = (group: Arm[]) => group.map((a) => endKey({ road: a.segment.id, end: a.end }));
	if (groups) junction.link = [keys(groups[0]), keys(groups[1])];
	const sides = arms
		.filter((a) => stored?.sides?.[a.segment.id])
		.map((a) => endKey({ road: a.segment.id, end: a.end }));
	if (sides.length) {
		junction.sides = sides;
		junction.anchors = {};
		for (const a of arms) {
			const key = endKey({ road: a.segment.id, end: a.end });
			const curve = curves.get(a.segment.id);
			if (sides.includes(key) && curve)
				junction.anchors[key] = a.end === 'start' ? curve.a : curve.b;
		}
	}
	const d = defaults(junction, geos);
	const keyOf = (r: Connection['from']) => `${endKey(r)}/${r.lane}`;
	const same = (x: Connection, y: Connection) =>
		(keyOf(x.from) === keyOf(y.from) && keyOf(x.to) === keyOf(y.to)) ||
		(keyOf(x.from) === keyOf(y.to) && keyOf(x.to) === keyOf(y.from));
	const here = new Set(
		ends.flatMap((e) => (geos.get(e.road)?.road.lanes ?? []).map((l) => `${endKey(e)}/${l.id}`))
	);
	const removed = stored?.removed ?? [];
	// An added connection stands while both its lanes exist and are still
	// of one kind.
	const kinds = new Map(
		ends.flatMap((e) =>
			(geos.get(e.road)?.road.lanes ?? []).map((l) => [`${endKey(e)}/${l.id}`, kindOf(l)])
		)
	);
	const added = (stored?.added ?? []).filter(
		(c) =>
			here.has(keyOf(c.from)) &&
			here.has(keyOf(c.to)) &&
			kinds.get(keyOf(c.from)) === kinds.get(keyOf(c.to))
	);
	junction.connections = [
		...d.connections.filter((c) => !removed.some((r) => same(r, c))),
		...added.filter((c) => !d.connections.some((x) => same(x, c)))
	];
	junction.walkways = d.walkways;
	// The defaults, with the approaches set by hand.
	junction.control = { ...d.control };
	for (const [key, c] of Object.entries(stored?.control ?? {}))
		if (key in d.control) junction.control[key] = c;
	return junction;
}

export interface Derived {
	place: Place;
	// Every road, merged away or not, with its sampled path.
	geos: Map<string, RoadGeo>;
	// Each node's junction, by node id.
	junctions: Map<string, Junction>;
	// Each node's crossings, defaults and hand-placed alike.
	crossings: Map<string, NodeCrossing[]>;
	// Each road along its segment: where it starts (d0), how long it is, and
	// the segment's whole length.
	spans: Map<string, { d0: number; length: number; total: number }>;
}

// A crossing as the editor sees it: stored or default (`auto`), on or off,
// and where along its road it landed (`place`, metres from the road's start)
// when it is drawn.
interface NodeCrossing extends JunctionCrossing {
	on: boolean;
	auto: boolean;
	place?: number;
}

// Where a crossing lies along its road, in metres from the road's start: at
// its stored distance from the node, or just past the corners, and never
// closer to either end of the road than half its depth and a little.
function crossingPlace(
	c: Pick<JunctionCrossing, 'end' | 'at'>,
	span: { d0: number; length: number; total: number }
) {
	if (c.at === undefined)
		return c.end === 'start' ? CROSSING_FROM_END : span.length - CROSSING_FROM_END;
	const along = (c.end === 'start' ? c.at : span.total - c.at) - span.d0;
	return Math.max(CROSSING_FROM_END, Math.min(span.length - CROSSING_FROM_END, along));
}

// The stored distance from the node for a crossing `place` metres along its
// road (the inverse of crossingPlace).
export function crossingAt(
	end: 'start' | 'end',
	place: number,
	span: { d0: number; length: number; total: number }
) {
	const along = span.d0 + place;
	return end === 'start' ? along : span.total - along;
}

export class PlaceBuilder {
	private junctionCache = new Map<string, { key: string; junction: Junction }>();
	// Per cross-section some road has: its curb, read once.
	private sections = new Map<string, ReturnType<typeof curbOf>>();
	// Each segment's curve, and its road's shape (with the path sampled
	// along it), kept while what they're made from stays the same; junction
	// keys name roads by the shape's number.
	private curveCache = new Map<string, { key: string; curve: Curve }>();
	private shapes = new Map<
		string,
		{ key: string; road: Road; path: PathSample; version: number }
	>();
	// Each road's shape and crossings together, numbered.
	private roadVersions = new Map<string, { json: string; shape: string; version: number }>();
	// Each junction's default crossings, kept while it and the links it ends
	// stay the same.
	private crossingCache = new Map<string, { key: string; list: NodeCrossing[] }>();
	// Whether a short road's two junctions touch (they merge), by road id,
	// kept while both junctions stay the same.
	private touching = new Map<string, { key: string; touching: boolean }>();
	private version = 0;
	// Each road ending at a node of two sides, whole (not yet trimmed back
	// from its nodes), numbered: that node's lanes are read off it.
	private wholeRoads = new Map<string, { key: string; geo: RoadGeo; version: number }>();
	// Each node of two sides' junction, read off its whole roads, with the
	// taper its connections' shifts need, the shortest it may be set to, and
	// how far it reaches along each side at least (clearOf). Kept while those
	// roads and the node's stored edits stay the same.
	private linkCache = new Map<
		string,
		{ key: string; junction: Junction; need: number; least: number; clear: number[] }
	>();
	// How far each road may be set to stop short of a node (node id, then
	// segment id), for the handles: at a node of two roads, its side of the
	// taper; at a junction of more, its setback.
	limits = new Map<string, Map<string, { min: number; max: number }>>();
	// A node whose tapers hold still (its connections are being edited), each
	// side's setback by segment id.
	private held: { node: string; setbacks: Map<string, number> } | null = null;

	// Keeps a node's tapers where they are until released.
	hold(nodeId: string | null) {
		this.held = nodeId ? { node: nodeId, setbacks: new Map(this.used.get(nodeId)) } : null;
	}
	// How far each side of each node of two sides stopped short of it in the
	// last build, by the segment id of the side's leading road.
	private used = new Map<string, Map<string, number>>();

	// A node's stored junction data as JSON, read once per object: edits
	// always replace the object.
	private jsonMemo = new WeakMap<object, string>();
	private json(data: object | undefined) {
		if (!data) return 'null';
		let text = this.jsonMemo.get(data);
		if (text === undefined) {
			text = JSON.stringify(data);
			this.jsonMemo.set(data, text);
		}
		return text;
	}

	// A segment's road untrimmed. Its key is what the trimmed shape's is
	// made of, less the trims: the curve (its drawn ends, so an end slid
	// along its host's edge by attachShift, and the control point), the
	// shifts at both ends and the lanes with their ids.
	private wholeRoad(segment: Segment, curve: Curve, curveKey: string) {
		const ids = segment.lanes.map((l) => l.id).join();
		const key = `${curveKey}|${segment.offsetStart},${segment.offsetEnd}|${segment.lanesKey}|${ids}`;
		let cached = this.wholeRoads.get(segment.id);
		if (cached?.key !== key) {
			const road = roadOf(segment, curve, 0, 0);
			cached = { key, geo: { road, path: samplePath(road) }, version: ++this.version };
			this.wholeRoads.set(segment.id, cached);
		}
		return cached;
	}

	// A node of two sides read at the node itself, off its roads untrimmed,
	// so the trims its taper sets never feed back into it. The key holds
	// each arm's whole-road number in arm order (which covers every heading,
	// anchor and lane that sorting its roads into sides and pairing their
	// lanes read) and the node's stored edits.
	private linkOf(
		nodeId: string,
		arms: Arm[],
		groups: [Arm[], Arm[]],
		stored: JunctionData | undefined,
		curves: Map<string, Curve>,
		curveKeys: Map<string, string>
	) {
		const whole = arms.map((a) =>
			this.wholeRoad(a.segment, curves.get(a.segment.id)!, curveKeys.get(a.segment.id)!)
		);
		const key = `${whole.map((w) => w.version).join()}|${this.json(stored)}`;
		const cached = this.linkCache.get(nodeId);
		if (cached?.key === key) return cached;
		const geos = new Map(arms.map((a, i) => [a.segment.id, whole[i].geo]));
		const junction = junctionOf(nodeId, arms, stored, geos, curves, groups);
		const link = {
			key,
			junction,
			...taperFor(junction, geos),
			clear: clearOf(groups, stored?.sides ?? {})
		};
		this.linkCache.set(nodeId, link);
		return link;
	}

	private crossingsAt(
		nodeId: string,
		junction: Junction,
		geos: Map<string, RoadGeo>,
		shortLink: (road: string) => boolean,
		junctionKey: string
	) {
		const key = `${junctionKey}|${junction.ends.map((e) => shortLink(e.road)).join()}`;
		const cached = this.crossingCache.get(nodeId);
		if (cached?.key === key) return cached;
		const list: NodeCrossing[] = defaultCrossings(junction, endsOf(junction, geos), shortLink).map(
			(d) => ({ road: d.end.ref.road, end: d.end.ref.end, lanes: d.lanes, on: d.on, auto: true })
		);
		return { key, list };
	}

	// A cross-section's curb, moved into `live`: the sections this build's
	// roads have, which is all the next build keeps.
	private section(segment: Segment, live: typeof this.sections) {
		let s = live.get(segment.lanesKey);
		if (!s) {
			s = this.sections.get(segment.lanesKey) ?? curbOf(segment.lanes);
			live.set(segment.lanesKey, s);
		}
		return s;
	}

	build(graph: Graph): Derived {
		const curves = new Map<string, Curve>();
		const curveKeys = new Map<string, string>();
		for (const segment of graph.segments.values()) {
			if (segment.startNodeId === segment.endNodeId) continue;
			// Its ends as drawn (an end attached at another road's edge moved
			// there).
			const ends = segmentEnds(graph, segment);
			if (!ends) continue;
			const { a, b } = ends;
			const key = `${a.x},${a.y},${b.x},${b.y},${segment.controlX},${segment.controlY}`;
			let cached = this.curveCache.get(segment.id);
			if (cached?.key !== key) {
				cached = { key, curve: curveOf(segment, a, b) };
				this.curveCache.set(segment.id, cached);
			}
			curves.set(segment.id, cached.curve);
			curveKeys.set(segment.id, key);
		}
		for (const id of [...this.curveCache.keys()]) if (!curves.has(id)) this.curveCache.delete(id);
		// Setbacks per segment end.
		const trims = new Map<string, number>();
		const armsAt = new Map<string, Arm[]>();
		// Nodes where lanes find their way across from one side to the other:
		// two roads, or roads attached at an edge with the ones they join.
		const links = new Map<string, [Arm[], Arm[]]>();
		const sections: typeof this.sections = new Map();
		for (const node of graph.nodes.values()) {
			const arms: Arm[] = [];
			for (const id of node.connectedSegments) {
				const segment = graph.segments.get(id);
				const curve = curves.get(id);
				if (!segment || !curve) continue;
				const end: End = segment.startNodeId === node.id ? 'start' : 'end';
				const section = this.section(segment, sections);
				const off = offsetAt(segment, end);
				const out = outward(curve, end);
				// The drawing direction leaves the start and arrives at the end.
				const along = end === 'start' ? out : { x: -out.x, y: -out.y };
				arms.push({
					segment,
					curve,
					end,
					out,
					n: { x: -along.y, y: along.x },
					full: { lo: -section.total / 2 + off, hi: section.total / 2 + off },
					roadway: { lo: section.lo + off, hi: section.hi + off },
					half: section.total / 2 + Math.abs(off),
					walks: section.walks,
					foot: section.foot
				});
			}
			if (arms.length < 2) continue;
			armsAt.set(node.id, arms);
			const groups = linkGroups(arms, node.junction?.sides);
			if (groups) links.set(node.id, groups);
			else
				for (const [arm, trim] of setbacks(arms)) trims.set(`${arm.segment.id}:${arm.end}`, trim);
		}
		this.sections = sections;
		// How much of a road its node at `end` may take: half of it when the
		// far node is one where lanes find their way across (the two may meet
		// in its middle), otherwise up to the far node's setback, leaving
		// `left`.
		const roomOf = (arm: Arm, left = ROAD_LEFT) => {
			const other = arm.end === 'start' ? arm.segment.endNodeId : arm.segment.startNodeId;
			const farEnd = arm.end === 'start' ? 'end' : 'start';
			const length = curves.get(arm.segment.id)?.length ?? 0;
			return links.has(other)
				? length / 2
				: length - (trims.get(`${arm.segment.id}:${farEnd}`) ?? 0) - left;
		};
		// Junctions of three or more: a road's setback set by hand makes the
		// junction bigger on it, never smaller than its curb corners need nor
		// past the far node's setback, leaving the road room for the paint
		// the junction lays on it (its crossing and stop line). Every automatic setback is known first,
		// so this reads the same whichever node comes first.
		this.limits.clear();
		const hand: [string, number][] = [];
		for (const [nodeId, arms] of armsAt) {
			if (links.has(nodeId)) continue;
			const set = graph.nodes.get(nodeId)?.junction?.setbacks;
			const limits = new Map<string, { min: number; max: number }>();
			for (const arm of arms) {
				const key = `${arm.segment.id}:${arm.end}`;
				const min = trims.get(key) ?? 0;
				const max = Math.max(min, roomOf(arm, Math.max(ROAD_LEFT, APPROACH_PAINT)));
				limits.set(arm.segment.id, { min, max });
				const value = set?.[arm.segment.id];
				if (value !== undefined) hand.push([key, Math.min(max, Math.max(min, value))]);
			}
			this.limits.set(nodeId, limits);
		}
		for (const [key, trim] of hand) trims.set(key, trim);
		// Nodes of two sides: their connections, and the taper those need,
		// read at the node before anything is trimmed. Each side's taper (set
		// by hand, held, or half what the shifts need) is never shorter than
		// the shifts allow nor so long it runs into the road's far node, nor
		// short of where a road attached on that side gets clear of the roads it
		// joins (clearOf). Left
		// to itself the taper is the same length both sides, as long as the
		// side with least room allows; past that the other side takes what it
		// can of the rest (a short footpath between this node and a junction
		// leaves its sidewalks to ease across on the road behind).
		const linked = new Map<string, Junction>();
		const allUsed: typeof this.used = new Map();
		for (const [nodeId, groups] of links) {
			const node = graph.nodes.get(nodeId)!;
			const arms = armsAt.get(nodeId)!;
			const link = this.linkOf(nodeId, arms, groups, node.junction, curves, curveKeys);
			linked.set(nodeId, link.junction);
			const lead = [groups[0][0], groups[1][0]];
			const rooms = groups.map((group) => Math.min(...group.map((arm) => roomOf(arm))));
			const shared = Math.min(...rooms);
			const limits = new Map<string, { min: number; max: number }>();
			const reach = lead.map((arm, k) => {
				const id = arm.segment.id;
				const max = Math.max(0, rooms[k]);
				const min = Math.min(link.least / 2, max);
				limits.set(id, { min, max });
				const set = node.junction?.setbacks?.[id];
				// Never short of where the roads attached on this side get clear.
				const far = (value: number) => Math.min(max, Math.max(value, link.clear[k]));
				if (set !== undefined) return { value: far(Math.max(min, set)), room: rooms[k] };
				const held = this.held?.node === nodeId ? this.held.setbacks.get(id) : undefined;
				const rest = held ?? link.need - Math.min(Math.max(0, shared), link.need / 2);
				const value = far(rest);
				return { value, room: Math.max(shared, value) };
			});
			if (groups.every((g) => g.length === 1)) this.limits.set(nodeId, limits);
			const result = linkSetbacks(lead[0], lead[1], [reach[0].value, reach[1].value]);
			const used = new Map<string, number>();
			for (const [k, group] of groups.entries()) {
				// A road too short for its far junction's setback and a taper
				// leaves no room here, but its end never reaches past the node.
				const trim = Math.min(result[k], Math.max(TAPER.THROUGH_GAP, reach[k].room));
				used.set(lead[k].segment.id, trim);
				for (const arm of group) trims.set(`${arm.segment.id}:${arm.end}`, trim);
			}
			allUsed.set(nodeId, used);
		}
		this.used = allUsed;

		const roads: Road[] = [];
		const shapeKeys = new Map<string, string>();
		// Where each road starts along its segment, and how long it is.
		const spans = new Map<string, { d0: number; length: number; total: number }>();
		for (const segment of graph.segments.values()) {
			const curve = curves.get(segment.id);
			if (!curve) continue;
			let d0 = trims.get(`${segment.id}:start`) ?? 0;
			let d1 = trims.get(`${segment.id}:end`) ?? 0;
			// Never trim a road away: two close junctions share what length
			// there is.
			const between = links.has(segment.startNodeId) && links.has(segment.endNodeId);
			const room = between
				? curve.length - TAPER.THROUGH_GAP
				: Math.max(curve.length - ROAD_LEFT, curve.length / 2);
			if (d0 + d1 > room) {
				const k = room / (d0 + d1);
				d0 *= k;
				d1 *= k;
			}
			// Junctions are keyed on the road's shape (numbered); its crossings
			// come later, onto a fresh copy each build.
			const ids = segment.lanes.map((l) => l.id).join();
			const shifts = `${segment.offsetStart},${segment.offsetEnd}`;
			const key = `${curveKeys.get(segment.id)}|${d0}|${d1}|${shifts}|${segment.lanesKey}|${ids}`;
			let shape = this.shapes.get(segment.id);
			if (shape?.key !== key) {
				const road = roadOf(segment, curve, d0, d1);
				shape = { key, road, path: samplePath(road), version: ++this.version };
				this.shapes.set(segment.id, shape);
			}
			roads.push({ ...shape.road });
			spans.set(segment.id, { d0, length: curve.length - d0 - d1, total: curve.length });
			shapeKeys.set(segment.id, String(shape.version));
		}

		const geos = new Map<string, RoadGeo>(
			roads.map((r) => [r.id, { road: r, path: this.shapes.get(r.id)!.path }])
		);
		const junctions = new Map<string, Junction>();
		const junctionKeys = new Map<string, string>();
		for (const [nodeId, arms] of armsAt) {
			const stored = graph.nodes.get(nodeId)!.junction;
			const key = `${arms.map((a) => shapeKeys.get(a.segment.id)).join()}|${this.json(stored)}`;
			junctionKeys.set(nodeId, key);
			// A node of two sides was read before the trims.
			let junction = linked.get(nodeId);
			if (!junction) {
				const cached = this.junctionCache.get(nodeId);
				junction =
					cached?.key === key ? cached.junction : junctionOf(nodeId, arms, stored, geos, curves);
				this.junctionCache.set(nodeId, { key, junction });
			}
			junctions.set(nodeId, junction);
		}
		for (const id of [...this.junctionCache.keys()])
			if (!armsAt.has(id) || links.has(id)) this.junctionCache.delete(id);
		for (const id of [...this.linkCache.keys()]) if (!links.has(id)) this.linkCache.delete(id);
		for (const id of [...this.wholeRoads.keys()]) if (!curves.has(id)) this.wholeRoads.delete(id);
		for (const id of [...this.shapes.keys()]) if (!shapeKeys.has(id)) this.shapes.delete(id);

		// Crossings: each junction's defaults, as stored edits move or switch
		// them, and those added by hand, placed on their roads.
		const arms = new Map<string, number>();
		for (const list of armsAt.values())
			for (const a of list) arms.set(`${a.segment.id}:${a.end}`, list.length);
		const shortLink = (road: string) =>
			(arms.get(`${road}:start`) ?? 0) > 2 &&
			(arms.get(`${road}:end`) ?? 0) > 2 &&
			(curves.get(road)?.length ?? Infinity) < SHORT_LINK;
		const crossings = new Map<string, NodeCrossing[]>();
		const crossingCache: typeof this.crossingCache = new Map();
		const byId = new Map(roads.map((r) => [r.id, r]));
		// Every junction, and any dead end holding a crossing of its own.
		const holders = [
			...junctions.keys(),
			...[...graph.nodes.values()]
				.filter((n) => !junctions.has(n.id) && n.junction?.crossings?.length)
				.map((n) => n.id)
		];
		for (const nodeId of holders) {
			const junction = junctions.get(nodeId);
			const stored = graph.nodes.get(nodeId)?.junction?.crossings ?? [];
			const kept = junction
				? this.crossingsAt(nodeId, junction, geos, shortLink, junctionKeys.get(nodeId)!)
				: undefined;
			if (kept) crossingCache.set(nodeId, kept);
			const list = kept?.list ?? [];
			const same = (x: JunctionCrossing, y: JunctionCrossing) =>
				x.road === y.road && x.end === y.end && x.lanes.every((l) => y.lanes.includes(l));
			const all: NodeCrossing[] = [
				...list.map((d) => {
					const s = stored.find((x) => same(x, d));
					return { ...d, ...s, on: s?.on ?? d.on, auto: true };
				}),
				...stored
					.filter((s) => !list.some((d) => same(s, d)))
					.map((s) => ({ ...s, on: s.on ?? true, auto: false }))
			];
			for (const c of all) {
				const road = byId.get(c.road);
				const span = spans.get(c.road);
				if (!road || !span || span.length < 2 * CROSSING_FROM_END) continue;
				if (!c.lanes.every((id) => road.lanes.some((l) => l.id === id))) continue;
				c.place = crossingPlace(c, span);
				if (c.on) road.crossings = [...(road.crossings ?? []), { at: c.place, lanes: c.lanes }];
			}
			crossings.set(nodeId, all);
		}
		this.crossingCache = crossingCache;
		const roadKeys = new Map<string, string>();
		for (const road of roads) {
			const json = JSON.stringify(road.crossings ?? []);
			const known = this.roadVersions.get(road.id);
			const shape = shapeKeys.get(road.id)!;
			const version =
				known?.json === json && known.shape === shape ? known.version : ++this.version;
			this.roadVersions.set(road.id, { json, shape, version });
			roadKeys.set(road.id, String(version));
		}
		for (const id of [...this.roadVersions.keys()])
			if (!roadKeys.has(id)) this.roadVersions.delete(id);

		// Junctions too close together draw as one (road-model/merge.ts). A drawn
		// junction's key holds its nodes' keys and those of every road they
		// end, the roads merged away between them included.
		const touching = new Map<string, { key: string; touching: boolean }>();
		const merged = effectiveJunctions(roads, [...junctions.values()], geos, (road, a, b, test) => {
			const key = `${junctionKeys.get(a.id)}|${junctionKeys.get(b.id)}`;
			let known = this.touching.get(road);
			if (known?.key !== key) known = { key, touching: test() };
			touching.set(road, known);
			return known.touching;
		});
		this.touching = touching;
		const drawn = merged.junctions.map(
			(j): DrawnJunction => ({
				...j,
				key: [
					...j.members.map((id) => junctionKeys.get(id)),
					...j.members.flatMap((id) => junctions.get(id)!.ends.map((e) => roadKeys.get(e.road)))
				].join('|')
			})
		);
		for (const road of roads) road.key = roadKeys.get(road.id);
		const place: Place = {
			roads: roads.filter((r) => !merged.hidden.has(r.id)),
			junctions: drawn
		};
		return { place, geos, junctions, crossings, spans };
	}
}
