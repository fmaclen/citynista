// Lane-use arrows painted on an approach, one closed outline per set of
// moves a lane may make.
//
// Shapes are from FHWA "Standard Highway Signs" (2004, metric), Pavement
// Markings chapter: page 10-10 (straight arrow, 3.0 m; turn arrow, 2.5 m,
// R 0.7 m inside the bend) and page 10-8 (straight-and-turn arrow, 4.0 m).
// Those drawings sit on a 100 mm grid that matches their dimensions, so the
// points below are read straight off them. The English edition (12.75 ft,
// 9.5 ft, 8.0 ft) is the same drawing in feet; MUTCD 11th Edition Figure
// 3B-21 shows the same arrows and refers to the book for sizes.
//
// The book's arrows differ in length. Here the straight tail of the
// straight and turn arrows is lengthened on purpose so every arrow is as
// long as the straight-and-turn one: arrows side by side on an approach
// start and end level. Heads, the 0.3 m stem and the bends are the
// book's.
//
// Local frame, metres: x across the lane (right of travel positive), y
// along it, the tail's end at y = 0 and the arrow pointing to +y.

import { union, toPath, fromPath, area } from './clip';
import type { Pt } from './model';

export type Move = 'through' | 'left' | 'right' | 'u';

export const ARROW_LENGTH = 4;

// A point, or a cubic Bézier from the previous point: two controls, then
// the end point.
type Step = [number, number] | [number, number, number, number, number, number];

function trace(steps: Step[]): Pt[] {
	const out: Pt[] = [];
	for (const s of steps) {
		if (s.length === 2) {
			out.push({ x: s[0], y: s[1] });
			continue;
		}
		const a = out[out.length - 1];
		const [b, c, d] = [
			{ x: s[0], y: s[1] },
			{ x: s[2], y: s[3] },
			{ x: s[4], y: s[5] }
		];
		for (let i = 1; i <= 8; i++) {
			const t = i / 8;
			const u = 1 - t;
			const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
			out.push({
				x: w[0] * a.x + w[1] * b.x + w[2] * c.x + w[3] * d.x,
				y: w[0] * a.y + w[1] * b.y + w[2] * c.y + w[3] * d.y
			});
		}
	}
	return out;
}

// Raise everything above the tail's end, lengthening the straight stem.
const lengthen = (pts: Pt[], by: number) => pts.map((p) => (p.y > 0 ? { x: p.x, y: p.y + by } : p));
const mirror = (pts: Pt[]) => pts.map((p) => ({ x: -p.x, y: p.y })).reverse();

// Straight arrow (page 10-10): head 1.6 m long and 1.0 m across.
const THROUGH = lengthen(
	trace([
		[-0.5, 1.4],
		[0, 3],
		[0.5, 1.4],
		[0.15, 1.7],
		[0.15, 0],
		[-0.15, 0],
		[-0.15, 1.7]
	]),
	1
);

// Left turn arrow (page 10-10): the arm leaves the stem round a 0.7 m
// bend inside and widens to 0.5 m at the head.
const LEFT = lengthen(
	trace([
		[-1.75, 1.7],
		[-0.85, 2.5],
		[-1.05, 1.8],
		[-0.85, 1.8],
		[-0.255, 1.754, 0.062, 1.439, 0.15, 0.9],
		[0.15, 0],
		[-0.15, 0],
		[-0.15, 0.6],
		[-0.215, 1.023, -0.427, 1.281, -0.85, 1.3],
		[-1.05, 1.3],
		[-0.95, 0.6]
	]),
	1.5
);

// Straight-and-left arrow (page 10-8): the turn arm branches low off a
// straight arrow's stem.
const THROUGH_LEFT = trace([
	[-0.95, 0.6],
	[-1.75, 1.7],
	[-0.85, 2.5],
	[-1.05, 1.8],
	[-0.66, 1.819, -0.369, 1.742, -0.15, 1.55],
	[-0.15, 2.7],
	[-0.5, 2.4],
	[0, 4],
	[0.5, 2.4],
	[0.15, 2.7],
	[0.15, 0],
	[-0.15, 0],
	[-0.15, 0.5],
	[-0.163, 0.971, -0.367, 1.265, -0.85, 1.3],
	[-1.05, 1.3]
]);

// U-turn arrow. MUTCD Figure 3B-21 (D) shows one, but the book has no
// dimensioned drawing of it yet, so it is put together from the book's
// parts: the 0.3 m stem bent through a half circle (0.7 m inside, 1.0 m
// outside, as the turn arrow) and the straight arrow's head turned back.
function uTurn(): Pt[] {
	const c = { x: -0.85, y: ARROW_LENGTH - 1 };
	const arc = (r: number, from: number, to: number) =>
		Array.from({ length: 17 }, (_, i) => {
			const a = from + ((to - from) * i) / 16;
			return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
		});
	const leg = c.x - 0.85;
	return [
		{ x: -0.15, y: 0 },
		{ x: 0.15, y: 0 },
		...arc(1, 0, Math.PI),
		{ x: leg - 0.15, y: 1.9 },
		{ x: leg - 0.5, y: 1.6 },
		{ x: leg, y: 0 },
		{ x: leg + 0.5, y: 1.6 },
		{ x: leg + 0.15, y: 1.9 },
		...arc(0.7, Math.PI, 0)
	];
}

const RIGHT = mirror(LEFT);
const THROUGH_RIGHT = mirror(THROUGH_LEFT);
const U = uTurn();

// Sets of moves the book has no single drawing for are the union of its
// arrows on one stem: left and right is both turn arrows, all three both
// straight-and-turn arrows. The outer ring is kept, so an outline never
// has a hole.
function merged(parts: Pt[][]): Pt[] {
	if (parts.length === 1) return parts[0];
	const rings = union(parts.map(toPath));
	return fromPath(rings.reduce((a, b) => (area(b) > area(a) ? b : a)));
}

function outlineOf(moves: ReadonlySet<Move>): Pt[] {
	const through = moves.has('through');
	const parts: Pt[][] = [];
	if (moves.has('left')) parts.push(through ? THROUGH_LEFT : LEFT);
	if (moves.has('right')) parts.push(through ? THROUGH_RIGHT : RIGHT);
	if (through && parts.length === 0) parts.push(THROUGH);
	// Both bend off the stem to the left and would cross, so a lane that
	// also turns left shows the left arrow alone: US left-turn lanes allow
	// U-turns unless a sign says otherwise.
	if (moves.has('u') && !moves.has('left')) parts.push(U);
	return merged(parts);
}

const cache = new Map<string, Pt[]>();

// The outline for a lane's moves, centred across the lane (its widest
// points equally far either side of x = 0).
export function arrowOutline(moves: ReadonlySet<Move>): Pt[] {
	const key = (['through', 'left', 'right', 'u'] as const).filter((m) => moves.has(m)).join('+');
	let pts = cache.get(key);
	if (!pts) {
		const raw = outlineOf(moves);
		const xs = raw.map((p) => p.x);
		const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
		pts = raw.map((p) => ({ x: p.x - mid, y: p.y }));
		cache.set(key, pts);
	}
	return pts;
}

export function arrowWidth(outline: Pt[]) {
	return 2 * Math.max(...outline.map((p) => Math.abs(p.x)));
}
