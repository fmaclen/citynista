// Where the car traffic meeting a crossing is held: the line it stops or
// gives way at, the lanes that line lies across, and the ground cleared of
// paint from the line up to the crossing. Decided here, once for each
// crossing and the traffic meeting it, from the whole crossing and the whole
// way that traffic drives (whatever roads, nodes of two sides and junctions
// it runs over), and handed to the pieces as their shares (`Share`): each
// road and node draws the lines that fall on it and clears, of every kind of
// paint it lays (lane and edge lines, hatching, arrows), whatever of the
// cleared ground lies on it. No piece decides whether a line exists or where.
//
// The rule, for a crossing laid over the car roads (overlay.ts) and each
// stream of traffic meeting it (the car lanes of the carriageway it lies
// across running one way, `holdsGoing`, and the paths across nodes of two
// sides that join them):
//
// - The stream meets the crossing where the first of its lanes does, read
//   along the traffic (its edge, `entry`). Its line stands signBack behind
//   that, square to the traffic there, across every lane of the stream whose
//   traffic meets the crossing, on whichever piece that falls (lineAt).
// - The paint of the stream's carriageway (the lanes between the walkways
//   either side of its lanes, as a junction's approach stops the paint of
//   its whole road; across a node of two sides, of both its roads) is
//   cleared from STOP_ROOM behind the edge up to the crossings the line
//   stands for, on every row of the carriageway one lies ahead on, and no
//   further than they reach across the stream's lanes at a slant (shortOf),
//   and along each path of the stream across a node of two sides up to
//   where its own ground meets them (shortAlong; clearing, crossingHolds).
// - It needs signRoom behind the edge, on ground the traffic drives (not
//   past where its road leaves a junction or ends free) and clear of every
//   other crossing on the stream's lanes. Two crossings are two crossings,
//   each with its own line, unless their ground on those lanes overlaps, or
//   leaves no room for a line between them: then the one the traffic meets
//   first (of two met at once, one holding all its lanes) stands its line
//   for both, and the other has none of its own. A piece's own crossing (a crosswalk, a junction's
//   walkway, a sidewalk a node of two sides carries across) holds no
//   traffic: it takes the room only where it lies under the line, on the
//   ground the line would paint.
// - Near a junction the traffic runs into, the junction's approach may take
//   the crossing as its own (`approachPlans`), where its road has room for
//   the line: its line stands behind it, as one line with the junction's own
//   control (`ApproachPlan.rows`), clearing its road up to it, and the
//   stream has no other.

import {
	approachSetback,
	ARROW_BACK,
	backAlong,
	CROSSING_DEPTH,
	CROSSING_TO_STOP,
	crossingsBack,
	crosswalkOf,
	incomingAt,
	setbackPast,
	signBack,
	signRoom,
	STOP_ROOM
} from './approach';
import { ARROW_LENGTH } from './arrows';
import { area, fromPath, intersect, offset, type Path, type Paths, toPath, union } from './clip';
import type { Sign } from './description';
import { band, type Curve, type EndInfo, type LaneEnd, type RoadGeo } from './ends';
import {
	crossSection,
	stretchOver,
	stripNear,
	stripOf,
	dist,
	dot,
	frameAt,
	hullOf,
	neg,
	offsetPoint,
	type PathSample,
	project
} from './geometry';
import { type Box, boxOf, type Crossed, holdsGoing, holdsLane, overlap } from './overlay';
import {
	type Control,
	isRoadway,
	isWalk,
	type Junction,
	type Lane,
	type LaneRef,
	type Pt,
	strongest
} from './model';
import { LINE, STOP_LINE } from './paint';

// A piece's share of the decisions: the lines it draws, and the ground its
// paint stops at for them.
export interface Share {
	signs: Sign[];
	cleared: Paths;
}
export type Shares = Map<string, Share>;

export function addShare(into: Shares, piece: string, share: Partial<Share>) {
	const known = into.get(piece) ?? { signs: [], cleared: [] };
	known.signs.push(...(share.signs ?? []));
	known.cleared.push(...(share.cleared ?? []));
	into.set(piece, known);
}

// A path across a node of two sides, from the lane coming in to the lane it
// goes on in.
export interface Way {
	curve: Curve;
	fromEnd: EndInfo;
	toEnd: EndInfo;
}

// What the decision reads of a node of two sides: its car paths (`ways`),
// and every path across it of a roadway lane, car lanes and hatching
// (`roadway`), whose ground a line's clearing covers.
export interface SidesView {
	kind: 'sides';
	id: string;
	ways: Way[];
	roadway: Way[];
}

// What the decision reads of the car network (core's drawing of it): the
// roads, the node at a road end (by end key) and what a node of two sides is,
// the crossings laid over a piece near a box, the bodies of a node's own crossings (a
// junction's walkways over its roads' mouths, a sidewalk a node of two sides
// carries across), how far back the node at a road end stops its paint with
// nothing laid over it (null at a free end; `carried` where the road's lanes
// carry on across it), and which crossings each junction's approach takes
// as its own (ApproachPlan.takes), by end key.
export interface Net {
	geo(road: string): RoadGeo | undefined;
	sides(node: string): SidesView | undefined;
	at(end: string): string | undefined;
	laid(piece: string, near: Box): Crossed[];
	own(node: string): Pt[][];
	stop(end: string): { paint: number; carried: boolean } | null;
	takes(end: string): Set<Crossed> | undefined;
}

type Dir = 'fwd' | 'back';
type Held = Extract<Sign, { kind: 'stop' | 'yield' }>;
// A crossing named by what it lies across and where its control stands,
// to tell apart two the traffic meets at once.
const nameOf = (c: Crossed) =>
	`${c.across?.roads.join(',') ?? ''}|${c.control?.at.x ?? 0},${c.control?.at.y ?? 0}`;
const upEnd = (d: Dir) => (d === 'fwd' ? 'start' : 'end');
const downEnd = (d: Dir) => (d === 'fwd' ? 'end' : 'start');
// The way traffic runs along a road heading into one of its ends.
const into = (end: EndInfo): Dir => (end.ref.end === 'end' ? 'fwd' : 'back');

