// A road's own surface: one ribbon per lane between the lane edges along the
// line, and the paint along it, as a description (description.ts).
// Everything comes from the lanes' kinds, directions and surfaces.

import {
	area as areaOf,
	fromPath,
	intersect,
	offset,
	open,
	subtract,
	toPath,
	toRings,
	union,
	type Paths
} from './clip';
import type {
	Crossing,
	EndCut,
	Line,
	Marking,
	Material,
	RoadDescription,
	Role,
	Surface as Ground
} from './description';
import {
	bars,
	crossSection,
	frameAt,
	mix,
	offsetPoint,
	quad,
	ribbonOf,
	sampleDistances,
	type LaneSpan,
	type PathSample
} from './geometry';
import { CROSSING_DEPTH, crosswalkOf } from './approach';
import type { Share } from './holds';
import { clearOf, type Crossed, crossingsOver } from './overlay';
import { INSET, laneLines } from './lines';
import {
	isRaised,
	isRoadway,
	isTravel,
	isWalk,
	type Lane,
	type Pt,
	type Road,
	type Surface
} from './model';
import { LINE, MIN_PIECE } from './paint';

// A painted line's centreline at a node (lines.ts, carry.ts).
export interface Mark {
	colour: 'white' | 'yellow';
	dashed: boolean;
	pts: Pt[];
}

export interface Row {
	d: number;
	p: Pt;
	n: Pt;
	t: Pt;
	spans: LaneSpan[];
}

export function roadRows(road: Road, path: PathSample, from = 0, to = path.length): Row[] {
	const distances = sampleDistances(path.length).filter((d) => d >= from && d <= to);
	if (distances[0] !== from) distances.unshift(from);
	if (distances[distances.length - 1] !== to) distances.push(to);
	return distances.map((d) => {
		const f = frameAt(path, d);
		return { d, p: f.p, n: f.n, t: f.t, spans: crossSection(road, d) };
	});
}

// Each lane's strip as a polygon, by lane id; a lane too narrow to see is
// left out.
export function laneStrips(rows: Row[], keep: (lane: Lane) => boolean) {
	const out = new Map<string, Pt[]>();
	if (rows.length < 2) return out;
	rows[0].spans.forEach((span, k) => {
		if (!keep(span.lane) || span.right - span.left < 0.02) return;
		const left = rows.map((r) => offsetPoint(r.p, r.n, r.spans[k].left));
		const right = rows.map((r) => offsetPoint(r.p, r.n, r.spans[k].right));
		out.set(span.lane.id, [...left, ...right.reverse()]);
	});
	return out;
}

// How far along a polyline each of its points is.
export function alongOf(pts: Pt[]) {
	let s = 0;
	return pts.map((p, i) => (s += i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0));
}

const MIN_PAINTED = 4;

// A road's painted line while it is laid: `ends` are where in the
// cross-section its first and last points sit (offsets at the road's start;
// the whole cross-section moves by `lean` per metre).
interface Draft {
	colour: 'white' | 'yellow';
	dashed: boolean;
	pts: Pt[];
	along: number[];
	ends: [number, number];
	rhythm?: [number, number];
}

const follows = (m: Draft, k: number, o: number) => Math.abs(m.ends[k === 0 ? 0 : 1] - o) < 0.1;

