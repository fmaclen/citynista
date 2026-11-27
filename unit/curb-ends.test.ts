import { expect, test } from 'bun:test';
import { roadAt, shiftAtCut, sideOf } from '../src/lib/core/road-line';
import { quadratic, tAt } from '../src/lib/core/segment-curve';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { Scene } from '../src/lib/core/networks';
import type { GraphData, Lane } from '../src/lib/core/types';
import { buildModel, liveShape } from './model';

// A footpath drawn across a street and ended where draw mode snaps it on
// the far curb crosses the street, curved or straight, as one ended just
// past that curb does: the snap and the crossing read the curb in one place.

const drive = (direction: Lane['direction']): Lane => ({
	role: 'vehicle',
	material: 'asphalt',
	width: 3.5,
	direction
});
// A two-lane street with no sidewalks from (-45, 0) to (45, 0), bowed up
// through `bow` (its curve's handle at (0, 2 bow)), and a footpath from
// (10, 25) to `end`.
const crossing = (bow: number, end: { x: number; y: number }): GraphData => ({
	nodes: [
		{ id: 'w', x: -45, y: 0 },
		{ id: 'e', x: 45, y: 0 },
		{ id: 'p', x: 10, y: 25 },
		{ id: 'q', ...end }
	],
	segments: [
		{
			id: 'street',
			startNodeId: 'w',
			endNodeId: 'e',
			lanes: [drive('backward'), drive('forward')],
			...(bow && { controlX: 0, controlY: 2 * bow })
		},
		{ id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: createLanesFrom('path') }
	]
});

const zebras = (scene: Scene) =>
	scene.place.roads
		.flatMap((r) => scene.road(r.id)?.crossings ?? [])
		.filter((c) => c.runs.some((r) => r.kind === 'zebra')).length;

for (const bow of [0, 16])
	test(`a footpath ended on the far curb of a ${bow ? 'curved' : 'straight'} street crosses it`, () => {
		const bare = crossing(bow, { x: 10, y: -20 });
		const graph = liveShape(bare);
		const curb = sideOf(graph as never, graph.segments.get('street')! as never, 10, bow ? 12 : -3)!;
		const ended = buildModel(crossing(bow, curb)).scene;
		const past = buildModel(crossing(bow, { x: curb.x, y: curb.y - 0.01 })).scene;
		expect(zebras(past)).toBe(1);
		expect(zebras(ended)).toBe(1);
	});

