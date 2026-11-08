// Junctions: road ends with stored connections, walkways and approach
// controls. `defaults` fills those in once, when a junction's set of ends is
// made; `buildJunction` draws whatever is stored. Neither knows what kind of
// junction it is looking at: asphalt is the union of the connections, holes
// in it are islands, sidewalks follow its edge, crossings are the walkways
// over it.

import { defaultConnections, defaultControl, sideConnections } from './connect';
import { buildLink, linkSides, throughDashes } from './link';
import {
	area as areaOf,
	inside,
	offset,
	offsetLine,
	fromPath,
	intersect,
	open,
	close,
	subtract,
	toPath,
	union,
	type Path,
	type Paths
} from './clip';
import {
	crossSection,
	curveBetween,
	cutOf,
	endFrame,
	frameAt,
	offsetPoint,
	type EndFrame,
	type PathSample
} from './geometry';
import {
	endKey,
	laneKey,
	type Connection,
	type Corner,
	type Island,
	type Control,
	type EndRef,
	type Junction,
	type Lane,
	type LaneRef,
	type Pt,
	type Road,
	type Surface,
	type Walkway
} from './model';
import {
	isRaised,
	isRoadway,
	isTravel,
	isWalk,
	laneStrips,
	paintLine,
	roadRows,
	rowMarks,
	type Mark
} from './road';

export interface RoadGeo {
	road: Road;
	path: PathSample;
}

export interface LaneEnd {
	ref: LaneRef;
	index: number;
	lane: Lane;
	point: Pt;
	left: number;
	right: number;
	flow: 'in' | 'out' | 'both' | 'none';
	// Where this lane meets the junction: its own end line.
	at: { p: Pt; n: Pt; distance: number };
}

export interface EndInfo {
	ref: EndRef;
	key: string;
	geo: RoadGeo;
	frame: EndFrame;
	lanes: LaneEnd[];
}

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const neg = (a: Pt) => ({ x: -a.x, y: -a.y });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function endsOf(junction: Junction, roads: Map<string, RoadGeo>): EndInfo[] {
	const out: EndInfo[] = [];
	for (const ref of junction.ends) {
		const geo = roads.get(ref.road);
		if (!geo) continue;
		const frame = endFrame(geo.road, geo.path, ref.end);
		const length = geo.path.length;
		const lanes = frame.spans
			.filter((span) => span.right - span.left > 0.05)
			.map((first, index) => {
				// Each lane meets the junction at its own end (a carriageway can
				// stop short of the road's end point).
				const back = Math.min(cutOf(geo.road, first.lane.id, ref.end), length);
				const d = ref.end === 'start' ? back : length - back;
				const span =
					back > 0
						? (crossSection(geo.road, d).find((x) => x.lane.id === first.lane.id) ?? first)
						: first;
				const f = frameAt(geo.path, d);
				const lane = span.lane;
				let flow: LaneEnd['flow'] = 'none';
				if (lane.dir === 'both') flow = 'both';
				else if (lane.dir === 'fwd') flow = ref.end === 'end' ? 'in' : 'out';
				else if (lane.dir === 'back') flow = ref.end === 'start' ? 'in' : 'out';
				return {
					ref: { ...ref, lane: lane.id },
					index,
					lane,
					point: offsetPoint(f.p, f.n, (span.left + span.right) / 2),
					left: span.left,
					right: span.right,
					flow,
					at: { p: f.p, n: f.n, distance: d }
				};
			});
		out.push({ ref, key: endKey(ref), geo, frame, lanes });
	}
	return out;
}

// ---- Connection curves.

export interface Curve {
	points: Pt[];
	widths: number[];
}

export function connectionCurve(
	from: LaneEnd,
	fromEnd: EndInfo,
	to: LaneEnd,
	toEnd: EndInfo
): Curve {
	const p0 = from.point;
	const p3 = to.point;
	const chord = dist(p0, p3);
	const samples = Math.max(6, Math.min(48, Math.ceil(chord / 1.2)));
	const points = curveBetween(p0, neg(fromEnd.frame.out), p3, toEnd.frame.out, samples);
	const w0 = from.right - from.left;
	const w1 = to.right - to.left;
	// Widths blend as the path moves across (a smoothstep), so a lane that
	// keeps one edge where it was while it narrows or widens keeps that edge
	// straight.
	const ease = (t: number) => t * t * (3 - 2 * t);
	return { points, widths: points.map((_, i) => w0 + (w1 - w0) * ease(i / samples)) };
}

// ---- Defaults.

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
	const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

// Whether a polyline crosses any of the curves (a turning movement over a
// lane line).
function crossesAny(pts: Pt[], curves: Curve[]) {
	for (const c of curves)
		for (let i = 1; i < pts.length; i++)
			for (let k = 1; k < c.points.length; k++)
				if (segmentsCross(pts[i - 1], pts[i], c.points[k - 1], c.points[k])) return true;
	return false;
}

// Road ends running straight on into each other, and whether another such
// pair crosses them.
function straightPairs(ends: EndInfo[]) {
	const pairs: [EndInfo, EndInfo][] = [];
	for (let i = 0; i < ends.length; i++) {
		for (let j = i + 1; j < ends.length; j++) {
			if (dot(ends[i].frame.out, ends[j].frame.out) < Math.cos((155 * Math.PI) / 180)) {
				pairs.push([ends[i], ends[j]]);
			}
		}
	}
	const crossed = (pair: [EndInfo, EndInfo]) =>
		pairs.some(
			(other) =>
				other !== pair &&
				!other.includes(pair[0]) &&
				!other.includes(pair[1]) &&
				segmentsCross(
					offsetPoint(pair[0].frame.p, pair[0].frame.out, 30),
					offsetPoint(pair[1].frame.p, pair[1].frame.out, 30),
					offsetPoint(other[0].frame.p, other[0].frame.out, 30),
					offsetPoint(other[1].frame.p, other[1].frame.out, 30)
				)
		);
	return pairs.map((pair) => ({ pair, crossed: crossed(pair) }));
}

// Pairs of road ends that traffic drives straight on between (they face each
// other and connections join them), whether another such pair crosses them,
// and which of a crossing set carries the most travel lanes. A road carrying
// on has priority over roads that only join it; where two carry-on roads
// cross, the one with more lanes wins, and a tie has no priority at all.
// Whether one road end carries on into the other with the same lanes: the
// other's lanes mirrored, with in and out swapped.
function sameLanes(a: EndInfo, b: EndInfo) {
	const outward = (e: EndInfo) => {
		const lanes = e.ref.end === 'start' ? e.lanes : [...e.lanes].reverse();
		return lanes.map((l) => ({
			kind: l.lane.kind,
			flow: l.flow,
			width: Math.round((l.right - l.left) * 10)
		}));
	};
	const swap = (f: LaneEnd['flow']) => (f === 'in' ? 'out' : f === 'out' ? 'in' : f);
	const la = outward(a);
	const lb = outward(b).reverse();
	return (
		la.length === lb.length &&
		la.every(
			(l, i) => l.kind === lb[i].kind && l.width === lb[i].width && l.flow === swap(lb[i].flow)
		)
	);
}

export function continuingPairs(ends: EndInfo[], connections: Connection[]) {
	const linked = (a: EndInfo, b: EndInfo) =>
		connections.some(
			(c) =>
				(c.from.road === a.ref.road &&
					c.from.end === a.ref.end &&
					c.to.road === b.ref.road &&
					c.to.end === b.ref.end) ||
				(c.from.road === b.ref.road &&
					c.from.end === b.ref.end &&
					c.to.road === a.ref.road &&
					c.to.end === a.ref.end)
		);
	// Each end carries on into at most one other: a road continuing with the
	// same lanes first, then the most nearly straight.
	const candidates: { pair: [EndInfo, EndInfo]; score: number }[] = [];
	for (let i = 0; i < ends.length; i++) {
		for (let j = i + 1; j < ends.length; j++) {
			const d = dot(ends[i].frame.out, ends[j].frame.out);
			if (d < -0.2 && linked(ends[i], ends[j])) {
				candidates.push({
					pair: [ends[i], ends[j]],
					score: d - (sameLanes(ends[i], ends[j]) ? 2 : 0)
				});
			}
		}
	}
	const used = new Set<EndInfo>();
	const pairs: [EndInfo, EndInfo][] = [];
	for (const { pair } of candidates.sort((a, b) => a.score - b.score)) {
		if (used.has(pair[0]) || used.has(pair[1])) continue;
		used.add(pair[0]);
		used.add(pair[1]);
		pairs.push(pair);
	}
	const far = (e: EndInfo) => offsetPoint(e.frame.p, e.frame.out, 30);
	const weight = (pair: [EndInfo, EndInfo]) =>
		pair.reduce((n, e) => n + e.lanes.filter((l) => isTravel(l.lane)).length, 0);
	return pairs.map((pair) => {
		const crossing = pairs.filter(
			(o) =>
				o !== pair &&
				!o.includes(pair[0]) &&
				!o.includes(pair[1]) &&
				segmentsCross(far(pair[0]), far(pair[1]), far(o[0]), far(o[1]))
		);
		return {
			pair,
			crossed: crossing.length > 0,
			priority: crossing.every((o) => weight(o) < weight(pair))
		};
	});
}

