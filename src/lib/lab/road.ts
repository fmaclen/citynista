// A road's own surface: one strip per lane from its cross-section along the
// line, and the paint along it. Everything comes from the lanes' kinds,
// directions and surfaces.

import {
	area as areaOf,
	fromPath,
	intersect,
	open,
	subtract,
	toPath,
	union,
	type Paths
} from './clip';
import {
	crossSection,
	frameAt,
	offsetPoint,
	cutOf,
	isCut,
	sampleDistances,
	samplePath,
	type LaneSpan,
	type PathSample
} from './geometry';
import type { Lane, Pt, Road, Surface } from './model';
import { bars, CROSSING_DEPTH } from './junction';

export type Fill = Surface | 'trail';

// A painted line's centreline, kept for checks.
export interface Mark {
	colour: 'white' | 'yellow';
	dashed: boolean;
	pts: Pt[];
	// On a road: how far along the road each point is.
	along?: number[];
}

// A crosswalk across a road: zebra over the roadway, a refuge island where it
// crosses a median, pavement through any verge; `hit` is its whole body.
export interface RoadCrossingDraw {
	zebra: Paths;
	refuge: Paths;
	paving: Paths;
	hit: Paths;
}

export interface RoadDraw {
	path: PathSample;
	crossings: RoadCrossingDraw[];
	fills: Map<Fill, Paths>;
	// All roadway: drive, bus and hatched lanes, and the asphalt left where a
	// median stops short of the end.
	roadway: Paths;
	white: Pt[][];
	yellow: Pt[][];
	marks: Mark[];
	// Where paint stops and medians end, as built.
	cut: { start: EndCut; end: EndCut };
}

// Per end: where paint stops (metres back from the end), and where a median
// stops in its nose (null at a free end, 0 where it meets the outline).
export interface EndCut {
	paint: number;
	nose: number | null;
}

export const LINE = 0.15;
// Lines sit this far inside the travel lane they edge.
export const INSET = 0.2;
const DASH = 3;
const PERIOD = 9;
// A lane narrower than this is treated as not there yet for paint.
const LIVE = 0.5;

export const isTravel = (lane: Lane) =>
	(lane.kind === 'drive' || lane.kind === 'bus') && (lane.dir === 'fwd' || lane.dir === 'back');
export const isRoadway = (lane: Lane) =>
	lane.kind === 'drive' ||
	lane.kind === 'bus' ||
	lane.surface === 'hatch' ||
	(lane.kind === 'buffer' && lane.surface === 'asphalt');
export const isRaised = (lane: Lane) =>
	lane.kind === 'buffer' && (lane.surface === 'grass' || lane.surface === 'concrete');
export const isWalk = (lane: Lane) => lane.kind === 'walk' || lane.kind === 'trail';

export function fillOf(lane: Lane): Fill {
	if (lane.kind === 'trail') return 'trail';
	if (lane.surface === 'hatch') return 'asphalt';
	return lane.surface;
}

export interface Row {
	d: number;
	p: Pt;
	n: Pt;
	t: Pt;
	spans: LaneSpan[];
}

export function roadRows(
	road: Road,
	path: PathSample,
	from = 0,
	to = path.length,
	extra: number[] = []
): Row[] {
	const distances = [...new Set([...sampleDistances(road, path.length), ...extra])]
		.filter((d) => d >= from && d <= to)
		.sort((a, b) => a - b);
	if (distances[0] !== from) distances.unshift(from);
	if (distances[distances.length - 1] !== to) distances.push(to);
	return distances.map((d) => {
		const f = frameAt(path, d);
		const spans = crossSection(road, d).map((s) =>
			isCut(road, s.lane.id, d, path.length) ? { ...s, cut: true } : s
		);
		return { d, p: f.p, n: f.n, t: f.t, spans };
	});
}

