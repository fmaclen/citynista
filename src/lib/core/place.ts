// The editor's graph read as the road model the drawing runs on (src/lib/lab,
// docs/road-model.md): every segment is a road with one cross-section, every
// node two or more segments meet at is a junction of their ends. Roads stop short of
// their junctions by a setback worked out here, so the junction has room for
// its curb corners or for lanes to find their way across; the junction's
// connections are the defaults plus the user's edits stored on the node.

import type { Graph } from './graph.svelte';
import { segmentEnds } from './attach';
import { offsetAt } from './road-line';
import type { Segment } from './segment.svelte';
import type { JunctionConnection, JunctionCrossing, Lane as EditorLane } from './types';
import { samplePath, type PathSample } from '../lab/geometry';
import {
	APPROACH_PAINT,
	CROSSING_FROM_END,
	NARROW,
	SHORT_LINK,
	defaultCrossings,
	defaults,
	endsOf,
	laneEndOf,
	type RoadGeo
} from '../lab/junction';
import { kindOf, lateral, sidePoint } from '../lab/connect';
import {
	endKey,
	type Connection,
	type End,
	type Junction,
	type Lane,
	type PathPoint,
	type Place,
	type Pt,
	type Road
} from '../lab/model';

// The role says what a lane carries, the material what it is made of. A
// buffer's material also decides its shape: asphalt is a painted (hatched)
// median, concrete or grass a raised one.
export function labLane(lane: EditorLane, fallbackId: string): Lane {
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

// ---- Segment curves (a straight line or one quadratic piece).

interface Curve {
	a: Pt;
	c: Pt | null;
	b: Pt;
	// Cumulative length at t = i / STEPS.
	arc: number[];
	length: number;
}

const STEPS = 64;

function quad(a: Pt, c: Pt, b: Pt, t: number): Pt {
	const u = 1 - t;
	return {
		x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
		y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
	};
}

function curveOf(segment: Segment, a: Pt, b: Pt): Curve {
	const c = segment.hasControlPoint ? { x: segment.controlX!, y: segment.controlY! } : null;
	const arc = [0];
	let prev = a;
	for (let i = 1; i <= STEPS; i++) {
		const p = c
			? quad(a, c, b, i / STEPS)
			: { x: a.x + ((b.x - a.x) * i) / STEPS, y: a.y + ((b.y - a.y) * i) / STEPS };
		arc.push(arc[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
		prev = p;
	}
	return { a, c, b, arc, length: arc[STEPS] };
}

function tAt(curve: Curve, distance: number) {
	const d = Math.max(0, Math.min(curve.length, distance));
	let i = 1;
	while (i < STEPS && curve.arc[i] < d) i++;
	const span = curve.arc[i] - curve.arc[i - 1];
	const f = span > 1e-9 ? (d - curve.arc[i - 1]) / span : 0;
	return (i - 1 + f) / STEPS;
}

function pointAt(curve: Curve, t: number): Pt {
	if (!curve.c)
		return {
			x: curve.a.x + (curve.b.x - curve.a.x) * t,
			y: curve.a.y + (curve.b.y - curve.a.y) * t
		};
	return quad(curve.a, curve.c, curve.b, t);
}

// Unit direction leaving the node along the segment.
function outward(curve: Curve, end: End): Pt {
	const from = end === 'start' ? curve.a : curve.b;
	const toward = curve.c ?? (end === 'start' ? curve.b : curve.a);
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	const l = Math.hypot(dx, dy) || 1;
	return { x: dx / l, y: dy / l };
}

// The piece of the curve between two distances, as road points.
function piece(curve: Curve, d0: number, d1: number): PathPoint[] {
	const t0 = tAt(curve, d0);
	const t1 = tAt(curve, d1);
	const a = pointAt(curve, t0);
	const b = pointAt(curve, t1);
	if (!curve.c) return [a, b];
	// The sub-curve's control point (the quadratic's blossom at t0, t1),
	// raised to the cubic handles a road point stores.
	const { a: p0, c: p1, b: p2 } = curve;
	const k0 = (1 - t0) * (1 - t1);
	const k1 = (1 - t0) * t1 + t0 * (1 - t1);
	const k2 = t0 * t1;
	const q = { x: k0 * p0.x + k1 * p1.x + k2 * p2.x, y: k0 * p0.y + k1 * p1.y + k2 * p2.y };
	return [
		a,
		{
			...b,
			c1: { x: a.x + ((q.x - a.x) * 2) / 3, y: a.y + ((q.y - a.y) * 2) / 3 },
			c2: { x: b.x + ((q.x - b.x) * 2) / 3, y: b.y + ((q.y - b.y) * 2) / 3 }
		}
	];
}

// ---- Setbacks: how far each road end stops short of its node.

interface Arm {
	segment: Segment;
	end: End;
	out: Pt;
	// Right normal of the segment's drawing direction at the node, and where
	// the road lies across it, offset included: its full width and its
	// roadway (kerb to kerb).
	n: Pt;
	full: { lo: number; hi: number };
	roadway: { lo: number; hi: number };
	half: number;
	// Whether the road has sidewalks or verges beyond its roadway, and
	// whether it has no car lanes at all (a footpath).
	walks: boolean;
	foot: boolean;
	// The lanes read outward from the node, for telling whether two arms
	// carry the same road on.
	key: string;
}

// Room past a crossing road's full width for a road's curb corners.
const CORNER_ROOM = 3;
// A road without sidewalks of its own (a driveway) stops on the crossing
// road's curb line (just inside it), so that road's sidewalk runs straight
// on across its mouth. A footpath stops right on a car road's curb line:
// its paving never laps over that road's asphalt.
const CURB_GAP = -0.1;
// A road with sidewalks stops this far past the mouth of a driveway: its curb
// turns straight into the driveway's edge.
const MOUTH_ROOM = 0.5;
// A road carrying straight on through a node of two still stops this far
// short, so the junction between has a little length to draw.
const THROUGH_GAP = 0.6;
// Where only two roads meet, the lanes find their way across over a length
// that grows with how far they shift sideways: this many metres along for
// each metre across, and never less than the shortest taper worth drawing.
const TAPER_PER_SHIFT = 6;
const MIN_TAPER = 8;
// A shift smaller than this needs no taper at all.
const NO_SHIFT = 0.05;
// The first guess for a change of cross-section, before the lanes' shifts
// are known.
const FIRST_TAPER = 16;
const MIN_SIN = 0.3;
// A taper set by hand is never steeper than this many metres along for each
// metre across.
const LEAST_TAPER_PER_SHIFT = 4;
// A footpath easing sideways off a sidewalk (or onto one) does so over this
// many metres along for each metre across, and may be set as steep as 1:1.
const WALK_TAPER_PER_SHIFT = 3;
const LEAST_WALK_TAPER_PER_SHIFT = 1;
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

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;

// Where two sides of a node meet (its lanes find their way across), how far
// each side's lead road stops short: its side of the taper (`reach`: set by
// hand, held, or what the shifts need; unknown at first), never less than a
// little, nor less than a bend needs.
function linkSetbacks(a: Arm, b: Arm, reach: [number | undefined, number | undefined]) {
	const d = dot(a.out, b.out);
	// Offsets read across the node, to the right of the way through it.
	const placeA = a.end === 'end' ? a.segment.offsetEnd : -a.segment.offsetStart;
	const placeB = b.end === 'start' ? b.segment.offsetStart : -b.segment.offsetEnd;
	const same = mirror(a.key) === b.key && Math.abs(placeA - placeB) < 0.01;
	// A bend: both sides pull back far enough for the lanes to turn on a
	// curve (R tan(deflection / 2)).
	const deflection = Math.PI - Math.acos(Math.max(-1, Math.min(1, d)));
	const r = 1.5 * Math.max(a.half, b.half);
	const bend = d < -0.995 ? 0 : r * Math.tan(Math.min(deflection, 2.4) / 2);
	return reach.map((x) => Math.max(THROUGH_GAP, x ?? (same ? 0 : FIRST_TAPER / 2), bend));
}

// At a junction of three or more roads, how far each road stops short of the
// node when nothing is set by hand: far enough for curb corners or for the
// crossing roads' curb lines.
function setbacks(arms: Arm[]) {
	const out = new Map<Arm, number>();
	// Each arm's straight-on partner: the most nearly opposite arm, if it is
	// nearly opposite.
	const partner = new Map<Arm, Arm>();
	const pairs = arms
		.flatMap((a, i) => arms.slice(i + 1).map((b) => ({ a, b, d: dot(a.out, b.out) })))
		.filter((p) => p.d < -0.9)
		.sort((x, y) => x.d - y.d);
	for (const p of pairs) {
		if (partner.has(p.a) || partner.has(p.b)) continue;
		partner.set(p.a, p.b);
		partner.set(p.b, p.a);
	}
	// A road without sidewalks is a driveway when it is narrow from curb to
	// curb (medians included) and no road faces it across the node: it stops
	// on the other roads' curb lines and they turn straight into its edges.
	// Any other road meets a road with sidewalks with curb corners, as one
	// with sidewalks of its own does (lab/junction.ts, joinsOnly, decides the
	// same for the drawing).
	const driveway = (a: Arm) => !a.walks && a.roadway.hi - a.roadway.lo < NARROW && !partner.has(a);
	const cornered = (a: Arm, b: Arm) => (a.walks || b.walks) && !driveway(a) && !driveway(b);
	for (const arm of arms) {
		let trim = 0;
		for (const other of arms) {
			if (other === arm || partner.get(arm) === other) continue;
			const cos = dot(arm.out, other.out);
			// How the arm crosses the other road: which side of it the arm
			// leaves on, and how steeply.
			const side = dot(arm.out, other.n);
			const sin = Math.max(MIN_SIN, Math.abs(side));
			// Past the other road's far edge on the arm's side, where that road
			// actually lies, and some, for curb corners; a road with sidewalks
			// only clears a driveway's mouth, and any other pair of roads stop
			// on each other's curb lines.
			const span = cornered(arm, other) ? other.full : other.roadway;
			const room = cornered(arm, other)
				? CORNER_ROOM
				: arm.walks && driveway(other)
					? MOUTH_ROOM
					: arm.foot && !other.foot
						? 0
						: CURB_GAP;
			const edge = side >= 0 ? span.hi : -span.lo;
			const clear = Math.max(0, edge + room);
			const need = cos > 0 ? (clear + arm.half * cos) / sin : clear;
			trim = Math.max(trim, need);
		}
		out.set(arm, trim);
	}
	return out;
}

// A node's two sides, when its lanes find their way across it from one to
// the other instead of meeting at a junction: two roads, or roads attached
// at an edge (`sides`) beside the ones they join. Each side is led by a road
// not attached at an edge where there is one.
function linkGroups(arms: Arm[], sides: Record<string, string> | undefined): [Arm[], Arm[]] | null {
	if (arms.length === 2) return [[arms[0]], [arms[1]]];
	const attached = (a: Arm) => !!sides?.[a.segment.id];
	if (!arms.some(attached)) return null;
	const mains = arms.filter((a) => !attached(a));
	if (mains.length > 2) return null;
	const lead = mains[0] ?? arms[0];
	const a = arms.filter(
		(x) => x === lead || (x !== mains[1] && attached(x) && dot(x.out, lead.out) > 0)
	);
	const b = arms.filter((x) => !a.includes(x));
	if (!b.length) return null;
	// The other side led by its own road where it has one.
	b.sort((x, y) => Number(attached(x)) - Number(attached(y)));
	return [a, b];
}

// The taper a node of two roads needs (long enough for the furthest any
// connection shifts sideways), and the shortest it may be set to. Sidewalks
// follow the roadway's taper; where only walks carry on (a footpath leaving
// a road) the furthest a walk shifts sets it, at a walker's steeper rate.
function taperFor(junction: Junction, geos: Map<string, RoadGeo>) {
	const ends = endsOf(junction, geos);
	let shift = 0;
	let walkShift = 0;
	let roadway = false;
	for (const c of junction.connections) {
		const a = laneEndOf(ends, c.from);
		const b = laneEndOf(ends, c.to);
		if (!a || !b || a.end === b.end) continue;
		const walk = a.lane.lane.kind === 'walk';
		roadway ||= !walk;
		// Lanes of a road attached at an edge are read across the road it
		// joins (its own frame leans by the angle it joins at), at the point
		// it joins, so the taper's own trim never changes the shift.
		const attached = junction.sides?.includes(a.end.key) || junction.sides?.includes(b.end.key);
		const ref = ends.find((e) => !junction.sides?.includes(e.key)) ?? ends[0];
		const across = (p: Pt) => p.x * ref.frame.n.x + p.y * ref.frame.n.y;
		const moved = attached
			? Math.abs(
					across(sidePoint(a.end, a.lane, junction.anchors ?? {})) -
						across(sidePoint(b.end, b.lane, junction.anchors ?? {}))
				)
			: Math.abs(lateral(a.end, a.lane, true) - lateral(b.end, b.lane, false));
		if (walk) walkShift = Math.max(walkShift, moved);
		else shift = Math.max(shift, moved);
	}
	const [s, along, least] = roadway
		? [shift, TAPER_PER_SHIFT, LEAST_TAPER_PER_SHIFT]
		: [walkShift, WALK_TAPER_PER_SHIFT, LEAST_WALK_TAPER_PER_SHIFT];
	return {
		need: s < NO_SHIFT ? 0 : Math.max(MIN_TAPER, s * along),
		least: Math.max(THROUGH_GAP * 2, s * least)
	};
}

// ---- The place.

export interface Derived {
	place: Place;
	// Content keys, so the drawing rebuilds only what changed.
	roadKeys: Map<string, string>;
	junctionKeys: Map<string, string>;
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
export interface NodeCrossing extends JunctionCrossing {
	on: boolean;
	auto: boolean;
	place?: number;
}

const toEditorConnections = (cs: Connection[]): JunctionConnection[] =>
	cs.map((c) => ({ from: { ...c.from }, to: { ...c.to } }));

// Where a crossing lies along its road, in metres from the road's start: at
// its stored distance from the node, or just past the corners, and never
// closer to either end of the road than half its depth and a little.
export function crossingPlace(
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
	// Per cross-section: its curb and the arm key at each end, read once.
	private sections = new Map<
		string,
		{
			total: number;
			lo: number;
			hi: number;
			walks: boolean;
			foot: boolean;
			start: string;
			end: string;
		}
	>();
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
	private version = 0;
	// The taper each node of two roads needs for the shifts its connections
	// make, and the shortest it may be set to, from the last build.
	private tapers = new Map<string, number>();
	private least = new Map<string, number>();
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
	// Each node of two roads' setbacks from the last build, by segment id.
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

	// The taper a node of two roads needs, kept with its junction.
	private taperCache = new Map<string, { key: string; need: number; least: number }>();
	private taperOf(nodeId: string, junction: Junction, geos: Map<string, RoadGeo>, key: string) {
		const cached = this.taperCache.get(nodeId);
		if (cached?.key === key) return cached;
		const t = { key, ...taperFor(junction, geos) };
		this.taperCache.set(nodeId, t);
		return t;
	}

	private crossingsAt(
		nodeId: string,
		junction: Junction,
		geos: Map<string, RoadGeo>,
		shortLink: (road: string) => boolean,
		junctionKey: string
	): NodeCrossing[] {
		const key = `${junctionKey}|${junction.ends.map((e) => shortLink(e.road)).join()}`;
		const cached = this.crossingCache.get(nodeId);
		if (cached?.key === key) return cached.list;
		const list = defaultCrossings(junction, endsOf(junction, geos), shortLink).map((d) => ({
			road: d.end.ref.road,
			end: d.end.ref.end,
			lanes: d.lanes,
			on: d.on,
			auto: true
		}));
		this.crossingCache.set(nodeId, { key, list });
		return list;
	}

	private section(segment: Segment) {
		let s = this.sections.get(segment.lanesKey);
		if (!s) {
			s = {
				...curbOf(segment.lanes),
				start: armKey(segment, 'start'),
				end: armKey(segment, 'end')
			};
			this.sections.set(segment.lanesKey, s);
		}
		return s;
	}

	build(graph: Graph): Derived {
		// A node's taper depends on its connections, which are read off the
		// roads it trims: build again while any come out different (a chain of
		// tapers settles one node further each pass).
		let derived = this.buildOnce(graph);
		for (let pass = 1; pass < 8 && !derived.settled; pass++) derived = this.buildOnce(graph);
		return derived;
	}

	private buildOnce(graph: Graph) {
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
		for (const node of graph.nodes.values()) {
			const arms: Arm[] = [];
			for (const id of node.connectedSegments) {
				const segment = graph.segments.get(id);
				const curve = curves.get(id);
				if (!segment || !curve) continue;
				const end: End = segment.startNodeId === node.id ? 'start' : 'end';
				const section = this.section(segment);
				const off = offsetAt(segment, end);
				const out = outward(curve, end);
				// The drawing direction leaves the start and arrives at the end.
				const along = end === 'start' ? out : { x: -out.x, y: -out.y };
				arms.push({
					segment,
					end,
					out,
					n: { x: -along.y, y: along.x },
					full: { lo: -section.total / 2 + off, hi: section.total / 2 + off },
					roadway: { lo: section.lo + off, hi: section.hi + off },
					half: section.total / 2 + Math.abs(off),
					walks: section.walks,
					foot: section.foot,
					key: section[end]
				});
			}
			if (arms.length < 2) continue;
			armsAt.set(node.id, arms);
			const groups = linkGroups(arms, node.junction?.sides);
			if (groups) links.set(node.id, groups);
			else
				for (const [arm, trim] of setbacks(arms)) trims.set(`${arm.segment.id}:${arm.end}`, trim);
		}
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
		// Nodes of two sides: each side's taper (set by hand, held, or half
		// what the shifts need), never shorter than the shifts allow nor so
		// long it runs into the road's far node. Left to itself the taper is
		// the same length both sides, as long as the side with least room
		// allows; past that the other side takes what it can of the rest (a
		// short footpath between this node and a junction leaves its sidewalks
		// to ease across on the road behind).
		for (const [nodeId, groups] of links) {
			const node = graph.nodes.get(nodeId)!;
			const lead = [groups[0][0], groups[1][0]];
			const rooms = groups.map((group) => Math.min(...group.map((arm) => roomOf(arm))));
			const shared = Math.min(...rooms);
			const need = this.tapers.get(nodeId);
			const least = (this.least.get(nodeId) ?? THROUGH_GAP * 2) / 2;
			const limits = new Map<string, { min: number; max: number }>();
			const reach = lead.map((arm, k) => {
				const id = arm.segment.id;
				const max = Math.max(0, rooms[k]);
				const min = Math.min(least, max);
				limits.set(id, { min, max });
				const set = node.junction?.setbacks?.[id];
				if (set !== undefined) return { value: Math.min(max, Math.max(min, set)), room: rooms[k] };
				const held = this.held?.node === nodeId ? this.held.setbacks.get(id) : undefined;
				if (held === undefined && need === undefined) return { value: undefined, room: shared };
				const rest = held ?? need! - Math.min(Math.max(0, shared), need! / 2);
				const value = Math.min(max, rest);
				return { value, room: Math.max(shared, value) };
			});
			if (groups.every((g) => g.length === 1)) this.limits.set(nodeId, limits);
			const result = linkSetbacks(lead[0], lead[1], [reach[0].value, reach[1].value]);
			const used = new Map<string, number>();
			for (const [k, group] of groups.entries()) {
				// A road too short for its far junction's setback and a taper
				// leaves no room here, but its end never reaches past the node.
				const trim = Math.min(result[k], Math.max(THROUGH_GAP, reach[k].room));
				used.set(lead[k].segment.id, trim);
				for (const arm of group) trims.set(`${arm.segment.id}:${arm.end}`, trim);
			}
			this.used.set(nodeId, used);
		}

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
				? curve.length - THROUGH_GAP
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
				const lanes = segment.lanes.map((l, i) => labLane(l, `l${i}`));
				// The shift blends from one end's to the other's with distance
				// along the whole segment (road-line.ts); the road starts d0 in.
				const lean = (segment.offsetEnd - segment.offsetStart) / (curve.length || 1);
				const offset = segment.offsetStart + lean * d0;
				const road: Road = {
					id: segment.id,
					points: piece(curve, d0, curve.length - d1),
					stretches: [{ at: 0, taper: 0, align: 'centre', offset, lanes }],
					height: 0
				};
				if (lean) road.lean = lean;
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
			const node = graph.nodes.get(nodeId)!;
			const ends = arms.map((a) => ({ road: a.segment.id, end: a.end }));
			const stored = node.junction;
			const key = `${ends.map((e) => shapeKeys.get(e.road)).join()}|${this.json(stored)}`;
			junctionKeys.set(nodeId, key);
			const cached = this.junctionCache.get(nodeId);
			if (cached?.key === key) {
				junctions.set(nodeId, cached.junction);
				continue;
			}
			const junction: Junction = {
				id: nodeId,
				ends,
				connections: [],
				walkways: [],
				control: {},
				corners: [],
				islands: (stored?.islands ?? []).map((i) => ({ shape: i.shape, surface: i.surface }))
			};
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
			// The defaults, less those removed by hand, plus those added by hand.
			const keyOf = (r: Connection['from']) => `${endKey(r)}/${r.lane}`;
			const same = (x: Connection, y: Connection) =>
				(keyOf(x.from) === keyOf(y.from) && keyOf(x.to) === keyOf(y.to)) ||
				(keyOf(x.from) === keyOf(y.to) && keyOf(x.to) === keyOf(y.from));
			const here = new Set(
				ends.flatMap((e) =>
					(geos.get(e.road)?.road.stretches[0].lanes ?? []).map((l) => `${endKey(e)}/${l.id}`)
				)
			);
			const removed = stored?.removed ?? [];
			// An added connection stands while both its lanes exist and are still
			// of one kind.
			const kinds = new Map(
				ends.flatMap((e) =>
					(geos.get(e.road)?.road.stretches[0].lanes ?? []).map((l) => [
						`${endKey(e)}/${l.id}`,
						kindOf(l)
					])
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
			junction.corners = d.corners;
			junctions.set(nodeId, junction);
			// The connections are the junction's data: keep the node's copy in
			// step, without touching it when nothing changed.
			const next = toEditorConnections(junction.connections);
			if (JSON.stringify(stored?.connections ?? []) !== JSON.stringify(next)) {
				const data = { ...(node.junction ?? {}), connections: next };
				node.junction = data;
				// Storing the connections changed the node's data; key the cache on
				// what the node now holds so the next build reuses this junction.
				const now = `${ends.map((e) => shapeKeys.get(e.road)).join()}|${this.json(data)}`;
				junctionKeys.set(nodeId, now);
				this.junctionCache.set(nodeId, { key: now, junction });
			} else this.junctionCache.set(nodeId, { key, junction });
		}
		for (const id of [...this.junctionCache.keys()])
			if (!armsAt.has(id)) this.junctionCache.delete(id);
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
			const list = junction
				? this.crossingsAt(nodeId, junction, geos, shortLink, junctionKeys.get(nodeId)!)
				: [];
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
				const lanes = road.stretches[0].lanes;
				if (!c.lanes.every((id) => lanes.some((l) => l.id === id))) continue;
				c.place = crossingPlace(c, span);
				if (c.on)
					road.crossings = [
						...(road.crossings ?? []),
						{ at: c.place, lanes: c.lanes, type: c.crossing }
					];
			}
			crossings.set(nodeId, all);
		}
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

		let settled = true;
		for (const [nodeId, junction] of junctions) {
			const groups = links.get(nodeId);
			if (!groups) continue;
			const { need, least } = this.taperOf(nodeId, junction, geos, junctionKeys.get(nodeId)!);
			const set = groups.map((g) => graph.nodes.get(nodeId)?.junction?.setbacks?.[g[0].segment.id]);
			// A side set by hand is held to the least its shifts allow, which
			// is only known now (on load, say): build again with it.
			if (
				set.some((s) => s !== undefined && s < least / 2 - 0.005) &&
				this.least.get(nodeId) !== least
			)
				settled = false;
			this.least.set(nodeId, least);
			if (Math.abs((this.tapers.get(nodeId) ?? -1) - need) > 0.01) {
				this.tapers.set(nodeId, need);
				if (set.some((s) => s === undefined) && this.held?.node !== nodeId) settled = false;
			}
		}
		for (const id of [...this.tapers.keys()]) if (!junctions.has(id)) this.tapers.delete(id);

		const place: Place = {
			id: 'editor',
			title: 'Editor',
			roads,
			junctions: [...junctions.values()],
			islands: [],
			view: { x: 0, y: 0, zoom: 1 }
		};
		return { place, roadKeys, junctionKeys, junctions, crossings, spans, settled };
	}
}
