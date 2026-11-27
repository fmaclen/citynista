// Road geometry: the drawn line, and the cross-section at any distance along
// it.

import { fromPath, intersect, toPath, toRings, union, type Path, type Paths } from './clip';
import type { Ribbon, Ring } from './description';
import { type End, isRoadway, type Lane, type Pt, type Road } from './model';

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

// The first of a path's distances from the second on that is at or past
// `d`, or the last: the end of the piece of the path `d` lies on. Halved
// down to, so a long path costs no more to read than a short one.
export function pieceAt(s: number[], d: number) {
	let [lo, hi] = [1, s.length - 1];
	while (lo < hi) {
		const m = (lo + hi) >> 1;
		if (s[m] < d) lo = m + 1;
		else hi = m;
	}
	return lo;
}

export function frameAt(path: PathSample, distance: number): Frame {
	const d = Math.max(0, Math.min(path.length, distance));
	const i = pieceAt(path.s, d);
	const a = path.pts[i - 1];
	const b = path.pts[i];
	const span = path.s[i] - path.s[i - 1];
	const f = span > 1e-9 ? (d - path.s[i - 1]) / span : 0;
	const l = span > 1e-9 ? span : 1;
	const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
	return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, t, n: { x: -t.y, y: t.x } };
}

// Nearest distance along the path to a point (`s`), and how far it lies
// from the path there (`d`): of the path's pieces nearest the point, the
// first. A long path is read through a tree of boxes round runs of its
// pieces (`boxTree`), each run looked into only where its box comes as near
// the point as the nearest piece found so far, so finding it reads only the
// pieces near the point, whatever the path's length.
export function project(path: PathSample, p: Pt) {
	const best = { s: 0, d: Infinity, i: 0 };
	const n = path.pts.length;
	if (n <= 2 * LEAF + 1) {
		pieceNear(path, p, 0, n - 1, best);
		return { s: best.s, d: best.d };
	}
	const tree = pathTree(path);
	const visit = (k: number) => {
		const node = tree[k];
		if (boxDistance(node, p) > best.d + 1e-9) return;
		if (node.to - node.from <= LEAF) {
			pieceNear(path, p, node.from, node.to, best);
			return;
		}
		const [a, b] = [2 * k + 1, 2 * k + 2];
		const [first, then] = boxDistance(tree[b], p) < boxDistance(tree[a], p) ? [b, a] : [a, b];
		visit(first);
		visit(then);
	};
	visit(0);
	return { s: best.s, d: best.d };
}

// Pieces `from` to `to - 1` of a path (piece j from point j to point j + 1)
// read as a scan along the whole path reads them: the nearest kept, and of
// two as near the first.
function pieceNear(
	path: PathSample,
	p: Pt,
	from: number,
	to: number,
	best: { s: number; d: number; i: number }
) {
	for (let i = from + 1; i <= to; i++) {
		const a = path.pts[i - 1];
		const b = path.pts[i];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const l2 = dx * dx + dy * dy || 1;
		const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
		const d = Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
		if (d < best.d || (d === best.d && i < best.i)) {
			best.s = path.s[i - 1] + (path.s[i] - path.s[i - 1]) * f;
			best.d = d;
			best.i = i;
		}
	}
}

// Things in a row (the pieces of a path, say) in a tree of the boxes round
// runs of them: node k holds things `from` to `to - 1`, halved between nodes
// 2k + 1 and 2k + 2 down to LEAF of them. So what lies near a point or a box
// is found reading only the runs near it.
const LEAF = 8;
export type BoxNode = { from: number; to: number; x0: number; y0: number; x1: number; y1: number };
export function boxTree(count: number, boxAt: (i: number) => [number, number, number, number]) {
	const nodes: BoxNode[] = [];
	const build = (k: number, from: number, to: number): BoxNode => {
		let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
		if (to - from <= LEAF)
			for (let i = from; i < to; i++) {
				const b = boxAt(i);
				[x0, y0, x1, y1] = [
					Math.min(x0, b[0]),
					Math.min(y0, b[1]),
					Math.max(x1, b[2]),
					Math.max(y1, b[3])
				];
			}
		else {
			const mid = (from + to) >> 1;
			const [a, b] = [build(2 * k + 1, from, mid), build(2 * k + 2, mid, to)];
			[x0, y0, x1, y1] = [
				Math.min(a.x0, b.x0),
				Math.min(a.y0, b.y0),
				Math.max(a.x1, b.x1),
				Math.max(a.y1, b.y1)
			];
		}
		return (nodes[k] = { from, to, x0, y0, x1, y1 });
	};
	if (count > 0) build(0, 0, count);
	return nodes;
}

