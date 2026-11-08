// Default connections and controls. They are filled in once and stored as
// ordinary data that the user edits; nothing here looks at angles beyond the
// order in which roads leave a node. Five rules:
//
// 1. Kind. A lane connects only to lanes of its own kind (car, bus, median
//    or other buffer, grass, sidewalk, trail); travel lanes run from where
//    traffic comes in to where it goes out, never back into their own road.
// 2. In order. Across a node of two roads, travel lanes going the same way
//    pair up: a lane with the other road's lane of its own id (the same
//    lane, where one road was cut from the other), the rest in order with
//    the run of lanes that lines up best across the node, nearest the kerb
//    where runs tie. A lane left over joins the nearest lane going its way,
//    so an added turn lane branches off its neighbour. Other lanes pair up
//    in order across.
// 3. Turns beside straight on. At a node of three or more roads an
//    approach's travel lanes go into the exit most nearly ahead as by rule 2.
//    Lanes left over left of those take every exit to the left, and those
//    on the kerb side every exit to the right; with none left over on a
//    side, the outermost straight-on lane on that side does. A turn goes
//    lane by lane from the side it turns toward. Medians, grass and sidewalks don't connect across such a node by
//    default: its sidewalks get corners and crosswalks instead.
// 4. Control. At a node of three or more roads where three or more of them
//    are busy (two or more travel lanes each way), every approach has
//    signals. Otherwise a road carrying straight on through the node (the
//    pair of ends whose lanes connect most nearly straight across) with at
//    least as many travel lanes as any other road goes on; a road that only
//    feeds into it (one way in) yields where it joins lanes other traffic
//    enters too, and goes on where it has them to itself; the rest stop. With
//    no such road, every approach stops.
// 5. Side by side. Where a road is attached at the edge of another (see
//    sideConnections), lanes carry on beside each other and nothing turns.

import type { EndInfo, LaneEnd } from './junction';
import { laneKey, type Connection, type Control, type Lane, type Pt } from './model';
import { isTravel } from './road';

// A road with at least this many travel lanes is busy.
const BUSY = 4;

// Lanes of one kind connect only to each other.
export function kindOf(lane: Lane) {
	if (lane.kind === 'buffer') return lane.surface === 'grass' ? 'grass' : 'buffer';
	return lane.kind;
}

// A lane's position across its road, measured to the right of a driver
// heading into the node (`into`) or out of it along the road.
export function lateral(end: EndInfo, lane: LaneEnd, into: boolean) {
	const mid = (lane.left + lane.right) / 2;
	// Offsets grow to the right of the drawing direction; a road's start faces
	// the node against it.
	const along = (end.ref.end === 'end') === into;
	return along ? mid : -mid;
}

// How far a travel lane is from the kerb on the driver's right, heading into
// the node (`into`) or out of it.
function fromKerb(end: EndInfo, lane: LaneEnd, into: boolean) {
	const along = (end.ref.end === 'end') === into;
	const kerb = Math.max(
		...end.lanes.filter((l) => isTravel(l.lane)).map((l) => (along ? l.right : -l.left))
	);
	return kerb - lateral(end, lane, into);
}

// Lanes in order across, paired so the order is kept and the pairs sit as
// close as they can: the shorter list lines up against a run of the longer.
function pairInOrder<T>(a: T[], b: T[], pa: (x: T) => number, pb: (x: T) => number) {
	const short = a.length <= b.length;
	const [s, l] = short ? [a, b] : [b, a];
	const [ps, pl] = short ? [pa, pb] : [pb, pa];
	let best = 0;
	let bestCost = Infinity;
	for (let k = 0; k + s.length <= l.length; k++) {
		const cost = s.reduce((sum, x, i) => sum + Math.abs(ps(x) - pl(l[k + i])), 0);
		if (cost < bestCost) {
			bestCost = cost;
			best = k;
		}
	}
	const pairs: [T, T][] = s.map((x, i) => (short ? [x, l[best + i]] : [l[best + i], x]));
	const rest = l.filter((_, i) => i < best || i >= best + s.length);
	return { pairs, restA: short ? [] : rest, restB: short ? rest : [] };
}

