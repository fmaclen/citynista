// Lane lines: what is painted between neighbours, across a road or across a
// node. A road passes its lanes (laneLines); a node passes the car paths
// crossing it, station by station, and chains each station's marks into
// lines (pathLines). Two-way lanes take no path across a node, so they get no
// line there.
//
// 0  A slot too thin to count is left out: a car slot (travel or two-way)
//    under 0.5 m, anything else under 1 cm.
// 1  A two-way lane: dashed yellow down its middle.
// 2  Two travel slots next to each other, the gap between them g:
//      g under -0.4 m (they share road), or either is
//      among overlapping paths that swap sides    nothing
//      up to 0.6 m, opposite ways                 two solid yellow, 0.2 m inside each facing
//                                                 edge (the middle of an overlap)
//      up to 0.6 m, same way                      dashed white midway, if both are 2 m wide
//      over 0.6 m                                 an edge line each (3)
// 3  Edge: a travel or two-way slot gets a solid line on each side with no
//    travel or two-way slot within 0.6 m, 0.2 m in from whatever is beside it
//    (from its own edge where nothing is). Two-way: yellow. Travel: white on
//    the driver's right; on the left, the first travel slot outward, not past
//    a sidewalk, gives white if it runs the same way; anything else yellow. At
//    a node the sidewalks' paths are read for this alone.
// 4  Hatching: a solid line 0.2 m inside each side whose neighbour is neither
//    a travel or two-way slot nor hatching. Yellow if the nearest travel
//    slots either side (not past a sidewalk) run opposite ways, else white.

import { curveBetween, offsetPoint, segmentsCross, TAPER, within } from './geometry';
import type { Curve, EndInfo } from './ends';
import { laneEdges } from './outline';
import { type Lane, type Pt, isTravel } from './model';
import type { Mark } from './road';

// Lines sit this far inside the travel lane they edge.
export const INSET = 0.2;
// Two slots closer than this edge to edge are side by side; further apart
// something (a median, hatching) lies between them.
export const BESIDE = 0.6;
// Paths overlapping by more than this share road there: no line between.
const SHARED = 0.4;
// A width of exactly 0.5 or 2 m counts, however its two edges round.
const SLACK = 1e-6;

// One thing across a road, or across a node at one station.
export interface Slot {
	lo: number;
	hi: number;
	kind: 'travel' | 'both' | 'hatch' | 'walk' | 'other';
	// A travel slot's direction: 1 has the driver's right at `hi`.
	way?: 1 | -1;
}

// A line where it crosses one row of slots or one station of a node.
interface RowMark {
	o: number;
	colour: 'white' | 'yellow';
	dashed: boolean;
	// Where the mark lies, when it isn't simply `o` across its row.
	p?: Pt;
	// What the mark follows (a path's edge, say): marks with one key at
	// consecutive rows are one line, however far apart across their rows.
	key?: string;
}

const wide = (s: Slot, least: number) => s.hi - s.lo >= least - SLACK;
// Rule 0: whether a slot counts.
const counts = (s: Slot) =>
	s.kind === 'travel' || s.kind === 'both' ? wide(s, 0.5) : s.hi - s.lo > 0.01;