// Each lane's strip as polygons, one per run where it has width.
export function laneStrips(rows: Row[], keep: (lane: Lane) => boolean) {
	const out = new Map<string, { lane: Lane; polys: Pt[][] }>();
	const ids = new Set<string>();
	for (const row of rows)
		for (const span of row.spans) if (keep(span.lane) && !span.cut) ids.add(span.lane.id);
	for (const id of ids) {
		const polys: Pt[][] = [];
		let left: Pt[] = [];
		let right: Pt[] = [];
		let lane: Lane | null = null;
		const flush = () => {
			if (left.length >= 2) polys.push([...left, ...right.reverse()]);
			left = [];
			right = [];
		};
		rows.forEach((row, i) => {
			const found = row.spans.find((s) => s.lane.id === id);
			const span = found?.cut ? undefined : found;
			if (!span || span.right - span.left < 0.02) {
				if (span && left.length) {
					left.push(offsetPoint(row.p, row.n, span.left));
					right.push(offsetPoint(row.p, row.n, span.right));
				}
				flush();
				return;
			}
			if (left.length === 0 && i > 0) {
				const prev = rows[i - 1].spans.find((s) => s.lane.id === id);
				if (prev) {
					left.push(offsetPoint(rows[i - 1].p, rows[i - 1].n, prev.left));
					right.push(offsetPoint(rows[i - 1].p, rows[i - 1].n, prev.right));
				}
			}
			lane = span.lane;
			left.push(offsetPoint(row.p, row.n, span.left));
			right.push(offsetPoint(row.p, row.n, span.right));
		});
		flush();
		if (lane) out.set(id, { lane, polys });
	}
	return out;
}

// The band of the road between two distances, across the given offsets.
function zone(rows: Row[], from: number, to: number, lo: number, hi: number): Paths {
	if (rows.length < 2 || to - from < 1e-6) return [];
	// The frame at distance d, between the rows either side of it.
	const at = (d: number) => {
		const k = Math.max(0, rows.findIndex((r) => r.d >= d) - 1);
		const a = rows[k];
		const b = rows[Math.min(rows.length - 1, k + 1)];
		const f = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
		const mix = (u: number, v: number) => u + (v - u) * f;
		return {
			d,
			p: { x: mix(a.p.x, b.p.x), y: mix(a.p.y, b.p.y) },
			n: { x: mix(a.n.x, b.n.x), y: mix(a.n.y, b.n.y) }
		};
	};
	const inner = rows.filter((r) => r.d > from + 1e-6 && r.d < to - 1e-6);
	const pick = [at(Math.max(from, rows[0].d)), ...inner, at(Math.min(to, rows[rows.length - 1].d))];
	if (pick.length < 2) return [];
	return [
		toPath([
			...pick.map((r) => offsetPoint(r.p, r.n, lo)),
			...[...pick].reverse().map((r) => offsetPoint(r.p, r.n, hi))
		])
	];
}

// Driver's left of a travel lane is the lower offset when it runs forward.
const leftSide = (lane: Lane) => (lane.dir === 'fwd' ? 'low' : 'high');

export interface RowMark {
	o: number;
	colour: 'white' | 'yellow';
	dashed: boolean;
	// Where the mark lies, when it isn't simply `o` across its row.
	p?: Pt;
	// What the mark follows (a path's edge, say): marks with one key at
	// consecutive rows are one line, however far apart across their rows.
	key?: string;
}

const edged = (lane: Lane) => isTravel(lane) || (lane.kind === 'drive' && lane.dir === 'both');

