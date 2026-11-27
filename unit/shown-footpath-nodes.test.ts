import { expect, test } from 'bun:test';
import { Networks, type Scene } from '../src/lib/core/networks';
import {
	closestOnRoad,
	endsAt,
	nodePoint,
	type Pt,
	roadAt,
	shownAt
} from '../src/lib/core/road-line';
import { fromFrame } from '../src/lib/core/segment-curve';
import type { GraphView } from '../src/lib/core/graph.svelte';
import type { GraphData, Lane } from '../src/lib/core/types';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { groundOf, liveShape } from './model';
import { cityOf, openEditor } from './editor.svelte';
import { walkwayOf } from '../src/lib/modes/picking';

type Ui = ReturnType<typeof openEditor>;

const p = (x: number, y: number) => ({ x, y });

// What a footpath node reads of the car roads it reads where it shows, its
// footpaths' shifts and all, never where it lies: it rides a street whose
// ground it shows on, keeping where it shows there, and it joins a car
// road's dead end where one of its footpaths' ends shows on it, the same
// from build to build as in a fresh build.

const lane = (role: Lane['role'], width: number): Lane => ({
	role,
	material: role === 'vehicle' ? 'asphalt' : 'concrete',
	width,
	direction: role === 'vehicle' ? 'forward' : 'bidirectional'
});
const walk = (width: number) => [lane('pedestrian', width)];
// A two-lane street with no sidewalks: its curbs 3.5 m either side of its line.
const street = [lane('vehicle', 3.5), lane('vehicle', 3.5)];

test('footpath nodes stored past a curb ride the street they show on', () => {
	// Along the street's curb at y = 3.5, a narrow footpath between two wider
	// ones, their nodes stored 30 cm past the curb, the narrow one shifted
	// 1.6 m toward the street: its nodes show over the car lanes.
	const data = (shift: number): GraphData => ({
		nodes: [
			{ id: 'w', x: -60, y: 0 },
			{ id: 'e', x: 60, y: 0 },
			{ id: 'p', x: -30, y: 3.8 },
			{ id: 'a', x: -5, y: 3.8 },
			{ id: 'b', x: 5, y: 3.8 },
			{ id: 'q', x: 30, y: 3.8 }
		],
		segments: [
			{ id: 'street', startNodeId: 'w', endNodeId: 'e', lanes: street },
			{ id: 'left', startNodeId: 'p', endNodeId: 'a', lanes: walk(3) },
			{
				id: 'narrow',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: walk(1),
				offsetStart: shift,
				offsetEnd: shift
			},
			{ id: 'right', startNodeId: 'b', endNodeId: 'q', lanes: walk(3) }
		]
	});
	const shown = (graph: ReturnType<typeof liveShape>, id: string) =>
		nodePoint(graph as never, graph.nodes.get(id)!).y;
	// Shifted left of its way east, it shows nearer the street.
	const graph = liveShape(data(-1.6));
	for (const id of ['a', 'b']) expect(shown(graph, id)).toBeLessThan(3.5);
	const riders = groundOf(graph as never)(new Set(['street']), new Set(['w', 'e']));
	expect([...riders.keys()].sort()).toEqual(['a', 'b']);
	// Unshifted, they show where they are stored, off the street.
	const off = liveShape(data(0));
	expect(groundOf(off as never)(new Set(['street']), new Set(['w', 'e'])).size).toBe(0);
});

// Each piece of a drawing as drawn, but the keys its caches go by.
const drawn = (scene: Scene) =>
	new Map(
		[
			...scene.place.roads.map((r) => [`road:${r.id}`, scene.road(r.id)] as const),
			...scene.place.junctions.map((j) => [`node:${j.id}`, scene.node(j.id)] as const)
		].map(([id, d]) => [id, JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v))])
	);

for (const [shift, joins] of [
	[0, true],
	[8, false]
] as const)
	test(`a street's dead end moved onto a footpath's end ${joins ? 'showing there joins it' : 'shown 8 m off joins nothing'}, as a fresh build draws it`, () => {
		// A footpath ending at (0, 0), shifted `shift` m off its line, and a
		// street whose dead end is moved from (20, 0) onto (0, 0).
		const graph = liveShape({
			nodes: [
				{ id: 'p', x: -30, y: 0 },
				{ id: 'q', x: 0, y: 0 },
				{ id: 'd', x: 20, y: 0 },
				{ id: 'e', x: 60, y: 0 }
			],
			segments: [
				{ id: 'street', startNodeId: 'd', endNodeId: 'e', lanes: street },
				{
					id: 'path',
					startNodeId: 'p',
					endNodeId: 'q',
					lanes: walk(2),
					offsetStart: shift,
					offsetEnd: shift
				}
			]
		});
		const networks = new Networks();
		networks.build(graph as never);
		graph.nodes.get('d')!.x = 0;
		const live = networks.build(graph as never).scene;
		const fresh = new Networks().build(graph as never).scene;
		expect(drawn(live)).toEqual(drawn(fresh));
		expect(fresh.place.junctions.some((j) => j.id.endsWith('q'))).toBe(joins);
	});

// A T of streets, arms west, east and north of (0, 0), and a footpath down
// from the north to a sidewalk of the east arm, shifted so its end shows on
// that sidewalk `along` m east while its node lies `off` m east of that
// (west: nearer the north arm than the east one). Its end rides the east
// arm whichever way it is stored, straight or curved with its shift easing
// to nothing at its far end, however far its shift puts the node, and
// however the arm is moved: its far end swung, its body dragged, or the T's
// node dragged with all three arms. After each, its end shows exactly at
// its place along and across the arm as it showed before (within a
// millimetre), joined to the same sidewalk, its far node where it lay,
// however many pointer updates the drag took: where a node lies for its
// end to show there is solved, not walked toward (endsAt).
const presets = { Street: 4.5, Avenue: 10.5 };
const moves = [
	['far end swung', p(60, 0), p(60, 15)],
	['body dragged', p(40, 0), p(40, -6)],
	['T dragged', p(0, 0), p(-5, 4)]
] as const;
const endOf = (graph: GraphView, id: string, nodeId: string) => {
	const s = graph.segments.get(id)!;
	return roadAt(graph, s, s.startNodeId === nodeId ? 0 : 1)!.point;
};
for (const [preset, walkway] of Object.entries(presets))
	for (const [move, from, to] of moves)
		test(`a shifted footpath end on a ${preset}'s sidewalk at a T rides that arm, wherever its node lies: ${move}`, () => {
			const wrong: string[] = [];
			const key = preset.toLowerCase() as 'street' | 'avenue';
			const along = walkway * 4;
			let k = 0;
			for (const off of [-along + 3, along / 2])
				for (const [down, bent] of [
					[true, false],
					[false, false],
					[false, true]
				]) {
					const at = p(along + off, walkway);
					const top = p(along + off + (bent ? 12 : 0), 60);
					const city = cityOf({ o: [0, 0], w: [-60, 0], e: [60, 0], n: [0, 80] }, [
						{ id: 'west', from: 'w', to: 'o', lanes: key },
						{ id: 'east', from: 'o', to: 'e', lanes: key },
						{ id: 'north', from: 'o', to: 'n', lanes: key }
					]);
					// Stored down from the north its right is east, so a shift of
					// -off shows it `off` m back west of its node; stored up, +off
					// does.
					city.nodes.push({ id: 'q', ...at }, { id: 'f', ...top });
					city.segments.push({
						id: 'path',
						startNodeId: down ? 'f' : 'q',
						endNodeId: down ? 'q' : 'f',
						lanes: createLanesFrom('path'),
						offsetStart: down ? -off : off,
						offsetEnd: down ? -off : bent ? 0 : off,
						// Leaving its end straight up, so its shift there is still
						// along the arm.
						...(bent && { controlX: at.x, controlY: 30 })
					} as GraphData['segments'][number]);
					const ui = openEditor(city);
					const graph = ui.editor.graph;
					const on = () => ui.editor.roadRenderer.derived?.sidewalks.get('q')?.[0];
					const was = on();
					const name = `off ${off} ${down ? 'down' : 'up'}${bent ? ' curved' : ''}`;
					if (!was || was.road !== 'east') {
						wrong.push(`${name}: not set up on the east sidewalk`);
						continue;
					}
					// Where the end shows along and across the arm.
					const end = endOf(graph, 'path', 'q');
					const east = graph.segments.get('east')!;
					const { t } = closestOnRoad(graph, east, end.x, end.y);
					const arm = roadAt(graph, east, t)!;
					const [dx, dy] = [end.x - arm.point.x, end.y - arm.point.y];
					const [a, c] = [
						dx * arm.tangent.x + dy * arm.tangent.y,
						dx * arm.normal.x + dy * arm.normal.y
					];
					const far = p(graph.nodes.get('f')!.x, graph.nodes.get('f')!.y);
					ui.click(from.x, from.y);
					ui.drag(from, to, {}, k++ % 2 ? 1 : 6);
					const now = roadAt(graph, east, t)!;
					const want = p(
						now.point.x + now.tangent.x * a + now.normal.x * c,
						now.point.y + now.tangent.y * a + now.normal.y * c
					);
					const shown = endOf(graph, 'path', 'q');
					const missed = Math.hypot(shown.x - want.x, shown.y - want.y);
					if (missed > 0.001) wrong.push(`${name}: shows ${missed} m off its place`);
					const f = graph.nodes.get('f')!;
					if (f.x !== far.x || f.y !== far.y) wrong.push(`${name}: its far node moved`);
					if (on()?.road !== 'east' || on()?.lane !== was.lane)
						wrong.push(`${name}: off its sidewalk`);
					if (ui.stale().length) wrong.push(`${name}: stale`);
				}
			expect(wrong).toEqual([]);
		});

// The point of the chord from `a` to `b` nearest `p`, and how far it is.
const nearestOnChord = (q: Pt, a: Pt, b: Pt) => {
	const [dx, dy] = [b.x - a.x, b.y - a.y];
	const f = Math.max(
		0,
		Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1))
	);
	const at = p(a.x + dx * f, a.y + dy * f);
	return { at, d: Math.hypot(at.x - q.x, at.y - q.y) };
};

// How far a point lies from the middle of a car road's sidewalks as drawn,
// the corners they run into included (walkwayOf in modes/picking.ts).
const offWalkway = (ui: Ui, road: string, at: Pt) => {
	let best = Infinity;
	for (const lane of ui.editor.graph.segments.get(road)?.lanes ?? []) {
		if (lane.role !== 'pedestrian' || !lane.id) continue;
		for (const line of walkwayOf(ui.editor, { road, lane: lane.id })?.lines ?? [])
			for (let k = 1; k < line.length; k++)
				best = Math.min(best, nearestOnChord(at, line[k - 1], line[k]).d);
	}
	return best;
};

// Where a point `of` lies from the spot of a road nearest `by`: that spot
// (`t`), and how far along and across the road from it; and the point kept
// there as the road now lies.
const placeOn = (graph: GraphView, road: string, by: Pt, of: Pt) => {
	const segment = graph.segments.get(road)!;
	const { t } = closestOnRoad(graph, segment, by.x, by.y);
	const at = roadAt(graph, segment, t)!;
	const [dx, dy] = [of.x - at.point.x, of.y - at.point.y];
	return { t, u: dx * at.tangent.x + dy * at.tangent.y, v: dx * at.normal.x + dy * at.normal.y };
};
const keptOn = (graph: GraphView, road: string, place: { t: number; u: number; v: number }) => {
	const at = roadAt(graph, graph.segments.get(road)!, place.t)!;
	return p(
		at.point.x + at.tangent.x * place.u + at.normal.x * place.v,
		at.point.y + at.tangent.y * place.u + at.normal.y * place.v
	);
};

// How far a carried footpath end may move across its walkway (placedBy in
// core/drag.ts): its node keeps where it lay from its end as the move began,
// turned as the road it rides turned there, so its end is off by as much as
// its shift turns against that: the shift times the angle the footpath's
// way out of the node turned less the angle the road turned (none for an
// end keeping to a corner), and the millimetre the sidewalk's middle as
// drawn (walkwayOf) may lie off a curved road's. Read before the move;
// called after it, the bound.
const carriedWithin = (graph: GraphView, path: string, node: string, road: string | null) => {
	const segment = graph.segments.get(path)!;
	const start = segment.startNodeId === node;
	const shift = Math.abs((start ? segment.offsetStart : segment.offsetEnd) ?? 0);
	const way = () => roadAt(graph, graph.segments.get(path)!, start ? 0 : 1)!.tangent;
	const end = endOf(graph, path, node);
	const t = road ? closestOnRoad(graph, graph.segments.get(road)!, end.x, end.y).t : 0;
	const along = () => (road ? roadAt(graph, graph.segments.get(road)!, t)!.tangent : p(1, 0));
	const [w0, r0] = [way(), along()];
	const turn = (a: Pt, b: Pt) => Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
	return () => shift * Math.abs(turn(w0, way()) - turn(r0, along())) + 0.001;
};

// Whether a footpath still runs within a right angle of the way it ran.
const unturned = (graph: GraphView, id: string, was: Pt) => {
	const s = graph.segments.get(id)!;
	const [a, b] = [graph.nodes.get(s.startNodeId)!, graph.nodes.get(s.endNodeId)!];
	return (b.x - a.x) * was.x + (b.y - a.y) * was.y > 0;
};
const chordOf = (graph: GraphView, id: string) => {
	const s = graph.segments.get(id)!;
	const [a, b] = [graph.nodes.get(s.startNodeId)!, graph.nodes.get(s.endNodeId)!];
	return p(b.x - a.x, b.y - a.y);
};