const angleOf = (end: EndInfo, centre: Pt) =>
	Math.atan2(end.frame.p.y - centre.y, end.frame.p.x - centre.x);

export function centreOf(ends: EndInfo[]) {
	const c = { x: 0, y: 0 };
	for (const end of ends) {
		c.x += end.frame.p.x / ends.length;
		c.y += end.frame.p.y / ends.length;
	}
	return c;
}

export function laneEndOf(ends: EndInfo[], ref: LaneRef) {
	const end = ends.find((e) => e.ref.road === ref.road && e.ref.end === ref.end);
	const lane = end?.lanes.find((l) => l.ref.lane === ref.lane);
	return end && lane ? { end, lane } : null;
}

// A walk lane's end and the curb it belongs to: the outer edge of the
// roadway on that lane's side, and the width from there to the lane's outer
// edge. Null when the walk lane isn't outside the roadway.
function curbFor(end: EndInfo, walk: LaneEnd) {
	const roadway = end.lanes.filter((l) => isRoadway(l.lane));
	if (roadway.length === 0) return { curb: null, walk, width: walk.right - walk.left, side: 0 };
	const lo = Math.min(...roadway.map((l) => l.left));
	const hi = Math.max(...roadway.map((l) => l.right));
	if (walk.left >= hi - 0.01) {
		return {
			curb: offsetPoint(end.frame.p, end.frame.n, hi),
			walk,
			width: walk.right - hi,
			side: 1
		};
	}
	if (walk.right <= lo + 0.01) {
		return {
			curb: offsetPoint(end.frame.p, end.frame.n, lo),
			walk,
			width: lo - walk.left,
			side: -1
		};
	}
	return null;
}

// The outermost walk lane on the side of a road end that faces the next end
// going round the junction one way (`ascending` angle) or the other.
function walkOnSide(end: EndInfo, centre: Pt, ascending: boolean) {
	const lanes = end.lanes;
	if (!lanes.length) return null;
	const rel = (p: Pt) => {
		let d = Math.atan2(p.y - centre.y, p.x - centre.x) - angleOf(end, centre);
		while (d > Math.PI) d -= 2 * Math.PI;
		while (d <= -Math.PI) d += 2 * Math.PI;
		return d;
	};
	const left = offsetPoint(end.frame.p, end.frame.n, lanes[0].left);
	const right = offsetPoint(end.frame.p, end.frame.n, lanes[lanes.length - 1].right);
	const rightIsAscending = rel(right) > rel(left);
	const wantRight = rightIsAscending === ascending;
	const walks = lanes.filter((l) => isWalk(l.lane));
	if (!walks.length) return null;
	if (lanes.every((l) => isWalk(l.lane))) return walks[Math.floor(walks.length / 2)];
	const walk = wantRight ? walks[walks.length - 1] : walks[0];
	const c = curbFor(end, walk);
	return c && (c.side === 0 || c.side === (wantRight ? 1 : -1)) ? walk : null;
}

export function defaultWalkways(ends: EndInfo[]): Walkway[] {
	const walkways: Walkway[] = [];
	const centre = centreOf(ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane))));
	const pairs = straightPairs(ends);
	// Along the edge: between neighbouring ends that both have walk lanes,
	// skipping ends that have none (their mouth is crossed on the way).
	// Only ends with a roadway have a curb on the outline; a walk-only road
	// (a trail) meets the junction where it ends.
	const kerbed = ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane)));
	const walking = kerbed
		.filter((e) => e.lanes.some((l) => isWalk(l.lane)))
		.sort((a, b) => angleOf(a, centre) - angleOf(b, centre));
	const sorted = [...kerbed].sort((a, b) => angleOf(a, centre) - angleOf(b, centre));
	if (walking.length >= 2) {
		for (let i = 0; i < walking.length; i++) {
			const a = walking[i];
			const b = walking[(i + 1) % walking.length];
			if (a === b) continue;
			const wa = walkOnSide(a, centre, true);
			const wb = walkOnSide(b, centre, false);
			if (!wa || !wb) continue;
			const ia = sorted.indexOf(a);
			const crossed: EndInfo[] = [];
			for (let k = (ia + 1) % sorted.length; sorted[k] !== b; k = (k + 1) % sorted.length)
				crossed.push(sorted[k]);
			const roadwayWidth = (e: EndInfo) =>
				e.lanes.filter((l) => isRoadway(l.lane)).reduce((s, l) => s + l.right - l.left, 0);
			walkways.push({
				id: `${a.key}~${b.key}`,
				a: wa.ref,
				b: wb.ref,
				on: true,
				paved: crossed.length > 0 && crossed.every((e) => roadwayWidth(e) < 8)
			});
		}
	}
	// Walk-only roads that run straight on into each other cross between.
	for (const { pair } of pairs) {
		const [a, b] = pair;
		const only = (e: EndInfo) => e.lanes.length > 0 && e.lanes.every((l) => isWalk(l.lane));
		if (!only(a) || !only(b)) continue;
		const la = a.lanes[Math.floor(a.lanes.length / 2)];
		const lb = b.lanes[Math.floor(b.lanes.length / 2)];
		walkways.push({ id: `${a.key}=${b.key}`, a: la.ref, b: lb.ref, on: true, paved: false });
	}
	return walkways;
}

// A road no longer than this between two junctions is a link inside one
// signalled group: nobody crosses it, they cross the roads beyond.
export const SHORT_LINK = 20;

export interface DefaultCrossing {
	end: EndInfo;
	// The outermost sidewalks either side of the roadway, by lane id.
	lanes: [string, string];
	on: boolean;
}

// The default crossings at a junction of three or more roads: one across
// every road end with sidewalks on both sides of its roadway. It is on where
// that end's traffic is controlled (stop, yield or signal) and across every
// road that isn't the through road; off across a through road nobody stops
// on, and across a short link between two junctions (`shortLink`).
export function defaultCrossings(
	junction: Junction,
	ends: EndInfo[],
	shortLink: (road: string) => boolean
): DefaultCrossing[] {
	if (ends.length < 3 || junction.sides?.length) return [];
	const through = new Set<string>();
	for (const { pair, priority } of continuingPairs(ends, junction.connections))
		if (priority) for (const e of pair) through.add(e.key);
	const out: DefaultCrossing[] = [];
	for (const end of ends) {
		const walks = end.lanes.filter((l) => isWalk(l.lane));
		const roadway = end.lanes.filter((l) => isRoadway(l.lane));
		if (walks.length < 2 || roadway.length === 0) continue;
		const a = walks[0];
		const b = walks[walks.length - 1];
		if (
			a.right > Math.min(...roadway.map((l) => l.left)) ||
			b.left < Math.max(...roadway.map((l) => l.right))
		)
			continue;
		const controlled = (junction.control[end.key] ?? 'none') !== 'none';
		const on = !shortLink(end.ref.road) && (controlled || !through.has(end.key));
		out.push({ end, lanes: [a.ref.lane, b.ref.lane], on });
	}
	return out;
}

export function defaults(junction: Junction, roads: Map<string, RoadGeo>) {
	const ends = endsOf(junction, roads);
	// Where one road meets just one other, sidewalks connect like any other
	// lane: no corners, no crosswalks.
	const sides = linkSides(junction, ends);
	const link = !!sides;
	const connections =
		sides && ends.length > 2 ? sideConnections(sides, junction.anchors) : defaultConnections(ends);
	// The roads that carry on through the node, by the connections.
	const through = new Set<string>();
	for (const { pair, priority } of continuingPairs(ends, connections))
		if (priority) for (const e of pair) through.add(e.key);
	return {
		connections,
		walkways: link ? [] : defaultWalkways(ends),
		control: link
			? Object.fromEntries(
					ends
						.filter((e) => e.lanes.some((l) => isTravel(l.lane) && l.flow === 'in'))
						.map((e) => [e.key, 'none' as Control])
				)
			: defaultControl(ends, through, connections),
		corners: link ? [] : defaultCorners(ends)
	};
}

// The default curb outline: a corner between each pair of neighbouring road
// ends (by angle round the junction), at the default curve.
export function defaultCorners(ends: EndInfo[]): Corner[] {
	const kerbed = ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane)));
	const centre = centreOf(kerbed);
	const sorted = [...kerbed].sort((a, b) => angleOf(a, centre) - angleOf(b, centre));
	if (sorted.length < 2) return [];
	return sorted.map((a, i) => ({ a: a.key, b: sorted[(i + 1) % sorted.length].key, bulge: 1 }));
}

// ---- Drawing.

export interface Crossing {
	id: string;
	on: boolean;
	paved: boolean;
	zebra: Paths;
	paving: Paths;
	trail: Paths;
	refuge: Paths;
	hit: Paths;
}

export interface JunctionDraw {
	outline: Pt[];
	asphalt: Paths;
	islands: { path: Path; surface: Surface }[];
	// Grass verge carried round a corner between curb and sidewalk.
	verges: Paths;
	// Raised and painted buffers carried across the junction with the road.
	carried: { paths: Paths; surface: Surface; line: 'white' | 'yellow'; bars: Paths }[];
	pavement: Paths;
	trail: Paths;
	crossings: Crossing[];
	white: Pt[][];
	yellow: Pt[][];
	marks: Mark[];
	curves: Curve[];
	badges: { key: string; p: Pt; control: Control }[];
	laneDots: { p: Pt; flow: LaneEnd['flow'] }[];
	// Road ends whose lanes carry on across the junction: their medians run
	// right up to the outline.
	carriedEnds: Set<string>;
	// How far back from each road end its paint stops.
	setbacks: Map<string, number>;
	mouths: { key: string; pts: Pt[]; out: Pt }[];
}

