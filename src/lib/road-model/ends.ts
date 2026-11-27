// A node's road ends: each end's frame and the lanes that reach it
// (`endsOf`), a lane end looked up by reference, and the curve a
// connection drives from one lane end to another.

import { toPath } from './clip';
import {
	crosses,
	crossSection,
	curveBetween,
	dist,
	dot,
	type EndFrame,
	endFrame,
	frameAt,
	type LaneSpan,
	neg,
	offsetPoint,
	type PathSample,
	stepsAcross,
	TAPER
} from './geometry';
import {
	endKey,
	type EndRef,
	type Junction,
	type Lane,
	type LaneRef,
	type Pt,
	type Road
} from './model';

export interface RoadGeo {
	road: Road;
	path: PathSample;
}

export interface LaneEnd {
	ref: LaneRef;
	lane: Lane;
	point: Pt;
	left: number;
	right: number;
	flow: 'in' | 'out' | 'both' | 'none';
}

export interface EndInfo {
	ref: EndRef;
	key: string;
	geo: RoadGeo;
	frame: EndFrame;
	lanes: LaneEnd[];
}

export function endsOf(junction: Pick<Junction, 'ends'>, roads: Map<string, RoadGeo>): EndInfo[] {
	const out: EndInfo[] = [];
	for (const ref of junction.ends) {
		const geo = roads.get(ref.road);
		if (!geo) continue;
		const frame = endFrame(geo.road, geo.path, ref.end);
		const lanes = frame.spans
			.filter((span) => span.right - span.left > 0.05)
			.map((span) => {
				const lane = span.lane;
				let flow: LaneEnd['flow'] = 'none';
				if (lane.dir === 'both') flow = 'both';
				else if (lane.dir === 'fwd') flow = ref.end === 'end' ? 'in' : 'out';
				else if (lane.dir === 'back') flow = ref.end === 'start' ? 'in' : 'out';
				return {
					ref: { ...ref, lane: lane.id },
					lane,
					point: offsetPoint(frame.p, frame.n, (span.left + span.right) / 2),
					left: span.left,
					right: span.right,
					flow
				};
			});
		out.push({ ref, key: endKey(ref), geo, frame, lanes });
	}
	return out;
}

export interface Curve {
	from: LaneEnd;
	to: LaneEnd;
	points: Pt[];
	widths: number[];
}

export function connectionCurve(
	from: LaneEnd,
	fromEnd: EndInfo,
	to: LaneEnd,
	toEnd: EndInfo,
	samples = stepsAcross(dist(from.point, to.point))
): Curve {
	const p0 = from.point;
	const p3 = to.point;
	const points = curveBetween(p0, neg(fromEnd.frame.run), p3, toEnd.frame.run, samples);
	const w0 = from.right - from.left;
	const w1 = to.right - to.left;
	// Widths blend as the path moves across (TAPER.EASE).
	const widths = points.map((_, i) => w0 + (w1 - w0) * TAPER.EASE(i / samples));
	return { from, to, points, widths };
}

// A line through nodes merged into one by way of the roads merged away
// between them: from `p` leaving along `dir`, along each road of `via` from
// the end it is entered by, `at` metres right of its drawn line at each
// station (given its cross-section there and whether it is walked from its
// start), across each node between on an even curve, to `q` arriving along
// `run`. So what follows those roads is drawn the same whether or not a
// node of theirs sits between. Each point has the width `at` gives there,
// blended across a node from `w0` at `p` to `w1` at `q`; `steps` is how
// many pieces a curve across a node of that chord takes.
export function alongVia(
	p: Pt,
	w0: number,
	dir: Pt,
	via: EndInfo[],
	at: (spans: LaneSpan[], forward: boolean, i: number) => { o: number; w: number },
	q: Pt,
	w1: number,
	run: Pt,
	steps = stepsAcross
) {
	const points: Pt[] = [p];
	const widths = [w0];
	let heading = dir;
	const across = (to: Pt, w: number, t: Pt) => {
		const from = points[points.length - 1];
		const wFrom = widths[widths.length - 1];
		const n = steps(dist(from, to));
		curveBetween(from, heading, to, t, n)
			.slice(1)
			.forEach((x, i) => {
				points.push(x);
				widths.push(wFrom + (w - wFrom) * TAPER.EASE((i + 1) / n));
			});
	};
	via.forEach((h, i) => {
		const { road, path } = h.geo;
		const forward = h.ref.end === 'start';
		(forward ? path.s : [...path.s].reverse()).forEach((d, k) => {
			const f = frameAt(path, d);
			const { o, w } = at(crossSection(road, d), forward, i);
			const x = offsetPoint(f.p, f.n, o);
			const t = forward ? f.t : neg(f.t);
			if (k === 0) across(x, w, t);
			else {
				points.push(x);
				widths.push(w);
			}
			heading = t;
		});
	});
	across(q, w1, run);
	const keep = points.map((x, i) => i === 0 || dist(x, points[i - 1]) > 0.01);
	return { points: points.filter((_, i) => keep[i]), widths: widths.filter((_, i) => keep[i]) };
}