// The lines across one row of slots, in order across it. Each names the slot
// it edges and on which side, or the two it lies between; `outer` is an edge
// with nothing at all beyond it. `swap` says whether two paths at a node
// change places across it; `walks` are sidewalks across a node's row, which
// stop the look outward of rule 3 and nothing else.
export function linesAcross<S extends Slot>(
	all: S[],
	swap?: (p: S, q: S) => boolean,
	walks: Slot[] = []
) {
	const slots = all.filter(counts);
	const marks: (RowMark & { of: S[]; side: -1 | 0 | 1; outer?: boolean })[] = [];
	const car = (s?: Slot) => s?.kind === 'travel' || s?.kind === 'both';
	// Where paths that cross each other overlap, nothing is painted between
	// any of the paths overlapping there.
	const crossing = new Set<S>();
	for (let i = 0; swap && i < slots.length; ) {
		let j = i;
		while (j + 1 < slots.length && slots[j + 1].lo - slots[j].hi < -SHARED) j++;
		const group = slots.slice(i, j + 1);
		if (group.some((p) => group.some((q) => swap(p, q)))) for (const g of group) crossing.add(g);
		i = j + 1;
	}
	slots.forEach((s, i) => {
		if (s.kind === 'both')
			marks.push({ o: (s.lo + s.hi) / 2, colour: 'yellow', dashed: true, of: [s], side: 0 });
		const next = slots[i + 1];
		if (s.kind !== 'travel' || next?.kind !== 'travel') return;
		const gap = next.lo - s.hi;
		if (gap < -SHARED || gap > BESIDE || crossing.has(s) || crossing.has(next)) return;
		// Each of a double yellow's lines keeps to its own slot's edge while
		// the two are apart, so it runs on unbroken as they come together.
		const mid = (s.hi + next.lo) / 2;
		const [a, b] = gap > 0 ? [s.hi, next.lo] : [mid, mid];
		if (s.way !== next.way)
			marks.push(
				{ o: a - INSET, colour: 'yellow', dashed: false, of: [s], side: 1 },
				{ o: b + INSET, colour: 'yellow', dashed: false, of: [next], side: -1 }
			);
		else if (wide(s, 2) && wide(next, 2))
			marks.push({ o: mid, colour: 'white', dashed: true, of: [s, next], side: 0 });
	});
	// The first travel slot outward from one, not past a sidewalk.
	const travelFrom = (i: number, side: 1 | -1) => {
		for (let k = i + side; slots[k]; k += side) {
			const [near, far] = side === 1 ? [slots[i].hi, slots[k].lo] : [slots[k].hi, slots[i].lo];
			if (walks.some((w) => (w.lo + w.hi) / 2 > near && (w.lo + w.hi) / 2 < far)) break;
			if (slots[k].kind === 'travel') return slots[k];
			if (slots[k].kind === 'walk') break;
		}
		return null;
	};
	const sides = [-1, 1] as const;
	slots.forEach((s, i) => {
		if (!car(s)) return;
		for (const side of sides) {
			const beside = slots[i + side];
			const gap = beside ? (side === 1 ? beside.lo - s.hi : s.lo - beside.hi) : 0;
			if (car(beside) && gap <= BESIDE) continue;
			// Placed from the edge of whatever is beside it (a curb, a verge, a
			// median), so a lane left out between the two never moves the line.
			const [near, own] = side === 1 ? [beside?.lo, s.hi] : [beside?.hi, s.lo];
			const o = (near !== undefined && !car(beside) ? near : own) - side * INSET;
			const white = s.kind === 'travel' && (side === s.way || travelFrom(i, side)?.way === s.way);
			const colour = white ? 'white' : 'yellow';
			marks.push({ o, colour, dashed: false, of: [s], side, outer: !beside });
		}
	});
	slots.forEach((s, i) => {
		if (s.kind !== 'hatch') return;
		const [a, b] = [travelFrom(i, -1), travelFrom(i, 1)];
		const colour = a && b && a.way !== b.way ? 'yellow' : 'white';
		for (const side of sides) {
			const beside = slots[i + side];
			if (!beside || car(beside) || beside.kind === 'hatch') continue;
			const o = (side === 1 ? s.hi : s.lo) - side * INSET;
			marks.push({ o, colour, dashed: false, of: [s], side });
		}
	});
	return marks;
}

// The lines across a road's lanes, laid side by side.
export const laneLines = (spans: { lane: Lane; left: number; right: number }[]) =>
	linesAcross(
		spans.map(({ lane, left: lo, right: hi }): Slot => {
			if (lane.kind === 'drive' && lane.dir === 'both') return { lo, hi, kind: 'both' };
			if (lane.kind === 'drive' && lane.dir !== 'none')
				return { lo, hi, kind: 'travel', way: lane.dir === 'fwd' ? 1 : -1 };
			return {
				lo,
				hi,
				kind: lane.surface === 'hatch' ? 'hatch' : lane.kind === 'walk' ? 'walk' : 'other'
			};
		})
	);

