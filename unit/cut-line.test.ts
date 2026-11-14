import { expect, test } from 'bun:test';
import { cutLine, within } from '../src/lib/road-model/geometry';
import type { Pt } from '../src/lib/road-model/model';

// Cutting a line to rings (cutLine): the pieces inside, found at a cost that
// grows with the line and the rings, not with the one times the other.

// A wavy ring of n points round a round hole, and a wavy line of n points
// across both, sampled as finely as the ring.
function shape(n: number) {
	const ring = Array.from({ length: n }, (_, i) => {
		const t = (2 * Math.PI * i) / n;
		const r = 50 + 3 * Math.sin(17 * t);
		return { x: r * Math.cos(t), y: r * Math.sin(t) };
	});
	const hole = Array.from({ length: n }, (_, i) => {
		const t = (-2 * Math.PI * i) / n;
		return { x: 10 * Math.cos(t), y: 10 * Math.sin(t) };
	});
	const line = Array.from({ length: n }, (_, i) => {
		const x = -70 + (140 * i) / (n - 1);
		return { x, y: 2 * Math.sin(x / 3) };
	});
	return { rings: [ring, hole], line };
}

test('a line cut to a ring with a hole keeps what lies inside, cut at the edges', () => {
	const { rings, line } = shape(400);
	const pieces = cutLine(line, rings);
	expect(pieces).toHaveLength(2);
	for (const { line: piece, along } of pieces) {
		expect(piece).toHaveLength(along.length);
		for (let i = 1; i < piece.length; i++) {
			const mid: Pt = {
				x: (piece[i - 1].x + piece[i].x) / 2,
				y: (piece[i - 1].y + piece[i].y) / 2
			};
			expect(within(rings, mid)).toBe(true);
		}
	}
	// From the ring's wavy edge to the hole's and on from the hole's to the
	// ring's: each end where its edge is.
	const xs = pieces.map(({ line: p }) => [p[0].x, p[p.length - 1].x].map((x) => Math.round(x)));
	expect(xs).toEqual([
		[-52, -10],
		[10, 49]
	]);
});

test('cutting a line costs about as much more as the line and ring are finer', () => {
	// The quickest of a few runs, a few milliseconds at most.
	const time = (n: number) => {
		const { rings, line } = shape(n);
		cutLine(line, rings);
		let best = Infinity;
		for (let k = 0; k < 5; k++) {
			const t0 = performance.now();
			cutLine(line, rings);
			best = Math.min(best, performance.now() - t0);
		}
		return best;
	};
	// Eight times the points: eight times the time, give or take; sixty-four
	// were every segment tested against every edge.
	expect(time(2000) / time(250)).toBeLessThan(25);
});
