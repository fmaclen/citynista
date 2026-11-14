// Road geometry: the drawn line, and the cross-section at any distance along
// it.

import { toPath, toRings, union, type Paths } from './clip';
import type { Ribbon, Ring } from './description';
import type { End, Lane, Pt, Road } from './model';

export interface PathSample {
	pts: Pt[];
	// Cumulative distance at each point.
	s: number[];
	length: number;
}

const CURVE_STEP = 0.75;

// The point at t on the cubic from a to b with handles c1 and c2.
export function cubic(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
	const u = 1 - t;
	return {
		x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
		y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y
	};
}

export function samplePath(road: Road): PathSample {
	const pts: Pt[] = [{ x: road.points[0].x, y: road.points[0].y }];
	for (let i = 1; i < road.points.length; i++) {
		const a = road.points[i - 1];
		const b = road.points[i];
		if (b.c1 && b.c2) {
			const rough = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(b.c1.x - a.x, b.c1.y - a.y);
			const steps = Math.max(4, Math.ceil(rough / CURVE_STEP));
			for (let k = 1; k <= steps; k++) pts.push(cubic(a, b.c1, b.c2, b, k / steps));
		} else {
			pts.push({ x: b.x, y: b.y });
		}
	}
	const s = [0];
	for (let i = 1; i < pts.length; i++) {
		s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
	}
	return { pts, s, length: s[s.length - 1] };
}

export interface Frame {
	p: Pt;
	// Unit tangent along the drawing direction.
	t: Pt;
	// Right-hand normal; lane offsets grow along it.
	n: Pt;
}

export function frameAt(path: PathSample, distance: number): Frame {
	const d = Math.max(0, Math.min(path.length, distance));
	let i = 1;
	while (i < path.s.length - 1 && path.s[i] < d) i++;
	const a = path.pts[i - 1];
	const b = path.pts[i];
	const span = path.s[i] - path.s[i - 1];
	const f = span > 1e-9 ? (d - path.s[i - 1]) / span : 0;
	const l = span > 1e-9 ? span : 1;
	const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
	return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, t, n: { x: -t.y, y: t.x } };
}

// Nearest distance along the path to a point.
export function project(path: PathSample, p: Pt) {
	let best = { s: 0, d: Infinity };
	for (let i = 1; i < path.pts.length; i++) {
		const a = path.pts[i - 1];
		const b = path.pts[i];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const l2 = dx * dx + dy * dy || 1;
		const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
		const d = Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
		if (d < best.d) best = { s: path.s[i - 1] + (path.s[i] - path.s[i - 1]) * f, d };
	}
	return best;
}

// ---- Cross-sections.

export interface LaneSpan {
	lane: Lane;
	// Offsets along the right normal.
	left: number;
	right: number;
}

export function crossSection(road: Road, distance: number): LaneSpan[] {
	const total = road.lanes.reduce((sum, lane) => sum + lane.width, 0);
	const spans: LaneSpan[] = [];
	let x = -total / 2 + road.offset + (road.lean ?? 0) * distance;
	for (const lane of road.lanes) {
		spans.push({ lane, left: x, right: x + lane.width });
		x += lane.width;
	}
	return spans;
}

// Distances at which to sample a road: regular steps from end to end.
export function sampleDistances(length: number) {
	const set = new Set<number>([0, length]);
	const step = 2;
	for (let d = step; d < length; d += step) set.add(d);
	return [...set].sort((a, b) => a - b);
}

// ---- Road ends.

export interface EndFrame {
	p: Pt;
	// Unit direction leaving the junction along the road's drawn line; the
	// road's end lies square to it.
	out: Pt;
	// Unit direction leaving the junction the way the road's lanes and lines
	// run there: `out` turned by the road's lean (a road shifted differently
	// at its two ends runs at a slant to its drawn line). Whatever carries a
	// lane edge, a curb or a line on across the junction leaves along this,
	// so it runs on from the road's own without a kink.
	run: Pt;
	// Right normal of the drawing direction (lane offsets grow along it).
	n: Pt;
	distance: number;
	spans: LaneSpan[];
}

export function endFrame(road: Road, path: PathSample, end: End): EndFrame {
	const distance = end === 'start' ? 0 : path.length;
	const frame = frameAt(path, end === 'start' ? 0 : path.length);
	const out = end === 'start' ? frame.t : { x: -frame.t.x, y: -frame.t.y };
	const lean = road.lean ?? 0;
	const slant = Math.hypot(1, lean) * (end === 'start' ? 1 : -1);
	const run = lean
		? { x: (frame.t.x + frame.n.x * lean) / slant, y: (frame.t.y + frame.n.y * lean) / slant }
		: out;
	return { p: frame.p, out, run, n: frame.n, distance, spans: crossSection(road, distance) };
}