// Where a median stops short in its rounded nose, the solid lines along
// either side of it join round the nose at the same inset, one line. They
// are cut where the median's sides still run straight (`at`, metres along
// the road) and joined by the median's outline grown by the inset beyond
// there. Lines that don't both reach that far along both sides are left be.
function wrapNose(
	path: PathSample,
	lines: Draft[],
	median: LaneSpan,
	lean: number,
	nose: Paths,
	end: 'start' | 'end',
	at: number
) {
	if (at <= 0 || at >= path.length || median.right - median.left < 0.2) return;
	const f = frameAt(path, at);
	// Toward the road's end from `at`.
	const ahead = end === 'end' ? 1 : -1;
	const beyond = (d: number) => (d - at) * ahead > 0;
	// The lines along the median's sides, by their place in the cross-section.
	const sides = [median.left - INSET, median.right + INSET];
	// A median's nose comes forward past a stop line, past where paint
	// stops: a line along either side that ends short of `at` runs on
	// straight beside the median to just past it.
	for (const o of sides) {
		for (const m of lines) {
			if (m.dashed) continue;
			const k = [m.pts.length - 1, 0].find(
				(i) => !beyond(m.along[i]) && (at - m.along[i]) * ahead <= 3 && follows(m, i, o)
			);
			if (k === undefined) continue;
			const s = m.along[k];
			const steps = Math.ceil(Math.abs(at - s) / 0.5) + 1;
			const more = Array.from({ length: steps }, (_, i) =>
				i === steps - 1 ? at + 0.05 * ahead : s + ((at - s) * (i + 1)) / (steps - 1)
			);
			const pts = more.map((d) => {
				const h = frameAt(path, d);
				return offsetPoint(h.p, h.n, o + lean * at);
			});
			if (k === 0) {
				m.pts = [...pts.reverse(), ...m.pts];
				m.along = [...more.reverse(), ...m.along];
			} else {
				m.pts = [...m.pts, ...pts];
				m.along = [...m.along, ...more];
			}
		}
	}
	// Each line end on the nose's side of `at`, and where its line crosses
	// `at`.
	const ends: { m: Draft; k: number; cut: number; p: Pt }[] = [];
	for (const m of lines) {
		if (m.dashed) continue;
		for (const k of [0, m.pts.length - 1]) {
			if (!beyond(m.along[k])) continue;
			const step = k === 0 ? 1 : -1;
			let i = k;
			while (i + step >= 0 && i + step < m.pts.length && beyond(m.along[i + step])) i += step;
			const j = i + step;
			if (j < 0 || j >= m.pts.length) continue;
			const p = mix(m.pts[i], m.pts[j], (at - m.along[i]) / (m.along[j] - m.along[i]));
			ends.push({ m, k, cut: i, p });
		}
	}
	const lo = ends.find((e) => follows(e.m, e.k, sides[0]));
	const hi = ends.find((e) => follows(e.m, e.k, sides[1]));
	if (!lo || !hi || lo.m.colour !== hi.m.colour || (lo.m === hi.m && lo.k === hi.k)) return;
	// The grown outline beyond `at`, in the few metres of the nose.
	const along = (q: Pt) => (q.x - f.p.x) * f.t.x + (q.y - f.p.y) * f.t.y;
	const across = (q: Pt) => (q.x - f.p.x) * f.n.x + (q.y - f.p.y) * f.n.y;
	const [left, right] = [sides[0] + lean * at, sides[1] + lean * at];
	let arc: Pt[] = [];
	for (const ring of offset(nose, INSET)) {
		const pts = fromPath(ring);
		const keep = pts.map((q) => {
			const a = along(q) * ahead;
			const o = across(q);
			return a > 0 && a < 5 && o > left - 0.5 && o < right + 0.5;
		});
		const first = keep.findIndex((x, i) => x && !keep[(i - 1 + pts.length) % pts.length]);
		if (first < 0) continue;
		const run: Pt[] = [];
		for (let i = first; keep[i % pts.length] && run.length < pts.length; i++)
			run.push(pts[i % pts.length]);
		if (run.length < 2 || keep.filter(Boolean).length !== run.length) continue;
		arc = run;
	}
	if (arc.length < 2) return;
	const d = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
	if (d(arc[0], lo.p) > d(arc[0], hi.p)) arc.reverse();
	const alongArc = arc.map((q) => at + along(q));
	// Each line up to where it's cut, running toward the nose.
	const lead = (e: (typeof ends)[number]) => {
		const pts = e.k === 0 ? e.m.pts.slice(e.cut + 1).reverse() : e.m.pts.slice(0, e.cut);
		const s = e.k === 0 ? e.m.along.slice(e.cut + 1).reverse() : e.m.along.slice(0, e.cut);
		return { pts: [...pts, e.p], s: [...s, at] };
	};
	if (lo.m === hi.m) {
		// Both sides are already one line, joined round the other end: it
		// closes into a loop.
		const m = lo.m;
		const [first, last] = lo.k === 0 ? [lo, hi] : [hi, lo];
		const round = last === lo ? arc : [...arc].reverse();
		const s = last === lo ? alongArc : [...alongArc].reverse();
		m.pts = [first.p, ...m.pts.slice(first.cut + 1, last.cut), last.p, ...round, first.p];
		m.along = [at, ...m.along.slice(first.cut + 1, last.cut), at, ...s, at];
		return;
	}
	const a = lead(lo);
	const b = lead(hi);
	// Each line's far end, which the joined line now ends at.
	const far = (e: (typeof ends)[number]) => e.m.ends[e.k === 0 ? 1 : 0];
	lo.m.ends = [far(lo), far(hi)];
	lines.splice(lines.indexOf(hi.m), 1);
	lo.m.pts = [...a.pts, ...arc, ...[...b.pts].reverse()];
	lo.m.along = [...a.s, ...alongArc, ...[...b.s].reverse()];
}