// The paint across one row. Lanes narrower than LIVE count as absent, so a
// lane opening or closing never breaks the lines either side of it, and an
// edge line is placed from the edge of whatever is beside it, so it follows
// that edge through any taper.
export function rowMarks(spans: LaneSpan[]): RowMark[] {
	// A lane past its own end leaves a gap: whatever borders it gets an edge.
	// Narrow travel lanes count as absent; anything else beside the roadway
	// keeps its edge however narrow, so an edge line slides smoothly onto
	// the median as a shoulder closes instead of jumping across.
	const live = spans
		.filter((s) => s.right - s.left >= LIVE || (!isTravel(s.lane) && s.right - s.left > 0.01))
		.map((s) =>
			s.cut ? { ...s, lane: { ...s.lane, kind: 'buffer' as const, dir: 'none' as const } } : s
		);
	const marks: RowMark[] = [];
	for (let i = 0; i < live.length; i++) {
		const s = live[i];
		const lane = s.lane;
		if (lane.kind === 'trail' || (lane.kind === 'drive' && lane.dir === 'both')) {
			marks.push({ o: (s.left + s.right) / 2, colour: 'yellow', dashed: true });
		}
		const next = live[i + 1];
		if (!next || !isTravel(lane) || !isTravel(next.lane)) continue;
		if (lane.dir !== next.lane.dir) {
			marks.push({ o: s.right - INSET, colour: 'yellow', dashed: false });
			marks.push({ o: s.right + INSET, colour: 'yellow', dashed: false });
		} else if (s.right - s.left >= 2 && next.right - next.left >= 2) {
			marks.push({ o: s.right, colour: 'white', dashed: true });
		}
	}
	const edgeColour = (lane: Lane, side: 'low' | 'high', index: number) => {
		if (!isTravel(lane)) return 'yellow' as const;
		if (leftSide(lane) !== side) return 'white' as const;
		const step = side === 'high' ? 1 : -1;
		for (let k = index + step; k >= 0 && k < live.length; k += step) {
			const other = live[k].lane;
			if (isTravel(other)) return other.dir === lane.dir ? ('white' as const) : ('yellow' as const);
			if (other.kind === 'walk') break;
		}
		return 'yellow' as const;
	};
	for (let i = 0; i < live.length; i++) {
		const lane = live[i].lane;
		if (!edged(lane)) continue;
		const before = live[i - 1];
		const after = live[i + 1];
		// An edge line just inside the roadway's edge, whatever is beyond it:
		// a curb, a verge, a median, or nothing (a ring's inner edge at its
		// apron).
		if (!before || !edged(before.lane)) {
			const o = before ? before.right : live[i].left;
			marks.push({ o: o + INSET, colour: edgeColour(lane, 'low', i), dashed: false });
		}
		if (!after || !edged(after.lane)) {
			const o = after ? after.left : live[i].right;
			marks.push({ o: o - INSET, colour: edgeColour(lane, 'high', i), dashed: false });
		}
	}
	// A hatched buffer is outlined on its own where nothing painted borders
	// it (beside a median, say), so its outline carries on as the lane beside
	// it closes. Yellow where it parts opposing traffic.
	const travelFrom = (k: number, step: number) => {
		for (; k >= 0 && k < live.length; k += step) {
			if (isTravel(live[k].lane)) return live[k].lane;
			if (live[k].lane.kind === 'walk') return null;
		}
		return null;
	};
	for (let i = 0; i < live.length; i++) {
		if (live[i].lane.surface !== 'hatch') continue;
		const a = travelFrom(i - 1, -1);
		const b = travelFrom(i + 1, 1);
		const colour = a && b && a.dir !== b.dir ? ('yellow' as const) : ('white' as const);
		const before = live[i - 1];
		const after = live[i + 1];
		const bare = (s?: LaneSpan) => !!s && !edged(s.lane) && s.lane.surface !== 'hatch';
		if (bare(before)) marks.push({ o: live[i].left + INSET, colour, dashed: false });
		if (bare(after)) marks.push({ o: live[i].right - INSET, colour, dashed: false });
	}
	return marks;
}