// A connection's path chained through roads merged away (Connection.via):
// along the lane it takes on each, `parts` holding their ends.
export function chainCurve(
	from: LaneEnd,
	fromEnd: EndInfo,
	via: LaneRef[],
	parts: EndInfo[],
	to: LaneEnd,
	toEnd: EndInfo
): Curve | null {
	const roads = via.map((ref) =>
		parts.find((e) => e.ref.road === ref.road && e.ref.end === ref.end)
	);
	if (roads.some((e) => !e)) return null;
	const { points, widths } = alongVia(
		from.point,
		from.right - from.left,
		neg(fromEnd.frame.run),
		roads as EndInfo[],
		(spans, _, i) => {
			const span = spans.find((s) => s.lane.id === via[i].lane) ?? spans[0];
			return { o: (span.left + span.right) / 2, w: span.right - span.left };
		},
		to.point,
		to.right - to.left,
		toEnd.frame.run
	);
	return { from, to, points, widths };
}

// The ground a car path sweeps, as wide as its widths, run 0.3 m back over
// the road at either end: what lies beside a line is asked of it.
export function band(curve: Curve) {
	const pts = curve.points;
	const last = pts.length - 1;
	const left: Pt[] = [];
	const right: Pt[] = [];
	pts.forEach((q, i) => {
		const a = pts[Math.max(0, i - 1)];
		const b = pts[Math.min(last, i + 1)];
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
		// Right of the direction of travel (y grows downward).
		const r = { x: -t.y, y: t.x };
		const h = curve.widths[i] / 2;
		const p = offsetPoint(q, t, i === 0 ? -0.3 : i === last ? 0.3 : 0);
		left.push(offsetPoint(p, r, -h));
		right.push(offsetPoint(p, r, h));
	});
	return { left, right, path: toPath([...right, ...[...left].reverse()]) };
}

// A node's two sides, when its lanes find their way across it from one to
// the other: its two ends, or the sides core/place.ts sorted its ends into
// (`junction.link`), each led by its first. Nothing here reads a heading:
// where the roads are trimmed back to must never change which side one is on.
export function linkSides(junction: Junction, ends: EndInfo[]): [EndInfo[], EndInfo[]] | null {
	if (ends.length === 2) return [[ends[0]], [ends[1]]];
	if (!junction.link) return null;
	const side = (keys: string[]) => keys.flatMap((key) => ends.filter((e) => e.key === key));
	const [a, b] = junction.link.map(side);
	return a.length && b.length ? [a, b] : null;
}

// Whether a polyline crosses any of the curves (a turning movement over a
// lane line).
export function crossesAny(pts: Pt[], curves: Curve[]) {
	for (const c of curves)
		for (let i = 1; i < pts.length; i++)
			for (let k = 1; k < c.points.length; k++)
				if (crosses(pts[i - 1], pts[i], c.points[k - 1], c.points[k])) return true;
	return false;
}

export const angleOf = (end: EndInfo, centre: Pt) =>
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

export const lateral = (end: EndInfo, p: Pt) =>
	dot({ x: p.x - end.frame.p.x, y: p.y - end.frame.p.y }, end.frame.n);
