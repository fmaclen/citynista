// Nodes: road ends with their connections, walkways and approach controls,
// which core/place.ts works out on every build (`defaults` in defaults.ts,
// with the user's edits at the node on top); `describeJunction` describes
// whatever the junction holds. Corner sidewalks and walkways are built in
// corners.ts, each approach's signs in approach.ts. The paving is what lies
// inside the curb outline. Where the lanes find their way across from one
// side to the other (two roads, or roads attached at an edge: linkSides)
// every connection is drawn as a band in its lanes' own surfaces and the
// lines run between the car paths; where roads meet at a junction the paving
// is bare but for a road carried across it, sidewalks follow the outline's
// edge and crossings are the walkways over it. Either way a walkway that car
// lanes cross carries on over them as a crossing (crossingOver in
// corners.ts), never as sidewalk.

import { approachesOf, endCut } from './approach';
import { type Band, carry, facingOf, type Owned } from './carry';
import {
	area as areaOf,
	fromPath,
	inset,
	inside,
	intersect,
	offset,
	open,
	type Paths,
	subtract,
	toPath,
	toRings,
	union
} from './clip';
import { cornersOf, crossingOver, densify, LAP, nearEnd, STRIPE, stripesOver } from './corners';
import { continuingPairs, joinsOnly, sameLanes } from './defaults';
import type {
	Crossing,
	EndCut,
	Marking,
	NodeDescription,
	Sign,
	Surface as Ground
} from './description';
import {
	band,
	connectionCurve,
	crossesAny,
	type Curve,
	type EndInfo,
	type LaneEnd,
	laneEndOf,
	lateral,
	linkSides
} from './ends';
import {
	crossSection,
	curveBetween,
	cutLine,
	dedupe,
	dist,
	dot,
	frameAt,
	neg,
	offsetPoint,
	quad,
	ribbonOf,
	TAPER
} from './geometry';
import { INSET, laneLines, linesBeside, pathLines } from './lines';
import {
	type Connection,
	type Junction,
	type Pt,
	type Surface,
	isRaised,
	isRoadway,
	isTravel,
	laneKey
} from './model';
import { type Curb, laneEdges, type Outline, outlineOf, outlinesAcross } from './outline';
import { LINE, MIN_PIECE } from './paint';
import { alongOf, barColour, hatchBar, materialOf, roleOf } from './road';

// How far past an edge line a path counts as lying beside it: just past
// its lane's edge, and a little further.
const EDGE_PROBES = [INSET + 0.05, 0.6];

// The runs of a polyline's points where `keep` holds.
function runsOf(pts: Pt[], keep: boolean[]) {
	const runs: Pt[][] = [];
	let run: Pt[] = [];
	pts.forEach((p, k) => {
		if (keep[k]) run.push(p);
		else if (run.length) {
			runs.push(run);
			run = [];
		}
	});
	if (run.length) runs.push(run);
	return runs.filter((r) => r.length > 1);
}

// A polyline moved `by` metres to the side of it `toward` lies on, each
// corner mitred, with the unit normal at each point pointing back across it.
// Points come at most half a metre apart, so a line cut short where it meets
// something loses no more than that.
function insetLine(line: Pt[], toward: Pt, by: number) {
	const pts = densify(dedupe(line), 0.5);
	if (pts.length < 2) return null;
	const left = (k: number) => {
		const l = dist(pts[k], pts[k + 1]) || 1;
		return { x: -(pts[k + 1].y - pts[k].y) / l, y: (pts[k + 1].x - pts[k].x) / l };
	};
	const side = dot({ x: toward.x - pts[0].x, y: toward.y - pts[0].y }, left(0)) < 0 ? -1 : 1;
	const normals = pts.map((_, k) => {
		const n0 = left(Math.max(0, k - 1));
		const n1 = left(Math.min(pts.length - 2, k));
		const m = { x: n0.x + n1.x, y: n0.y + n1.y };
		const l = Math.hypot(m.x, m.y) || 1;
		const n = { x: m.x / l, y: m.y / l };
		const reach = by / Math.max(0.3, dot(n, n1));
		return { n: { x: n.x * side, y: n.y * side }, reach };
	});
	return {
		pts: pts.map((p, k) => offsetPoint(p, normals[k].n, normals[k].reach)),
		out: normals.map((v) => neg(v.n))
	};
}