// ---- Across a node.

// Chain each station's marks into continuous polylines: a mark carries on to
// the mark with its key at the next station, or else to the nearest mark of
// the same kind there.
// Lines shorter than `least` are dropped (crumbs).
function chainLines(stations: { d: number; marks: RowMark[] }[], least = 1) {
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

// Stations across the node at which the paths are put in order: one at each
// point of the bands' edges (TAPER in geometry.ts).
const STATIONS = TAPER.STEPS;

const neg = (a: Pt) => ({ x: -a.x, y: -a.y });

// A fraction u of the way along a list of samples: the sample before, and
// how far on toward the next.
function place(count: number, u: number) {
	const x = Math.max(0, Math.min(count - 1, u * (count - 1)));
	const i = Math.min(count - 2, Math.floor(x));
	return { i, f: x - i };
}

// A value, and a point, a fraction of the way along their samples.
function lerp(list: number[], u: number) {
	const { i, f } = place(list.length, u);
	return list[i] + (list[i + 1] - list[i]) * f;
}
function along(pts: Pt[], u: number) {
	const { i, f } = place(pts.length, u);
	return {
		x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
		y: pts[i].y + (pts[i + 1].y - pts[i].y) * f
	};
}

// A curve's direction at each of its points, for laying marks across it:
// square to the road end it meets at either end, and between them along its
// neighbours. A road shifted differently at its two ends has its lanes at a
// slant to its end line (frame.run): the curve leaves that end at the slant,
// and its directions here are turned back by it, less and less toward the
// far end, so marks across the curve start on the road's end line, where its
// own lines end, and run on from there without folding back.
function headings(curve: Curve, from: EndInfo, to: EndInfo) {
	const pts = curve.points;
	const last = pts.length - 1;
	const turn = (a: Pt, b: Pt) => Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
	const t0 = turn(from.frame.run, from.frame.out);
	const t1 = turn(to.frame.run, to.frame.out);
	return pts.map((_, i) => {
		if (i === 0) return neg(from.frame.out);
		if (i === last) return to.frame.out;
		const a = pts[i - 1];
		const b = pts[i + 1];
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const along = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
		const by = t0 + ((t1 - t0) * i) / last;
		if (!by) return along;
		const [c, s] = [Math.cos(by), Math.sin(by)];
		return { x: along.x * c - along.y * s, y: along.x * s + along.y * c };
	});
}

const lengthOf = (pts: Pt[]) =>
	pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);

// The frame the paths across a node are read in: its two outer edges, looking
// from one side's roads (`sa`) to the other's (`sb`), each side led by its
// first. An edge runs from the outermost lane edge of any of a side's roads,
// measured across its leading road, to the other side's; where that is
// another road's than the leading one, the edge starts level with the leading
// road's end, however far along the road reaching furthest out ends.
function frameEdges(sa: EndInfo[], sb: EndInfo[]) {
	const edge = (side: EndInfo[], right: boolean, into: boolean) => {
		const ref = side[0];
		const sign = ((ref.ref.end === 'end') === into) === right ? 1 : -1;
		let best = ref.frame.p;
		let reach = -Infinity;
		for (const e of side)
			for (const l of e.lanes)
				for (const o of [l.left, l.right]) {
					const p = offsetPoint(e.frame.p, e.frame.n, o);
					const s =
						sign * ((p.x - ref.frame.p.x) * ref.frame.n.x + (p.y - ref.frame.p.y) * ref.frame.n.y);
					if (s > reach) {
						reach = s;
						best = e === ref ? p : offsetPoint(ref.frame.p, ref.frame.n, s * sign);
					}
				}
		return best;
	};
	const side = (right: boolean) =>
		curveBetween(
			edge(sa, right, true),
			neg(sa[0].frame.run),
			edge(sb, right, false),
			sb[0].frame.run,
			16
		);
	return { left: side(false), right: side(true) };
}