// The use a shift is for: a 2 m path meeting an 8 m path end to end, the
// wide one shifted 3 or 4 m (up to half its width) toward a street, so the
// joint lies off the street and the wide path's end shows on its sidewalk.
// The wide path runs along the street (its far end on the sidewalk too) or
// leaves it at 60°; stored either way; on either side of a T's arm next to
// the T, of a straight street or of a curved one; the narrow path's id
// sorting first or last. Where the wide path's end shows is decided as a
// footpath's ends are (endsAt), and lands to the millimetre:
// - leaving the street, the street moved (a T's arm's end dragged, a
//   street's end dragged), it shows at its place along and across the road
//   it shows on, the same for one pointer update as for six;
// - along the street, both its nodes riding (placedBy in core/drag.ts:
//   carried), whichever path's id sorts first: the street's end dragged,
//   each node keeps its place at the spot where its end shows and each end
//   stays on the sidewalk's middle (carriedWithin), the same for one
//   pointer update as for 32; the street dragged whole or a T's arm swung
//   about the junction at its length, both ends show exactly where it
//   carried them;
// - along the street, the wide path's far end (a free end, joined to the
//   sidewalk) dragged along it, it slides along the sidewalk's middle to
//   where it comes nearest where the drag took it, and the street widened,
//   it stays on the sidewalk's middle;
// - leaving the street, that far end dragged onto the sidewalk, it shows
//   where let go.
// Each time drawn as a fresh build draws it.
test('a 2 m path meeting an 8 m path shifted toward a street keeps the wide end on the sidewalk in every gesture', () => {
	const wrong: string[] = [];
	const walkway = 4.5;
	// Where the street's end dragged leaves the pair along it, by arrangement
	// but for the paths' ids.
	const stretchedTo = new Map<string, string>();
	const missed = (name: string, at: Pt, want: Pt) => {
		const by = Math.hypot(at.x - want.x, at.y - want.y);
		if (by > 0.001) wrong.push(`${name}: shows ${by} m off`);
	};
	for (const layout of ['T', 'straight', 'curved'] as const)
		for (const side of [1, -1])
			for (const shift of [3, 4])
				for (const along of [true, false])
					for (const out of [true, false])
						for (const narrowFirst of [true, false]) {
							// The paths' ids, the narrow one's sorting first or last.
							const [narrow, wide] = narrowFirst ? ['a-narrow', 'b-wide'] : ['b-narrow', 'a-wide'];
							const name = `${layout}, side ${side}, shifted ${shift}, ${along ? 'along' : 'leaving'}, stored ${out ? 'out' : 'in'}, ${narrow} and ${wide}`;
							// The road the wide end shows on, a point on its sidewalk, and
							// the way along it and out to that side there.
							const [a, b] = layout === 'T' ? [p(0, 0), p(60, 0)] : [p(-60, 0), p(60, 0)];
							const bow = layout === 'curved' ? { controlX: 0, controlY: -20 * side } : {};
							const road = { ...bow, offsetStart: 0, offsetEnd: 0 };
							const t0 = layout === 'T' ? 1 / 3 : 0.4;
							const at = shownAt(road, a, b, t0);
							const sign = Math.sign(at.normal.y * side) || 1;
							const outward = p(at.normal.x * sign, at.normal.y * sign);
							const sidewalkAt = (t: number) => {
								const there = shownAt(road, a, b, t);
								const k = Math.sign(there.normal.x * outward.x + there.normal.y * outward.y);
								return p(
									there.point.x + there.normal.x * k * walkway,
									there.point.y + there.normal.y * k * walkway
								);
							};
							const target = sidewalkAt(t0);
							// Along: its far end showing on the sidewalk 25 m on.
							const on = sidewalkAt(t0 + 25 / 120);
							const chord = Math.hypot(on.x - target.x, on.y - target.y);
							const r = Math.PI / 3;
							const dir = along
								? p((on.x - target.x) / chord, (on.y - target.y) / chord)
								: p(
										at.tangent.x * Math.cos(r) + outward.x * Math.sin(r),
										at.tangent.y * Math.cos(r) + outward.y * Math.sin(r)
									);
							// Its right as stored from the joint, and the shift that puts
							// the joint `shift` m further out than its end shows.
							const right = p(-dir.y, dir.x);
							const s = right.x * outward.x + right.y * outward.y > 0 ? -shift : shift;
							const q = p(target.x - right.x * s, target.y - right.y * s);
							const f = along
								? p(on.x - right.x * s, on.y - right.y * s)
								: p(q.x + dir.x * 25, q.y + dir.y * 25);
							const h = p(q.x - at.tangent.x * 11, q.y - at.tangent.y * 11);
							const cars: GraphData['segments'] =
								layout === 'T'
									? [
											{
												id: 'west',
												startNodeId: 'w',
												endNodeId: 'o',
												lanes: createLanesFrom('street')
											},
											{
												id: 'street',
												startNodeId: 'o',
												endNodeId: 'e',
												lanes: createLanesFrom('street')
											},
											{
												id: 'stem',
												startNodeId: 'o',
												endNodeId: 'n',
												lanes: createLanesFrom('street')
											}
										]
									: [
											{
												id: 'street',
												startNodeId: 'w',
												endNodeId: 'e',
												lanes: createLanesFrom('street'),
												...bow
											}
										];
							const city = (): GraphData => ({
								nodes: [
									{ id: 'w', ...(layout === 'T' ? p(-60, 0) : a) },
									{ id: 'o', ...a },
									{ id: 'e', ...b },
									{ id: 'n', ...p(0, 80 * side) },
									{ id: 'q', ...q },
									{ id: 'f', ...f },
									{ id: 'h', ...h }
								].filter((n) => layout === 'T' || !['o', 'n'].includes(n.id)),
								segments: [
									...cars,
									{
										id: wide,
										startNodeId: out ? 'q' : 'f',
										endNodeId: out ? 'f' : 'q',
										lanes: walk(8),
										offsetStart: out ? s : -s,
										offsetEnd: out ? s : -s
									},
									{ id: narrow, startNodeId: 'h', endNodeId: 'q', lanes: walk(2) }
								]
							});
							const open = () => {
								const ui = openEditor(city());
								const graph = ui.editor.graph;
								const end = () => endOf(graph, wide, 'q');
								missed(`${name}, as set up`, end(), target);
								if (along && !ui.editor.roadRenderer.derived?.sidewalks.get('f'))
									wrong.push(`${name}, as set up: its far end on no sidewalk`);
								return { ui, graph, end };
							};
							const fresh = (ui: Ui, step: string) => {
								if (ui.stale().length) wrong.push(`${name}, ${step}: stale`);
							};

							// Ridden, leaving the street: the street's far end dragged.
							const runs = (layout === 'T' && !along ? [1, 6] : along ? [] : [6]).map((steps) => {
								const { ui, graph, end } = open();
								const street = graph.segments.get('street')!;
								// Where the wide end keeps its place.
								const places = [end].map((read) => {
									const before = read();
									const { t } = closestOnRoad(graph, street, before.x, before.y);
									const was = roadAt(graph, street, t)!;
									const [dx, dy] = [before.x - was.point.x, before.y - was.point.y];
									return {
										read,
										t,
										u: dx * was.tangent.x + dy * was.tangent.y,
										v: dx * was.normal.x + dy * was.normal.y
									};
								});
								ui.click(b.x, b.y);
								ui.drag(b, p(b.x + 4, b.y - 12 * side), {}, steps);
								for (const { read, t, u, v } of places) {
									const now = roadAt(graph, street, t)!;
									missed(
										`${name}, street moved in ${steps}`,
										read(),
										p(
											now.point.x + now.tangent.x * u + now.normal.x * v,
											now.point.y + now.tangent.y * u + now.normal.y * v
										)
									);
								}
								fresh(ui, 'street moved');
								return JSON.stringify(['q', 'f'].map((id) => p(ui.node(id).x, ui.node(id).y)));
							});
							if (new Set(runs).size > 1)
								wrong.push(`${name}: placed otherwise by 1 and 6 pointer updates`);

							// Ridden along the street, both nodes riding: the street's
							// far end dragged, each node keeps its place at the spot of
							// the street where its end shows and each end stays on the
							// sidewalk's middle (carriedWithin), the same in 1 and 32
							// pointer updates; the street moved bodily (dragged whole, or
							// a T's arm swung about the junction at its length), both
							// ends show exactly where it carried them.
							if (along) {
								const ends = (graph: GraphView) => ['q', 'f'].map((id) => endOf(graph, wide, id));
								const stretched = (narrowFirst ? [1, 32] : [1]).map((steps) => {
									const { ui, graph } = open();
									const shown = ends(graph);
									const places = ['q', 'f'].map((id, k) =>
										placeOn(graph, 'street', shown[k], graph.nodes.get(id)!)
									);
									const within = ['q', 'f'].map((id) => carriedWithin(graph, wide, id, 'street'));
									const gaps = shown.map((end) => offWalkway(ui, 'street', end));
									ui.click(b.x, b.y);
									ui.drag(b, p(b.x + 4, b.y - 12 * side), {}, steps);
									['q', 'f'].forEach((id, k) => {
										const node = graph.nodes.get(id)!;
										const kept = keptOn(graph, 'street', places[k]);
										if (Math.hypot(node.x - kept.x, node.y - kept.y) > 1e-9)
											wrong.push(`${name}, street's end dragged in ${steps}: ${id} off its place`);
										const off = Math.abs(offWalkway(ui, 'street', ends(graph)[k]) - gaps[k]);
										if (off > within[k]())
											wrong.push(
												`${name}, street's end dragged in ${steps}: ${id}'s end moved ${off} m across the sidewalk`
											);
									});
									fresh(ui, "street's end dragged");
									const at = JSON.stringify(['q', 'f'].map((id) => graph.nodes.get(id)));
									const arrangement = `${layout} ${side} ${shift} ${out} ${steps}`;
									const other = stretchedTo.get(arrangement);
									if (!other) stretchedTo.set(arrangement, at);
									else if (other !== at)
										wrong.push(
											`${name}, street's end dragged: placed otherwise with the ids the other way round`
										);
									return JSON.stringify(ui.saved());
								});
								if (new Set(stretched).size > 1)
									wrong.push(
										`${name}, street's end dragged: stored otherwise by 1 and 32 pointer updates`
									);
								const { ui, graph } = open();
								const shown = ends(graph);
								const turn = layout === 'T' ? Math.PI / 12 : 0;
								const [c, sn] = [Math.cos(turn), Math.sin(turn)];
								const by = layout === 'T' ? p(0, 0) : p(5, -7 * side);
								if (layout === 'T') {
									ui.click(b.x, b.y);
									ui.drag(b, p(b.x * c, b.x * sn), {}, 6);
								} else {
									const grab = shownAt(road, a, b, 0.1).point;
									ui.click(grab.x, grab.y);
									ui.drag(grab, p(grab.x + by.x, grab.y + by.y), {}, 6);
								}
								ends(graph).forEach((at, k) => {
									const want = p(
										shown[k].x * c - shown[k].y * sn + by.x,
										shown[k].x * sn + shown[k].y * c + by.y
									);
									const off = Math.hypot(at.x - want.x, at.y - want.y);
									if (off > 1e-9)
										wrong.push(
											`${name}, ${layout === 'T' ? 'arm swung' : 'dragged bodily'}: ${off} m off`
										);
								});
								fresh(ui, 'moved bodily');
							}
							if (layout === 'T') continue;

							// Along the street, the wide path's far end is a free end on
							// the sidewalk, joined to it (the joint, where a path goes on,
							// is not: modes/picking.ts joinedTo).
							// Slid: that end dragged by where it shows 6 m along the street,
							// to the point of the sidewalk's middle as drawn (walkwayOf in
							// modes/picking.ts) nearest where the drag took it.
							if (along) {
								const { ui, graph } = open();
								const before = endOf(graph, wide, 'f');
								const by = p(at.tangent.x * 6, at.tangent.y * 6);
								const aim = p(before.x + by.x, before.y + by.y);
								const joined = ui.editor.roadRenderer.derived!.sidewalks.get('f')![0];
								const lines = walkwayOf(ui.editor, joined)?.lines ?? [];
								const want = lines
									.flatMap((l) => l.slice(1).map((q, k) => nearestOnChord(aim, l[k], q)))
									.sort((x, y) => x.d - y.d)[0]?.at;
								ui.click(before.x, before.y);
								ui.drag(before, aim);
								if (!want) wrong.push(`${name}, slid: no sidewalk`);
								else missed(`${name}, slid`, endOf(graph, wide, 'f'), want);
								const node = graph.nodes.get('q')!;
								if (node.x !== q.x || node.y !== q.y) wrong.push(`${name}, slid: the joint moved`);
								fresh(ui, 'slid');
							}

							// Followed: the street widened 2 m a side.
							if (along) {
								const { ui, graph } = open();
								const grab = shownAt(road, a, b, 0.1).point;
								ui.click(grab.x, grab.y);
								ui.editor.editLanes((lanes) => {
									for (const lane of lanes) if (lane.role === 'vehicle') lane.width += 2;
								});
								const street = graph.segments.get('street')!;
								const shown = endOf(graph, wide, 'f');
								const { t } = closestOnRoad(graph, street, shown.x, shown.y);
								const on = roadAt(graph, street, t)!;
								const [dx, dy] = [shown.x - on.point.x, shown.y - on.point.y];
								if (Math.abs(Math.abs(dx * on.normal.x + dy * on.normal.y) - walkway - 2) > 0.001)
									wrong.push(`${name}, widened: off the sidewalk's middle`);
								fresh(ui, 'widened');
							}

							// Dropped: leaving the street, its far end brought onto the
							// sidewalk 10 m on along the street.
							if (!along) {
								const { ui, graph } = open();
								const from = endOf(graph, wide, 'f');
								const to = sidewalkAt(t0 + 10 / 120);
								ui.click(from.x, from.y);
								ui.drag(from, to);
								missed(`${name}, dropped`, endOf(graph, wide, 'f'), to);
								const node = graph.nodes.get('q')!;
								if (node.x !== q.x || node.y !== q.y)
									wrong.push(`${name}, dropped: the joint moved`);
								fresh(ui, 'dropped');
							}
						}
	expect(wrong).toEqual([]);
}, 30_000);

