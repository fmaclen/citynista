// Close junctions merge. A road between two junctions that is shorter than
// MERGE_GAP is too short to exist: its two junctions draw as one, with the
// road's lanes chained through, and the road itself isn't drawn. Pulled
// apart, they are two again. Nothing is stored; the stored junctions stay as
// they are.

import { intersect, offset, toPath, union } from './clip';
import { defaultCorners, defaultWalkways, endsOf, outlineOf, type RoadGeo } from './junction';
import { laneKey, type Connection, type Junction, type Place } from './model';

export const MERGE_GAP = 2.5;
// A merged link has to grow past this before the junctions split again, so a
// drag across the threshold doesn't flicker between one junction and two, and
// the link it leaves is long enough to read as a road: room for its median
// and a stop line at each end.
export const SPLIT_GAP = 8;

// `memo` keeps a road's touching test while nothing it reads has changed
// (keyed by the caller's versions of the road and its two junctions).
export function effectiveJunctions(
	place: Place,
	geos: Map<string, RoadGeo>,
	memo: (road: string, a: Junction, b: Junction, gap: number, test: () => boolean) => boolean = (
		_road,
		_a,
		_b,
		_gap,
		test
	) => test()
) {
	const parent = new Map<string, string>(place.junctions.map((j) => [j.id, j.id]));
	const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
	const owners = new Map<string, Junction>();
	for (const j of place.junctions) for (const e of j.ends) owners.set(`${e.road}:${e.end}`, j);
	const owner = (road: string, end: 'start' | 'end') => owners.get(`${road}:${end}`);
	const hidden = new Set<string>();
	// Outlines, to tell whether two junctions joined by a short road nearly
	// touch; worked out only for junctions that have one.
	const outlines = new Map<string, ReturnType<typeof union>>();
	const outline = (j: Junction) => {
		let o = outlines.get(j.id);
		if (!o) {
			o = union([toPath(outlineOf(j, endsOf(j, geos)).polygon)]);
			outlines.set(j.id, o);
		}
		return o;
	};
	for (const road of place.roads) {
		const a = owner(road.id, 'start');
		const b = owner(road.id, 'end');
		if (!a || !b || a === b) continue;
		const length = geos.get(road.id)?.path.length ?? Infinity;
		const gap = place.merged?.includes(road.id) ? SPLIT_GAP : MERGE_GAP;
		const touching =
			length < 30 &&
			memo(
				road.id,
				a,
				b,
				gap,
				() => intersect(offset(outline(a), gap / 2), offset(outline(b), gap / 2)).length > 0
			);
		if (length >= gap && !touching) continue;

		hidden.add(road.id);
		parent.set(find(a.id), find(b.id));
	}
	const groups = new Map<string, Junction[]>();
	for (const j of place.junctions) {
		const root = find(j.id);
		groups.set(root, [...(groups.get(root) ?? []), j]);
	}
	const out: Junction[] = [];
	for (const members of groups.values()) {
		if (members.length === 1) {
			out.push(members[0]);
			continue;
		}
		out.push(merged(members, hidden, geos));
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
		control: Object.assign({}, ...members.map((m) => m.control)),
		corners: [],
		islands: members.flatMap((m) => m.islands)
	};
	const info = endsOf(j, geos);
	j.corners = defaultCorners(info);
	const stored = new Map(members.flatMap((m) => m.walkways).map((w) => [w.id, w]));
	j.walkways = defaultWalkways(info).map((w) => {
		const s = stored.get(w.id);
		return s ? { ...w, on: s.on, paved: s.paved, bare: s.bare } : w;
	});
	return j;
}
