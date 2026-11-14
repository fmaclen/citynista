// Corner sidewalks and verges: a road end's lanes near the node, and the
// bands and curves a sidewalk round a curb is built from.

import { getQuadraticBezierPoint } from '../geometry/bezier';
import type { Band } from './carry';
import {
	close,
	fromPath,
	inside,
	intersect,
	offset,
	offsetLine,
	open,
	type Paths,
	subtract,
	toPath,
	toRings,
	union
} from './clip';
import type { Crossing } from './description';
import { type EndInfo, type LaneEnd, laneEndOf, lateral } from './ends';
import { bars, curveBetween, dedupe, dist, dot, neg, offsetPoint } from './geometry';
import { type Junction, type Lane, type Pt, isRaised, isRoadway, isWalk } from './model';
import { chainBetween, type Outline } from './outline';
import { laneStrips, roadRows } from './road';

// How far a corner's sidewalk overlaps the roads' own sidewalks.
const SEAM = 0.4;

// Two road ends whose headings are within this (a cosine, about 11°) of the
// line between their curb points carry straight on into each other.
const IN_LINE = 0.98;

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

// Each lane's strip over a road end's last few metres (those `keep` keeps),
// by lane id.
function nearEndLanes(end: EndInfo, depth: number, keep: (lane: Lane) => boolean = () => true) {
	const length = end.geo.path.length;
	const [from, to] =
		end.ref.end === 'start' ? [0, Math.min(length, depth)] : [Math.max(0, length - depth), length];
	const rows = roadRows(end.geo.road, end.geo.path, from, to);
	return new Map([...laneStrips(rows, keep)].map(([id, poly]) => [id, [toPath(poly)]]));
}

// Those strips as one.
export const nearEnd = (end: EndInfo, depth: number, keep: (lane: Lane) => boolean) =>
	union([...nearEndLanes(end, depth, keep).values()].flat());

