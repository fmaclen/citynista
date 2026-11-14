// Setbacks: how far each road end stops short of its node, for curb corners
// or curb lines at a junction, and for the taper where two sides meet.

import { lateral, sidePoint } from '../road-model/connect';
import { NARROW } from '../road-model/defaults';
import { endsOf, laneEndOf, type RoadGeo } from '../road-model/ends';
import { TAPER, dot } from '../road-model/geometry';
import type { End, Junction, Pt } from '../road-model/model';

import type { Curve } from './segment-curve';
import type { Segment } from './segment.svelte';

export interface Arm {
	segment: Segment;
	curve: Curve;
	end: End;
	out: Pt;
	// Right normal of the segment's drawing direction at the node, and where
	// the road lies across it, offset included: its full width and its
	// roadway (kerb to kerb).
	n: Pt;
	full: { lo: number; hi: number };
	roadway: { lo: number; hi: number };
	half: number;
	// Whether the road has sidewalks or verges beyond its roadway, and
	// whether it has no car lanes at all (a footpath).
	walks: boolean;
	foot: boolean;
}

// Room past a crossing road's full width for a road's curb corners.
const CORNER_ROOM = 3;
// A narrow road without sidewalks of its own that only joins another
// (stopsOnCurb below) stops on that road's curb line (just inside it), so
// that road's sidewalk carries straight on across its mouth, as a crosswalk
// (road-model/corners.ts). A footpath stops right on a car road's curb line:
// its paving never laps over that road's asphalt.
const CURB_GAP = -0.1;
// A road with sidewalks stops this far past the mouth of a road that stops
// on its curb line: its curb turns straight into that road's edge.
const MOUTH_ROOM = 0.5;
// A road crossing another at a slant is trimmed as if it crossed no more
// steeply than this (the sine of the angle between them).
const MIN_SIN = 0.3;

// Where two sides of a node meet (its lanes find their way across), how far
// each side's lead road stops short: its side of the taper (`reach`: set by
// hand, held, or what the shifts need), never less than a little, nor less
// than a bend needs (TAPER in road-model/geometry.ts).
export function linkSetbacks(a: Arm, b: Arm, reach: number[]) {
	const d = dot(a.out, b.out);
	// A bend: both sides pull back far enough for the lanes to turn on a
	// curve (R tan(deflection / 2)).
	const deflection = Math.PI - Math.acos(Math.max(-1, Math.min(1, d)));
	const r = TAPER.BEND_RADIUS * Math.max(a.half, b.half);
	const bend = d < -TAPER.STRAIGHT ? 0 : r * Math.tan(Math.min(deflection, TAPER.SHARPEST) / 2);
	return reach.map((x) => Math.max(TAPER.THROUGH_GAP, x, bend));
}

// At a junction of three or more roads, how far each road stops short of the
// node when nothing is set by hand: far enough for curb corners or for the
// crossing roads' curb lines.
export function setbacks(arms: Arm[]) {
	const out = new Map<Arm, number>();
	// Each arm's straight-on partner: the most nearly opposite arm, if it is
	// nearly opposite.
	const partner = new Map<Arm, Arm>();
	const pairs = arms
		.flatMap((a, i) => arms.slice(i + 1).map((b) => ({ a, b, d: dot(a.out, b.out) })))
		.filter((p) => p.d < -0.9)
		.sort((x, y) => x.d - y.d);
	for (const p of pairs) {
		if (partner.has(p.a) || partner.has(p.b)) continue;
		partner.set(p.a, p.b);
		partner.set(p.b, p.a);
	}
	// A road without sidewalks that is narrow from curb to curb (medians
	// included) and that no road faces across the node stops on the other
	// roads' curb lines, and they turn straight into its edges. Any other road
	// meets a road with sidewalks with curb corners, as one with sidewalks of
	// its own does. (The drawing asks more loosely, in
	// road-model/defaults.ts, joinsOnly: any narrow road nothing faces,
	// sidewalks or not, so a narrow street ending on another gets curb corners
	// here and the road it ends on is still carried across there.)
	const stopsOnCurb = (a: Arm) =>
		!a.walks && a.roadway.hi - a.roadway.lo < NARROW && !partner.has(a);
	const cornered = (a: Arm, b: Arm) => (a.walks || b.walks) && !stopsOnCurb(a) && !stopsOnCurb(b);
	for (const arm of arms) {
		let trim = 0;
		for (const other of arms) {
			if (other === arm || partner.get(arm) === other) continue;
			const cos = dot(arm.out, other.out);
			// How the arm crosses the other road: which side of it the arm
			// leaves on, and how steeply.
			const side = dot(arm.out, other.n);
			const sin = Math.max(MIN_SIN, Math.abs(side));
			// Past the other road's far edge on the arm's side, where that road
			// actually lies, and some, for curb corners; a road with sidewalks
			// only clears the mouth of a road stopping on its curb line, and
			// any other pair of roads stop on each other's curb lines.
			const span = cornered(arm, other) ? other.full : other.roadway;
			const room = cornered(arm, other)
				? CORNER_ROOM
				: arm.walks && stopsOnCurb(other)
					? MOUTH_ROOM
					: arm.foot && !other.foot
						? 0
						: CURB_GAP;
			const edge = side >= 0 ? span.hi : -span.lo;
			const clear = Math.max(0, edge + room);
			const need = cos > 0 ? (clear + arm.half * cos) / sin : clear;
			trim = Math.max(trim, need);
		}
		out.set(arm, trim);
	}
	return out;
}

// The taper a node of two roads needs (long enough for the furthest any
// connection shifts sideways), and the shortest it may be set to. Sidewalks
// follow the roadway's taper; where only walks carry on (a footpath leaving
// a road) the furthest a walk shifts sets it, at a walker's steeper rate.
export function taperFor(junction: Junction, geos: Map<string, RoadGeo>) {
	const ends = endsOf(junction, geos);
	let shift = 0;
	let walkShift = 0;
	let roadway = false;
	for (const c of junction.connections) {
		const a = laneEndOf(ends, c.from);
		const b = laneEndOf(ends, c.to);
		if (!a || !b || a.end === b.end) continue;
		const walk = a.lane.lane.kind === 'walk';
		roadway ||= !walk;
		// Lanes of a road attached at an edge are read across the road it
		// joins (its own frame leans by the angle it joins at), at the point
		// it joins, so the taper's own trim never changes the shift.
		const attached = junction.sides?.includes(a.end.key) || junction.sides?.includes(b.end.key);
		const ref = ends.find((e) => !junction.sides?.includes(e.key)) ?? ends[0];
		const across = (p: Pt) => p.x * ref.frame.n.x + p.y * ref.frame.n.y;
		const moved = attached
			? Math.abs(
					across(sidePoint(a.end, a.lane, junction.anchors ?? {})) -
						across(sidePoint(b.end, b.lane, junction.anchors ?? {}))
				)
			: Math.abs(lateral(a.end, a.lane, true) - lateral(b.end, b.lane, false));
		if (walk) walkShift = Math.max(walkShift, moved);
		else shift = Math.max(shift, moved);
	}
	const [s, along, least] = roadway
		? [shift, TAPER.ALONG_PER_SHIFT, TAPER.LEAST_ALONG_PER_SHIFT]
		: [walkShift, TAPER.WALK_ALONG_PER_SHIFT, TAPER.LEAST_WALK_ALONG_PER_SHIFT];
	return {
		need: s < TAPER.NO_SHIFT ? 0 : Math.max(TAPER.SHORTEST, s * along),
		least: Math.max(TAPER.THROUGH_GAP * 2, s * least)
	};
}