const groundOf = (b: Band, faults: Pt[], stripe = STRIPE): Ground => {
	const ground: Ground = {
		role: b.role,
		material: b.material,
		shape: ribbonOf(b.left, b.right, faults),
		lane: { road: b.lane.road, lane: b.lane.lane }
	};
	if (!b.bars.length) return ground;
	return { ...ground, bars: { colour: b.line, rings: toRings(b.bars, faults, stripe) } };
};

// How far a line's stroke may graze past the edge of where it runs: a line
// guessed as a curve between two road ends can run along a corner's curb a
// hair closer than half a stroke for metres.
const GRAZE = 0.005;

// A connection's path across a node.
interface Route {
	c: Connection;
	curve: Curve;
	fromEnd: EndInfo;
	toEnd: EndInfo;
	travel: boolean;
}

// What crosses a node's paving and lies round it.
interface Across {
	surfaces: Ground[];
	// The ground of the bands that are the node's surface where they lie: the
	// paving shows only between them.
	banded: Paths;
	markings: Marking[];
	signs: Sign[];
	crossings: Crossing[];
	approaches: NodeDescription['approaches'];
	// What the node asks of a road ending at it (endCut).
	cut: (end: EndInfo) => { carried: boolean; linesOn: boolean; setback: number };
}

// What is left of a node's paving along the edges of its bands, thinner than
// this on clipper's grid, is nothing.
const SLIVER = 0.002;

// A node as a description: `paving` is the material inside its curb outline
// (pavingOf in drawing.ts).
export function describeJunction(
	junction: Junction,
	ends: EndInfo[],
	paving: Surface
): NodeDescription {
	const faults: Pt[] = [];
	const sides = linkSides(junction, ends);
	const routes: Route[] = [];
	for (const c of junction.connections) {
		const a = laneEndOf(ends, c.from);
		const b = laneEndOf(ends, c.to);
		if (!a || !b) continue;
		// Across a node of two sides every path is sampled as its bands' edges
		// and its lines are, so the three follow one curve.
		const curve = sides
			? connectionCurve(a.lane, a.end, b.lane, b.end, TAPER.STEPS)
			: connectionCurve(a.lane, a.end, b.lane, b.end);
		routes.push({ c, curve, fromEnd: a.end, toEnd: b.end, travel: isTravel(a.lane.lane) });
	}
	// Across a node of two sides the curbs are the outermost edges of the
	// roadway lanes (car lanes and hatching) that connect across between each
	// two road ends (outlinesAcross): a lane ending there between two that
	// carry on is paved over; one ending at the edge, or every lane of a node
	// with no connection, ends on ground, and so does the gore between a road
	// and one attached at its edge, but for the seams between paths still
	// side by side.
	let across: Across;
	let outline: { corners: Outline['corners']; curbs: Iterable<Curb> };
	let asphalt: Paths;
	if (sides) {
		const lanes = lanesAcross(ends, sides, routes, faults);
		const outlines = outlinesAcross(lanes.between);
		asphalt = union([...outlines.polygons, ...lanes.seams].map(toPath));
		[across, outline] = [lanes, outlines];
	} else {
		const whole = outlineOf(ends);
		asphalt = whole.polygon.length >= 3 ? union([toPath(whole.polygon)]) : [];
		across = roadsMeeting(junction, ends, whole, asphalt, routes, faults);
		outline = { corners: whole.corners, curbs: whole.curbs.values() };
	}

	// A road end is a mouth of the outline where there is one (two or more
	// road ends with a roadway); the paving's rings keep the points the
	// roads' lane edges end on there, each once (a road end has a mouth in
	// each outline it is part of).
	const curbs = outline.corners.length ? [...outline.curbs] : [];
	const mouths = [
		...new Map(curbs.flatMap((c) => c.mouth).map((p) => [`${p.x},${p.y}`, p])).values()
	];
	const rings = toRings(asphalt, faults, 0, mouths);
	const bare = across.banded.length
		? toRings(open(subtract(asphalt, across.banded), SLIVER), faults, 0, mouths)
		: rings;
	const surfaces: Ground[] = [
		{ role: 'paving', material: materialOf(paving), shape: bare },
		...across.surfaces
	];
	return {
		ends,
		outline: {
			rings,
			corners: outline.corners.map((c) => ({ a: c.a, b: c.b, line: c.pts })),
			mouths: curbs.map((c) => ({ end: c.end.key, line: c.mouth, out: c.end.frame.out }))
		},
		paths: routes.map(({ curve }) => ({
			from: curve.from.ref,
			to: curve.to.ref,
			kind: curve.from.lane.kind,
			line: curve.points,
			widths: curve.widths
		})),
		surfaces: surfaces.filter((s) => 'left' in s.shape || s.shape.length > 0),
		markings: across.markings,
		signs: across.signs,
		crossings: across.crossings,
		approaches: across.approaches,
		cuts: new Map<string, EndCut>(
			ends.map((e) => [e.key, endCut(junction, e.geo, e.ref.end, across.cut(e))])
		),
		faults
	};
}