// A polyline as a path to read distances along.
export function pathOf(pts: Pt[]): PathSample {
	const s = [0];
	for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i - 1], pts[i]));
	return { pts, s, length: s[s.length - 1] };
}

// The ground along a path from one distance to another, as wide as its
// widths and a line's width more.
export function stripAlong(route: PathSample, widths: number[], from: number, to: number) {
	const at = [from, ...route.s.filter((s) => s > from && s < to), to];
	const side = (sign: number) =>
		at.map((d) => {
			const f = frameAt(route, d);
			const i = Math.max(
				0,
				route.s.findIndex((s) => s >= d)
			);
			return offsetPoint(f.p, f.n, sign * (widths[i] / 2 + LINE));
		});
	return [...side(-1), ...side(1).reverse()];
}

// The ground between a line and the crossing it stands for, read as a
// stretch of road or path (`zone`) from behind the line to as far as the
// crossing (`rings`) reaches across it: of that, only what lies short of
// the crossing the way traffic drives (`ahead`), as far back as `far` (the
// crossing swept back up the traffic). So at a slant, nothing past the
// crossing beside it is cleared, nor anything on a row of the road the
// crossing lies behind the line on or does not reach.
// The crossing is read a little grown (SHORT_EDGE), so the lines along the
// edges of the road it reaches are read as rows it reaches.
const SHORT_EDGE = 0.6;
export function shortOf(zone: Paths, rings: Paths, ahead: Pt, far: number): Paths {
	if (!rings.length) return [];
	const short = rings.map((ring) => {
		const pts = fromPath(ring);
		const grown = offset([ring], SHORT_EDGE).flatMap(fromPath);
		return toPath(hullOf([...grown, ...pts.map((p) => offsetPoint(p, ahead, -far))]));
	});
	return intersect(zone, union(short));
}

// The ground along a car path, a line's width beyond its edges, from `from`
// along it up to a crossing (`rings`), read along the path itself: as far
// on as the crossing reaches across it at a slant, less what lies past the
// crossing the way the path heads where it first meets it (shortOf). So
// where paths fan out or curve (a widening, a turn), each is cleared up to
// where its own ground meets the crossing, its edges too. None where the
// path doesn't meet it.
function shortAlong(curve: Curve, from: number, rings: Paths): Paths {
	const { route } = wayOf(curve);
	const ground = wayNear(curve, rings);
	if (!ground.length) return [];
	const on = intersect(rings, [ground])
		.filter((p) => Math.abs(area(p)) > 1e-4)
		.flatMap(fromPath)
		.map((p) => project(route, p).s);
	if (!on.length) return [];
	const [s0, s1] = [Math.min(...on), Math.min(route.length, Math.max(...on))];
	from = Math.max(0, from);
	if (s1 - from < 0.05) return [];
	const strip = toPath(stripAlong(route, curve.widths, from, s1));
	return shortOf([strip], rings, frameAt(route, s0).t, s1 - from + 1);
}

// A road between lane edges k0 and k1 (lane k lies between edges k and
// k + 1) from one distance along it to another.
export function roadBand(geo: RoadGeo, k0: number, k1: number, from: number, to: number): Path {
	const [left, right] = bandEdges(geo, k0, k1, from, to);
	return toPath([...left, ...right.reverse()]);
}

// The two edges of that band: each edge's points at `from`, at every point
// of the road's path between, and at `to`.
function bandEdges(geo: RoadGeo, k0: number, k1: number, from: number, to: number) {
	const { road, path } = geo;
	[from, to] = [Math.max(0, from), Math.min(path.length, to)];
	// The path's points lying more than a hair inside from and to.
	const [i0, i1] = [firstPast(path.s, from + 1e-6), firstPast(path.s, to - 1e-6, true)];
	const at = [from, ...path.s.slice(i0, i1), to];
	const edge = (k: number) =>
		at.map((d) => {
			const f = frameAt(path, d);
			const spans = crossSection(road, d);
			return offsetPoint(f.p, f.n, k < spans.length ? spans[k].left : spans[k - 1].right);
		});
	return [edge(k0), edge(k1)] as const;
}

// The first of some distances in order past `d` (or, `atOrPast`, at or past
// it), or as many as there are.
function firstPast(s: number[], d: number, atOrPast = false) {
	let [lo, hi] = [0, s.length];
	while (lo < hi) {
		const m = (lo + hi) >> 1;
		if (s[m] < d || (!atOrPast && s[m] === d)) lo = m + 1;
		else hi = m;
	}
	return lo;
}

// A road's carriageway round lanes k0 to k1: the lanes between the walkways
// either side of them, as the edges bounding them (lane k lies between edges
// k and k + 1). The paint a line for a crossing clears is its carriageway's,
// as a junction's approach stops the paint of its whole road: on a street
// with a walkway down its middle, nothing of the other carriageway.
export function carriagewayOf(lanes: Lane[], k0: number, k1: number) {
	while (k0 > 0 && !isWalk(lanes[k0 - 1])) k0--;
	while (k1 + 1 < lanes.length && !isWalk(lanes[k1 + 1])) k1++;
	return [k0, k1 + 1] as const;
}

// The roadway of a road's carriageway (its roadway lanes between edges k0
// and k1) from one distance along it to another.
export function carriagewayBand(geo: RoadGeo, k0: number, k1: number, from: number, to: number) {
	if (to - from < 1e-6) return [];
	const lanes = geo.road.lanes;
	const out: Paths = [];
	for (let k = k0; k < k1; k++)
		if (isRoadway(lanes[k])) out.push(roadBand(geo, k, k + 1, from, to));
	return out.length > 1 ? union(out) : out;
}