// The same rule swept: for straight and curved streets, a shift that grows
// along the street, both ways the street can be stored, the street cut in
// two where it draws the same, both curbs, several places along it and
// several angles (fewer on a long street, slow to draw). Ended where draw mode snaps it on the far curb, or just
// past it, the footpath crosses; ended just short of it, inside the
// roadway, it does not.
type Street = {
	name: string;
	a: Pt;
	b: Pt;
	c?: Pt;
	o0: number;
	o1: number;
	long?: true;
	short?: true;
};
type Pt = { x: number; y: number };
const streets: Street[] = [
	{ name: 'straight', a: { x: -45, y: 0 }, b: { x: 45, y: 0 }, o0: 0, o1: 0 },
	{ name: 'shift growing', a: { x: -45, y: 0 }, b: { x: 45, y: 0 }, o0: 0, o1: 6 },
	{ name: 'shift crossing over', a: { x: -45, y: 0 }, b: { x: 45, y: 0 }, o0: -4, o1: 5 },
	{ name: 'curved', a: { x: -45, y: 0 }, b: { x: 45, y: 0 }, c: { x: 0, y: 32 }, o0: 0, o1: 0 },
	{
		name: 'curved, shifted',
		a: { x: -45, y: 0 },
		b: { x: 45, y: 0 },
		c: { x: 0, y: -40 },
		o0: 3,
		o1: -2
	},
	{
		name: 'long and curved',
		a: { x: -450, y: 0 },
		b: { x: 450, y: 0 },
		c: { x: 0, y: 520 },
		o0: 0,
		o1: 0,
		long: true
	}
];
// Near a dead end: a road's end lies square to its drawn line, however its
// shift slants its lanes, and a footpath straight across it (along the
// drawn line's normal) crosses it at every station along that line strictly
// between its ends and at none past them. Swept for short streets straight
// and curved, shifted alike and growing either way, both ways stored, cut
// in two or whole, stations every half metre from past one end to past the
// other, crossed from either side. Ended where draw mode snaps it on the
// far curb near either dead end, it crosses as along the street.
const shortStreets: Street[] = [
	{ name: 'shift growing', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, o0: 0, o1: 6, short: true },
	{
		name: 'shift crossing over',
		a: { x: 0, y: 0 },
		b: { x: 14, y: 0 },
		o0: -3,
		o1: 4,
		short: true
	},
	{ name: 'shifted alike', a: { x: 0, y: 0 }, b: { x: 12, y: 0 }, o0: 3, o1: 3, short: true },
	{
		name: 'curved, shift growing',
		a: { x: 0, y: 0 },
		b: { x: 20, y: 0 },
		c: { x: 10, y: 8 },
		o0: 0,
		o1: 5,
		short: true
	}
];
const bezier = (s: Street, t: number) => {
	const c = s.c ?? { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
	const u = 1 - t;
	return {
		x: u * u * s.a.x + 2 * u * t * c.x + t * t * s.b.x,
		y: u * u * s.a.y + 2 * u * t * c.y + t * t * s.b.y
	};
};
// The street as stored, reversed if asked, cut in two halves at its middle
// if asked (each half the curve's own half, its shift where the whole one
// has it), and a footpath from `from` to `to`.
function streetGraph(s: Street, reversed: boolean, cut: boolean, from: Pt, to: Pt): GraphData {
	const lanes = [drive('backward'), drive('forward')];
	const one = (id: string, a: string, b: string, c: Pt | undefined, o0: number, o1: number) =>
		reversed
			? {
					id,
					startNodeId: b,
					endNodeId: a,
					lanes: [drive('backward'), drive('forward')],
					offsetStart: -o1,
					offsetEnd: -o0,
					...(c && { controlX: c.x, controlY: c.y })
				}
			: {
					id,
					startNodeId: a,
					endNodeId: b,
					lanes,
					offsetStart: o0,
					offsetEnd: o1,
					...(c && { controlX: c.x, controlY: c.y })
				};
	const nodes = [
		{ id: 'w', ...s.a },
		{ id: 'e', ...s.b },
		{ id: 'p', ...from },
		{ id: 'q', ...to }
	];
	const path = { id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: createLanesFrom('path') };
	if (!cut) return { nodes, segments: [one('street', 'w', 'e', s.c, s.o0, s.o1), path] };
	const c = s.c ?? { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
	const mid = bezier(s, 0.5);
	const left = quadratic(s.a, { x: (s.a.x + c.x) / 2, y: (s.a.y + c.y) / 2 }, mid).length;
	const right = quadratic(mid, { x: (c.x + s.b.x) / 2, y: (c.y + s.b.y) / 2 }, s.b).length;
	const o = shiftAtCut(s.o0, s.o1, left, right);
	const lc = s.c && { x: (s.a.x + c.x) / 2, y: (s.a.y + c.y) / 2 };
	const rc = s.c && { x: (c.x + s.b.x) / 2, y: (c.y + s.b.y) / 2 };
	return {
		nodes: [...nodes, { id: 'm', ...mid }],
		segments: [one('street', 'w', 'm', lc, s.o0, o), one('street2', 'm', 'e', rc, o, s.o1), path]
	};
}

for (const s of [...streets, ...shortStreets])
	test(`a footpath crosses the ${s.short ? 'short ' : ''}${s.name} street exactly when it reaches its far curb`, () => {
		const wrong: string[] = [];
		for (const reversed of [false, true])
			for (const cut of [false, true])
				for (const f of s.long
					? [0.3, 0.7]
					: s.short
						? [0.08, 0.15, 0.85, 0.92]
						: [0.2, 0.37, 0.5, 0.63, 0.8])
					for (const side of [1, -1])
						for (const angle of s.long ? [0.5] : s.short ? [0] : [0, 0.5, -0.9]) {
							// Where the street shows f along it, and the way across it.
							const probe = liveShape(
								streetGraph(s, false, false, { x: 0, y: 900 }, { x: 1, y: 900 })
							);
							const at = roadAt(probe as never, probe.segments.get('street')! as never, f)!;
							const n = { x: at.normal.x * side, y: at.normal.y * side };
							const t = { x: -n.y, y: n.x };
							const way = {
								x: n.x * Math.cos(angle) + t.x * Math.sin(angle),
								y: n.y * Math.cos(angle) + t.y * Math.sin(angle)
							};
							const beyond = { x: at.point.x + n.x * 5, y: at.point.y + n.y * 5 };
							const from = { x: at.point.x - way.x * 14, y: at.point.y - way.y * 14 };
							const graph = liveShape(streetGraph(s, reversed, cut, from, beyond));
							const ids = cut ? ['street', 'street2'] : ['street'];
							// The curb draw mode snaps to: on the half under the point.
							const snaps = ids.map(
								(id) =>
									sideOf(graph as never, graph.segments.get(id)! as never, beyond.x, beyond.y)!
							);
							const curb = snaps.reduce((b, p) =>
								Math.hypot(p.x - beyond.x, p.y - beyond.y) <
								Math.hypot(b.x - beyond.x, b.y - beyond.y)
									? p
									: b
							);
							const back = { x: curb.x - from.x, y: curb.y - from.y };
							const l = Math.hypot(back.x, back.y);
							const along = (d: number) => ({
								x: curb.x + (back.x / l) * d,
								y: curb.y + (back.y / l) * d
							});
							for (const [d, want] of [
								[0, 1],
								[0.05, 1],
								[-0.05, 0]
							] as const) {
								const got = zebras(buildModel(streetGraph(s, reversed, cut, from, along(d))).scene);
								if (got !== want)
									wrong.push(
										`${reversed ? 'reversed ' : ''}${cut ? 'cut ' : ''}f ${f} side ${side} angle ${angle} end ${d}: ${got}`
									);
							}
						}
		expect(wrong).toEqual([]);
	});

for (const s of shortStreets)
	test(`a footpath across the short ${s.name} street crosses it right up to its dead ends`, () => {
		const wrong: string[] = [];
		const probe = liveShape(streetGraph(s, false, false, { x: 0, y: 900 }, { x: 1, y: 900 }));
		const street = probe.segments.get('street')!;
		const curve = quadratic(s.a, s.c ?? null, s.b);
		const { length } = curve;
		// The drawn line's point, its normal and the shift `d` along it, read
		// on straight past its ends.
		const station = (d: number) => {
			const along = Math.max(0, Math.min(length, d));
			const at = roadAt(probe as never, street as never, tAt(curve, along))!;
			const past = d - along;
			const p = { x: at.line.x + at.tangent.x * past, y: at.line.y + at.tangent.y * past };
			return { p, n: at.normal, shift: at.shift };
		};
		for (const reversed of [false, true])
			for (const cut of [false, true])
				for (let d = -1.5; d <= length + 1.5; d += 0.5) {
					if (Math.abs(d) < 0.2 || Math.abs(d - length) < 0.2) continue;
					const { p, n, shift } = station(d);
					const mid = { x: p.x + n.x * shift, y: p.y + n.y * shift };
					for (const side of [1, -1]) {
						const from = { x: mid.x - n.x * 12 * side, y: mid.y - n.y * 12 * side };
						const to = { x: mid.x + n.x * 12 * side, y: mid.y + n.y * 12 * side };
						const want = d > 0 && d < length ? 1 : 0;
						const got = zebras(buildModel(streetGraph(s, reversed, cut, from, to)).scene);
						if (got !== want)
							wrong.push(
								`${reversed ? 'reversed ' : ''}${cut ? 'cut ' : ''}at ${d} side ${side}: ${got}`
							);
					}
				}
		expect(wrong).toEqual([]);
	});