const nearest = <T>(pool: T[], to: number, at: (x: T) => number) =>
	pool.reduce((best, x) => (Math.abs(at(x) - to) < Math.abs(at(best) - to) ? x : best));

// Straight-on pairs between an approach's lanes and an exit's. A lane goes
// on into the lane with its own id where the exit has one: the same lane,
// where one road was cut from the other (a lane added to the piece later
// has a new id, so a pocket's turn lane is the one left over). The rest
// pair in order with the run of the other side's lanes that lines up best
// across the node (each measured to the driver's right of the line the
// roads meet on), nearest the kerb where runs tie.
function pairStraight(from: EndInfo, ins: LaneEnd[], to: EndInfo, outs: LaneEnd[]) {
	const ki = (l: LaneEnd) => fromKerb(from, l, true);
	const ko = (l: LaneEnd) => fromKerb(to, l, false);
	const pi = (l: LaneEnd) => lateral(from, l, true);
	const po = (l: LaneEnd) => lateral(to, l, false);
	const pairs: [LaneEnd, LaneEnd][] = [];
	const used = new Set<LaneEnd>();
	const restIns: LaneEnd[] = [];
	for (const a of ins) {
		const b = outs.find((o) => !used.has(o) && o.ref.lane === a.ref.lane);
		if (b) {
			pairs.push([a, b]);
			used.add(b);
		} else restIns.push(a);
	}
	// Kerb first.
	const a = restIns.sort((x, y) => pi(y) - pi(x));
	const b = outs.filter((o) => !used.has(o)).sort((x, y) => po(y) - po(x));
	const shortIsA = a.length <= b.length;
	const [s, l] = shortIsA ? [a, b] : [b, a];
	const [ps, pl] = shortIsA ? [pi, po] : [po, pi];
	let best = 0;
	let bestCost = Infinity;
	for (let k = 0; k + s.length <= l.length; k++) {
		const cost = s.reduce((sum, x, i) => sum + Math.abs(ps(x) - pl(l[k + i])), 0);
		if (cost < bestCost - 0.01) {
			bestCost = cost;
			best = k;
		}
	}
	for (const [i, x] of s.entries()) pairs.push(shortIsA ? [x, l[best + i]] : [l[best + i], x]);
	const rest = l.filter((_, i) => i < best || i >= best + s.length);
	return {
		pairs,
		restA: shortIsA ? [] : rest,
		restB: shortIsA ? rest : [],
		ki,
		ko
	};
}

// Rule 2 for travel lanes from one end into another.
function straightOn(
	from: EndInfo,
	ins: LaneEnd[],
	to: EndInfo,
	outs: LaneEnd[],
	out: Connection[]
) {
	if (ins.length === 0 || outs.length === 0) return;
	const { pairs, restA, restB, ki, ko } = pairStraight(from, ins, to, outs);
	for (const [a, b] of pairs) out.push({ from: a.ref, to: b.ref });
	for (const b of restB) out.push({ from: nearest(ins, ko(b), ki).ref, to: b.ref });
	for (const a of restA) out.push({ from: a.ref, to: nearest(outs, ki(a), ko).ref });
}