// A lane's ground on a road near some rings (stripNear), or nothing where
// the road has no such lane.
function laneNear(geo: RoadGeo, lane: string, rings: Paths): Path {
	const k = geo.road.lanes.findIndex((l) => l.id === lane);
	if (k < 0) return [];
	const edges = () => bandEdges(geo, k, k + 1, 0, geo.path.length);
	return stripNear(stripOf(geo.path, `lane ${lane}`, edges), rings);
}
// Each path's ground and route, kept with it, and the strip a line's width
// wider than it that a line run across it clears (`strip`, clearing), with
// the box round it, made the first time it is asked for.
type WayGround = {
	ground: Path;
	route: PathSample;
	box: Box;
	strip?: { path: Path; box: Box };
};
const wayGrounds = new WeakMap<Curve, WayGround>();
function wayOf(curve: Curve) {
	let known = wayGrounds.get(curve);
	if (!known) {
		const ground = band(curve).path;
		known = { ground, route: pathOf(curve.points), box: boxOf(fromPath(ground)) };
		wayGrounds.set(curve, known);
	}
	return known;
}
function wayStrip(curve: Curve) {
	const way = wayOf(curve);
	if (!way.strip) {
		const path = toPath(stripAlong(way.route, curve.widths, 0, way.route.length));
		way.strip = { path, box: boxOf(fromPath(path)) };
	}
	return way.strip;
}

// A path's ground across a node of two sides where its box meets the box
// round some rings, or nothing: a crossing reads only the paths near it.
function wayNear(curve: Curve, rings: Paths): Path {
	const way = wayOf(curve);
	return overlap(way.box, boxOf(rings.flatMap(fromPath))) ? way.ground : [];
}

// One piece of a lane's way, in the stream's own measure along the traffic
// (`u`, metres): a lane of a road, `u = o` where the traffic enters it, or a
// path across a node of two sides, `u = o` at its start.
type Leg =
	| { kind: 'road'; piece: string; geo: RoadGeo; lane: string; dir: Dir; o: number; length: number }
	| { kind: 'way'; piece: string; way: Way; o: number; length: number };

const legU = (leg: Leg, p: Pt) => {
	if (leg.kind === 'way') return leg.o + project(wayOf(leg.way.curve).route, p).s;
	const s = project(leg.geo.path, p).s;
	return leg.o + (leg.dir === 'fwd' ? s : leg.length - s);
};
// The distance along a road leg's road at `u`.
const legS = (leg: Extract<Leg, { kind: 'road' }>, u: number) =>
	leg.dir === 'fwd' ? u - leg.o : leg.length - (u - leg.o);

// Where along a leg some ground lies, in u: from and to, or null. Read on
// the leg's whole ground, or (`painted`) on the ground a line across it
// paints, LINE_INSET short of either edge.
const LINE_INSET = 0.15;
const insetGrounds = new WeakMap<Path, Path[]>();
function spanOn(leg: Leg, rings: Paths, painted = false): [number, number] | null {
	const ground =
		leg.kind === 'road' ? laneNear(leg.geo, leg.lane, rings) : wayNear(leg.way.curve, rings);
	if (!ground.length) return null;
	let grounds = [ground];
	if (painted) {
		let inner = insetGrounds.get(ground);
		if (!inner) insetGrounds.set(ground, (inner = offset([ground], -LINE_INSET)));
		grounds = inner;
		if (!grounds.length) return null;
	}
	const us = intersect(rings, grounds)
		.filter((p) => Math.abs(area(p)) > 1e-4)
		.flatMap(fromPath)
		.map((p) => legU(leg, p));
	return us.length ? [Math.min(...us), Math.max(...us)] : null;
}

// A lane's way through the stream: its legs in driving order.
type LaneWay = Leg[];
const spanAlong = (lw: LaneWay, rings: Paths, painted = false) => {
	let out: [number, number] | null = null;
	for (const leg of lw) {
		const on = spanOn(leg, rings, painted);
		if (on) out = out ? [Math.min(out[0], on[0]), Math.max(out[1], on[1])] : on;
	}
	return out;
};
// The leg at u; where a road and a path across a node meet, the road.
const legAt = (lw: LaneWay, u: number) => {
	const at = lw.filter((leg) => u >= leg.o - 1e-6 && u <= leg.o + leg.length + 1e-6);
	return at.find((leg) => leg.kind === 'road') ?? at[0];
};

// The box round the ground of some lane ways from u0 to u1 along them.
function stretchBox(lws: LaneWay[], u0: number, u1: number): Box {
	const pts = lws.flatMap((lw) =>
		lw.flatMap((leg) => {
			const [a, b] = [Math.max(u0, leg.o), Math.min(u1, leg.o + leg.length)];
			if (b < a) return [];
			if (leg.kind === 'way') {
				const { curve } = leg.way;
				return stripAlong(wayOf(curve).route, curve.widths, a - leg.o, b - leg.o);
			}
			const k = leg.geo.road.lanes.findIndex((l) => l.id === leg.lane);
			const [s0, s1] = [legS(leg, a), legS(leg, b)].sort((x, y) => x - y);
			return fromPath(roadBand(leg.geo, k, k + 1, s0, s1));
		})
	);
	return boxOf(pts);
}

// The tangent the traffic runs along a leg at u.
function aheadOn(leg: Leg, u: number) {
	if (leg.kind === 'way') return frameAt(wayOf(leg.way.curve).route, u - leg.o).t;
	const t = frameAt(leg.geo.path, legS(leg, u)).t;
	return leg.dir === 'fwd' ? t : neg(t);
}

