// Road geometry: the drawn line, and the cross-section at any distance along
// it from the road's stretches.

import type { Align, End, Lane, Pt, Road, Stretch } from './model';

export interface PathSample {
	pts: Pt[];
	// Cumulative distance at each point.
	s: number[];
	length: number;
}

const CURVE_STEP = 0.75;

function cubic(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
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
	// Past this lane's own end (a per-carriageway cut): it keeps its place
	// across the road but isn't there.
	cut?: boolean;
}

// How far short of each end of the road a lane stops.
export const cutOf = (road: Road, id: string, end: End) => road.cuts?.[end]?.[id] ?? 0;

export function isCut(road: Road, id: string, d: number, length: number) {
	return d < cutOf(road, id, 'start') - 1e-6 || d > length - cutOf(road, id, 'end') + 1e-6;
}

// Lane order across a stretch boundary: both lists' orders kept, lanes only in
// the previous stretch placed just before the next lane they preceded.
function mergeOrder(prev: Lane[], cur: Lane[]) {
	const curIds = new Set(cur.map((l) => l.id));
	const out: { prev?: Lane; cur?: Lane }[] = [];
	let p = 0;
	for (const lane of cur) {
		const at = prev.findIndex((l) => l.id === lane.id);
		if (at >= 0) {
			for (; p < at; p++) if (!curIds.has(prev[p].id)) out.push({ prev: prev[p] });
			p = Math.max(p, at + 1);
			out.push({ prev: prev[at], cur: lane });
		} else {
			// Lanes that end here come before lanes that begin in their place,
			// so a buffer opening up grows from the far side of the lanes it
			// replaces.
			const next = cur.slice(cur.indexOf(lane) + 1).find((l) => prev.some((q) => q.id === l.id));
			const until = next ? prev.findIndex((l) => l.id === next.id) : prev.length;
			for (; p < until; p++) if (!curIds.has(prev[p].id)) out.push({ prev: prev[p] });
			out.push({ cur: lane });
		}
	}
	for (; p < prev.length; p++) if (!curIds.has(prev[p].id)) out.push({ prev: prev[p] });
	return out;
}

const leftEdge = (align: Align, width: number) =>
	align === 'left' ? 0 : align === 'right' ? -width : -width / 2;

const ease = (f: number) => f * f * (3 - 2 * f);

export function stretchIndex(road: Road, distance: number) {
	let i = 0;
	while (i + 1 < road.stretches.length && road.stretches[i + 1].at <= distance) i++;
	return i;
}

export function crossSection(road: Road, distance: number): LaneSpan[] {
	return sectionAt(road, stretchIndex(road, distance), distance);
}

// The cross-section in stretch i at a distance. A stretch blends from
// whatever the road actually is where it begins, so a taper cut short by the
// next stretch carries on from where it got to instead of jumping.
function sectionAt(road: Road, i: number, distance: number): LaneSpan[] {
	const cur = road.stretches[i];
	const prev: Stretch | undefined = road.stretches[i - 1];
	const f =
		prev && cur.taper > 0 ? ease(Math.min(1, Math.max(0, (distance - cur.at) / cur.taper))) : 1;
	let rows: { lane: Lane; width: number }[];
	if (prev) {
		const before = sectionAt(road, i - 1, cur.at);
		const from = before.map((s) => s.lane);
		const width = new Map(before.map((s) => [s.lane.id, s.right - s.left]));
		rows = mergeOrder(from, cur.lanes).map(({ prev: a, cur: b }) => ({
			lane: (f < 0.5 ? (a ?? b) : (b ?? a))!,
			width: (a ? (width.get(a.id) ?? 0) : 0) * (1 - f) + (b?.width ?? 0) * f
		}));
		// Lanes that have already closed stay out of the order.
		rows = rows.filter((r) => r.width > 1e-9 || cur.lanes.some((l) => l.id === r.lane.id));
	} else rows = cur.lanes.map((lane) => ({ lane, width: lane.width }));
	const total = rows.reduce((sum, row) => sum + row.width, 0);
	const shift = (st: Stretch) => st.offset ?? 0;
	const anchor = prev
		? (leftEdge(prev.align, total) + shift(prev)) * (1 - f) +
			(leftEdge(cur.align, total) + shift(cur)) * f
		: leftEdge(cur.align, total) + shift(cur);
	const spans: LaneSpan[] = [];
	let x = anchor;
	for (const row of rows) {
		spans.push({ lane: row.lane, left: x, right: x + row.width });
		x += row.width;
	}
	return spans;
}

// Distances at which to sample a road: regular steps, plus extra points
// through every taper so blends stay smooth, and both sides of each stretch
// boundary so a sharp change stays sharp.
export function sampleDistances(road: Road, length: number) {
	const set = new Set<number>([0, length]);
	const step = 2;
	for (let d = step; d < length; d += step) set.add(d);
	for (const end of ['start', 'end'] as const) {
		for (const back of Object.values(road.cuts?.[end] ?? {})) {
			const d = end === 'start' ? back : length - back;
			if (d > 0 && d < length) {
				set.add(d);
				set.add(Math.max(0, Math.min(length, d + (end === 'start' ? -0.01 : 0.01))));
			}
		}
	}
	for (const stretch of road.stretches.slice(1)) {
		if (stretch.at <= 0 || stretch.at >= length) continue;
		set.add(Math.max(0, stretch.at - 0.01));
		set.add(stretch.at);
		const n = Math.max(1, Math.ceil(stretch.taper / 0.5));
		for (let k = 1; k <= n; k++) set.add(Math.min(length, stretch.at + (stretch.taper * k) / n));
	}
	return [...set].sort((a, b) => a - b);
}

// ---- Road ends.

export interface EndFrame {
	p: Pt;
	// Unit direction leaving the junction along the road.
	out: Pt;
	// Right normal of the drawing direction (lane offsets grow along it).
	n: Pt;
	distance: number;
	spans: LaneSpan[];
}

export function endFrame(road: Road, path: PathSample, end: End): EndFrame {
	const distance = end === 'start' ? 0 : path.length;
	const frame = frameAt(path, end === 'start' ? 0 : path.length);
	const out = end === 'start' ? frame.t : { x: -frame.t.x, y: -frame.t.y };
	return { p: frame.p, out, n: frame.n, distance, spans: crossSection(road, distance) };
}

export const offsetPoint = (p: Pt, n: Pt, d: number) => ({ x: p.x + n.x * d, y: p.y + n.y * d });

// A cubic from one lane end to another; `inDir` heads into the node, `outDir`
// leaves it.
export function curveBetween(p0: Pt, inDir: Pt, p3: Pt, outDir: Pt, samples: number) {
	const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
	// Handles of a circular arc turning through the angle between the two
	// directions, so a lane path through a bend follows the bend's curvature.
	const turn = Math.acos(Math.max(-1, Math.min(1, inDir.x * outDir.x + inDir.y * outDir.y)));
	const k =
		turn < 1e-3
			? chord / 3
			: (chord * (2 / 3) * Math.tan(turn / 4)) / Math.sin(Math.max(turn / 2, 0.2));
	const p1 = { x: p0.x + inDir.x * k, y: p0.y + inDir.y * k };
	const p2 = { x: p3.x - outDir.x * k, y: p3.y - outDir.y * k };
	const points: Pt[] = [];
	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const u = 1 - t;
		points.push({
			x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
		});
	}
	return points;
}
