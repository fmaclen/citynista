// Small Clipper wrappers for the road model: world metres in, integer millimetres
// inside Clipper.

import ClipperLib from 'clipper-lib';
import type { Path, Paths, PolyNode } from 'clipper-lib';
import type { Pt } from './model';

const SCALE = 1000;

export type { Path, Paths };

// A closed ring, wound positively, so overlapping rings always add up under
// the nonzero fill rule instead of cancelling out. The loops of a ring that
// crosses itself are wound both ways, so union one alone before adding it.
export const toPath = (points: Pt[]): Path => {
	const path = points.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
	return ClipperLib.Clipper.Area(path) < 0 ? path.reverse() : path;
};

export const fromPath = (path: Path): Pt[] => path.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }));

// The points handed to Clipper, every array of them, counted only while a
// test turns counting on (`on`): with it off nothing here is written, so
// shipped code pays nothing for it. Work that reads a road whole
// is counted apart (`whole`, inside `wholly`): describing a car piece afresh
// with what is laid over it, and the ground of a road a footpath is laid
// over and a crossing is cut from, which Clipper cannot read in part
// without moving a vertex of the result now and then, a millimetre or so
// (docs/road-model.md). The rest (`near`) is what tests hold to what an
// edit changed, however long the road.
export const clipped = { on: false, near: 0, whole: 0, depth: 0 };
const count = (paths: Paths) => {
	if (!clipped.on) return;
	let n = 0;
	for (const p of paths) n += p.length;
	if (clipped.depth) clipped.whole += n;
	else clipped.near += n;
};
export function wholly<T>(work: () => T): T {
	if (!clipped.on) return work();
	clipped.depth++;
	try {
		return work();
	} finally {
		clipped.depth--;
	}
}

function run(type: number, subject: Paths, clip: Paths): Paths {
	count(subject);
	count(clip);
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
	if (clip.length > 0) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
	const out: Paths = [];
	clipper.Execute(
		type,
		out,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return out;
}

export const union = (paths: Paths) =>
	paths.length ? run(ClipperLib.ClipType.ctUnion, paths, []) : [];
export const intersect = (a: Paths, b: Paths) =>
	a.length && b.length ? run(ClipperLib.ClipType.ctIntersection, a, b) : [];
export const subtract = (a: Paths, b: Paths) =>
	a.length ? (b.length ? run(ClipperLib.ClipType.ctDifference, a, b) : a) : [];

export function offset(paths: Paths, delta: number): Paths {
	if (paths.length === 0) return [];
	count(paths);
	const o = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
	o.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
	const out: Paths = [];
	o.Execute(out, delta * SCALE);
	return out;
}

// Shrunk by `d` with mitred corners (squared past twice `d`), so every point
// left lies at least `d` inside: a round join's chords would cut corners.
export function inset(paths: Paths, d: number): Paths {
	if (paths.length === 0) return [];
	count(paths);
	const o = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
	o.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
	const out: Paths = [];
	o.Execute(out, -d * SCALE);
	return out;
}

// A band `half` either side of an open polyline, square at its ends.
export function offsetLine(points: Pt[], half: number): Paths {
	if (points.length < 2) return [];
	const o = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
	const path = points.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
	count([path]);
	o.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenButt);
	const out: Paths = [];
	o.Execute(out, half * SCALE);
	return out;
}

// Dilate then erode: fills gaps and notches narrower than 2r.
export const close = (paths: Paths, r: number) => offset(offset(paths, r), -r);
// Erode then dilate: removes parts thinner than 2r and rounds corners.
export const open = (paths: Paths, r: number) => offset(offset(paths, -r), r);

// Signed area in square metres (sign follows ring orientation).
export const area = (path: Path) => ClipperLib.Clipper.Area(path) / (SCALE * SCALE);

const contains = (path: Path, p: Pt) =>
	ClipperLib.Clipper.PointInPolygon(
		{ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) },
		path
	) !== 0;

// Whether a point is inside a set of rings, holes respected (nonzero).
export function inside(paths: Paths, p: Pt) {
	let winding = 0;
	for (const path of paths) {
		if (!contains(path, p)) continue;
		winding += area(path) > 0 ? 1 : -1;
	}
	return winding !== 0;
}

interface Polygon {
	outer: Pt[];
	holes: Pt[][];
}

// Pieces of a set of rings ready to triangulate, grown by `grow` metres
// first (negative shrinks). THREE.ShapeGeometry's earcut intermittently
// mis-triangulates polygons with holes, so every holed polygon is cut into
// simply connected pieces: sliced across at each hole.
function toPolygons(paths: Paths, grow: number, slices = 4, strict = false): Polygon[] {
	if (paths.length === 0) return [];
	const grown = grow ? offset(paths, grow) : paths;
	const out: Polygon[] = [];
	for (const polygon of polygonsOf(grown.length ? grown : paths, strict))
		slice(polygon, slices, strict, out);
	return out;
}

// A spike thinner than this has no width: a tenth of clipper's grid.
const NO_WIDTH = 1e-4;