export const offsetPoint = (p: Pt, n: Pt, d: number) => ({ x: p.x + n.x * d, y: p.y + n.y * d });

// What shapes the node between two roads, a taper where their lanes differ
// or a bend where they turn, to tune by eye. Its length is worked out with
// how far the roads are trimmed back (core/setbacks.ts); each lane edge then eases across it on
// curveBetween's even S (below), and each lane's line follows its path,
// whose width eases by EASE (connectionCurve in ends.ts).
export const TAPER = {
	// Metres along for each metre the lane that moves furthest shifts
	// sideways: higher draws a longer, gentler taper.
	ALONG_PER_SHIFT: 6,
	// Metres: the shortest taper worth drawing.
	SHORTEST: 8,
	// Metres along per metre of shift: a taper set by hand is never steeper.
	LEAST_ALONG_PER_SHIFT: 4,
	// The same two for a footpath easing sideways off a sidewalk (or onto
	// one), which does so more steeply, and may be set as steep as 1:1.
	WALK_ALONG_PER_SHIFT: 3,
	LEAST_WALK_ALONG_PER_SHIFT: 1,
	// Metres: a shift smaller than this needs no taper at all.
	NO_SHIFT: 0.05,
	// Metres each road stops short of a node where it carries straight on,
	// so the node has a little length to draw.
	THROUGH_GAP: 0.6,
	// A bend's radius, in half widths of the wider road: higher pulls both
	// roads back further and rounds the bend wider.
	BEND_RADIUS: 1.5,
	// Radians: past this a bend pulls the roads back no further, so a near
	// hairpin stays a tight turn rather than a long loop (2.4 is 137.5°).
	SHARPEST: 2.4,
	// Cosine: two roads whose headings differ by less than about 5.7° (this
	// and closer to 1) run straight on, with no bend.
	STRAIGHT: 0.995,
	// Fraction of the way across at which one road's lane gives way to the
	// other's in surface (a median running into hatching, asphalt into
	// concrete).
	SPLIT: 0.5,
	// Steps every lane edge, band, car path and line across the node is
	// sampled in, one count for all so they follow one curve: fewer shows
	// facets on a tight bend.
	STEPS: 32,
	// How a lane's width changes along the way across (0 to 1 in, 0 to 1
	// out): a smoothstep, so a lane keeping one edge where it was while it
	// narrows or widens keeps that edge straight.
	EASE: (t: number) => t * t * (3 - 2 * t)
};

// How many steps a car path across a junction is sampled in, by its chord:
// a point every STEP metres, never fewer than 6 steps nor more than 48.
const STEP = 1.2;
export const stepsAcross = (chord: number) => Math.max(6, Math.min(48, Math.ceil(chord / STEP)));

// A cubic from one lane end to another; `inDir` heads into the node, `outDir`
// leaves it.
export function curveBetween(p0: Pt, inDir: Pt, p3: Pt, outDir: Pt, samples: number) {
	const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
	// Handles of a circular arc turning through the angle between the two
	// directions, so a lane path through a bend follows the bend's curvature.
	// As the turn shrinks they lengthen smoothly to a third of the chord, so
	// ends nearly in line (a lane easing sideways) get an even S, never a
	// straight run with sharp ends.
	const turn = Math.acos(Math.max(-1, Math.min(1, inDir.x * outDir.x + inDir.y * outDir.y)));
	const k = turn < 1e-3 ? chord / 3 : (chord * (2 / 3) * Math.tan(turn / 4)) / Math.sin(turn / 2);
	const p1 = { x: p0.x + inDir.x * k, y: p0.y + inDir.y * k };
	const p2 = { x: p3.x - outDir.x * k, y: p3.y - outDir.y * k };
	const points: Pt[] = [];
	for (let i = 0; i <= samples; i++) points.push(cubic(p0, p1, p2, p3, i / samples));
	return points;
}

// Signed area, positive anticlockwise.
export const signedArea = (ring: Pt[]) =>
	ring.reduce((s, p, i) => {
		const q = ring[(i + 1) % ring.length];
		return s + (p.x * q.y - q.x * p.y) / 2;
	}, 0);