// The lines between the car paths across a node from one side's road ends to
// the other's: the paths are put in order across the node at every station,
// and each station's lines chained into polylines. They are read between the
// roads with car lanes on either side, each side led by its first such road
// (a footpath leaving one side has no paths to read across). Where one road
// meets one, the two outermost edge lines run smoothly from one end to the
// other, like the verge beside them, instead of tracing whichever paths are
// outermost (a kink where two of them swap). The sidewalks' paths (`walks`)
// are read at each station too, for rule 3's look outward.
export function pathLines(
	cars: { fromEnd: EndInfo; toEnd: EndInfo; curve: Curve }[],
	sa: EndInfo[],
	sb: EndInfo[],
	walks: { fromEnd: EndInfo; curve: Curve }[] = []
) {
	const withCars = (side: EndInfo[]) => {
		const some = side.filter((e) => e.lanes.some((l) => isTravel(l.lane)));
		return some.length ? some : side;
	};
	const [a, b] = [withCars(sa)[0], withCars(sb)[0]];
	const { left, right } = frameEdges(withCars(sa), withCars(sb));
	const smooth = sa.length === 1 && sb.length === 1;
	// Every path read from end a to end b; `start` and `part` are where it
	// sits across the node at either end.
	const paths = cars.map((c, id) => ({
		id,
		curve: c.curve,
		dirs: headings(c.curve, c.fromEnd, c.toEnd),
		forward: sa.includes(c.fromEnd),
		start: 0,
		part: 0
	}));
	// The node's frame at each station, and each path's edges measured across
	// it there.
	const rows = Array.from({ length: STATIONS + 1 }, (_, k) => {
		const u = k / STATIONS;
		const lo = along(left, u);
		const hi = along(right, u);
		const span = Math.hypot(hi.x - lo.x, hi.y - lo.y) || 1;
		const across = { x: (hi.x - lo.x) / span, y: (hi.y - lo.y) / span };
		const project = (p: Pt) => (p.x - lo.x) * across.x + (p.y - lo.y) * across.y;
		const slots = paths.map((path) => {
			const f = path.forward ? u : 1 - u;
			const p = along(path.curve.points, f);
			const w = lerp(path.curve.widths, f);
			const c = project(p);
			// A path leaving the node at an angle (a ramp curving away) is
			// read across the frame, but its lines go across the path itself:
			// each at its offset from the path's middle, square to the path.
			const t = along(path.dirs, f);
			const turn = t.x * across.y - t.y * across.x >= 0 ? 1 : -1;
			const l = turn * (Math.hypot(t.x, t.y) || 1);
			const n = { x: -t.y / l, y: t.x / l };
			const on = (o: number) => offsetPoint(p, n, o - c);
			const way = path.forward ? (1 as const) : (-1 as const);
			return { path, kind: 'travel' as const, way, c, lo: c - w / 2, hi: c + w / 2, on };
		});
		const walking = walks.map(({ fromEnd, curve }): Slot => {
			const f = sa.includes(fromEnd) ? u : 1 - u;
			const c = project(along(curve.points, f));
			const w = lerp(curve.widths, f);
			return { lo: c - w / 2, hi: c + w / 2, kind: 'walk' };
		});
		return { u, lo, across, project, slots, walking };
	});
	paths.forEach((path, i) => {
		path.start = rows[0].slots[i].c;
		path.part = rows[STATIONS].slots[i].c;
	});
	type Path = (typeof paths)[number];
	// Two paths that change places across the node cross each other.
	const swap = (p: Path, q: Path) => (p.start - q.start) * (p.part - q.part) < -0.25;
	const kerb = (side: 'lo' | 'hi') => {
		const [from, to] = [rows[0], rows[STATIONS]].map((row) => {
			// The paths rule 0 leaves out are no edge of the road either.
			const shown = row.slots.filter(counts);
			const edges = (shown.length ? shown : row.slots).map((q) => q[side]);
			return offsetPoint(
				row.lo,
				row.across,
				side === 'lo' ? Math.min(...edges) : Math.max(...edges)
			);
		});
		return curveBetween(from, neg(a.frame.run), to, b.frame.run, STATIONS);
	};
	const kerbs = paths.length && smooth ? { lo: kerb('lo'), hi: kerb('hi') } : null;
	// STATIONS steps, evenly spaced along the node's middle however long it is.
	const step = (lengthOf(left) + lengthOf(right)) / 2 / STATIONS || 1;
	const stations = rows.map((row, k) => {
		// Paths on top of each other go in the order they part.
		const here = row.slots.sort((x, y) => x.lo + x.hi - (y.lo + y.hi) || x.path.part - y.path.part);
		const marks = linesAcross(here, (p, q) => swap(p.path, q.path), row.walking).map(
			(m): RowMark => {
				const { colour, dashed } = m;
				if (m.outer && kerbs) {
					const curb = row.project(along(m.side === 1 ? kerbs.hi : kerbs.lo, row.u));
					return { o: curb - m.side * INSET, colour, dashed };
				}
				const [p, q = p] = m.of.map((s) => s.on(m.o));
				const key = m.side ? `${m.of[0].path.id}:${m.side}` : m.of.map((s) => s.path.id).join(':');
				return { o: m.o, colour, dashed, p: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, key };
			}
		);
		return { d: k * step, marks, lo: row.lo, across: row.across };
	});
	// However short the node, its lines join the roads' either side.
	return chainLines(stations, Math.min(1, step * STATIONS * 0.5)).map(
		(line): Mark => ({
			colour: line.mark.colour,
			dashed: line.mark.dashed,
			pts: line.d.map((d, i) => {
				const s = stations[Math.round(d / step)];
				return line.marks[i].p ?? offsetPoint(s.lo, s.across, line.o[i]);
			})
		})
	);
}