// The lane ways of the stream read on road `id` heading `dir`: each lane of
// it the crossing holds, with the path across a node of two sides leading
// into it at its start and those leading on from it at its end, and the
// lane of the road each of those leads on in.
function laneWays(c: Crossed, id: string, dir: Dir, net: Net, pieces: Set<string>): LaneWay[] {
	const geo = net.geo(id)!;
	const length = geo.path.length;
	const held = geo.road.lanes.filter(holdsGoing(c, id, dir));
	// Only as far as the pieces the crossing is drawn on.
	const node = (end: string) => {
		const n = net.at(`${id}:${end}`);
		return n && pieces.has(n) ? net.sides(n) : undefined;
	};
	const before = node(upEnd(dir));
	const after = node(downEnd(dir));
	const out: LaneWay[] = [];
	for (const lane of held) {
		const own: Leg = { kind: 'road', piece: id, geo, lane: lane.id, dir, o: 0, length };
		const ups = (before?.ways ?? []).flatMap((way): Leg[][] => {
			if (way.toEnd.key !== `${id}:${upEnd(dir)}` || way.curve.to.ref.lane !== lane.id) return [];
			const from = pieces.has(way.fromEnd.ref.road) ? net.geo(way.fromEnd.ref.road) : undefined;
			if (!from) return [];
			const w = wayOf(way.curve).route.length;
			return [
				[
					{
						kind: 'road',
						piece: way.fromEnd.ref.road,
						geo: from,
						lane: way.curve.from.ref.lane,
						dir: into(way.fromEnd),
						o: -w - from.path.length,
						length: from.path.length
					},
					{ kind: 'way', piece: before!.id, way, o: -w, length: w }
				]
			];
		});
		const downs = (after?.ways ?? []).flatMap((way): Leg[][] => {
			if (way.fromEnd.key !== `${id}:${downEnd(dir)}` || way.curve.from.ref.lane !== lane.id)
				return [];
			if (!holdsLane(c, way.toEnd.ref.road, way.curve.to.ref.lane)) return [];
			const to = pieces.has(way.toEnd.ref.road) ? net.geo(way.toEnd.ref.road) : undefined;
			const w = wayOf(way.curve).route.length;
			const legs: Leg[] = [{ kind: 'way', piece: after!.id, way, o: length, length: w }];
			if (to)
				legs.push({
					kind: 'road',
					piece: way.toEnd.ref.road,
					geo: to,
					lane: way.curve.to.ref.lane,
					dir: way.toEnd.ref.end === 'start' ? 'fwd' : 'back',
					o: length + w,
					length: to.path.length
				});
			return [legs];
		});
		for (const up of ups.length ? ups : [[]])
			for (const down of downs.length ? downs : [[]]) out.push([...up, own, ...down]);
	}
	return out;
}

// The streams a crossing meets, each read on the road the traffic is on
// where it first meets the crossing (a path across a node of two sides
// read on the road coming in): a road and the way its traffic runs. One read
// on a road whose traffic comes across a node of two sides from another the
// crossing lies over too is that one's.
function streamsOf(c: Crossed, pieces: string[], net: Net) {
	const found = new Map<string, { id: string; dir: Dir }>();
	for (const id of pieces) {
		const geo = net.geo(id);
		if (geo) {
			for (const dir of ['fwd', 'back'] as const) {
				const keep = holdsGoing(c, id, dir);
				const ground = geo.road.lanes
					.filter(keep)
					.map((l) => laneNear(geo, l.id, c.rings))
					.filter((g) => g.length);
				if (ground.length && intersect(c.rings, union(ground)).length)
					found.set(`${id}|${dir}`, { id, dir });
			}
			continue;
		}
		for (const way of net.sides(id)?.ways ?? []) {
			const a = way.fromEnd.ref.road;
			if (
				!net.geo(a) ||
				!holdsLane(c, a, way.curve.from.ref.lane) ||
				!holdsLane(c, way.toEnd.ref.road, way.curve.to.ref.lane)
			)
				continue;
			const ground = wayNear(way.curve, c.rings);
			const on = ground.length ? intersect(c.rings, [ground]) : [];
			if (on.reduce((t, p) => t + Math.abs(area(p)), 0) > 0.05)
				found.set(`${a}|${into(way.fromEnd)}`, { id: a, dir: into(way.fromEnd) });
		}
	}
	// Each one fed across a node of two sides by another found is that one's.
	const feeder = (s: { id: string; dir: Dir }) => {
		const n = net.at(`${s.id}:${upEnd(s.dir)}`);
		const view = n ? net.sides(n) : undefined;
		for (const way of view?.ways ?? [])
			if (way.toEnd.key === `${s.id}:${upEnd(s.dir)}`) {
				const k = `${way.fromEnd.ref.road}|${into(way.fromEnd)}`;
				if (found.has(k)) return k;
			}
		return null;
	};
	const roots = new Map<string, { id: string; dir: Dir }>();
	for (const [k, s] of found) {
		let key = k;
		const seen = new Set([k]);
		for (let up = feeder(s); up && !seen.has(up); up = feeder(found.get(key)!)) {
			seen.add(up);
			key = up;
		}
		roots.set(key, found.get(key)!);
	}
	return [...roots.values()];
}