// The same pair with the joint itself on a street's sidewalk: the narrow
// path comes in from outside the street and ends on the sidewalk's middle,
// and the wide one leaves square across the street, shifted 3 or 4 m (up
// to half its width) so its end shows on the same sidewalk as far along.
// Both ends
// lie on the sidewalk, so the joint is joined to it and slides along it,
// held by the end of its wider footpath (heldFirst in core/networks.ts),
// whichever path's id sorts first: dragged 12 m along either way, the wide
// end shows on the sidewalk's middle where it comes nearest where the drag
// took it, to the millimetre, and the joint lies where it lies with the ids
// the other way round. On a straight or a curved street, either side,
// stored either way; drawn as a fresh build draws it.
test('a joint of a 2 m and an 8 m path on a sidewalk slides held by the wide end, whichever id sorts first', () => {
	const wrong: string[] = [];
	const walkway = 4.5;
	const placed = new Map<string, Pt>();
	for (const curved of [false, true])
		for (const side of [1, -1])
			for (const shift of [3, 4])
				for (const out of [true, false])
					for (const by of [12, -12])
						for (const narrowFirst of [true, false]) {
							const [narrow, wide] = narrowFirst ? ['a-narrow', 'b-wide'] : ['b-narrow', 'a-wide'];
							const arrangement = `${curved ? 'curved' : 'straight'}, side ${side}, shifted ${shift}, stored ${out ? 'out' : 'in'}, dragged ${by}`;
							const name = `${arrangement}, ${narrow} and ${wide}`;
							const [a, b] = [p(-75, 0), p(75, 0)];
							const bow = curved ? { controlX: 0, controlY: -20 * side } : {};
							const road = { ...bow, offsetStart: 0, offsetEnd: 0 };
							const at = shownAt(road, a, b, 95 / 150);
							const k = Math.sign(at.normal.y * side) || 1;
							const outward = p(at.normal.x * k, at.normal.y * k);
							const j = p(at.point.x + outward.x * walkway, at.point.y + outward.y * walkway);
							// The wide path's way from the joint, across the street, and
							// its shift (as stored from the joint) that shows its end
							// `shift` m along the street: its right lies along it there.
							const dir = p(-outward.x, -outward.y);
							const s = shift * Math.sign(-dir.y * at.tangent.x + dir.x * at.tangent.y);
							const f = p(j.x + dir.x * 30, j.y + dir.y * 30);
							const h = p(j.x + outward.x * 25, j.y + outward.y * 25);
							const ui = openEditor({
								nodes: [
									{ id: 'w', ...a },
									{ id: 'e', ...b },
									{ id: 'j', ...j },
									{ id: 'f', ...f },
									{ id: 'h', ...h }
								],
								segments: [
									{
										id: 'street',
										startNodeId: 'w',
										endNodeId: 'e',
										lanes: createLanesFrom('street'),
										...bow
									},
									{ id: narrow, startNodeId: 'h', endNodeId: 'j', lanes: walk(2) },
									{
										id: wide,
										startNodeId: out ? 'j' : 'f',
										endNodeId: out ? 'f' : 'j',
										lanes: walk(8),
										offsetStart: out ? s : -s,
										offsetEnd: out ? s : -s
									}
								]
							});
							const graph = ui.editor.graph;
							const held = ui.editor.roadRenderer.derived?.sidewalks.get('j') ?? [];
							if (held.length !== 2 || held[0].path !== wide)
								wrong.push(`${name}: held by ${held.map((o) => o.path)}`);
							const before = endOf(graph, wide, 'j');
							const ring = nodePoint(graph, graph.nodes.get('j')!);
							const move = p(at.tangent.x * by, at.tangent.y * by);
							const aim = p(before.x + move.x, before.y + move.y);
							const lines = held[0] ? (walkwayOf(ui.editor, held[0])?.lines ?? []) : [];
							const want = lines
								.flatMap((l) => l.slice(1).map((q, i) => nearestOnChord(aim, l[i], q)))
								.sort((x, y) => x.d - y.d)[0]?.at;
							ui.click(ring.x, ring.y);
							ui.drag(ring, p(ring.x + move.x, ring.y + move.y), {}, 6);
							const shown = endOf(graph, wide, 'j');
							if (!want) wrong.push(`${name}: no sidewalk`);
							else if (Math.hypot(shown.x - want.x, shown.y - want.y) > 0.001)
								wrong.push(
									`${name}: the wide end shows at (${shown.x}, ${shown.y}), not (${want.x}, ${want.y})`
								);
							const node = p(ui.node('j').x, ui.node('j').y);
							const other = placed.get(arrangement);
							if (!other) placed.set(arrangement, node);
							else if (Math.hypot(node.x - other.x, node.y - other.y) > 1e-9)
								wrong.push(`${name}: placed otherwise than with the ids the other way round`);
							if (ui.stale().length) wrong.push(`${name}: stale`);
						}
	expect(wrong).toEqual([]);
});

// The same joint, the street's far end swung: the joint rides by the wide
// end, the end of the path it is held by (heldFirst in core/networks.ts),
// which shows at its place along and across the street to the millimetre,
// and the joint lies where it lies whichever path's id sorts first and
// whichever path was added first.
test('a joint of a 2 m and an 8 m path on a sidewalk rides by the wide end, whichever path was added or sorts first', () => {
	const wrong: string[] = [];
	const walkway = 4.5;
	const placed = new Map<string, Pt>();
	for (const curved of [false, true])
		for (const side of [1, -1])
			for (const shift of [3, 4])
				for (const out of [true, false])
					for (const narrowFirst of [true, false])
						for (const narrowAdded of [true, false]) {
							const [narrow, wide] = narrowFirst ? ['a-narrow', 'b-wide'] : ['b-narrow', 'a-wide'];
							const arrangement = `${curved ? 'curved' : 'straight'}, side ${side}, shifted ${shift}, stored ${out ? 'out' : 'in'}`;
							const name = `${arrangement}, ${narrow} and ${wide}${narrowAdded ? ', the narrow added first' : ''}`;
							const [a, b] = [p(-75, 0), p(75, 0)];
							const bow = curved ? { controlX: 0, controlY: -20 * side } : {};
							const at = shownAt({ ...bow, offsetStart: 0, offsetEnd: 0 }, a, b, 95 / 150);
							const k = Math.sign(at.normal.y * side) || 1;
							const outward = p(at.normal.x * k, at.normal.y * k);
							const j = p(at.point.x + outward.x * walkway, at.point.y + outward.y * walkway);
							const dir = p(-outward.x, -outward.y);
							const s = shift * Math.sign(-dir.y * at.tangent.x + dir.x * at.tangent.y);
							const paths = [
								{ id: narrow, startNodeId: 'h', endNodeId: 'j', lanes: walk(2) },
								{
									id: wide,
									startNodeId: out ? 'j' : 'f',
									endNodeId: out ? 'f' : 'j',
									lanes: walk(8),
									offsetStart: out ? s : -s,
									offsetEnd: out ? s : -s
								}
							];
							const ui = openEditor({
								nodes: [
									{ id: 'w', ...a },
									{ id: 'e', ...b },
									{ id: 'j', ...j },
									{ id: 'f', ...p(j.x + dir.x * 30, j.y + dir.y * 30) },
									{ id: 'h', ...p(j.x + outward.x * 25, j.y + outward.y * 25) }
								],
								segments: [
									{
										id: 'street',
										startNodeId: 'w',
										endNodeId: 'e',
										lanes: createLanesFrom('street'),
										...bow
									},
									...(narrowAdded ? paths : [...paths].reverse())
								]
							});
							const graph = ui.editor.graph;
							const street = graph.segments.get('street')!;
							const before = endOf(graph, wide, 'j');
							const { t } = closestOnRoad(graph, street, before.x, before.y);
							const was = roadAt(graph, street, t)!;
							const [dx, dy] = [before.x - was.point.x, before.y - was.point.y];
							const [u, v] = [
								dx * was.tangent.x + dy * was.tangent.y,
								dx * was.normal.x + dy * was.normal.y
							];
							ui.click(b.x, b.y);
							ui.drag(b, p(b.x, b.y - 18 * side), {}, 6);
							const now = roadAt(graph, street, t)!;
							const want = p(
								now.point.x + now.tangent.x * u + now.normal.x * v,
								now.point.y + now.tangent.y * u + now.normal.y * v
							);
							const shown = endOf(graph, wide, 'j');
							const by = Math.hypot(shown.x - want.x, shown.y - want.y);
							if (by > 0.001) wrong.push(`${name}: the wide end shows ${by} m off its place`);
							const node = p(ui.node('j').x, ui.node('j').y);
							const other = placed.get(arrangement);
							if (!other) placed.set(arrangement, node);
							else if (Math.hypot(node.x - other.x, node.y - other.y) > 1e-9)
								wrong.push(`${name}: placed otherwise than in another order`);
							if (ui.stale().length) wrong.push(`${name}: stale`);
						}
	expect(wrong).toEqual([]);
});