export function defaultConnections(ends: EndInfo[]): Connection[] {
	const out: Connection[] = [];
	const travel = (e: EndInfo, kind: string, flow: 'in' | 'out') =>
		e.lanes.filter((l) => isTravel(l.lane) && kindOf(l.lane) === kind && l.flow === flow);

	if (ends.length === 2) {
		const [a, b] = ends;
		for (const kind of ['drive', 'bus']) {
			straightOn(a, travel(a, kind, 'in'), b, travel(b, kind, 'out'), out);
			straightOn(b, travel(b, kind, 'in'), a, travel(a, kind, 'out'), out);
		}
		// Everything else pairs up in order across, read from end a.
		const others = (e: EndInfo) => e.lanes.filter((l) => !isTravel(l.lane));
		for (const kind of new Set(others(a).map((l) => kindOf(l.lane)))) {
			const at = (e: EndInfo) => (l: LaneEnd) => lateral(e, l, e === a);
			const sorted = (e: EndInfo) =>
				others(e)
					.filter((l) => kindOf(l.lane) === kind)
					.sort((x, y) => at(e)(x) - at(e)(y));
			const { pairs } = pairInOrder(sorted(a), sorted(b), at(a), at(b));
			for (const [x, y] of pairs) out.push({ from: x.ref, to: y.ref });
		}
		return out;
	}

	for (const kind of ['drive', 'bus']) {
		for (const from of ends) {
			const pi = (l: LaneEnd) => lateral(from, l, true);
			const ins = travel(from, kind, 'in').sort((x, y) => pi(x) - pi(y));
			if (ins.length === 0) continue;
			const heading = { x: -from.frame.out.x, y: -from.frame.out.y };
			// Exits by how far they turn: negative to the left, positive to the
			// right (y grows downward, so a positive cross product is a right).
			const exits = ends
				.filter((e) => e !== from && travel(e, kind, 'out').length > 0)
				.map((e) => ({
					e,
					turn: Math.atan2(
						heading.x * e.frame.out.y - heading.y * e.frame.out.x,
						heading.x * e.frame.out.x + heading.y * e.frame.out.y
					),
					outs: travel(e, kind, 'out').sort((x, y) => lateral(e, x, false) - lateral(e, y, false))
				}));
			if (exits.length === 0) continue;
			const ahead = exits.reduce((best, x) => (Math.abs(x.turn) < Math.abs(best.turn) ? x : best));
			const { pairs, restA, restB, ki, ko } = pairStraight(from, ins, ahead.e, ahead.outs);
			for (const [x, y] of pairs) out.push({ from: x.ref, to: y.ref });
			for (const y of restB) out.push({ from: nearest(ins, ko(y), ki).ref, to: y.ref });
			const through = pairs.map(([x]) => x).sort((x, y) => pi(x) - pi(y));
			// Lanes left over turn: those left of the straight-on ones left,
			// those on the kerb side right.
			const lo = pi(through[0]);
			const hi = pi(through[through.length - 1]);
			const lefts = restA.filter((x) => pi(x) < lo).sort((x, y) => pi(x) - pi(y));
			const rights = restA.filter((x) => pi(x) > hi).sort((x, y) => pi(y) - pi(x));
			for (const x of restA)
				if (pi(x) >= lo && pi(x) <= hi)
					out.push({ from: x.ref, to: nearest(ahead.outs, ki(x), ko).ref });
			for (const x of exits) {
				if (x === ahead) continue;
				const o = x.outs;
				if (x.turn < ahead.turn) {
					// With none left over on the left, the leftmost straight-on
					// lane turns left; lane by lane from the left.
					const turning = lefts.length ? lefts : through.slice(0, 1);
					turning.forEach((l, i) =>
						out.push({ from: l.ref, to: o[Math.min(i, o.length - 1)].ref })
					);
				} else {
					// With none left over on the kerb side, the kerb lane turns
					// right; lane by lane from the kerb.
					const turning = rights.length ? rights : through.slice(-1);
					const kerbFirst = [...o].reverse();
					turning.forEach((l, i) =>
						out.push({ from: l.ref, to: kerbFirst[Math.min(i, kerbFirst.length - 1)].ref })
					);
				}
			}
		}
	}
	return out;
}

export function defaultControl(
	ends: EndInfo[],
	through: Set<string>,
	connections: Connection[]
): Record<string, Control> {
	const control: Record<string, Control> = {};
	const approaches = ends.filter((e) => e.lanes.some((l) => isTravel(l.lane) && l.flow === 'in'));
	if (ends.length < 3) {
		for (const e of approaches) control[e.key] = 'none';
		return control;
	}
	const lanes = (e: EndInfo) => e.lanes.filter((l) => isTravel(l.lane)).length;
	// Three or more busy roads (two or more lanes each way) meeting: signals.
	if (ends.filter((e) => lanes(e) >= BUSY).length >= 3) {
		for (const e of approaches) control[e.key] = 'signal';
		return control;
	}
	// A road carrying on through the node with at least as many lanes as any
	// other goes on; a road only feeding into it yields where its traffic
	// joins lanes other traffic also enters, and goes on where it has its
	// lanes to itself; any other road stops.
	const into = (e: EndInfo) =>
		connections.filter((c) => c.from.road === e.ref.road && c.from.end === e.ref.end);
	const shares = (e: EndInfo) => {
		const mine = new Set(into(e).map((c) => laneKey(c.to)));
		return ends.some((o) => o !== e && into(o).some((c) => mine.has(laneKey(c.to))));
	};
	const main = ends.filter((e) => through.has(e.key));
	const others = ends.filter((e) => !through.has(e.key));
	const leads = main.length === 2 && others.every((o) => main.every((m) => lanes(m) >= lanes(o)));
	for (const e of approaches) {
		if (leads && main.includes(e)) control[e.key] = 'none';
		else if (leads && e.lanes.every((l) => !isTravel(l.lane) || l.flow === 'in'))
			control[e.key] = shares(e) ? 'yield' : 'none';
		else control[e.key] = 'stop';
	}
	return control;
}

