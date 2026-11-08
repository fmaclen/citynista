// Where one road meets just one other (a road carrying on, a bend, a change
// of cross-section) the drawing follows the connections and nothing else.
// The whole width between the two road ends is paved; each connected lane
// runs across as a band from its lane on one side to its lane on the other,
// in its own surface; a lane with no connection simply ends, leaving the
// paving. Car connections rank highest: where one crosses a median, grass or
// sidewalk band, the road shows and that band stops there.
//
// Paint goes between neighbours, as on a real road: at every station across
// the node the car paths are put in order across it, and each boundary
// between two side by side gets what those two lanes call for (dashed white
// between lanes going the same way, double yellow between opposing ones, an
// edge line where a path has no car path beside it). Paths that overlap
// (branching, merging or crossing) have no line between them there.

import { subtract, toPath, union, type Paths } from './clip';
import { curveBetween, offsetPoint } from './geometry';
import {
	connectionCurve,
	laneEndOf,
	type Curve,
	type EndInfo,
	type JunctionDraw,
	type LaneEnd
} from './junction';
import { laneKey, type Junction, type Pt } from './model';
import {
	INSET,
	LINE,
	chainLines,
	isTravel,
	isWalk,
	paintLine,
	type Mark,
	type RowMark
} from './road';
import { lateral } from './connect';

const neg = (a: Pt) => ({ x: -a.x, y: -a.y });

// How far a band laps back over the roads at either end, so no seam opens
// where it meets them.
const LAP = 0.3;
// Stations across the node at which the paths are put in order.
const STATIONS = 32;
// Two paths closer than this edge to edge are side by side; further apart
// something (a median, hatching) lies between them.
const BESIDE = 0.6;
// Paths overlapping by more than this share road there: no line between.
const SHARED = 0.4;

// A band along a curve, as wide as the curve's widths, between two fractions
// of its length.
function band(curve: Curve, from = 0, to = 1) {
	const pts = curve.points;
	const last = pts.length - 1;
	const left: Pt[] = [];
	const right: Pt[] = [];
	for (let i = Math.round(from * last); i <= Math.round(to * last); i++) {
		const a = pts[Math.max(0, i - 1)];
		const b = pts[Math.min(last, i + 1)];
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
		// Right of the direction of travel (y grows downward).
		const r = { x: -t.y, y: t.x };
		const h = curve.widths[i] / 2;
		const lap = i === 0 ? -LAP : i === last ? LAP : 0;
		const p = offsetPoint(pts[i], t, lap);
		left.push(offsetPoint(p, r, -h));
		right.push(offsetPoint(p, r, h));
	}
	return { left, right, path: toPath([...right, ...left.reverse()]) };
}

// A curve's point and width a fraction of the way along it.
function at(curve: Curve, u: number) {
	const last = curve.points.length - 1;
	const x = Math.max(0, Math.min(last, u * last));
	const i = Math.min(last - 1, Math.floor(x));
	const f = x - i;
	const p = curve.points[i];
	const q = curve.points[i + 1];
	return {
		p: { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f },
		w: curve.widths[i] + (curve.widths[i + 1] - curve.widths[i]) * f
	};
}

// A solid line from a to b, as one quad.
function bar(a: Pt, b: Pt): Pt[] {
	const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
	const n = { x: (-(b.y - a.y) / l) * (LINE / 2), y: ((b.x - a.x) / l) * (LINE / 2) };
	return [offsetPoint(a, n, 1), offsetPoint(b, n, 1), offsetPoint(b, n, -1), offsetPoint(a, n, -1)];
}

const lengthOf = (pts: Pt[]) =>
	pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);

// A point a fraction of the way along a polyline's samples.
function along(pts: Pt[], u: number) {
	const x = Math.max(0, Math.min(pts.length - 1, u * (pts.length - 1)));
	const i = Math.min(pts.length - 2, Math.floor(x));
	const f = x - i;
	return {
		x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
		y: pts[i].y + (pts[i + 1].y - pts[i].y) * f
	};
}