export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt, near = 1e-6) {
	// How far r lies to the left of the line through p and q.
	const side = (p: Pt, q: Pt, r: Pt) =>
		((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) /
		(Math.hypot(q.x - p.x, q.y - p.y) || 1);
	// Apart in either axis: no crossing (and no float noise between two
	// pieces of one straight line).
	if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x))
		return false;
	if (Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y))
		return false;
	// Lines that only meet don't cross: one running on at a slight angle from
	// where the other ends, its first point a float's width off the other's
	// last, touches it. Each end must lie clearly (`near`) on its side.
	const s = [side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)];
	if (s.some((v) => Math.abs(v) < near)) return false;
	return s[0] * s[1] < 0 && s[2] * s[3] < 0;
}

// Whether a corner of one segment lies on the other.
function segmentsTouch(a: Pt, b: Pt, c: Pt, d: Pt) {
	const on = (p: Pt, q: Pt, r: Pt) => {
		const [dx, dy] = [q.x - p.x, q.y - p.y];
		const f = Math.max(0, Math.min(1, ((r.x - p.x) * dx + (r.y - p.y) * dy) / (dx * dx + dy * dy)));
		return Math.hypot(p.x + dx * f - r.x, p.y + dy * f - r.y) < 1e-6;
	};
	return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

// A closed line crosses itself where two edges that don't share a corner
// cross, by more than clipper's millimetre grid can put a point off a line;
// with `touching`, also where they only meet (a corner of one on the other:
// two lobes pinched together at a point). Edges are taken in order along the
// axis the line is longer in, each against those starting before it ends.
export function crossesItself(ring: Pt[], touching = false) {
	const n = ring.length;
	const span = (key: 'x' | 'y') =>
		Math.max(...ring.map((p) => p[key])) - Math.min(...ring.map((p) => p[key]));
	const key = span('x') >= span('y') ? 'x' : 'y';
	const edges = ring.map((a, i) => {
		const b = ring[(i + 1) % n];
		return { i, a, b, lo: Math.min(a[key], b[key]), hi: Math.max(a[key], b[key]) };
	});
	edges.sort((u, v) => u.lo - v.lo);
	for (let k = 0; k < n; k++) {
		const u = edges[k];
		for (let m = k + 1; m < n && edges[m].lo <= u.hi; m++) {
			const v = edges[m];
			const gap = Math.abs(u.i - v.i);
			if (gap <= 1 || gap === n - 1) continue;
			if (segmentsCross(u.a, u.b, v.a, v.b, 0.002)) return true;
			if (touching && segmentsTouch(u.a, u.b, v.a, v.b)) return true;
		}
	}
	return false;
}

// Whether a strip is folded, read off what is drawn of it: each quad
// between two samples is two triangles sharing the diagonal from its first
// left corner to its second right one (strip in rendering/road-meshes.ts),
// and one turned over lies on the other even where the quad's whole area
// stays positive; or two edges of the strip's outline cross.
export function folded({ left, right }: Ribbon) {
	for (let i = 1; i < left.length; i++) {
		const [a, b, c, d] = [left[i - 1], left[i], right[i], right[i - 1]];
		if (signedArea([a, b, c]) < -1e-9 || signedArea([a, c, d]) < -1e-9) return true;
	}
	return crossesItself([...left, ...[...right].reverse()]);
}

// A strip between two lines of equal point count, as a ribbon. Folded (where
// a bend is tighter than the strip's offset) it becomes rings instead: the
// strip's outline filled by winding, so ground the fold covers both ways
// round is left out, grown a centimetre. Grown only once its holes are
// sliced away: clipper's offset can take a hole that touches the outline's
// lowest point for the outline, and shrink the whole strip away. `faults` is
// toRings's.
export function ribbonOf(left: Pt[], right: Pt[], faults: Pt[]): Ribbon | Ring[] {
	const ribbon = { left, right };
	if (!folded(ribbon)) return ribbon;
	const outline = union([toPath([...left, ...[...right].reverse()])]);
	return toRings(toRings(outline, faults).map(toPath), faults, 0.01);
}

// Whether a point lies inside rings, holes wound the other way (as clipper
// gives them): the rings' winding round it is not zero.
export function within(rings: Pt[][], p: Pt) {
	return windingAt(rings.flatMap(edgesOf), p) !== 0;
}

type Edge = [Pt, Pt];
const edgesOf = (ring: Pt[]) => ring.map((c, k): Edge => [c, ring[(k + 1) % ring.length]]);

// How many times edges of rings wind round a point (those level with it are
// enough).
function windingAt(edges: Edge[], p: Pt) {
	let winding = 0;
	for (const [a, b] of edges) {
		const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
		if (a.y <= p.y && b.y > p.y && side > 0) winding++;
		else if (a.y > p.y && b.y <= p.y && side < 0) winding--;
	}
	return winding;
}

// Rings' edges sorted into horizontal strips, about two edges a strip, each
// edge in every strip its height spans: a point or a segment is tested only
// against the edges in the strips it lies in, which for the outlines a node
// has (no edge spanning much of the whole) is a handful.
function stripsOf(rings: Pt[][]) {
	const edges = rings.flatMap(edgesOf);
	const ys = edges.map(([c]) => c.y);
	const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
	const n = Math.max(1, Math.ceil(edges.length / 2));
	const h = (y1 - y0) / n || 1;
	const row = (y: number) => Math.max(0, Math.min(n - 1, Math.floor((y - y0) / h)));
	const strips: Edge[][] = Array.from({ length: n }, () => []);
	for (const e of edges)
		for (let i = row(Math.min(e[0].y, e[1].y)); i <= row(Math.max(e[0].y, e[1].y)); i++)
			strips[i].push(e);
	// The edges in the strips from one height to another, each once.
	const level = (ya: number, yb: number) => {
		const [i0, i1] = [row(Math.min(ya, yb)), row(Math.max(ya, yb))];
		if (i0 === i1) return strips[i0];
		return [...new Set(strips.slice(i0, i1 + 1).flat())];
	};
	return { level };
}

// The pieces of a polyline inside rings (holes as in `within`): each segment
// is cut where it crosses a ring's edge, at the exact crossing, and each
// stretch between cuts kept or not as its middle lies. Each piece comes with
// how far along the whole line each of its points is.
export function cutLine(line: Pt[], rings: Pt[][]) {
	const { level } = stripsOf(rings);
	const at = (a: Pt, b: Pt, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
	const pieces: { line: Pt[]; along: number[] }[] = [];
	let piece: { line: Pt[]; along: number[] } | null = null;
	let s = 0;
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const [dx, dy] = [b.x - a.x, b.y - a.y];
		const [sa, length] = [s, Math.hypot(dx, dy)];
		s += length;
		const cuts = [0, 1];
		const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
		for (const [c, d] of level(a.y, b.y)) {
			if (Math.max(c.x, d.x) < x0 || Math.min(c.x, d.x) > x1) continue;
			const [ex, ey] = [d.x - c.x, d.y - c.y];
			const den = dx * ey - dy * ex;
			if (Math.abs(den) < 1e-12) continue;
			const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
			const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
			if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
		}
		cuts.sort((x, y) => x - y);
		for (let j = 1; j < cuts.length; j++) {
			const [t0, t1] = [cuts[j - 1], cuts[j]];
			if (t1 - t0 < 1e-9) continue;
			const mid = at(a, b, (t0 + t1) / 2);
			if (windingAt(level(mid.y, mid.y), mid) !== 0) {
				piece ??= { line: [t0 === 0 ? a : at(a, b, t0)], along: [sa + length * t0] };
				piece.line.push(t1 === 1 ? b : at(a, b, t1));
				piece.along.push(sa + length * t1);
			} else if (piece) {
				pieces.push(piece);
				piece = null;
			}
		}
	}
	if (piece) pieces.push(piece);
	return pieces;
}

// The point a fraction f of the way from p to q.
export const mix = (p: Pt, q: Pt, f: number) => ({
	x: p.x + (q.x - p.x) * f,
	y: p.y + (q.y - p.y) * f
});

export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
export const neg = (a: Pt) => ({ x: -a.x, y: -a.y });
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

// Whether two segments cross, a touch not counting.
export const crosses = (a: Pt, b: Pt, c: Pt, d: Pt) => segmentsCross(a, b, c, d, 0);

// A polyline less any point within a centimetre of the one before.
export const dedupe = (pts: Pt[]) => pts.filter((q, i) => i === 0 || dist(q, pts[i - 1]) > 0.01);

// Bars half a metre wide across a polyline, one every metre from half a metre
// in, each reaching 0.3 m past `width / 2` either side of it.
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

// The rectangle along a to b, `w` either side of it.
export function quad(a: Pt, b: Pt, w: number): Pt[] {
	const l = dist(a, b) || 1;
	const n = { x: (-(b.y - a.y) / l) * w, y: ((b.x - a.x) / l) * w };
	return [
		{ x: a.x + n.x, y: a.y + n.y },
		{ x: b.x + n.x, y: b.y + n.y },
		{ x: b.x - n.x, y: b.y - n.y },
		{ x: a.x - n.x, y: a.y - n.y }
	];
}