// The pieces of a line clear of the given stretches of road (distances along
// it: crossings), cut where its own distance meets them. Each cut is held back
// by how far the stroke's square end reaches along the road there (half the
// stroke, turned by the angle between line and road), so no corner of the
// stroke enters. A dashed piece keeps the whole line's dashes (paintLine). A
// piece left shorter than MIN_PIECE (less the stroke held back at both its
// cuts) is dropped.
function cutAlong(path: PathSample, m: Draft, gaps: [number, number][]): Draft[] {
	const [lo, hi] = [Math.min(...m.along), Math.max(...m.along)];
	if (!gaps.some(([g0, g1]) => g1 + LINE > lo && g0 - LINE < hi)) return [m];
	const out: Draft[] = [];
	const rhythm: [number, number] = [m.along[0], m.along[m.along.length - 1]];
	let piece: Draft | null = null;
	for (let i = 1; i < m.pts.length; i++) {
		const [a, b] = [m.pts[i - 1], m.pts[i]];
		const [sa, sb] = [m.along[i - 1], m.along[i]];
		const n = frameAt(path, (sa + sb) / 2).n;
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const c = ((LINE / 2) * Math.abs((b.x - a.x) * n.x + (b.y - a.y) * n.y)) / l;
		const held = gaps.map(([g0, g1]) => [g0 - c, g1 + c]);
		const breaks = [
			0,
			1,
			...held.flat().flatMap((s) => ((s - sa) * (s - sb) < 0 ? [(s - sa) / (sb - sa)] : []))
		];
		breaks.sort((x, y) => x - y);
		for (let j = 1; j < breaks.length; j++) {
			const [f0, f1] = [breaks[j - 1], breaks[j]];
			const mid = sa + ((sb - sa) * (f0 + f1)) / 2;
			if (held.some(([g0, g1]) => mid > g0 && mid < g1)) {
				if (piece) out.push(piece);
				piece = null;
			} else if (f1 > f0) {
				piece ??= { ...m, pts: [mix(a, b, f0)], along: [sa + (sb - sa) * f0], rhythm };
				piece.pts.push(mix(a, b, f1));
				piece.along.push(sa + (sb - sa) * f1);
			}
		}
	}
	if (piece) out.push(piece);
	return out.filter((p) => alongOf(p.pts)[p.pts.length - 1] >= MIN_PIECE - LINE);
}

// Stretches of road taken together where they overlap or leave less than
// MIN_PIECE between them.
function merged(spans: [number, number][]) {
	const out: [number, number][] = [];
	for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
		const last = out[out.length - 1];
		if (last && from - last[1] < MIN_PIECE) last[1] = Math.max(last[1], to);
		else out.push([from, to]);
	}
	return out;
}

export const materialOf = (s: Surface): Material =>
	s === 'pavement' ? 'concrete' : s === 'hatch' ? 'asphalt' : s;

type Span = { lane: Lane; left: number; right: number };