// ---- Beside each other on the ground.

// A seam laps this far over the two paths it lies between.
const SEAM_LAP = 0.2;

// A path across a node with the ground it covers there, and its heading at
// each point for laying marks across it (headings).
interface Swept {
	pts: Pt[];
	widths: number[];
	dirs: Pt[];
	// The outline of its lane as the node draws it (laneEdges in outline.ts).
	ground: Pt[];
}

function sweep(c: { fromEnd: EndInfo; toEnd: EndInfo; curve: Curve }): Swept {
	const { points: pts, widths } = c.curve;
	const { left, right } = laneEdges(
		{ end: c.fromEnd, lane: c.curve.from },
		{ end: c.toEnd, lane: c.curve.to },
		pts.length - 1
	);
	return {
		pts,
		widths,
		dirs: headings(c.curve, c.fromEnd, c.toEnd),
		ground: [...left, ...right.reverse()]
	};
}

// Where a path's ground lies on the line through `p` square to the heading
// `t`: the stretch of that line it covers nearest `p` (metres to the right of
// `p`), and whether the path runs `t`'s way there or against it.
function sectionOf(path: Swept, p: Pt, t: Pt) {
	const hits: number[] = [];
	const ring = path.ground;
	for (let k = 0; k < ring.length; k++) {
		const [a, b] = [ring[k], ring[(k + 1) % ring.length]];
		const da = (a.x - p.x) * t.x + (a.y - p.y) * t.y;
		const db = (b.x - p.x) * t.x + (b.y - p.y) * t.y;
		if (da > 0 === db > 0) continue;
		const u = da / (da - db);
		hits.push((a.x + (b.x - a.x) * u - p.x) * -t.y + (a.y + (b.y - a.y) * u - p.y) * t.x);
	}
	hits.sort((x, y) => x - y);
	let best: { lo: number; hi: number } | null = null;
	const off = (s: { lo: number; hi: number }) => Math.max(s.lo, -s.hi, 0);
	for (let k = 1; k < hits.length; k += 2) {
		const s = { lo: hits[k - 1], hi: hits[k] };
		if (!best || off(s) < off(best)) best = s;
	}
	if (!best) return null;
	const mid = offsetPoint(p, { x: -t.y, y: t.x }, (best.lo + best.hi) / 2);
	let near = 0;
	path.pts.forEach((q, k) => {
		if (
			Math.hypot(q.x - mid.x, q.y - mid.y) <
			Math.hypot(path.pts[near].x - mid.x, path.pts[near].y - mid.y)
		)
			near = k;
	});
	const way = path.dirs[near].x * t.x + path.dirs[near].y * t.y >= 0 ? (1 as const) : (-1 as const);
	return { ...best, way };
}

