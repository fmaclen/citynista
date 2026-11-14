// What a node has before the user's edits there (`defaults`), worked out on
// every build: its connections, its walkways and crossings, and its approach
// controls.

import { facingOf } from './carry';
import { defaultConnections, defaultControl, sideConnections } from './connect';
import {
	angleOf,
	centreOf,
	type EndInfo,
	endsOf,
	type LaneEnd,
	linkSides,
	type RoadGeo
} from './ends';
import { crosses, dist, dot, offsetPoint } from './geometry';
import {
	type Connection,
	type Control,
	type Junction,
	type Pt,
	type Walkway,
	isRoadway,
	isTravel,
	isWalk
} from './model';

// Road ends running straight on into each other, and whether another such
// pair crosses them.
function straightPairs(ends: EndInfo[]) {
	const pairs: [EndInfo, EndInfo][] = [];
	for (let i = 0; i < ends.length; i++) {
		for (let j = i + 1; j < ends.length; j++) {
			if (dot(ends[i].frame.out, ends[j].frame.out) < Math.cos((155 * Math.PI) / 180)) {
				pairs.push([ends[i], ends[j]]);
			}
		}
	}
	const crossed = (pair: [EndInfo, EndInfo]) =>
		pairs.some(
			(other) =>
				other !== pair &&
				!other.includes(pair[0]) &&
				!other.includes(pair[1]) &&
				crosses(
					offsetPoint(pair[0].frame.p, pair[0].frame.out, 30),
					offsetPoint(pair[1].frame.p, pair[1].frame.out, 30),
					offsetPoint(other[0].frame.p, other[0].frame.out, 30),
					offsetPoint(other[1].frame.p, other[1].frame.out, 30)
				)
		);
	return pairs.map((pair) => ({ pair, crossed: crossed(pair) }));
}

// Whether one road end carries on into the other with the same lanes: the
// other's lanes mirrored, with in and out swapped.
export function sameLanes(a: EndInfo, b: EndInfo) {
	const outward = (e: EndInfo) => {
		const lanes = e.ref.end === 'start' ? e.lanes : [...e.lanes].reverse();
		return lanes.map((l) => ({
			kind: l.lane.kind,
			flow: l.flow,
			width: Math.round((l.right - l.left) * 10)
		}));
	};
	const swap = (f: LaneEnd['flow']) => (f === 'in' ? 'out' : f === 'out' ? 'in' : f);
	const la = outward(a);
	const lb = outward(b).reverse();
	return (
		la.length === lb.length &&
		la.every(
			(l, i) => l.kind === lb[i].kind && l.width === lb[i].width && l.flow === swap(lb[i].flow)
		)
	);
}

// Pairs of road ends that traffic drives straight on between (they face each
// other and connections join them), whether another such pair crosses them,
// and which of a crossing set carries the most travel lanes. A road carrying
// on has priority over roads that only join it; where two carry-on roads
// cross, the one with more lanes wins, and a tie has no priority at all.
export function continuingPairs(ends: EndInfo[], connections: Connection[]) {
	const linked = (a: EndInfo, b: EndInfo) =>
		connections.some(
			(c) =>
				(c.from.road === a.ref.road &&
					c.from.end === a.ref.end &&
					c.to.road === b.ref.road &&
					c.to.end === b.ref.end) ||
				(c.from.road === b.ref.road &&
					c.from.end === b.ref.end &&
					c.to.road === a.ref.road &&
					c.to.end === a.ref.end)
		);
	// Each end carries on into at most one other: a road continuing with the
	// same lanes first, then the most nearly straight.
	const candidates: { pair: [EndInfo, EndInfo]; score: number }[] = [];
	for (let i = 0; i < ends.length; i++) {
		for (let j = i + 1; j < ends.length; j++) {
			const d = dot(ends[i].frame.out, ends[j].frame.out);
			if (d < -0.2 && linked(ends[i], ends[j])) {
				candidates.push({
					pair: [ends[i], ends[j]],
					score: d - (sameLanes(ends[i], ends[j]) ? 2 : 0)
				});
			}
		}
	}
	const used = new Set<EndInfo>();
	const pairs: [EndInfo, EndInfo][] = [];
	for (const { pair } of candidates.sort((a, b) => a.score - b.score)) {
		if (used.has(pair[0]) || used.has(pair[1])) continue;
		used.add(pair[0]);
		used.add(pair[1]);
		pairs.push(pair);
	}
	const far = (e: EndInfo) => offsetPoint(e.frame.p, e.frame.out, 30);
	const weight = (pair: [EndInfo, EndInfo]) =>
		pair.reduce((n, e) => n + e.lanes.filter((l) => isTravel(l.lane)).length, 0);
	return pairs.map((pair) => {
		const crossing = pairs.filter(
			(o) =>
				o !== pair &&
				!o.includes(pair[0]) &&
				!o.includes(pair[1]) &&
				crosses(far(pair[0]), far(pair[1]), far(o[0]), far(o[1]))
		);
		return {
			pair,
			crossed: crossing.length > 0,
			priority: crossing.every((o) => weight(o) < weight(pair))
		};
	});
}