export const CROSSING_DEPTH = 3;
// Where a junction's crossing sits by default: its middle this far from the
// road's end, just clear of the corners.
export const CROSSING_FROM_END = 0.5 + CROSSING_DEPTH / 2;
// How far a corner's sidewalk overlaps the roads' own sidewalks.
const SEAM = 0.4;
export const STOP_GAP = 1;
// Any road end wider than this across its roadway is a road crossing the
// through road, not a driveway: lines stop at it.
const NARROW = 8;

// A crossing across a road counts as at its end, with the stop line behind
// it, when it starts no further back than this: far enough that it never
// sits among the turn arrows before a stop line at the end.
const CROSSING_AT_END = 12;

// How far back from a road's end (its `end`, a road of `length`) the crossing
// at that end reaches, or 0 when none lies there.
export function crossingReach(road: Road, length: number, end: 'start' | 'end') {
	let reach = 0;
	for (const c of road.crossings ?? []) {
		const d = end === 'start' ? c.at : length - c.at;
		// Only the end it is nearer counts it: on a short road between two
		// junctions, the far end keeps its stop line where it was.
		if (d - CROSSING_DEPTH / 2 <= CROSSING_AT_END && d <= length / 2)
			reach = Math.max(reach, d + CROSSING_DEPTH / 2);
	}
	return reach;
}

// How far back from a road end its paint stops: behind the crossing at its
// end, if there is one, and behind the stop line when the approach is
// controlled.
export function approachSetback(
	junction: Junction,
	road: Road,
	length: number,
	end: 'start' | 'end'
) {
	const reach = crossingReach(road, length, end);
	const controlled = (junction.control[endKey({ road: road.id, end })] ?? 'none') !== 'none';
	return (reach ? reach + 1 : 0) + (controlled ? STOP_GAP : 0);
}

// Roadway (or other) strips of a road end's last few metres.
// A road end's outer edge on the side facing `toward`, from the end out
// along the road, if the lane on that edge is grass.
function facingEdge(end: EndInfo, toward: Pt) {
	const length = end.geo.path.length;
	const depth = Math.min(length, 80);
	const [from, to] = end.ref.end === 'start' ? [0, depth] : [length - depth, length];
	let rows = roadRows(end.geo.road, end.geo.path, from, to);
	if (end.ref.end === 'end') rows = [...rows].reverse();
	const out: Pt[] = [];
	for (const row of rows) {
		const spans = row.spans.filter((sp) => sp.right - sp.left > 0.01);
		if (spans.length === 0) return null;
		const side = (toward.x - row.p.x) * row.n.x + (toward.y - row.p.y) * row.n.y;
		const edge = side >= 0 ? spans[spans.length - 1] : spans[0];
		if (edge.lane.surface !== 'grass' || !isRaised(edge.lane)) return null;
		out.push(offsetPoint(row.p, row.n, side >= 0 ? edge.right : edge.left));
	}
	return out.length >= 2 ? out : null;
}

// Each lane's strip over a road end's last few metres, by lane id.
function nearEndLanes(end: EndInfo, depth: number) {
	const length = end.geo.path.length;
	const [from, to] =
		end.ref.end === 'start' ? [0, Math.min(length, depth)] : [Math.max(0, length - depth), length];
	const rows = roadRows(end.geo.road, end.geo.path, from, to);
	const out = new Map<string, Paths>();
	for (const [id, { polys }] of laneStrips(rows, () => true)) out.set(id, polys.map(toPath));
	return out;
}

function nearEnd(end: EndInfo, depth: number, keep: (lane: Lane) => boolean) {
	const length = end.geo.path.length;
	const [from, to] =
		end.ref.end === 'start' ? [0, Math.min(length, depth)] : [Math.max(0, length - depth), length];
	const rows = roadRows(end.geo.road, end.geo.path, from, to);
	const paths: Paths = [];
	for (const { polys } of laneStrips(rows, keep).values())
		for (const poly of polys) paths.push(toPath(poly));
	return union(paths);
}

// A road end's curb points: either edge of its roadway, and which of them
// comes first going round the junction.
export interface Curb {
	end: EndInfo;
	lo: Pt;
	hi: Pt;
	// The curb point the outline leaves from toward the next end, and the one
	// it arrives at from the previous end.
	leave: Pt;
	arrive: Pt;
	// No sidewalk or verge beyond the curb on that side.
	bareLeave: boolean;
	bareArrive: boolean;
	// From the arriving curb across the road end to the leaving curb.
	mouth: Pt[];
}

const dedupe = (pts: Pt[]) => pts.filter((q, i) => i === 0 || dist(q, pts[i - 1]) > 0.01);

export function curbsOf(ends: EndInfo[]) {
	const kerbed = ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane)));
	const centre = centreOf(kerbed);
	const curbs = new Map<string, Curb>();
	for (const end of kerbed) {
		const roadway = end.lanes.filter((l) => isRoadway(l.lane));
		const loLane = roadway.reduce((a, b) => (b.left < a.left ? b : a));
		const hiLane = roadway.reduce((a, b) => (b.right > a.right ? b : a));
		const lo = offsetPoint(loLane.at.p, loLane.at.n, loLane.left);
		const hi = offsetPoint(hiLane.at.p, hiLane.at.n, hiLane.right);
		// The mouth: across every lane between the curbs, each at its own end,
		// so a carriageway that stops short steps the edge back along its side.
		const across = end.lanes.filter(
			(l) => l.left >= loLane.left - 0.01 && l.right <= hiLane.right + 0.01
		);
		const mouthLoHi: Pt[] = [];
		for (const l of across) {
			mouthLoHi.push(offsetPoint(l.at.p, l.at.n, l.left), offsetPoint(l.at.p, l.at.n, l.right));
		}
		const rel = (p: Pt) => {
			let d = Math.atan2(p.y - centre.y, p.x - centre.x) - angleOf(end, centre);
			while (d > Math.PI) d -= 2 * Math.PI;
			while (d <= -Math.PI) d += 2 * Math.PI;
			return d;
		};
		const hiLeads = rel(hi) > rel(lo);
		const top = Math.max(...roadway.map((l) => l.right));
		const bottom = Math.min(...roadway.map((l) => l.left));
		const bareHi = !end.lanes.some((l) => l.left >= top - 0.01);
		const bareLo = !end.lanes.some((l) => l.right <= bottom + 0.01);
		curbs.set(end.key, {
			end,
			lo,
			hi,
			leave: hiLeads ? hi : lo,
			arrive: hiLeads ? lo : hi,
			mouth: dedupe(hiLeads ? mouthLoHi : [...mouthLoHi].reverse()),
			bareLeave: hiLeads ? bareHi : bareLo,
			bareArrive: hiLeads ? bareLo : bareHi
		});
	}
	return { curbs, centre };
}