// The lines a crossing laid over the car roads puts across the traffic
// meeting it, and the ground they clear, by the piece each falls on
// (`pieces`, the car pieces it is drawn on: Crossed.on).
export function crossingHolds(c: Crossed, pieces: string[], net: Net): Shares {
	const out: Shares = new Map();
	const kind = c.control?.kind ?? 'none';
	if (!c.traffic || kind === 'none') return out;
	const on = new Set(pieces);
	for (const { id, dir } of streamsOf(c, pieces, net)) {
		const ways = laneWays(c, id, dir, net, on);
		const hits = ways.map((lw) => spanAlong(lw, c.rings));
		const meeting = ways.filter((_, i) => hits[i]);
		if (!meeting.length) continue;
		// A junction the traffic runs into that takes it as its approach's own.
		const ends = new Set(
			ways.flatMap((lw) =>
				lw.flatMap((leg) => (leg.kind === 'road' ? [`${leg.piece}:${downEnd(leg.dir)}`] : []))
			)
		);
		if ([...ends].some((e) => net.takes(e)?.has(c))) continue;
		const room = signRoom(kind);
		const legs = ways.flat();
		const spans = hits.filter((s) => s !== null);
		const entry = Math.min(...spans.map((s) => s[0]));
		const far = Math.max(...spans.map((s) => s[1]));
		// The other crossings that bear on it: on its pieces, lying on the
		// stream's lanes from its room behind it up to as far as it reaches
		// (where any that laps it or stands in its room lies).
		const stretch = stretchBox(meeting, entry - room - 0.1, far + 0.1);
		const others = [
			...new Set(
				legs.flatMap((leg) => net.laid(leg.piece, stretch)).filter((x) => x !== c && x.traffic)
			)
		];
		// The traffic meets another first where their ground on its lanes
		// overlaps: that one's line stands for both, and this one's stands
		// for those it meets first (`mates`), clearing the ground up to them
		// too. Of two met at once (a footpath read as crossing two roads
		// there), one holding all the stream's lanes (holdsLane: not one of
		// the other carriageway) stands it, then the one named first.
		const firstOf = (x: Crossed) =>
			Math.min(...ways.flatMap((lw) => spanAlong(lw, x.rings)?.[0] ?? []));
		const rank = (x: Crossed) => [
			meeting.every((lw) =>
				lw.every((leg) => leg.kind !== 'road' || holdsLane(x, leg.piece, leg.lane))
			)
				? 0
				: 1,
			nameOf(x)
		];
		const before = (x: Crossed) => {
			const [a, b] = [rank(x), rank(c)];
			return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
		};
		let held = false;
		let blocked = false;
		const mates: Paths = [];
		for (const x of others) {
			const on = meeting.map((lw) => spanAlong(lw, x.rings));
			const laps = on.some((s, i) => s && s[0] <= spans[i][1] + 0.05 && s[1] >= spans[i][0] - 0.05);
			if (laps) {
				const first = firstOf(x);
				if (first < entry - 1e-6 || (first <= entry + 1e-6 && before(x))) held = true;
				else mates.push(...x.rings);
				continue;
			}
			if (on.some((s) => s && s[1] > entry - room && s[0] < entry)) blocked = true;
		}
		// The pieces' own crossings (a road's crosswalk, over the lanes
		// between the walkways it joins alone, a junction's walkway over a
		// road's mouth, a sidewalk a node of two sides carries across) hold no
		// traffic: they block it where they lie under its line, on the ground
		// the line would paint (each lane short of its edges, from its room
		// behind the edge up to its front), wherever else they lie. Lying
		// between the line and the crossing, lapping it or ahead of it, they
		// leave it be.
		const ownRings = [
			...new Set(
				legs.flatMap((leg) =>
					leg.kind === 'way'
						? [leg.piece]
						: (['start', 'end'] as const).flatMap((end) => net.at(`${leg.piece}:${end}`) ?? [])
				)
			)
		].flatMap((n) => net.own(n).map(toPath));
		const roadOwn = [
			...new Set(legs.flatMap((leg) => (leg.kind === 'road' ? [leg.geo] : [])))
		].flatMap((geo) =>
			(geo.road.crossings ?? []).flatMap((x) => {
				const at = crosswalkOf(geo.road, geo.path.length, x);
				if (!at) return [];
				const { d, k0, k1 } = at;
				return [roadBand(geo, k0, k1, d - CROSSING_DEPTH / 2, d + CROSSING_DEPTH / 2)];
			})
		);
		const front = entry - signBack(kind) + (kind === 'yield' ? 0 : STOP_LINE / 2);
		for (const ring of [...ownRings, ...roadOwn]) {
			const on = meeting.map((lw) => spanAlong(lw, [ring], true));
			if (on.some((s) => s && s[1] > entry - room && s[0] < front)) blocked = true;
		}
		if (held || blocked) continue;
		// It stands on the first lane to meet the crossing, or, where that
		// lane starts too late (a lane a node of two sides begins), on
		// another of the stream's that runs back there.
		const at = entry - signBack(kind);
		const first = meeting[spans.findIndex((s) => s[0] === entry)];
		const placer = [first, ...meeting].find((lw) => legAt(lw, at));
		if (!placer) continue;
		// Its room lies on ground the traffic drives: not past where its road
		// leaves a junction that stops its paint there, nor off a free end.
		const start = placer[0];
		if (start.kind === 'road') {
			const back = `${start.piece}:${upEnd(start.dir)}`;
			const node = net.at(back);
			const stop = node && net.sides(node) ? { paint: 0, carried: true } : net.stop(back);
			const limit = start.o + (stop?.paint ?? 0);
			if (entry - room < limit && !(stop?.carried && stop.paint === 0)) continue;
		}
		const leg = legAt(placer, at)!;
		const line = lineAt(leg, at, meeting, kind);
		if (!line) continue;
		const { sign } = line;
		addShare(out, leg.piece, { signs: [sign] });
		// What it clears, on every piece of the stream, up to every crossing
		// it stands for.
		const rings = mates.length ? [...c.rings, ...mates] : c.rings;
		const reach = mates.length
			? Math.max(far, ...meeting.flatMap((lw) => spanAlong(lw, rings)?.[1] ?? []))
			: far;
		const ahead = aheadOn(legAt(first, entry) ?? leg, entry);
		const zone = clearing(
			ways,
			entry - STOP_ROOM,
			Math.max(entry + 0.05, reach),
			{
				sign,
				ahead: line.ahead,
				back: signBack(kind) - STOP_ROOM,
				front: Math.max(entry + 0.05, reach) - at
			},
			net
		);
		const short = shortOf(zone, rings, ahead, 2 * (reach - entry) + STOP_ROOM + 1);
		// Across a node of two sides the lanes meeting it may curve away
		// from the way the traffic heads at the line (a widening): along each
		// such path, from the line up to the crossing (shortAlong).
		const along = meeting.flatMap((lw) =>
			lw.flatMap((leg) =>
				leg.kind === 'way' ? shortAlong(leg.way.curve, entry - STOP_ROOM - leg.o, rings) : []
			)
		);
		const cleared = along.length ? union([...short, ...along]) : short;
		if (cleared.length)
			for (const piece of new Set(legs.map((l) => l.piece))) addShare(out, piece, { cleared });
	}
	return out;
}

