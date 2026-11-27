// Close junctions merge. A road between two junctions that is shorter than
// MERGE_GAP, or whose junctions come within MERGE_GAP of touching, is too
// short to exist: its two junctions draw as one, with the road's lanes chained
// through, and the road itself isn't drawn. Pulled apart, they are two again.
// Nothing is stored; the stored junctions stay as they are.
//
// Merging changes how the nodes are drawn, never what they hold: the merged
// junction's curb outline is its nodes' own outlines joined along the curbs
// of the roads merged away (`parts`, joinedOutline in outline.ts), so its
// paving is what they paved apart; each approach keeps its control; and
// nodes of two sides merged only with each other stay a node of two sides,
// so they don't merge where that would leave them more than two.

import { intersect, offset, toPath, union } from './clip';
import { continuingPairs, defaultWalkways, sameLanes } from './defaults';
import { type EndInfo, endsOf, type RoadGeo } from './ends';
import { outlineOf } from './outline';
import {
	type Connection,
	type Control,
	type EndRef,
	endKey,
	farEnd,
	type Junction,
	laneKey,
	type Road,
	isTravel
} from './model';

const MERGE_GAP = 2.5;
// Metres: a road this long or longer never has its junctions tested for
// touching, however wide they are, so no test of it is kept (MergeMemo).
export const TOUCH_REACH = 30;

// A node whose lanes find their way across it from one side to the other
// (linkSides in ends.ts).
const twoSided = (j: Junction) => j.ends.length === 2 || !!j.link;

// A road's touching test, kept while its two junctions stay the same and
// the road is shorter than TOUCH_REACH.
export type MergeMemo = (road: string, a: Junction, b: Junction, test: () => boolean) => boolean;

// Whether the road `road` between junctions `a` and `b` is too short to
// exist (the rule at the top of this file), its junctions' outlines read
// through `outlines` (kept for one build, by junction id). Every reader of
// whether two junctions may merge asks this.
export function tooShort(
	road: string,
	a: Junction,
	b: Junction,
	geos: Map<string, RoadGeo>,
	memo: MergeMemo,
	outlines: Map<string, ReturnType<typeof union>>
) {
	const outline = (j: Junction) => {
		let o = outlines.get(j.id);
		if (!o) {
			o = union(outlineOf(endsOf(j, geos)).rings.map(toPath));
			outlines.set(j.id, o);
		}
		return o;
	};
	const length = geos.get(road)?.path.length ?? Infinity;
	const touching =
		length < TOUCH_REACH &&
		memo(
			road,
			a,
			b,
			() =>
				intersect(offset(outline(a), MERGE_GAP / 2), offset(outline(b), MERGE_GAP / 2)).length > 0
		);
	return length < MERGE_GAP || touching;
}