// Where a lane of an end attached at an edge lies, read at the point it
// joins the other road (its anchor) instead of where the node trims it back
// to; other lanes lie where they end.
export function sidePoint(end: EndInfo, lane: LaneEnd, anchors: Record<string, Pt>) {
	const anchor = anchors[end.key];
	if (!anchor) return lane.point;
	const { p, n } = end.frame;
	const across = (lane.point.x - p.x) * n.x + (lane.point.y - p.y) * n.y;
	return { x: anchor.x + n.x * across, y: anchor.y + n.y * across };
}

// Across a node where roads are attached at an edge (a ramp beside a
// freeway, the two halves of a road that splits), the road ends on one side
// and those on the other are each read as one road. Travel lanes going the
// same way pair up in order across, lined up by where they lie; a lane left
// over joins the nearest going its way. Other lanes pair up in order across
// by kind. Nothing turns.
export function sideConnections(
	groups: [EndInfo[], EndInfo[]],
	anchors: Record<string, Pt> = {}
): Connection[] {
	const out: Connection[] = [];
	const ref = groups[0][0];
	const at = new Map<LaneEnd, Pt>();
	for (const e of [...groups[0], ...groups[1]])
		for (const l of e.lanes) at.set(l, sidePoint(e, l, anchors));
	const pos = (l: LaneEnd) => {
		const p = at.get(l) ?? l.point;
		return (p.x - ref.frame.p.x) * ref.frame.n.x + (p.y - ref.frame.p.y) * ref.frame.n.y;
	};
	const lanes = (g: EndInfo[], keep: (l: LaneEnd) => boolean) =>
		g.flatMap((e) => e.lanes.filter(keep)).sort((x, y) => pos(x) - pos(y));
	const join = (ins: LaneEnd[], outs: LaneEnd[]) => {
		if (!ins.length || !outs.length) return;
		const { pairs, restA, restB } = pairInOrder(ins, outs, pos, pos);
		for (const [a, b] of pairs) out.push({ from: a.ref, to: b.ref });
		// A lane left over joins the nearest going its way, if that is next to
		// it (never across the road).
		const close = (x: LaneEnd, y: LaneEnd) =>
			Math.abs(pos(x) - pos(y)) <= x.right - x.left + y.right - y.left;
		for (const b of restB) {
			const a = nearest(ins, pos(b), pos);
			if (close(a, b)) out.push({ from: a.ref, to: b.ref });
		}
		for (const a of restA) {
			const b = nearest(outs, pos(a), pos);
			if (close(a, b)) out.push({ from: a.ref, to: b.ref });
		}
	};
	const [a, b] = groups;
	for (const kind of ['drive', 'bus']) {
		const travel = (flow: string) => (l: LaneEnd) =>
			isTravel(l.lane) && kindOf(l.lane) === kind && l.flow === flow;
		join(lanes(a, travel('in')), lanes(b, travel('out')));
		join(lanes(b, travel('in')), lanes(a, travel('out')));
	}
	const kinds = new Set(
		[...a, ...b].flatMap((e) => e.lanes.filter((l) => !isTravel(l.lane)).map((l) => kindOf(l.lane)))
	);
	for (const kind of kinds) {
		const keep = (l: LaneEnd) => !isTravel(l.lane) && kindOf(l.lane) === kind;
		const x = lanes(a, keep);
		const y = lanes(b, keep);
		if (!x.length || !y.length) continue;
		for (const [p, q] of pairInOrder(x, y, pos, pos).pairs) out.push({ from: p.ref, to: q.ref });
	}
	return out;
}