// What lane k of a cross-section is: a raised lane with roadway on both
// sides of it is a median.
export function roleOf(lanes: Span[], k: number): Role {
	const lane = lanes[k].lane;
	const carries = (list: Span[]) => list.some((s) => isRoadway(s.lane) && s.right - s.left > 0.05);
	if (isRaised(lane) && carries(lanes.slice(0, k)) && carries(lanes.slice(k + 1))) return 'median';
	return isRoadway(lane) ? 'lane' : isWalk(lane) ? 'walk' : 'verge';
}

// The colour of lane k's hatch bars: yellow where the nearest car lanes
// either side of it run opposite ways.
export function barColour(lanes: Span[], k: number): 'white' | 'yellow' {
	const travel = (list: Span[]) => list.find((s) => isTravel(s.lane) && s.right - s.left > 0.02);
	const l = travel(lanes.slice(0, k).reverse());
	const r = travel(lanes.slice(k + 1));
	return l && r && l.lane.dir !== r.lane.dir ? 'yellow' : 'white';
}

// One hatch bar of a lane `left` to `right` across the road at its start
// (the cross-section moving by `lean` per metre): from 0.5 m outside its
// left edge `d` along the road to 0.5 m outside its right edge 0.8 of its
// width further on, 0.5 m wide. Before the road's start it runs on straight.
export function hatchBar(path: PathSample, d: number, left: number, right: number, lean: number) {
	const at = Math.max(0, d);
	const here = frameAt(path, at);
	const ahead = frameAt(path, d + (right - left) * 0.8);
	const p0 = offsetPoint(here.p, here.t, d - at);
	const a = offsetPoint(p0, here.n, left + lean * at - 0.5);
	const b = offsetPoint(ahead.p, ahead.n, right + lean * at + 0.5);
	return toPath(quad(a, b, 0.25));
}

