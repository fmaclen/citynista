// A road's approach to a node: crossing and stop sizes, how far back its
// paint stops (`approachSetback`), and what the node asks of the road's end
// (`endCut`).

import { arrowOutline, arrowWidth, type Move } from './arrows';
import type { EndCut, NodeDescription, Ring, Sign } from './description';
import type { Curve, EndInfo, LaneEnd, RoadGeo } from './ends';
import { crossSection, dot, frameAt, neg, offsetPoint, stretchOver } from './geometry';
import type { ApproachPlan } from './holds';
import { INSET } from './lines';
import { type Crossed, holdsGoing } from './overlay';
import {
	type Connection,
	type Control,
	type End,
	endKey,
	type Junction,
	laneKey,
	type Road,
	isTravel
} from './model';
import { STOP_LINE, YIELD_HEIGHT } from './paint';

export const CROSSING_DEPTH = 3;
// Where a junction's crossing sits by default: its middle this far from the
// road's end, just clear of the corners.
export const CROSSING_FROM_END = 0.5 + CROSSING_DEPTH / 2;

const STOP_GAP = 1;

// A crossing across a road counts as at its end, with the stop line behind
// it, when it starts no further back than this: far enough that it never
// sits among the turn arrows before a stop line at the end.
const CROSSING_AT_END = 12;
// The gap between a crossing at a road's end (or the road's end itself,
// where there's none) and the stop line behind it.
export const CROSSING_TO_STOP = 1;
// How far a stop line's back edge sits behind the crossing or road end in
// front of it: room enough for a median's nose to come forward past the stop
// line, so the lines along the median run straight beside its end.
export const STOP_ROOM = CROSSING_TO_STOP + STOP_GAP;

// How far back from a road's end (its `end`, a road of `length`) the crossing
// at that end reaches, or 0 when none lies there.
function crossingReach(road: Road, length: number, end: 'start' | 'end') {
	let reach = 0;
	for (const c of road.crossings ?? []) {
		const d = end === 'start' ? c.at : length - c.at;
		// Only the end it is nearer counts it: on a short road between two
		// junctions, the far end keeps its stop line where it was.
		if (d - CROSSING_DEPTH / 2 <= CROSSING_AT_END && d <= length / 2)
			reach = Math.max(reach, d + CROSSING_DEPTH / 2);
	}
	return reach;
}

// Where one of a road's own crosswalks (Road.crossings) lies: its middle
// `d` along the road (kept on it), and the lane edges it lies between (lane
// k lies between edges k and k + 1): straight across from the one walkway it
// joins to the other, over the lanes between them alone. Null where the road
// has no such walkways.
export function crosswalkOf(road: Road, length: number, c: { at: number; lanes: string[] }) {
	const d = Math.max(0, Math.min(length, c.at));
	const spans = crossSection(road, d);
	const sides = c.lanes.map((id) => spans.findIndex((sp) => sp.lane.id === id));
	if (sides.includes(-1)) return null;
	const [p, q] = [Math.min(...sides), Math.max(...sides)];
	return { d, sides, k0: p + 1, k1: q };
}

// How far back from a road end its paint stops: behind the crossing at its
// end, if there is one, and at the stop line when the approach is
// controlled (its back edge, so the lane's lines run up to it).
export function approachSetback(
	control: Control,
	road: Road,
	length: number,
	end: 'start' | 'end'
) {
	return setbackPast(control, crossingReach(road, length, end));
}

// How far back an approach's paint stops past a crossing reaching `reach`
// back from where it ends (0 for none).
export const setbackPast = (control: Control, reach: number) =>
	control !== 'none' ? reach + STOP_ROOM : reach ? reach + CROSSING_TO_STOP : 0;

// How far back along an approach a junction's paint reaches at most, with
// its crossing where it sits by default: past the crossing and its gap, the
// stop line (its back edge on the paint's setback) or the give-way teeth
// (their base half a stop gap short of it, pointing back up the road).
export const APPROACH_PAINT =
	CROSSING_FROM_END +
	CROSSING_DEPTH / 2 +
	CROSSING_TO_STOP +
	STOP_GAP / 2 +
	Math.max(STOP_GAP / 2, YIELD_HEIGHT);

// How far behind the crossing in front of it a control's line stands (its
// middle), and how far back from the crossing it reaches: a stop line's back
// edge STOP_ROOM back, the give-way teeth's base half a stop gap short of
// that, pointing YIELD_HEIGHT back up the road.
export const signBack = (control: Control) =>
	STOP_ROOM - (control === 'yield' ? STOP_GAP : STOP_LINE) / 2;
export const signRoom = (control: Control) =>
	control === 'yield' ? STOP_ROOM - STOP_GAP / 2 + YIELD_HEIGHT : STOP_ROOM;

// An arrow's tail stands this far back from where an approach's paint
// stops, and only where the approach runs on ARROW_ROOM back from there.
export const ARROW_BACK = 6;
export const ARROW_ROOM = 9;