// The first and last of the things in a box tree whose boxes (`boxAt`) meet
// a box, or null.
function runNear(
	tree: BoxNode[],
	boxAt: (i: number) => [number, number, number, number],
	box: [number, number, number, number]
): [number, number] | null {
	let [lo, hi] = [Infinity, -Infinity];
	const meets = (b: { x0: number; y0: number; x1: number; y1: number }) =>
		b.x0 <= box[2] && box[0] <= b.x1 && b.y0 <= box[3] && box[1] <= b.y1;
	const visit = (k: number) => {
		const node = tree[k];
		if (!node || !meets(node) || (node.from >= lo && node.to - 1 <= hi)) return;
		if (node.to - node.from <= LEAF) {
			for (let i = node.from; i < node.to; i++) {
				const [x0, y0, x1, y1] = boxAt(i);
				if (meets({ x0, y0, x1, y1 })) [lo, hi] = [Math.min(lo, i), Math.max(hi, i)];
			}
			return;
		}
		visit(2 * k + 1);
		visit(2 * k + 2);
	};
	visit(0);
	return lo <= hi ? [lo, hi] : null;
}

// A strip along a road between two of its edges (a lane's ground, or its
// roadway's), kept with the road's sampled path, which PlaceBuilder keeps
// (with the road it was sampled from) while the road's shape, lanes and
// shifts stay the same, from build to build: each edge's points at the
// strip's rows (`edges`, made once per path and `key`), the boxes round its
// pieces (piece i between rows i and i + 1) in a tree, and the runs of it
// read so far.
type Box4 = [number, number, number, number];
export type Strip = {
	left: Pt[];
	right: Pt[];
	box: (i: number) => Box4;
	tree: BoxNode[];
	runs: Map<string, Path>;
};
const strips = new WeakMap<PathSample, Map<string, Strip>>();
export function stripOf(path: PathSample, key: string, edges: () => readonly [Pt[], Pt[]]) {
	let known = strips.get(path);
	if (!known) strips.set(path, (known = new Map()));
	let strip = known.get(key);
	if (!strip) {
		const [left, right] = edges();
		const box = (i: number): Box4 => {
			const pts = [left[i], left[i + 1], right[i], right[i + 1]];
			return [
				Math.min(...pts.map((p) => p.x)),
				Math.min(...pts.map((p) => p.y)),
				Math.max(...pts.map((p) => p.x)),
				Math.max(...pts.map((p) => p.y))
			];
		};
		strip = { left, right, box, tree: boxTree(left.length - 1, box), runs: new Map() };
		known.set(key, strip);
	}
	return strip;
}

// How far round some rings a strip is read (stripNear), m.
const NEAR = 1;

// A strip's ground near some rings: the run of its pieces from the first to
// the last whose boxes come within NEAR of theirs. Its two ends cut across
// the strip where a piece lying further off begins, so the run is the whole
// strip's ground wherever it comes near them, point for point, and what
// reads it there reads it alone, however long the road. Empty where none
// comes near. It is the whole strip to rounding: what is drawn from it has
// the same pieces, rings and vertex counts as from the whole strip, every
// coordinate within 5 mm. Clipper is not local (it sweeps all of an
// operation's vertices at once), so against the rings it may place a point
// where they cross a millimetre or two off where it would against the whole
// strip, now and then; reading the strip whole would give back most of what
// this saves (road-model doc).
export function stripNear(strip: Strip, rings: Paths): Path {
	if (!rings.length) return [];
	const pts = rings.flatMap(fromPath);
	const xs = pts.map((p) => p.x);
	const ys = pts.map((p) => p.y);
	const run = runNear(strip.tree, strip.box, [
		Math.min(...xs) - NEAR,
		Math.min(...ys) - NEAR,
		Math.max(...xs) + NEAR,
		Math.max(...ys) + NEAR
	]);
	if (!run) return [];
	const key = `${run[0]}:${run[1]}`;
	let path = strip.runs.get(key);
	if (!path) {
		const [i, j] = [run[0], run[1] + 2];
		path = toPath([...strip.left.slice(i, j), ...strip.right.slice(i, j).reverse()]);
		strip.runs.set(key, path);
	}
	return path;
}

