// A road's approach to a node: crossing and stop sizes, how far back its
// paint stops (`approachSetback`), and what the node asks of the road's end
// (`endCut`).

import { arrowOutline, arrowWidth, type Move } from './arrows';
import type { EndCut, NodeDescription, Sign } from './description';
import type { EndInfo, RoadGeo } from './ends';
import { dot, frameAt, neg, offsetPoint } from './geometry';
import { INSET } from './lines';
import {
	type Connection,
	type End,
	endKey,
	type Junction,
	laneKey,
	type Road,
	isRoadway,
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
const CROSSING_TO_STOP = 1;
// How far a stop line's back edge sits behind the crossing or road end in
// front of it: room enough for a median's nose to come forward past the stop
// line, so the lines along the median run straight beside its end.
const STOP_ROOM = CROSSING_TO_STOP + STOP_GAP;

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

// How far back from a road end its paint stops: behind the crossing at its
// end, if there is one, and at the stop line when the approach is
// controlled (its back edge, so the lane's lines run up to it).
function approachSetback(junction: Junction, road: Road, length: number, end: 'start' | 'end') {
	const reach = crossingReach(road, length, end);
	const controlled = (junction.control[endKey({ road: road.id, end })] ?? 'none') !== 'none';
	if (controlled) return reach + STOP_ROOM;
	return reach ? reach + CROSSING_TO_STOP : 0;
}

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

// What a node asks of a road ending at it (`end` of the road `geo`): where
// its paint stops and its median ends. Lanes carried on across the node
// (`carried`) run on, their medians up to the outline; lines carried on alone
// (`linesOn`) meet the node's at the outline, the medians keeping their
// noses. Otherwise the paint stops `setback` back, at least half a metre
// short of the outline, clear of anything painted across the node; a
// walk-only road's paint stops short of the sidewalk it meets.
export function endCut(
	junction: Junction,
	geo: RoadGeo,
	end: End,
	{ carried, linesOn, setback }: { carried: boolean; linesOn: boolean; setback: number }
): EndCut {
	const { road, path } = geo;
	const crossing = crossingReach(road, path.length, end) > 0;
	if (!crossing && carried) return { paint: 0, nose: 0 };
	if (!crossing && linesOn) return { paint: 0, nose: 0.5 };
	const paint = road.lanes.some(isRoadway) ? Math.max(0.5, setback) : 2;
	// A median's nose stops half a metre behind the paint; at a stop line it
	// comes forward past it, its lines (the inset round it) stopping half a
	// metre short of the crossing or the road's end.
	const stops = (junction.control[endKey({ road: road.id, end })] ?? 'none') !== 'none';
	return { paint, nose: stops ? paint - STOP_ROOM + 0.5 + INSET : paint + 0.5 };
}

// Each approach of a junction where roads meet (roadsMeeting in node.ts),
// given its connections (`resolved`) and how deep a walkway lies across each
// road's mouth (`crossDepth`): its badge, its stop line or give-way teeth,
// its arrows, and how far back its road's paint stops (`setbackOf`).
export function approachesOf(
	junction: Junction,
	ends: EndInfo[],
	resolved: { c: Connection; toEnd: EndInfo }[],
	crossDepth: Map<string, number>
) {
	// How far back each road's paint stops: past a crossing laid across its
	// mouth, too.
	const setbackOf = (end: EndInfo) => {
		const depth = crossDepth.get(end.key);
		const { road, path } = end.geo;
		return approachSetback(junction, road, path.length, end.ref.end) + (depth ? depth + 0.3 : 0);
	};
	// Stop and yield lines across each controlled approach, arrows, badges.
	const signs: Sign[] = [];
	const approaches: NodeDescription['approaches'] = [];
	for (const end of ends) {
		const incoming = end.lanes.filter((l) => l.flow === 'in' && isTravel(l.lane));
		if (incoming.length === 0) continue;
		const control = junction.control[end.key] ?? 'none';
		const setback = setbackOf(end);
		// Distances back from the road end.
		const at = (back: number) =>
			frameAt(
				end.geo.path,
				end.ref.end === 'start' ? end.frame.distance + back : end.frame.distance - back
			);
		const lo = Math.min(...incoming.map((l) => l.left));
		const hi = Math.max(...incoming.map((l) => l.right));
		const fb = at(6);
		approaches.push({
			end: end.key,
			control,
			badge: offsetPoint(fb.p, fb.n, (lo + hi) / 2 > 0 ? hi + 2 : lo - 2)
		});
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
		if (control === 'none' && !turnLane) continue;
		// One bar (or one row of give-way teeth, pointing back up the road)
		// across the incoming lanes. The stop line's back edge is where the
		// road's paint stops, so the lines either side run into its ends; the
		// teeth sit half a stop gap short of it.
		if (control !== 'none') {
			const f = at(setback - (control === 'yield' ? STOP_GAP : STOP_LINE) / 2);
			const a = offsetPoint(f.p, f.n, lo + 0.15);
			const b = offsetPoint(f.p, f.n, hi - 0.15);
			const lanes = incoming.map((l) => l.ref);
			signs.push(
				control === 'yield'
					? { kind: 'yield', lanes, a, b, toward: end.frame.out }
					: { kind: 'stop', lanes, a, b }
			);
		}
		const arrowed = incoming.filter(
			(l) =>
				movesOf.get(l)!.size > 0 &&
				setback + 9 <=
					end.frame.distance +
						(end.ref.end === 'start' ? end.geo.path.length - 2 * end.frame.distance : 0)
		);
		// Every arrow on an approach is drawn at one size: full size unless one
		// of them is wider than its lane allows.
		const scale = Math.min(
			1,
			...arrowed.map((l) => (l.right - l.left - 0.5) / arrowWidth(arrowOutline(movesOf.get(l)!)))
		);
		// Each arrow's tail is 6 m back from where the paint stops, so all of an
		// approach's arrows start and end level (see `arrows.ts`), pointing
		// along the lane where it sits (the road may curve).
		const fa = at(setback + 6);
		for (const l of arrowed)
			signs.push({
				kind: 'arrow',
				lane: l.ref,
				at: offsetPoint(fa.p, fa.n, (l.left + l.right) / 2),
				dir: end.ref.end === 'end' ? fa.t : neg(fa.t),
				moves: [...movesOf.get(l)!],
				scale
			});
	}
	return { signs, approaches, setbackOf };
}