// `over` is the ground a network laid over the road crosses on it
// (overlay.ts): its crossings; `share`, the lines the traffic meeting them
// is held at that fall on the road and the ground its paint stops at for
// them (holds.ts), which the road draws and clears, deciding nothing.
export function describeRoad(
	road: Road,
	path: PathSample,
	cut: { start: EndCut; end: EndCut },
	over: Crossed[] = [],
	share: Share = { signs: [], cleared: [] }
): RoadDescription {
	const length = path.length;
	const rows = roadRows(road, path);
	const lanes = crossSection(road, 0);
	const lean = road.lean ?? 0;
	// Lane k lies between edges k and k + 1.
	const offsets = rows.map((r) => [
		...r.spans.map((s) => s.left),
		...r.spans.slice(-1).map((s) => s.right)
	]);
	const edges: Line[] = offsets[0].map((_, k) =>
		rows.map((r, i) => offsetPoint(r.p, r.n, offsets[i][k]))
	);
	const along = rows.map((r) => r.d);
	// The road between edges k0 and k1, from one distance along it to another.
	const band = (k0: number, k1: number, from = 0, to = length): Paths => {
		[from, to] = [Math.max(0, from), Math.min(length, to)];
		if (to - from < 1e-6) return [];
		// A line's points between the two, its ends where it reaches them.
		const slice = (line: Pt[]) => {
			const at = (d: number) => {
				const k = Math.max(0, along.findIndex((s) => s >= d) - 1);
				const j = Math.min(along.length - 1, k + 1);
				const f = along[j] > along[k] ? (d - along[k]) / (along[j] - along[k]) : 0;
				return mix(line[k], line[j], Math.min(1, Math.max(0, f)));
			};
			const inner = line.filter((_, i) => along[i] > from + 1e-6 && along[i] < to - 1e-6);
			return [at(from), ...inner, at(to)];
		};
		return [toPath([...slice(edges[k0]), ...slice(edges[k1]).reverse()])];
	};
	const strip = (k: number) => band(k, k + 1);

	const surfaces: Ground[] = [];
	const faults: Pt[] = [];
	const hatched = new Map<number, Ground>();
	// What a crossing reads: all roadway, the medians, and the other lanes in
	// any other material than asphalt (a verge it is paved through; never a
	// car lane, whatever it is made of).
	const roadway: Paths = [];
	const carLanes: Paths[] = [];
	const medians: Paths = [];
	const verges: Paths = [];
	const others = new Map<number, Paths>();
	const noses: { span: LaneSpan; r: number; from: number; to: number; shape: Paths }[] = [];
	lanes.forEach((span, k) => {
		const lane = span.lane;
		if (span.right - span.left < 0.02) return;
		const material = materialOf(lane.surface);
		// A median stops short of a junction end in a rounded nose, and the
		// road is paved up to the end.
		const role = roleOf(lanes, k);
		const median = role === 'median';
		const ref = { road: road.id, lane: lane.id };
		if (!median || !(cut.start.nose || cut.end.nose)) {
			const surface: Ground = {
				role,
				material,
				shape: ribbonOf(edges[k], edges[k + 1], faults),
				lane: ref
			};
			surfaces.push(surface);
			if (lane.surface === 'hatch') hatched.set(k, surface);
			if (isRoadway(lane)) roadway.push(...strip(k));
			if (lane.kind === 'drive') carLanes.push(strip(k));
			if (median) medians.push(...strip(k));
			else if (!isRoadway(lane) && lane.surface !== 'asphalt') others.set(k, strip(k));
			if (role === 'verge') verges.push(...strip(k));
			return;
		}
		const paths = strip(k);
		const from = cut.start.nose ?? 0;
		const to = length - (cut.end.nose ?? 0);
		const kept = to - from > 0.5 ? band(k, k + 1, from, to) : [];
		const r = Math.min(1.2, Math.max(lane.width, 0.2) * 0.45);
		// Rounded where it stops short; square at a free end or where it meets
		// the outline.
		const square: Paths = [];
		if (!cut.start.nose) square.push(...band(k, k + 1, 0, 2 * r + 0.5));
		if (!cut.end.nose) square.push(...band(k, k + 1, length - 2 * r - 0.5));
		const shaped = union([...open(kept, r), ...intersect(kept, square)]);
		const freed = subtract(paths, shaped);
		surfaces.push(
			{ role: 'median', material, shape: toRings(shaped, faults), lane: ref },
			{ role: 'lane', material: 'asphalt', shape: toRings(freed, faults), lane: ref }
		);
		medians.push(...shaped);
		roadway.push(...freed);
		if (kept.length) noses.push({ span, r, from, to, shape: shaped });
	});

	// Crosswalks: straight across between their two sidewalks, zebra over the
	// roadway, a refuge where they cross a median, paving through any other
	// lane not of asphalt that is no roadway. Where two overlap, the ground they share is drawn
	// once, as the earlier one's.
	const crossings: Crossing[] = [];
	const depths: [number, number][] = [];
	const laid: { at: number; body: Paths }[] = [];
	const half = CROSSING_DEPTH / 2;
	for (const c of road.crossings ?? []) {
		const at = crosswalkOf(road, length, c);
		if (!at) continue;
		const { d, sides, k0, k1 } = at;
		const [p, q] = [k0 - 1, k1];
		const spans = crossSection(road, d);
		const f = frameAt(path, d);
		const body = band(k0, k1, d - half, d + half);
		const under = laid.filter((l) => Math.abs(l.at - d) < 2 * half).flatMap((l) => l.body);
		const fresh = subtract(body, under);
		laid.push({ at: d, body });
		// Not the sidewalks it joins: they only touch it.
		const between = [...others].flatMap(([k, s]) => (k > p && k < q ? s : []));
		const centre = [offsetPoint(f.p, f.n, spans[p].right), offsetPoint(f.p, f.n, spans[q].left)];
		depths.push([d - half, d + half]);
		crossings.push({
			id: `${road.id}#${crossings.length}`,
			line: sides.map((k) => offsetPoint(f.p, f.n, (spans[k].left + spans[k].right) / 2)),
			runs: (
				[
					{ kind: 'paved', rings: toRings(intersect(fresh, between), faults) },
					{ kind: 'refuge', rings: toRings(intersect(fresh, medians), faults) },
					{
						kind: 'zebra',
						rings: toRings(
							intersect(bars(centre, CROSSING_DEPTH), intersect(fresh, roadway)),
							faults
						)
					}
				] as const
			).filter((run) => run.rings.length > 0),
			body: toRings(body, faults)
		});
	}
	// Crossings a network laid over the road makes on it (crossingsOver),
	// their stripes along the road.
	const overlaid = crossingsOver(
		road.id,
		over,
		{ hard: roadway, lanes: carLanes, median: medians, verge: verges },
		crossings,
		faults
	);
	crossings.push(...overlaid);
	// Its paint stops at each crossing, and at the ground cleared for the
	// lines held traffic meets them at (Share.cleared): lane and edge lines
	// and hatching alike.
	const clears = [
		...share.cleared,
		...[...(cut.start.clear ?? []), ...(cut.end.clear ?? [])].map(toPath)
	];
	const cleared = clears.length ? union(clears) : [];
	const bodies = union([...crossings.flatMap((c) => c.body.map(toPath)), ...cleared]);
	const gaps = merged(depths);

	// Paint, between the cuts at either end. A road with only a few metres
	// left between them gets no lines: they would be crumbs. Each line keeps
	// its place in the cross-section the whole way.
	const from = cut.start.paint;
	const to = length - cut.end.paint;
	const painted = to - from < MIN_PAINTED ? [] : roadRows(road, path, from, to);
	const lines: Draft[] = painted.length
		? laneLines(painted[0].spans).map((m) => {
				const o = m.o - lean * painted[0].d;
				return {
					colour: m.colour,
					dashed: m.dashed,
					pts: painted.map((row) => offsetPoint(row.p, row.n, o + lean * row.d)),
					along: painted.map((row) => row.d),
					ends: [o, o]
				};
			})
		: [];
	for (const nose of noses) {
		if (cut.start.nose)
			wrapNose(path, lines, nose.span, lean, nose.shape, 'start', nose.from + nose.r + 0.25);
		if (cut.end.nose)
			wrapNose(path, lines, nose.span, lean, nose.shape, 'end', nose.to - nose.r - 0.25);
	}

	// Hatched buffers: diagonal bars every 4 m, clipped to the buffer and the
	// painted length, yellow where the buffer separates opposing traffic.
	for (const [k, surface] of hatched) {
		const area = band(k, k + 1, from, to);
		const { left, right } = lanes[k];
		if (!area.length || right - left < 1) continue;
		// Bars every 4 m in world terms along the road's heading, so pieces of
		// one road either side of a junction keep the same rhythm.
		const t0 = frameAt(path, 0).t;
		const phase = (((path.pts[0].x * t0.x + path.pts[0].y * t0.y) % 4) + 4) % 4;
		const kept: Paths = [];
		for (let d = ((4 - phase) % 4) - 4; d < length; d += 4) {
			const bar = hatchBar(path, d, left, right, lean);
			// A bar cut down to a stub where the paint stops is left out: it
			// reads as a stray tick.
			const pieces = intersect([bar], area);
			const sum = pieces.reduce((s, q) => s + Math.abs(areaOf(q)), 0);
			if (sum >= 0.3 && sum >= 0.4 * Math.abs(areaOf(bar))) kept.push(...pieces);
		}
		const rings = toRings(subtract(kept, bodies), faults);
		if (rings.length) surface.bars = { colour: barColour(lanes, k), rings };
	}

	return {
		path,
		lanes,
		edges,
		along,
		surfaces,
		// Lines stop at crossings.
		markings: clearOf(
			lines
				.flatMap((m) => cutAlong(path, m, gaps))
				.map(
					(m): Marking => ({
						colour: m.colour,
						dashed: m.dashed,
						line: m.pts,
						along: m.along,
						...(m.rhythm && { rhythm: m.rhythm })
					})
				),
			[...overlaid.flatMap((c) => c.body), ...cleared.map(fromPath)]
		),
		signs: share.signs,
		crossings,
		cleared: toRings(cleared, faults),
		cut,
		faults
	};
}