// The line across the stream at `u` on a leg: across the lanes of the road
// it lies on whose traffic meets the crossing (`meeting`), square to the
// road; or on a node of two sides, across every path there whose traffic
// meets it, square to the way they run taken together.
function lineAt(leg: Leg, u: number, meeting: LaneWay[], kind: 'yield' | 'stop' | 'signal') {
	let place: { p: Pt; n: Pt; left: number; right: number; ahead: Pt; lanes: LaneRef[] };
	if (leg.kind === 'road') {
		const d = legS(leg, u);
		const ids = new Set(
			meeting.flatMap((lw) => {
				const l = legAt(lw, u);
				return l?.kind === 'road' && l.piece === leg.piece ? [l.lane] : [];
			})
		);
		const spans = crossSection(leg.geo.road, d).filter((sp) => ids.has(sp.lane.id));
		if (!spans.length) return null;
		const f = frameAt(leg.geo.path, d);
		place = {
			p: f.p,
			n: f.n,
			left: Math.min(...spans.map((sp) => sp.left)),
			right: Math.max(...spans.map((sp) => sp.right)),
			ahead: leg.dir === 'fwd' ? f.t : neg(f.t),
			lanes: spans.map((sp) => ({
				road: leg.piece,
				end: downEnd(leg.dir),
				lane: sp.lane.id
			}))
		};
	} else {
		const here = meeting.flatMap((lw) => {
			const l = legAt(lw, u);
			return l?.kind === 'way' && l.piece === leg.piece ? [l] : [];
		});
		const f = frameAt(wayOf(leg.way.curve).route, u - leg.o);
		const sum = here.reduce(
			(t, l) => {
				const g = frameAt(wayOf(l.way.curve).route, u - l.o);
				return { x: t.x + g.t.x, y: t.y + g.t.y };
			},
			{ x: 0, y: 0 }
		);
		const l = Math.hypot(sum.x, sum.y) || 1;
		const t = { x: sum.x / l, y: sum.y / l };
		const n = { x: -t.y, y: t.x };
		const across = [...new Set(here.map((h) => h.way))].flatMap(({ curve }) => {
			const r = wayOf(curve).route;
			const ahead = r.pts.map((p) => dot({ x: p.x - f.p.x, y: p.y - f.p.y }, t));
			const i = ahead.findIndex((d, k) => k > 0 && ahead[k - 1] <= 0 && d >= 0);
			if (i < 0) return [];
			const v = ahead[i] - ahead[i - 1] > 1e-9 ? -ahead[i - 1] / (ahead[i] - ahead[i - 1]) : 0;
			const x = {
				x: r.pts[i - 1].x + (r.pts[i].x - r.pts[i - 1].x) * v,
				y: r.pts[i - 1].y + (r.pts[i].y - r.pts[i - 1].y) * v
			};
			const o = dot({ x: x.x - f.p.x, y: x.y - f.p.y }, n);
			const w = curve.widths[i - 1] + (curve.widths[i] - curve.widths[i - 1]) * v;
			return [o - w / 2, o + w / 2];
		});
		if (!across.length) return null;
		place = {
			p: f.p,
			n,
			left: Math.min(...across),
			right: Math.max(...across),
			ahead: t,
			lanes: [
				...new Map(
					here.map((h) => [JSON.stringify(h.way.curve.from.ref), h.way.curve.from.ref])
				).values()
			]
		};
	}
	const a = offsetPoint(place.p, place.n, place.left + 0.15);
	const b = offsetPoint(place.p, place.n, place.right - 0.15);
	const sign: Held =
		kind === 'yield'
			? { kind: 'yield', lanes: place.lanes, a, b, toward: neg(place.ahead) }
			: { kind: 'stop', lanes: place.lanes, a, b };
	return { sign, ahead: place.ahead };
}

// The ground of the stream's carriageway from u0 to u1 along it, on every
// piece it runs over: on a road, the roadway between the walkways either
// side of its lanes, between those distances along it; on a node of two
// sides, every path from or to the lanes of the carriageway of either road
// the stream runs between there (both ways: a street with a walkway down its
// middle meeting a plain one has the plain one's whole roadway for its
// carriageway on that side) of a roadway lane, car lane or hatching, a
// line's width beyond its edges, from `back` behind
// the line (`sign`, its traffic driving `ahead`) to `front` ahead of it, the
// line run on straight across them.
function clearing(
	ways: LaneWay[],
	u0: number,
	u1: number,
	{ sign, ahead, back, front }: { sign: Held; ahead: Pt; back: number; front: number },
	net: Net
): Paths {
	const out: Paths = [];
	const roads = new Map<string, { geo: RoadGeo; lanes: Set<string>; s0: number; s1: number }>();
	const nodes = new Map<string, Set<string>>();
	for (const lw of ways)
		lw.forEach((leg, i) => {
			if (leg.kind === 'way') {
				// The roads either side of the node the stream runs between.
				const sides = nodes.get(leg.piece) ?? new Set();
				for (const side of [lw[i - 1], lw[i + 1]]) if (side?.kind === 'road') sides.add(side.piece);
				nodes.set(leg.piece, sides);
				return;
			}
			const r = roads.get(leg.piece) ?? {
				geo: leg.geo,
				lanes: new Set<string>(),
				s0: Infinity,
				s1: -Infinity
			};
			r.lanes.add(leg.lane);
			const [a, b] = [Math.max(u0, leg.o), Math.min(u1, leg.o + leg.length)];
			if (b > a) {
				const [s0, s1] = [legS(leg, a), legS(leg, b)].sort((x, y) => x - y);
				r.s0 = Math.min(r.s0, s0);
				r.s1 = Math.max(r.s1, s1);
			}
			roads.set(leg.piece, r);
		});
	const carriageway = (geo: RoadGeo, lanes: Set<string>) => {
		const ks = geo.road.lanes.flatMap((l, k) => (lanes.has(l.id) ? [k] : []));
		return carriagewayOf(geo.road.lanes, Math.min(...ks), Math.max(...ks));
	};
	for (const r of roads.values()) {
		if (!(r.s1 > r.s0)) continue;
		const [k0, k1] = carriageway(r.geo, r.lanes);
		out.push(...carriagewayBand(r.geo, k0, k1, r.s0, r.s1));
	}
	const l = dist(sign.a, sign.b) || 1;
	const e = { x: (sign.b.x - sign.a.x) / l, y: (sign.b.y - sign.a.y) / l };
	const W = 40;
	const slab = toPath(
		hullOf(
			[back, front].flatMap((d) => [
				offsetPoint(offsetPoint(sign.a, e, -W), ahead, d),
				offsetPoint(offsetPoint(sign.b, e, W), ahead, d)
			])
		)
	);
	for (const [node, sides] of nodes) {
		const view = net.sides(node);
		if (!view) continue;
		const strips: { path: Path; box: Box }[] = [];
		for (const road of sides) {
			const r = roads.get(road);
			if (!r) continue;
			const [k0, k1] = carriageway(r.geo, r.lanes);
			const inWay = new Set(r.geo.road.lanes.slice(k0, k1).map((l) => l.id));
			for (const way of view.roadway) {
				const from = way.fromEnd.ref.road === road && inWay.has(way.curve.from.ref.lane);
				const to = way.toEnd.ref.road === road && inWay.has(way.curve.to.ref.lane);
				if (!from && !to) continue;
				strips.push(wayStrip(way.curve));
			}
		}
		// Paths whose ground lies off the slab clear nothing.
		const slabBox = boxOf(fromPath(slab));
		if (strips.some((strip) => overlap(strip.box, slabBox)))
			out.push(...intersect(union(strips.map((strip) => strip.path)), [slab]));
	}
	return out.length ? union(out) : [];
}

