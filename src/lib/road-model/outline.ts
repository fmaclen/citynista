// A node's curb outline: each road end's curb points, the corner curves
// between neighbouring ends, and the mouth straight across each roadway.

import { angleOf, centreOf, type EndInfo, type LaneEnd, lateral } from './ends';
import { cubic, curveBetween, dedupe, dist, dot, neg, offsetPoint, TAPER } from './geometry';
import { type Pt, isRoadway } from './model';

// The curb outline's corners: one between each pair of neighbouring road
// ends with a roadway (of the lanes `counts` keeps), by angle round the
// junction.
function cornersOf(ends: EndInfo[], counts: Counts) {
	const kerbed = ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane) && counts(l)));
	const centre = centreOf(kerbed);
	const sorted = [...kerbed].sort((a, b) => angleOf(a, centre) - angleOf(b, centre));
	if (sorted.length < 2) return [];
	return sorted.map((a, i) => ({ a: a.key, b: sorted[(i + 1) % sorted.length].key }));
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

// How far a road end may sit inside a neighbour's curb line and still have
// its corner run straight along both edges (automatic setbacks overlap by a
// tenth of a metre, more at a sharp angle).
const OVERLAP = 1;

// Which of a road end's lanes its curbs are read from.
type Counts = (lane: LaneEnd) => boolean;

function curbsOf(ends: EndInfo[], counts: Counts) {
	const kerbed = ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane) && counts(l)));
	const centre = centreOf(kerbed);
	const curbs = new Map<string, Curb>();
	for (const end of kerbed) {
		const roadway = end.lanes.filter((l) => isRoadway(l.lane) && counts(l));
		const loLane = roadway.reduce((a, b) => (b.left < a.left ? b : a));
		const hiLane = roadway.reduce((a, b) => (b.right > a.right ? b : a));
		const lo = offsetPoint(end.frame.p, end.frame.n, loLane.left);
		const hi = offsetPoint(end.frame.p, end.frame.n, hiLane.right);
		// The mouth: across every lane between the curbs, through each lane's
		// edges.
		const across = end.lanes.filter(
			(l) => l.left >= loLane.left - 0.01 && l.right <= hiLane.right + 0.01
		);
		const mouthLoHi: Pt[] = [];
		for (const l of across) {
			mouthLoHi.push(
				offsetPoint(end.frame.p, end.frame.n, l.left),
				offsetPoint(end.frame.p, end.frame.n, l.right)
			);
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

// A curb's points less those within `gap` of the point before, ending
// exactly on its last point: a road's curb point, which its lane edge shares.
function ending(pts: Pt[], gap: number) {
	const out = pts.filter((q, i, list) => i === 0 || dist(q, list[i - 1]) > gap);
	const last = pts[pts.length - 1];
	if (out.length > 1) out[out.length - 1] = last;
	else if (last !== out[0]) out.push(last);
	return out;
}

// A corner curve from one curb to the next: leaves along the first road into
// the junction and arrives along the second, with arc-like handles.
function cornerCurve(a: Curb, b: Curb) {
	const p0 = a.leave;
	const p3 = b.arrive;
	const d0 = neg(a.end.frame.run);
	const d3 = b.end.frame.run;
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
		return ending([p0, offsetPoint(p0, u, t - ta), offsetPoint(p3, u, t - tb), p3], 0.05);
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
			const tangent = Math.min(sAt, tAt);
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
			return ending([p0, ...arc, p3], 0.02);
		}
		// The curb lines meet just behind a curb point instead: that end sits a
		// little inside the other road's line, as roads meeting at a sharp angle
		// do. No curve fits between them; any would swing into the other road's
		// mouth and pinch it. The curb runs along both edges to where they meet,
		// back along an end's own edge where nothing lies beyond it.
		const reaches = (s: number, bare: boolean) => s > 0.05 || (bare && s > -OVERLAP);
		if (reaches(sAt, a.bareLeave) && reaches(tAt, b.bareArrive)) {
			return ending([p0, offsetPoint(p0, d0, sAt), p3], 0.02);
		}
	}
	let k =
		turn < 1e-3
			? chord / 3
			: (chord * (2 / 3) * Math.tan(turn / 4)) / Math.sin(Math.max(turn / 2, 0.2));
	// Here the curb lines don't meet ahead of both ends (one end sticks out
	// past the other road's curb): short handles, so the curve stays close to
	// the chord instead of hooking round into a point.
	k = Math.min(k, chord / 3);
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
	for (let i = 0; i <= n; i++) pts.push(cubic(p0, p1, p2, p3, i / n));
	return pts;
}