// Which side of a road end's roadway a walk lane lies beyond (1 along the
// normal, -1 against it, 0 where there's no roadway); null when it isn't
// outside the roadway.
function curbSide(end: EndInfo, walk: LaneEnd) {
	const roadway = end.lanes.filter((l) => isRoadway(l.lane));
	if (roadway.length === 0) return 0;
	if (walk.left >= Math.max(...roadway.map((l) => l.right)) - 0.01) return 1;
	if (walk.right <= Math.min(...roadway.map((l) => l.left)) + 0.01) return -1;
	return null;
}

// The outermost walk lane on the side of a road end that faces the next end
// going round the junction one way (`ascending` angle) or the other.
function walkOnSide(end: EndInfo, centre: Pt, ascending: boolean) {
	const lanes = end.lanes;
	if (!lanes.length) return null;
	const rel = (p: Pt) => {
		let d = Math.atan2(p.y - centre.y, p.x - centre.x) - angleOf(end, centre);
		while (d > Math.PI) d -= 2 * Math.PI;
		while (d <= -Math.PI) d += 2 * Math.PI;
		return d;
	};
	const left = offsetPoint(end.frame.p, end.frame.n, lanes[0].left);
	const right = offsetPoint(end.frame.p, end.frame.n, lanes[lanes.length - 1].right);
	const rightIsAscending = rel(right) > rel(left);
	const wantRight = rightIsAscending === ascending;
	const walks = lanes.filter((l) => isWalk(l.lane));
	if (!walks.length) return null;
	if (lanes.every((l) => isWalk(l.lane))) return walks[Math.floor(walks.length / 2)];
	const walk = wantRight ? walks[walks.length - 1] : walks[0];
	const side = curbSide(end, walk);
	return side === 0 || side === (wantRight ? 1 : -1) ? walk : null;
}

// Two walk-only road ends face each other when each heads into the node
// within 25° of the line to the other.
const FACING = Math.cos((25 * Math.PI) / 180);

// The sidewalks round a junction. Where one runs across the mouth of a road
// with no sidewalk of its own it carries on as a crosswalk, whatever the road.
export function defaultWalkways(ends: EndInfo[]): Walkway[] {
	const walkways: Walkway[] = [];
	const centre = centreOf(ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane))));
	const pairs = straightPairs(ends);
	// Along the edge: between neighbouring ends that both have walk lanes,
	// skipping ends that have none (their mouth is crossed on the way).
	// Only ends with a roadway have a curb on the outline; a walk-only road
	// (a footpath) meets the junction where it ends.
	const kerbed = ends.filter((e) => e.lanes.some((l) => isRoadway(l.lane)));
	const walking = kerbed
		.filter((e) => e.lanes.some((l) => isWalk(l.lane)))
		.sort((a, b) => angleOf(a, centre) - angleOf(b, centre));
	if (walking.length >= 2) {
		for (let i = 0; i < walking.length; i++) {
			const a = walking[i];
			const b = walking[(i + 1) % walking.length];
			if (a === b) continue;
			const wa = walkOnSide(a, centre, true);
			const wb = walkOnSide(b, centre, false);
			if (!wa || !wb) continue;
			walkways.push({ id: `${a.key}~${b.key}`, a: wa.ref, b: wb.ref });
		}
	}
	// Walk-only roads that run on into each other cross between: two that
	// face each other across the node, as a path drawn on a curve through it
	// does, or that run straight on.
	const only = (e: EndInfo) => e.lanes.length > 0 && e.lanes.every((l) => isWalk(l.lane));
	const walks = ends.filter(only);
	const facing = (a: EndInfo, b: EndInfo) => {
		const l = dist(a.frame.p, b.frame.p) || 1;
		const t = { x: (b.frame.p.x - a.frame.p.x) / l, y: (b.frame.p.y - a.frame.p.y) / l };
		return -dot(a.frame.out, t) > FACING && dot(b.frame.out, t) > FACING;
	};
	const inLine = (a: EndInfo, b: EndInfo) =>
		pairs.some(({ pair }) => pair.includes(a) && pair.includes(b));
	for (const [i, a] of walks.entries())
		for (const b of walks.slice(i + 1)) {
			if (!inLine(a, b) && !facing(a, b)) continue;
			const la = a.lanes[Math.floor(a.lanes.length / 2)];
			const lb = b.lanes[Math.floor(b.lanes.length / 2)];
			walkways.push({ id: `${a.key}=${b.key}`, a: la.ref, b: lb.ref });
		}
	return walkways;
}