// A shifted footpath whose two nodes both move in a gesture is never placed
// against the other, which may be moving too (placedBy in core/drag.ts:
// carried). A node riding keeps its own place relative to the road at the
// spot where its end shows; a node dragged moves by the pointer's travel;
// each worked out from where things lay when the gesture began, so where
// they go is the same however many pointer updates it took. A footpath
// along a Street's or an Avenue's sidewalk, both its ends riding, shifted
// more at one end than the other, straight or curved, stored either way:
// the street dragged bodily, or a T's arm swung about the junction at its
// length, both ends show exactly where the street carried them; the
// street's end dragged, which stretches it, each node keeps its place at
// its end's spot and each end stays on the sidewalk's middle within
// carriedWithin. The 2 m and 8 m pair, the wide path's far node on the far
// sidewalk, both nodes dragged together: the wide end shows where the drag
// took it, whichever path's id sorts first. Three short curved paths in a
// ring, all riding a street whose end is dragged: none turns round.
test('a shifted footpath whose two nodes both move is carried as one with no shift is', () => {
	const wrong: string[] = [];
	const near = (name: string, at: Pt, want: Pt) => {
		const by = Math.hypot(at.x - want.x, at.y - want.y);
		if (by > 1e-9) wrong.push(`${name}: ${by} m off`);
	};
	for (const [preset, walkway] of Object.entries(presets))
		for (const down of [false, true])
			for (const bent of [false, true]) {
				const key = preset.toLowerCase() as 'street' | 'avenue';
				const y = walkway - 2.5;
				const name = `${preset}, ${down ? 'stored west' : 'stored east'}${bent ? ', curved' : ''}`;
				// Showing 0.5 m out at its west end and 1.5 m at its east.
				const open = (t: boolean) => {
					const [a, b] = t ? [p(20, y), p(40, y)] : [p(-20, y), p(20, y)];
					const nodes: Record<string, [number, number]> = {
						w: [-60, 0],
						e: [60, 0],
						a: [a.x, a.y],
						b: [b.x, b.y],
						...(t && { o: [0, 0], s: [0, -80] })
					};
					const city = cityOf(nodes, [
						...(t
							? [
									{ id: 'west', from: 'w', to: 'o', lanes: key },
									{ id: 'street', from: 'o', to: 'e', lanes: key },
									{ id: 'stem', from: 'o', to: 's', lanes: key }
								]
							: [{ id: 'street', from: 'w', to: 'e', lanes: key }]),
						{
							id: 'path',
							from: down ? 'b' : 'a',
							to: down ? 'a' : 'b',
							lanes: 'path' as const,
							...(bent && { control: p((a.x + b.x) / 2, y - 0.5) })
						}
					]);
					const path = city.segments.at(-1)!;
					[path.offsetStart, path.offsetEnd] = down ? [-1.5, -0.5] : [0.5, 1.5];
					const ui = openEditor(city);
					const ends = () => ['a', 'b'].map((id) => endOf(ui.editor.graph, 'path', id));
					return { ui, ends };
				};
				// Dragged bodily: both ends move as the street did.
				{
					const { ui, ends } = open(false);
					const before = ends();
					ui.click(40, 0);
					ui.drag(p(40, 0), p(47, -5), {}, 6);
					ends().forEach((at, k) =>
						near(`${name}, dragged bodily`, at, p(before[k].x + 7, before[k].y - 5))
					);
					if (ui.stale().length) wrong.push(`${name}, dragged bodily: stale`);
				}
				// Swung about the junction at its length.
				{
					const { ui, ends } = open(true);
					const before = ends();
					const turn = Math.PI / 12;
					const [c, sn] = [Math.cos(turn), Math.sin(turn)];
					ui.click(60, 0);
					ui.drag(p(60, 0), p(60 * c, 60 * sn), {}, 6);
					ends().forEach((at, k) =>
						near(
							`${name}, swung`,
							at,
							p(before[k].x * c - before[k].y * sn, before[k].x * sn + before[k].y * c)
						)
					);
					if (ui.stale().length) wrong.push(`${name}, swung: stale`);
				}
				// The street's end dragged: each node keeps its place at its end's
				// spot, and each end stays on the sidewalk, the same in one
				// pointer update as in 32.
				const placed = [1, 32].map((steps) => {
					const { ui, ends } = open(false);
					const graph = ui.editor.graph;
					const places = ['a', 'b'].map((id, k) =>
						placeOn(graph, 'street', ends()[k], graph.nodes.get(id)!)
					);
					const gaps = ends().map((end) => offWalkway(ui, 'street', end));
					const within = ['a', 'b'].map((id) => carriedWithin(graph, 'path', id, 'street'));
					ui.click(60, 0);
					ui.drag(p(60, 0), p(55, 14), {}, steps);
					['a', 'b'].forEach((id, k) => {
						near(
							`${name}, street's end dragged in ${steps}: ${id}`,
							graph.nodes.get(id)!,
							keptOn(graph, 'street', places[k])
						);
						const off = Math.abs(offWalkway(ui, 'street', ends()[k]) - gaps[k]);
						if (off > within[k]())
							wrong.push(
								`${name}, street's end dragged in ${steps}: ${id}'s end moved ${off} m across`
							);
					});
					if (ui.stale().length) wrong.push(`${name}, street's end dragged: stale`);
					return JSON.stringify(ui.saved());
				});
				if (placed[0] !== placed[1])
					wrong.push(`${name}: stored otherwise by 1 and 32 pointer updates`);
			}

	// The 2 m and 8 m pair, the wide path's far node on the far sidewalk,
	// both nodes dragged 10 m east together.
	for (const side of [1, -1])
		for (const reverse of [false, true])
			for (const narrowFirst of [true, false]) {
				const [narrow, wide] = narrowFirst ? ['a-narrow', 'b-wide'] : ['b-narrow', 'a-wide'];
				const name = `pair, side ${side}, ${reverse ? 'stored in' : 'stored out'}, ${narrow} and ${wide}`;
				const stored = [1, 32].map((steps) => {
					const city = cityOf(
						{
							w: [-75, 0],
							e: [75, 0],
							j: [20, 4.5 * side],
							f: [20, -4.5 * side],
							h: [20, 25 * side]
						},
						[
							{ id: 'street', from: 'w', to: 'e', lanes: 'street' },
							{ id: narrow, from: 'h', to: 'j', lanes: 'path' },
							{ id: wide, from: reverse ? 'f' : 'j', to: reverse ? 'j' : 'f', lanes: 'path' }
						]
					);
					city.segments[1].lanes[0].width = 2;
					const w = city.segments[2];
					w.lanes[0].width = 8;
					w.offsetStart = w.offsetEnd = (reverse ? -1 : 1) * 3 * side;
					const ui = openEditor(city);
					const graph = ui.editor.graph;
					const ring = (id: string) => nodePoint(graph, graph.nodes.get(id)!);
					const [j, f] = [ring('j'), ring('f')];
					ui.click(j.x, j.y);
					ui.click(f.x, f.y, { shift: true });
					ui.drag(j, p(j.x + 10, j.y), {}, steps);
					near(`${name}, in ${steps}`, endOf(graph, wide, 'j'), p(33, 4.5 * side));
					near(`${name}, in ${steps}`, endOf(graph, wide, 'f'), p(33, -4.5 * side));
					if (ui.stale().length) wrong.push(`${name}, in ${steps}: stale`);
					return JSON.stringify(ui.saved());
				});
				if (stored[0] !== stored[1])
					wrong.push(`${name}: stored otherwise by 1 and 32 pointer updates`);
			}

	// Three short curved paths in a ring, shifted up to 9 m, all three nodes
	// riding a street whose end is dragged: none turns round.
	const rings = [1, 6, 32].map((steps) => {
		const city = cityOf({ w: [-45, 0], e: [45, 0], a: [-2, 2.1], b: [0, 2.3], c: [2.8, 4.3] }, [
			{ id: 'street', from: 'w', to: 'e', lanes: 'street' },
			{ id: 'ab', from: 'a', to: 'b', lanes: 'path', control: p(-7.4, 14) },
			{ id: 'bc', from: 'b', to: 'c', lanes: 'path', control: p(-2.2, 15.6) },
			{ id: 'ca', from: 'c', to: 'a', lanes: 'path' }
		]);
		const shifts = [
			[-1.4, -9.1],
			[7.6, 6.3],
			[3, 9.4]
		];
		city.segments.slice(1).forEach((s, k) => ([s.offsetStart, s.offsetEnd] = shifts[k]));
		const ui = openEditor(city);
		const graph = ui.editor.graph;
		const was = ['ab', 'bc', 'ca'].map((id) => chordOf(graph, id));
		ui.drag(p(45, 0), p(61, -26), {}, steps);
		['ab', 'bc', 'ca'].forEach((id, k) => {
			if (!unturned(graph, id, was[k])) wrong.push(`ring in ${steps}: ${id} turned round`);
		});
		if (ui.stale().length) wrong.push(`ring in ${steps}: stale`);
		return JSON.stringify(ui.saved());
	});
	if (new Set(rings).size !== 1)
		wrong.push('ring: stored otherwise by 1, 6 and 32 pointer updates');
	expect(wrong).toEqual([]);
});

// A T of Streets, arms west, east and north (or south) of (0, 0), and
// shifted footpaths whose two nodes both move as one of its streets or its
// centre moves (placedBy in core/drag.ts: carried). Each end keeps as far
// from the middle of the sidewalks of the street it shows on (their corners
// included) as it was, within carriedWithin, or lands on that middle (an
// end keeping to a corner is put back on it); no footpath turns round; and
// where the nodes go is the same in 1 and 32 pointer updates and whatever
// the paths' ids or the order they were added in. Where all three streets
// are dragged together, every node moves as they did, exactly. The scenes:
// - a path from the east arm's sidewalk to the south arm's, both ends
//   riding, stored either way, the T's centre moved;
// - a path between the two corners either side of the north arm, both
//   keeping to their corners, the east arm's end dragged or the centre
//   moved;
// - a 2 m path joined to an 8 m path shifted 3 m at the joint, the joint
//   riding the east arm's sidewalk and the wide path's far node keeping to
//   the south-west corner: the three streets dragged bodily (the wide end
//   lands at (27, 1.5)), the east arm's end dragged, or the centre moved;
// - a 2 m path joined to a curved 8 m path shifted 3 or 4 m along its
//   length, stored either way, either id first, either added first, the
//   joint on the junction and its far node on the east arm's roadway, the
//   centre moved or the three streets dragged.
test('a shifted footpath whose two nodes both move at a T keeps its ends on the walkways they showed on', () => {
	const wrong: string[] = [];
	const T: Record<string, [number, number]> = { w: [-75, 0], o: [0, 0], e: [75, 0], n: [0, 72] };
	const streets = [
		{ id: 'west', from: 'w', to: 'o', lanes: 'street' as const },
		{ id: 'east', from: 'o', to: 'e', lanes: 'street' as const },
		{ id: 'north', from: 'o', to: 'n', lanes: 'street' as const }
	];
	type Roads = Parameters<typeof cityOf>[1];
	const shifted = (
		nodes: Record<string, [number, number]>,
		roads: Roads,
		shifts: Record<string, [number, number]>,
		widths: Record<string, number> = {},
		perPixel?: number
	) => {
		const city = cityOf(nodes, roads);
		for (const s of city.segments) {
			if (shifts[s.id]) [s.offsetStart, s.offsetEnd] = shifts[s.id];
			if (widths[s.id]) s.lanes[0].width = widths[s.id];
		}
		return openEditor(city, perPixel);
	};
	// Each footpath end of `paths` at `at`, the street whose walkway it
	// shows on, before and after `move`; checked, and the graph stored.
	const check = (
		name: string,
		ui: Ui,
		ends: [path: string, node: string, street: string, rides: boolean][],
		move: () => void
	) => {
		const graph = ui.editor.graph;
		const paths = [...new Set(ends.map(([path]) => path))];
		const was = paths.map((id) => chordOf(graph, id));
		const gaps = ends.map(([path, node, street]) =>
			offWalkway(ui, street, endOf(graph, path, node))
		);
		const within = ends.map(([path, node, street, rides]) =>
			carriedWithin(graph, path, node, rides ? street : null)
		);
		move();
		ends.forEach(([path, node, street], k) => {
			const gap = offWalkway(ui, street, endOf(graph, path, node));
			const off = Math.min(Math.abs(gap - gaps[k]), gap);
			if (off > within[k]())
				wrong.push(`${name}: ${path}'s end at ${node} moved ${off} m across its walkway`);
		});
		paths.forEach((id, k) => {
			if (!unturned(graph, id, was[k])) wrong.push(`${name}: ${id} turned round`);
		});
		if (ui.stale().length) wrong.push(`${name}: stale`);
		return JSON.stringify(ui.saved());
	};
	const same = (name: string, stored: string[]) => {
		const graphs = stored.map((g) => JSON.parse(g) as GraphData);
		for (const g of graphs.slice(1))
			g.nodes.forEach((n, k) => {
				const was = graphs[0].nodes[k];
				const by = Math.hypot(n.x - was.x, n.y - was.y);
				if (n.id !== was.id || by > 1e-9)
					wrong.push(`${name}: ${n.id} placed ${by} m otherwise by pointer updates`);
			});
	};
	// The three streets selected and dragged by (3, 6) in `steps` pointer
	// updates: every node of `nodes` moves by that, exactly.
	const dragAll = (ui: Ui, nodes: string[], steps: number) => () => {
		const graph = ui.editor.graph;
		const before = nodes.map((id) => p(graph.nodes.get(id)!.x, graph.nodes.get(id)!.y));
		ui.click(-35, 0);
		ui.click(0, 40, { shift: true });
		ui.click(35, 0, { shift: true });
		ui.drag(p(35, 0), p(38, 6), {}, steps);
		nodes.forEach((id, k) => {
			const node = graph.nodes.get(id)!;
			const by = Math.hypot(node.x - before[k].x - 3, node.y - before[k].y - 6);
			if (by > 1e-9) wrong.push(`all three dragged in ${steps}: ${id} moved ${by} m off (3, 6)`);
		});
	};

	// A path between the east and south arms' sidewalks.
	const south = { ...T, n: [0, -72] } as Record<string, [number, number]>;
	for (const down of [false, true])
		same(
			`two arms ${down ? 'down' : 'up'}`,
			[1, 32].map((steps) => {
				const ui = shifted(
					{ ...south, a: [20, -4.5], b: [4.5, -20] },
					[...streets, { id: 'path', from: down ? 'b' : 'a', to: down ? 'a' : 'b', lanes: 'path' }],
					{ path: down ? [-0.6, -0.3] : [0.3, 0.6] }
				);
				return check(
					`two arms ${down ? 'down' : 'up'}, centre moved in ${steps}`,
					ui,
					[
						['path', 'a', 'east', true],
						['path', 'b', 'north', true]
					],
					() => ui.drag(p(0, 0), p(2, 5), {}, steps)
				);
			})
		);

	// A path between the corners either side of the north arm.
	for (const [move, from, to] of [
		['arm', p(75, 0), p(78, 9)],
		['centre', p(0, 0), p(-2, 4)]
	] as const)
		same(
			`corners, ${move}`,
			[1, 32].map((steps) => {
				const ui = shifted(
					{
						...T,
						a: [-5.671572875253809, 5.67157287525381],
						b: [5.67157287525381, 5.671572875253808]
					},
					[...streets, { id: 'path', from: 'a', to: 'b', lanes: 'path' }],
					{ path: [0.4, 0.4] }
				);
				return check(
					`corners, ${move} in ${steps}`,
					ui,
					[
						['path', 'a', 'north', false],
						['path', 'b', 'north', false]
					],
					() => ui.drag(from, to, {}, steps)
				);
			})
		);

	// The joint riding the east arm and the wide path's far node on the
	// south-west corner.
	const joint = () =>
		shifted(
			{
				...T,
				j: [23.6088933804952, -1.5256033196327823],
				f: [0.9883720930232561, -4.5],
				h: [45.42113570318813, 1.3425118900690869]
			},
			[
				...streets,
				{ id: 'narrow', from: 'h', to: 'j', lanes: 'path' },
				{ id: 'wide', from: 'j', to: 'f', lanes: 'path' }
			],
			{ wide: [3, 0] },
			{ narrow: 2, wide: 8 },
			0.055
		);
	const jointEnds: [string, string, string, boolean][] = [
		['wide', 'j', 'east', true],
		['wide', 'f', 'west', false]
	];
	same(
		'joint, all three dragged',
		[1, 32].map((steps) => {
			const ui = joint();
			const stored = check(
				`joint, all three dragged in ${steps}`,
				ui,
				jointEnds,
				dragAll(ui, ['j', 'f', 'h'], steps)
			);
			const end = endOf(ui.editor.graph, 'wide', 'j');
			if (Math.hypot(end.x - 27, end.y - 1.5) > 1e-9)
				wrong.push(
					`joint, all three dragged in ${steps}: the wide end shows at (${end.x}, ${end.y})`
				);
			return stored;
		})
	);
	for (const [move, from, to] of [
		['arm', p(75, 0), p(72, 10)],
		['centre', p(0, 0), p(2, 5)]
	] as const)
		same(
			`joint, ${move}`,
			[1, 32].map((steps) => {
				const ui = joint();
				return check(`joint, ${move} in ${steps}`, ui, jointEnds, () =>
					ui.drag(from, to, {}, steps)
				);
			})
		);

	// A curved 8 m path from the junction to the east arm.
	for (const reverse of [false, true])
		for (const shift of [3, 4])
			for (const move of ['centre', 'all'] as const) {
				const stored: string[] = [];
				for (const narrowFirst of [true, false])
					for (const narrowAdded of [true, false])
						for (const steps of move === 'centre' && narrowFirst && narrowAdded ? [1, 32] : [1]) {
							const narrow = {
								id: narrowFirst ? 'a-narrow' : 'z-narrow',
								from: 'h',
								to: 'j',
								lanes: 'path' as const
							};
							const wideId = narrowFirst ? 'z-wide' : 'a-wide';
							const wide = {
								id: wideId,
								from: reverse ? 'f' : 'j',
								to: reverse ? 'j' : 'f',
								lanes: 'path' as const,
								control: p(-2, -7)
							};
							const by = shift * (reverse ? -1 : 1);
							const ui = shifted(
								{ ...T, n: [0, 70], j: [-2, -1.5], f: [17, -0.4], h: [-2, 18] },
								[...streets, ...(narrowAdded ? [narrow, wide] : [wide, narrow])],
								{ [wideId]: [by, by] },
								{ [wideId]: 8 },
								0.04
							);
							const name = `curved, ${reverse ? 'in' : 'out'}, shifted ${shift}, ${narrow.id}${narrowAdded ? ' added first' : ''}, ${move} in ${steps}`;
							const graph = ui.editor.graph;
							const ends: [string, string, string, boolean][] = [[wideId, 'f', 'east', true]];
							check(
								name,
								ui,
								ends,
								move === 'all'
									? dragAll(ui, ['j', 'f', 'h'], steps)
									: () => ui.drag(p(0, 0), p(1, 12), {}, steps)
							);
							stored.push(
								JSON.stringify({ nodes: ['j', 'f', 'h'].map((id) => graph.nodes.get(id)) })
							);
						}
				same(`curved, ${reverse ? 'in' : 'out'}, shifted ${shift}, ${move}`, stored);
			}
	expect(wrong).toEqual([]);
}, 30_000);

