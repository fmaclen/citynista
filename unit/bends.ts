import { WALK } from '../src/lib/core/footpaths';
import type { Scene } from '../src/lib/core/networks';
import { inside, piecesOf, toPath, union } from '../src/lib/road-model/clip';
import { offsetPoint } from '../src/lib/road-model/geometry';
import type { Pt } from '../src/lib/road-model/model';

// A footpath bend as the road model draws it (core/footpaths.ts), measured
// for tests in Node and in the browser alike: the node's one walker's line
// and the stretch of it between where the two strips stop (`round`), the
// circle through that stretch, and how the paving lies about it.

const sub = (a: Pt, b: Pt) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt) => ({ x: a.x / (len(a) || 1), y: a.y / (len(a) || 1) });

// The nearest point of a polyline to `p`: how far, and where along it (the
// segment and the fraction of the way along it).
function nearest(line: Pt[], p: Pt) {
	let best = { d: Infinity, i: 0, f: 0 };
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const ab = sub(b, a);
		const f = Math.max(
			0,
			Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (len(ab) ** 2 || 1))
		);
		const d = len(sub(p, { x: a.x + ab.x * f, y: a.y + ab.y * f }));
		if (d < best.d) best = { d, i: i - 1, f };
	}
	return best;
}

// The circle through three points.
function circleThrough(a: Pt, b: Pt, c: Pt) {
	const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
	const sq = (p: Pt) => p.x * p.x + p.y * p.y;
	const centre = {
		x: (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d,
		y: (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d
	};
	return { centre, radius: len(sub(a, centre)) };
}

// Whether a list of numbers only grows or only shrinks, give or take `tol`.
export const oneWay = (xs: number[], tol = 0.01) =>
	xs.every((x, k) => !k || x >= xs[k - 1] - tol) || xs.every((x, k) => !k || x <= xs[k - 1] + tol);

// The bend at footpath node `node` (at `at`) in `scene`.
export function bendAt(scene: Scene, node: string, at: Pt) {
	const d = scene.node(WALK + node)!;
	const { line, widths } = d.paths[0];
	// Where each strip stops: the middle of its cross-section, its half
	// width, and the way it runs off from the node.
	const ends = d.ends.map((e) => {
		const { p, n, run, spans } = e.frame;
		const [l, r] = [spans[0].left, spans.at(-1)!.right];
		return { road: e.ref.road, m: offsetPoint(p, n, (l + r) / 2), half: (r - l) / 2, run };
	});
	const [ia, ib] = ends.map((e) => nearest(line, e.m)).map((q) => q.i + Math.round(q.f));
	const round = line.slice(Math.min(ia, ib), Math.max(ia, ib) + 1);
	const { centre, radius } = circleThrough(
		round[0],
		round[Math.floor(round.length / 2)],
		round.at(-1)!
	);
	const rings = d.surfaces.flatMap((s) => ('left' in s.shape ? [] : s.shape));
	const ground = union(rings.map(toPath));
	// How far each point of the paving's edge lies from the walker's line,
	// less half the width the line is drawn as there: every ring point but
	// the lane edges each strip's lanes meet it at, inside its cross-section
	// where it stops.
	const across = ends.map((e) => ({ m: e.m, along: e.run, half: e.half }));
	const onEnd = (p: Pt) =>
		across.some((e) => {
			const q = sub(p, e.m);
			return Math.abs(q.x * e.along.x + q.y * e.along.y) < 1e-6 && len(q) < e.half - 1e-6;
		});
	const offEdge = rings
		.flat()
		.filter((p) => !onEnd(p))
		.map((p) => {
			const q = nearest(line, p);
			const w = widths[q.i] + (widths[q.i + 1] - widths[q.i]) * q.f;
			return q.d - w / 2;
		});
	// How far out the paving reaches either side of each point of the
	// stretch round, square to it, read every centimetre.
	const reach = (side: 1 | -1) =>
		round.slice(1, -1).map((p, k) => {
			const t = unit(sub(round[k + 2], round[k]));
			const n = { x: -t.y * side, y: t.x * side };
			let r = 0;
			while (r < 20 && inside(ground, offsetPoint(p, n, r + 0.01))) r += 0.01;
			return r;
		});
	return {
		description: d,
		line,
		ends,
		round,
		centre,
		radius,
		// How far each round point lies off the circle, at most.
		offCircle: Math.max(...round.map((p) => Math.abs(len(sub(p, centre)) - radius))),
		// How far the circle's radius at each end is off square to the way the
		// strip runs there: 0 where the stretch round leaves the strip's line
		// along it.
		offTangent: Math.max(
			...ends.map((e) =>
				Math.abs(unit(sub(e.m, centre)).x * e.run.x + unit(sub(e.m, centre)).y * e.run.y)
			)
		),
		// How far back from the node each strip stops.
		cuts: d.ends.map((e) => len(sub(e.frame.p, at))),
		// The deflection: how far the way turns going round the bend.
		deflection: Math.PI - Math.acos(ends[0].run.x * ends[1].run.x + ends[0].run.y * ends[1].run.y),
		offEdge,
		reach: { left: reach(1), right: reach(-1) },
		pieces: piecesOf(ground).length,
		coversNode: inside(ground, at)
	};
}
