import type { JunctionData, JunctionLaneRef } from './types';

type End = 'start' | 'end';

// A node's junction edits (connections added and removed, crossings,
// approach controls, taper) carried over to other roads: copied with the
// roads they name, pasted onto another node, or kept when two roads are
// joined into one. `end` maps a road end to its new road end (or drops it);
// `lane` maps a lane id on an old road to the lane id on the new one.
// The connections list itself is left out: it is worked out again from the
// defaults and these edits.
export function mapJunction(
	data: JunctionData,
	end: (road: string, end: End) => { road: string; end: End } | null,
	lane: (road: string, lane: string) => string | null = (_road, id) => id
): JunctionData | undefined {
	const ref = (r: JunctionLaneRef) => {
		const e = end(r.road, r.end);
		const l = e ? lane(r.road, r.lane) : null;
		return e && l ? { road: e.road, end: e.end, lane: l } : null;
	};
	const pairs = (list: JunctionData['added']) =>
		(list ?? []).flatMap((c) => {
			const from = ref(c.from);
			const to = ref(c.to);
			return from && to ? [{ from, to }] : [];
		});
	const crossings = (data.crossings ?? []).flatMap((c) => {
		const e = end(c.road, c.end);
		const lanes = c.lanes.map((id) => lane(c.road, id));
		if (!e || !lanes[0] || !lanes[1]) return [];
		return [{ ...c, road: e.road, end: e.end, lanes: [lanes[0], lanes[1]] as [string, string] }];
	});
	const control: NonNullable<JunctionData['control']> = {};
	for (const [key, value] of Object.entries(data.control ?? {})) {
		const [road, at] = key.split(':') as [string, End];
		const e = end(road, at);
		if (e) control[`${e.road}:${e.end}`] = value;
	}
	const out: JunctionData = { connections: [] };
	const added = pairs(data.added);
	const removed = pairs(data.removed);
	if (added.length) out.added = added;
	if (removed.length) out.removed = removed;
	if (crossings.length) out.crossings = crossings;
	if (Object.keys(control).length) out.control = control;
	if (data.taper !== undefined) out.taper = data.taper;
	if (data.islands?.length) out.islands = data.islands;
	const edited = Object.keys(out).length > 1;
	return edited ? out : undefined;
}