// Every street a footpath touches moved by one rigid motion moves every
// node and handle of that footpath by that motion, exactly, however many
// pointer updates the drag took: a node riding keeps its place relative to
// the road at the spot where its end shows (ridersOf in core/drag.ts), a
// node kept to a corner keeps its place relative to the spot of the corner
// its end held when the press began (followWalkway in modes/picking.ts),
// and a curve is placed once both its nodes have their places
// (bentAfter). No gesture turns a selection, so the motion is a drag: the
// T's three streets selected and dragged, or its four nodes. An 8 m path
// shifted 3 m at one end and 3 or 4 m at the other: from an arm's sidewalk
// to the corner south of the T or the one north-east of it, between the
// corners either side of the north arm, or along the east arm's sidewalk;
// straight or curved; alone, or with a 2 m path at its first node whose
// other node rides the T (so it moves as one too) or lies free (so only the
// wide path does); the T as drawn or mirrored (so every side swaps), the
// wide path stored either way, the narrow one's id and place in the list
// first or last, each scene one of those, the T's streets or its nodes
// dragged in turn; 1, 2 and 32 pointer updates. Then three scenes
// that went wrong: a straight path shifted 3 m at both ends from the east
// arm's sidewalk to the south corner, and two curved ones from there with
// no shift at the corner. A node with no shift at it (the curved scenes'
// corner end) follows its corner as it always did, from build to build
// (placedBy: 'lies'), within a millimetre.
test('every node and handle of a footpath moves with the T it touches, dragged whole', () => {
	const wrong: string[] = [];
	const T: Record<string, [number, number]> = { w: [-75, 0], o: [0, 0], e: [75, 0], n: [0, 72] };
	const streets = [
		{ id: 'west', from: 'w', to: 'o', lanes: 'street' as const },
		{ id: 'east', from: 'o', to: 'e', lanes: 'street' as const },
		{ id: 'north', from: 'o', to: 'n', lanes: 'street' as const }
	];
	// The middle of each corner of the T's junction as drawn.
	const bare = openEditor(cityOf(T, streets), 0.055).editor.roadRenderer.scene!;
	const junction = bare.place.junctions.find((j) => j.id.endsWith('o'))!;
	const middles = (bare.node(junction.id)?.walkways ?? []).map(
		(w) => w.line[Math.floor(w.line.length / 2)]
	);
	const ne = middles.find((c) => c.x > 1 && c.y > 1)!;
	const nw = middles.find((c) => c.x < -1 && c.y > 1)!;
	const south = middles.find((c) => c.y < -1)!;
	// Where a footpath's nodes lie for its ends to show at s0 and s1.
	const placed = (s0: Pt, s1: Pt, shift: [number, number], c?: Pt) => {
		const seg = { offsetStart: shift[0], offsetEnd: shift[1], controlX: c?.x, controlY: c?.y };
		let [a, b] = [s0, s1];
		for (let k = 0; k < 200; k++) {
			const [e0, e1] = [shownAt(seg, a, b, 0).point, shownAt(seg, a, b, 1).point];
			a = p(a.x + s0.x - e0.x, a.y + s0.y - e0.y);
			b = p(b.x + s1.x - e1.x, b.y + s1.y - e1.y);
		}
		return { a, b };
	};
	type Scene = {
		name: string;
		mirror: boolean;
		j: Pt;
		f: Pt;
		h?: Pt;
		control?: Pt;
		shift: [number, number];
		reversed: boolean;
		narrowFirst: boolean;
		gesture: 'streets' | 'nodes';
		// The nodes moving as one with the T, and those with no shift.
		rigid: string[];
		within: Record<string, number>;
	};
	const run = (s: Scene, steps: number) => {
		const sign = s.mirror ? -1 : 1;
		const tee = Object.fromEntries(
			Object.entries(T).map(([k, [x, y]]) => [k, [x, y * sign]])
		) as Record<string, [number, number]>;
		const [wideId, narrowId] = s.narrowFirst ? ['z-wide', 'a-narrow'] : ['a-wide', 'z-narrow'];
		const wide = {
			id: wideId,
			from: s.reversed ? 'f' : 'j',
			to: s.reversed ? 'j' : 'f',
			lanes: 'path' as const,
			...(s.control && { control: s.control })
		};
		const narrow = {
			id: narrowId,
			from: s.reversed ? 'j' : 'h',
			to: s.reversed ? 'h' : 'j',
			lanes: 'path' as const
		};
		const paths = !s.h ? [wide] : s.narrowFirst ? [narrow, wide] : [wide, narrow];
		const city = cityOf(
			{ ...tee, j: [s.j.x, s.j.y], f: [s.f.x, s.f.y], ...(s.h && { h: [s.h.x, s.h.y] }) },
			[...streets, ...paths]
		);
		for (const seg of city.segments) {
			if (seg.id === wideId) {
				seg.lanes[0].width = 8;
				[seg.offsetStart, seg.offsetEnd] = s.reversed ? [-s.shift[1], -s.shift[0]] : s.shift;
			}
			if (seg.id === narrowId) seg.lanes[0].width = 2;
		}
		const ui = openEditor(city, 0.055);
		const graph = ui.editor.graph;
		const name = `${s.name} in ${steps}`;
		if (!ui.editor.roadRenderer.derived?.sidewalks.get('f') && s.name.includes('corner'))
			wrong.push(`${name}: not set up on its walkway`);
		const at = (id: string) => p(graph.nodes.get(id)!.x, graph.nodes.get(id)!.y);
		const handle = () => {
			const w = graph.segments.get(wideId)!;
			return w.hasControlPoint ? p(w.controlX!, w.controlY!) : null;
		};
		const before = new Map(s.rigid.map((id) => [id, at(id)]));
		const curve = handle();
		const by = p(3, 6);
		if (s.gesture === 'streets') {
			ui.click(-35, 0);
			ui.click(0, 50 * sign, { shift: true });
			ui.click(65, 0, { shift: true });
			ui.drag(p(65, 0), p(65 + by.x, by.y), {}, steps);
		} else {
			ui.click(75, 0);
			ui.click(-75, 0, { shift: true });
			ui.click(0, 72 * sign, { shift: true });
			ui.click(0, 0, { shift: true });
			ui.drag(p(75, 0), p(75 + by.x, by.y), {}, steps);
		}
		const off = (q: Pt, was: Pt) => Math.hypot(q.x - was.x - by.x, q.y - was.y - by.y);
		if (off(at('o'), p(0, 0)) > 1e-9) wrong.push(`${name}: the T did not move`);
		for (const [id, was] of before) {
			const by = off(at(id), was);
			if (by > (s.within[id] ?? 1e-9)) wrong.push(`${name}: ${id} ${by} m off the T's motion`);
		}
		const now = handle();
		if (curve && now && off(now, curve) > (s.within.f ?? 1e-9))
			wrong.push(`${name}: the handle ${off(now, curve)} m off the T's motion`);
		if (ui.stale().length) wrong.push(`${name}: stale`);
		return JSON.stringify([...before.keys()].map(at));
	};
	const layouts: [string, Pt, Pt][] = [
		['from the east arm to the south corner', p(24, -4.5), south],
		['from the east arm to the north-east corner', p(24, 4.5), ne],
		['between two corners', nw, ne],
		['along the east arm', p(20, -4.5), p(50, -4.5)]
	];
	const scenes: [Scene, number[]][] = [];
	let i = 0;
	for (const [layout, S0, S1] of layouts)
		for (const bow of [0, 0.08])
			for (const narrow of ['none', 'riding', 'free'] as const) {
				for (const [k, variant] of [[Math.floor(i / 4) % 2, i % 4]]) {
					const mirror = (variant & 1) === 1;
					const reversed = variant === 1 || variant === 2;
					const sign = mirror ? -1 : 1;
					const m = (q: Pt) => p(q.x, q.y * sign);
					const shift: [number, number] = [3 * sign, (variant < 2 ? 3 : 4) * sign];
					const control = bow ? fromFrame(m(S0), m(S1), { u: 0.5, v: bow * sign }) : undefined;
					const { a, b } = placed(m(S0), m(S1), shift, control);
					// The narrow path's other node on the roadway of the arm or
					// the north street, or off the T.
					const h =
						narrow === 'none'
							? undefined
							: narrow === 'free'
								? p(a.x + 6, a.y - 24 * sign)
								: layout === 'between two corners'
									? p(Math.sign(a.x) * 2, 30 * sign)
									: p(a.x + (layout === 'along the east arm' ? -10 : 22), m(S0).y / 3);
					scenes.push([
						{
							name: `${layout}${bow ? ', curved' : ''}, the narrow path ${narrow === 'none' ? 'away' : narrow}, shifted ${shift}${mirror ? ', mirrored' : ''}${reversed ? ', stored the other way' : ''}, ${variant < 2 ? 'narrow' : 'wide'} first, ${k ? 'nodes' : 'streets'} dragged`,
							mirror,
							j: a,
							f: b,
							h,
							control,
							shift,
							reversed,
							narrowFirst: variant < 2,
							gesture: k ? 'nodes' : 'streets',
							rigid: narrow === 'riding' ? ['j', 'f', 'h'] : ['j', 'f'],
							within: {}
						},
						[1, 2, 32]
					]);
				}
				i++;
			}
	const corner = 0.9883720930232561;
	for (const [name, j, f, h, control, far] of [
		['straight', p(24, -1.5), p(corner, -1.5), p(46, -1.5), undefined, 3],
		[
			'curved',
			p(24.50301875587087, -1.5424719559669224),
			p(corner, -4.5),
			p(46.19155774544677, -5.2312761656866185),
			p(12.494186046511627, 0.5),
			0
		],
		[
			'curved less',
			p(23.737258454919775, -1.5115276677725697),
			p(corner, -4.5),
			p(45.6527222245876, 0.4152436628157432),
			p(12.494186046511627, -2.5),
			0
		]
	] as const)
		scenes.push([
			{
				name: `the east arm to the south corner, ${name}, shifted 3 and ${far}`,
				mirror: false,
				j,
				f,
				h,
				control,
				shift: [3, far],
				reversed: false,
				narrowFirst: false,
				gesture: 'streets',
				rigid: ['j', 'f', 'h'],
				within: far ? {} : { f: 0.001 }
			},
			[1, 32]
		]);
	for (const [scene, counts] of scenes) {
		const stored = counts.map((steps) => run(scene, steps));
		if (!scene.within.f && new Set(stored).size > 1)
			wrong.push(`${scene.name}: placed otherwise by other pointer updates`);
	}
	expect(wrong).toEqual([]);
}, 60_000);

