// How paint is stroked: the line's width and dash rhythm, and the sizes of
// stop and yield lines. Roads and nodes keep their markings clear by these;
// rendering/road-meshes.ts strokes a description's markings with `paintLine`.

import { mix, quad } from './geometry';
import type { Pt } from './model';

export const LINE = 0.15;
const DASH = 3;
const PERIOD = 9;

// A piece of line shorter than this is a crumb and is not painted; crossings
// that leave less than this of the road between them leave no line there.
export const MIN_PIECE = 1;

// Quads along a polyline, dashed by distances along `along`.
export function paintLine(
	pts: Pt[],
	along: number[],
	dashed: boolean,
	out: Pt[][],
	rhythm: [number, number] = [along[0], along[along.length - 1]]
) {
	// Whole dashes, the period stretched to fit the line exactly with half a
	// gap at each end: pieces of one line meeting end to end (a road, its
	// taper, the next road) then keep one even rhythm, never a stub against
	// a full dash nor a double gap. A piece cut from a longer line is dashed
	// as that line was (`rhythm`); a dash its cut leaves shorter than
	// MIN_PIECE is left out.
	const [a0, a1] = rhythm;
	const [lo, hi] = [along[0], along[along.length - 1]];
	const dashes: [number, number][] = [];
	const count = Math.round((a1 - a0) / PERIOD) || (a1 - a0 >= DASH + 1 ? 1 : 0);
	if (dashed && count > 0) {
		const period = (a1 - a0) / count;
		for (let k = 0; k < count; k++) {
			const mid = a0 + (k + 0.5) * period;
			const [d0, d1] = [Math.max(lo, mid - DASH / 2), Math.min(hi, mid + DASH / 2)];
			if (d1 - d0 >= MIN_PIECE - 1e-6) dashes.push([d0, d1]);
		}
	}
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
		const s0 = along[i - 1];
		const s1 = along[i];
		const pieces: [number, number][] = [];
		if (!dashed) pieces.push([0, 1]);
		else {
			for (const [d0, d1] of dashes) {
				const p0 = Math.max(s0, d0);
				const p1 = Math.min(s1, d1);
				if (p1 > p0 + 1e-3) pieces.push([(p0 - s0) / (s1 - s0), (p1 - s0) / (s1 - s0)]);
			}
		}
		for (const [f0, f1] of pieces) out.push(quad(mix(a, b, f0), mix(a, b, f1), LINE / 2));
	}
}

// Stop line and yield line sizes, MUTCD 11th Edition Section 3B.19: a stop
// line 12 to 24 in wide; yield teeth 12 to 24 in across the base, 1.5 times
// that high, 3 to 12 in apart. Each takes the top of its range (600 mm in
// the metric edition).
export const STOP_LINE = 0.6;
export const YIELD_BASE = 0.6;
export const YIELD_HEIGHT = 0.9;
export const YIELD_GAP = 0.3;