// What the decision reads of a junction where roads meet: its road ends,
// how deep a walkway of its own lies across each road's mouth
// (`crossDepth`) and, of nodes merged into one, every road end of theirs.
export interface MeetingView {
	kind: 'meeting';
	junction: Junction;
	ends: EndInfo[];
	crossDepth: Map<string, number>;
	parts: EndInfo[];
}

type Back = ReturnType<typeof crossingsBack>[number];

// What a junction's approach does with the crossings laid over its road
// (approachPlans): its control, how far back its road's paint stops
// (`back`), its lines (`rows`, rowsOf), which the painter draws as they
// are, the crossings over its road it takes as its own (`own`),
// where its line stands for crossings, the lanes it holds there and where
// the paint of the others stops (`held`), the approach as a whole up to
// where its signs stand (`whole`, through roads merged away), each lane
// coming in and what holds it there (`by`, `kinds`), where its arrows'
// tails stand (`tail`), and every crossing it stands its line for
// (`takes`), which no stream of traffic stands another for (crossingHolds).
export interface ApproachPlan {
	control: Control;
	back: number;
	rows: Held[];
	own: Back[];
	held?: { lanes: { lane: string; setback: number }[]; bare: number };
	whole: { pieces: EndInfo[]; back: number; own: Back[]; control: Control };
	by: unknown[][];
	kinds: Control[];
	tail: number;
	takes: Set<Crossed>;
}

// Each approach of a junction where roads meet with the ground a network
// laid over its roads crosses (`over`, overlay.ts), and the shares of its
// roads: where each road's paint stops behind a line its approach stands
// for crossings. A junction paints no crossing and clears nothing for one
// (drawJunction in node.ts, onJunction in core/networks.ts): each crossing
// holds its own road's approach alone, and what of it runs on past the
// road's end leaves the junction's lines as they are.
//
// On one approach, in driving order, come its arrows, one line, the
// crossings near the junction, and the junction. A crossing over the
// approach's lanes whose near side lies within its stop room (short of where
// its arrows' tails would stand, behind the line it would have with no
// crossing there), and any crossing too close behind such a one for a line
// to fit between, is the approach's own where the approach has room behind
// it for a line: its line stands behind the last of them, and no stream of
// traffic stands another for them. Each lane coming in is marked on that
// line by the strongest of the approach's own control and those of the
// crossings it takes as its own lying across it (a signal the strongest of
// all), so a crossing of one carriageway of a street with a walkway down its
// middle marks that carriageway's lanes alone. The arrows stand behind the
// line, and behind any crossing further back that would fall on them, and
// the line that one has behind it.
export function approachPlans(view: MeetingView, over: Crossed[] = []) {
	const { junction, ends, crossDepth, parts } = view;
	// Of the crossings over an approach (`pieces`), those it takes as its
	// own, its paint stopping `base` back with none there: each with room
	// behind it on the approach for its line.
	const takenOver = (pieces: EndInfo[], base: number) => {
		const out: Back[] = [];
		let reach = base + ARROW_BACK;
		for (const c of over.length ? crossingsBack(pieces, over) : []) {
			if (c.near >= reach || !backAlong(pieces, c.far + signRoom('yield'))) break;
			out.push(c);
			reach = Math.max(reach, c.far + signRoom('yield'));
		}
		return out;
	};
	// Where the paint of an approach controlled by `control` stops, `base`
	// back with no crossing there: behind each crossing it holds.
	const behind = (control: Control, base: number, own: Back[]) =>
		control === 'none' ? base : Math.max(base, ...own.map((c) => setbackPast(control, c.far)));
	// Of the crossings over an approach's road it takes as its own (`own`),
	// those holding each lane coming in, by the lanes' places among those
	// coming in: each holds the lanes it lies across there (holdsLane), so on
	// a street with a walkway down its middle a crossing of one carriageway
	// holds that carriageway's lanes and nothing of the other's. With how
	// each lane is held: by the strongest of the junction's control and
	// theirs.
	const heldAt = (end: EndInfo, own: Back[]) => {
		const by = incomingAt(end).map((_, k) => own.filter((c) => c.lanes.includes(k)));
		const kinds = by.map((cs) =>
			strongest([junction.control[end.key] ?? 'none', ...cs.map((c) => c.control)])
		);
		return { by, kinds };
	};
	const plans = new Map<string, ApproachPlan>();
	for (const end of ends) {
		const depth = crossDepth.get(end.key);
		const { road, path } = end.geo;
		const base = (control: Control) =>
			approachSetback(control, road, path.length, end.ref.end) + (depth ? depth + 0.3 : 0);
		const own = junction.control[end.key] ?? 'none';
		const mine = takenOver([end], base(own));
		const control = strongest([own, ...mine.map((c) => c.control)]);
		// Where its line stands for crossings, the lanes it stands across,
		// those held by anything (heldAt), stop at it.
		const { kinds: single } = heldAt(end, mine);
		const back = behind(control, base(control), mine);
		const lanes = incomingAt(end).flatMap((l, k) =>
			single[k] === 'none' ? [] : [{ lane: l.ref.lane, setback: back }]
		);
		// The approach as a whole up to where its signs stand: one that goes
		// on into a road merged away stops or gives way where that road meets
		// the next node (Junction.signsAt), across its lanes there, taken in
		// order for its own.
		const via = (junction.signsAt?.[end.key] ?? []).map((k) => parts.find((p) => p.key === k));
		const sited = via.at(-1);
		let whole = { pieces: [end], back, own: mine, control };
		if (
			control !== 'none' &&
			sited &&
			incomingAt(sited).length === incomingAt(end).length &&
			via.every((p) => !!p)
		) {
			const pieces = [end, ...(via as EndInfo[])];
			const base = (c: Control) =>
				approachSetback(c, sited.geo.road, sited.geo.path.length, sited.ref.end);
			const own = takenOver(pieces, base(control));
			const kind = strongest([control, ...own.map((c) => c.control)]);
			whole = { pieces, back: behind(kind, base(kind), own), own, control: kind };
		}
		const { by, kinds } = heldAt(end, whole.own);
		// Each arrow's tail is ARROW_BACK back from where the paint stops, on
		// the approach as a whole; where a crossing over it would fall on the
		// arrows, or the line traffic has behind that crossing (one the
		// approach does not hold), their heads stand a crossing's gap behind it.
		// The traffic running the other way across a crossing of its
		// carriageway has its line beyond the crossing, on this approach's
		// side towards the junction, and clears the carriageway from there
		// (crossingHolds): the arrows stand clear of that too.
		const otherWay = (c: Crossed) => {
			const { road, path } = end.geo;
			const keep = holdsGoing(c, road.id, end.ref.end === 'end' ? 'back' : 'fwd');
			return c.rings.some((ring) => stretchOver(road, path, ring, keep));
		};
		let tail = whole.back + ARROW_BACK;
		if (over.length)
			for (const c of crossingsBack(whole.pieces, over)) {
				const taken = whole.own.some((h) => h.near === c.near && h.far === c.far);
				const room = taken || c.control === 'none' ? 0 : signRoom(c.control);
				const ahead = !taken && c.control !== 'none' && otherWay(c.c) ? STOP_ROOM : 0;
				if (c.near - ahead < tail && c.far + room > tail - ARROW_LENGTH - CROSSING_TO_STOP)
					tail = c.far + room + CROSSING_TO_STOP + ARROW_LENGTH;
			}
		plans.set(end.key, {
			control,
			back,
			rows: rowsOf(whole, by, kinds),
			own: mine,
			...(control !== 'none' && mine.length > 0 && { held: { lanes, bare: base(own) } }),
			whole,
			by,
			kinds,
			tail,
			takes: new Set([...mine.map((b) => b.c), ...whole.own.map((b) => b.c)])
		});
	}
	// The shares: on each road coming in whose line stands for crossings,
	// the roadway of each held lane's carriageway from the line to the end.
	const shares: Shares = new Map();
	for (const end of ends) {
		const plan = plans.get(end.key)!;
		if (!plan.held) continue;
		const { geo } = end;
		const length = geo.path.length;
		const rings = plan.held.lanes.flatMap(({ lane, setback }) => {
			const k = geo.road.lanes.findIndex((l) => l.id === lane);
			if (k < 0) return [];
			const [k0, k1] = carriagewayOf(geo.road.lanes, k, k);
			const paint = Math.max(0.5, setback);
			return end.ref.end === 'start'
				? carriagewayBand(geo, k0, k1, 0, paint)
				: carriagewayBand(geo, k0, k1, length - paint, length);
		});
		if (rings.length) addShare(shares, geo.road.id, { cleared: union(rings) });
	}
	return { plans, shares };
}