// Each junction as drawn lists the nodes it covers (`members`). `memo` keeps
// a road's touching test while its two junctions stay the same. Junctions
// merge only along roads tooShort finds, so a set of junctions joined by
// such roads and by none to any other junction (with those roads, in the
// same order) merges as it does among all of them.
export function effectiveJunctions(
	roads: Road[],
	junctions: Junction[],
	geos: Map<string, RoadGeo>,
	memo: MergeMemo,
	outlines = new Map<string, ReturnType<typeof union>>()
) {
	const parent = new Map<string, string>(junctions.map((j) => [j.id, j.id]));
	const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
	// The junctions drawn as one so far, by the id their group goes by.
	const groupOf = new Map(junctions.map((j) => [j.id, [j]]));
	const owners = new Map<string, Junction>();
	for (const j of junctions) for (const e of j.ends) owners.set(endKey(e), j);
	const owner = (road: string, end: 'start' | 'end') => owners.get(`${road}:${end}`);
	const hidden = new Set<string>();
	for (const road of roads) {
		const a = owner(road.id, 'start');
		const b = owner(road.id, 'end');
		if (!a || !b || a === b) continue;
		if (!tooShort(road.id, a, b, geos, memo, outlines)) continue;
		// Nodes of two sides carry their lanes on across the road between them:
		// merged only with each other, they stay a node of two sides, or they
		// stay apart.
		const [ra, rb] = [find(a.id), find(b.id)];
		const group = ra === rb ? groupOf.get(ra)! : [...groupOf.get(ra)!, ...groupOf.get(rb)!];
		const gone = (id: string) => id === road.id || hidden.has(id);
		if (group.every(twoSided) && !linkOf(group, gone)) continue;
		hidden.add(road.id);
		if (ra === rb) continue;
		parent.set(ra, rb);
		groupOf.set(rb, group);
		groupOf.delete(ra);
	}
	const groups = new Map<string, Junction[]>();
	for (const j of junctions) {
		const root = find(j.id);
		groups.set(root, [...(groups.get(root) ?? []), j]);
	}
	const out: (Junction & { members: string[] })[] = [];
	for (const members of groups.values()) {
		const ids = members.map((m) => m.id);
		out.push({
			...(members.length === 1 ? members[0] : merged(members, hidden, geos, owners)),
			members: ids
		});
	}
	return { junctions: out, hidden };
}

// The two sides of nodes of two sides merged into one: the sides of theirs
// that keep a road, where every other side holds only roads merged away and
// two are left. Null where they don't.
function linkOf(
	members: Junction[],
	hidden: (road: string) => boolean
): [string[], string[]] | null {
	const sides = members.flatMap((j) => j.link ?? j.ends.map((e) => [endKey(e)] as string[]));
	const kept = (key: string) => !hidden(key.slice(0, key.lastIndexOf(':')));
	const outer = sides.filter((side) => side.some(kept));
	if (outer.length !== 2 || outer.some((side) => !side.every(kept))) return null;
	return [outer[0], outer[1]];
}