// How far back along an approach its paint can reach from the road's end:
// past a crossing as far back as one still counts as at the end, the stop
// line behind it, and its arrows.
export const APPROACH_REACH = CROSSING_AT_END + CROSSING_DEPTH + STOP_ROOM + ARROW_ROOM;

// What a node asks of a road ending at it (`end` of the road `geo`): where
// its paint stops and its median ends. Lanes carried on across the node
// (`carried`) run on, their medians up to the outline; lines carried on alone
// (`linesOn`) meet the node's at the outline, the medians keeping their
// noses, and where a walkway of the node's is laid across its mouth
// (`crossed`, its ground there) their paint stops short of that ground
// (EndCut.clear), wherever it reaches onto the road. Otherwise the paint
// stops `setback` back, at least half a metre short of the outline, clear
// of anything painted across the node: a crossing of the road's own at its
// end, or such a walkway.
//
// Where the approach's line stands for crossings (`held`, ApproachPlan),
// the paint of the lanes it holds stops where the plan's share clears it
// (approachPlans in holds.ts), and the rest of the road's paint where it
// would with nothing laid over the node (`bare`).
export interface EndAsk {
	carried: boolean;
	linesOn: boolean;
	setback: number;
	crossed?: Ring[];
	held?: { bare: number };
}
export function endCut(
	junction: Junction,
	geo: RoadGeo,
	end: End,
	{ carried, linesOn, setback, crossed, held }: EndAsk
): EndCut {
	const { road, path } = geo;
	const own = crossingReach(road, path.length, end) > 0;
	const paint = Math.max(0.5, setback);
	// A median's nose stops half a metre behind the paint; at a stop line it
	// comes forward past it, its lines (the inset round it) stopping half a
	// metre short of the crossing or the road's end.
	const stops = (junction.control[endKey({ road: road.id, end })] ?? 'none') !== 'none';
	const nose = stops ? paint - STOP_ROOM + 0.5 + INSET : paint + 0.5;
	if (!own && (carried || linesOn))
		return {
			paint: 0,
			nose: held ? nose : carried ? 0 : 0.5,
			...(crossed?.length && { clear: crossed })
		};
	return { paint: held ? Math.max(0.5, held.bare) : paint, nose };
}

// The incoming travel lanes at a road end.
export const incomingAt = (end: EndInfo) =>
	end.lanes.filter((l) => l.flow === 'in' && isTravel(l.lane));

// How far an approach runs back along one of its pieces (as backAlong reads
// them): from the piece's end at its node back to its road's far end. And
// the gap across the node between that far end and the piece before it
// (`before`, the next one back up the approach), from one road end straight
// to the next.
const roomOn = (end: EndInfo) =>
	end.ref.end === 'end' ? end.frame.distance : end.geo.path.length - end.frame.distance;
function gapTo(end: EndInfo, before: EndInfo) {
	const start = frameAt(end.geo.path, end.ref.end === 'end' ? 0 : end.geo.path.length).p;
	return Math.hypot(start.x - before.frame.p.x, start.y - before.frame.p.y);
}

// The point `back` metres back from the end of the last of `pieces`, along
// an approach as a whole: its own road up to its end, then each road merged
// away it goes on through, each up to its far end (Junction.signsAt). The
// nodes between them count from one road end straight to the next, and a
// point that falls inside one lands at the end of the road behind it. With
// the frame there, the lanes coming in at that road's end (whose offsets
// read across the frame) and the way traffic heads; null where the approach
// is shorter than that, unless `clamp`, which keeps it on the last road.
export function backAlong(pieces: EndInfo[], back: number, clamp = false) {
	let left = back;
	for (let i = pieces.length - 1; i >= 0; i--) {
		const end = pieces[i];
		const { path } = end.geo;
		const toEnd = end.ref.end === 'end';
		const room = roomOn(end);
		if (left <= room || clamp) {
			const f = frameAt(path, toEnd ? end.frame.distance - left : end.frame.distance + left);
			return { frame: f, lanes: incomingAt(end), ahead: toEnd ? f.t : neg(f.t) };
		}
		const before = pieces[i - 1];
		if (!before) return null;
		left = Math.max(0, left - room - gapTo(end, before));
	}
	return null;
}

// The stretches of an approach as a whole (`pieces`, as backAlong reads
// them) that the ground crossed by a network laid over it lies on (`over`,
// overlay.ts) across the lanes its traffic drives in, as distances back from
// its last piece's end, nearest first, with the control each crossing has
// and the lanes coming in it holds (`lanes`, by their place among the lanes
// coming in at a road end, as each piece lists them alike).
export function crossingsBack(pieces: EndInfo[], over: Crossed[]) {
	const out: { c: Crossed; near: number; far: number; control: Control; lanes: number[] }[] = [];
	let behind = 0;
	for (let i = pieces.length - 1; i >= 0; i--) {
		const end = pieces[i];
		const { road, path } = end.geo;
		const toEnd = end.ref.end === 'end';
		const room = roomOn(end);
		for (const c of over)
			for (const ring of c.rings) {
				// The lanes this approach's traffic drives in that the crossing
				// holds (holdsLane): one over the other carriageway holds none.
				const driven = holdsGoing(c, road.id, toEnd ? 'fwd' : 'back');
				const on = stretchOver(road, path, ring, driven);
				if (!on) continue;
				const back = (s: number) =>
					behind + (toEnd ? end.frame.distance - s : s - end.frame.distance);
				const [a, b] = [back(on.from), back(on.to)].sort((x, y) => x - y);
				if (b > behind && a < behind + room)
					out.push({
						c,
						near: a,
						far: b,
						control: c.control?.kind ?? 'none',
						lanes: incomingAt(end).flatMap((l, k) => (driven(l.lane) ? [k] : []))
					});
			}
		const before = pieces[i - 1];
		if (!before) break;
		behind += room + gapTo(end, before);
	}
	return out.sort((x, y) => x.near - y.near);
}