// A move refused puts the curve the follower placed back too
// (Editor.putBackFollowed): a curved 8 m path shifted 3 m between the
// corners either side of a T's north arm, the three streets dragged south
// till the north arm crosses another street and let go there, leaves every
// node and the handle where they were.
test('a refused drag of a T puts back the curve of a footpath between its corners', () => {
	const T: Record<string, [number, number]> = { w: [-75, 0], o: [0, 0], e: [75, 0], n: [0, 72] };
	const streets = [
		{ id: 'west', from: 'w', to: 'o', lanes: 'street' as const },
		{ id: 'east', from: 'o', to: 'e', lanes: 'street' as const },
		{ id: 'north', from: 'o', to: 'n', lanes: 'street' as const }
	];
	const bare = openEditor(cityOf(T, streets), 0.055).editor.roadRenderer.scene!;
	const junction = bare.place.junctions.find((j) => j.id.endsWith('o'))!;
	const middles = (bare.node(junction.id)?.walkways ?? []).map(
		(w) => w.line[Math.floor(w.line.length / 2)]
	);
	const [nw, ne] = [
		middles.find((c) => c.x < -1 && c.y > 1)!,
		middles.find((c) => c.x > 1 && c.y > 1)!
	];
	const c = fromFrame(nw, ne, { u: 0.5, v: 0.08 });
	const seg = { offsetStart: 3, offsetEnd: 3, controlX: c.x, controlY: c.y };
	let [a, b] = [nw, ne];
	for (let k = 0; k < 200; k++) {
		const [e0, e1] = [shownAt(seg, a, b, 0).point, shownAt(seg, a, b, 1).point];
		a = p(a.x + nw.x - e0.x, a.y + nw.y - e0.y);
		b = p(b.x + ne.x - e1.x, b.y + ne.y - e1.y);
	}
	const city = cityOf({ ...T, j: [a.x, a.y], f: [b.x, b.y], x: [-30, -40], y: [30, -40] }, [
		...streets,
		{ id: 'bar', from: 'x', to: 'y', lanes: 'street' },
		{ id: 'wide', from: 'j', to: 'f', lanes: 'path', control: c }
	]);
	const wide = city.segments.at(-1)!;
	wide.lanes[0].width = 8;
	[wide.offsetStart, wide.offsetEnd] = [3, 3];
	const ui = openEditor(city, 0.055);
	const before = JSON.stringify(ui.graph());
	ui.click(-35, 0);
	ui.click(0, 50, { shift: true });
	ui.click(65, 0, { shift: true });
	ui.fire('mousedown', 65, 0);
	for (let k = 1; k <= 5; k++) ui.fire('mousemove', 65, -10 * k);
	const path = ui.editor.graph.segments.get('wide')!;
	expect(path.controlY).toBeCloseTo(c.y - 50, 6);
	ui.fire('mouseup', 65, -50);
	expect(JSON.stringify(ui.graph())).toBe(before);
	expect(ui.stale()).toEqual([]);
});

// A footpath node of two footpaths whose ends show apart, each shifted its
// own way (north-west and south-east of the node, or onto two streets'
// sidewalks), and a street's dead end moved from the west onto where the
// node's ring shows (the middle of its ends) or onto one end. It joins the
// node only where it meets one of the node's ends, never at the middle of
// them, where no footpath is; the drawing kept from build to build draws as
// a fresh build does.
const twoEnds = (shifts: [number, number], stored: number, streets: boolean): GraphData => {
	const arms = [
		{ id: 'A', far: { x: -30, y: 30 }, shift: shifts[0] },
		{ id: 'B', far: { x: 30, y: -30 }, shift: shifts[1] }
	];
	return {
		nodes: [
			{ id: 'j', x: 0, y: 0 },
			{ id: 'x', x: -60, y: 0 },
			{ id: 'y', x: -40, y: 0 },
			...arms.map((a) => ({ id: `${a.id}far`, ...a.far })),
			...(streets
				? [
						{ id: 'n0', x: -60, y: 12 },
						{ id: 'n1', x: 60, y: 12 },
						{ id: 's0', x: -60, y: -12 },
						{ id: 's1', x: 60, y: -12 }
					]
				: [])
		],
		segments: [
			{ id: 'stub', startNodeId: 'x', endNodeId: 'y', lanes: createLanesFrom('street') },
			...(streets
				? ['n', 's'].map((k) => ({
						id: k,
						startNodeId: `${k}0`,
						endNodeId: `${k}1`,
						lanes: createLanesFrom('street')
					}))
				: []),
			// Stored from the node out (bit k of `stored` clear) or in: its
			// shift flips with it, so it shows the same.
			...arms.map((a, k) => {
				const out = ((stored >> k) & 1) === 0;
				return {
					id: a.id,
					startNodeId: out ? 'j' : `${a.id}far`,
					endNodeId: out ? `${a.id}far` : 'j',
					lanes: walk(2),
					offsetStart: out ? a.shift : -a.shift,
					offsetEnd: out ? a.shift : -a.shift
				};
			})
		]
	};
};
test("a street's dead end moved onto a footpath node whose ends show apart joins it only where it meets an end, as a fresh build draws it", () => {
	const wrong: string[] = [];
	const cases: [[number, number], boolean][] = [
		[[-7.5 * Math.SQRT2, -7.5 * Math.SQRT2], true],
		[[4, 4], false],
		[[-6, 3], false],
		[[0, 8], false]
	];
	for (const [shifts, streets] of cases)
		for (let stored = 0; stored < 4; stored++) {
			const data = twoEnds(shifts, stored, streets);
			const ends = (graph: ReturnType<typeof liveShape>) =>
				['A', 'B'].map((id) => {
					const s = graph.segments.get(id)!;
					const at = roadAt(graph as never, s as never, s.startNodeId === 'j' ? 0 : 1)!;
					return at.point;
				});
			const graph = liveShape(data);
			const [a, b] = ends(graph);
			for (const [where, to, joins] of [
				['the middle', nodePoint(graph as never, graph.nodes.get('j')!), false],
				['the first end', a, true],
				['the second end', b, true]
			] as const) {
				if (Math.hypot(a.x - b.x, a.y - b.y) < 0.01 && where === 'the middle') continue;
				const moved = liveShape(data);
				const networks = new Networks();
				networks.build(moved as never);
				Object.assign(moved.nodes.get('y')!, to);
				Object.assign(moved.nodes.get('x')!, { x: to.x - 20, y: to.y });
				const live = networks.build(moved as never).scene;
				const fresh = new Networks().build(moved as never).scene;
				const name = `${shifts} stored ${stored} onto ${where}`;
				if (JSON.stringify([...drawn(live)]) !== JSON.stringify([...drawn(fresh)]))
					wrong.push(`${name}: drawn otherwise than a fresh build`);
				const fill = fresh.place.junctions.find((j) => j.id.endsWith(':j'));
				const joined = !!fill?.key?.startsWith('joint');
				if (joined !== joins) wrong.push(`${name}: ${joined ? 'joined' : 'not joined'}`);
			}
		}
	expect(wrong).toEqual([]);
});

test("a one-way lane's dead end moved onto a bend's footpath end shown off the bend's paving joins it, as a fresh build draws it", () => {
	// Two footpaths leaving (0, 0) a sharp angle apart, the wide one shifted
	// 5.1 m: the bend's paving passes inside the node, and the wide one's end
	// shows at (4, -3.2), metres off it and off its own strip, cut back by
	// the bend. A one-way lane (1.75 m half wide) moved from the north-east
	// till its dead end lies there.
	const width = (w: number) => walk(w);
	const graph = liveShape({
		nodes: [
			{ id: 'j', x: 0, y: 0 },
			{ id: 'a', x: -34, y: -21 },
			{ id: 'b', x: -24, y: -30 },
			{ id: 'd', x: 40, y: 20 },
			{ id: 'e', x: 80, y: 20 }
		],
		segments: [
			{
				id: 'A',
				startNodeId: 'j',
				endNodeId: 'a',
				lanes: width(2),
				offsetStart: -1.25,
				offsetEnd: -1.25
			},
			{
				id: 'B',
				startNodeId: 'j',
				endNodeId: 'b',
				lanes: width(6.5),
				offsetStart: 5.1,
				offsetEnd: 5.1
			},
			{ id: 'lane', startNodeId: 'd', endNodeId: 'e', lanes: [lane('vehicle', 3.5)] }
		]
	});
	const networks = new Networks();
	networks.build(graph as never);
	const end = roadAt(graph as never, graph.segments.get('B') as never, 0)!.point;
	Object.assign(graph.nodes.get('d')!, end);
	Object.assign(graph.nodes.get('e')!, { x: end.x + 40, y: end.y });
	const live = networks.build(graph as never).scene;
	const fresh = new Networks().build(graph as never).scene;
	expect(drawn(live)).toEqual(drawn(fresh));
	expect(fresh.place.junctions.find((j) => j.id.endsWith(':j'))?.key?.startsWith('joint')).toBe(
		true
	);
});

// Two footpaths meeting at (0, 0), one running west and one east, shifted
// so their ends there show `apart` m north and south of the node, and car
// roads whose dead ends are moved onto where those ends show, from the north
// and the south or from the west and the east: each end joins the dead end
// it shows on, whether one is there or both, its joint holding that road's
// sidewalks carried on past its end; the same from build to build as in a
// fresh build. Each footpath stored either way, on the app's Street and
// Avenue.
const inRing = (ring: { x: number; y: number }[], q: { x: number; y: number }) => {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [a, b] = [ring[i], ring[j]];
		if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x)
			inside = !inside;
	}
	return inside;
};
test('a footpath node whose two ends show on two dead ends joins both, each where its end shows', () => {
	const wrong: string[] = [];
	for (const preset of ['street', 'avenue'] as const)
		for (const apart of [12, 16])
			for (const from of ['north and south', 'west and east'] as const)
				for (let stored = 0; stored < 4; stored++)
					for (const which of ['north', 'south', 'both'] as const) {
						const out = (k: number) => ((stored >> k) & 1) === 0;
						// The west footpath shows `apart` north of its line (its right
						// stored eastward), the east one `apart` south.
						const ends = { north: p(0, apart), south: p(0, -apart) };
						const far = (end: 'north' | 'south') =>
							from === 'north and south'
								? p(0, ends[end].y + (end === 'north' ? 40 : -40))
								: p(end === 'north' ? -40 : 40, ends[end].y);
						const graph = liveShape({
							nodes: [
								{ id: 'j', x: 0, y: 0 },
								{ id: 'w', x: -30, y: 0 },
								{ id: 'e', x: 30, y: 0 },
								...(['north', 'south'] as const).flatMap((end) => [
									{ id: `${end}Far`, ...p(far(end).x + 100, far(end).y) },
									{ id: `${end}End`, ...p(far(end).x + 100, far(end).y + 5) }
								])
							],
							segments: [
								{
									id: 'west',
									startNodeId: out(0) ? 'w' : 'j',
									endNodeId: out(0) ? 'j' : 'w',
									lanes: walk(2),
									offsetStart: out(0) ? apart : -apart,
									offsetEnd: out(0) ? apart : -apart
								},
								{
									id: 'east',
									startNodeId: out(1) ? 'j' : 'e',
									endNodeId: out(1) ? 'e' : 'j',
									lanes: walk(2),
									offsetStart: out(1) ? -apart : apart,
									offsetEnd: out(1) ? -apart : apart
								},
								...(['north', 'south'] as const).map((end) => ({
									id: end,
									startNodeId: `${end}Far`,
									endNodeId: `${end}End`,
									lanes: createLanesFrom(preset)
								}))
							]
						});
						const networks = new Networks();
						networks.build(graph as never);
						for (const end of ['north', 'south'] as const) {
							if (which !== 'both' && which !== end) continue;
							Object.assign(graph.nodes.get(`${end}Far`)!, far(end));
							Object.assign(graph.nodes.get(`${end}End`)!, ends[end]);
						}
						const live = networks.build(graph as never).scene;
						const fresh = new Networks().build(graph as never).scene;
						const name = `${preset} ${apart} m apart from the ${from}, stored ${stored}, ${which}`;
						if (JSON.stringify([...drawn(live)]) !== JSON.stringify([...drawn(fresh)]))
							wrong.push(`${name}: drawn otherwise than a fresh build`);
						// The ground its joint paves.
						const fill = fresh.place.junctions.find((j) => j.id.endsWith(':j'));
						const rings = (fill ? (fresh.node(fill.id)?.surfaces ?? []) : []).flatMap((s) =>
							Array.isArray(s.shape) ? s.shape : []
						);
						const lanes = createLanesFrom(preset);
						// Across each road from its line: its sidewalks' middles.
						const total = lanes.reduce((w, l) => w + l.width, 0);
						let left = -total / 2;
						const across: number[] = [];
						for (const l of lanes) {
							if (l.role === 'pedestrian') across.push(left + l.width / 2);
							left += l.width;
						}
						for (const end of ['north', 'south'] as const) {
							const there = which === 'both' || which === end;
							// Its sidewalks held a metre past its end.
							const [d, back] = [ends[end], far(end)];
							const l = Math.hypot(d.x - back.x, d.y - back.y);
							const [ux, uy] = [(d.x - back.x) / l, (d.y - back.y) / l];
							const joined = across.every((o) =>
								rings.some((r) => inRing(r, p(d.x + ux - uy * o, d.y + uy + ux * o)))
							);
							if (joined !== there)
								wrong.push(`${name}: ${end} ${joined ? 'joined' : 'not joined'}`);
						}
					}
	expect(wrong).toEqual([]);
});