export interface Outline {
	polygon: Pt[];
	corners: { a: string; b: string; pts: Pt[] }[];
	curbs: Map<string, Curb>;
}

// A lane edge carried across a node of two sides, from its point on a road
// end of the first side to its point on one of the second.
export const edgeAcross = (p: Pt, a: EndInfo, q: Pt, b: EndInfo, steps: number) =>
	curveBetween(p, neg(a.frame.run), q, b.frame.run, steps);

// A lane's two edges across a node of two sides, from its end on one road
// to its end on another: each runs from the lane's corner on the first
// road's end to its corner on the second's, the left one first looking from
// the first road into the second. `corners` are those four points, the
// roads' own.
export function laneEdges(
	from: { end: EndInfo; lane: LaneEnd },
	to: { end: EndInfo; lane: LaneEnd },
	steps: number
) {
	const ends = (end: EndInfo, lane: LaneEnd, into: boolean) => {
		const [l, r] =
			(end.ref.end === 'end') === into ? [lane.left, lane.right] : [lane.right, lane.left];
		return [offsetPoint(end.frame.p, end.frame.n, l), offsetPoint(end.frame.p, end.frame.n, r)];
	};
	const [fl, fr] = ends(from.end, from.lane, true);
	const [tl, tr] = ends(to.end, to.lane, false);
	return {
		corners: [fl, fr, tl, tr],
		left: edgeAcross(fl, from.end, tl, to.end, steps),
		right: edgeAcross(fr, from.end, tr, to.end, steps)
	};
}

// The curb outline. Between one corner's arrival and the next corner's
// departure runs a road end's mouth, straight across its roadway. Across a
// node of two sides (`sides`) the curb is no corner: it is the edge of the
// lane beside it, carrying on from one side to the other. (merge.ts asks
// without sides how near two nodes' outlines come, as it always has.) Only
// the roadway lanes `counts` keeps are kerbed.
export function outlineOf(
	ends: EndInfo[],
	sides: [EndInfo[], EndInfo[]] | null = null,
	counts: Counts = () => true
): Outline {
	const { curbs } = curbsOf(ends, counts);
	const corners: Outline['corners'] = [];
	for (const c of cornersOf(ends, counts)) {
		const a = curbs.get(c.a)!;
		const b = curbs.get(c.b)!;
		const first = sides?.[0].includes(a.end);
		const pts =
			!sides || first === sides[0].includes(b.end)
				? cornerCurve(a, b)
				: first
					? edgeAcross(a.leave, a.end, b.arrive, b.end, TAPER.STEPS)
					: edgeAcross(b.arrive, b.end, a.leave, a.end, TAPER.STEPS).reverse();
		corners.push({ a: c.a, b: c.b, pts });
	}
	// Each corner ends where the next end's mouth begins; the mouth runs on
	// across to where the next corner leaves.
	const polygon = corners.flatMap((c) => [...c.pts, ...curbs.get(c.b)!.mouth.slice(1, -1)]);
	return { polygon, corners, curbs };
}

// The curb outlines across a node of two sides (linkSides in ends.ts): one
// between each two road ends that lanes run between (`between`: each such
// pair of ends with the lanes that do), along the outermost of those lanes
// that are roadway. Two roads have one. Where roads are attached at an edge
// each pair of ends has its own, and what lies between one pair's and
// another's is ground: only lanes are paved there, never the gore between a
// road and one leaving it. A road end has a mouth in each outline it is part
// of.
export function outlinesAcross(between: { a: EndInfo; b: EndInfo; lanes: Set<LaneEnd> }[]) {
	const outlines = between
		.map(({ a, b, lanes }) => outlineOf([a, b], [[a], [b]], (l) => lanes.has(l)))
		.filter((o) => o.polygon.length >= 3);
	return {
		polygons: outlines.map((o) => o.polygon),
		corners: outlines.flatMap((o) => o.corners),
		curbs: outlines.flatMap((o) => [...o.curbs.values()])
	};
}

// The outline from one end's departing curb round to another's arriving curb.
export function chainBetween(outline: Outline, from: string, to: string) {
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