// Chain each station's marks into continuous polylines: a mark carries on to
// the mark with its key at the next station, or else to the nearest mark of
// the same kind there.
// Lines shorter than `least` are dropped (crumbs).
export function chainLines(stations: { d: number; marks: RowMark[] }[], least = 1) {
	type Line = { mark: RowMark; d: number[]; o: number[]; marks: RowMark[] };
	const done: Line[] = [];
	let live: Line[] = [];
	for (const row of stations) {
		const marks = row.marks;
		const next: Line[] = [];
		const used = new Set<number>();
		// Match in order across the row, kind by kind, so lines never swap
		// places (and so never cross).
		const kinds = new Set(marks.map((m) => `${m.colour}${m.dashed}`));
		for (const line of live) kinds.add(`${line.mark.colour}${line.mark.dashed}`);
		for (const kind of kinds) {
			const carry = (line: Line, m: RowMark, k: number) => {
				used.add(k);
				line.d.push(row.d);
				line.o.push(m.o);
				line.marks.push(m);
				next.push(line);
			};
			const all = marks
				.map((m, k) => ({ m, k }))
				.filter(({ m }) => `${m.colour}${m.dashed}` === kind);
			const lines = live
				.filter((l) => `${l.mark.colour}${l.mark.dashed}` === kind)
				.filter((l) => {
					const key = l.marks[l.marks.length - 1].key;
					const same = key === undefined ? undefined : all.find((c) => c.m.key === key);
					if (!same || used.has(same.k)) return true;
					carry(l, same.m, same.k);
					return false;
				})
				.sort((p, q) => p.o[p.o.length - 1] - q.o[q.o.length - 1]);
			const cand = all.filter(({ k }) => !used.has(k)).sort((p, q) => p.m.o - q.m.o);
			let c = 0;
			for (const line of lines) {
				const last = line.o[line.o.length - 1];
				while (c < cand.length && cand[c].m.o < last - 0.75) c++;
				if (c < cand.length && Math.abs(cand[c].m.o - last) < 0.75) {
					carry(line, cand[c].m, cand[c].k);
					c++;
				} else done.push(line);
			}
		}
		marks.forEach((m, k) => {
			if (!used.has(k)) next.push({ mark: m, d: [row.d], o: [m.o], marks: [m] });
		});
		live = next;
	}
	done.push(...live);
	return done.filter((l) => l.d.length >= 2 && l.d[l.d.length - 1] - l.d[0] >= least);
}

// Quads along a polyline, dashed by a pattern measured along `along`.
export function paintLine(
	pts: Pt[],
	along: number[],
	dashed: boolean,
	out: Pt[][],
	pattern: { dash: number; period: number } = { dash: DASH, period: PERIOD }
) {
	const DASH = pattern.dash;
	const PERIOD = pattern.period;
	// Whole dashes, the period stretched to fit the line exactly with half a
	// gap at each end: pieces of one line meeting end to end (a road, its
	// taper, the next road) then keep one even rhythm, never a stub against
	// a full dash nor a double gap.
	const a0 = along[0];
	const a1 = along[along.length - 1];
	const dashes: [number, number][] = [];
	const count = Math.round((a1 - a0) / PERIOD) || (a1 - a0 >= DASH + 1 ? 1 : 0);
	if (dashed && count > 0) {
		const period = (a1 - a0) / count;
		for (let k = 0; k < count; k++) {
			const mid = a0 + (k + 0.5) * period;
			dashes.push([mid - DASH / 2, mid + DASH / 2]);
		}
	}
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const l = Math.hypot(b.x - a.x, b.y - a.y);
		if (l < 1e-6) continue;
		const n = { x: (-(b.y - a.y) / l) * (LINE / 2), y: ((b.x - a.x) / l) * (LINE / 2) };
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
		for (const [f0, f1] of pieces) {
			const p = { x: a.x + (b.x - a.x) * f0, y: a.y + (b.y - a.y) * f0 };
			const q = { x: a.x + (b.x - a.x) * f1, y: a.y + (b.y - a.y) * f1 };
			out.push([
				{ x: p.x + n.x, y: p.y + n.y },
				{ x: q.x + n.x, y: q.y + n.y },
				{ x: q.x - n.x, y: q.y - n.y },
				{ x: p.x - n.x, y: p.y - n.y }
			]);
		}
	}
}

const MIN_PAINTED = 4;

// Whether a lane that stops short of the road's end is past where its paint
// stops.
function paintCut(
	road: Road,
	id: string,
	d: number,
	length: number,
	cut: { start: EndCut; end: EndCut }
) {
	const start = cutOf(road, id, 'start');
	const end = cutOf(road, id, 'end');
	return (
		(start > 0 && d < start + cut.start.paint) || (end > 0 && d > length - end - cut.end.paint)
	);
}