// A footpath node joins the car dead end at each spot its ends show, by
// the rule it always had at one spot: the one car road end showing there,
// none where two or more show there. The node's west footpath is shifted
// 12 m, so its end shows at (0, 12), on the dead end of a road from the
// north; its east footpath's end shows at the node, (0, 0), on the dead end
// of a road from the south where there is one. Another car road's dead end
// at the same spot as the north one, or 5 mm off, or a car node three roads
// end at 5 mm off, leaves that spot joining nothing; 2 cm off, it shows
// elsewhere and the north dead end is joined. Whatever lies at (0, 12), the
// south dead end is joined at its own spot. So the footpaths are paved
// (Scene.footpathPaving: before they are laid over the cars) exactly as
// with the other roads at (0, 12) gone, and the north one gone too where
// that spot joins nothing; a dead end joined has its sidewalks held 1.5 m
// past its end. The same live as fresh.
test('a footpath node joins the dead end at each spot its ends show only where one car road ends there', () => {
	const wrong: string[] = [];
	for (const preset of ['street', 'avenue'] as const)
		for (const [extra, off, joins] of [
			['nothing', 0, true],
			['a dead end at the same spot', 0, false],
			['a dead end 5 mm off', 0.005, false],
			['a dead end 2 cm off', 0.02, true],
			['a junction of three roads 5 mm off', 0.005, false],
			['a junction of three roads 2 cm off', 0.02, true]
		] as const)
			for (const south of [false, true])
				for (const reversed of [false, true]) {
					const end = p(0, 12);
					const extras =
						extra === 'nothing'
							? []
							: extra.startsWith('a junction')
								? [p(40, 12), p(-30, 52), p(30, 52)]
								: [p(40, 12)];
					const city = (north: boolean, others: boolean) => {
						const outs = others ? extras : [];
						return {
							nodes: [
								{ id: 'j', x: 0, y: 0 },
								{ id: 'w', x: -30, y: 0 },
								{ id: 'e', x: 30, y: 0 },
								...(north
									? [
											{ id: 'end', ...end },
											{ id: 'far', x: 0, y: 52 }
										]
									: []),
								...(outs.length ? [{ id: 'near', x: off, y: 12 + off }] : []),
								...outs.map((q, k) => ({ id: `out${k}`, ...q })),
								...(south
									? [
											{ id: 'southFar', x: 0, y: -40 },
											{ id: 'southEnd', x: 0, y: 0 }
										]
									: [])
							],
							segments: [
								{
									id: 'west',
									startNodeId: reversed ? 'j' : 'w',
									endNodeId: reversed ? 'w' : 'j',
									lanes: walk(2),
									offsetStart: reversed ? -12 : 12,
									offsetEnd: reversed ? -12 : 12
								},
								{
									id: 'east',
									startNodeId: reversed ? 'e' : 'j',
									endNodeId: reversed ? 'j' : 'e',
									lanes: walk(2),
									offsetStart: 0,
									offsetEnd: 0
								},
								...(north
									? [
											{
												id: 'north',
												startNodeId: 'far',
												endNodeId: 'end',
												lanes: createLanesFrom(preset)
											}
										]
									: []),
								...outs.map((_, k) => ({
									id: `extra${k}`,
									startNodeId: `out${k}`,
									endNodeId: 'near',
									lanes: createLanesFrom(preset)
								})),
								...(south
									? [
											{
												id: 'south',
												startNodeId: 'southFar',
												endNodeId: 'southEnd',
												lanes: createLanesFrom(preset)
											}
										]
									: [])
							]
						} as GraphData;
					};
					const paving = (scene: ReturnType<Networks['build']>['scene']) =>
						JSON.stringify(['west', 'east'].map((id) => scene.footpathPaving(id)));
					// Built first with the car roads away, then moved in.
					const graph = liveShape(city(true, true));
					const cars = [...graph.nodes.keys()].filter((id) => !['j', 'w', 'e'].includes(id));
					const networks = new Networks();
					for (const id of cars) graph.nodes.get(id)!.x += 200;
					networks.build(graph as never);
					for (const id of cars) graph.nodes.get(id)!.x -= 200;
					const live = networks.build(graph as never).scene;
					const fresh = new Networks().build(graph as never).scene;
					const name = `${preset} with ${extra}${south ? ' and a dead end at the node' : ''}${reversed ? ', footpaths stored the other way' : ''}`;
					if (JSON.stringify([...drawn(live)]) !== JSON.stringify([...drawn(fresh)]))
						wrong.push(`${name}: drawn otherwise than a fresh build`);
					const as = new Networks().build(liveShape(city(joins, false)) as never).scene;
					if (paving(fresh) !== paving(as))
						wrong.push(
							`${name}: paved otherwise than with ${joins ? 'the north dead end alone' : 'nothing'} at (0, 12)`
						);
					const rings = ['west', 'east']
						.flatMap((id) => fresh.footpathPaving(id))
						.flatMap(({ description: d }) => ('surfaces' in d ? d.surfaces : []))
						.flatMap((s) => (Array.isArray(s.shape) ? s.shape : []));
					const held = (q: { x: number; y: number }) => rings.some((r) => inRing(r, q));
					const lanes = createLanesFrom(preset);
					const total = lanes.reduce((w, l) => w + l.width, 0);
					let left = -total / 2;
					for (const l of lanes) {
						// The north road runs south to its end and the south one
						// north to its: each sidewalk's middle `o` m across, 1.5 m
						// past its end.
						const o = left + l.width / 2;
						left += l.width;
						if (l.role !== 'pedestrian') continue;
						if (held(p(o, end.y - 1.5)) !== joins)
							wrong.push(
								`${name}: the north dead end's sidewalk ${o} m across ${joins ? 'not ' : ''}held`
							);
						if (held(p(o, 1.5)) !== south)
							wrong.push(
								`${name}: the south dead end's sidewalk ${o} m across ${south ? 'not ' : ''}held`
							);
					}
				}
	expect(wrong).toEqual([]);
});

// Where a footpath's node goes for its end to show at a point (endsAt):
// short curved footpaths carried in their frame as a drag bends them, with
// large and uneven shifts, the handle anywhere from steeply off the chord to
// on either node, either end placed, its far node lying still. Asked to show where it shows now, nothing moves.
// Otherwise, wherever asked, the end shows where it was asked to (read by
// shownAt) with the chord turned less than a right angle from the way it
// ran, or from where a footpath with no shift would run (its node moved by
// as much as its end was asked to), or else its node moves so.
test('a short curved footpath placed by where its end shows never turns round', () => {
	const wrong: string[] = [];
	const near = (q: { x: number; y: number }, r: { x: number; y: number }, within = 1e-9) =>
		Math.hypot(q.x - r.x, q.y - r.y) <= within;
	for (const length of [2, 4, 8])
		for (const [u, v] of [
			[0, -2.5],
			[0.5, -1],
			[1.2, 0.8],
			[-0.4, 0.6],
			[0, 0],
			[1, 0]
		])
			for (const [s0, s1] of [
				[8, 20],
				[20, 8],
				[-8, 3],
				[0, 12],
				[6, -6]
			])
				for (const moved of ['start', 'end'] as const) {
					const a = p(0, 0);
					const b = p(length, 0);
					const frame = { u, v };
					const segment = { startNodeId: 'a', endNodeId: 'b', offsetStart: s0, offsetEnd: s1 };
					const shown = (q: { start: Pt; end: Pt }, t: number) => {
						const c = fromFrame(q.start, q.end, frame);
						return shownAt({ ...segment, controlX: c.x, controlY: c.y }, q.start, q.end, t).point;
					};
					const was = { start: a, end: b };
					const t = moved === 'start' ? 0 : 1;
					const mine = shown(was, t);
					const off = {
						start: p(a.x - shown(was, 0).x, a.y - shown(was, 0).y),
						end: p(b.x - shown(was, 1).x, b.y - shown(was, 1).y)
					};
					for (const [dx, dy] of [
						[0, 0],
						[0.2, 0.1],
						[1, 0],
						[-1, 0],
						[0, 1],
						[0, -1],
						[3, 2],
						[-3, -2],
						[8, 0],
						[-8, 0]
					]) {
						const target = p(mine.x + dx, mine.y + dy);
						const node = endsAt(
							segment,
							{ heading: p(length, 0), off, frame },
							moved,
							target,
							moved === 'start' ? b : a
						);
						const got = moved === 'start' ? { start: node, end: b } : { start: a, end: node };
						const name = `${length} m, handle at (${u}, ${v}), shifted ${s0} to ${s1}, ${moved} moved by (${dx}, ${dy})`;
						if (dx === 0 && dy === 0) {
							const was = moved === 'start' ? a : b;
							if (!near(node, p(was.x + dx, was.y + dy)))
								wrong.push(`${name}: not moved as far as its end was asked to`);
							continue;
						}
						// Where a footpath with no shift would go: its node moved by
						// as much as its end was asked to, its far node lying still.
						const lies = p(target.x + off[moved].x, target.y + off[moved].y);
						const asMoved = near(node, lies);
						const toward =
							moved === 'start' ? p(b.x - lies.x, b.y - lies.y) : p(lies.x - a.x, lies.y - a.y);
						const [cx, cy] = [got.end.x - got.start.x, got.end.y - got.start.y];
						const unturned = cx > 0 || cx * toward.x + cy * toward.y > 0;
						if (!asMoved && !(unturned && near(shown(got, t), target, 1e-6)))
							wrong.push(
								`${name}: neither shows where asked, unturned, nor moved as its end was asked to`
							);
					}
				}
	expect(wrong).toEqual([]);
});

// The same with the curve's handle left where it is (a footpath end kept
// on a walkway its street draws anew): its end shows wherever asked at
// least its shift from the handle, its node on the handle (where the
// footpath leaves it no way and shows no shift) or off it, where the node
// that shows it there leaves the chord turned less than a right angle from
// the way it ran or from where a footpath with no shift would run;
// elsewhere its node moves by as much as its end was asked to, as that
// footpath's would.
test('a curved footpath placed by where its end shows, its handle left in place, shows it where asked unless that turns it round', () => {
	const wrong: string[] = [];
	for (const b of [p(4, 0), p(20, 0)])
		for (const [hx, hy] of [
			[0, 0],
			[2, -5],
			[10, 8]
		])
			for (const [s0, s1] of [
				[8, 20],
				[-6, 0],
				[0, 5]
			]) {
				const a = p(0, 0);
				const handle = p(hx, hy);
				const segment = { startNodeId: 'a', endNodeId: 'b', offsetStart: s0, offsetEnd: s1 };
				const curved = { ...segment, controlX: hx, controlY: hy };
				const now = shownAt(curved, a, b, 0).point;
				const off = { start: p(a.x - now.x, a.y - now.y), end: p(0, 0) };
				for (const [dx, dy] of [
					[0, 0],
					[0.5, 0],
					[0, 2],
					[-3, 1],
					[12, -9],
					[20, 0]
				]) {
					const target = p(now.x + dx, now.y + dy);
					const got = { start: endsAt(segment, { heading: b, off, handle }, 'start', target, b) };
					const at = shownAt(curved, got.start, b, 0).point;
					const name = `to (${b.x}, 0), handle at (${hx}, ${hy}), shifted ${s0} to ${s1}, moved by (${dx}, ${dy})`;
					if (dx === 0 && dy === 0 && Math.hypot(got.start.x - a.x, got.start.y - a.y) > 1e-9)
						wrong.push(`${name}: moved`);
					// Where the node lies for its end to show at the target, leaving
					// toward the handle: one of the two points from which the
					// target lies |s0| off the line to the handle, on its side.
					const [ex, ey] = [target.x - hx, target.y - hy];
					const far = Math.hypot(ex, ey);
					const answer =
						far < Math.abs(s0)
							? null
							: [1, -1]
									.map((k) => {
										const along = Math.sqrt(far * far - s0 * s0);
										const [c, sn] = [along / far, (k * Math.abs(s0)) / far];
										return p(
											hx + along * ((c * ex) / far - (sn * ey) / far),
											hy + along * ((sn * ex) / far + (c * ey) / far)
										);
									})
									.find((q) => {
										const shows = shownAt(curved, q, b, 0).point;
										return Math.hypot(shows.x - target.x, shows.y - target.y) < 1e-6;
									});
					const lies = p(target.x + off.start.x, target.y + off.start.y);
					const unturned =
						answer &&
						(b.x - answer.x > 0 ||
							(b.x - answer.x) * (b.x - lies.x) + (b.y - answer.y) * (b.y - lies.y) > 0);
					if (unturned && Math.hypot(at.x - target.x, at.y - target.y) > 1e-6)
						wrong.push(`${name}: shows ${at.x}, ${at.y}`);
					if (!unturned && Math.hypot(got.start.x - lies.x, got.start.y - lies.y) > 1e-9)
						wrong.push(
							`${name}: lies at ${got.start.x}, ${got.start.y}, not moved as its end was asked to`
						);
				}
			}
	expect(wrong).toEqual([]);
});

