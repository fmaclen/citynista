// Roads carried straight across a junction: the ends a road carries on
// into (`facingOf`), and its lanes laid across as bands and lines (`carry`).

import { area as areaOf, intersect, offset, type Paths, toPath } from './clip';
import type { Material, Role } from './description';
import { crossesAny, type Curve, type EndInfo, laneEndOf, lateral } from './ends';
import { curveBetween, dist, dot, neg, offsetPoint, quad } from './geometry';
import { laneLines } from './lines';
import {
	type Connection,
	endKey,
	type Junction,
	type Lane,
	type LaneRef,
	type Pt,
	isRoadway,
	isTravel
} from './model';
import { type Mark, materialOf } from './road';

// A line painted across the junction, and the road ends it runs between: it
// may run on over their roadways, never over another road's.
export interface Owned extends Mark {
	own: EndInfo[];
}

// A lane carried across a node between two curves of one point count, as on
// its road: hatching is roadway, with its bars (`line` their colour); grass
// and concrete between carriageways stand raised. `lane` is the lane it
// carries on from.
export interface Band {
	lane: LaneRef;
	role: Role;
	material: Material;
	left: Pt[];
	right: Pt[];
	line: 'white' | 'yellow';
	bars: Paths;
}

// The road ends `a` carries straight on into: nearly opposite it and joined
// to it by connections. Where one of them is about as wide as `a` (the same
// road carrying on), a narrower one beside it (a ramp or a side road at a
// slant) only joins it and isn't carried into.
export function facingOf(a: EndInfo, ends: EndInfo[], connections: Connection[]) {
	const facing = ends.filter(
		(e) =>
			e !== a &&
			e.lanes.some((l) => isRoadway(l.lane)) &&
			dot(e.frame.out, a.frame.out) < -0.7 &&
			connections.some(
				(c) =>
					(endKey(c.from) === a.key && endKey(c.to) === e.key) ||
					(endKey(c.from) === e.key && endKey(c.to) === a.key)
			)
	);
	const wide = facing.filter((e) => roadwayOf(e) >= 0.6 * roadwayOf(a));
	return wide.length ? wide : facing;
}

const roadwayOf = (e: EndInfo) =>
	e.lanes.filter((l) => isRoadway(l.lane)).reduce((s, l) => s + l.right - l.left, 0);

// Hatch bars carried on from road end A: the same slant and the same 4 m
// rhythm (measured along A's road) as the bars painted on the road.
function hatchBars(a: EndInfo, lo: number, hi: number, length: number): Paths {
	const w = hi - lo;
	const into = neg(a.frame.out);
	// The road paints a bar every 4 m in world terms along its heading; the
	// slant runs with the road's drawing direction.
	const sign = a.ref.end === 'end' ? 1 : -1;
	const t = { x: into.x * sign, y: into.y * sign };
	const along0 = dot(a.frame.p, t);
	const first = (((-along0 * sign) % 4) + 4) % 4;
	const out: Paths = [];
	for (let s = first - 8; s < length + 8; s += 4) {
		const base = offsetPoint(a.frame.p, into, s);
		const p0 = offsetPoint(base, a.frame.n, lo - 0.5);
		const p1 = offsetPoint(
			offsetPoint(base, into, sign * Math.max(w, 1) * 0.8),
			a.frame.n,
			hi + 0.5
		);
		out.push(toPath(quad(p0, p1, 0.25)));
	}
	return out;
}

// A road carried across that turns by less than this (10°) runs nearly
// straight on.
const STRAIGHT_ON = Math.cos((10 * Math.PI) / 180);

