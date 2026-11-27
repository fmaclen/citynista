// The car roads of the editor's graph (core/networks.ts) read as the road
// model the drawing runs on (src/lib/road-model, docs/road-model.md): every
// segment is a road with one cross-section, every node two or more segments
// meet at is a junction of their ends. Roads stop short of their junctions
// by a setback worked out here, so the junction has room for its curb
// corners or for lanes to find their way across; the junction's connections
// are the defaults plus the user's edits stored on the node.

import { APPROACH_PAINT, CROSSING_FROM_END } from '../road-model/approach';
import { kindOf } from '../road-model/connect';
import { defaultCrossings, defaults, SHORT_LINK } from '../road-model/defaults';
import { endsOf, type RoadGeo } from '../road-model/ends';
import { type PathSample, samplePath, TAPER, dot } from '../road-model/geometry';
import { BESIDE } from '../road-model/lines';
import { effectiveJunctions, type MergeMemo, TOUCH_REACH, tooShort } from '../road-model/merge';
import type { Paths } from '../road-model/clip';
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
import { type Attach, attachShift, endAt, placedFrom } from './attach';
import { mapJunction } from './junction-data';

import type { GraphView } from './graph.svelte';
import {
	distanceToChord,
	type LineFrom,
	LineBook,
	lineThrough,
	offsetAt,
	sameLine,
	shiftAtCut
} from './road-line';
import {
	type Curve,
	curveOf,
	headingFrom,
	joinCurves,
	lengthTo,
	outward,
	piece,
	pointAt,
	STEPS,
	tAt
} from './segment-curve';
import type { Segment } from './segment.svelte';
import { type Arm, linkSetbacks, type RoadUnit, setbacks, taperFor } from './setbacks';
import type {
	JunctionConnection,
	JunctionCrossing,
	JunctionData,
	JunctionLaneRef,
	Lane as EditorLane
} from './types';

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
export function roadOf(segment: RoadUnit, curve: Curve, d0: number, d1: number) {
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

// Whether two lists hold the same things, one by one.
const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// A taper never eats the last of its road: at least this much is left beyond
// it before the road's far end (or the far node's own setback).
const ROAD_LEFT = 5;

// How far a road's shift may jump where it is cut and still run on unbroken.
const SHIFT_JOIN = 0.01;

// Whether a node only carries a road on: two segments and nothing else, one
// ending there and the other starting there, the same cross-section with the
// same lane ids heading straight on (TAPER.STRAIGHT) with its shift running
// on unbroken; and the user's edits there leave every lane of the one carried
// straight on into its counterpart in the other and nothing else, and set
// neither's setback. That the two carry on is read off the node, never off
// where they came from: two streets drawn on their own carry on as one cut in
// two does. (The road keeps the first segment's lane ids, by which the edits
// at its far end name its lanes, so two segments whose lanes are named apart
// stay apart.) The two, in order, or null. Such a node is no boundary for the
// road: everything about its shape reads the two as one (`units` in
// PlaceBuilder.build), and the node is no junction.
export function carriedOn(
	node: { id: string; junction?: JunctionData },
	segments: Segment[],
	curves: { get(id: string): Curve | undefined }
) {
	if (segments.length !== 2) return null;
	const [a, b] = segments[0].endNodeId === node.id ? segments : [segments[1], segments[0]];
	if (a.endNodeId !== node.id || b.startNodeId !== node.id || a === b) return null;
	const edits = node.junction;
	if (edits?.sides?.[a.id] || edits?.sides?.[b.id]) return null;
	if (edits?.setbacks?.[a.id] !== undefined || edits?.setbacks?.[b.id] !== undefined) return null;
	const ids = (s: Segment) => s.lanes.map((l) => l.id).join();
	if (a.lanesKey !== b.lanesKey || ids(a) !== ids(b)) return null;
	// Each lane's connection straight on, as `a:end/lane>b:start/lane`.
	const straight = new Set(a.lanes.map((l) => `${a.id}:end/${l.id}>${b.id}:start/${l.id}`));
	const named = (c: JunctionConnection) => {
		const key = (r: JunctionLaneRef) => `${r.road}:${r.end}/${r.lane}`;
		return [`${key(c.from)}>${key(c.to)}`, `${key(c.to)}>${key(c.from)}`];
	};
	if ((edits?.removed ?? []).some((c) => named(c).some((k) => straight.has(k)))) return null;
	if ((edits?.added ?? []).some((c) => !named(c).some((k) => straight.has(k)))) return null;
	const [ca, cb] = [curves.get(a.id), curves.get(b.id)];
	if (!ca || !cb || dot(outward(ca, 'end'), outward(cb, 'start')) > -TAPER.STRAIGHT) return null;
	// The shift read straight on from each road's far end meets the other's.
	const at = shiftAtCut(a.offsetStart, b.offsetEnd, ca.length, cb.length);
	if (Math.abs(at - a.offsetEnd) > SHIFT_JOIN || Math.abs(at - b.offsetStart) > SHIFT_JOIN)
		return null;
	return [a, b] as const;
}

// The segments of the road a segment is part of as it carries on, before
// any parting: carried on each way through every node the road only carries
// on through (`pairAt`, the two segments carriedOn finds there, or null),
// round a loop once (`loop`, read round from its oldest node, so it lists
// alike whichever segment it is asked from). What is stored reads a road so
// (a crossing's control: core/crossing-controls.ts), never as roadThrough
// parts it.
export function chainThrough<S extends { startNodeId: string; endNodeId: string }>(
	segment: S,
	pairAt: (nodeId: string) => readonly [S, S] | null
) {
	let road = [segment];
	let loop = false;
	for (let pair = pairAt(segment.startNodeId); pair && pair[1] === road[0]; ) {
		if (road.includes(pair[0])) {
			loop = true;
			break;
		}
		road.unshift(pair[0]);
		pair = pairAt(pair[0].startNodeId);
	}
	for (let pair = pairAt(segment.endNodeId); !loop && pair && pair[0] === road.at(-1); ) {
		if (road.includes(pair[1])) break;
		road.push(pair[1]);
		pair = pairAt(pair[1].endNodeId);
	}
	if (loop) {
		const oldest = road.map((s) => s.startNodeId).sort(olderId)[0];
		const first = road.findIndex((s) => s.startNodeId === oldest);
		road = [...road.slice(first), ...road.slice(0, first)];
	}
	return { road, loop };
}

// The segments of the road a segment is part of as it is drawn, in order:
// its chain (chainThrough), parted where it would start and end at one node.
//
// The segments of one road never start and end at the same node, and where
// a chain of them would, it is parted at nodes chosen by identity alone, so
// a parting stays where it is while the chain and its nodes stay the same. A loop carried through all
// the way round (the Curve tool closed on itself, the Circle tool's ring) is
// parted at its two oldest nodes (`olderId`) into two roads; a chain whose
// two ends are one real node (a ring with a side street, two rings sharing a
// node, a teardrop, a loop given an edit at one of its nodes) is parted at
// its oldest inner node. Each parting is then an ordinary node of two roads.
// Both are read off the chain's own node ids, so whichever segment it is
// asked from, every reader parts it at the same nodes. This is the one place
// a chain is parted.
//
// A parting is a matter of drawing alone: the user never made it and cannot
// see it, and whatever changes the chain or its nodes (a cut, a bend past
// straight, a setback, a side street, a paste) can move it. So nothing stored, carried through
// an edit or kept from one gesture to the next reads a road as parted here:
// those read the chain whole (chainThrough), as a loop was one road before
// it was parted.
export function roadThrough<S extends { startNodeId: string; endNodeId: string }>(
	segment: S,
	pairAt: (nodeId: string) => readonly [S, S] | null
) {
	const { road, loop } = chainThrough(segment, pairAt);
	// The nodes it is parted at, each where a segment starts.
	let parts: string[];
	if (loop)
		parts = road
			.map((s) => s.startNodeId)
			.sort(olderId)
			.slice(0, 2);
	else if (road.length > 1 && road[0].startNodeId === road.at(-1)!.endNodeId)
		parts = [
			road
				.slice(1)
				.map((s) => s.startNodeId)
				.sort(olderId)[0]
		];
	else return road;
	const cut = road.findIndex((s, k) => k > 0 && parts.includes(s.startNodeId));
	return road.indexOf(segment) < cut ? road.slice(0, cut) : road.slice(cut);
}

// Two node ids in order of age: read as numbered (`node-2` before
// `node-10`, as the graph numbers them), then as written where that ties
// (`node-01` and `node-1`).
export const olderId = (a: string, b: string) =>
	a.localeCompare(b, 'en', { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);

const laneSig = (lane: EditorLane, flip: boolean) => {
	const dir =
		lane.direction === 'bidirectional' ? 'b' : (lane.direction === 'forward') !== flip ? 'o' : 'i';
	return `${lane.role}:${lane.material}:${lane.width}:${lane.role === 'vehicle' ? dir : ''}`;
};

// A cross-section's lanes read out of a node from one of its road's ends.
function armKey(lanes: readonly EditorLane[], end: End) {
	const out = end === 'start' ? lanes : [...lanes].reverse();
	return out.map((l) => laneSig(l, end === 'end')).join(',');
}

const mirror = (key: string) =>
	key
		.split(',')
		.reverse()
		.map((s) => s.replace(/:o$/, ':x').replace(/:i$/, ':o').replace(/:x$/, ':i'))
		.join(',');

// Whether two roads meeting at a node carry the same lanes on through it (a
// plain bend or continuation rather than a change of cross-section).
export const carriesOn = (
	a: Pick<Segment, 'lanes'>,
	aEnd: End,
	b: Pick<Segment, 'lanes'>,
	bEnd: End
) => mirror(armKey(a.lanes, aEnd)) === armKey(b.lanes, bEnd);

// Where a cross-section's roadway lies across it, from its centre, and
// whether it has sidewalks or verges beyond that: read once per
// cross-section.
function curbOf(lanes: readonly EditorLane[]) {
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
	const walks = lo > -total / 2 + 0.05 || hi < total / 2 - 0.05;
	return { total, lo, hi, walks };
}

// The way a road attached at an edge heads off from its node, which decides
// the side of the node it goes with: its heading where it has got clear of
// the node, the first point out along it where none of its width lies over
// what stands side by side at the node (the roads it joins, `hosts`, carried
// straight on along `lead`, and its own place beside them). A curve arriving
// across the road it joins can point either way before that; from there on
// it has settled which way it came from. A road that never gets clear is
// read where it leaves the node. Only the roads' lines and widths are read,
// never a trim or a picked distance: the trims follow from the connections
// this decides, and the answer is the same at any scale.
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
// for the roads attached there. Beside roads carrying on through it: as far
// along each as it lies over a road it joins, that road's sidewalks and
// verges included, to the point where none of its width does (give or take
// 5 cm). A road it joins lies along its own line out of the node, from where
// it stops short of it at the least (TAPER.THROUGH_GAP), so the attached road
// is over it where it reaches that far to that road's side of the node,
// within its width. So wherever an attached road's lanes cut through the
// sidewalk or verge of the road it joins, they do so across the node, where
// a car lane comes first and a sidewalk carries on as a crossing
// (road-model/node.ts); two roads' own surfaces never lie over each other
// beyond it. And as far along two roads attached side by side on one side
// (the halves of a road that splits) as the ground between them is no wider
// than BESIDE (road-model/lines.ts): the node paves that as a seam between
// their lanes, and beyond it their gore is never a hairline. A road that
// never gets clear counts whole.
function clearOf(groups: [Arm[], Arm[]], attached: Record<string, string>) {
	const hosts = groups.flat().filter((a) => !attached[a.segment.id]);
	const through = groups.every((g) => g.some((a) => hosts.includes(a)));
	return groups.map((group) => {
		const own = group.filter((arm) => !hosts.includes(arm));
		return Math.max(
			0,
			...own.map((arm) => (through ? reachWhile(arm, overAny(arm, hosts)) : 0)),
			...own.flatMap((arm) =>
				own.filter((b) => b !== arm).map((b) => reachWhile(arm, besideOf(arm, b)))
			)
		);
	});
}

// Whether a road lies over any of `roads` at its node, a fraction u of the
// way along it from there: over their whole width give or take 5 cm
// (clearOf), or over the stretch across each that `over` gives (a junction's
// setbacks: a road clears another's curb line and the room for its corners,
// core/setbacks.ts). Each of them lies along its own curve out of the node,
// from where it stops short of it at the least (TAPER.THROUGH_GAP).
function overAny(arm: Arm, roads: Arm[], over?: (road: Arm) => { lo: number; hi: number }) {
	const { curve, end } = arm;
	const half = (arm.full.hi - arm.full.lo) / 2;
	const slack = over ? 0 : 0.05;
	const spanOf = over ?? ((road: Arm) => road.full);
	// Each road's line sampled from the node out every LINE_STEP (a straight
	// segment by its two ends), so a road reads the same whether it is one
	// segment or several joined (`units` in PlaceBuilder.build), and which
	// way its offsets grow from the way it heads out (its right normal of the
	// drawing direction, n). Sampled only as far as is read: a point of the
	// road a fraction u along it lies no further from the node than it is
	// along, and over a line within the two roads' widths of it, which an
	// arc reaches within half as far again; twice that is read.
	const lines = roads.map((road) => {
		const { length } = road.curve;
		const at = (d: number) =>
			pointAt(road.curve, tAt(road.curve, road.end === 'start' ? d : length - d));
		const straight = !road.curve.c && !road.curve.parts;
		const span = spanOf(road);
		return {
			road,
			pts: straight ? [at(0), at(length)] : [at(0)],
			// Samples as far as `d` along it, at least.
			upto(d: number) {
				const want = Math.min(length, 2 * (d + half + Math.max(-span.lo, span.hi)));
				while (!straight && (this.pts.length - 1) * LINE_STEP < want)
					this.pts.push(at(Math.min(length, this.pts.length * LINE_STEP)));
				return this.pts;
			},
			turn: road.end === 'start' ? 1 : -1
		};
	});
	return (u: number) => {
		const p = middleAt(arm, u);
		const heading = headingFrom(curve, end, u);
		const d = fromNode(arm, u);
		return lines.some((line) => {
			const { road, turn } = line;
			const pts = line.upto(d);
			// The nearest piece of its line, read on past the node's end of it.
			let best = { d: Infinity, s: 0, x: 0, t: road.out };
			let s0 = 0;
			for (let k = 1; k < pts.length; k++) {
				const [a, b] = [pts[k - 1], pts[k]];
				const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
				// (Leaving the node along it exactly.)
				const t = k === 1 ? road.out : { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
				const f = dot({ x: p.x - a.x, y: p.y - a.y }, t);
				const g = k === 1 ? Math.min(f, l) : Math.max(0, Math.min(f, l));
				const foot = { x: a.x + t.x * g, y: a.y + t.y * g };
				const d = Math.hypot(p.x - foot.x, p.y - foot.y);
				const n = { x: -t.y * turn, y: t.x * turn };
				if (d < best.d) best = { d, s: s0 + g, x: dot({ x: p.x - foot.x, y: p.y - foot.y }, n), t };
				s0 += l;
			}
			const n = { x: -best.t.y * turn, y: best.t.x * turn };
			// Its width as it lies along and across that road there.
			const along = half * Math.abs(dot(heading, n));
			const across = half * Math.abs(dot(heading, best.t));
			const span = spanOf(road);
			return (
				best.s + along > TAPER.THROUGH_GAP &&
				best.x + across > span.lo + slack &&
				best.x - across < span.hi - slack
			);
		});
	};
}

// How far apart overAny reads the points of a road's line.
const LINE_STEP = 0.5;

// How far along a road from its node a fraction u of the way along it is.
function fromNode({ curve, end }: Arm, u: number) {
	const d = lengthTo(curve, end === 'start' ? u : 1 - u);
	return end === 'start' ? d : curve.length - d;
}

// The middle of a road's cross-section a fraction u of the way along it from
// its node, moved off its line by its shift there.
function middleAt(arm: Arm, u: number) {
	const p = pointAt(arm.curve, arm.end === 'start' ? u : 1 - u);
	const h = headingFrom(arm.curve, arm.end, u);
	const k = ((arm.full.lo + arm.full.hi) / 2) * (arm.end === 'start' ? 1 : -1);
	return { x: p.x - h.y * k, y: p.y + h.x * k };
}

// Whether the ground between two roads leaving a node is no wider than
// BESIDE, a fraction u of the way along the first from there: each read as
// wide as it is, where it shows.
function besideOf(arm: Arm, other: Arm) {
	const half = (a: Arm) => (a.full.hi - a.full.lo) / 2;
	const line = Array.from({ length: STEPS + 1 }, (_, k) => middleAt(other, k / STEPS));
	return (u: number) => {
		const p = middleAt(arm, u);
		let d = Infinity;
		for (let k = 1; k < line.length; k++) d = Math.min(d, distanceToChord(p, line[k - 1], line[k]));
		return d - half(arm) - half(other) <= BESIDE;
	};
}

// How far along a road from its node `holds` (clearOf), from the first of its
// sampled points where it does (within its own width or so of the node, or
// 0 where it never does) to where it stops.
function reachWhile(arm: Arm, holds: (u: number) => boolean) {
	const half = (arm.full.hi - arm.full.lo) / 2;
	// Its sampled points from the node on: the first where it holds, then the
	// first after that where it doesn't, then the point between that one and
	// the one before where it stops.
	let i = 0;
	while (i < STEPS && !holds(i / STEPS) && fromNode(arm, i / STEPS) <= 2 * half + 1) i++;
	if (!holds(i / STEPS)) return 0;
	while (i <= STEPS && holds(i / STEPS)) i++;
	let u = 1;
	if (i <= STEPS) {
		let [lo, hi] = [(i - 1) / STEPS, i / STEPS];
		for (let k = 0; k < 12; k++) {
			const mid = (lo + hi) / 2;
			if (holds(mid)) lo = mid;
			else hi = mid;
		}
		u = hi;
	}
	return fromNode(arm, u);
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
	curves: { get(id: string): Curve | undefined },
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

// A node of two sides as PlaceBuilder.linkOf reads it.
interface LinkRead {
	key: string;
	inputs: unknown[];
	through: boolean;
	junction: Junction;
	need: number;
	least: number;
	clear: number[];
}

export interface Derived {
	place: Place;
	// Every road, merged away or not, with its sampled path.
	geos: Map<string, RoadGeo>;
	// Each node's junction, by node id.
	junctions: Map<string, Junction>;
	// Each node's crossings, defaults and hand-placed alike.
	crossings: Map<string, NodeCrossing[]>;
	// Each road along its segment: where it starts (d0, from the segment's
	// start, along the road it is part of), how long it is, and the
	// segment's whole length.
	spans: Map<string, { d0: number; length: number; total: number }>;
	// Each segment joined with others into one road through nodes the road
	// only carries on through (carriedOn): that road's segments in order, the
	// first naming it. A segment that is a road of its own isn't listed.
	units: Map<string, string[]>;
	// Every road end at each node, as a network laid over this one reads it
	// (core/networks.ts: a footpath node on a car road's dead end).
	ends: Map<string, FixedEnd[]>;
	// A node a road only carries on through (carriedOn), as the connector
	// shows it: a junction of its two segments with the defaults and the
	// node's edits, and those segments' roads whole up to the node. Null for
	// any other node.
	through: (nodeId: string) => { junction: Junction; geos: Map<string, RoadGeo> } | null;
	// Each footpath end lying on a walkway a car road or its junction draws,
	// by its node, one for each footpath ending there so, the one the node
	// is held by first (heldFirst in core/networks.ts): the footpath (`path`), where its end shows (`end`), that
	// road, the sidewalk lane, how far along the road, the line a walker
	// follows from the footpath onto the middle of that walkway there
	// (walkOnto in core/footpaths.ts; core/networks.ts), and on a junction's
	// corner sidewalk that junction, a car node it is drawn at where that
	// lay, the two lanes the corner joins and its middle line from the first
	// to the second (`corner`: walkAt in road-model/overlay.ts), the lane
	// named being the one nearer the end.
	sidewalks: Map<string, OnWalkway[]>;
}

// A footpath end lying on a walkway a car road or its junction draws
// (Derived.sidewalks).
export interface OnWalkway {
	path: string;
	end: Pt;
	road: string;
	lane: string;
	at: number;
	line: Pt[];
	corner?: {
		junction: string;
		node: { id: string; x: number; y: number };
		a: JunctionLaneRef;
		b: JunctionLaneRef;
		line: Pt[];
	};
}

// A road end of a network as one laid over it reads it (core/networks.ts):
// which end of its road it is, the road as drawn, and a key that changes
// whenever that does.
export interface FixedEnd {
	end: End;
	geo: RoadGeo;
	key: string;
}

// The segment ending at one end of a road as drawn (named by its first
// segment): the first or last of its segments where it is cut through nodes
// it only carries on through (`units`, Derived.units). The editor stores
// what it sets at that end under that segment.
export function segmentAtEnd(units: Derived['units'], road: string, end: End) {
	const pieces = units.get(road);
	return pieces ? (end === 'start' ? pieces[0] : pieces[pieces.length - 1]) : road;
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
	// Per cross-section some road end at a node has (Kept.endsHere): its
	// curb, read once, and how many of those ends have it (`uses`, as each
	// node last counted them: Kept.sectionsAt); one no end has any more is
	// let go.
	private sections = new Map<string, { curb: ReturnType<typeof curbOf>; uses: number }>();
	// Each segment's curve, and its road's shape (with the path sampled
	// along it), kept while what they're made from stays the same; junction
	// keys name roads by the shape's number.
	private curveCache = new Map<string, { key: string; curve: Curve }>();
	// What each segment's shown line is made of as the last build drew it
	// (core/road-line.ts), one object while it stays the same, and the
	// segments whose line that build drew anew (new, or moved however: its
	// nodes, its handle, its shift, or the roads an end attached at an edge
	// lies beside).
	lines = new LineBook();
	relined = new Set<string>();
	// How far each end attached at an edge is moved off its node (segment
	// id, then node id), kept while what that is worked out from stays the
	// same (drawnEnd).
	private attached = new Map<string, { key: string; shift: Pt }>();
	// Each segment an end attached at an edge is placed from (placedFrom in
	// core/attach.ts) with the segments whose ends it places, as the last
	// build read them: what an edit of it may move besides its own line and
	// the roads at its nodes (Networks.shownIn).
	placing: ReadonlyMap<string, readonly string[]> = new Map();
	// Each junction of three or more roads' setbacks, by road end, kept while
	// its roads leave it the same way (`setbacksAt`).
	private setbackCache = new Map<string, { key: unknown[]; trims: [string, number][] }>();
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
	// kept while both junctions stay the same and the road is shorter than
	// the merge limit (TOUCH_REACH).
	private touching = new Map<string, { key: string; touching: boolean }>();
	private version = 0;
	// Each road ending at a node of two sides, whole (not yet trimmed back
	// from its nodes), numbered: that node's lanes are read off it. Kept by
	// segment id while the segment has a curve, so a segment gone is dropped
	// with its curve, whether or not it led its road.
	private wholeRoads = new Map<string, { key: string; geo: RoadGeo; version: number }>();
	// Each road cut into segments at nodes it only carries on through: the
	// segments' curves joined, kept while they stay the same, by the id of
	// its first segment: dropped when that road is, and on a full build for
	// every road not joined in it.
	private joinedCache = new Map<string, { key: string; curve: Curve }>();
	// Each junction as the editor sees it where a road ending there is
	// named by a segment other than its first (renamed), kept per junction
	// while the segments ending there stay the same.
	private renamedMemo = new WeakMap<Junction, { sig: string; junction: Junction }>();
	// A node's stored edits with its roads named so, kept per stored object
	// (edits always replace it) while the segments ending there stay the
	// same.
	private renamedStored = new WeakMap<object, { sig: string; data: JunctionData | undefined }>();
	// Each node of two sides' junction, read off its whole roads, with the
	// taper its connections' shifts need, the shortest it may be set to, and
	// how far it reaches along each side at least (clearOf), and whether its
	// two roads carry the same lanes on through it (`through`, carriesOn).
	// Kept while those roads and the node's stored edits stay the same.
	private linkCache = new Map<string, LinkRead>();
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
	// shifts at both ends and the lanes with their ids. A road joined through
	// nodes it only carries on through is read whole.
	private wholeRoad(segment: RoadUnit, curve: Curve, curveKey: string) {
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
	// lanes read) and the node's stored edits; before it is built, what those
	// numbers are made of (`inputs`: each road's curve, kept as one object
	// while it stays the same, its lanes and shifts) is compared as it stands.
	private linkOf(
		nodeId: string,
		arms: Arm[],
		groups: [Arm[], Arm[]],
		stored: JunctionData | undefined,
		curves: { get(id: string): Curve | undefined },
		curveKeys: { get(id: string): string | undefined }
	) {
		const inputs = [
			this.json(stored),
			...arms.flatMap((a) => {
				const s = a.segment;
				return [s.id, a.end, a.curve, s.lanes, s.lanesKey, s.offsetStart, s.offsetEnd];
			})
		];
		const cached = this.linkCache.get(nodeId);
		if (cached && same(cached.inputs, inputs)) return cached;
		const whole = arms.map((a) =>
			this.wholeRoad(a.segment, curves.get(a.segment.id)!, curveKeys.get(a.segment.id)!)
		);
		const key = `${whole.map((w) => w.version).join()}|${this.json(stored)}`;
		if (cached?.key === key) {
			const kept = { ...cached, inputs };
			this.linkCache.set(nodeId, kept);
			return kept;
		}
		const geos = new Map(arms.map((a, i) => [a.segment.id, whole[i].geo]));
		const junction = junctionOf(nodeId, arms, stored, geos, curves, groups);
		const [a, b] = groups.map((g) => g[0]);
		const link: LinkRead = {
			key,
			inputs,
			through: groups.every((g) => g.length === 1) && carriesOn(a.segment, a.end, b.segment, b.end),
			junction,
			...taperFor(junction, geos),
			clear: clearOf(groups, stored?.sides ?? {})
		};
		this.linkCache.set(nodeId, link);
		return link;
	}

	// A junction of three or more roads' setbacks (core/setbacks.ts), by road
	// end. They read only its roads as they leave it: each one's curve (kept
	// as one object while it stays the same), its cross-section and its shift
	// there, which the key holds.
	private setbacksAt(nodeId: string, arms: Arm[], live: typeof this.setbackCache) {
		const key = arms.flatMap((a) => [a.segment.id, a.end, a.curve, a.segment.lanesKey, a.full.lo]);
		let cached = this.setbackCache.get(nodeId);
		if (!cached || !same(cached.key, key)) {
			const clear = (arm: Arm, other: Arm, span: { lo: number; hi: number }) =>
				reachWhile(
					arm,
					overAny(arm, [other], () => span)
				);
			const trims = [...setbacks(arms, clear)].map(([arm, trim]): [string, number] => [
				`${arm.segment.id}:${arm.end}`,
				trim
			]);
			cached = { key, trims };
		}
		live.set(nodeId, cached);
		return cached.trims;
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

	// A cross-section's curb.
	private section(segment: RoadUnit) {
		let s = this.sections.get(segment.lanesKey);
		if (!s) this.sections.set(segment.lanesKey, (s = { curb: curbOf(segment.lanes), uses: 0 }));
		return s.curb;
	}
	// The cross-sections of the road ends a node had (-1) or has now (1).
	private useSections(keys: readonly string[], by: 1 | -1) {
		for (const key of keys) {
			const s = this.sections.get(key);
			if (!s) continue;
			s.uses += by;
			if (s.uses <= 0) this.sections.delete(key);
		}
	}

	// A segment's end at a node as drawn (endAt in core/attach.ts): the node,
	// or the edge it is attached at. How far an attached end is moved is kept
	// while what it is worked out from stays the same: the node, its stored edits, each road there, its
	// lanes, its shifts and the point it heads for out of the node (`inputs`,
	// read once per node per build), and the road moved (the segment, or the
	// whole road it was cut from) and the point it heads for.
	private drawnEnd(
		graph: GraphView,
		segment: Segment,
		nodeId: string,
		inputs: Map<string, string>,
		live: typeof this.attached
	) {
		const attach: Attach = (g, s, id) => {
			const node = g.nodes.get(id)!;
			let key = inputs.get(id);
			if (key === undefined) {
				const roads = node.connectedSegments.map((r) => {
					const o = g.segments.get(r);
					if (!o) return '';
					const far = g.nodes.get(o.startNodeId === id ? o.endNodeId : o.startNodeId);
					const toward = `${o.controlX},${o.controlY},${far?.x},${far?.y}`;
					return `${r}:${o.startNodeId === id}:${toward}:${o.offsetStart},${o.offsetEnd}:${o.lanesKey}`;
				});
				key = `${node.x},${node.y}|${this.json(node.junction)}|${roads.join(';')}`;
				inputs.set(id, key);
			}
			const farId = s.startNodeId === id ? s.endNodeId : s.startNodeId;
			const far = g.nodes.get(farId);
			const own = `${s.startNodeId}>${s.endNodeId}:${s.controlX},${s.controlY}:${far?.x},${far?.y}:${s.offsetStart},${s.offsetEnd}`;
			const slot = `${s.id}:${id}:${farId}`;
			let cached = this.attached.get(slot);
			if (cached?.key !== `${key}|${own}`)
				cached = { key: `${key}|${own}`, shift: attachShift(g, s, id) };
			live.set(slot, cached);
			return cached.shift;
		};
		return endAt(graph, segment, nodeId, attach);
	}

	// Each segment's (of `segments`, all of `graph`'s by default) ends as
	// drawn in `graph` (an end attached at another road's edge moved there,
	// drawnEnd, each shift worked out kept in `attached`), and its shown line:
	// the last build's, one object, where it is the same.
	private linesOf(
		graph: GraphView,
		attached: typeof this.attached,
		segments: Iterable<Segment> = graph.segments.values()
	) {
		const inputs = new Map<string, string>();
		const ends = new Map<string, { a: Pt; b: Pt; line: LineFrom }>();
		for (const segment of segments) {
			if (segment.startNodeId === segment.endNodeId) continue;
			const a = this.drawnEnd(graph, segment, segment.startNodeId, inputs, attached);
			const b = this.drawnEnd(graph, segment, segment.endNodeId, inputs, attached);
			if (!a || !b) continue;
			const was = this.lines.get(segment.id);
			const line = was && sameLine(was, segment, a, b) ? was : lineThrough(segment, a, b);
			ends.set(segment.id, { a, b, line });
		}
		return ends;
	}

	// Some segments' shown lines in a graph a few edits from the one last
	// built (a drop held over its marker, modes/select.ts), read as a build
	// reads it, keeping nothing: only the ends those edits changed are worked
	// out, the rest found in what the last build kept.
	linesIn(graph: GraphView, segments: Iterable<Segment>) {
		const ends = this.linesOf(graph, new Map(), segments);
		return new Map([...ends].map(([id, { line }]) => [id, line]));
	}

	// What the last build made, of which graph, with the hold it read.
	private built: { graph: GraphView; held: unknown[]; derived: Derived } | null = null;
	// What the last build read of each node, segment and road (`model`).
	private kept: Kept | null = null;

	// The road model of `graph`. Told what was written to it since the last
	// build of the same graph (`changed`: Graph.changesSince) and the order
	// of its nodes and segments (`order`), it reads again only what those
	// writes reach (`model`); told neither, it reads the graph whole. With
	// nothing written and the hold the same, it is the last build's, the same
	// object.
	build(graph: GraphView, changed?: Changes | null, order?: Order): Derived {
		const held = [this.held, this.held?.node, this.held?.setbacks];
		const was = this.built;
		const known = !!changed && !!order && !!this.kept && was?.graph === graph;
		const heldSame = !!was && sameAll(held, was.held);
		if (
			known &&
			heldSame &&
			!changed!.nodes.size &&
			!changed!.segments.size &&
			!changed!.reordered
		) {
			this.relined = new Set();
			return was!.derived;
		}
		let edit: Changes | null = null;
		if (known) {
			const nodes = new Set(changed!.nodes);
			// A node held or let go is read again.
			if (!heldSame)
				for (const id of [was!.held[1], this.held?.node]) if (typeof id === 'string') nodes.add(id);
			edit = { nodes, segments: changed!.segments, reordered: changed!.reordered };
		}
		const derived = this.model(graph, edit, order ?? orderOf(graph));
		// The hold as the model left it: breaking a node it carried on through
		// gives it the setbacks read there.
		this.built = { graph, held: [this.held, this.held?.node, this.held?.setbacks], derived };
		return derived;
	}

	// The segments whose shown lines an edit of `seeds` may change: those and
	// the roads attached at an edge at their nodes, and the segments whose
	// attached ends the last build placed from them (`placing`), each read so
	// in turn (as `moving` in core/networks.ts reads them).
	private reached(graph: GraphView, seeds: Iterable<string>) {
		const found = new Set(seeds);
		const todo = [...found];
		const add = (id: string) => {
			if (found.has(id)) return;
			found.add(id);
			todo.push(id);
		};
		for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
			for (const placed of this.placing.get(id) ?? []) add(placed);
			const s = graph.segments.get(id);
			if (!s) continue;
			for (const n of [s.startNodeId, s.endNodeId])
				for (const side of Object.keys(graph.nodes.get(n)?.junction?.sides ?? {})) add(side);
		}
		return found;
	}

	// The road model, read again where `edit` (null: everywhere) reaches.
	//
	// Every stage keeps what it read of each node, segment and road (`Kept`)
	// and reads again only what its inputs changed in, each stage's reach
	// following from the one before:
	// - shown lines and curves: the segments written, those at a node
	//   written, and what those place at an edge (`reached`);
	// - which nodes only carry a road on (carriedOn): the nodes written and
	//   those of every segment read above;
	// - roads (`units`): every road any of those segments was or is part of;
	// - each node's road ends, sides and setbacks: those nodes, and both ends
	//   of every road read again;
	// - a junction's setback limits and a node of two sides' taper, which
	//   read the room the far node of each road leaves (`roomOf`): those
	//   nodes, the nodes one road away from any whose room changed (`roomy`),
	//   and a node of two sides one road away from a junction whose setbacks
	//   changed (`resized`);
	// - each road's shape: every road at a node read in the last two;
	// - junctions: those nodes, and either end of a road whose shape changed;
	// - crossings: those junctions, the far ends of the roads at a node read
	//   (a short link reads how many roads meet at each end), and every node
	//   of a road read again or reshaped that holds crossings of its own;
	// - the road ends handed on (`ends`): the nodes read, and either end of
	//   a road whose shape or crossings changed;
	// - merging: every junction joined by a road too short to exist
	//   (tooShort in road-model/merge.ts) to one read again, and the rest of
	//   the junctions it merged with last time.
	// A node's or road's result is kept by its id; where a key names a road
	// that ends at another node by the next build (a road end's setback),
	// only the node that set it takes it back.
	// So what a build reads follows what the edit changes, never the size of
	// the map. The lists handed on (Place) are copied whole where anything
	// changed: they are what the drawing walks.
	private model(graph: GraphView, edit: Changes | null, order: Order): Derived {
		const full = !edit || !this.kept;
		if (full) this.kept = new Kept();
		const k = this.kept!;
		const count = (kind: 'nodes' | 'segments') => {
			if (visited.on) visited[kind]++;
		};
		const nodeRank = (id: string) => order.node(id) ?? Infinity;
		const segmentRank = (id: string) => order.segment(id) ?? Infinity;
		const allNodes = () => new Set(graph.nodes.keys());
		const roadsAt = (nodeId: string) => graph.nodes.get(nodeId)?.connectedSegments ?? [];

		// Shown lines and curves.
		const seeds = new Set<string>();
		if (full) for (const id of graph.segments.keys()) seeds.add(id);
		else {
			for (const id of edit!.segments) seeds.add(id);
			for (const id of edit!.nodes) for (const s of roadsAt(id)) seeds.add(s);
		}
		const lineSet = full ? seeds : this.reached(graph, seeds);
		const inputs = new Map<string, string>();
		const attached = full ? new Map<string, { key: string; shift: Pt }>() : this.attached;
		const lines = this.lines;
		const relined = new Set<string>();
		// The nodes of every segment read, as it was and as it is.
		const readAt = new Set<string>();
		for (const id of lineSet) {
			count('segments');
			const was = k.segs.get(id);
			if (was) readAt.add(was.ends[0]).add(was.ends[1]);
			const segment = graph.segments.get(id);
			const live = new Map<string, { key: string; shift: Pt }>();
			let now: SegRead | undefined;
			let line: LineFrom | undefined;
			if (segment && segment.startNodeId !== segment.endNodeId) {
				readAt.add(segment.startNodeId).add(segment.endNodeId);
				const a = this.drawnEnd(graph, segment, segment.startNodeId, inputs, live);
				const b = this.drawnEnd(graph, segment, segment.endNodeId, inputs, live);
				if (a && b) {
					const before = this.lines.get(id);
					line = before && sameLine(before, segment, a, b) ? before : lineThrough(segment, a, b);
					if (line !== before) relined.add(id);
					const key = `${a.x},${a.y},${b.x},${b.y},${segment.controlX},${segment.controlY}`;
					let cached = this.curveCache.get(id);
					if (cached?.key !== key) {
						cached = { key, curve: curveOf(segment, a, b) };
						this.curveCache.set(id, cached);
					}
					now = {
						ends: [segment.startNodeId, segment.endNodeId],
						curve: cached.curve,
						key,
						slots: [...live.keys()]
					};
				}
			}
			for (const slot of was?.slots ?? []) if (!live.has(slot)) attached.delete(slot);
			for (const [slot, shift] of live) attached.set(slot, shift);
			if (now) k.segs.set(id, now);
			else {
				k.segs.delete(id);
				this.curveCache.delete(id);
				this.wholeRoads.delete(id);
			}
			lines.set(id, line);
		}
		if (full) {
			for (const id of [...this.curveCache.keys()]) if (!k.segs.has(id)) this.curveCache.delete(id);
			for (const id of [...lines.keys()]) if (!k.segs.has(id)) lines.set(id, undefined);
		}
		this.relined = relined;
		this.attached = attached;
		const pieceCurves = { get: (id: string) => k.segs.get(id)?.curve };

		// Each road attached at an edge and the segments it is placed from:
		// read again at the nodes written and those whose roads attached at an
		// edge read a segment written or at a node written (placedFrom).
		const placers = full ? allNodes() : new Set(edit!.nodes);
		if (!full) for (const id of seeds) for (const n of k.readBy.get(id) ?? []) placers.add(n);
		if (full) this.placing = new Map();
		const placing = this.placing as Map<string, readonly string[]>;
		const replaced = new Set<string>();
		for (const nodeId of placers) {
			count('nodes');
			for (const { id, read } of k.placedBy.get(nodeId) ?? [])
				for (const from of read) {
					k.readBy.get(from)?.delete(nodeId);
					const counts = k.placedCount.get(from)!;
					const n = counts.get(id)! - 1;
					if (n) counts.set(id, n);
					else counts.delete(id);
					replaced.add(from);
				}
			k.placedBy.delete(nodeId);
			const list: { id: string; read: string[] }[] = [];
			for (const id of Object.keys(graph.nodes.get(nodeId)?.junction?.sides ?? {})) {
				const segment = graph.segments.get(id);
				if (!segment) continue;
				const read = [...placedFrom(graph, segment, nodeId)];
				for (const from of read) {
					let by = k.readBy.get(from);
					if (!by) k.readBy.set(from, (by = new Set()));
					by.add(nodeId);
					let counts = k.placedCount.get(from);
					if (!counts) k.placedCount.set(from, (counts = new Map()));
					counts.set(id, (counts.get(id) ?? 0) + 1);
					replaced.add(from);
				}
				list.push({ id, read });
			}
			if (list.length) k.placedBy.set(nodeId, list);
		}
		for (const from of replaced) {
			const counts = k.placedCount.get(from);
			if (counts?.size) placing.set(from, [...counts.keys()]);
			else {
				placing.delete(from);
				k.placedCount.delete(from);
			}
			if (!k.readBy.get(from)?.size) k.readBy.delete(from);
		}

		// Roads as everything below reads them (`units`, by the id of their
		// first segment): a segment, or segments cut from one road joined end
		// to end through the nodes it only carries on through (`carried`, each
		// with the two segments it joins; carriedOn). Such a road is one road:
		// its tapers, the reach of a split, a bend's room, a junction's setback
		// and the merge test all read it as running on through those nodes,
		// and it is drawn as one. Such a node is no junction, even while its
		// connections are being edited (held): the connector reads it as a
		// node of its two segments (Derived.through), and it is drawn as one
		// road until an edit there breaks the join.
		const pairNodes = full ? allNodes() : new Set([...edit!.nodes, ...readAt]);
		// Segments whose road is read again.
		const chainSeeds = new Set(full ? graph.segments.keys() : [...lineSet, ...edit!.segments]);
		for (const nodeId of pairNodes) {
			count('nodes');
			const node = graph.nodes.get(nodeId);
			let pair: readonly [Segment, Segment] | null = null;
			if (node && node.connectedSegments.length === 2) {
				const here = node.connectedSegments.flatMap((id) => {
					const s = graph.segments.get(id);
					return s && k.segs.has(id) ? [s] : [];
				});
				pair = carriedOn(node, here, pieceCurves);
			}
			const was = k.pairs.get(nodeId);
			if (pair) k.pairs.set(nodeId, pair);
			else k.pairs.delete(nodeId);
			if (pair?.[0] !== was?.[0] || pair?.[1] !== was?.[1]) {
				for (const s of [...(was ?? []), ...(pair ?? [])]) chainSeeds.add(s.id);
				for (const s of roadsAt(nodeId)) chainSeeds.add(s);
			}
		}
		const pairAt = (id: string) => k.pairs.get(id) ?? null;
		// Every segment of every road a seed was or is part of.
		const touched = new Set<string>();
		const chained = new Set<string>();
		const todo = [...chainSeeds];
		const take = (id: string) => {
			if (touched.has(id)) return;
			touched.add(id);
			todo.push(id);
		};
		for (const id of chainSeeds) touched.add(id);
		for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
			const road = k.along.get(id)?.id ?? id;
			for (const p of k.joined.get(road)?.pieces ?? []) take(p.id);
			const s = graph.segments.get(id);
			if (!s || chained.has(id) || !k.segs.has(id)) continue;
			for (const p of chainThrough(s, pairAt).road) {
				chained.add(p.id);
				take(p.id);
			}
		}
		// The roads read again, as they were (with their ends) and as they are.
		const oldRoads = new Map<string, { ends: string[]; pieces: string[] }>();
		for (const id of touched) {
			const road = k.along.get(id)?.id ?? id;
			if (oldRoads.has(road)) continue;
			const j = k.joined.get(road);
			if (j)
				oldRoads.set(road, {
					ends: [j.unit.startNodeId, j.unit.endNodeId],
					pieces: j.pieces.map((p) => p.id)
				});
			else if (k.shapeKeys.has(road)) oldRoads.set(road, { ends: [], pieces: [road] });
		}
		for (const road of oldRoads.keys()) k.joined.delete(road);
		for (const id of touched) {
			k.along.delete(id);
			k.units.delete(id);
		}
		const newRoads = new Set<string>();
		for (const id of touched) {
			if (k.along.has(id)) continue;
			const segment = graph.segments.get(id);
			if (!segment || !k.segs.has(id)) continue;
			const pieces = roadThrough(segment, pairAt);
			if (pieces.length < 2) {
				newRoads.add(id);
				continue;
			}
			const [first, last] = [pieces[0], pieces[pieces.length - 1]];
			const key = pieces.map((s) => k.segs.get(s.id)!.key).join('/');
			let cached = this.joinedCache.get(first.id);
			if (cached?.key !== key) {
				cached = { key, curve: joinCurves(pieces.map((s) => k.segs.get(s.id)!.curve)) };
				this.joinedCache.set(first.id, cached);
			}
			const unit: RoadUnit = {
				id: first.id,
				startNodeId: first.startNodeId,
				endNodeId: last.endNodeId,
				lanes: first.lanes,
				lanesKey: first.lanesKey,
				offsetStart: first.offsetStart,
				offsetEnd: last.offsetEnd
			};
			k.joined.set(first.id, { unit, pieces, curve: cached.curve, key });
			const ids = pieces.map((p) => p.id);
			let at = 0;
			for (const s of pieces) {
				k.along.set(s.id, { id: first.id, at });
				k.units.set(s.id, ids);
				at += k.segs.get(s.id)!.curve.length;
			}
			newRoads.add(first.id);
		}
		const removedRoads = [...oldRoads.keys()].filter((id) => !newRoads.has(id));
		// A node two roads meet at, a loop parted there among them
		// (roadThrough), is a node like any other.
		const recarry = new Set(pairNodes);
		for (const id of touched) {
			const s = graph.segments.get(id);
			if (s) recarry.add(s.startNodeId).add(s.endNodeId);
		}
		for (const nodeId of recarry) {
			const pair = k.pairs.get(nodeId);
			const of = pair && k.along.get(pair[0].id);
			if (pair && of && of.id === k.along.get(pair[1].id)?.id) k.carried.set(nodeId, pair);
			else k.carried.delete(nodeId);
		}
		// Each road's curve and its key, by the id of its first segment (a
		// segment of a road of more than one reads its own).
		const curves = { get: (id: string) => k.joined.get(id)?.curve ?? k.segs.get(id)?.curve };
		const curveKeys = { get: (id: string) => k.joined.get(id)?.key ?? k.segs.get(id)?.key };
		const unitOf = (id: string) => k.along.get(id) ?? { id, at: 0 };
		// A road's two end nodes, by its id.
		const endsOfRoad = (id: string) => {
			const unit = k.joined.get(id)?.unit ?? graph.segments.get(id);
			return unit ? [unit.startNodeId, unit.endNodeId] : [];
		};
		// The segment of a road that ends at a node there: its edits there are
		// stored by that segment's id.
		const pieceAt = (arm: Arm) => segmentAtEnd(k.units, arm.segment.id, arm.end);
		const storedAt = (nodeId: string) =>
			k.renamedAt.has(nodeId) ? k.renamedAt.get(nodeId) : graph.nodes.get(nodeId)?.junction;
		const far = (arm: Arm) =>
			arm.end === 'start' ? arm.segment.endNodeId : arm.segment.startNodeId;

		// Each node's road ends, its sides where its lanes find their way
		// across (`links`: two roads, or roads attached at an edge with the
		// ones they join), and the setbacks of a junction of three or more.
		const ends = full ? allNodes() : new Set([...pairNodes, ...recarry, ...edit!.nodes]);
		if (!full) {
			for (const { ends: at } of oldRoads.values()) for (const n of at) ends.add(n);
			for (const id of newRoads) for (const n of endsOfRoad(id)) ends.add(n);
		}
		if (full) this.sections = new Map();
		const setbackCache = full
			? new Map<string, { key: unknown[]; trims: [string, number][] }>()
			: this.setbackCache;
		const armOf = (segment: RoadUnit, curve: Curve, end: End): Arm => {
			const section = this.section(segment);
			const off = offsetAt(segment, end);
			const out = outward(curve, end);
			// The drawing direction leaves the start and arrives at the end.
			const along = end === 'start' ? out : { x: -out.x, y: -out.y };
			return {
				segment,
				curve,
				end,
				out,
				n: { x: -along.y, y: along.x },
				full: { lo: -section.total / 2 + off, hi: section.total / 2 + off },
				roadway: { lo: section.lo + off, hi: section.hi + off },
				half: section.total / 2 + Math.abs(off),
				walks: section.walks
			};
		};
		// What a far node's room reads of a node (roomOf), to tell whether it
		// changed: whether it is a node of two sides, the least it takes of
		// each side, and its automatic setbacks.
		const facing = (nodeId: string) =>
			JSON.stringify([
				k.links.has(nodeId),
				k.leasts.get(nodeId) ?? null,
				k.autoAt.get(nodeId) ?? null
			]);
		const faced = new Map<string, { was: string; near: Set<string> }>();
		for (const nodeId of ends) {
			count('nodes');
			const near = new Set((k.endsHere.get(nodeId) ?? []).map(far));
			faced.set(nodeId, { was: full ? '' : facing(nodeId), near });
			// A road end's key names its road, which may end at another node
			// now: only what this node set is taken back.
			for (const [key] of k.autoAt.get(nodeId) ?? [])
				if (k.autoBy.get(key) === nodeId) {
					k.auto.delete(key);
					k.autoBy.delete(key);
				}
			for (const map of [k.autoAt, k.endsHere, k.armsAt, k.renames, k.renamedAt, k.links])
				map.delete(nodeId);
			const node = graph.nodes.get(nodeId);
			const arms: Arm[] = [];
			let rename: Map<string, string> | undefined;
			if (node && !k.carried.has(nodeId))
				for (const id of node.connectedSegments) {
					const segment = graph.segments.get(id);
					if (!segment || !k.segs.has(id)) continue;
					const end: End = segment.startNodeId === nodeId ? 'start' : 'end';
					// A segment joined into a road is read as that road, its first
					// segment too.
					const of = k.along.get(id)?.id ?? id;
					if (of !== id) (rename ??= new Map()).set(id, of);
					arms.push(armOf(k.joined.get(of)?.unit ?? segment, curves.get(of)!, end));
				}
			if (arms.length) k.endsHere.set(nodeId, [...arms]);
			const keys = arms.map((arm) => arm.segment.lanesKey);
			this.useSections(keys, 1);
			this.useSections(k.sectionsAt.get(nodeId) ?? [], -1);
			if (keys.length) k.sectionsAt.set(nodeId, keys);
			else k.sectionsAt.delete(nodeId);
			for (const arm of arms) near.add(far(arm));
			if (arms.length < 2) {
				if (!full) setbackCache.delete(nodeId);
				continue;
			}
			if (rename) {
				const to = rename;
				k.renames.set(nodeId, to);
				const stored = node!.junction;
				const sig = [...to].join();
				let known = stored && this.renamedStored.get(stored);
				if (stored && known?.sig !== sig) {
					known = {
						sig,
						data: mapJunction(stored, (road, end) => ({ road: to.get(road) ?? road, end }))
					};
					this.renamedStored.set(stored, known);
				}
				k.renamedAt.set(nodeId, known?.data);
			}
			k.armsAt.set(nodeId, arms);
			const groups = linkGroups(arms, storedAt(nodeId)?.sides);
			if (groups) {
				k.links.set(nodeId, groups);
				if (!full) setbackCache.delete(nodeId);
				continue;
			}
			const auto = this.setbacksAt(nodeId, arms, setbackCache);
			for (const [key, trim] of auto) {
				k.auto.set(key, trim);
				k.autoBy.set(key, nodeId);
			}
			k.autoAt.set(nodeId, auto);
		}
		this.setbackCache = setbackCache;
		// Nodes of two sides: their connections, the taper those need, read at
		// the node before anything is trimmed, and the least they take of each
		// side where their lanes line up across them (they need no taper: a
		// road cut in two, or a bend) and nothing is set by hand or held there:
		// its side's bend, never short of what is attached there getting clear.
		// Null where it may take more.
		for (const nodeId of ends) {
			const groups = k.links.get(nodeId);
			if (!groups) {
				k.linkData.delete(nodeId);
				k.leasts.delete(nodeId);
				this.linkCache.delete(nodeId);
				continue;
			}
			const stored = storedAt(nodeId);
			const link = this.linkOf(nodeId, k.armsAt.get(nodeId)!, groups, stored, curves, curveKeys);
			k.linkData.set(nodeId, link);
			const free = link.need <= 0 && !stored?.setbacks && this.held?.node !== nodeId;
			k.leasts.set(
				nodeId,
				free ? linkSetbacks(groups[0][0], groups[1][0], link.clear) : [null, null]
			);
		}
		if (full)
			for (const id of [...this.linkCache.keys()]) if (!k.links.has(id)) this.linkCache.delete(id);
		// The nodes one road away from any whose room as a far node changed.
		const roomy = new Set<string>();
		for (const [nodeId, { was, near }] of faced)
			if (full || facing(nodeId) !== was) for (const n of near) roomy.add(n);
		const leastAt = (nodeId: string, segment: RoadUnit) => {
			const groups = k.links.get(nodeId)!;
			const i = groups.findIndex((g) => g.some((a) => a.segment === segment));
			return i < 0 ? null : k.leasts.get(nodeId)![i];
		};
		// How much of a road its node at `end` may take: where the far node is
		// one where lanes find their way across, what that leaves of it if it
		// takes no more than it must, unless this node, one of the same kind,
		// must take more than that leaves (the road is too short for both:
		// a tight hairpin's piece); otherwise half of it (the two may meet in
		// its middle); elsewhere up to the far node's setback, leaving `left`:
		// its automatic one (`final` false), or the one it ends up with, set
		// by hand too.
		const roomOf = (arm: Arm, left = ROAD_LEFT, final = true) => {
			const own = arm.end === 'start' ? arm.segment.startNodeId : arm.segment.endNodeId;
			const other = far(arm);
			const farKey = `${arm.segment.id}:${arm.end === 'start' ? 'end' : 'start'}`;
			const length = curves.get(arm.segment.id)?.length ?? 0;
			if (k.links.has(other)) {
				const least = leastAt(other, arm.segment);
				const mine = k.links.has(own) ? leastAt(own, arm.segment) : null;
				return least === null || (mine !== null && mine + least > length)
					? length / 2
					: length - least;
			}
			return length - ((final ? k.trims : k.auto).get(farKey) ?? 0) - left;
		};
		// Each node's setbacks as it ends up with them, by road end.
		const setTrims = (nodeId: string, entries: [string, number][]) => {
			for (const key of k.trimsAt.get(nodeId) ?? [])
				if (k.trimsBy.get(key) === nodeId) {
					k.trims.delete(key);
					k.trimsBy.delete(key);
				}
			for (const [key, trim] of entries) {
				k.trims.set(key, trim);
				k.trimsBy.set(key, nodeId);
			}
			if (entries.length)
				k.trimsAt.set(
					nodeId,
					entries.map(([key]) => key)
				);
			else k.trimsAt.delete(nodeId);
		};
		const trimsOf = (nodeId: string) =>
			JSON.stringify((k.trimsAt.get(nodeId) ?? []).map((key) => [key, k.trims.get(key)]));

		// Junctions of three or more: a road's setback set by hand makes the
		// junction bigger on it, never smaller than its curb corners need nor
		// past the far node's setback, leaving the road room for the paint
		// the junction lays on it (its crossing and stop line). Every
		// automatic setback is known first, so this reads the same whichever
		// node comes first.
		if (full) this.limits.clear();
		if (full) this.used = new Map();
		const sized = full ? new Set(k.armsAt.keys()) : new Set([...ends, ...roomy]);
		const resized = new Set<string>();
		for (const nodeId of sized) {
			count('nodes');
			if (k.links.has(nodeId)) continue;
			const was = trimsOf(nodeId);
			this.used.delete(nodeId);
			k.paintBy.delete(nodeId);
			const arms = k.armsAt.get(nodeId);
			if (!arms) {
				setTrims(nodeId, []);
				this.limits.delete(nodeId);
				if (was !== '[]') for (const n of faced.get(nodeId)?.near ?? []) resized.add(n);
				continue;
			}
			const set = storedAt(nodeId)?.setbacks;
			const limits = new Map<string, { min: number; max: number }>();
			const trims = new Map<string, number>(k.autoAt.get(nodeId));
			for (const arm of arms) {
				const key = `${arm.segment.id}:${arm.end}`;
				const min = k.auto.get(key) ?? 0;
				const max = Math.max(min, roomOf(arm, Math.max(ROAD_LEFT, APPROACH_PAINT), false));
				limits.set(pieceAt(arm), { min, max });
				const value = set?.[arm.segment.id];
				if (value !== undefined) trims.set(key, Math.min(max, Math.max(min, value)));
			}
			this.limits.set(nodeId, limits);
			setTrims(nodeId, [...trims]);
			if (full || trimsOf(nodeId) !== was) for (const arm of arms) resized.add(far(arm));
		}
		// Nodes of two sides: each side's taper (set by hand, held, or half
		// what the shifts need) is never shorter than the shifts allow nor so
		// long it runs into the road's far node, nor short of where a road
		// attached on that side gets clear of the roads it joins (clearOf).
		// Left to itself the taper is the same length both sides, as long as
		// the side with least room allows; past that the other side takes what
		// it can of the rest (a short road between this node and a junction
		// leaves its lanes to ease across on the road behind). Roads it takes
		// past the paint room their far junction leaves on them, for a taper,
		// a bend or a road attached there getting clear, are noted
		// (`paintBy`): more than the least gap every such node keeps
		// (TAPER.THROUGH_GAP), which takes nothing it needs room for.
		const tapered = full ? new Set(k.links.keys()) : new Set([...ends, ...roomy, ...resized]);
		for (const nodeId of tapered) {
			const groups = k.links.get(nodeId);
			if (!groups) continue;
			count('nodes');
			const stored = storedAt(nodeId);
			const link = k.linkData.get(nodeId)!;
			const lead = [groups[0][0], groups[1][0]];
			// A bend takes what it needs to turn its lanes, and the roads
			// attached on a side reach as far as they need to get clear
			// (clearOf), wherever the road holds that past its far node: the
			// paint room a junction there leaves on the road gives way to them,
			// as the junction's own room on the road already leaves the bend
			// its least (leastAt).
			const bends = linkSetbacks(lead[0], lead[1], [0, 0]);
			const rooms = groups.map((group, i) =>
				Math.min(
					...group.map((arm) =>
						Math.max(roomOf(arm), Math.min(Math.max(bends[i], link.clear[i]), roomOf(arm, 0)))
					)
				)
			);
			const shared = Math.min(...rooms);
			const limits = new Map<string, { min: number; max: number }>();
			const reach = lead.map((arm, i) => {
				const id = arm.segment.id;
				const max = Math.max(0, rooms[i]);
				const min = Math.min(link.least / 2, max);
				limits.set(pieceAt(arm), { min, max });
				const set = stored?.setbacks?.[id];
				// Never short of where the roads attached on this side get clear.
				const farOf = (value: number) => Math.min(max, Math.max(value, link.clear[i]));
				if (set !== undefined) return { value: farOf(Math.max(min, set)), room: rooms[i] };
				// Held while it was no junction (a road only carrying on through
				// it, its lanes shown at the node), it takes no more than a road
				// carried on through a node of two sides keeps clear of it.
				const fresh = this.held?.node === nodeId && !this.held.setbacks.size;
				const held = fresh
					? TAPER.THROUGH_GAP
					: this.held?.node === nodeId
						? this.held.setbacks.get(id)
						: undefined;
				const rest = held ?? link.need - Math.min(Math.max(0, shared), link.need / 2);
				const value = farOf(rest);
				return { value, room: Math.max(shared, value) };
			});
			if (groups.every((g) => g.length === 1)) this.limits.set(nodeId, limits);
			else this.limits.delete(nodeId);
			const result = linkSetbacks(lead[0], lead[1], [reach[0].value, reach[1].value]);
			const used = new Map<string, number>();
			const trims = new Map<string, number>();
			const paint = new Set<string>();
			for (const [i, group] of groups.entries()) {
				// A road too short for its far junction's setback and a taper
				// leaves no room here, but its end never reaches past the node.
				const trim = Math.min(result[i], Math.max(TAPER.THROUGH_GAP, reach[i].room));
				used.set(lead[i].segment.id, trim);
				for (const arm of group) {
					trims.set(`${arm.segment.id}:${arm.end}`, trim);
					if (trim > Math.max(TAPER.THROUGH_GAP, roomOf(arm))) paint.add(arm.segment.id);
				}
			}
			this.used.set(nodeId, used);
			if (paint.size) k.paintBy.set(nodeId, paint);
			else k.paintBy.delete(nodeId);
			// A node held while it was no junction holds what it takes the first
			// time it is one.
			if (this.held?.node === nodeId && !this.held.setbacks.size) this.held.setbacks = used;
			// A junction's setback on a road that carries on through a node of
			// two roads short of it reaches on past that node into the road
			// beyond, as it would with no node there: the road it is set on is
			// too short to hold it (and its junction merges with that node,
			// road-model/merge.ts).
			if (link.through) {
				const [a, b] = lead;
				for (const [arm, beyond] of [
					[a, b],
					[b, a]
				]) {
					if (k.links.has(far(arm))) continue;
					const set =
						k.trims.get(`${arm.segment.id}:${arm.end === 'start' ? 'end' : 'start'}`) ?? 0;
					const past = set - (curves.get(arm.segment.id)?.length ?? Infinity);
					const key = `${beyond.segment.id}:${beyond.end}`;
					if (past > (trims.get(key) ?? 0)) trims.set(key, past);
				}
			}
			setTrims(nodeId, [...trims]);
		}

		// Each road trimmed by its setbacks, with its span and shape's number
		// noted: every road read again, and every road at a node read since.
		const shaped = new Set<string>(full ? graph.segments.keys() : newRoads);
		if (!full)
			for (const nodeId of new Set([...ends, ...sized, ...tapered]))
				for (const arm of k.endsHere.get(nodeId) ?? []) shaped.add(arm.segment.id);
		for (const id of removedRoads) {
			for (const p of oldRoads.get(id)!.pieces) if (!graph.segments.has(p)) k.spans.delete(p);
			k.shapeKeys.delete(id);
			k.roads.delete(id);
			this.roadVersions.delete(id);
			this.shapes.delete(id);
			this.joinedCache.delete(id);
			this.touching.delete(id);
		}
		for (const { pieces } of oldRoads.values())
			for (const p of pieces) if (!newRoads.has(p)) k.geos.delete(p);
		for (const id of lineSet) if (!k.segs.has(id)) k.spans.delete(id);
		const reshaped = new Set<string>();
		// A road (its first segment) trimmed by its setbacks.
		const shapeRoad = (first: Segment) => {
			const joined = k.joined.get(first.id);
			const segment = joined?.unit ?? first;
			const curve = curves.get(segment.id)!;
			let d0 = k.trims.get(`${segment.id}:start`) ?? 0;
			let d1 = k.trims.get(`${segment.id}:end`) ?? 0;
			// Never trim a road away: two close junctions share what length
			// there is. Where its lanes line up across a node of two sides at
			// each end, or at either end (each of which takes no more of it than
			// it must, as roomOf allows), or a node of two sides has taken its
			// paint room already, the two leave it only a little; otherwise they
			// leave its paint room. (Only a road its two nodes' setbacks may not
			// fit is read further.)
			const paint = Math.max(curve.length - ROAD_LEFT, curve.length / 2);
			const through = curve.length - TAPER.THROUGH_GAP;
			if (d0 + d1 > Math.min(paint, through)) {
				const lined = (nodeId: string) => k.links.has(nodeId) && leastAt(nodeId, segment) !== null;
				const between =
					(k.links.has(segment.startNodeId) && k.links.has(segment.endNodeId)) ||
					lined(segment.startNodeId) ||
					lined(segment.endNodeId) ||
					!!k.paintBy.get(segment.startNodeId)?.has(segment.id) ||
					!!k.paintBy.get(segment.endNodeId)?.has(segment.id);
				const room = between ? through : paint;
				if (d0 + d1 > room) {
					const f = room / (d0 + d1);
					d0 *= f;
					d1 *= f;
				}
			}
			// Junctions are keyed on the road's shape (numbered); its crossings
			// come later, onto a fresh copy.
			const ids = segment.lanes.map((l) => l.id).join();
			const shifts = `${segment.offsetStart},${segment.offsetEnd}`;
			const key = `${curveKeys.get(segment.id)}|${d0}|${d1}|${shifts}|${segment.lanesKey}|${ids}`;
			let shape = this.shapes.get(segment.id);
			if (shape?.key !== key) {
				const road = roadOf(segment, curve, d0, d1);
				shape = { key, road, path: samplePath(road), version: ++this.version };
				this.shapes.set(segment.id, shape);
			}
			const length = curve.length - d0 - d1;
			if (!joined) k.spans.set(first.id, { d0, length, total: curve.length });
			else
				for (const p of joined.pieces)
					k.spans.set(p.id, {
						d0: d0 - k.along.get(p.id)!.at,
						length,
						total: k.segs.get(p.id)!.curve.length
					});
			const number = String(shape.version);
			if (k.shapeKeys.get(segment.id) !== number) {
				reshaped.add(segment.id);
				k.shapeKeys.set(segment.id, number);
				// Its shape, for the junctions read before its crossings are.
				k.geos.set(segment.id, { road: { ...shape.road }, path: shape.path });
			}
		};
		for (const id of shaped) {
			count('segments');
			const first = graph.segments.get(id);
			if (!first || !k.segs.has(id) || unitOf(id).id !== id) continue;
			shapeRoad(first);
		}

		// Each node's junction as drawn, naming each road by its first
		// segment's id (`junctions`), and as the editor sees it, naming each road
		// end by the segment that ends there (`seen`): at every node read, and
		// at either end of every road whose shape changed.
		const junctioned = full ? allNodes() : new Set(ends);
		if (!full) for (const id of reshaped) for (const n of endsOfRoad(id)) junctioned.add(n);
		// The segment ending at a node for a road's end there (`renames`).
		const pieceOf = (nodeId: string) => {
			const rename = k.renames.get(nodeId);
			if (!rename) return null;
			const back = new Map([...rename].map(([piece, unit]) => [`${unit}:end`, piece]));
			return (road: string, end: End) => back.get(`${road}:${end}`) ?? road;
		};
		const rejunctioned = new Set<string>();
		for (const nodeId of junctioned) {
			count('nodes');
			const arms = k.armsAt.get(nodeId);
			const was = k.junctions.get(nodeId);
			const wasKey = k.junctionKeys.get(nodeId);
			if (!arms) {
				k.junctions.delete(nodeId);
				k.seen.delete(nodeId);
				k.junctionKeys.delete(nodeId);
				this.junctionCache.delete(nodeId);
				if (was) rejunctioned.add(nodeId);
				continue;
			}
			const stored = storedAt(nodeId);
			const key = `${arms.map((a) => k.shapeKeys.get(a.segment.id)).join()}|${this.json(stored)}`;
			k.junctionKeys.set(nodeId, key);
			// A node of two sides was read before the trims.
			let junction = k.linkData.get(nodeId)?.junction;
			if (junction) this.junctionCache.delete(nodeId);
			else {
				const cached = this.junctionCache.get(nodeId);
				junction =
					cached?.key === key ? cached.junction : junctionOf(nodeId, arms, stored, k.geos, curves);
				this.junctionCache.set(nodeId, { key, junction });
			}
			k.junctions.set(nodeId, junction);
			const back = pieceOf(nodeId);
			if (back) {
				const sig = [...k.renames.get(nodeId)!].join();
				let known = this.renamedMemo.get(junction);
				if (known?.sig !== sig) {
					known = { sig, junction: renamed(junction, back) };
					this.renamedMemo.set(junction, known);
				}
				k.seen.set(nodeId, known.junction);
			} else k.seen.set(nodeId, junction);
			if (junction !== was || key !== wasKey) rejunctioned.add(nodeId);
		}
		if (full)
			for (const id of [...this.junctionCache.keys()])
				if (!k.armsAt.has(id) || k.links.has(id)) this.junctionCache.delete(id);
		if (full)
			for (const id of [...this.wholeRoads.keys()]) if (!curves.get(id)) this.wholeRoads.delete(id);
		if (full)
			for (const id of [...this.joinedCache.keys()])
				if (!k.joined.has(id)) this.joinedCache.delete(id);
		if (full)
			for (const id of [...this.shapes.keys()]) if (!k.shapeKeys.has(id)) this.shapes.delete(id);

		// Crossings: each junction's defaults, as stored edits move or switch
		// them, and those added by hand, placed on their roads (a crossing
		// stored at a node a road only carries on through lies on that road):
		// read at every junction read, at the far end of every road at a node
		// whose roads came or went (a short link reads how many roads meet at
		// each of its ends), and at every node of a road read again or whose
		// shape changed that holds crossings of its own.
		const armCount = (road: string, end: End) => {
			const nodeId = endsOfRoad(road)[end === 'start' ? 0 : 1];
			const arms = nodeId === undefined ? undefined : k.armsAt.get(nodeId);
			return arms?.some((a) => a.segment.id === road && a.end === end) ? arms.length : 0;
		};
		const shortLink = (road: string) =>
			armCount(road, 'start') > 2 &&
			armCount(road, 'end') > 2 &&
			(curves.get(road)?.length ?? Infinity) < SHORT_LINK;
		const holders = full ? allNodes() : new Set([...junctioned, ...edit!.nodes]);
		if (!full) {
			for (const { near } of faced.values()) for (const n of near) holders.add(n);
			for (const id of [...reshaped, ...touched])
				for (const p of k.joined.get(id)?.pieces ?? [graph.segments.get(id)])
					if (p) holders.add(p.startNodeId).add(p.endNodeId);
		}
		const recrossed = new Set<string>();
		const crossingCache = full
			? new Map<string, { key: string; list: NodeCrossing[] }>()
			: this.crossingCache;
		for (const nodeId of holders) {
			count('nodes');
			for (const { road } of k.laid.get(nodeId) ?? []) {
				recrossed.add(road);
				k.holdersOn.get(road)?.delete(nodeId);
			}
			k.laid.delete(nodeId);
			const junction = k.junctions.get(nodeId);
			const stored = graph.nodes.get(nodeId)?.junction?.crossings ?? [];
			if (!junction && !stored.length) {
				k.crossings.delete(nodeId);
				crossingCache.delete(nodeId);
				continue;
			}
			const kept = junction
				? this.crossingsAt(nodeId, junction, k.geos, shortLink, k.junctionKeys.get(nodeId)!)
				: undefined;
			if (kept) crossingCache.set(nodeId, kept);
			else crossingCache.delete(nodeId);
			const back = pieceOf(nodeId);
			const list = (kept?.list ?? []).map((d) => (back ? { ...d, road: back(d.road, d.end) } : d));
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
			const laid: { road: string; at: number; lanes: [string, string] }[] = [];
			for (const c of all) {
				const road = unitOf(c.road).id;
				const shape = k.shapeKeys.has(road) ? this.shapes.get(road) : undefined;
				const span = k.spans.get(c.road);
				if (!shape || !span || span.length < 2 * CROSSING_FROM_END) continue;
				if (!c.lanes.every((id) => shape.road.lanes.some((l) => l.id === id))) continue;
				c.place = crossingPlace(c, span);
				if (!c.on) continue;
				laid.push({ road, at: c.place, lanes: c.lanes });
				recrossed.add(road);
				let on = k.holdersOn.get(road);
				if (!on) k.holdersOn.set(road, (on = new Set()));
				on.add(nodeId);
			}
			if (laid.length) k.laid.set(nodeId, laid);
			k.crossings.set(nodeId, all);
		}
		this.crossingCache = crossingCache;
		// A road's crossings, in the order of the nodes that hold them:
		// junctions first, each list in the order its node holds them.
		const crossingsOf = (road: string) => {
			const by = [...(k.holdersOn.get(road) ?? [])].sort(
				(a, b) =>
					Number(!k.junctions.has(a)) - Number(!k.junctions.has(b)) || nodeRank(a) - nodeRank(b)
			);
			const out = by.flatMap((h) =>
				(k.laid.get(h) ?? [])
					.filter((c) => c.road === road)
					.map((c) => ({ at: c.at, lanes: c.lanes }))
			);
			return out.length ? out : undefined;
		};
		// Each road as drawn, numbered: its number changes with its shape and
		// its crossings, and it is drawn afresh, with its segments' roads as
		// the editor reads them (by each segment's id), where that changes.
		const revised = new Set<string>();
		for (const id of new Set([...shaped, ...recrossed])) {
			if (!k.shapeKeys.has(id)) {
				if (!graph.segments.has(id) || unitOf(id).id !== id) k.holdersOn.delete(id);
				continue;
			}
			count('segments');
			const crossings = crossingsOf(id);
			const json = JSON.stringify(crossings ?? []);
			const shape = this.shapes.get(id)!;
			const number = k.shapeKeys.get(id)!;
			const known = this.roadVersions.get(id);
			const same = known?.json === json && known.shape === number;
			if (!same || !k.roads.has(id)) {
				const version = same ? known!.version : ++this.version;
				this.roadVersions.set(id, { json, shape: number, version });
				const road: Road = { ...shape.road };
				if (crossings) road.crossings = crossings;
				road.key = String(version);
				k.roads.set(id, road);
				k.geos.set(id, { road, path: shape.path });
				revised.add(id);
			}
			const road = k.roads.get(id)!;
			for (const piece of k.joined.get(id)?.pieces.slice(1) ?? [])
				if (revised.has(id) || !k.geos.has(piece.id))
					k.geos.set(piece.id, { road: { ...road, id: piece.id }, path: shape.path });
		}
		if (full)
			for (const id of [...this.roadVersions.keys()])
				if (!k.roads.has(id)) this.roadVersions.delete(id);

		// Every road end at each node, for a network laid over this one: at
		// every node read, and at either end of every road drawn afresh.
		const fixedAt = full ? allNodes() : new Set(ends);
		if (!full) for (const id of revised) for (const n of endsOfRoad(id)) fixedAt.add(n);
		for (const nodeId of fixedAt) {
			count('nodes');
			const arms = k.endsHere.get(nodeId);
			if (!arms) k.fixed.delete(nodeId);
			else
				k.fixed.set(
					nodeId,
					arms.map((arm) => ({
						end: arm.end,
						geo: k.geos.get(arm.segment.id)!,
						key: k.shapeKeys.get(arm.segment.id)!
					}))
				);
		}

		// Junctions too close together draw as one (road-model/merge.ts):
		// every junction joined to one read again (its junction or its roads'
		// shapes changed) by roads too short to exist, read with those roads
		// as effectiveJunctions reads them all, and the junctions those merged
		// with in the last build. A drawn junction's key holds its nodes' keys
		// and those of every road they end, the roads merged away between them
		// included.
		const touching = full ? new Map<string, { key: string; touching: boolean }>() : this.touching;
		const memo: MergeMemo = (road, a, b, test) => {
			const key = `${k.junctionKeys.get(a.id)}|${k.junctionKeys.get(b.id)}`;
			let known = this.touching.get(road);
			if (known?.key !== key) known = { key, touching: test() };
			touching.set(road, known);
			return known.touching;
		};
		const outlines = new Map<string, Paths>();
		// The road ends at a junction (`end` its end of the road), and the
		// junction at its far end.
		const owner = (road: string, end: End) => {
			const nodeId = endsOfRoad(road)[end === 'start' ? 0 : 1];
			const j = nodeId === undefined ? undefined : k.junctions.get(nodeId);
			return j?.ends.some((e) => e.road === road && e.end === end) ? j : undefined;
		};
		// The two junctions a road links, if it links two.
		const linking = (road: string) => {
			const a = owner(road, 'start');
			const b = owner(road, 'end');
			return a && b && a !== b ? ([a, b] as const) : null;
		};
		const short = (road: string) => {
			const link = linking(road);
			return !!link && tooShort(road, ...link, k.geos, memo, outlines);
		};
		const remerge = full ? new Set(k.junctions.keys()) : new Set(rejunctioned);
		if (!full)
			for (const id of [...reshaped, ...removedRoads, ...newRoads]) {
				for (const n of endsOfRoad(id)) remerge.add(n);
				for (const n of oldRoads.get(id)?.ends ?? []) remerge.add(n);
			}
		// Each junction reached, its last cluster's members pushed once for
		// the whole cluster.
		const reached = new Set<string>();
		const expanded = new Set<object>();
		const stack = [...remerge];
		for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
			if (reached.has(id)) continue;
			reached.add(id);
			count('nodes');
			const was = k.clusterOf.get(id);
			if (was && !expanded.has(was)) {
				expanded.add(was);
				for (const m of was.members) {
					count('nodes');
					stack.push(m);
				}
			}
			for (const arm of k.junctions.has(id) ? k.armsAt.get(id)! : [])
				if (short(arm.segment.id)) stack.push(far(arm));
		}
		// The first nodes of the groups no longer drawn and drawn afresh.
		const gone = new Set<string>();
		const come = new Set<string>();
		for (const id of reached) {
			const cluster = k.clusterOf.get(id);
			if (!cluster) continue;
			for (const m of cluster.members) k.clusterOf.delete(m);
			for (const r of cluster.hidden) k.hidden.delete(r);
			for (const g of cluster.groups) {
				k.drawn.delete(g.members[0]);
				gone.add(g.members[0]);
				for (const m of g.members) k.groupOf.delete(m);
			}
		}
		const drawnKey = (j: { members: string[] }) =>
			[
				...j.members.map((id) => k.junctionKeys.get(id)),
				...j.members.flatMap((id) => k.junctions.get(id)!.ends.map((e) => k.roads.get(e.road)?.key))
			].join('|');
		const draw = (j: Junction & { members: string[] }) => {
			k.drawn.set(j.members[0], { ...j, key: drawnKey(j) });
			come.add(j.members[0]);
			for (const m of j.members) k.groupOf.set(m, j.members[0]);
		};
		const placed = new Set<string>();
		for (const id of reached) {
			if (placed.has(id) || !k.junctions.has(id)) continue;
			// The junctions joined to this one by roads too short to exist.
			const members = new Set<string>();
			const roads = new Set<string>();
			const group = [id];
			for (let at = group.pop(); at !== undefined; at = group.pop()) {
				if (members.has(at)) continue;
				members.add(at);
				for (const arm of k.armsAt.get(at)!)
					if (short(arm.segment.id)) {
						roads.add(arm.segment.id);
						group.push(far(arm));
					}
			}
			for (const m of members) placed.add(m);
			const ids = [...members].sort((a, b) => nodeRank(a) - nodeRank(b));
			const merged = roads.size
				? effectiveJunctions(
						[...roads].sort((a, b) => segmentRank(a) - segmentRank(b)).map((r) => k.roads.get(r)!),
						ids.map((m) => k.junctions.get(m)!),
						k.geos,
						memo,
						outlines
					)
				: { junctions: [{ ...k.junctions.get(id)!, members: [id] }], hidden: new Set<string>() };
			const cluster = { members: ids, groups: merged.junctions, hidden: [...merged.hidden] };
			for (const m of ids) k.clusterOf.set(m, cluster);
			for (const r of cluster.hidden) k.hidden.add(r);
			for (const g of cluster.groups) draw(g);
		}
		// A road keeps its touching test only while it is short enough to merge
		// the two junctions it links. It stops being either only where it was
		// read again or a node at its ends was (`shaped`): a junction gone from
		// an end leaves it a dead end or carried on, whether or not that end
		// trimmed it, so its shape may stay the same. So a road read out of the
		// merge limit, or linking two junctions no more, has it no more.
		for (const id of shaped)
			if (!((k.geos.get(id)?.path.length ?? Infinity) < TOUCH_REACH && linking(id)))
				touching.delete(id);
		this.touching = touching;
		// A group not read again whose roads were drawn afresh is keyed again.
		for (const id of revised)
			for (const n of endsOfRoad(id)) {
				const first = k.groupOf.get(n);
				const drawn = first === undefined ? undefined : k.drawn.get(first);
				if (drawn && !reached.has(n)) {
					const key = drawnKey(drawn);
					if (key !== drawn.key) k.drawn.set(first!, { ...drawn, key });
				}
			}
		const regrouped = full || gone.size !== come.size || [...gone].some((id) => !come.has(id));
		if (regrouped) k.drawnOrder = [...k.drawn.keys()].sort((a, b) => nodeRank(a) - nodeRank(b));
		if (
			full ||
			edit!.reordered ||
			removedRoads.length ||
			[...newRoads].some((id) => !oldRoads.has(id))
		)
			k.roadOrder = [...k.roads.keys()].sort((a, b) => segmentRank(a) - segmentRank(b));
		const all = k.roadOrder.map((id) => k.roads.get(id)!);
		const place: Place = {
			roads: all.filter((r) => !k.hidden.has(r.id)),
			hidden: all.filter((r) => k.hidden.has(r.id)),
			junctions: k.drawnOrder.map((id) => k.drawn.get(id)!)
		};
		// A node a road only carries on through, as the connector shows it: a
		// node of its two segments, each read whole up to it. Worked out only
		// when asked.
		const through = (nodeId: string) => {
			const pair = k.carried.get(nodeId);
			if (!pair) return null;
			const ends: [Segment, End][] = [
				[pair[0], 'end'],
				[pair[1], 'start']
			];
			const own = new Map<string, RoadGeo>();
			const arms = ends.map(([s, end]) => {
				const curve = k.segs.get(s.id)!.curve;
				const road = roadOf(s, curve, 0, 0);
				own.set(s.id, { road, path: samplePath(road) });
				return armOf(s, curve, end);
			});
			const stored = graph.nodes.get(nodeId)?.junction;
			const junction = junctionOf(nodeId, arms, stored, own, pieceCurves, [[arms[0]], [arms[1]]]);
			return { junction, geos: own };
		};
		return {
			place,
			geos: k.geos,
			junctions: k.seen,
			crossings: k.crossings,
			spans: k.spans,
			units: k.units,
			ends: k.fixed,
			through,
			sidewalks: new Map()
		};
	}
}

// What was written to a graph since its last build (Graph.changesSince): the
// ids of the nodes and segments written, made or removed, and whether its
// segments were put in another order.
export interface Changes {
	nodes: ReadonlySet<string>;
	segments: ReadonlySet<string>;
	reordered: boolean;
}

// Where each node and segment stands in its graph's order (Graph.nodeRank,
// Graph.segmentRank): the order roads, junctions and crossings are listed
// in, whatever order a graph's maps were filled in.
export interface Order {
	node(id: string): number | undefined;
	segment(id: string): number | undefined;
}

// The order of a graph's nodes and segments as its maps list them.
function orderOf(graph: GraphView): Order {
	const nodes = new Map([...graph.nodes.keys()].map((id, i) => [id, i]));
	const segments = new Map([...graph.segments.keys()].map((id, i) => [id, i]));
	return { node: (id) => nodes.get(id), segment: (id) => segments.get(id) };
}

// How many nodes and segments the car build reads, each once for each
// stage that reads it (PlaceBuilder.model), counted only while a test turns
// counting on (`on`): with it off nothing is written.
export const visited = { on: false, nodes: 0, segments: 0 };

// A segment as the last build read it: its nodes, its curve (as drawn), the
// curve's key and the slots its ends attached at an edge are kept in
// (PlaceBuilder.attached).
type SegRead = { ends: [string, string]; curve: Curve; key: string; slots: string[] };

// What the last build read of each node, segment and road (PlaceBuilder.model).
class Kept {
	segs = new Map<string, SegRead>();
	// The roads attached at an edge at each node and the segments each is
	// placed from, each segment's readers so, and how many of each node's
	// roads each segment places.
	placedBy = new Map<string, { id: string; read: string[] }[]>();
	readBy = new Map<string, Set<string>>();
	placedCount = new Map<string, Map<string, number>>();
	// The two segments at each node a road only carries on through
	// (carriedOn), and those it still carries a road on through once loops
	// are parted (roadThrough).
	pairs = new Map<string, readonly [Segment, Segment]>();
	carried = new Map<string, readonly [Segment, Segment]>();
	// Each segment of a road of more than one: the road and how far along
	// it the segment starts; each such road, by its first segment's id.
	along = new Map<string, { id: string; at: number }>();
	joined = new Map<string, { unit: RoadUnit; pieces: Segment[]; curve: Curve; key: string }>();
	units: Derived['units'] = new Map();
	// Each node's road ends and their cross-sections' keys, those of a node
	// two or more roads end at, its stored edits renamed by road, its sides,
	// and a junction's automatic setbacks (by node, by road end, and the node
	// that set each: a road's end may be another node's by the next build).
	endsHere = new Map<string, Arm[]>();
	sectionsAt = new Map<string, string[]>();
	armsAt = new Map<string, Arm[]>();
	renames = new Map<string, Map<string, string>>();
	renamedAt = new Map<string, JunctionData | undefined>();
	links = new Map<string, [Arm[], Arm[]]>();
	autoAt = new Map<string, [string, number][]>();
	auto = new Map<string, number>();
	autoBy = new Map<string, string>();
	// Each node of two sides' junction and taper (PlaceBuilder.linkOf), and
	// the least it takes of each side (null where it may take more).
	linkData = new Map<string, LinkRead>();
	leasts = new Map<string, (number | null)[]>();
	// Each road end's setback as it ends up, the road ends each node sets
	// and the node that set each, and the roads a node of two sides takes
	// past their paint room.
	trims = new Map<string, number>();
	trimsAt = new Map<string, string[]>();
	trimsBy = new Map<string, string>();
	paintBy = new Map<string, Set<string>>();
	// Each road's shape's number, its span along each of its segments, the
	// road as drawn, and the roads by id with their sampled paths.
	shapeKeys = new Map<string, string>();
	spans: Derived['spans'] = new Map();
	roads = new Map<string, Road>();
	geos: Derived['geos'] = new Map();
	roadOrder: string[] = [];
	// Every road end at each node; each node's junction as drawn and as the
	// editor sees it, and its key.
	fixed: Derived['ends'] = new Map();
	junctions = new Map<string, Junction>();
	seen: Derived['junctions'] = new Map();
	junctionKeys = new Map<string, string>();
	// Each node's crossings, those of them it lays on a road, and the nodes
	// laying crossings on each road.
	crossings: Derived['crossings'] = new Map();
	laid = new Map<string, { road: string; at: number; lanes: [string, string] }[]>();
	holdersOn = new Map<string, Set<string>>();
	// The junctions merged with each (themselves at least), the roads merged
	// away, each group as drawn by its first node, each node's group and the
	// groups in order.
	clusterOf = new Map<
		string,
		{ members: string[]; groups: (Junction & { members: string[] })[]; hidden: string[] }
	>();
	hidden = new Set<string>();
	drawn = new Map<string, DrawnJunction>();
	groupOf = new Map<string, string>();
	drawnOrder: string[] = [];
}

const sameAll = (a: unknown[], b: unknown[]) =>
	a.length === b.length && a.every((v, k) => Object.is(v, b[k]));

// A junction with every road end named afresh (`name`, by road and end).
function renamed(j: Junction, name: (road: string, end: End) => string): Junction {
	const ref = <T extends { road: string; end: End }>(r: T) => ({ ...r, road: name(r.road, r.end) });
	const key = (k: string) => {
		const at = k.lastIndexOf(':');
		const end: End = k.slice(at + 1) === 'start' ? 'start' : 'end';
		return `${name(k.slice(0, at), end)}:${end}`;
	};
	const keyed = <T>(record: Record<string, T>) =>
		Object.fromEntries(Object.entries(record).map(([k, v]) => [key(k), v]));
	return {
		...j,
		ends: j.ends.map(ref),
		connections: j.connections.map((c) => ({
			...c,
			from: ref(c.from),
			to: ref(c.to),
			...(c.via ? { via: c.via.map(ref) } : {})
		})),
		walkways: j.walkways.map((w) => ({ ...w, a: ref(w.a), b: ref(w.b) })),
		control: keyed(j.control),
		...(j.sides ? { sides: j.sides.map(key) } : {}),
		...(j.anchors ? { anchors: keyed(j.anchors) } : {}),
		...(j.link ? { link: [j.link[0].map(key), j.link[1].map(key)] } : {})
	};
}