// A corner curve from one curb to the next: leaves along the first road into
// the junction and arrives along the second, with arc-like handles.
function cornerCurve(a: Curb, b: Curb, bulge: number) {
	const p0 = a.leave;
	const p3 = b.arrive;
	const d0 = neg(a.end.frame.out);
	const d3 = b.end.frame.out;
	const chord = dist(p0, p3);
	// Two roads leaving side by side (a busway beside a highway, two halves of
	// a split): the curb runs straight across between them.
	if (dot(a.end.frame.out, b.end.frame.out) > 0.9) {
		// With nothing beyond either curb, straight across.
		if (a.bareLeave && b.bareArrive) return [p0, p3];
		// Two roads leaving side by side (a busway beside a highway, the two
		// halves of a split): the curb swings across in front of whichever end
		// sits further in, never behind either.
		const u = neg(a.end.frame.out);
		const ta = dot(p0, u);
		const tb = dot(p3, u);
		// In front of every lane corner facing the gap too (a verge between
		// the two roads), so a slanted end never has a corner behind the curb.
		const facing = (e: EndInfo, toward: Pt) => {
			const sign = Math.sign(lateral(e, toward));
			return e.lanes
				.filter((l) => Math.sign((l.left + l.right) / 2) === sign)
				.flatMap((l) => [l.left, l.right])
				.map((o) => dot(offsetPoint(e.frame.p, e.frame.n, o), u));
		};
		const t = Math.max(ta, tb, ...facing(a.end, p3), ...facing(b.end, p0));
		// Straight pieces: a curve here could bulge behind an end line.
		return [p0, offsetPoint(p0, u, t - ta), offsetPoint(p3, u, t - tb), p3].filter(
			(q, i, list) => i === 0 || dist(q, list[i - 1]) > 0.05
		);
	}
	const turn = Math.acos(Math.max(-1, Math.min(1, dot(d0, d3))));
	// Where both curb lines run on to meet in front of both ends: straight
	// along the longer one, then a circular arc into the other, like a curb
	// return. A single arc never wiggles, however far apart the ends are.
	const cross = d0.x * d3.y - d0.y * d3.x;
	if (turn > 0.05 && Math.abs(cross) > 1e-6) {
		// p0 + s d0 = p3 - t d3
		const rx = p3.x - p0.x;
		const ry = p3.y - p0.y;
		const sAt = (rx * d3.y - ry * d3.x) / cross;
		const tAt = (d0.x * ry - d0.y * rx) / cross;
		if (sAt > 0.05 && tAt > 0.05) {
			const x = offsetPoint(p0, d0, sAt);
			const tangent = Math.min(sAt, tAt) * Math.min(1, bulge);
			const radius = tangent / Math.tan(turn / 2);
			const from = offsetPoint(x, d0, -tangent);
			const to = offsetPoint(x, d3, tangent);
			const side = Math.sign(cross);
			const centre = offsetPoint(from, { x: -d0.y * side, y: d0.x * side }, radius);
			const a0 = Math.atan2(from.y - centre.y, from.x - centre.x);
			const steps = Math.max(2, Math.min(64, Math.ceil((radius * turn) / 0.4)));
			const arc: Pt[] = [];
			for (let i = 0; i <= steps; i++) {
				const t = a0 + (side * turn * i) / steps;
				arc.push({ x: centre.x + Math.cos(t) * radius, y: centre.y + Math.sin(t) * radius });
			}
			arc[arc.length - 1] = to;
			return [p0, ...arc, p3].filter((q, i, list) => i === 0 || dist(q, list[i - 1]) > 0.02);
		}
	}
	let k =
		turn < 1e-3
			? chord / 3
			: (chord * (2 / 3) * Math.tan(turn / 4)) / Math.sin(Math.max(turn / 2, 0.2));
	// Here the curb lines don't meet ahead of both ends (one end sticks out
	// past the other road's curb): short handles, so the curve stays close to
	// the chord instead of hooking round into a point.
	k = Math.min(k * bulge, chord / 3);
	// Neither handle may reach behind the other road's end line, or the curve
	// would cut across that road's sidewalk.
	const limit = (from: Pt, dir: Pt, line: Pt, out: Pt) => {
		const toward = dot(dir, out);
		if (toward <= 1e-6) return k;
		return Math.max(0, Math.min(k, -dot({ x: from.x - line.x, y: from.y - line.y }, out) / toward));
	};
	const p1 = offsetPoint(p0, d0, limit(p0, d0, p3, b.end.frame.out));
	const p2 = offsetPoint(p3, neg(d3), limit(p3, neg(d3), p0, a.end.frame.out));
	const n = Math.max(2, Math.min(64, Math.ceil(chord / 0.4)));
	const pts: Pt[] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const u = 1 - t;
		pts.push({
			x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
		});
	}
	return pts;
}

export interface Outline {
	polygon: Pt[];
	corners: { a: string; b: string; pts: Pt[] }[];
	curbs: Map<string, Curb>;
}

// The curb outline from the stored corners. Between one corner's arrival and
// the next corner's departure runs a road end's mouth, straight across its
// roadway.
export function outlineOf(junction: Junction, ends: EndInfo[]): Outline {
	const { curbs } = curbsOf(ends);
	const corners: Outline['corners'] = [];
	const stored = junction.corners.filter((c) => curbs.has(c.a) && curbs.has(c.b));
	const list = stored.length === curbs.size && curbs.size >= 2 ? stored : defaultCorners(ends);
	for (const c of list) {
		const a = curbs.get(c.a)!;
		const b = curbs.get(c.b)!;
		const pts = c.via ? [a.leave, ...c.via, b.arrive] : cornerCurve(a, b, c.bulge);
		corners.push({ a: c.a, b: c.b, pts });
	}
	// Each corner ends where the next end's mouth begins; the mouth runs on
	// across to where the next corner leaves.
	const polygon = corners.flatMap((c) => [...c.pts, ...curbs.get(c.b)!.mouth.slice(1, -1)]);
	return { polygon, corners, curbs };
}

// The outline from one end's departing curb round to another's arriving curb.
function chainBetween(outline: Outline, from: string, to: string) {
	const start = outline.corners.findIndex((c) => c.a === from);
	if (start < 0) return null;
	const pts: Pt[] = [];
	const crossed: string[] = [];
	for (let k = 0; k < outline.corners.length; k++) {
		const c = outline.corners[(start + k) % outline.corners.length];
		pts.push(...c.pts);
		if (c.b === to) return { pts, crossed };
		crossed.push(c.b);
		pts.push(...outline.curbs.get(c.b)!.mouth.slice(1, -1));
	}
	return null;
}

export function bars(points: Pt[], width: number): Paths {
	const out: Paths = [];
	let run = 0;
	let next = 0.5;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		const l = dist(a, b);
		while (next <= run + l) {
			const f = (next - run) / (l || 1);
			const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
			const t = { x: (b.x - a.x) / (l || 1), y: (b.y - a.y) / (l || 1) };
			const n = { x: -t.y, y: t.x };
			const h = width / 2 + 0.3;
			out.push(
				toPath([
					{ x: p.x - t.x * 0.25 + n.x * h, y: p.y - t.y * 0.25 + n.y * h },
					{ x: p.x + t.x * 0.25 + n.x * h, y: p.y + t.y * 0.25 + n.y * h },
					{ x: p.x + t.x * 0.25 - n.x * h, y: p.y + t.y * 0.25 - n.y * h },
					{ x: p.x - t.x * 0.25 - n.x * h, y: p.y - t.y * 0.25 - n.y * h }
				])
			);
			next += 1.0;
		}
		run += l;
	}
	return out;
}

function quad(a: Pt, b: Pt, w: number): Pt[] {
	const l = dist(a, b) || 1;
	const n = { x: (-(b.y - a.y) / l) * w, y: ((b.x - a.x) / l) * w };
	return [
		{ x: a.x + n.x, y: a.y + n.y },
		{ x: b.x + n.x, y: b.y + n.y },
		{ x: b.x - n.x, y: b.y - n.y },
		{ x: a.x - n.x, y: a.y - n.y }
	];
}

// An island's shape in world metres.
export function islandShape(island: Island, ends: EndInfo[]): Pt[] | null {
	if (!island.anchor) return island.shape;
	const end = ends.find((e) => e.key === island.anchor);
	if (!end) return null;
	return island.shape.map((q) =>
		offsetPoint(offsetPoint(end.frame.p, end.frame.out, q.x), end.frame.n, q.y)
	);
}

const lateral = (end: EndInfo, p: Pt) =>
	dot({ x: p.x - end.frame.p.x, y: p.y - end.frame.p.y }, end.frame.n);

// The roads leaving the far side of a junction from a road end: facing it
// and joined to it by connections.
// The road ends `a` carries straight on into: nearly opposite it and joined
// to it by connections. Where one of them is about as wide as `a` (the same
// road carrying on), a narrower one beside it (a ramp or a driveway at a
// slant) only joins it and isn't carried into.
function facingOf(a: EndInfo, ends: EndInfo[], junction: Junction) {
	const facing = ends.filter(
		(e) =>
			e !== a &&
			e.lanes.some((l) => isRoadway(l.lane)) &&
			dot(e.frame.out, a.frame.out) < -0.7 &&
			junction.connections.some(
				(c) =>
					(endKey(c.from) === a.key && endKey(c.to) === e.key) ||
					(endKey(c.from) === e.key && endKey(c.to) === a.key)
			)
	);
	const wide = facing.filter((e) => roadwayOf(e) >= 0.6 * roadwayOf(a));
	return wide.length ? wide : facing;
}

const roadwayOf = (e: EndInfo) =>
	e.lanes.filter((l) => isRoadway(l.lane)).reduce((s, l) => s + l.right - l.left, 0);

// Points along a polyline at most `step` apart.
function densify(pts: Pt[], step: number) {
	const out: Pt[] = [pts[0]];
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const n = Math.max(1, Math.ceil(dist(a, b) / step));
		for (let k = 1; k <= n; k++)
			out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
	}
	return dedupe(out);
}

// Which side of a curb line is outside the asphalt: +1 for the left normal.
function outwardSide(pts: Pt[], asphalt: Paths) {
	const i = Math.floor(pts.length / 2);
	const a = pts[Math.max(0, i - 1)];
	const b = pts[Math.min(pts.length - 1, i + 1)];
	const l = dist(a, b) || 1;
	const probe = { x: pts[i].x - ((b.y - a.y) / l) * 0.3, y: pts[i].y + ((b.x - a.x) / l) * 0.3 };
	return inside(asphalt, probe) ? -1 : 1;
}

// A band beside a curb line on its outward side, from `inner` to `outer`
// metres out, each running smoothly from its start value to its end value.
// A band along one side of a polyline, from `i` to `o` metres off it, both
// running linearly from their start to end values. Built from a piece per
// segment plus a round wedge at each outward turn, unioned, so a tight curve
// can't fold the outer edge back over itself into a spike or a notch.
// A sidewalk lane's outer edge (away from the curb at `curb`) where its road
// meets the junction, a seam's length back into the road.
function outerEdge(end: EndInfo, walk: LaneEnd, curb: Pt) {
	const c = lateral(end, curb);
	const o = Math.abs(walk.left - c) > Math.abs(walk.right - c) ? walk.left : walk.right;
	return offsetPoint(offsetPoint(end.frame.p, end.frame.n, o), end.frame.out, SEAM);
}