// Carrying a road across the junction: from road end A, the roads leaving the
// far side (facing A, joined to it by connections) are laid side by side
// across A's line. Where their lanes line up with A's, kind for kind (a run
// of buffers counting as one), A's lanes run on across: buffers as strips,
// paint as lines.
export function carry(
	a: EndInfo,
	ends: EndInfo[],
	junction: Junction,
	others: Curve[],
	out: { bands: Band[]; marks: Owned[] }
) {
	const far = facingOf(a, ends, junction.connections);
	if (!far.length) return false;
	// Each crossing is laid once: from the side with one road, or from the
	// smaller key when one road faces one road.
	if (far.length === 1) {
		const back = facingOf(far[0], ends, junction.connections);
		if (back.length > 1 || (back.length === 1 && far[0].key < a.key)) return false;
	}
	// Lanes are put side by side across A's line, a far road's lanes each at
	// its place across its own end, lined up with A's: where the road runs
	// nearly straight on, by where its end lies across A's line; round a
	// bend (a road on a curve), where its end lies across depends on how the
	// road curves, so by the lanes that connect across instead, on average.
	const into = neg(a.frame.out);
	const turn = dot({ x: -into.y, y: into.x }, a.frame.n) > 0 ? 1 : -1;
	const frameOf = (end: EndInfo) => {
		if (end === a) return { shift: 0, sign: 1 };
		// Across the heading halfway between A's and the far road's.
		const h = { x: into.x + end.frame.out.x, y: into.y + end.frame.out.y };
		const l = Math.hypot(h.x, h.y) || 1;
		const n = { x: (-h.y / l) * turn, y: (h.x / l) * turn };
		const sign = dot(end.frame.n, n) > 0 ? 1 : -1;
		const measured = dot({ x: end.frame.p.x - a.frame.p.x, y: end.frame.p.y - a.frame.p.y }, n);
		if (dot(into, end.frame.out) > STRAIGHT_ON) return { shift: measured, sign };
		const gaps: number[] = [];
		for (const c of junction.connections) {
			const from = laneEndOf(ends, c.from);
			const to = laneEndOf(ends, c.to);
			if (!from || !to || !isTravel(from.lane.lane)) continue;
			const [near, there] =
				from.end === a && to.end === end
					? [from, to]
					: to.end === a && from.end === end
						? [to, from]
						: [];
			if (near && there)
				gaps.push(lateral(a, near.lane.point) - sign * lateral(end, there.lane.point));
		}
		return {
			shift: gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : measured,
			sign
		};
	};
	const inFrame = (end: EndInfo) =>
		end.lanes.map((l) => {
			const { shift, sign } = frameOf(end);
			const c = shift + sign * lateral(end, l.point);
			const w = l.right - l.left;
			const flow = end === a ? l.flow : l.flow === 'in' ? 'out' : l.flow === 'out' ? 'in' : l.flow;
			const dir: Lane['dir'] = isTravel(l.lane)
				? (flow === 'out') === (a.ref.end === 'start')
					? 'fwd'
					: 'back'
				: l.lane.dir;
			return { lane: { ...l.lane, dir }, left: c - w / 2, right: c + w / 2, end, own: l };
		});
	const near = inFrame(a).sort((p, q) => p.left - q.left);
	const other = far.flatMap(inFrame).sort((p, q) => p.left - q.left);
	const roadwayOnly = (list: typeof near) => {
		const i0 = list.findIndex((s) => isRoadway(s.lane));
		const i1 = list.length - 1 - [...list].reverse().findIndex((s) => isRoadway(s.lane));
		return i0 < 0 ? [] : list.slice(i0, i1 + 1);
	};
	const group = (list: typeof near) => {
		const groups: { kind: string; items: typeof near }[] = [];
		for (const s of list) {
			const kind = isTravel(s.lane)
				? `${s.lane.kind}:${s.lane.dir}`
				: s.lane.kind === 'buffer'
					? `buffer:${s.lane.surface === 'hatch' ? 'hatch' : 'raised'}`
					: s.lane.kind;
			// Side by side lanes of one kind (travel lanes going one way, say)
			// are one group, so a road gaining a lane across the junction (an
			// acceleration lane) still carries on.
			const last = groups[groups.length - 1];
			if (last && last.kind === kind) last.items.push(s);
			else groups.push({ kind, items: [s] });
		}
		return groups;
	};
	const ga = group(roadwayOnly(near));
	const gb = group(roadwayOnly(other));
	if (ga.length !== gb.length || ga.some((g, i) => g.kind !== gb[i].kind)) return false;
	// A lane's edge where it meets its own road end, on the side (-1 or 1) of
	// it toward A's left or right: the road's own point there.
	const edgeOf = (s: (typeof near)[number], side: -1 | 1) => {
		const e = s.end;
		const right = side * (dot(e.frame.n, a.frame.n) > 0 ? 1 : -1) > 0;
		return offsetPoint(e.frame.p, e.frame.n, right ? s.own.right : s.own.left);
	};
	// Nothing is carried across if another road's mouth reaches into the
	// carried roadway (a side road pushed into the street). (Inset past the
	// few centimetres a road without sidewalks laps over the curb it stops
	// on.)
	const corners = [
		ga[0].items[0],
		ga.at(-1)!.items.at(-1)!,
		gb.at(-1)!.items.at(-1)!,
		gb[0].items[0]
	];
	const span = offset(
		[toPath(corners.map((s, i) => edgeOf(s, i === 0 || i === 3 ? -1 : 1)))],
		-0.3
	);
	for (const e of ends) {
		if (e === a || far.includes(e) || !e.lanes.some((l) => isRoadway(l.lane))) continue;
		const roadway = e.lanes.filter((l) => isRoadway(l.lane));
		const lo = offsetPoint(e.frame.p, e.frame.n, Math.min(...roadway.map((l) => l.left)));
		const hi = offsetPoint(e.frame.p, e.frame.n, Math.max(...roadway.map((l) => l.right)));
		if (
			intersect(span, [
				toPath([lo, hi, offsetPoint(hi, e.frame.out, 0.05), offsetPoint(lo, e.frame.out, 0.05)])
			]).length
		)
			return false;
	}
	const steps = (p: Pt, q: Pt) => Math.max(4, Math.ceil(dist(p, q) / 1.5));
	const along = (p: Pt, q: Pt, qOut: Pt, samples = steps(p, q)) =>
		curveBetween(p, neg(a.frame.run), q, qOut, samples);
	// Buffers as strips, unless a turning connection cuts across them.
	ga.forEach((g, i) => {
		if (!g.kind.startsWith('buffer')) return;
		const h = gb[i];
		const aL = edgeOf(g.items[0], -1);
		const aR = edgeOf(g.items[g.items.length - 1], 1);
		const fl = h.items[0];
		const fr = h.items[h.items.length - 1];
		const bL = edgeOf(fl, -1);
		const bR = edgeOf(fr, 1);
		// Both edges in one count of points, so the band is a ribbon.
		const n = Math.max(steps(aL, bL), steps(aR, bR));
		const left = along(aL, bL, fl.end.frame.run, n);
		const right = along(aR, bR, fr.end.frame.run, n);
		const poly = [toPath([...left, ...[...right].reverse()])];
		const cut = others.some((c) =>
			c.points.some(
				(p, k) => k > 0 && intersect([toPath(quad(c.points[k - 1], p, 0.05))], poly).length > 0
			)
		);
		if (cut) return;
		const surface = g.items[0].lane.surface;
		const l = ga[i - 1]?.items[0].lane;
		const r = ga[i + 1]?.items[0].lane;
		const opposing = !!(l && r && isTravel(l) && isTravel(r) && l.dir !== r.dir);
		const reach = Math.max(...left.map((q) => dist(q, aL)), 1);
		const bars =
			surface === 'hatch'
				? intersect(
						hatchBars(a, g.items[0].left, g.items[g.items.length - 1].right, reach),
						poly
					).filter((bar) => Math.abs(areaOf(bar)) > 0.3)
				: [];
		out.bands.push({
			lane: g.items[0].own.ref,
			role:
				surface === 'hatch'
					? 'lane'
					: surface === 'grass' || surface === 'concrete'
						? 'median'
						: 'verge',
			material: materialOf(surface),
			left,
			right,
			line: opposing ? 'yellow' : 'white',
			bars
		});
	});
	// Paint: the marks across A's end and across the far ends must match one
	// for one; each runs on as a curve between them.
	const ma = laneLines(near).filter(
		(m) => m.o >= ga[0].items[0].left - 0.01 && m.o <= ga[ga.length - 1].items.at(-1)!.right + 0.01
	);
	const mb = laneLines(other).filter(
		(m) => m.o >= gb[0].items[0].left - 0.01 && m.o <= gb[gb.length - 1].items.at(-1)!.right + 0.01
	);
	// Each mark carries on to the far mark of its kind straight across from
	// it; a mark with none there (beside a lane gained or lost across the
	// junction) stops.
	const used = new Set<number>();
	const pairs = ma.flatMap((m) => {
		const k = mb.findIndex(
			(x, i) =>
				!used.has(i) && x.colour === m.colour && x.dashed === m.dashed && Math.abs(x.o - m.o) < 0.75
		);
		if (k < 0) return [];
		used.add(k);
		return [{ m, o: mb[k].o }];
	});
	for (const { m, o } of pairs) {
		const p = offsetPoint(a.frame.p, a.frame.n, m.o);
		// The far mark sits on whichever far road spans its offset.
		const host = other.find((s) => o >= s.left - 0.3 && o <= s.right + 0.3)?.end ?? far[0];
		const { shift, sign } = frameOf(host);
		const q = offsetPoint(host.frame.p, host.frame.n, sign * (o - shift));
		const pts = along(p, q, host.frame.run);
		// A line only carries on where no turning traffic crosses it.
		if (crossesAny(pts, others)) continue;
		out.marks.push({ colour: m.colour, dashed: m.dashed, pts, own: [a, ...far] });
	}
	return true;
}