// Whether a sidewalk connection runs from one side of the carriageway to the
// other (an old way of storing a crossing; see place.ts).
export function crossesRoadway(a: EndInfo, la: LaneEnd, b: EndInfo, lb: LaneEnd) {
	const span = (e: EndInfo, into: boolean) => {
		const lats = e.lanes
			.filter((l) => isTravel(l.lane))
			.flatMap((l) => [
				lateral(e, { ...l, left: l.left, right: l.left }, into),
				lateral(e, { ...l, left: l.right, right: l.right }, into)
			]);
		return lats.length ? { lo: Math.min(...lats), hi: Math.max(...lats) } : null;
	};
	const sa = span(a, true);
	const sb = span(b, false);
	if (!sa || !sb) return false;
	const pa = lateral(a, la, true);
	const pb = lateral(b, lb, false);
	return (pa < sa.lo && pb > sb.hi) || (pa > sa.hi && pb < sb.lo);
}

// A node's two sides, when its lanes find their way across it from one to
// the other: its two ends, or, where roads are attached at an edge
// (`junction.sides`), each road with those attached beside it going its way.
// Each side is led by a road not attached at an edge where there is one.
export function linkSides(junction: Junction, ends: EndInfo[]): [EndInfo[], EndInfo[]] | null {
	if (ends.length === 2) return [[ends[0]], [ends[1]]];
	const attached = new Set(junction.sides ?? []);
	if (!ends.some((e) => attached.has(e.key))) return null;
	const mains = ends.filter((e) => !attached.has(e.key));
	if (mains.length > 2) return null;
	const lead = mains[0] ?? ends[0];
	const dot = (p: Pt, q: Pt) => p.x * q.x + p.y * q.y;
	const a = ends.filter(
		(e) =>
			e === lead || (e !== mains[1] && attached.has(e.key) && dot(e.frame.out, lead.frame.out) > 0)
	);
	const b = ends.filter((e) => !a.includes(e));
	if (!b.length) return null;
	b.sort((x, y) => Number(attached.has(x.key)) - Number(attached.has(y.key)));
	return [a, b];
}

// The outer edges of the paving between two sides (looking from a to b),
// each the outermost lane edge of any of a side's roads, across its leading
// road.
function sideCurves(sa: EndInfo[], sb: EndInfo[]) {
	const [a, b] = [sa[0], sb[0]];
	const edge = (side: EndInfo[], right: boolean, into: boolean) => {
		const ref = side[0];
		const sign = ((ref.ref.end === 'end') === into) === right ? 1 : -1;
		let best = ref.frame.p;
		let reach = -Infinity;
		for (const e of side)
			for (const l of e.lanes)
				for (const o of [l.left, l.right]) {
					const p = offsetPoint(e.frame.p, e.frame.n, o);
					const s =
						sign * ((p.x - ref.frame.p.x) * ref.frame.n.x + (p.y - ref.frame.p.y) * ref.frame.n.y);
					if (s > reach) {
						reach = s;
						best = p;
					}
				}
		return best;
	};
	const side = (right: boolean) =>
		curveBetween(edge(sa, right, true), neg(a.frame.out), edge(sb, right, false), b.frame.out, 16);
	return { left: side(false), right: side(true) };
}

// The dashed lines between neighbouring lanes running straight across a
// junction from one road end to another and back: a road carrying on
// through it keeps its lane lines.
export function throughDashes(junction: Junction, ends: EndInfo[], a: EndInfo, b: EndInfo) {
	const cars: { fromEnd: EndInfo; curve: Curve }[] = [];
	for (const c of junction.connections) {
		const from = laneEndOf(ends, c.from);
		const to = laneEndOf(ends, c.to);
		if (!from || !to || !isTravel(from.lane.lane)) continue;
		const across = (from.end === a && to.end === b) || (from.end === b && to.end === a);
		if (across)
			cars.push({
				fromEnd: from.end,
				curve: connectionCurve(from.lane, from.end, to.lane, to.end)
			});
	}
	if (cars.length < 2) return [];
	const { left, right } = sideCurves([a], [b]);
	return paint(cars, (e) => e === a, true, a, b, left, right).lines.filter((l) => l.dashed);
}

