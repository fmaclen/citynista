// Close junctions merge. A road between two junctions that is shorter than
// MERGE_GAP, or whose junctions come within MERGE_GAP of touching, is too
// short to exist: its two junctions draw as one, with the road's lanes chained
// through, and the road itself isn't drawn. Pulled apart, they are two again.
// Nothing is stored; the stored junctions stay as they are.

import { intersect, offset, toPath, union } from './clip';
import { defaultWalkways } from './defaults';
import { endsOf, type RoadGeo } from './ends';
import { outlineOf } from './outline';
import { laneKey, type Connection, type Junction, type Road } from './model';

const MERGE_GAP = 2.5;

// Each junction as drawn lists the nodes it covers (`members`). `memo` keeps
// a road's touching test while its two junctions stay the same.
export function effectiveJunctions(
	roads: Road[],
	junctions: Junction[],
	geos: Map<string, RoadGeo>,
	memo: (road: string, a: Junction, b: Junction, test: () => boolean) => boolean
) {
	const parent = new Map<string, string>(junctions.map((j) => [j.id, j.id]));
	const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
	const owners = new Map<string, Junction>();
	for (const j of junctions) for (const e of j.ends) owners.set(`${e.road}:${e.end}`, j);
	const owner = (road: string, end: 'start' | 'end') => owners.get(`${road}:${end}`);
	const hidden = new Set<string>();
	// Outlines, to tell whether two junctions joined by a short road nearly
	// touch; worked out only for junctions that have one.
	const outlines = new Map<string, ReturnType<typeof union>>();
	const outline = (j: Junction) => {
		let o = outlines.get(j.id);
		if (!o) {
			o = union([toPath(outlineOf(endsOf(j, geos)).polygon)]);
			outlines.set(j.id, o);
		}
		return o;
	};
	for (const road of roads) {
		const a = owner(road.id, 'start');
		const b = owner(road.id, 'end');
		if (!a || !b || a === b) continue;
		const length = geos.get(road.id)?.path.length ?? Infinity;
		const touching =
			length < 30 &&
			memo(
				road.id,
				a,
				b,
				() =>
					intersect(offset(outline(a), MERGE_GAP / 2), offset(outline(b), MERGE_GAP / 2)).length > 0
			);
		if (length >= MERGE_GAP && !touching) continue;

		hidden.add(road.id);
		parent.set(find(a.id), find(b.id));
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
			...(members.length === 1 ? members[0] : merged(members, hidden, geos)),
			members: ids
		});
	}
	return { junctions: out, hidden };
}

function merged(members: Junction[], hidden: Set<string>, geos: Map<string, RoadGeo>): Junction {
	const ends = members.flatMap((j) => j.ends).filter((e) => !hidden.has(e.road));
	const all = members.flatMap((j) => j.connections);
	const kept = all.filter((c) => !hidden.has(c.from.road) && !hidden.has(c.to.road));
	// A connection into a hidden road chains on to whatever leaves the same
	// lane at its other end.
	const chained: Connection[] = [];
	for (const c of all) {
		if (hidden.has(c.from.road) || !hidden.has(c.to.road)) continue;
		let at = {
			road: c.to.road,
			end: c.to.end === 'start' ? 'end' : 'start',
			lane: c.to.lane
		} as Connection['to'];
		for (let guard = 0; guard < 4; guard++) {
			// A connection has a direction only for traffic: one into the same
			// lane from the far side (a sidewalk's) carries on as well, turned
			// round.
			const next = all
				.filter((d) => d !== c)
				.flatMap((d) =>
					laneKey(d.from) === laneKey(at)
						? [d]
						: laneKey(d.to) === laneKey(at) && !hidden.has(d.from.road)
							? [{ from: d.to, to: d.from }]
							: []
				);
			const done = next.filter((d) => !hidden.has(d.to.road));
			for (const d of done) chained.push({ from: c.from, to: d.to });
			const on = next.find((d) => hidden.has(d.to.road));
			if (!on) break;
			at = { road: on.to.road, end: on.to.end === 'start' ? 'end' : 'start', lane: on.to.lane };
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
	const j: Junction = {
		id: members.map((m) => m.id).join('+'),
		ends,
		connections: [...kept, ...unique],
		walkways: [],
		control: Object.assign({}, ...members.map((m) => m.control))
	};
	j.walkways = defaultWalkways(endsOf(j, geos));
	return j;
}