// Points along a polyline at most `step` apart.
export function densify(pts: Pt[], step: number) {
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

// A sidewalk lane's outer edge (away from the curb at `curb`) where its road
// meets the junction, a seam's length back into the road.
function outerEdge(end: EndInfo, walk: LaneEnd, curb: Pt) {
	const c = lateral(end, curb);
	const o = Math.abs(walk.left - c) > Math.abs(walk.right - c) ? walk.left : walk.right;
	return offsetPoint(offsetPoint(end.frame.p, end.frame.n, o), end.frame.run, SEAM);
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
	for (let i = 0; i <= 24; i++)
		out.push(getQuadraticBezierPoint(a.x, a.y, c.x, c.y, b.x, b.y, i / 24));
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

// A band along one side of a polyline, from `i` to `o` metres off it, both
// running linearly from their start to end values. Built from a piece per
// segment plus a round wedge at each outward turn, unioned, so a tight curve
// can't fold the outer edge back over itself into a spike or a notch.
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

// Where car lanes cross a walkway, the walkway carries on as a crossing:
// zebra stripes over the lanes it lies across (`over`), never sidewalk
// paving, and the sidewalk itself stops at their edge. This is the one place
// a walkway's crossing is made: for a junction's corner sidewalk laid across
// the mouth of a road with no sidewalk of its own, for a footpath across a
// street, and for a sidewalk carried across a node of two sides where a lane
// cuts through it (cornersOf here, lanesAcross in node.ts). `stripes` are the
// bars to paint; `refuge` is where the walkway rests on a median carried
// across, and `paved` sidewalk paving that belongs to the crossing but lies
// on no car lane (a footpath's run over the sidewalk and verge of the street
// it crosses).
export function crossingOver(
	id: string,
	line: Pt[],
	over: Paths,
	stripes: Paths,
	faults: Pt[],
	refuge: Paths = [],
	paved: Paths = []
): Crossing {
	return {
		id,
		line,
		runs: (
			[
				{ kind: 'paved', rings: toRings([...refuge, ...paved], faults, LAP) },
				// No stripes over a refuge: it is paved.
				{
					kind: 'zebra',
					rings: toRings(intersect(stripes, subtract(over, refuge)), faults, STRIPE)
				}
			] as const
		).filter((run) => run.rings.length > 0),
		body: toRings(union([...over, ...refuge]), faults)
	};
}

// Zebra stripes for a piece of road a walkway crosses (its corners,
// `piece`), laid along the traffic there: bars across the line through the
// piece's middle, square to the way the traffic runs (`along`, with `across`
// to its side, both from `origin`), each as long as the piece is deep.
export function stripesOver(piece: Pt[], origin: Pt, along: Pt, across: Pt): Paths {
	const depth = piece.map((q) => dot({ x: q.x - origin.x, y: q.y - origin.y }, along));
	const lo = Math.min(...depth);
	const hi = Math.max(...depth);
	const reach =
		Math.max(...piece.map((q) => Math.abs(dot({ x: q.x - origin.x, y: q.y - origin.y }, across)))) +
		1;
	const mid = offsetPoint(origin, along, (lo + hi) / 2);
	return bars([offsetPoint(mid, across, -reach), offsetPoint(mid, across, reach)], hi - lo);
}

// How a junction's zebra stripes and the hatch bars carried across it are
// drawn: their bars less 5 cm all round (0.4 m wide); a road's are not, as
// yet, nor those of a band between two roads, which carry on the roads'.
export const STRIPE = -0.05;

// Corner sidewalk, verge and a crossing's paving (a refuge, or sidewalk laid
// across a mouth) are cut on clipper's millimetre grid against the exact
// edges of the roads and the paving, so they are drawn a centimetre wider: no
// hair of ground opens along those edges. The sidewalk's lies under whatever
// it meets.
export const LAP = 0.01;

// Where roads meet at a junction (roadsMeeting in node.ts): the corner
// sidewalk (`pavement`) and verges round its curb outline, and its walkways
// as crossings. Also what the rest of the junction reads from them: each
// end's roadway near the node, the carried medians (`bands` not in a car
// lane's role) a crossing rests on, everything the crossings lay across the
// paving, and how deep into each road's mouth a walkway reaches.
export function cornersOf(
	junction: Junction,
	ends: EndInfo[],
	outline: Outline,
	asphalt: Paths,
	bands: Band[],
	faults: Pt[]
) {
	// Each end's roadway near its end. The depth adds how far along the road
	// its lanes meet the junction, so at a road's far end it takes in the
	// whole road.
	const roadways = new Map(ends.map((e) => [e, nearEnd(e, 8 + e.frame.distance, isRoadway)]));
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
	// What corner sidewalk never covers, besides the roads.
	const blockers = union([...raisedNear, ...lapped]);
	const pavement: Paths = [];
	const crossings: Crossing[] = [];
	// Everything a crossing lays across the junction.
	const across: Paths = [];
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
	// Where a crossing rests on a carried median.
	const raised = bands
		.filter((b) => b.role !== 'lane')
		.map((b) => toPath([...b.left, ...[...b.right].reverse()]));
	const refuges = union(raised);
	for (const w of junction.walkways) {
		const ea = laneEndOf(ends, w.a);
		const eb = laneEndOf(ends, w.b);
		if (!ea || !eb) continue;
		let centre: Pt[] = [];
		let width = 0;
		let body: Paths = [];
		// Where a sidewalk carried straight on lies: only what it crosses there
		// is its crossing.
		let line: Paths | null = null;
		let stripes: Paths | null = null;
		let walkOnly = false;
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
			const [ia, oa] = reach(ea.end, ea.lane, ca.leave);
			const [ib, ob] = reach(eb.end, eb.lane, cb.arrive);
			width = (oa + ob) / 2;
			// The sidewalk's distance from the curb runs smoothly from one
			// road's to the other's, and the verge between them stays grass.
			const own = union([...roadways.get(ea.end)!, ...roadways.get(eb.end)!]);
			// Run the band a little way back into both roads, so it overlaps
			// their own sidewalks and no crack opens at the seam when an end
			// sits at a slight angle to the curb.
			const backInto = (run: Pt[]) =>
				densify(
					[
						offsetPoint(ca.leave, ea.end.frame.run, SEAM),
						...run,
						offsetPoint(cb.arrive, eb.end.frame.run, SEAM)
					],
					0.5
				);
			const outward = outwardSide(backInto(chain.pts), asphalt);
			// Between two ends of one road carrying straight on, past roads that
			// stop on its curb line (roads without sidewalks that only join it:
			// core/setbacks.ts), the sidewalk carries on along that road's own
			// curb, from one curb point to the other as the curb of a road
			// carrying on runs, and crosses whatever asphalt lies in its way
			// there: the crossing is where the sidewalk would be, however the
			// road it crosses is slanted. Round a road with curb corners of its
			// own it follows the corners and crosses at the mouth.
			const span = dist(ca.leave, cb.arrive) || 1;
			const on = { x: (cb.arrive.x - ca.leave.x) / span, y: (cb.arrive.y - ca.leave.y) / span };
			const off = (p: Pt) => Math.abs((p.x - ca.leave.x) * on.y - (p.y - ca.leave.y) * on.x);
			const straight =
				chain.crossed.length > 0 &&
				dot(ea.end.frame.out, on) < -IN_LINE &&
				dot(eb.end.frame.out, on) > IN_LINE &&
				chain.crossed.every((key) => outline.curbs.get(key)!.mouth.some((p) => off(p) < 0.5));
			const run = straight
				? curveBetween(
						ca.leave,
						neg(ea.end.frame.run),
						cb.arrive,
						eb.end.frame.run,
						Math.max(2, Math.ceil(span / 0.5))
					)
				: chain.pts;
			const pts = backInto(run);
			// Along the curb outline nothing of it lies over the junction's
			// paving. Carried straight on, what does is its crossing, and its
			// ground reaches a metre inside its line, so it meets the paving's
			// edge wherever that lies a little short of the line.
			const cutAway = straight ? own : union([...asphalt, ...own]);
			const inside = straight ? ribbon(pts, 0, 0, 1, 1, -outward) : [];
			if (straight) line = ribbon(pts, ia, ib, oa, ob, outward);
			// Its inner edge follows the curb (past any verge), at the roads'
			// own widths all the way round. Where the two roads' sidewalk edges
			// meet ahead of both ends, the outer edge also rounds that corner in
			// one curve inside it, filling any dent where the curb turns
			// tightly; the curve never leaves the corner, so it can't bulge or
			// end in a point. Where an end runs past the other's edge, or the
			// band crosses another road's mouth on the way, the band alone is
			// the corner.
			const band = union([
				...ribbon(pts, ia, ib, oa, ob, outward),
				...(ia > 0.3 || ib > 0.3 ? [] : inside)
			]);
			const outer = chain.crossed.length
				? null
				: fillet(
						outerEdge(ea.end, ea.lane, ca.leave),
						neg(ea.end.frame.run),
						outerEdge(eb.end, eb.lane, cb.arrive),
						neg(eb.end.frame.run)
					);
			body = subtract(
				outer
					? union([...band, toPath([...edgeAlong(pts, ia, ib, outward), ...[...outer].reverse()])])
					: band,
				cutAway
			);
			// Where it runs back over a road it takes on that road's own
			// sidewalk there exactly, and is smoothed together with it below,
			// so the two meet without a sliver or a tooth.
			const roadsHere = union([...seams.get(ea.end)!, ...seams.get(eb.end)!]);
			const sides = union([
				...(seamLanes.get(ea.end)!.get(ea.lane.lane.id) ?? []),
				...(seamLanes.get(eb.end)!.get(eb.lane.lane.id) ?? [])
			]);
			body = union([...subtract(body, roadsHere), ...sides]);
			// Closed and opened by 10 cm: no dent where the band's pieces meet,
			// no zero-width sliver left along a curb.
			body = open(close(body, 0.1), 0.1);
			// Past the mouth of a road it follows the corners of and crosses
			// (one without sidewalks of its own), the band is the crossing over
			// that road's roadway and a square landing either side of it, as
			// deep as the crossing and as wide as the sidewalk, instead of
			// whatever its rounding round the curb point would leave there.
			for (const key of straight ? [] : chain.crossed) {
				const e = ends.find((x) => x.key === key);
				if (!e) continue;
				const roadway = e.lanes.filter((l) => isRoadway(l.lane));
				if (!roadway.length) continue;
				const lo = Math.min(...roadway.map((l) => l.left));
				const hi = Math.max(...roadway.map((l) => l.right));
				const at = (along: number, across: number) =>
					offsetPoint(offsetPoint(e.frame.p, e.frame.out, along), e.frame.n, across);
				const box = (d: number, from: number, to: number) =>
					toPath([at(0, from), at(d, from), at(d, to), at(0, to)]);
				const far = width + 8;
				body = union([
					...subtract(body, subtract([box(far, lo - far, hi + far)], roadways.get(e)!)),
					box(width, lo - width, lo),
					box(width, hi, hi + width)
				]);
			}
			// The verge stops at every road mouth it passes (the road's asphalt
			// runs through it; only the sidewalk carries on across, as a
			// crossing).
			if (ia > 0.3 || ib > 0.3)
				verges.push(
					...subtract(union([...ribbon(pts, 0, 0, ia, ib, outward), ...inside]), pavedAll)
				);
			centre = run;
		} else {
			walkOnly = true;
			// A walk-only road at either end: on between them, leaving each
			// square to its end, so a path drawn on a curve through the node
			// carries on along it (straight where the two ends line up).
			const a = ea.lane.point;
			const b = eb.lane.point;
			centre = curveBetween(
				a,
				neg(ea.end.frame.run),
				b,
				eb.end.frame.run,
				Math.max(2, Math.ceil(dist(a, b) / 1.5))
			);
			width = Math.max(ea.lane.right - ea.lane.left, eb.lane.right - eb.lane.left);
			body = offsetLine(centre, width / 2);
			// Its zebra stripes run along the road it crosses (that road's
			// ends' headings, averaged), one on the middle of the crossing,
			// each long enough for any angle: clipped to the path over the
			// roadway, the zebra is as wide as the path and spans just the
			// roadway, however the path meets the road or curves.
			const along = ends
				.filter((e) => e !== ea.end && e !== eb.end && e.lanes.some((l) => isRoadway(l.lane)))
				.reduce(
					(d, e) => {
						const s = dot(d, e.frame.out) < 0 ? -1 : 1;
						return { x: d.x + s * e.frame.out.x, y: d.y + s * e.frame.out.y };
					},
					{ x: 0, y: 0 }
				);
			const l = Math.hypot(along.x, along.y);
			if (l > 1e-6) {
				const across = { x: -along.y / l, y: along.x / l };
				const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
				const reach = Math.ceil(dist(a, b) / 2 + width) + 0.5;
				stripes = union(
					bars(
						[offsetPoint(m, across, -reach), offsetPoint(m, across, reach)],
						2 * (dist(a, b) + width)
					)
				);
			}
		}
		// What it crosses: the junction's paving, and the roadway of any end but
		// the two it runs between.
		const solid = union([
			...asphalt,
			...ends.filter((e) => e !== ea.end && e !== eb.end).flatMap((e) => roadways.get(e)!)
		]);
		const over = intersect(line ? intersect(body, line) : body, solid);
		// Along a curb chain the stripes are laid along each road they cross
		// (square to its mouth), so they never fan or cross where the chain
		// turns a corner.
		if (
			!stripes &&
			ea.end !== eb.end &&
			outline.curbs.has(ea.end.key) &&
			outline.curbs.has(eb.end.key)
		) {
			const pieces: Paths = [];
			for (const e of ends) {
				if (e === ea.end || e === eb.end) continue;
				// What lies over that road; of a sidewalk carried straight on,
				// all of the piece that does, the junction's paving in front of
				// the road's mouth too.
				const piece = (
					line
						? over.filter((path) => intersect([path], roadways.get(e)!).length > 0)
						: intersect(over, roadways.get(e)!)
				).flatMap(fromPath);
				if (piece.length === 0) continue;
				pieces.push(...stripesOver(piece, e.frame.p, e.frame.out, e.frame.n));
			}
			stripes = union(pieces);
		}
		// A crossing rests on a carried median where it meets one; a road's own
		// median stops short of its crossings.
		const refuge = intersect(body, refuges);
		// Sidewalk paving never covers a road; roads draw their own lanes.
		const plain = subtract(subtract(body, solid), blockers);
		if (ea.end !== eb.end) pavement.push(...plain);
		if (over.length === 0 && refuge.length === 0) continue;
		// A walk-only road crossing a road runs on over that road's sidewalk
		// and verge right up to its zebra, in sidewalk paving.
		const approach = walkOnly ? subtract(body, union([...solid, ...refuge])) : [];
		// A walkway laid across another road's mouth pushes that road's stop
		// line back behind it.
		if (ea.end !== eb.end) {
			for (const e of ends) {
				if (e === ea.end || e === eb.end) continue;
				const across = intersect(over, roadways.get(e)!);
				for (const q of across.flatMap(fromPath)) {
					const depth = dot({ x: q.x - e.frame.p.x, y: q.y - e.frame.p.y }, e.frame.out);
					crossDepth.set(e.key, Math.max(crossDepth.get(e.key) ?? 0, depth));
				}
			}
		}
		crossings.push(
			crossingOver(
				w.id,
				centre,
				over,
				stripes ?? union(bars(centre, width)),
				faults,
				refuge,
				approach
			)
		);
		across.push(...approach, ...over, ...refuge);
	}
	return { roadways, raised, verges, pavement, crossings, across, crossDepth };
}