function merged(
	members: Junction[],
	hidden: Set<string>,
	geos: Map<string, RoadGeo>,
	owners: Map<string, Junction>
): Junction {
	const ends = members.flatMap((j) => j.ends).filter((e) => !hidden.has(e.road));
	const all = members.flatMap((j) => j.connections);
	const kept = all.filter((c) => !hidden.has(c.from.road) && !hidden.has(c.to.road));
	// A connection into a hidden road chains on to whatever leaves the same
	// lane at its other end, by way of each lane it enters (`via`), through as
	// many hidden roads as it takes and along every way on where a lane
	// branches, each lane entered once (the first way found is the fewest
	// roads). A connection has a direction only for traffic: any other (a
	// sidewalk's) is followed either way, wherever it was stored from.
	const travel = (r: EndRef & { lane: string }) => {
		const lane = geos.get(r.road)?.road.lanes.find((l) => l.id === r.lane);
		return !!lane && isTravel(lane);
	};
	const ways = all.flatMap((d) => (travel(d.from) ? [d] : [d, { from: d.to, to: d.from }]));
	const chained: Connection[] = [];
	for (const c of ways) {
		if (hidden.has(c.from.road) || !hidden.has(c.to.road)) continue;
		const seen = new Set([laneKey(c.to)]);
		const queue = [{ via: [c.to], at: { ...farEnd(c.to), lane: c.to.lane } }];
		for (const { via, at } of queue) {
			// One into the same lane from the far side carries on as well,
			// turned round, where it leaves into a road kept.
			const next = ways
				.filter((d) => d !== c)
				.flatMap((d) =>
					laneKey(d.from) === laneKey(at)
						? [d]
						: laneKey(d.to) === laneKey(at) && !hidden.has(d.from.road)
							? [{ from: d.to, to: d.from }]
							: []
				);
			for (const d of next) {
				if (!hidden.has(d.to.road)) {
					if (laneKey(d.to) !== laneKey(c.from))
						chained.push({ from: c.from, to: d.to, via: [...via] });
				} else if (!seen.has(laneKey(d.to))) {
					seen.add(laneKey(d.to));
					queue.push({ via: [...via, d.to], at: { ...farEnd(d.to), lane: d.to.lane } });
				}
			}
		}
	}
	// A sidewalk carried across from both sides is one connection.
	const seen = new Set<string>();
	const unique = chained.filter((c) => {
		const key = [laneKey(c.from), laneKey(c.to)].sort().join('|');
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const connections = [...kept, ...unique];
	// Each approach keeps its control. One that goes on at its own node (a
	// node of two sides controls nothing) into a road merged away is
	// controlled where that road ends, at the next node, as it was apart,
	// and its signs stand there (`signsAt`): `via` is the far end of each
	// road merged away it goes on through, the last where they stand.
	const controlOf = (key: string, guard = 0): { control?: Control; via: string[] } => {
		const j = owners.get(key)!;
		const own = j.control[key];
		if ((own ?? 'none') !== 'none' || guard > members.length) return { control: own, via: [] };
		const into = j.connections.find(
			(c) => endKey(c.from) === key && c.to.road !== c.from.road && hidden.has(c.to.road)
		);
		const far = into && endKey(farEnd(into.to));
		const next = far && controlOf(far, guard + 1);
		return next && (next.control ?? 'none') !== 'none'
			? { control: next.control, via: [far, ...next.via] }
			: { control: own, via: [] };
	};
	const control: Record<string, Control> = {};
	const signsAt: Record<string, string[]> = {};
	for (const e of ends) {
		const key = endKey(e);
		if (!(key in owners.get(key)!.control)) continue;
		const c = controlOf(key);
		if (c.control) control[key] = c.control;
		if (c.via.length) signsAt[key] = c.via;
	}
	const link = members.every(twoSided) ? linkOf(members, (r) => hidden.has(r)) : null;
	const runs = runsThrough(members, hidden, geos);
	// The nodes' outlines are joined along the curbs of the roads merged away
	// between them.
	const j: Junction = {
		id: members.map((m) => m.id).join('+'),
		ends,
		connections,
		walkways: [],
		control,
		...(Object.keys(signsAt).length ? { signsAt } : {}),
		...(runs.length ? { runs } : {}),
		...(link ? { link } : {}),
		parts: members.map((m) => m.ends)
	};
	j.walkways = link ? [] : defaultWalkways(endsOf(j, geos));
	return j;
}

// Roads that carry on through nodes merged into one by way of roads merged
// away between them, with the same lanes all along: at each node a road
// carries on into the one it is paired with there (continuingPairs in
// defaults.ts), and a run ends where that is a road kept. Its priority is
// whether it had it at every node.
function runsThrough(members: Junction[], hidden: Set<string>, geos: Map<string, RoadGeo>) {
	const partner = new Map<string, { to: EndInfo; priority: boolean }>();
	for (const m of members)
		for (const { pair, priority } of continuingPairs(endsOf(m, geos), m.connections)) {
			if (!sameLanes(pair[0], pair[1])) continue;
			partner.set(pair[0].key, { to: pair[1], priority });
			partner.set(pair[1].key, { to: pair[0], priority });
		}
	const runs: NonNullable<Junction['runs']> = [];
	const done = new Set<string>();
	for (const m of members)
		for (const ref of m.ends) {
			const from = endKey(ref);
			if (hidden.has(ref.road) || done.has(from)) continue;
			const via: EndRef[] = [];
			let priority = true;
			for (let next = partner.get(from); next && via.length <= members.length; ) {
				priority &&= next.priority;
				if (!hidden.has(next.to.ref.road)) {
					if (via.length) runs.push({ ends: [from, next.to.key], via, priority });
					done.add(next.to.key);
					break;
				}
				via.push(next.to.ref);
				next = partner.get(endKey(farEnd(next.to.ref)));
			}
		}
	return runs;
}