// The curve rounding the corner where two edges meet: each edge runs from
// its point (a, b) along its direction (da, db) to where the two lines cross,
// and the curve leaves a, bends toward that crossing and arrives at b, never
// leaving the triangle between them. Null when either point is already past
// the crossing (or the lines barely meet), as there is no corner ahead.
function fillet(a: Pt, da: Pt, b: Pt, db: Pt) {
	const cross = da.x * db.y - da.y * db.x;
	if (Math.abs(cross) < 0.05) return null;
	const rx = b.x - a.x;
	const ry = b.y - a.y;
	const sa = (rx * db.y - ry * db.x) / cross;
	const sb = (rx * da.y - ry * da.x) / cross;
	if (sa < 0.05 || sb < 0.05) return null;
	const c = offsetPoint(a, da, sa);
	const out: Pt[] = [];
	for (let i = 0; i <= 24; i++) {
		const t = i / 24;
		const u = 1 - t;
		out.push({
			x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
			y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
		});
	}
	return out;
}

// The points of a polyline moved off it to one side (`side`) by a distance
// running from d0 at its start to d1 at its end.
function edgeAlong(pts: Pt[], d0: number, d1: number, side: number) {
	const lengths = [0];
	for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + dist(pts[i], pts[i - 1]));
	const total = lengths[lengths.length - 1] || 1;
	return pts.map((p, i) => {
		const a = pts[Math.max(0, i - 1)];
		const b = pts[Math.min(pts.length - 1, i + 1)];
		const l = dist(a, b) || 1;
		const n = { x: (-(b.y - a.y) / l) * side, y: ((b.x - a.x) / l) * side };
		return offsetPoint(p, n, d0 + ((d1 - d0) * lengths[i]) / total);
	});
}

function ribbon(pts: Pt[], i0: number, i1: number, o0: number, o1: number, side: number): Paths {
	const lengths = [0];
	for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + dist(pts[i], pts[i - 1]));
	const total = lengths[lengths.length - 1] || 1;
	const at = (i: number) => {
		const f = lengths[i] / total;
		return { i: i0 + (i1 - i0) * f, o: o0 + (o1 - o0) * f };
	};
	const normals: Pt[] = [];
	for (let k = 0; k + 1 < pts.length; k++) {
		const l = dist(pts[k], pts[k + 1]) || 1;
		normals.push({
			x: (-(pts[k + 1].y - pts[k].y) / l) * side,
			y: ((pts[k + 1].x - pts[k].x) / l) * side
		});
	}
	const pieces: Paths = [];
	for (let k = 0; k + 1 < pts.length; k++) {
		if (dist(pts[k], pts[k + 1]) < 1e-4) continue;
		const n = normals[k];
		const a = at(k);
		const b = at(k + 1);
		pieces.push(
			toPath([
				offsetPoint(pts[k], n, a.i),
				offsetPoint(pts[k + 1], n, b.i),
				offsetPoint(pts[k + 1], n, b.o),
				offsetPoint(pts[k], n, a.o)
			])
		);
	}
	for (let k = 1; k + 1 < pts.length; k++) {
		const n0 = normals[k - 1];
		const n1 = normals[k];
		const a0 = Math.atan2(n0.y, n0.x);
		let sweep = Math.atan2(n1.y, n1.x) - a0;
		while (sweep > Math.PI) sweep -= 2 * Math.PI;
		while (sweep < -Math.PI) sweep += 2 * Math.PI;
		// Only where the line turns away from the band's side.
		if (Math.abs(sweep) < 1e-3 || side * sweep > 0) continue;
		const { i, o } = at(k);
		const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 0.25));
		const arc = (r: number) =>
			Array.from({ length: steps + 1 }, (_, s) => {
				const t = a0 + (sweep * s) / steps;
				return { x: pts[k].x + Math.cos(t) * r, y: pts[k].y + Math.sin(t) * r };
			});
		pieces.push(toPath([...arc(o), ...arc(i).reverse()]));
	}
	return union(pieces);
}

// Hatch bars carried on from road end A: the same slant and the same 4 m
// rhythm (measured along A's road) as the bars painted on the road.
function hatchBars(a: EndInfo, lo: number, hi: number, length: number): Paths {
	const w = hi - lo;
	const into = neg(a.frame.out);
	// The road paints a bar every 4 m in world terms along its heading; the
	// slant runs with the road's drawing direction.
	const sign = a.ref.end === 'end' ? 1 : -1;
	const t = { x: into.x * sign, y: into.y * sign };
	const along0 = dot(a.frame.p, t);
	const first = (((-along0 * sign) % 4) + 4) % 4;
	const out: Paths = [];
	for (let s = first - 8; s < length + 8; s += 4) {
		const base = offsetPoint(a.frame.p, into, s);
		const p0 = offsetPoint(base, a.frame.n, lo - 0.5);
		const p1 = offsetPoint(
			offsetPoint(base, into, sign * Math.max(w, 1) * 0.8),
			a.frame.n,
			hi + 0.5
		);
		out.push(toPath(quad(p0, p1, 0.25)));
	}
	return out;
}

// Carrying a road across the junction: from road end A, the roads leaving the
// far side (facing A, joined to it by connections) are laid side by side
// across A's line. Where their lanes line up with A's, kind for kind (a run
// of buffers counting as one), A's lanes run on across: buffers as strips,
// paint as lines.
function carry(
	a: EndInfo,
	ends: EndInfo[],
	junction: Junction,
	others: Curve[],
	out: { carried: JunctionDraw['carried']; marks: Mark[]; white: Pt[][]; yellow: Pt[][] }
) {
	const far = facingOf(a, ends, junction);
	if (!far.length) return false;
	// Each crossing is laid once: from the side with one road, or from the
	// smaller key when one road faces one road.
	if (far.length === 1) {
		const back = facingOf(far[0], ends, junction);
		if (back.length > 1 || (back.length === 1 && far[0].key < a.key)) return false;
	}
	const inFrame = (end: EndInfo) =>
		end.lanes.map((l) => {
			const c = lateral(a, l.point);
			const w = l.right - l.left;
			const flow = end === a ? l.flow : l.flow === 'in' ? 'out' : l.flow === 'out' ? 'in' : l.flow;
			const dir: Lane['dir'] = isTravel(l.lane)
				? (flow === 'out') === (a.ref.end === 'start')
					? 'fwd'
					: 'back'
				: l.lane.dir;
			return { lane: { ...l.lane, dir }, left: c - w / 2, right: c + w / 2, point: l.point, end };
		});
	const near = inFrame(a).sort((p, q) => p.left - q.left);
	const other = far.flatMap(inFrame).sort((p, q) => p.left - q.left);
	const roadwayOnly = (list: typeof near) => {
		const i0 = list.findIndex((s) => isRoadway(s.lane));
		const i1 = list.length - 1 - [...list].reverse().findIndex((s) => isRoadway(s.lane));
		return i0 < 0 ? [] : list.slice(i0, i1 + 1);
	};
	const group = (list: typeof near) => {
		const groups: { kind: string; items: typeof near }[] = [];
		for (const s of list) {
			const kind = isTravel(s.lane)
				? `${s.lane.kind}:${s.lane.dir}`
				: s.lane.kind === 'buffer'
					? `buffer:${s.lane.surface === 'hatch' ? 'hatch' : 'raised'}`
					: s.lane.kind;
			// Side by side lanes of one kind (travel lanes going one way, say)
			// are one group, so a road gaining a lane across the junction (an
			// acceleration lane) still carries on.
			const last = groups[groups.length - 1];
			if (last && last.kind === kind) last.items.push(s);
			else groups.push({ kind, items: [s] });
		}
		return groups;
	};
	const ga = group(roadwayOnly(near));
	const gb = group(roadwayOnly(other));
	if (ga.length !== gb.length || ga.some((g, i) => g.kind !== gb[i].kind)) return false;
	const into = neg(a.frame.out);
	// Nothing is carried across if another road's mouth reaches into the
	// carried roadway (a driveway pushed into the street).
	const edgeL = offsetPoint(a.frame.p, a.frame.n, ga[0].items[0].left);
	const edgeR = offsetPoint(a.frame.p, a.frame.n, ga[ga.length - 1].items.at(-1)!.right);
	const farL = gb[0].items[0];
	const farR = gb[gb.length - 1].items.at(-1)!;
	const farEdge = (s: (typeof near)[number], side: -1 | 1) =>
		offsetPoint(
			s.point,
			s.end.frame.n,
			(side * (dot(s.end.frame.n, a.frame.n) > 0 ? 1 : -1) * (s.right - s.left)) / 2
		);
	// (Inset past the few centimetres a road without sidewalks laps over the
	// curb it stops on.)
	const span = offset([toPath([edgeL, edgeR, farEdge(farR, 1), farEdge(farL, -1)])], -0.3);
	for (const e of ends) {
		if (e === a || far.includes(e) || !e.lanes.some((l) => isRoadway(l.lane))) continue;
		const roadway = e.lanes.filter((l) => isRoadway(l.lane));
		const lo = offsetPoint(e.frame.p, e.frame.n, Math.min(...roadway.map((l) => l.left)));
		const hi = offsetPoint(e.frame.p, e.frame.n, Math.max(...roadway.map((l) => l.right)));
		if (
			intersect(span, [
				toPath([lo, hi, offsetPoint(hi, e.frame.out, 0.05), offsetPoint(lo, e.frame.out, 0.05)])
			]).length
		)
			return false;
	}
	const along = (p: Pt, q: Pt, qOut: Pt) => {
		const pts = curveBetween(p, into, q, qOut, Math.max(4, Math.ceil(dist(p, q) / 1.5)));
		return pts;
	};
	// Buffers as strips, unless a turning connection cuts across them.
	ga.forEach((g, i) => {
		if (!g.kind.startsWith('buffer')) return;
		const h = gb[i];
		const aL = offsetPoint(a.frame.p, a.frame.n, g.items[0].left);
		const aR = offsetPoint(a.frame.p, a.frame.n, g.items[g.items.length - 1].right);
		const fl = h.items[0];
		const fr = h.items[h.items.length - 1];
		const edge = (s: (typeof near)[number], side: -1 | 1) => {
			const w = s.lane.width;
			const e = s.end;
			const sign = dot(e.frame.n, a.frame.n) > 0 ? 1 : -1;
			return offsetPoint(s.point, e.frame.n, (side * sign * (s.right - s.left || w)) / 2);
		};
		const bL = edge(fl, -1);
		const bR = edge(fr, 1);
		const left = along(aL, bL, fl.end.frame.out);
		const right = along(aR, bR, fr.end.frame.out);
		const poly = [toPath([...left, ...right.reverse()])];
		const cut = others.some((c) =>
			c.points.some(
				(p, k) => k > 0 && intersect([toPath(quad(c.points[k - 1], p, 0.05))], poly).length > 0
			)
		);
		if (cut) return;
		const lane = g.items[0].lane;
		const surface = lane.surface;
		const l = ga[i - 1]?.items[0].lane;
		const r = ga[i + 1]?.items[0].lane;
		const opposing = !!(l && r && isTravel(l) && isTravel(r) && l.dir !== r.dir);
		const reach = Math.max(...left.map((q) => dist(q, aL)), 1);
		const bars =
			surface === 'hatch'
				? intersect(
						hatchBars(a, g.items[0].left, g.items[g.items.length - 1].right, reach),
						poly
					).filter((bar) => Math.abs(areaOf(bar)) > 0.3)
				: [];
		out.carried.push({ paths: poly, surface, line: opposing ? 'yellow' : 'white', bars });
	});
	// Paint: the marks across A's end and across the far ends must match one
	// for one; each runs on as a curve between them.
	const ma = rowMarks(near).filter(
		(m) => m.o >= ga[0].items[0].left - 0.01 && m.o <= ga[ga.length - 1].items.at(-1)!.right + 0.01
	);
	const mb = rowMarks(other).filter(
		(m) => m.o >= gb[0].items[0].left - 0.01 && m.o <= gb[gb.length - 1].items.at(-1)!.right + 0.01
	);
	// Each mark carries on to the far mark of its kind straight across from
	// it; a mark with none there (beside a lane gained or lost across the
	// junction) stops.
	const used = new Set<number>();
	const pairs = ma.flatMap((m) => {
		const k = mb.findIndex(
			(x, i) =>
				!used.has(i) && x.colour === m.colour && x.dashed === m.dashed && Math.abs(x.o - m.o) < 0.75
		);
		if (k < 0) return [];
		used.add(k);
		return [{ m, o: mb[k].o }];
	});
	for (const { m, o } of pairs) {
		const p = offsetPoint(a.frame.p, a.frame.n, m.o);
		// The far mark sits on whichever far road spans its offset.
		const host = other.find((s) => o >= s.left - 0.3 && o <= s.right + 0.3)?.end ?? far[0];
		const q = offsetPoint(
			host.frame.p,
			host.frame.n,
			(o - lateral(a, host.frame.p)) / dot(host.frame.n, a.frame.n)
		);
		const pts = along(p, q, host.frame.out);
		// A line only carries on where no turning traffic crosses it.
		if (crossesAny(pts, others)) continue;
		const s = [0];
		for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + dist(pts[k], pts[k - 1]));
		paintLine(pts, s, m.dashed, m.colour === 'white' ? out.white : out.yellow);
		out.marks.push({ colour: m.colour, dashed: m.dashed, pts });
	}
	return true;
}