// The box round piece i of a path.
const pieceBox =
	(path: PathSample) =>
	(i: number): [number, number, number, number] => {
		const [a, b] = [path.pts[i], path.pts[i + 1]];
		return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
	};
const trees = new WeakMap<PathSample, BoxNode[]>();
// A path's pieces in a box tree, built once for each path.
function pathTree(path: PathSample) {
	let tree = trees.get(path);
	if (!tree) trees.set(path, (tree = boxTree(path.pts.length - 1, pieceBox(path))));
	return tree;
}

// How near a point a box comes.
const boxDistance = (b: BoxNode, p: Pt) =>
	Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1));

// How far along a path a point lies, read on past either end along the
// path's way there.
export function alongPath(path: PathSample, p: Pt) {
	const { s } = project(path, p);
	if (s > 1e-9 && s < path.length - 1e-9) return s;
	const end = s <= 1e-9 ? 0 : path.length;
	const f = frameAt(path, end);
	return end + (p.x - f.p.x) * f.t.x + (p.y - f.p.y) * f.t.y;
}

// The stretch of a road's roadway (its outermost roadway lanes, edge to
// edge; or of the lanes `keep` keeps) that a ring lies over: from and to how
// far along it, or null where it lies over none. It reads the roadway near
// the ring alone (stripNear).
export function stretchOver(
	road: Road,
	path: PathSample,
	ring: Path,
	keep: (lane: Lane) => boolean = isRoadway
) {
	const first = road.lanes.findIndex(keep);
	const last = road.lanes.findLastIndex(keep);
	if (first < 0) return null;
	const edge = (side: 'left' | 'right') =>
		path.s.map((d) => {
			const f = frameAt(path, d);
			const spans = crossSection(road, d);
			return offsetPoint(f.p, f.n, side === 'left' ? spans[first].left : spans[last].right);
		});
	const strip = stripOf(path, `roadway ${first} ${last}`, () => [edge('left'), edge('right')]);
	const ground = stripNear(strip, [ring]);
	if (!ground.length) return null;
	const along = intersect([ring], [ground])
		.flatMap(fromPath)
		.map((p) => project(path, p).s);
	return along.length ? { from: Math.min(...along), to: Math.max(...along) } : null;
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
	// The same two for sidewalks easing sideways where no car lane carries
	// on, which do so more steeply, and may be set as steep as 1:1.
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

// The smallest convex polygon holding every point, wound to a positive area
// (Andrew's monotone chain).
export function hullOf(pts: Pt[]): Pt[] {
	const sorted = [...pts].sort((p, q) => p.x - q.x || p.y - q.y);
	const turn = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const chain = (list: Pt[]) => {
		const out: Pt[] = [];
		for (const p of list) {
			while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
			out.push(p);
		}
		return out.slice(0, -1);
	};
	return [...chain(sorted), ...chain([...sorted].reverse())];
}

// A polyline's points, `step` apart at the most: its own, and as few more
// as each stretch needs, spaced evenly along it.
export function sampled(line: Pt[], step: number) {
	return line.flatMap((q, k) => {
		if (!k) return [q];
		const a = line[k - 1];
		const n = Math.max(1, Math.ceil(Math.hypot(q.x - a.x, q.y - a.y) / step));
		return Array.from({ length: n }, (_, i) => ({
			x: a.x + ((q.x - a.x) * (i + 1)) / n,
			y: a.y + ((q.y - a.y) * (i + 1)) / n
		}));
	});
}

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
