// Small Clipper wrappers for the lab: world metres in, integer millimetres
// inside Clipper.

import ClipperLib from 'clipper-lib';
import type { Path, Paths, PolyNode } from 'clipper-lib';
import type { Pt } from './model';

const SCALE = 1000;

export type { Path, Paths };

// A closed ring, wound positively, so overlapping rings always add up under
// the nonzero fill rule instead of cancelling out.
export const toPath = (points: Pt[]): Path => {
	const path = points.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
	return ClipperLib.Clipper.Area(path) < 0 ? path.reverse() : path;
};

export const fromPath = (path: Path): Pt[] => path.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }));

function run(type: number, subject: Paths, clip: Paths): Paths {
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
	const o = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
	o.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
	const out: Paths = [];
	o.Execute(out, delta * SCALE);
	return out;
}

// A band `half` either side of an open polyline, square at its ends.
export function offsetLine(points: Pt[], half: number): Paths {
	if (points.length < 2) return [];
	const o = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
	const path = points.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
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

export const contains = (path: Path, p: Pt) =>
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

export interface Polygon {
	outer: Pt[];
	holes: Pt[][];
}

// Pieces of a set of rings ready to triangulate, grown by `grow` metres
// first (negative shrinks). THREE.ShapeGeometry's earcut intermittently
// mis-triangulates polygons with holes, so every holed polygon is cut into
// simply connected pieces: sliced across at each hole.
export function toPolygons(paths: Paths, grow: number): Polygon[] {
	if (paths.length === 0) return [];
	const grown = grow ? offset(paths, grow) : paths;
	const out: Polygon[] = [];
	for (const polygon of polygonsOf(grown.length ? grown : paths)) slice(polygon, 0, out);
	return out;
}

// Outer rings with their holes (islands inside holes come out on their own).
function polygonsOf(paths: Paths): Polygon[] {
	const clipper = new ClipperLib.Clipper();
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

const MAX_SLICES = 4;

function slice(polygon: Polygon, depth: number, out: Polygon[]) {
	if (polygon.holes.length === 0 || depth >= MAX_SLICES) {
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
		for (const piece of polygonsOf(intersect(rings, [slab]))) slice(piece, depth + 1, out);
	}
}