export function buildLink(
	junction: Junction,
	ends: EndInfo[],
	// Lanes (by lane key) that carry on into roads drawn apart from this one.
	elsewhere: Set<string> = new Set()
): JunctionDraw {
	const [sa, sb] = linkSides(junction, ends) ?? [[ends[0]], ends.slice(1)];
	const [a, b] = [sa[0], sb[0]];
	const attached = new Set(junction.sides ?? []);
	// A road carrying on through with roads attached beside it: the road is
	// drawn as any two road ends are, and each attached road's lanes join it
	// as bands of their own, edge lines and all.
	if ((sa.length > 1 || sb.length > 1) && !attached.has(a.key) && !attached.has(b.key)) {
		const pair = (r: { road: string; end: string }) =>
			[a, b].some((e) => e.ref.road === r.road && e.ref.end === r.end);
		const main = buildLink(
			{
				...junction,
				sides: undefined,
				connections: junction.connections.filter((c) => pair(c.from) && pair(c.to))
			},
			[a, b],
			new Set(
				junction.connections
					.filter((c) => !(pair(c.from) && pair(c.to)))
					.flatMap((c) => [laneKey(c.from), laneKey(c.to)])
			)
		);
		const side: { fromEnd: EndInfo; curve: Curve }[] = [];
		for (const c of junction.connections) {
			if (pair(c.from) && pair(c.to)) continue;
			const from = laneEndOf(ends, c.from);
			const to = laneEndOf(ends, c.to);
			if (!from || !to || from.end === to.end || !isTravel(from.lane.lane)) continue;
			side.push({
				fromEnd: from.end,
				curve: connectionCurve(from.lane, from.end, to.lane, to.end)
			});
		}
		if (!side.length) return main;
		const { left, right } = sideCurves(sa, sb);
		// Its lines are white: where it parts from the road it parts from
		// traffic going its way.
		const paths = paint(side, (e) => sa.includes(e), false, a, b, left, right);
		paths.white.push(...paths.yellow);
		paths.yellow = [];
		for (const m of paths.lines) m.colour = 'white';
		const keys = ends.map((e) => e.key);
		return {
			...main,
			asphalt: union([...main.asphalt, ...side.map((c) => band(c.curve).path)]),
			white: [...main.white, ...paths.white],
			yellow: [...main.yellow, ...paths.yellow],
			marks: [...main.marks, ...paths.lines],
			curves: [...main.curves, ...side.map((c) => c.curve)],
			laneDots: ends.flatMap((e) =>
				e.lanes.filter((l) => isTravel(l.lane)).map((l) => ({ p: l.point, flow: l.flow }))
			),
			carriedEnds: new Set(keys),
			setbacks: new Map(keys.map((k) => [k, 0]))
		};
	}

	const { left, right } = sideCurves(sa, sb);

	const cars: { from: LaneEnd; fromEnd: EndInfo; to: LaneEnd; toEnd: EndInfo; curve: Curve }[] = [];
	const others: { from: LaneEnd; to: LaneEnd; curve: Curve }[] = [];
	for (const c of junction.connections) {
		const from = laneEndOf(ends, c.from);
		const to = laneEndOf(ends, c.to);
		if (!from || !to || from.end === to.end) continue;
		const curve = connectionCurve(from.lane, from.end, to.lane, to.end);
		if (isTravel(from.lane.lane))
			cars.push({ from: from.lane, fromEnd: from.end, to: to.lane, toEnd: to.end, curve });
		else others.push({ from: from.lane, to: to.lane, curve });
	}

	const carBands = cars.map((c) => band(c.curve));
	const roadway = union(carBands.map((x) => x.path));
	// The paving: the full width from one side to the other, or where roads
	// attached at an edge part from the others, wherever a lane runs.
	// Where roads attached at an edge part from the others, the paving is
	// only where car lanes and medians run, and sidewalks lie under any road
	// beside them (a slip lane cuts across the sidewalk it passes).
	const parted = sa.length > 1 || sb.length > 1;
	const paving = parted
		? union([
				...roadway,
				...others.filter((o) => !isWalk(o.from.lane)).map((o) => band(o.curve).path)
			])
		: union([toPath([...right, ...[...left].reverse()])]);

	// A band takes its lane's surface on the way out of one road and the other
	// lane's on the way into the next (a median running into hatching).
	const surfaces = new Map<string, Paths>();
	const surfaceOf = (lane: LaneEnd['lane']) =>
		lane.kind === 'walk' ? 'pavement' : lane.kind === 'trail' ? 'trail' : lane.surface;
	for (const o of others) {
		for (const [lane, f0, f1] of [
			[o.from.lane, 0, 0.5],
			[o.to.lane, 0.5, 1]
		] as const) {
			const surface = surfaceOf(lane);
			const paths = subtract([band(o.curve, f0, f1).path], roadway);
			surfaces.set(surface, [...(surfaces.get(surface) ?? []), ...paths]);
		}
	}
	const fill = (surface: string) => union(surfaces.get(surface) ?? []);

	const { white, yellow, lines } = paint(
		cars,
		(e) => sa.includes(e),
		sa.length === 1 && sb.length === 1,
		a,
		b,
		left,
		right
	);

	// A car lane whose traffic goes nowhere across the node ends there: a
	// line across its end says so.
	for (const e of ends)
		for (const l of e.lanes) {
			if (!isTravel(l.lane) || l.flow !== 'in') continue;
			if (cars.some((c) => c.from === l) || elsewhere.has(laneKey(l.ref))) continue;
			const at = offsetPoint(l.at.p, e.frame.out, LINE / 2 + 0.05);
			white.push(bar(offsetPoint(at, l.at.n, l.left), offsetPoint(at, l.at.n, l.right)));
		}

	const keys = ends.map((e) => e.key);
	return {
		outline: [],
		asphalt: paving,
		islands: parted
			? []
			: [
					...fill('pavement').map((path) => ({ path, surface: 'pavement' as const })),
					...fill('trail').map((path) => ({ path, surface: 'pavement' as const }))
				],
		verges: fill('grass'),
		carried: [
			{ paths: fill('concrete'), surface: 'concrete', line: 'white', bars: [] },
			{ paths: fill('hatch'), surface: 'hatch', line: 'white', bars: [] }
		],
		pavement: parted ? union([...fill('pavement'), ...fill('trail')]) : [],
		trail: [],
		crossings: [],
		white,
		yellow,
		marks: lines,
		curves: cars.map((c) => c.curve),
		badges: [],
		laneDots: ends.flatMap((e) =>
			e.lanes.filter((l) => isTravel(l.lane)).map((l) => ({ p: l.point, flow: l.flow }))
		),
		carriedEnds: new Set(keys),
		setbacks: new Map(keys.map((k) => [k, 0])),
		mouths: []
	};
}