export function buildRoad(road: Road, cut: { start: EndCut; end: EndCut }): RoadDraw {
	const path = samplePath(road);
	const length = path.length;
	const rows = roadRows(road, path);
	const fills = new Map<Fill, Paths>();
	const add = (fill: Fill, paths: Paths) => fills.set(fill, [...(fills.get(fill) ?? []), ...paths]);
	const strips = laneStrips(rows, () => true);
	const lo = Math.min(...rows.map((r) => r.spans[0]?.left ?? 0)) - 1;
	const hi = Math.max(...rows.map((r) => r.spans[r.spans.length - 1]?.right ?? 0)) + 1;
	const roadway: Paths = [];
	const medians: Paths = [];
	for (const { lane, polys } of strips.values()) {
		const paths = union(polys.map(toPath));
		if (!isRaised(lane)) {
			add(fillOf(lane), paths);
			if (isRoadway(lane)) roadway.push(...paths);
			continue;
		}
		// A raised lane between roadway lanes is a median: at a junction end it
		// stops short in a rounded nose and the road is paved up to the end.
		const median = rows.some((row) => {
			const i = row.spans.findIndex((s) => s.lane.id === lane.id);
			const has = (list: LaneSpan[]) =>
				list.some((s) => isRoadway(s.lane) && s.right - s.left > 0.05);
			return i > 0 && has(row.spans.slice(0, i)) && has(row.spans.slice(i + 1));
		});
		if (!median) {
			add(fillOf(lane), paths);
			continue;
		}
		const from = cut.start.nose ?? 0;
		const to = length - (cut.end.nose ?? 0);
		const kept = to - from > 0.5 ? intersect(paths, zone(rows, from, to, lo, hi)) : [];
		const r = Math.min(1.2, Math.max(lane.width, 0.2) * 0.45);
		// Rounded where it stops short; square at a free end or where it meets
		// the outline.
		const square: Paths = [];
		if (!cut.start.nose) square.push(...zone(rows, 0, Math.min(length, 2 * r + 0.5), lo, hi));
		if (!cut.end.nose)
			square.push(...zone(rows, Math.max(0, length - 2 * r - 0.5), length, lo, hi));
		const shaped = union([...open(kept, r), ...intersect(kept, square)]);
		add(fillOf(lane), shaped);
		medians.push(...shaped);
		const freed = subtract(paths, shaped);
		add('asphalt', freed);
		roadway.push(...freed);
	}
	for (const [fill, paths] of fills) fills.set(fill, union(paths));

	// Paint, between the cuts at either end. A road with only a few metres
	// left between them gets none: its lines would be crumbs.
	const painted =
		length - cut.start.paint - cut.end.paint < MIN_PAINTED
			? []
			: roadRows(road, path, cut.start.paint, length - cut.end.paint, [
					// Rows right where a short carriageway's paint stops.
					...Object.values(road.cuts?.start ?? {}).flatMap((c) => [
						c + cut.start.paint - 0.01,
						c + cut.start.paint
					]),
					...Object.values(road.cuts?.end ?? {}).flatMap((c) => [
						length - c - cut.end.paint,
						length - c - cut.end.paint + 0.01
					])
				]).map((row) => ({
					...row,
					// A carriageway that stops short keeps its paint back from its
					// own end by as much as the road's paint is kept back from the
					// road's end (behind its own stop line and crossing).
					spans: row.spans.map((sp) =>
						paintCut(road, sp.lane.id, row.d, length, cut) ? { ...sp, cut: true } : sp
					)
				}));
	const white: Pt[][] = [];
	const yellow: Pt[][] = [];
	const marks: Mark[] = [];
	for (const line of chainLines(painted.map((r) => ({ d: r.d, marks: rowMarks(r.spans) })))) {
		const pts = line.d.map((d, i) => {
			const row = painted.find((r) => r.d === d)!;
			return offsetPoint(row.p, row.n, line.o[i]);
		});
		paintLine(pts, line.d, line.mark.dashed, line.mark.colour === 'white' ? white : yellow);
		marks.push({ colour: line.mark.colour, dashed: line.mark.dashed, pts, along: line.d });
	}
	// Hatched buffers: diagonal bars every 4 m, clipped to the buffer and the
	// painted length, yellow where the buffer separates opposing traffic.
	const paintZone = zone(rows, cut.start.paint, length - cut.end.paint, lo, hi);
	for (const { lane, polys } of strips.values()) {
		if (lane.surface !== 'hatch') continue;
		const own = zone(
			rows,
			cut.start.paint + (cutOf(road, lane.id, 'start') > 0 ? cutOf(road, lane.id, 'start') : 0),
			length - cut.end.paint - (cutOf(road, lane.id, 'end') > 0 ? cutOf(road, lane.id, 'end') : 0),
			lo,
			hi
		);
		const area = intersect(intersect(union(polys.map(toPath)), paintZone), own);
		if (!area.length) continue;
		const bars: Paths = [];
		let opposing = false;
		for (const row of rows) {
			const live = row.spans.filter((s) => s.right - s.left > 0.02);
			const i = live.findIndex((s) => s.lane.id === lane.id);
			if (i < 0) continue;
			const l = live
				.slice(0, i)
				.reverse()
				.find((s) => isTravel(s.lane));
			const r = live.slice(i + 1).find((s) => isTravel(s.lane));
			if (l && r && l.lane.dir !== r.lane.dir) opposing = true;
		}
		// Bars every 4 m in world terms along the road's heading, so pieces of
		// one road either side of a junction keep the same rhythm.
		const t0 = frameAt(path, 0).t;
		const phase = (((path.pts[0].x * t0.x + path.pts[0].y * t0.y) % 4) + 4) % 4;
		for (let d = ((4 - phase) % 4) - 4; d < length; d += 4) {
			const at = Math.max(0, d);
			const span = crossSection(road, at).find((x) => x.lane.id === lane.id);
			if (!span) continue;
			const w = span.right - span.left;
			if (w < 1) continue;
			const here = frameAt(path, at);
			const p0 = offsetPoint(here.p, here.t, d - at);
			const ahead = frameAt(path, d + Math.max(w, 1) * 0.8);
			const a = offsetPoint(p0, here.n, span.left - 0.5);
			const b = offsetPoint(ahead.p, ahead.n, span.right + 0.5);
			const l2 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
			const n = { x: (-(b.y - a.y) / l2) * 0.25, y: ((b.x - a.x) / l2) * 0.25 };
			bars.push(
				toPath([
					{ x: a.x + n.x, y: a.y + n.y },
					{ x: b.x + n.x, y: b.y + n.y },
					{ x: b.x - n.x, y: b.y - n.y },
					{ x: a.x - n.x, y: a.y - n.y }
				])
			);
		}
		// A bar the buffer cuts down to a stub (where it tapers to a point)
		// is left out: it reads as a stray tick.
		for (const bar of bars) {
			const pieces = intersect([bar], area);
			const kept = pieces.reduce((sum, q) => sum + Math.abs(areaOf(q)), 0);
			if (kept < 0.3 || kept < 0.4 * Math.abs(areaOf(bar))) continue;
			for (const q of pieces) (opposing ? yellow : white).push(fromPath(q));
		}
	}
	// Crosswalks: straight across between their two sidewalks.
	const crossings: RoadCrossingDraw[] = [];
	for (const c of road.crossings ?? []) {
		const d = Math.max(0, Math.min(length, c.at));
		const spans = crossSection(road, d);
		const ends = c.lanes.map((id) => spans.find((sp) => sp.lane.id === id));
		if (!ends[0] || !ends[1]) continue;
		const [p, q] = ends[0].left < ends[1].left ? [ends[0], ends[1]] : [ends[1], ends[0]];
		const f = frameAt(path, d);
		const half = CROSSING_DEPTH / 2;
		const hit = zone(rows, d - half, d + half, p.right, q.left);
		const others = union(
			[...fills.entries()].filter(([fill]) => fill !== 'asphalt').flatMap(([, paths]) => paths)
		);
		const centre = [offsetPoint(f.p, f.n, p.right), offsetPoint(f.p, f.n, q.left)];
		crossings.push({
			zebra: intersect(bars(centre, CROSSING_DEPTH), intersect(hit, union(roadway))),
			refuge: intersect(hit, union(medians)),
			paving: subtract(intersect(hit, others), union(medians)),
			hit
		});
	}
	const crossed = union(crossings.flatMap((c) => c.hit));
	// Paint stays on the road's own surface, however tight a bend folds an
	// edge line, and off its crosswalks.
	const surface = subtract(union([...roadway, ...(fills.get('trail') ?? [])]), crossed);
	const keep = (polys: Pt[][]) =>
		intersect(union(polys.map(toPath)), surface)
			.map(fromPath)
			.filter((q) => q.length >= 3);
	return {
		path,
		crossings,
		fills,
		roadway: union(roadway),
		white: keep(white),
		yellow: keep(yellow),
		marks,
		cut
	};
}