// A short curved footpath with large, uneven shifts, one end showing on a
// street dragged along its length: that end keeps where it showed on the
// street, the footpath stays the same path (its far node on the side of
// where the end shows it was on, along the chord), and where its nodes go
// is the same however many pointer updates the drag took. Stored either
// way, with the handle steeply off the chord or bowing it gently.
test('a short curved footpath with large shifts riding a dragged street stays the same path', () => {
	const wrong: string[] = [];
	for (const reversed of [false, true])
		for (const handle of [p(0, -10), p(2, 6)])
			for (const [sa, sb] of [
				[8, 20],
				[8, 2],
				[-8, -20]
			])
				for (const by of [1, -3]) {
					const name = `${reversed ? 'stored from its far end, ' : ''}handle at (${handle.x}, ${handle.y}), shifted ${sa} at the riding end and ${sb} at the other, street dragged ${by} m`;
					const runs = [1, 6].map((steps) => {
						const [a, b] = [p(0, 0), p(4, 0)];
						const path = {
							startNodeId: reversed ? 'b' : 'a',
							endNodeId: reversed ? 'a' : 'b',
							offsetStart: reversed ? -sb : sa,
							offsetEnd: reversed ? -sa : sb,
							controlX: handle.x,
							controlY: handle.y
						};
						const t = reversed ? 1 : 0;
						const [from, to] = reversed ? [b, a] : [a, b];
						const shown = shownAt(path, from, to, t).point;
						const city = cityOf(
							{ a: [a.x, a.y], b: [b.x, b.y], s: [shown.x, -60], n: [shown.x, 60] },
							[{ id: 'street', from: 's', to: 'n', lanes: 'street' }]
						);
						city.segments.push({
							id: 'path',
							lanes: createLanesFrom('path'),
							...path
						} as GraphData['segments'][number]);
						const ui = openEditor(city);
						const graph = ui.editor.graph;
						const ends = () => {
							const [na, nb] = [graph.nodes.get('a')!, graph.nodes.get('b')!];
							return { a: p(na.x, na.y), b: p(nb.x, nb.y), shown: endOf(graph, 'path', 'a') };
						};
						// How far along the chord from a the far node lies past
						// where a's end shows.
						const side = (q: ReturnType<typeof ends>) =>
							((q.b.x - q.shown.x) * (q.b.x - q.a.x) + (q.b.y - q.shown.y) * (q.b.y - q.a.y)) /
							Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
						const before = ends();
						ui.click(shown.x, 35);
						ui.drag(p(shown.x, 35), p(shown.x, 35 + by), {}, steps);
						const after = ends();
						if (Math.hypot(after.shown.x - shown.x, after.shown.y - shown.y - by) > 1e-3)
							wrong.push(
								`${name}, ${steps} updates: end shows at ${after.shown.x}, ${after.shown.y}`
							);
						if (side(before) * side(after) < 0)
							wrong.push(`${name}, ${steps} updates: turned inside out`);
						return after;
					});
					const [one, six] = runs;
					if (
						Math.hypot(one.a.x - six.a.x, one.a.y - six.a.y) > 1e-9 ||
						Math.hypot(one.b.x - six.b.x, one.b.y - six.b.y) > 1e-9
					)
						wrong.push(`${name}: placed otherwise by 1 and 6 pointer updates`);
				}
	expect(wrong).toEqual([]);
});

// A footpath shorter than its shifts, one end showing on a street that is
// dragged across and along itself: straight or curved (its handle beside a
// node, as one drawn with a slight curve has it, or well off the chord),
// shifted either way, the long shift at the riding end or the far one,
// riding by its start or its end, stored either way, on 2 m and 8 m paths.
// A node rides where its end shows on the street's ground as the drag
// begins (Networks.onGround); its end then shows where the street took it,
// its chord turned less than a right angle from the way it ran or from
// where the street's move takes a footpath with no shift, or else its node
// moves with the street as that footpath's would. A node that does not ride stays. Never turned
// round, the same whatever the pointer did, and drawn as a fresh build
// draws it.
test('a footpath shorter than its shifts riding a dragged street never turns round', () => {
	const wrong: string[] = [];
	let [exact, asMoved] = [0, 0];
	const near = (q: Pt, r: Pt, within = 1e-9) => Math.hypot(q.x - r.x, q.y - r.y) <= within;
	for (const length of [2, 8])
		for (const handle of [null, p(0.05, 0), p(-length, length / 2)])
			for (const [sa, sb] of [
				[1.0125, -0.75],
				[-1.0125, 0.75],
				[0.75, 1.0125],
				[-2, -2.5]
			].map(([x, y]) => [x * length, y * length]))
				for (const riding of ['a', 'b'] as const)
					for (const reversed of [false, true]) {
						const path = {
							id: 'path',
							startNodeId: reversed ? 'b' : 'a',
							endNodeId: reversed ? 'a' : 'b',
							lanes: createLanesFrom('path'),
							offsetStart: reversed ? -sb : sa,
							offsetEnd: reversed ? -sa : sb,
							...(handle && { controlX: handle.x, controlY: handle.y })
						};
						const [a, b] = [p(0, 0), p(0, length)];
						const [from, to] = reversed ? [b, a] : [a, b];
						const shows = (node: 'a' | 'b') =>
							shownAt(path, from, to, (node === 'a') === !reversed ? 0 : 1).point;
						const [S, O] = [shows(riding), shows(riding === 'a' ? 'b' : 'a')];
						const away = Math.hypot(S.x - O.x, S.y - O.y);
						const dir = away > 1e-6 ? p((S.x - O.x) / away, (S.y - O.y) / away) : p(1, 0);
						const across = p(-dir.y, dir.x);
						for (const [move, by] of [
							['across', p(across.x * 0.2, across.y * 0.2)],
							['back across', p(across.x * -1.5, across.y * -1.5)],
							['along, away from its dead end', p(dir.x * -2, dir.y * -2)]
						] as const) {
							const name = `${length} m, handle ${handle ? `at (${handle.x}, ${handle.y})` : 'none'}, shifted ${sa} to ${sb}, riding by ${riding}${reversed ? ', stored the other way' : ''}, street dragged ${move}`;
							const runs = [1, 6].map((steps) => {
								const city = cityOf(
									{
										a: [a.x, a.y],
										b: [b.x, b.y],
										s: [S.x - dir.x * 2, S.y - dir.y * 2],
										n: [S.x + dir.x * 75, S.y + dir.y * 75]
									},
									[{ id: 'street', from: 's', to: 'n', lanes: 'street' }]
								);
								city.segments.push(path as GraphData['segments'][number]);
								const ui = openEditor(city);
								const graph = ui.editor.graph;
								const lies = (id: string) => p(graph.nodes.get(id)!.x, graph.nodes.get(id)!.y);
								const rides = new Set(
									ui.editor.roadRenderer.onGround(['street'], ['s', 'n']).keys()
								);
								const grip = p(S.x + dir.x * 40, S.y + dir.y * 40);
								ui.click(grip.x, grip.y);
								ui.drag(grip, p(grip.x + by.x, grip.y + by.y), {}, steps);
								if (ui.stale().length)
									wrong.push(`${name}, ${steps} updates: drawn otherwise than fresh`);
								return {
									rides,
									a: lies('a'),
									b: lies('b'),
									shown: { a: endOf(graph, 'path', 'a'), b: endOf(graph, 'path', 'b') }
								};
							});
							const [one, six] = runs;
							if (!near(one.a, six.a) || !near(one.b, six.b))
								wrong.push(`${name}: placed otherwise by 1 and 6 pointer updates`);
							// Turned less than a right angle from the way it ran or from
							// where the street's move takes a footpath with no shift
							// (each node riding moved by as much, each other where it
							// lay).
							const [ma, mb] = (['a', 'b'] as const).map((node) => {
								const was = node === 'a' ? a : b;
								return one.rides.has(node) ? p(was.x + by.x, was.y + by.y) : was;
							});
							const [dx, dy] = [one.b.x - one.a.x, one.b.y - one.a.y];
							if (
								dx * (mb.x - ma.x) + dy * (mb.y - ma.y) <= 0 &&
								dx * (b.x - a.x) + dy * (b.y - a.y) <= 0
							)
								wrong.push(`${name}: turned round`);
							// Each node riding: its end where the street took it, or
							// moved by as much; each other where it lay.
							for (const node of ['a', 'b'] as const) {
								const [was, showed] = [node === 'a' ? a : b, shows(node)];
								const ends = near(one.shown[node], p(showed.x + by.x, showed.y + by.y), 1e-3);
								const moved = near(one[node], p(was.x + by.x, was.y + by.y));
								if (!one.rides.has(node)) {
									if (!near(one[node], was)) wrong.push(`${name}: ${node} moved, riding nothing`);
								} else if (ends) exact++;
								else if (moved) asMoved++;
								else
									wrong.push(
										`${name}: ${node} lies at (${one[node].x}, ${one[node].y}), its end shows at (${one.shown[node].x}, ${one.shown[node].y})`
									);
							}
						}
					}
	expect(wrong).toEqual([]);
	// The sweep reaches both: ends placed where they show, and nodes moved
	// as their ends were.
	expect(exact).toBeGreaterThan(0);
	expect(asMoved).toBeGreaterThan(0);
}, 30_000);

// Three footpaths in a ring on a street, each node riding by the end of a
// different one, so each one's far node rides by the next: chained, each is
// placed once from where things lay when the move began (ridersOf), so the
// ends land near their places but not on them. What holds: the street
// swung about its west end, the nodes go to the same places however many
// pointer updates the drag took, each footpath keeps its heading (turning
// no more than the street did, give or take a degree), every end it rides
// by shows within a centimetre of where it showed along and across the
// street (on these 34 m footpaths), and the editor draws what a fresh build
// does.
test('footpath nodes riding a swung street in a ring are placed once, the same whatever the pointer did', () => {
	const wrong: string[] = [];
	for (const bow of [22, 30])
		for (const swing of [-8, 6]) {
			const name = `bowed to ${bow}, east end swung ${swing} m`;
			const runs = [1, 32].map((steps) => {
				const city = cityOf({ w: [-90, 0], e: [90, 0], a: [-34, 3], b: [0, 3], c: [34, 3] }, [
					{ id: 'street', from: 'w', to: 'e', lanes: 'street' },
					{ id: 'ab', from: 'a', to: 'b', lanes: 'path' },
					{ id: 'bc', from: 'b', to: 'c', lanes: 'path' },
					{ id: 'ca', from: 'c', to: 'a', lanes: 'path', control: { x: 0, y: bow } }
				]);
				for (const [id, s, e] of [
					['ab', -2, 1.8],
					['bc', -2, 1.8],
					['ca', 2, -1.8]
				] as const)
					Object.assign(city.segments.find((x) => x.id === id)!, { offsetStart: s, offsetEnd: e });
				const ui = openEditor(city, 0.1);
				const graph = ui.editor.graph;
				const ends = () =>
					['ab', 'bc', 'ca'].flatMap((id) => {
						const s = graph.segments.get(id)!;
						return [roadAt(graph, s, 0)!.point, roadAt(graph, s, 1)!.point];
					});
				const chords = () =>
					['ab', 'bc', 'ca'].map((id) => {
						const s = graph.segments.get(id)!;
						const [a, b] = [graph.nodes.get(s.startNodeId)!, graph.nodes.get(s.endNodeId)!];
						return Math.atan2(b.y - a.y, b.x - a.x);
					});
				const before = ends();
				const headings = chords();
				ui.click(90, 0);
				ui.drag(p(90, 0), p(90, swing), {}, steps);
				// The street turned about (-90, 0) and stretched: each end the
				// same share along it and as far across it as it was.
				const r = Math.atan2(swing, 180);
				const stretch = Math.hypot(180, swing) / 180;
				const [cos, sin] = [Math.cos(r), Math.sin(r)];
				ends().forEach((q, k) => {
					const [along, across] = [(before[k].x + 90) * stretch, before[k].y];
					// Each node rides by its end showing nearest the street's line:
					// ab's start at a, bc's at b, ca's at c, each riding by the
					// next one's footpath.
					if (k % 2) return;
					const want = p(-90 + along * cos - across * sin, along * sin + across * cos);
					const off = Math.hypot(q.x - want.x, q.y - want.y);
					if (off > 0.01) wrong.push(`${name}, ${steps} updates: end ${k} shows ${off} m off`);
				});
				chords().forEach((h, k) => {
					const turn = Math.abs(
						Math.atan2(Math.sin(h - headings[k] - r), Math.cos(h - headings[k] - r))
					);
					if (turn > Math.PI / 180)
						wrong.push(
							`${name}, ${steps} updates: footpath ${k} turned ${turn} more than the street`
						);
				});
				if (ui.stale().length) wrong.push(`${name}, ${steps} updates: stale`);
				return ['a', 'b', 'c'].map((id) => p(graph.nodes.get(id)!.x, graph.nodes.get(id)!.y));
			});
			for (const run of runs.slice(1))
				if (run.some((q, k) => Math.hypot(q.x - runs[0][k].x, q.y - runs[0][k].y) > 1e-9))
					wrong.push(`${name}: placed otherwise by other pointer updates`);
		}
	expect(wrong).toEqual([]);
});

// A curved footpath whose two ends show at one spot, both on a street: the
// spot gives it no way to point, so riding the street it keeps the heading
// it had when the move began (endsAt) and moves along with the street,
// never turned round; stored either way, the same for one pointer update
// as for 32.
test('a footpath whose ends show at one spot rides a street without turning', () => {
	for (const reversed of [false, true])
		for (const steps of [1, 32]) {
			const city = cityOf({ w: [-80, 8], e: [80, 8], q: [0, 0], f: [0, 8] }, [
				{ id: 'street', from: 'w', to: 'e', lanes: 'street' },
				{
					id: 'path',
					from: reversed ? 'f' : 'q',
					to: reversed ? 'q' : 'f',
					lanes: 'path',
					control: p(20, 0)
				}
			]);
			Object.assign(
				city.segments[1],
				reversed ? { offsetStart: 0, offsetEnd: -8 } : { offsetStart: 8, offsetEnd: 0 }
			);
			const ui = openEditor(city);
			const graph = ui.editor.graph;
			expect(endOf(graph, 'path', 'q')).toEqual(p(0, 8));
			ui.click(55, 8);
			ui.drag(p(55, 8), p(55.2, 8), { ctrl: true }, steps);
			expect(ui.node('e').x).toBeCloseTo(80.2, 9);
			const path = graph.segments.get('path')!;
			for (const [got, want] of [
				[ui.node('q'), p(0.2, 0)],
				[ui.node('f'), p(0.2, 8)],
				[p(path.controlX!, path.controlY!), p(20.2, 0)]
			] as const) {
				expect(got.x).toBeCloseTo(want.x, 9);
				expect(got.y).toBeCloseTo(want.y, 9);
			}
			expect(ui.stale()).toEqual([]);
		}
});