export function buildJunction(junction: Junction, roads: Map<string, RoadGeo>): JunctionDraw {
	const ends = endsOf(junction, roads);
	if (linkSides(junction, ends)) return buildLink(junction, ends);
	const outline = outlineOf(junction, ends);
	const asphalt = outline.polygon.length >= 3 ? union([toPath(outline.polygon)]) : [];
	const curves: Curve[] = [];
	const resolved: { c: Connection; curve: Curve; fromEnd: EndInfo; toEnd: EndInfo }[] = [];
	for (const c of junction.connections) {
		const a = laneEndOf(ends, c.from);
		const b = laneEndOf(ends, c.to);
		if (!a || !b) continue;
		const curve = connectionCurve(a.lane, a.end, b.lane, b.end);
		curves.push(curve);
		resolved.push({ c, curve, fromEnd: a.end, toEnd: b.end });
	}
	const islands: JunctionDraw['islands'] = [];
	for (const island of junction.islands) {
		const shape = islandShape(island, ends);
		if (shape) islands.push({ path: toPath(shape), surface: island.surface });
	}

	// Carry roads straight across where nothing but narrow roads (driveways)
	// joins them and nobody has to stop.
	const out = {
		carried: [] as JunctionDraw['carried'],
		marks: [] as Mark[],
		white: [] as Pt[][],
		yellow: [] as Pt[][]
	};
	const carriedEnds = new Set<string>();
	const roadwayWidth = (e: EndInfo) =>
		e.lanes.filter((l) => isRoadway(l.lane)).reduce((s, l) => s + l.right - l.left, 0);
	for (const a of ends) {
		if (!a.lanes.some((l) => isRoadway(l.lane))) continue;
		if ((junction.control[a.key] ?? 'none') !== 'none') continue;
		const facing = facingOf(a, ends, junction);
		if (facing.some((e) => (junction.control[e.key] ?? 'none') !== 'none')) continue;
		const rest = ends.filter(
			(e) => e !== a && !facing.includes(e) && dot(e.frame.out, a.frame.out) <= 0.7
		);
		if (rest.some((e) => roadwayWidth(e) >= NARROW)) continue;
		const turning = resolved
			.filter((r) => dot(neg(r.fromEnd.frame.out), r.toEnd.frame.out) < Math.cos(Math.PI / 6))
			.map((r) => r.curve);
		if (carry(a, ends, junction, turning, out)) {
			carriedEnds.add(a.key);
			for (const e of facing) carriedEnds.add(e.key);
		}
	}
	// A road with priority that carries on keeps its lane lines (dashed,
	// between lanes going the same way) through the junction, even round a
	// bend, as a roundabout's ring does past each entry.
	for (const { pair, priority } of continuingPairs(ends, junction.connections)) {
		const [a, b] = pair;
		if (!priority || carriedEnds.has(a.key)) continue;
		if (
			(junction.control[a.key] ?? 'none') !== 'none' ||
			(junction.control[b.key] ?? 'none') !== 'none'
		)
			continue;
		// Only where no other movement crosses them.
		const crossing = resolved
			.filter((r) => !(r.fromEnd === a && r.toEnd === b) && !(r.fromEnd === b && r.toEnd === a))
			.map((r) => r.curve);
		const dashes = throughDashes(junction, ends, a, b).filter((m) => !crossesAny(m.pts, crossing));
		if (!dashes.length) continue;
		// Its lines meet the carried ones at the outline.
		carriedEnds.add(a.key);
		carriedEnds.add(b.key);
		for (const m of dashes) {
			const s = [0];
			for (let k = 1; k < m.pts.length; k++) s.push(s[k - 1] + dist(m.pts[k], m.pts[k - 1]));
			paintLine(m.pts, s, true, out.white);
			out.marks.push(m);
		}
		if (!sameLanes(a, b)) continue;
		// Its edge lines carry on too where no other road joins on that side
		// (a ring's inner edge along the apron); the side with the entry
		// breaks for it.
		const edges = (e: EndInfo) =>
			rowMarks(e.lanes.map((l) => ({ lane: l.lane, left: l.left, right: l.right })))
				.filter((m) => !m.dashed)
				.map((m) => ({ colour: m.colour, p: offsetPoint(e.frame.p, e.frame.n, m.o) }))
				.sort((p, q) => lateral(a, p.p) - lateral(a, q.p));
		const ea = edges(a);
		const eb = edges(b);
		if (ea.length !== eb.length) continue;
		const rest = ends.filter((e) => e !== a && e !== b);
		let inner: Paths | null = null;
		// Sides measured from the middle of the road's own width.
		const mid =
			(Math.min(...a.lanes.map((l) => l.left)) + Math.max(...a.lanes.map((l) => l.right))) / 2;
		const side = Math.sign(rest.reduce((sum, e) => sum + lateral(a, e.frame.p) - mid, 0));
		ea.forEach((m, i) => {
			if (eb[i].colour !== m.colour) return;
			// Only the edge away from every other road's mouth.
			if (rest.length && Math.sign(lateral(a, m.p) - mid) === side) return;
			if (!inner) inner = offset(union(asphalt), -0.3);
			const pts = curveBetween(
				m.p,
				neg(a.frame.out),
				eb[i].p,
				b.frame.out,
				Math.max(6, Math.ceil(dist(m.p, eb[i].p) / 1.2))
			);
			// Only where it stays on the junction's asphalt.
			if (!pts.slice(1, -1).every((q) => inside(inner!, q))) return;
			const s = [0];
			for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + dist(pts[k], pts[k - 1]));
			paintLine(pts, s, false, m.colour === 'white' ? out.white : out.yellow);
			out.marks.push({ colour: m.colour, dashed: false, pts });
		});
	}

	// Surfaces a walkway can cross: the junction's asphalt, and the roadway of
	// any end but the two it runs between.
	// Each end's roadway near its end, reaching back past any carriageway
	// that stops short (so a crossing at that carriageway's own end lands on
	// it).
	const roadways = new Map(
		ends.map((e) => [
			e,
			nearEnd(e, 8 + Math.max(0, ...e.lanes.map((l) => l.at.distance)), isRoadway)
		])
	);
	// Everything paved: the junction and every road's roadway near it.
	const pavedAll = union([...asphalt, ...[...roadways.values()].flat()]);
	// Each road's last few centimetres, whole and lane by lane, read once.
	const seamLanes = new Map(ends.map((e) => [e, nearEndLanes(e, SEAM + 0.1)]));
	const seams = new Map(ends.map((e) => [e, union([...seamLanes.get(e)!.values()].flat())]));
	const raisedNear = union(ends.flatMap((e) => nearEnd(e, 8, isRaised)));
	const footprints = union(ends.flatMap((e) => nearEnd(e, 12, () => true)));
	// Corner sidewalk may lap a little way over the roads' own sidewalks, so
	// the two always overlap at the seam.
	const lapped = subtract(
		footprints,
		union(ends.flatMap((e) => nearEnd(e, SEAM + 0.1, (l) => isWalk(l))))
	);
	// Medians stored to run right up to the outline (nose at 0) carry a
	// refuge where a crossing cuts through them.
	const squareMedians = union(
		ends.filter((e) => e.geo.road.noses?.[e.ref.end] === 0).flatMap((e) => nearEnd(e, 8, isRaised))
	);
	const islandPaths = islands.map((i) => i.path);
	// What corner sidewalk never covers, besides the roads.
	const blockers = union([...raisedNear, ...islandPaths, ...lapped]);
	const crossableFor = (a: EndInfo, b: EndInfo) =>
		union([...asphalt, ...ends.filter((e) => e !== a && e !== b).flatMap((e) => roadways.get(e)!)]);
	const pavement: Paths = [];
	const trail: Paths = [];
	const crossings: Crossing[] = [];
	const verges: Paths = [];
	// Two roads leaving side by side with grass on their facing edges (the
	// halves of a split avenue): the median carries on between them as
	// grass, however far apart they are moved, instead of bare ground.
	for (let i = 0; i < ends.length; i++) {
		for (let k = i + 1; k < ends.length; k++) {
			const a = ends[i];
			const b = ends[k];
			if (dot(a.frame.out, b.frame.out) < 0.9) continue;
			const ea = facingEdge(a, b.frame.p);
			const eb = facingEdge(b, a.frame.p);
			if (!ea || !eb) continue;
			const gap = dist(ea[0], eb[0]);
			const fill = subtract(
				intersect(
					[toPath([...ea, ...[...eb].reverse()])],
					offset(union([...nearEnd(a, 80, () => true), ...nearEnd(b, 80, () => true)]), gap / 2 + 1)
				),
				union([...nearEnd(a, 80, () => true), ...nearEnd(b, 80, () => true), ...asphalt])
			);
			verges.push(...fill);
		}
	}
	const crossDepth = new Map<string, number>();
	// Where a crossing rests on an island or a carried median.
	const refuges = union([
		...out.carried.filter((c) => c.surface !== 'hatch').flatMap((c) => c.paths),
		...islandPaths,
		...squareMedians
	]);
	for (const w of junction.walkways) {
		const ea = laneEndOf(ends, w.a);
		const eb = laneEndOf(ends, w.b);
		if (!ea || !eb) continue;
		let centre: Pt[] = [];
		let width = 0;
		let body: Paths = [];
		let stripes: Paths | null = null;
		let walkOnly = false;
		{
			const ca = outline.curbs.get(ea.end.key);
			const cb = outline.curbs.get(eb.end.key);
			if (ca && cb) {
				// Along the curb outline, outside it, as wide as the gap from curb
				// to the sidewalk's outer edge.
				const chain = chainBetween(outline, ea.end.key, eb.end.key);
				if (!chain) continue;
				// The band sits where the roads' sidewalks sit: from the curb out past
				// any verge, so the verge stays grass round the corner.
				const reach = (end: EndInfo, l: LaneEnd, at: Pt) => {
					const a = Math.abs(l.left - lateral(end, at));
					const b = Math.abs(l.right - lateral(end, at));
					return [Math.min(a, b), Math.max(a, b)];
				};
				// A bare walkway is only its crossings: full crossing depth from
				// the curb line.
				const [ia, oa] = w.bare ? [0, CROSSING_DEPTH] : reach(ea.end, ea.lane, ca.leave);
				const [ib, ob] = w.bare ? [0, CROSSING_DEPTH] : reach(eb.end, eb.lane, cb.arrive);
				width = (oa + ob) / 2;
				// The sidewalk's distance from the curb runs smoothly from one
				// road's to the other's, and the verge between them stays grass.
				const cutAway = union([...asphalt, ...roadways.get(ea.end)!, ...roadways.get(eb.end)!]);
				// Run the band a little way back into both roads, so it overlaps
				// their own sidewalks and no crack opens at the seam when an end
				// sits at a slight angle to the curb.
				const pts = densify(
					[
						offsetPoint(ca.leave, ea.end.frame.out, SEAM),
						...chain.pts,
						offsetPoint(cb.arrive, eb.end.frame.out, SEAM)
					],
					0.5
				);
				const outward = outwardSide(pts, asphalt);
				// Its inner edge follows the curb (past any verge), at the roads'
				// own widths all the way round. Where the two roads' sidewalk edges
				// meet ahead of both ends, the outer edge also rounds that corner in
				// one curve inside it, filling any dent where the curb turns
				// tightly; the curve never leaves the corner, so it can't bulge or
				// end in a point. Where an end runs past the other's edge, the band
				// alone is the corner.
				const band = ribbon(pts, ia, ib, oa, ob, outward);
				const outer = w.bare
					? null
					: fillet(
							outerEdge(ea.end, ea.lane, ca.leave),
							neg(ea.end.frame.out),
							outerEdge(eb.end, eb.lane, cb.arrive),
							neg(eb.end.frame.out)
						);
				body = subtract(
					outer
						? union([
								...band,
								toPath([...edgeAlong(pts, ia, ib, outward), ...[...outer].reverse()])
							])
						: band,
					cutAway
				);
				// Where it runs back over a road it takes on that road's own
				// sidewalk there exactly, and is smoothed together with it below,
				// so the two meet without a sliver or a tooth.
				const roadsHere = union([...seams.get(ea.end)!, ...seams.get(eb.end)!]);
				const sides = w.bare
					? []
					: union([
							...(seamLanes.get(ea.end)!.get(ea.lane.lane.id) ?? []),
							...(seamLanes.get(eb.end)!.get(eb.lane.lane.id) ?? [])
						]);
				body = union([...subtract(body, roadsHere), ...sides]);
				// Closed and opened by 10 cm: no dent where the band's pieces meet,
				// no zero-width sliver left along a curb.
				body = open(close(body, 0.1), 0.1);
				// The verge stops at every road mouth it passes (a driveway's
				// asphalt runs through it; only the sidewalk carries on across).
				if (!w.bare && (ia > 0.3 || ib > 0.3))
					verges.push(...subtract(ribbon(pts, 0, 0, ia, ib, outward), pavedAll));
				centre = chain.pts;
			} else {
				walkOnly = true;
				// A walk-only road at either end: straight on between them.
				// Straight across: a curve between two trail ends that don't
				// quite line up would kink into a chevron.
				centre = [ea.lane.point, eb.lane.point];
				width = Math.max(ea.lane.right - ea.lane.left, eb.lane.right - eb.lane.left);
				body = offsetLine(centre, width / 2);
			}
		}
		const solid = crossableFor(ea.end, eb.end);
		// A bare walkway is only where it crosses a road mouth.
		if (w.bare && ea.end !== eb.end)
			body = intersect(
				body,
				union(ends.filter((e) => e !== ea.end && e !== eb.end).flatMap((e) => roadways.get(e)!))
			);
		const over = intersect(body, solid);
		// Along a curb chain the stripes are laid square to each mouth they
		// cross, so they never fan or cross where the chain turns a corner.
		if (
			!stripes &&
			ea.end !== eb.end &&
			outline.curbs.has(ea.end.key) &&
			outline.curbs.has(eb.end.key)
		) {
			const pieces: Paths = [];
			for (const e of ends) {
				if (e === ea.end || e === eb.end) continue;
				const piece = intersect(over, roadways.get(e)!).flatMap(fromPath);
				if (piece.length === 0) continue;
				const depth = piece.map((q) =>
					dot({ x: q.x - e.frame.p.x, y: q.y - e.frame.p.y }, e.frame.out)
				);
				const lo = Math.min(...depth);
				const hi = Math.max(...depth);
				const reach =
					Math.max(
						...piece.map((q) =>
							Math.abs(dot({ x: q.x - e.frame.p.x, y: q.y - e.frame.p.y }, e.frame.n))
						)
					) + 1;
				const mid = offsetPoint(e.frame.p, e.frame.out, (lo + hi) / 2);
				pieces.push(
					...bars(
						[offsetPoint(mid, e.frame.n, -reach), offsetPoint(mid, e.frame.n, reach)],
						hi - lo
					)
				);
			}
			stripes = union(pieces);
		}
		// A crossing rests on an island or a carried median where it meets one;
		// a road's own median stops short of its crossings.
		const refuge = intersect(body, refuges);
		// Sidewalk paving never covers a road; roads draw their own lanes.
		const plain = subtract(subtract(body, solid), blockers);
		if (ea.end !== eb.end && !w.bare)
			(ea.lane.lane.kind === 'trail' || eb.lane.lane.kind === 'trail' ? trail : pavement).push(
				...plain
			);
		if (over.length === 0 && refuge.length === 0) continue;
		// A walkway laid across another road's mouth pushes that road's stop
		// line back behind it.
		if (w.on && ea.end !== eb.end) {
			for (const e of ends) {
				if (e === ea.end || e === eb.end) continue;
				const across = intersect(over, roadways.get(e)!);
				for (const q of across.flatMap(fromPath)) {
					const depth = dot({ x: q.x - e.frame.p.x, y: q.y - e.frame.p.y }, e.frame.out);
					crossDepth.set(e.key, Math.max(crossDepth.get(e.key) ?? 0, depth));
				}
			}
		}
		crossings.push({
			id: w.id,
			on: w.on,
			paved: w.paved,
			// No stripes over a refuge: it is paved.
			zebra: w.paved
				? []
				: intersect(stripes ?? union(bars(centre, width)), subtract(over, refuge)),
			paving: w.paved ? over : [],
			// A trail crossing a road runs on over that road's sidewalk and
			// verge right up to its zebra.
			trail: walkOnly ? subtract(body, union([...solid, ...islandPaths, ...refuge])) : [],
			refuge,
			hit: union([...over, ...refuge])
		});
	}

	// Lines carried across stay on the asphalt where a corner pulls the curb in.
	// Lines carried across stop at sidewalk laid across a mouth.
	// Lines carried across also break for a zebra laid across them.
	const sidewalkAcross = union(
		crossings.filter((c) => c.on).flatMap((c) => [...c.paving, ...c.hit, ...c.trail])
	);
	// Lines carried across stay inside the outline: they mustn't run on over a
	// road that has been pushed into the junction.
	const paved = subtract(
		union([...asphalt]),
		union([
			...sidewalkAcross,
			...[...roadways.values()].flat(),
			...islandPaths,
			...verges,
			...out.carried.filter((c) => c.surface !== 'hatch').flatMap((c) => c.paths)
		])
	);
	const clip = (polys: Pt[][]) => intersect(union(polys.map(toPath)), paved).map(fromPath);
	const intruders = offset(union([...roadways.values()].flat()), -0.1);
	for (const c of out.carried) {
		c.paths = subtract(c.paths, intruders);
		c.bars = subtract(c.bars, intruders);
	}
	// A carried line that runs into a road pushed into the junction is dropped.
	out.marks = out.marks.filter((m) => !m.pts.some((q) => inside(intruders, q)));
	// Stop and yield lines across each controlled approach, arrows, badges.
	const white: Pt[][] = clip(out.white);
	const yellow: Pt[][] = clip(out.yellow);
	const badges: JunctionDraw['badges'] = [];
	const setbacks = new Map<string, number>();
	for (const end of ends) {
		const across = crossDepth.get(end.key);
		setbacks.set(
			end.key,
			approachSetback(junction, end.geo.road, end.geo.path.length, end.ref.end) +
				(across ? across + 0.3 : 0)
		);
	}
	for (const end of ends) {
		const incoming = end.lanes.filter((l) => l.flow === 'in' && isTravel(l.lane));
		if (incoming.length === 0) continue;
		const control = junction.control[end.key] ?? 'none';
		const setback = setbacks.get(end.key)!;
		// Distances back from each lane's own end (a carriageway may stop short).
		const atL = (l: LaneEnd, back: number) =>
			frameAt(end.geo.path, end.ref.end === 'start' ? l.at.distance + back : l.at.distance - back);
		const lo = Math.min(...incoming.map((l) => l.left));
		const hi = Math.max(...incoming.map((l) => l.right));
		const fb = atL(incoming[0], 6);
		badges.push({
			key: end.key,
			p: offsetPoint(fb.p, fb.n, (lo + hi) / 2 > 0 ? hi + 2 : lo - 2),
			control
		});
		// What each lane may do: through, left, right or a U-turn.
		const movesOf = new Map(
			incoming.map((l) => {
				const moves = new Set<string>();
				for (const r of resolved) {
					if (laneKey(r.c.from) !== laneKey(l.ref)) continue;
					const dIn = neg(end.frame.out);
					const dOut = r.toEnd.frame.out;
					const ahead = dot(dIn, dOut);
					const turn = dIn.x * dOut.y - dIn.y * dOut.x;
					moves.add(ahead > 0.7 ? 'through' : ahead < -0.7 ? 'u' : turn > 0 ? 'right' : 'left');
				}
				return [l, moves];
			})
		);
		// Arrows where traffic stops, and on any approach with a lane that
		// can't go straight on (a turn lane) even where it doesn't.
		const turnLane = [...movesOf.values()].some((m) => m.size > 0 && !m.has('through'));
		if (control === 'none' && !turnLane && !junction.arrows?.includes(end.key)) continue;
		// One bar (or one row of give-way teeth) across each run of incoming
		// lanes that end at the same place.
		const runs = new Map<number, LaneEnd[]>();
		for (const l of incoming) {
			const k = Math.round(l.at.distance * 10);
			runs.set(k, [...(runs.get(k) ?? []), l]);
		}
		for (const run of control === 'none' ? [] : runs.values()) {
			const f = atL(run[0], setback - STOP_GAP / 2);
			const rl = Math.min(...run.map((l) => l.left));
			const rh = Math.max(...run.map((l) => l.right));
			if (control === 'yield') {
				for (let x = rl + 0.3; x + 0.6 <= rh - 0.1; x += 0.9) {
					const a = offsetPoint(f.p, f.n, x);
					const b = offsetPoint(f.p, f.n, x + 0.6);
					white.push([a, b, offsetPoint(offsetPoint(f.p, f.n, x + 0.3), end.frame.out, 1.0)]);
				}
				// The give-way line itself: short dashes just ahead of the teeth.
				const g = atL(run[0], setback - STOP_GAP / 2 - 0.35);
				for (let x = rl + 0.2; x + 0.5 <= rh - 0.1; x += 0.9) {
					white.push(quad(offsetPoint(g.p, g.n, x), offsetPoint(g.p, g.n, x + 0.5), 0.1));
				}
			} else {
				white.push(quad(offsetPoint(f.p, f.n, rl + 0.15), offsetPoint(f.p, f.n, rh - 0.15), 0.25));
			}
		}
		for (const l of incoming) {
			const moves = movesOf.get(l)!;
			if (
				!moves.size ||
				setback + 9 >
					l.at.distance + (end.ref.end === 'start' ? end.geo.path.length - 2 * l.at.distance : 0)
			)
				continue;
			const fa = atL(l, setback + 6);
			const base = offsetPoint(fa.p, fa.n, (l.left + l.right) / 2);
			// Along the lane where the arrow sits (the road may curve).
			const dIn = end.ref.end === 'end' ? fa.t : neg(fa.t);
			const tip = offsetPoint(base, dIn, 3);
			// A turn-only arrow's stem stops where it turns.
			white.push(quad(base, moves.has('through') ? tip : offsetPoint(tip, dIn, -0.6), 0.12));
			const side = { x: -dIn.y, y: dIn.x };
			for (const m of moves) {
				if (m === 'through') {
					white.push([
						offsetPoint(tip, side, 0.4),
						offsetPoint(tip, side, -0.4),
						offsetPoint(tip, dIn, 0.8)
					]);
					continue;
				}
				const sign = m === 'right' ? 1 : -1;
				const elbow = offsetPoint(tip, dIn, -0.6);
				const o = offsetPoint(elbow, side, sign * 0.6);
				white.push(quad(elbow, o, 0.12));
				const dir = m === 'u' ? neg(dIn) : { x: side.x * sign, y: side.y * sign };
				const perp = { x: -dir.y, y: dir.x };
				white.push([
					offsetPoint(o, perp, 0.35),
					offsetPoint(o, perp, -0.35),
					offsetPoint(o, dir, 0.5)
				]);
			}
		}
	}
	const mouths = [...outline.curbs.values()].map((c) => ({
		key: c.end.key,
		pts: c.mouth,
		out: c.end.frame.out
	}));

	return {
		outline: outline.polygon,
		asphalt,
		islands,
		carried: out.carried,
		pavement: union(pavement),
		verges: union(verges),
		trail: union(trail),
		crossings,
		white,
		yellow,
		marks: out.marks,
		curves,
		badges,
		laneDots: ends.flatMap((e) =>
			e.lanes.filter((l) => l.flow !== 'none').map((l) => ({ p: l.point, flow: l.flow }))
		),
		carriedEnds,
		setbacks,
		mouths
	};
}