// Where an approach's control badge sits: 6 m back from its road's end,
// 2 m beside the lanes coming in there (`incoming`, one at least).
function badgeOf(end: EndInfo, incoming: LaneEnd[]) {
	const lo = Math.min(...incoming.map((l) => l.left));
	const hi = Math.max(...incoming.map((l) => l.right));
	const back = end.ref.end === 'start' ? end.frame.distance + 6 : end.frame.distance - 6;
	const f = frameAt(end.geo.path, back);
	return offsetPoint(f.p, f.n, (lo + hi) / 2 > 0 ? hi + 2 : lo - 2);
}

// Each approach of a junction where roads meet (roadsMeeting in node.ts),
// given its connections (`resolved`) and what it does with the crossings
// laid over its roads and its ground (`plans`, approachPlans in holds.ts):
// its badge, its stop lines or give-way teeth where its plan stands them
// (ApproachPlan.rows), and its arrows, where the plan puts their tails.
export function approachesOf(
	junction: Junction,
	ends: EndInfo[],
	resolved: { c: Connection; toEnd: EndInfo; fromEnd: EndInfo; curve: Curve }[],
	plans: Map<string, ApproachPlan>
) {
	// Stop and yield lines across each controlled approach, arrows, badges.
	const signs: Sign[] = [];
	const approaches: NodeDescription['approaches'] = [];
	for (const end of ends) {
		const incoming = incomingAt(end);
		if (incoming.length === 0) continue;
		const plan = plans.get(end.key)!;
		const approach = {
			end: end.key,
			control: junction.control[end.key] ?? 'none',
			badge: badgeOf(end, incoming),
			arrows: 0
		};
		approaches.push(approach);
		// What each lane may do: through, left, right or a U-turn. A U-turn
		// is a path back into its own road; a sharp turn onto another road
		// is still a left or right, however tight.
		const movesOf = new Map(
			incoming.map((l) => {
				const moves = new Set<Move>();
				for (const r of resolved) {
					if (laneKey(r.c.from) !== laneKey(l.ref)) continue;
					const dIn = neg(end.frame.out);
					const dOut = r.toEnd.frame.out;
					const ahead = dot(dIn, dOut);
					const turn = dIn.x * dOut.y - dIn.y * dOut.x;
					moves.add(r.toEnd === end ? 'u' : ahead > 0.7 ? 'through' : turn > 0 ? 'right' : 'left');
				}
				return [l, moves];
			})
		);
		// Arrows where traffic stops, and on any approach with a lane that
		// can't go straight on (a turn lane) even where it doesn't.
		const turnLane = [...movesOf.values()].some((m) => m.size > 0 && !m.has('through'));
		if (plan.control === 'none' && !turnLane) continue;
		approach.arrows = incoming.filter((l) => movesOf.get(l)!.size > 0).length;
		// Its lines, where its plan stands them (ApproachPlan.rows).
		signs.push(...plan.rows);
		// Each arrow's tail stands where the plan puts it, on the approach as
		// a whole, wherever the nodes on it cut it, where there is ARROW_ROOM
		// of it behind that.
		const { whole } = plan;
		const fa = backAlong(whole.pieces, plan.tail);
		const arrowed = backAlong(whole.pieces, plan.tail + ARROW_ROOM - ARROW_BACK)
			? incoming.filter((l) => movesOf.get(l)!.size > 0)
			: [];
		// Every arrow on an approach is drawn at one size: full size unless one
		// of them is wider than its lane allows.
		const scale = Math.min(
			1,
			...arrowed.map((l) => (l.right - l.left - 0.5) / arrowWidth(arrowOutline(movesOf.get(l)!)))
		);
		// All of an approach's arrows start and end level (see `arrows.ts`),
		// pointing along the lane where they sit (the road may curve), each over
		// its lane there (taken in order).
		const laneAt = (l: LaneEnd) => fa!.lanes[incoming.indexOf(l)] ?? l;
		for (const l of arrowed)
			signs.push({
				kind: 'arrow',
				lane: l.ref,
				at: offsetPoint(fa!.frame.p, fa!.frame.n, (laneAt(l).left + laneAt(l).right) / 2),
				dir: fa!.ahead,
				moves: [...movesOf.get(l)!],
				scale
			});
	}
	return { signs, approaches };
}