// A road no longer than this between two junctions is a link inside one
// signalled group: nobody crosses it, they cross the roads beyond.
export const SHORT_LINK = 20;

interface DefaultCrossing {
	end: EndInfo;
	// The outermost sidewalks either side of the roadway, by lane id.
	lanes: [string, string];
	on: boolean;
}

// The default crossings at a junction of three or more roads: one across
// every road end with sidewalks on both sides of its roadway. It is on where
// that end's traffic is controlled (stop, yield or signal) and across every
// road that isn't the through road; off across a through road nobody stops
// on, and across a short link between two junctions (`shortLink`).
export function defaultCrossings(
	junction: Junction,
	ends: EndInfo[],
	shortLink: (road: string) => boolean
): DefaultCrossing[] {
	if (ends.length < 3 || junction.sides?.length) return [];
	const through = new Set<string>();
	for (const { pair, priority } of continuingPairs(ends, junction.connections))
		if (priority) for (const e of pair) through.add(e.key);
	const out: DefaultCrossing[] = [];
	for (const end of ends) {
		const walks = end.lanes.filter((l) => isWalk(l.lane));
		const roadway = end.lanes.filter((l) => isRoadway(l.lane));
		if (walks.length < 2 || roadway.length === 0) continue;
		const a = walks[0];
		const b = walks[walks.length - 1];
		if (
			a.right > Math.min(...roadway.map((l) => l.left)) ||
			b.left < Math.max(...roadway.map((l) => l.right))
		)
			continue;
		const controlled = (junction.control[end.key] ?? 'none') !== 'none';
		const on = !shortLink(end.ref.road) && (controlled || !through.has(end.key));
		out.push({ end, lanes: [a.ref.lane, b.ref.lane], on });
	}
	return out;
}

export function defaults(junction: Junction, roads: Map<string, RoadGeo>) {
	const ends = endsOf(junction, roads);
	// Where one road meets just one other, sidewalks connect like any other
	// lane: no corners, no crosswalks.
	const sides = linkSides(junction, ends);
	const link = !!sides;
	const connections =
		sides && ends.length > 2 ? sideConnections(sides, junction.anchors) : defaultConnections(ends);
	// The roads that carry on through the node, by the connections.
	const through = new Set<string>();
	for (const { pair, priority } of continuingPairs(ends, connections))
		if (priority) for (const e of pair) through.add(e.key);
	return {
		connections,
		walkways: link ? [] : defaultWalkways(ends),
		control: link
			? Object.fromEntries(
					ends
						.filter((e) => e.lanes.some((l) => isTravel(l.lane) && l.flow === 'in'))
						.map((e) => [e.key, 'none' as Control])
				)
			: defaultControl(ends, through, connections)
	};
}

// A road end narrower than this from curb to curb can be a side road that
// only joins the roads it meets (see joinsOnly).
export const NARROW = 8;

// Whether a road end only joins the roads it meets: it is narrow from curb
// to curb (medians included), and none of its lanes carry straight on across
// the junction into a road that carries straight back into it. A road that
// nothing but such roads join is carried across the junction past them
// (roadsMeeting in node.ts). Any other road is a road of its own, however
// few its lanes: what it meets is not carried over it. A sidewalk crosses
// either kind the same way, with a crosswalk.
export function joinsOnly(e: EndInfo, ends: EndInfo[], connections: Connection[]) {
	const roadway = e.lanes.filter((l) => isRoadway(l.lane));
	if (!roadway.length) return true;
	const span = Math.max(...roadway.map((l) => l.right)) - Math.min(...roadway.map((l) => l.left));
	if (span >= NARROW) return false;
	return !facingOf(e, ends, connections).some((f) => facingOf(f, ends, connections).includes(e));
}