// Bands sharing more ground than this (m²) lie over each other.
const SHARED = 0.02;
// What is left of a hatch bar a car path cuts through, smaller than this
// (m²), is a crumb.
const MIN_BAR = 0.05;

// The hatch bars of road end `end`'s lane `lane` as its road paints them
// (describeRoad in road.ts), carried on along a band between two roads (its
// edges `left` and `right`, point for point): one every 4 m in the road's
// rhythm, here measured along the band's middle from the end the road is at
// (`atStart`: the band's first row), each running from 0.5 m outside the
// lane's left edge to 0.5 m outside its right edge 0.8 of its width further
// on, 0.5 m wide. So the bars keep their spacing and slant round a bend.
// `grid` is where each bar starts on the lane's left edge, along the band's
// middle; it ends `slant` further on (back, for a road leaving the node).
// `bar` draws one along the band; `roadBar` draws it exactly as the road
// does, straight on past the road's end.
function rhythm(left: Pt[], right: Pt[], end: EndInfo, lane: LaneEnd, atStart: boolean) {
	const w = lane.right - lane.left;
	if (w < 1) return null;
	const [a, b] = atStart ? [left, right] : [[...left].reverse(), [...right].reverse()];
	// The lane's left edge (its road's offset lane.left) first.
	const laneLeft = offsetPoint(end.frame.p, end.frame.n, lane.left);
	const [lo, hi] = dist(a[0], laneLeft) < dist(b[0], laneLeft) ? [a, b] : [b, a];
	const mid = lo.map((p, i) => ({ x: (p.x + hi[i].x) / 2, y: (p.y + hi[i].y) / 2 }));
	const s = [0];
	for (let i = 1; i < mid.length; i++) s.push(s[i - 1] + dist(mid[i], mid[i - 1]));
	const total = s[s.length - 1];
	const last = mid.length - 1;
	const unit = (p: Pt, q: Pt) => {
		const l = dist(p, q) || 1;
		return { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
	};
	// A point of an edge `d` along the middle, run on straight past either end.
	const at = (edge: Pt[], d: number) => {
		if (d <= 0) return offsetPoint(edge[0], unit(mid[0], mid[1]), d);
		if (d >= total) return offsetPoint(edge[last], unit(mid[last - 1], mid[last]), d - total);
		let k = 0;
		while (s[k + 1] < d) k++;
		const f = (d - s[k]) / (s[k + 1] - s[k] || 1);
		return {
			x: edge[k].x + (edge[k + 1].x - edge[k].x) * f,
			y: edge[k].y + (edge[k + 1].y - edge[k].y) * f
		};
	};
	// 0.5 m out past one edge from the other.
	const past = (edge: Pt[], other: Pt[], d: number) => {
		const p = at(edge, d);
		return offsetPoint(p, unit(at(other, d), p), 0.5);
	};
	// The road's bars lie every 4 m from a phase set by where it starts
	// (describeRoad); along the band they run on past its end, or back
	// before its start.
	const path = end.geo.path;
	const t0 = frameAt(path, 0).t;
	const phase = (((path.pts[0].x * t0.x + path.pts[0].y * t0.y) % 4) + 4) % 4;
	const forward = end.ref.end === 'end';
	const offset = forward ? (4 - phase - path.length) % 4 : (phase - 4) % 4;
	const grid: number[] = [];
	for (let d = (((offset % 4) + 4) % 4) - 8; d < total + 4; d += 4) grid.push(d);
	const slant = forward ? 0.8 * w : -0.8 * w;
	const { road } = end.geo;
	const span = crossSection(road, 0).find((x) => x.lane.id === lane.lane.id)!;
	return {
		total,
		grid,
		slant,
		bar: (d: number) => toPath(quad(past(lo, hi, d), past(hi, lo, d + slant), 0.25)),
		roadBar: (d: number) =>
			hatchBar(path, forward ? path.length + d : -d, span.left, span.right, road.lean ?? 0)
	};
}

// The hatch bars of a band between two roads, carrying on those of the
// first road (`end`, `lane`, `atStart` as for rhythm). Where the far road's
// lane is hatched too (`far`), each road's bars that reach into it are its
// own, drawn as the road draws them so each meets its other half at the
// seam, and between the middles of the first road's last bar and the far
// road's first the band lays as many equal intervals as come nearest 4 m
// each: the rhythm runs on from one road into the other without a jump.
function barsAlong(
	left: Pt[],
	right: Pt[],
	end: EndInfo,
	lane: LaneEnd,
	atStart: boolean,
	far?: { end: EndInfo; lane: LaneEnd }
) {
	const own = rhythm(left, right, end, lane, atStart);
	if (!own) return [];
	const other = far && rhythm(left, right, far.end, far.lane, !atStart);
	if (!other) return own.grid.map(own.bar);
	const reaching = (r: typeof other) => r.grid.filter((d) => Math.min(d, d + r.slant) < 0);
	const mine = reaching(own);
	const theirs = reaching(other);
	const from = mine[mine.length - 1] + own.slant / 2;
	const to = own.total - (theirs[theirs.length - 1] + other.slant / 2);
	const n = Math.max(1, Math.round((to - from) / 4));
	const between = Array.from(
		{ length: n - 1 },
		(_, i) => from + ((to - from) * (i + 1)) / n - own.slant / 2
	);
	return [...mine.map(own.roadBar), ...between.map(own.bar), ...theirs.map(other.roadBar)];
}

// A node of two sides (linkSides): a road carrying on, a bend, a change of
// cross-section, a road attached at the edge of another. The drawing follows
// the connections and nothing else. Each connected lane runs across as a
// band between its two edges, each a curve from the lane's edge on one side
// to its lane's on the other, so bands side by side share their edges and
// every band starts on its roads' own points. A band is in its lane's
// surface: the first road's as far as TAPER.SPLIT of the way across, then the
// second's (a median running into hatching, an asphalt car lane into a
// concrete one). A lane with no connection simply ends: on the paving
// between the curbs, which tapers to the far curb, or on the ground beyond
// them. Bands of one surface lying over each other (lanes merging, paths
// crossing) are drawn as one. Car lanes rank highest: where one crosses a
// median, grass or sidewalk band, the road shows and that band stops there.
//
// Lines go between neighbouring car paths wherever they run, by the rule
// every lane line follows (lines.ts): two roads' paths are read side by side
// from one to the other; with roads attached at an edge each path is read
// against what lies beside it (linesBeside), which also gives the seams of
// road between paths still side by side. A car lane whose traffic goes
// nowhere across the node ends there: a bar across its end says so. No
// approach has a control, and the roads' own lines and medians run up to the
// node.
//
// `between` is each two road ends that lanes run between, with those lanes:
// the node's curbs follow them (outlinesAcross in outline.ts).
function lanesAcross(
	ends: EndInfo[],
	sides: [EndInfo[], EndInfo[]],
	routes: Route[],
	faults: Pt[]
): Across & { between: { a: EndInfo; b: EndInfo; lanes: Set<LaneEnd> }[]; seams: Pt[][] } {
	const steps = TAPER.STEPS;
	const split = Math.round(steps * TAPER.SPLIT);
	const first = (e: EndInfo) => sides[0].includes(e);
	const bands: (Band & { car: boolean })[] = [];
	// The roads' own points the bands start and end on, each once.
	const corners = new Map<string, Pt>();
	const between = new Map<string, { a: EndInfo; b: EndInfo; lanes: Set<LaneEnd> }>();
	for (const r of routes) {
		if (r.fromEnd === r.toEnd) continue;
		// Read from the first side to the second, whichever way it runs (two
		// ends of one side, the way it runs).
		const from = { end: r.fromEnd, lane: r.curve.from };
		const to = { end: r.toEnd, lane: r.curve.to };
		const [x, y] = first(to.end) && !first(from.end) ? [to, from] : [from, to];
		const pair = [x.end, y.end].sort((p, q) => ends.indexOf(p) - ends.indexOf(q));
		const key = pair.map((e) => e.key).join('|');
		if (!between.has(key)) between.set(key, { a: x.end, b: y.end, lanes: new Set() });
		between.get(key)!.lanes.add(x.lane).add(y.lane);
		const { left, right, corners: own } = laneEdges(x, y, steps);
		for (const p of own) corners.set(`${p.x},${p.y}`, p);
		// The band from one row of its edges to another, as a lane of one of
		// its two roads: hatching keeps its bars, in that road's rhythm, and
		// meets the bars of the far road (`far`) where that is hatched too.
		const part = ({ end, lane }: typeof x, i0: number, i1: number, far?: typeof x) => {
			const k = end.lanes.indexOf(lane);
			const [l, r1] = [left.slice(i0, i1 + 1), right.slice(i0, i1 + 1)];
			return {
				lane: lane.ref,
				role: roleOf(end.lanes, k),
				material: materialOf(lane.lane.surface),
				left: l,
				right: r1,
				line: barColour(end.lanes, k),
				bars:
					lane.lane.surface === 'hatch'
						? intersect(barsAlong(left, right, end, lane, end === x.end, far), [
								toPath([...l, ...[...r1].reverse()])
							]).filter((bar) => Math.abs(areaOf(bar)) > 0.3)
						: [],
				// Any lane vehicles drive on, one-way or two-way.
				car: r.curve.from.lane.kind === 'drive'
			};
		};
		const surface = (at: typeof x) =>
			`${roleOf(at.end.lanes, at.end.lanes.indexOf(at.lane))}|${at.lane.lane.surface}`;
		if (surface(x) === surface(y)) bands.push(part(from, 0, steps, to));
		else bands.push(part(x, 0, split), part(y, split, steps));
	}
	const driven = routes.filter((r) => r.travel && r.fromEnd !== r.toEnd);
	const walked = routes.filter((r) => r.curve.from.lane.kind === 'walk' && r.fromEnd !== r.toEnd);
	const { lines, seams } =
		ends.length > 2
			? linesBeside(driven, walked)
			: { lines: pathLines(driven, sides[0], sides[1], walked), seams: [] };
	const shapeOf = (b: Band) => toPath([...b.left, ...[...b.right].reverse()]);
	const sum = (paths: Paths) => paths.reduce((total, q) => total + areaOf(q), 0);
	const cars = union([...bands.filter((b) => b.car).map(shapeOf), ...seams.map(toPath)]);
	// Where car lanes cut through a sidewalk carried across, it carries on
	// over them as a crossing (crossingOver in corners.ts), its stripes laid
	// along the path nearest each piece of it; every line stops at it.
	const driving = routes.filter((r) => r.curve.from.lane.kind === 'drive' && r.fromEnd !== r.toEnd);
	const crossings: Crossing[] = [];
	for (const r of walked) {
		const from = { end: r.fromEnd, lane: r.curve.from };
		const to = { end: r.toEnd, lane: r.curve.to };
		const [x, y] = first(to.end) && !first(from.end) ? [to, from] : [from, to];
		const ground = laneEdges(x, y, steps);
		const over = intersect([toPath([...ground.left, ...[...ground.right].reverse()])], cars);
		if (sum(over) <= SHARED) continue;
		const stripes = over.flatMap((piece) => {
			const pts = fromPath(piece);
			const middle = {
				x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
				y: pts.reduce((s, p) => s + p.y, 0) / pts.length
			};
			let near: { at: Pt; along: Pt; d: number } | null = null;
			for (const { curve } of driving)
				curve.points.forEach((q, k) => {
					const d = dist(q, middle);
					if (near && near.d <= d) return;
					const [a, b] = [curve.points[Math.max(0, k - 1)], curve.points[k + 1] ?? q];
					const l = dist(a, b) || 1;
					near = { at: q, along: { x: (b.x - a.x) / l, y: (b.y - a.y) / l }, d };
				});
			const lane = near as { at: Pt; along: Pt } | null;
			return lane
				? stripesOver(pts, lane.at, lane.along, { x: -lane.along.y, y: lane.along.x })
				: [];
		});
		crossings.push(
			crossingOver(
				`${laneKey(r.c.from)}~${laneKey(r.c.to)}`,
				r.curve.points,
				over,
				union(stripes),
				faults
			)
		);
	}
	const bodies = crossings.flatMap((c) => c.body);
	const clear = (m: (typeof lines)[number]): Marking[] => {
		const whole = { colour: m.colour, dashed: m.dashed, line: m.pts, along: alongOf(m.pts) };
		if (!bodies.length) return [whole];
		const xs = [...m.pts, ...bodies.flat()].map((p) => p.x);
		const ys = [...m.pts, ...bodies.flat()].map((p) => p.y);
		const box = [
			{ x: Math.min(...xs) - 1, y: Math.min(...ys) - 1 },
			{ x: Math.max(...xs) + 1, y: Math.min(...ys) - 1 },
			{ x: Math.max(...xs) + 1, y: Math.max(...ys) + 1 },
			{ x: Math.min(...xs) - 1, y: Math.max(...ys) + 1 }
		];
		const keep = subtract([toPath(box)], offset(bodies.map(toPath), LINE / 2)).map(fromPath);
		// Cut pieces keep the whole line's dashes.
		const rhythm: [number, number] = [0, whole.along[whole.along.length - 1]];
		return cutLine(m.pts, keep)
			.map(({ line, along }) => ({ colour: m.colour, dashed: m.dashed, line, along, rhythm }))
			.filter((piece) => piece.along[piece.along.length - 1] - piece.along[0] >= MIN_PIECE - LINE);
	};
	// Hatching stops where a car path crosses it, as the lane's own surface
	// does under a raised band.
	for (const b of bands)
		if (b.bars.length && cars.length)
			b.bars = subtract(b.bars, cars).filter((q) => Math.abs(areaOf(q)) > MIN_BAR);
	const exact = [...corners.values()];
	const surfaces: Ground[] = [];
	const groups = new Map<string, typeof bands>();
	for (const b of bands) {
		const key = `${b.role}|${b.material}`;
		groups.set(key, [...(groups.get(key) ?? []), b]);
	}
	for (const group of groups.values()) {
		const { role, material } = group[0];
		const shapes = group.map(shapeOf);
		const one = group.length > 1 ? union(shapes) : shapes;
		const lapped = sum(shapes) - sum(one) > SHARED;
		const crossed = role !== 'lane' && sum(intersect(shapes, cars)) > SHARED;
		if (!lapped && !crossed) {
			surfaces.push(...group.map((b) => groundOf(b, faults, 0)));
			continue;
		}
		const ground: Ground = {
			role,
			material,
			shape: toRings(crossed ? subtract(one, cars) : one, faults, 0, exact)
		};
		const barred = group.filter((b) => b.bars.length);
		if (barred.length)
			ground.bars = {
				colour: barred[0].line,
				rings: toRings(
					barred.flatMap((b) => b.bars),
					faults
				)
			};
		surfaces.push(ground);
	}

	const signs: Sign[] = [];
	for (const e of ends)
		for (const l of e.lanes) {
			if (!isTravel(l.lane) || l.flow !== 'in' || driven.some((r) => r.curve.from === l)) continue;
			const at = offsetPoint(e.frame.p, e.frame.out, LINE / 2 + 0.05);
			signs.push({
				kind: 'end',
				lane: l.ref,
				a: offsetPoint(at, e.frame.n, l.left),
				b: offsetPoint(at, e.frame.n, l.right)
			});
		}
	return {
		surfaces,
		// A seam is road: no other band is the node's surface there.
		banded: seams.length
			? [
					...bands.filter((b) => b.car).map(shapeOf),
					...subtract(bands.filter((b) => !b.car).map(shapeOf), seams.map(toPath))
				]
			: bands.map(shapeOf),
		markings: lines.flatMap(clear),
		signs,
		crossings,
		approaches: [],
		cut: () => ({ carried: true, linesOn: false, setback: 0 }),
		between: [...between.values()],
		seams
	};
}

// Where roads meet at a junction: what is carried across its paving, its
// corner sidewalks and crossings, its lines, and each approach's signs.
function roadsMeeting(
	junction: Junction,
	ends: EndInfo[],
	outline: Outline,
	asphalt: Paths,
	resolved: Route[],
	faults: Pt[]
): Across {
	// Carry roads straight across where nothing but side roads that only join
	// them (joinsOnly) meets them and nobody has to stop.
	const out = { bands: [] as Band[], marks: [] as Owned[] };
	const carriedEnds = new Set<string>();
	for (const a of ends) {
		if (!a.lanes.some((l) => isRoadway(l.lane))) continue;
		if ((junction.control[a.key] ?? 'none') !== 'none') continue;
		const facing = facingOf(a, ends, junction.connections);
		if (facing.some((e) => (junction.control[e.key] ?? 'none') !== 'none')) continue;
		const rest = ends.filter(
			(e) => e !== a && !facing.includes(e) && dot(e.frame.out, a.frame.out) <= 0.7
		);
		if (rest.some((e) => !joinsOnly(e, ends, junction.connections))) continue;
		// Traffic turning across it; the road's own, following it round a
		// bend, isn't.
		const own = (r: (typeof resolved)[number]) =>
			(r.fromEnd === a && facing.includes(r.toEnd)) ||
			(r.toEnd === a && facing.includes(r.fromEnd));
		const turning = resolved
			.filter(
				(r) => !own(r) && dot(neg(r.fromEnd.frame.out), r.toEnd.frame.out) < Math.cos(Math.PI / 6)
			)
			.map((r) => r.curve);
		if (carry(a, ends, junction, turning, out)) {
			carriedEnds.add(a.key);
			for (const e of facing) carriedEnds.add(e.key);
		}
	}
	// A road with priority that carries on keeps its lines through the
	// junction, even round a bend, as a roundabout's ring does past each
	// entry. The paint follows the neighbour rule of a two-road node
	// (lines.ts) with right of way added: traffic from an approach that stops,
	// yields or has signals gives way to the road, so its paths never break
	// the road's lines; a path from another approach nobody controls does.
	const free = (e: EndInfo) => (junction.control[e.key] ?? 'none') === 'none';
	const linesOn = new Set<string>();
	for (const { pair, priority } of continuingPairs(ends, junction.connections)) {
		const [a, b] = pair;
		if (!priority || carriedEnds.has(a.key) || !free(a) || !free(b)) continue;
		const through = (r: (typeof resolved)[number]) =>
			(r.fromEnd === a && r.toEnd === b) || (r.fromEnd === b && r.toEnd === a);
		// Dashes between the road's lanes going the same way, unless a path
		// with right of way crosses them (the road's own traffic turning off
		// changes lanes first, so it doesn't).
		const crossing = resolved
			.filter((r) => r.fromEnd !== a && r.fromEnd !== b && free(r.fromEnd))
			.map((r) => r.curve);
		const own = resolved.filter((r) => r.travel && through(r));
		const dashes = (own.length < 2 ? [] : pathLines(own, [a], [b])).filter(
			(m) => m.dashed && !crossesAny(m.pts, crossing)
		);
		out.marks.push(...dashes.map((m) => ({ ...m, own: [a, b] })));
		let painted = dashes.length > 0;
		// Edge lines, where the road keeps its lanes across: each runs on
		// wherever nothing lies just beyond it, neither another car path nor
		// another road's mouth. Any path counts, given way or not: a path
		// coming in from an entry runs beside the road's outermost path, or
		// across it, until it has merged, so that path has no bare outside
		// there, and the outer edge line stops at the mouth and starts again
		// past it; the same goes for a path turning off at an exit, and for a
		// lane of the other road that no path uses. The far side, with nothing
		// joining it (a ring's inner edge along the apron), runs unbroken.
		if (sameLanes(a, b)) {
			// A median stopping in its nose has its lines wrapped round the nose
			// on the road (road.ts), so none carry on from beside it.
			const nosed = (e: EndInfo, o: number) =>
				e.lanes.some(
					(l, i) =>
						isRaised(l.lane) &&
						(Math.abs(l.left - INSET - o) < 0.02 || Math.abs(l.right + INSET - o) < 0.02) &&
						e.lanes.slice(0, i).some((x) => isRoadway(x.lane)) &&
						e.lanes.slice(i + 1).some((x) => isRoadway(x.lane))
				);
			const edges = (e: EndInfo) =>
				laneLines(e.lanes)
					.filter((m) => !m.dashed && !nosed(e, m.o))
					.map((m) => ({ colour: m.colour, o: m.o, p: offsetPoint(e.frame.p, e.frame.n, m.o) }))
					.sort((p, q) => lateral(a, p.p) - lateral(a, q.p));
			const ea = edges(a);
			const eb = edges(b);
			const mouths = union(
				ends.filter((e) => e !== a && e !== b).flatMap((e) => nearEnd(e, 1, isRoadway))
			);
			const beside = union([
				...resolved
					.filter((r) => !through(r) && r.curve.from.lane.kind === 'drive')
					.map((r) => band(r.curve).path),
				...mouths
			]);
			// Sides measured from the middle of the road's own width.
			const mid =
				(Math.min(...a.lanes.map((l) => l.left)) + Math.max(...a.lanes.map((l) => l.right))) / 2;
			// An edge line just inside a curb that runs straight from one end
			// to the other, nobody joining between, follows that curb at its
			// inset. A curve guessed from the two ends alone strays off the
			// asphalt where the curb is long or bends one way then the other.
			const alongCurb = (p: Pt, q: Pt) => {
				for (const c of outline.corners) {
					const pts =
						c.a === a.key && c.b === b.key
							? c.pts
							: c.a === b.key && c.b === a.key
								? [...c.pts].reverse()
								: null;
					if (!pts || pts.length < 2) continue;
					const near = (curb: Pt, mark: Pt) => Math.abs(dist(curb, mark) - INSET) < 0.05;
					if (!near(pts[0], p) || !near(pts[pts.length - 1], q)) continue;
					const line = insetLine(pts, p, INSET);
					if (line) return line;
				}
				return null;
			};
			if (ea.length === eb.length)
				ea.forEach((m, i) => {
					if (eb[i].colour !== m.colour) return;
					const curb = alongCurb(m.p, eb[i].p);
					const pts =
						curb?.pts ??
						curveBetween(
							m.p,
							neg(a.frame.run),
							eb[i].p,
							b.frame.run,
							Math.max(12, Math.ceil(dist(m.p, eb[i].p) / 0.5))
						);
					// Looking past the line, away from the road.
					const away = Math.sign(m.o - mid);
					const bare = pts.map((q, k) => {
						const p0 = pts[Math.max(0, k - 1)];
						const p1 = pts[Math.min(pts.length - 1, k + 1)];
						const l = dist(p0, p1) || 1;
						let n = curb?.out[k] ?? { x: -(p1.y - p0.y) / l, y: (p1.x - p0.x) / l };
						if (!curb && dot(n, a.frame.n) * away < 0) n = neg(n);
						// Past a curb line lies only the curb: a path that seems to
						// lie there is a turn guessed wide of the asphalt.
						const past = curb ? mouths : beside;
						return !EDGE_PROBES.some((d) => inside(past, offsetPoint(q, n, d)));
					});
					for (const run of runsOf(pts, bare)) {
						if (alongOf(run).at(-1)! < 1) continue;
						out.marks.push({ colour: m.colour, dashed: false, pts: run, own: [a, b] });
						painted = true;
					}
				});
		}
		// Its lines meet the junction's at the outline; its medians and
		// verges keep their own noses, as nothing else of it is carried.
		if (painted) {
			linesOn.add(a.key);
			linesOn.add(b.key);
		}
	}

	const { roadways, raised, verges, pavement, crossings, across, crossDepth } = cornersOf(
		junction,
		ends,
		outline,
		asphalt,
		out.bands,
		faults
	);

	// Where a line may run: the paving and the roadways of the road ends it
	// runs between, less any crossing, verge or raised band, and every other
	// road's roadway (a road pushed into the junction); held half a stroke in,
	// so all of the stroke stays inside, give or take GRAZE. A line that runs
	// into another road's roadway at all is dropped. (A corner's sidewalk can
	// leave hairlines of crossing along the curb, where its rounding dips over
	// it: they block nothing.)
	const blocked = union([...open(union(across), 0.005), ...verges, ...raised]);
	const regions = new Map<string, { keep: Pt[][]; others: Pt[][] }>();
	const regionOf = (own: EndInfo[]) => {
		const key = own.map((e) => e.key).join('|');
		let region = regions.get(key);
		if (!region) {
			const others = ends.filter((e) => !own.includes(e)).flatMap((e) => roadways.get(e)!);
			const paved = union([...asphalt, ...own.flatMap((e) => roadways.get(e)!)]);
			region = {
				keep: inset(subtract(paved, union([...blocked, ...others])), LINE / 2 - GRAZE).map(
					fromPath
				),
				others: offset(union(others), -0.1).map(fromPath)
			};
			regions.set(key, region);
		}
		return region;
	};
	const markings: Marking[] = out.marks.flatMap((m) => {
		const { keep, others } = regionOf(m.own);
		if (cutLine(m.pts, others).length) return [];
		const pieces = cutLine(m.pts, keep);
		// Cut pieces keep the whole line's dashes.
		const rhythm: [number, number] = [0, alongOf(m.pts).at(-1)!];
		return pieces
			.map(({ line, along }) => ({ colour: m.colour, dashed: m.dashed, line, along, rhythm }))
			.filter((piece) => piece.along[piece.along.length - 1] - piece.along[0] >= MIN_PIECE - LINE);
	});

	const { signs, approaches, setbackOf } = approachesOf(junction, ends, resolved, crossDepth);

	return {
		surfaces: [
			...out.bands.map((b) => groundOf(b, faults)),
			{ role: 'walk', material: 'concrete', shape: toRings(union(pavement), faults, LAP) },
			{ role: 'verge', material: 'grass', shape: toRings(union(verges), faults, LAP) }
		],
		// A carried band of asphalt (hatching) lies in the paving's own layer:
		// the paving stops at it.
		banded: out.bands
			.filter((b) => b.material === 'asphalt')
			.map((b) => toPath([...b.left, ...[...b.right].reverse()])),
		markings,
		signs,
		crossings,
		approaches,
		cut: (e) => ({
			carried: carriedEnds.has(e.key),
			linesOn: linesOn.has(e.key),
			setback: setbackOf(e)
		})
	};
}