// An approach's lines (ApproachPlan.rows): one bar or one row of give-way
// teeth, pointing back up the road, across each run of its lanes coming in
// held alike. Two lanes side by side share one where they are held alike and
// lie on one carriageway, or are held by the same crossings (the approach's
// own control alone, across the whole road as a car road alone draws it, or
// crossings laid over both). The stop line's back edge is where the
// approach's paint stops (`whole.back`), so the lines either side run into
// its ends; the teeth stand half a stop gap short of it (signBack). An
// approach going on into a road merged away stops or gives way where that
// road meets the next node, across the lanes coming in there, taken in order
// for its own (ApproachPlan.whole). A line standing for crossings always has
// its whole depth on the approach (takenOver); one for the approach's own
// control alone, on a road too short for it, stands at the road's far end,
// as a car road alone draws it.
function rowsOf(whole: ApproachPlan['whole'], by: unknown[][], kinds: Control[]) {
	const rows: Held[] = [];
	if (whole.control === 'none') return rows;
	const there = whole.pieces.at(-1)!;
	const own = incomingAt(there);
	const lanesOf = there.geo.road.lanes;
	const placeOf = (l: LaneEnd) => lanesOf.findIndex((x) => x.id === l.ref.lane);
	const apart = (p: LaneEnd, q: LaneEnd) => {
		const [i, j] = [placeOf(p), placeOf(q)].sort((x, y) => x - y);
		return lanesOf.slice(i + 1, j).some(isWalk);
	};
	const alike = (k: number) =>
		kinds[k] === kinds[k - 1] &&
		(!apart(own[k - 1], own[k]) ||
			(by[k].length === by[k - 1].length && by[k].every((c) => by[k - 1].includes(c))));
	const groups: number[][] = [];
	own.forEach((_, k) => (k > 0 && alike(k) ? groups.at(-1)!.push(k) : groups.push([k])));
	for (const group of groups) {
		const kind = kinds[group[0]];
		if (kind === 'none') continue;
		const grouped = group.map((k) => own[k]);
		const line = whole.back - STOP_ROOM + signBack(kind);
		const at = (backAlong(whole.pieces, line) ?? backAlong([there], line, true))!;
		const f = at.frame;
		const a = offsetPoint(f.p, f.n, Math.min(...grouped.map((l) => l.left)) + 0.15);
		const b = offsetPoint(f.p, f.n, Math.max(...grouped.map((l) => l.right)) - 0.15);
		const lanes = grouped.map((l) => l.ref);
		rows.push(
			kind === 'yield'
				? { kind: 'yield', lanes, a, b, toward: neg(at.ahead) }
				: { kind: 'stop', lanes, a, b }
		);
	}
	return rows;
}