// The lines between the car paths of a node where roads are attached at an
// edge. Its paths don't all run from one side to the other (one turns off
// into a road attached square to the rest while its neighbour carries
// straight on), so no one frame puts them in order at every station, and
// each path is read on its own instead. At every point along it, the paths
// whose ground its own cross-section there meets (the line square to it) are
// its neighbours, each as wide as it lies across that line and going the
// path's way or against it. The row they make goes to the rule every row
// goes to (linesAcross): the path keeps the lines that puts on its own two
// sides, and of two paths the earlier keeps the line midway between them.
// Nothing is painted on a path where another crosses over it. A path's lines
// are chained along it; where one changes colour, or takes over from the line
// midway to a path coming beside it, the new one starts where the old one
// stops.
//
// `seams` is the ground between two paths wherever they are side by side
// (BESIDE): too narrow to be anything but road. Each laps SEAM_LAP over the
// two paths, whose own ground lies over it there.
export function linesBeside(
	cars: { fromEnd: EndInfo; toEnd: EndInfo; curve: Curve }[],
	walks: { fromEnd: EndInfo; toEnd: EndInfo; curve: Curve }[] = []
) {
	const paths = cars.map(sweep);
	const walked = walks.map(sweep);
	// Which paths cross each other.
	const crossed = paths.map((p, a) =>
		paths.map((q, b) => {
			if (a === b) return false;
			for (let i = 1; i < p.pts.length; i++)
				for (let k = 1; k < q.pts.length; k++)
					if (segmentsCross(p.pts[i - 1], p.pts[i], q.pts[k - 1], q.pts[k], 0)) return true;
			return false;
		})
	);
	type Beside = Slot & { path: number };
	const lines: Mark[] = [];
	const seams: Pt[][] = [];
	paths.forEach((path, a) => {
		const last = path.pts.length - 1;
		const normal = (i: number) => ({ x: -path.dirs[i].y, y: path.dirs[i].x });
		// Path b across this one's cross-section at point i. One lying exactly
		// on this one there (two sharing a lane where they start or end) is put
		// on the side it lies on a little further along.
		// (The path's first and last points lie on its roads' end lines, where
		// every path there starts or ends: its cross-section is read a hair
		// inside the node instead.)
		const cut = (other: Swept, i: number) => {
			const inward = i === 0 ? 1e-4 : i === last ? -1e-4 : 0;
			return sectionOf(other, offsetPoint(path.pts[i], path.dirs[i], inward), path.dirs[i]);
		};
		const across = (b: number, i: number) => cut(paths[b], i);
		const beside = (b: number, i: number) => {
			const here = across(b, i);
			if (!here || Math.abs(here.lo + here.hi) >= 1e-6) return here;
			const toward = i < last / 2 ? 1 : -1;
			for (let k = i + toward; k >= 0 && k <= last && Math.abs(k - i) <= 4; k += toward) {
				const c = across(b, k);
				const nudge = c && Math.abs(c.lo + c.hi) >= 1e-6 ? Math.sign(c.lo + c.hi) * 1e-7 : 0;
				if (nudge) return { ...here, lo: here.lo + nudge, hi: here.hi + nudge };
			}
			return here;
		};
		// Each line of this path by what it follows (a side of it, or the path
		// it lies midway to), at each point along.
		const marks = new Map<string, ({ p: Pt; colour: Mark['colour']; dashed: boolean } | null)[]>();
		// Where a line lies midway between this path and one beside it, by side.
		const midway: Record<number, boolean[]> = { [-1]: [], 1: [] };
		// How far off another path's ground lies on either side, where one
		// lies beside it.
		const gaps = new Map<string, (number | null)[]>();
		const listed = <T>(lists: Map<string, (T | null)[]>, key: string) => {
			if (!lists.has(key))
				lists.set(
					key,
					path.pts.map(() => null)
				);
			return lists.get(key)!;
		};
		// The path's own ground across each of its points: its lane's two edges
		// as drawn there, which bow a little off its middle line's.
		const span = path.pts.map((p, i) => {
			const half = path.widths[i] / 2;
			const s = cut(path, i);
			return s && s.lo < 0 && s.hi > 0 ? s : { lo: -half, hi: half };
		});
		path.pts.forEach((p, i) => {
			const own: Beside = { ...span[i], kind: 'travel', way: 1, path: a };
			const row: Beside[] = [own];
			paths.forEach((_, b) => {
				const s = b === a ? null : beside(b, i);
				if (s) row.push({ ...s, kind: 'travel', path: b });
			});
			row.sort((x, y) => x.lo + x.hi - (y.lo + y.hi));
			const walking = walked.flatMap((w): Slot[] => {
				const s = cut(w, i);
				return s ? [{ lo: s.lo, hi: s.hi, kind: 'walk' }] : [];
			});
			for (const m of linesAcross(row, (x, y) => crossed[x.path][y.path], walking)) {
				if (!m.of.includes(own)) continue;
				const other = m.of.find((s) => s !== own);
				if (other) midway[other.lo + other.hi > 0 ? 1 : -1][i] = true;
				if (other && other.path < a) continue;
				const at = offsetPoint(p, normal(i), m.o);
				// Under a path crossing this one there is no line.
				if (paths.some((q, b) => crossed[a][b] && within([q.ground], at))) continue;
				listed(marks, other ? `to ${other.path}` : `${m.side}`)[i] = {
					p: at,
					colour: m.colour,
					dashed: m.dashed
				};
			}
			// How near any other path's ground comes on either side.
			const k = row.indexOf(own);
			for (const side of [-1, 1]) {
				const there = side === 1 ? row.slice(k + 1) : row.slice(0, k);
				const gap = Math.min(...there.map((s) => (side === 1 ? s.lo - own.hi : own.lo - s.hi)));
				if (gap <= BESIDE) listed(gaps, `${side}`)[i] = Math.max(0, gap);
			}
		});
		for (const [key, list] of marks) {
			// A line along a side of the path that takes over from the line
			// midway to a path coming beside it starts a point early (or ends a
			// point late), along the path's own edge: the two meet instead of
			// leaving a step unpainted between them.
			const side = Number(key) || 0;
			const edge = (i: number) =>
				offsetPoint(path.pts[i], normal(i), side === 1 ? span[i].hi - INSET : span[i].lo + INSET);
			const runs: Mark[] = [];
			list.forEach((m, i) => {
				if (!m) return;
				let run = list[i - 1] ? runs[runs.length - 1] : undefined;
				if (run && run.colour === m.colour && run.dashed === m.dashed) run.pts.push(m.p);
				else {
					const from = run
						? [run.pts[run.pts.length - 1]]
						: midway[side]?.[i - 1]
							? [edge(i - 1)]
							: [];
					run = { colour: m.colour, dashed: m.dashed, pts: [...from, m.p] };
					runs.push(run);
				}
				if (!list[i + 1] && midway[side]?.[i + 1]) run.pts.push(edge(i + 1));
			});
			lines.push(...runs.filter((run) => run.pts.length > 1 && lengthOf(run.pts) >= 1));
		}
		for (const [key, list] of gaps) {
			const side = Number(key);
			const edge = (i: number, gap: number) =>
				offsetPoint(path.pts[i], normal(i), side === 1 ? span[i].hi + gap : span[i].lo - gap);
			for (let i = 1; i <= last; i++) {
				const [g0, g1] = [list[i - 1], list[i]];
				if (g0 === null || g1 === null || (g0 === 0 && g1 === 0)) continue;
				seams.push([
					edge(i - 1, -SEAM_LAP),
					edge(i, -SEAM_LAP),
					edge(i, g1 + SEAM_LAP),
					edge(i - 1, g0 + SEAM_LAP)
				]);
			}
		}
	});
	return { lines, seams };
}