// The paint between neighbouring car paths (see the top of this file).
function paint(
	cars: { fromEnd: EndInfo; curve: Curve }[],
	onA: (e: EndInfo) => boolean,
	smooth: boolean,
	a: EndInfo,
	b: EndInfo,
	left: Pt[],
	right: Pt[]
) {
	const white: Pt[][] = [];
	const yellow: Pt[][] = [];
	const lines: Mark[] = [];
	// Every path read from end a to end b, with which way its traffic runs.
	const paths = cars.map((c, id) => {
		const forward = onA(c.fromEnd);
		// Where the path ends up across the node, to order paths that start
		// out on top of each other.
		const across = (u: number) => {
			const p = at(c.curve, forward ? u : 1 - u).p;
			const lo = along(left, u);
			const hi = along(right, u);
			const l = Math.hypot(hi.x - lo.x, hi.y - lo.y) || 1;
			return ((p.x - lo.x) * (hi.x - lo.x) + (p.y - lo.y) * (hi.y - lo.y)) / l;
		};
		return { id, curve: c.curve, forward, start: across(0), part: across(1) };
	});
	// Two paths that change places across the node cross each other.
	const swap = (p: (typeof paths)[number], q: (typeof paths)[number]) =>
		(p.start - q.start) * (p.part - q.part) < -0.25;
	// The node's frame at a fraction u of the way across it, and each path's
	// edges measured across it there.
	const crossAt = (u: number) => {
		const lo = along(left, u);
		const hi = along(right, u);
		const span = Math.hypot(hi.x - lo.x, hi.y - lo.y) || 1;
		const across = { x: (hi.x - lo.x) / span, y: (hi.y - lo.y) / span };
		const project = (p: Pt) => (p.x - lo.x) * across.x + (p.y - lo.y) * across.y;
		const here = paths.map((path) => {
			const { p, w } = at(path.curve, path.forward ? u : 1 - u);
			const c = project(p);
			return { path, lo: c - w / 2, hi: c + w / 2 };
		});
		return { lo, across, project, here };
	};
	// The outermost edges of the car paths run smoothly from one end to the
	// other, like the verge beside them, instead of tracing the outline of
	// whichever paths are outermost (a kink where two of them swap).
	const kerb = (side: 'lo' | 'hi') => {
		const ends = [crossAt(0), crossAt(1)].map((x) => {
			const c =
				side === 'lo' ? Math.min(...x.here.map((q) => q.lo)) : Math.max(...x.here.map((q) => q.hi));
			return offsetPoint(x.lo, x.across, c);
		});
		return curveBetween(ends[0], neg(a.frame.out), ends[1], b.frame.out, STATIONS);
	};
	// (Where roads attached at an edge part from the others, the paving is
	// only where lanes run: the edges follow the paths themselves.)
	const kerbs = paths.length && smooth ? { lo: kerb('lo'), hi: kerb('hi') } : null;
	// Stations a little over a metre apart, measured along the node's middle.
	const step = (lengthOf(left) + lengthOf(right)) / 2 / STATIONS || 1;
	const stations: { d: number; marks: RowMark[]; lo: Pt; across: Pt }[] = [];
	for (let k = 0; k <= STATIONS; k++) {
		const u = k / STATIONS;
		const { lo, across, project, here: unsorted } = crossAt(u);
		// Paths on top of each other go in the order they part.
		const here = unsorted.sort((x, y) => x.lo + x.hi - (y.lo + y.hi) || x.path.part - y.path.part);
		const marks: RowMark[] = [];
		// Where paths that cross each other overlap, nothing is painted
		// between any of the paths overlapping there.
		const crossing = new Set<number>();
		for (let i = 0; i < here.length; ) {
			let j = i;
			while (j + 1 < here.length && here[j + 1].lo - here[j].hi < -SHARED) j++;
			const group = here.slice(i, j + 1);
			if (group.some((p) => group.some((q) => swap(p.path, q.path))))
				for (const g of group) crossing.add(g.path.id);
			i = j + 1;
		}
		// An edge line on one side of a path: white on the driver's right,
		// and on the left too where the next path that way runs the same
		// way; yellow otherwise.
		const edge = (i: number, side: 1 | -1) => {
			const q = here[i];
			const driverRight = (side === 1) === q.path.forward;
			const beyond = here[i + side];
			const colour =
				driverRight || (beyond && beyond.path.forward === q.path.forward) ? 'white' : 'yellow';
			const outer = !beyond && kerbs ? project(along(side === 1 ? kerbs.hi : kerbs.lo, u)) : null;
			const o = side === 1 ? (outer ?? q.hi) - INSET : (outer ?? q.lo) + INSET;
			marks.push({ o, colour, dashed: false });
		};
		here.forEach((q, i) => {
			const next = here[i + 1];
			if (i === 0) edge(i, -1);
			if (!next) {
				edge(i, 1);
				return;
			}
			const gap = next.lo - q.hi;
			if (gap < -SHARED) return;
			if (gap > BESIDE) {
				edge(i, 1);
				edge(i + 1, -1);
				return;
			}
			if (crossing.has(q.path.id) || crossing.has(next.path.id)) return;
			const mid = (q.hi + next.lo) / 2;
			if (q.path.forward === next.path.forward)
				marks.push({ o: mid, colour: 'white', dashed: true });
			else {
				// The double yellow, each line at its own path's edge while the
				// two are apart, so it runs on unbroken as they come together.
				const a = gap > 0 ? q.hi : mid;
				const b = gap > 0 ? next.lo : mid;
				marks.push({ o: a - INSET, colour: 'yellow', dashed: false });
				marks.push({ o: b + INSET, colour: 'yellow', dashed: false });
			}
		});
		stations.push({ d: k * step, marks, lo, across });
	}
	// However short the node, its lines join the roads' either side.
	for (const line of chainLines(stations, Math.min(1, step * STATIONS * 0.5))) {
		const pts = line.d.map((d, i) => {
			const s = stations[Math.round(d / step)];
			return offsetPoint(s.lo, s.across, line.o[i]);
		});
		const along = [0];
		for (let i = 1; i < pts.length; i++)
			along.push(along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
		const { colour, dashed } = line.mark;
		paintLine(pts, along, dashed, colour === 'white' ? white : yellow);
		lines.push({ colour, dashed, pts });
	}
	return { white, yellow, lines };
}