// A ring less its spikes of no width: each corner where it turns straight
// back along the edge it came by. Clipper leaves one where two edges meant to
// coincide round a hair apart (a median's side and its strip's), running out
// along the edge and back, and a ring with one touches itself.
function unspiked(ring: Pt[]) {
	const pts = [...ring];
	// Round the ring until every corner has been passed with none removed.
	for (let i = 0, sound = 0; sound < pts.length && pts.length > 3; i = (i + 1) % pts.length) {
		const n = pts.length;
		const [a, b, c] = [pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]];
		const [u, v] = [
			{ x: a.x - b.x, y: a.y - b.y },
			{ x: c.x - b.x, y: c.y - b.y }
		];
		// How far the shorter edge's end lies off the longer edge.
		const long = Math.max(Math.hypot(u.x, u.y), Math.hypot(v.x, v.y)) || 1;
		const width = Math.abs(u.x * v.y - u.y * v.x) / long;
		if (u.x * v.x + u.y * v.y > 0 && width < NO_WIDTH) {
			pts.splice(i, 1);
			// The corner before it next.
			i = (i + n - 3) % (n - 1);
			sound = 0;
		} else sound++;
	}
	return pts;
}

// The only way a clipper result becomes a description's rings (description.ts):
// each strictly simple (not even touching itself), wound positively, with no
// holes, sliced away as toPolygons does but until none is left. A hole it
// could not slice away is dropped, its ring left covering it, and a point of
// that ring added to `faults`: the caller's list, which it hands on with its
// description (`faults` there) for checks.ts to report.
//
// Points of `exact` (where something else's exact edges end) that the grid
// put a hair off are put back exactly: in place of a ring's point within
// NEAR of one, or into the edge one lies on, where clipper dropped it as
// collinear. A sliver of a ring left with fewer than three points is
// dropped.
export function toRings(paths: Paths, faults: Pt[], grow = 0, exact: Pt[] = []): Pt[][] {
	const rings = toPolygons(paths, grow, 12, true).map((polygon) => {
		if (polygon.holes.length) faults.push(polygon.outer[0]);
		return unspiked(polygon.outer);
	});
	if (!exact.length) return rings;
	const near = (p: Pt) => exact.find((e) => Math.hypot(e.x - p.x, e.y - p.y) < NEAR);
	const placed = new Set(rings.flat().flatMap((p) => near(p) ?? []));
	const rest = exact.filter((e) => !placed.has(e));
	return (
		rings
			.map((ring) =>
				ring
					.flatMap((p, i) => {
						const q = ring[(i + 1) % ring.length];
						const [dx, dy] = [q.x - p.x, q.y - p.y];
						const l2 = dx * dx + dy * dy || 1;
						const on = rest
							.map((e) => ({ e, t: ((e.x - p.x) * dx + (e.y - p.y) * dy) / l2 }))
							.filter(
								({ e, t }) =>
									t > 0 && t < 1 && Math.hypot(p.x + dx * t - e.x, p.y + dy * t - e.y) < NEAR
							)
							.sort((a, b) => a.t - b.t)
							.map(({ e }) => e);
						return [near(p) ?? p, ...on];
					})
					// Two of a ring's points put back on one exact point are one.
					.filter((p, i, list) => p !== list[(i + 1) % list.length])
			)
			// A sliver whose points all went back onto fewer than three is gone.
			.filter((ring) => ring.length >= 3)
	);
}

// Half of clipper's grid, and a little.
const NEAR = 0.0015;

// Outer rings with their holes (islands inside holes come out on their own).
function polygonsOf(paths: Paths, strict: boolean): Polygon[] {
	count(paths);
	const clipper = new ClipperLib.Clipper();
	clipper.StrictlySimple = strict;
	clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
	const tree = new ClipperLib.PolyTree();
	clipper.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	const out: Polygon[] = [];
	const visit = (outer: PolyNode) => {
		const polygon: Polygon = { outer: fromPath(outer.Contour()), holes: [] };
		for (const hole of outer.Childs()) {
			polygon.holes.push(fromPath(hole.Contour()));
			for (const island of hole.Childs()) visit(island);
		}
		out.push(polygon);
	};
	for (const child of tree.Childs()) visit(child);
	return out;
}

// Each piece of a set of rings on its own, with its holes (islands inside
// holes come out on their own).
export function piecesOf(paths: Paths): Paths[] {
	if (!paths.length) return [];
	count(paths);
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
	const tree = new ClipperLib.PolyTree();
	clipper.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	const out: Paths[] = [];
	const visit = (outer: PolyNode) => {
		out.push([outer.Contour(), ...outer.Childs().map((hole) => hole.Contour())]);
		for (const hole of outer.Childs()) for (const island of hole.Childs()) visit(island);
	};
	for (const child of tree.Childs()) visit(child);
	return out;
}

// Slices `left` more times at most.
function slice(polygon: Polygon, left: number, strict: boolean, out: Polygon[]) {
	if (polygon.holes.length === 0 || left <= 0) {
		out.push(polygon);
		return;
	}
	const xs = polygon.outer.map((p) => p.x);
	const ys = polygon.outer.map((p) => p.y);
	const [x0, x1] = [Math.min(...xs) - 1, Math.max(...xs) + 1];
	const mid = (ring: Pt[]) => ring.reduce((s, p) => s + p.y, 0) / ring.length;
	const cuts = [...new Set(polygon.holes.map(mid))].sort((a, b) => a - b);
	const bounds = [Math.min(...ys) - 1, ...cuts, Math.max(...ys) + 1];
	const rings = [toPath(polygon.outer), ...polygon.holes.map((h) => toPath(h).reverse())];
	for (let i = 0; i < bounds.length - 1; i++) {
		if (bounds[i + 1] - bounds[i] < 0.001) continue;
		const slab = toPath([
			{ x: x0, y: bounds[i] },
			{ x: x1, y: bounds[i] },
			{ x: x1, y: bounds[i + 1] },
			{ x: x0, y: bounds[i + 1] }
		]);
		for (const piece of polygonsOf(intersect(rings, [slab]), strict))
			slice(piece, left - 1, strict, out);
	}
}
