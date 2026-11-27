import { expect, test } from 'bun:test';
import { segmentEnds, sideToward } from '../src/lib/core/attach';
import { splitSegment } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { Networks } from '../src/lib/core/networks';
import { roadAt, roadLine } from '../src/lib/core/road-line';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { frameAt, samplePath } from '../src/lib/road-model/geometry';
import { buildModel, carDiff, carPart, liveShape } from './model';

// A road cut in two (core/crossings.ts, splitSegment), as drawing across it
// or the split tool does: the edits stored at the nodes it ended at name it,
// and must carry on applying to the half that ends there now.

const preset = (id: string): Lane[] => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));

// Stores which way each attached road sits, so its end lands on the edge
// `across` points to from the road it joins (as draw mode does).
function attach(data: GraphData, nodeId: string, across: Record<string, { x: number; y: number }>) {
	const graph = liveShape(data);
	const sides: Record<string, 'left' | 'right'> = {};
	for (const [id, toward] of Object.entries(across))
		sides[id] = sideToward(graph as never, graph.segments.get(id)!, nodeId, toward)!;
	const node = data.nodes.find((n) => n.id === nodeId)!;
	node.junction = { ...node.junction, sides };
}

// Cuts a road `t` of the way along where it shows (halfway unless given), as
// the split tool does.
function cut(data: GraphData, id: string, t = 0.5) {
	const graph = new Graph();
	graph.fromJSON(structuredClone(data));
	const segment = graph.segments.get(id)!;
	const at = roadAt(graph, segment, t)!.line;
	const node = graph.createNode(at.x, at.y);
	const halves = splitSegment(graph, segment, t, node.id)!;
	return { graph, left: halves.left.id, right: halves.right.id, node: node.id };
}

// How far p lies from the segment a–b.
const toSegment = (p: Pt, a: Pt, b: Pt) => {
	const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
	const f = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
	return Math.hypot(a.x + (b.x - a.x) * f - p.x, a.y + (b.y - a.y) * f - p.y);
};
type Pt = { x: number; y: number };

// A list in the model with one road's id put in another's place, in no
// particular order: a node lists its roads in the order they were made.
const renamed = (list: unknown[] | undefined, from: string, to: string) =>
	unordered(
		JSON.parse(
			JSON.stringify(list).replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}:`, `"${to}:`)
		)
	);
const unordered = (list: unknown[] | undefined) =>
	(list ?? []).map((x) => JSON.stringify(Array.isArray(x) ? [...x].sort() : x)).sort();

// How far a road is trimmed back from its node at one end.
const trim = (
	spans: Map<string, { d0: number; length: number; total: number }>,
	road: string,
	end: 'start' | 'end'
) => {
	const span = spans.get(road)!;
	return end === 'start' ? span.d0 : span.total - span.d0 - span.length;
};

// Where each crossing drawn on a road lies on the ground.
function crossingsOn(data: GraphData, ids: string[]) {
	const { scene } = buildModel(data);
	return scene.place.roads
		.filter((r) => ids.includes(r.id))
		.flatMap((r) => (r.crossings ?? []).map((c) => frameAt(samplePath(r), c.at).p));
}

test('a road cut in two keeps every edit stored at its ends, each on the half ending there', () => {
	// A street from a T junction at `a` north to an avenue at `b`, attached at
	// the avenue's south edge.
	const data: GraphData = {
		nodes: [
			{ id: 'w', x: -60, y: 0 },
			{ id: 'a', x: 0, y: 0 },
			{ id: 'e', x: 60, y: 0 },
			{ id: 'aw', x: -100, y: -100 },
			{ id: 'b', x: 0, y: -100 },
			{ id: 'ae', x: 100, y: -100 }
		],
		segments: [
			{ id: 'west', startNodeId: 'w', endNodeId: 'a', lanes: preset('street') },
			{ id: 'east', startNodeId: 'a', endNodeId: 'e', lanes: preset('street') },
			{ id: 'cut', startNodeId: 'a', endNodeId: 'b', lanes: preset('street') },
			{ id: 'avw', startNodeId: 'aw', endNodeId: 'b', lanes: preset('avenue') },
			{ id: 'ave', startNodeId: 'b', endNodeId: 'ae', lanes: preset('avenue') }
		]
	};
	attach(data, 'b', { cut: { x: 0, y: 1 } });
	const at = (ref: string) => ({ road: 'cut', end: 'start' as const, lane: ref });
	data.nodes[1].junction = {
		// A U-turn back down the road, and no left turn from it.
		added: [{ from: at('l1'), to: at('l2') }],
		removed: [{ from: at('l1'), to: { road: 'west', end: 'end', lane: 'l1' } }],
		control: { 'cut:start': 'stop' },
		setbacks: { cut: 12 },
		crossings: [{ road: 'cut', end: 'start', lanes: ['l0', 'l3'], at: 20 }]
	};
	// A crossing 70 m back from the avenue: on the half nearer `a` once cut.
	data.nodes[4].junction!.crossings = [{ road: 'cut', end: 'end', lanes: ['l0', 'l3'], at: 70 }];

	const { graph, left, right } = cut(data, 'cut');
	const before = buildModel(data).derived;
	const after = buildModel(graph.toJSON()).derived;

	// Each edit applies before the cut...
	const ta = before.junctions.get('a')!;
	const has = (list: typeof ta.connections, road: string, lane: string) =>
		list.some((c) => c.from.road === road && c.from.lane === 'l1' && c.to.lane === lane);
	expect(has(ta.connections, 'cut', 'l2')).toBe(true);
	expect(has(ta.connections, 'cut', 'l1')).toBe(false);
	expect(ta.control['cut:start']).toBe('stop');
	expect(trim(before.spans, 'cut', 'start')).toBeCloseTo(12);
	expect(before.junctions.get('b')!.sides).toEqual(['cut:end']);

	// ...and the same on the half ending at that node after it.
	const ja = after.junctions.get('a')!;
	expect(unordered(ja.connections)).toEqual(renamed(ta.connections, 'cut', left));
	expect(ja.control[`${left}:start`]).toBe('stop');
	expect(trim(after.spans, left, 'start')).toBeCloseTo(12);
	const tb = before.junctions.get('b')!;
	const jb = after.junctions.get('b')!;
	expect(unordered(jb.sides)).toEqual(renamed(tb.sides, 'cut', right));
	expect(unordered(jb.link)).toEqual(renamed(tb.link, 'cut', right));
	expect(jb.anchors![`${right}:end`]).toEqual(tb.anchors!['cut:end']);
	expect(trim(after.spans, right, 'end')).toBeCloseTo(trim(before.spans, 'cut', 'end'));

	// Both crossings are drawn where they were: one still at `a`, the one
	// 70 m from `b` on the near half, held by the node at the cut.
	const was = crossingsOn(data, ['cut']);
	const now = crossingsOn(graph.toJSON(), [left, right]);
	expect(was).toHaveLength(2);
	expect(now).toHaveLength(2);
	for (const p of was) expect(now.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.05)).toBe(true);
});

// A dead end dropped on a node joins it (Graph.merge): its roads end there
// instead, and its edits go with it, beside the node's own.
test("a node merged into another brings its edits there, beside the other's own", () => {
	const graph = new Graph();
	graph.fromJSON({
		nodes: [
			{ id: 'a', x: -60, y: 20 },
			{ id: 'b', x: -40, y: 35, junction: { control: { 'ab:end': 'signal' } } },
			{ id: 'c', x: 50, y: 0, junction: { control: { 'ec:end': 'stop' } } },
			{ id: 'd', x: 75, y: 0 },
			{ id: 'e', x: 50, y: -30 }
		],
		segments: [
			{ id: 'ab', startNodeId: 'a', endNodeId: 'b', lanes: preset('street') },
			{ id: 'cd', startNodeId: 'c', endNodeId: 'd', lanes: preset('street') },
			{ id: 'ec', startNodeId: 'e', endNodeId: 'c', lanes: preset('street') }
		]
	});
	expect(graph.merge('b', 'c')).toBe(true);
	expect(graph.nodes.has('b')).toBe(false);
	expect(graph.segments.get('ab')!.endNodeId).toBe('c');
	expect(graph.toJSON().nodes.find((n) => n.id === 'c')!.junction?.control).toEqual({
		'ec:end': 'stop',
		'ab:end': 'signal'
	});
});

test('a node merged into one with a road attached at its edge draws as it will after a reload', () => {
	// fc, a lane attached at c's left edge between two highway halves: which
	// road it joins goes by the order c lists its roads in, so c lists them
	// in the graph's order, ab (first in it) included, as a reload reads it.
	const graph = new Graph();
	graph.fromJSON({
		nodes: [
			{ id: 'a', x: 70, y: 70 },
			{ id: 'b', x: 60, y: 40 },
			{ id: 'c', x: 0, y: 0, junction: { sides: { fc: 'left' } } },
			{ id: 'd', x: 0, y: -70 },
			{ id: 'e', x: 0, y: 70 },
			{ id: 'f', x: -40, y: -50 }
		],
		segments: [
			{ id: 'ab', startNodeId: 'a', endNodeId: 'b', lanes: preset('street') },
			{ id: 'cd', startNodeId: 'c', endNodeId: 'd', lanes: preset('highway') },
			{ id: 'ce', startNodeId: 'c', endNodeId: 'e', lanes: preset('highway') },
			{ id: 'fc', startNodeId: 'f', endNodeId: 'c', lanes: preset('lane') }
		]
	});
	expect(graph.merge('b', 'c')).toBe(true);
	const reloaded = new Graph();
	reloaded.fromJSON(graph.toJSON());
	expect(graph.nodes.get('c')!.connectedSegments).toEqual(
		reloaded.nodes.get('c')!.connectedSegments
	);
	const points = (g: Graph) =>
		new Networks().build(g).scene.place.roads.find((r) => r.id === 'fc')!.points;
	expect(points(graph)).toEqual(points(reloaded));
});

test('a ramp cut in two still sits beside the other ramp where both leave the road they split from', () => {
	// A two-way road ending at `m`, an entry ramp leaving it on its inbound
	// edge and an exit ramp arriving on its outbound one, both curving away
	// to a roundabout south of it.
	const ramp = (): Lane[] => [{ ...preset('street')[2], width: 4, id: 'l0' }];
	const data: GraphData = {
		nodes: [
			{ id: 'far', x: 0, y: -110 },
			{ id: 'm', x: 0, y: -40 },
			{ id: 'in', x: -8.6, y: -12.3 },
			{ id: 'out', x: 8.6, y: -12.3 }
		],
		segments: [
			{
				id: 'approach',
				startNodeId: 'far',
				endNodeId: 'm',
				lanes: preset('street').slice(1, 3)
			},
			{
				id: 'entry',
				startNodeId: 'm',
				endNodeId: 'in',
				controlX: -4.1,
				controlY: -29.2,
				lanes: ramp()
			},
			{
				id: 'exit',
				startNodeId: 'out',
				endNodeId: 'm',
				controlX: 4.1,
				controlY: -29.2,
				lanes: ramp()
			}
		]
	};
	attach(data, 'm', { entry: { x: -1, y: 0 }, exit: { x: 1, y: 0 } });

	const { graph, left } = cut(data, 'entry');
	const before = buildModel(data);
	const after = buildModel(graph.toJSON());

	const tm = before.derived.junctions.get('m')!;
	const jm = after.derived.junctions.get('m')!;
	expect(tm.link).toEqual([['approach:end'], ['entry:start', 'exit:end']]);
	expect(unordered(jm.link)).toEqual(renamed(tm.link, 'entry', left));
	expect(unordered(jm.sides)).toEqual(renamed(tm.sides, 'entry', left));
	// The ramps' ends sit where they did, and the taper is as long.
	expect(segmentEnds(graph, graph.segments.get(left)!)!.a).toEqual(tm.anchors!['entry:start']);
	expect(jm.anchors![`${left}:start`]).toEqual(tm.anchors!['entry:start']);
	const trims = (spans: typeof before.derived.spans, entry: string) => [
		trim(spans, 'approach', 'end'),
		trim(spans, entry, 'start'),
		trim(spans, 'exit', 'end')
	];
	const was = trims(before.derived.spans, 'entry');
	trims(after.derived.spans, left).forEach((d, i) => expect(d).toBeCloseTo(was[i]));
	expect(check(after.scene)).toEqual([]);
});

test('a curved road attached at an end and cut in two traces the road as it showed, its crossings where they were', () => {
	// A street east from `a`, bowed south, attached at the south edge of an
	// avenue ending at `a` from the west; shifted at its ends or not. A
	// crossing stored at `a` 80 m along it lies on the far half once cut.
	for (const shifted of [false, true]) {
		const data: GraphData = {
			nodes: [
				{ id: 'w', x: -100, y: 0 },
				{ id: 'a', x: 0, y: 0 },
				{ id: 'b', x: 100, y: 0 }
			],
			segments: [
				{ id: 'avenue', startNodeId: 'w', endNodeId: 'a', lanes: preset('avenue') },
				{
					id: 'cut',
					startNodeId: 'a',
					endNodeId: 'b',
					controlX: 60,
					controlY: 60,
					lanes: preset('street'),
					...(shifted ? { offsetStart: 2, offsetEnd: -3 } : {})
				}
			]
		};
		attach(data, 'a', { cut: { x: 0, y: 1 } });
		data.nodes[1].junction!.crossings = [
			{ road: 'cut', end: 'start', lanes: ['l0', 'l3'], at: 80 }
		];
		const before = new Graph();
		before.fromJSON(structuredClone(data));
		const road = before.segments.get('cut')!;
		const shown = Array.from({ length: 21 }, (_, i) => roadAt(before, road, i / 20)!.point);

		const graph = new Graph();
		graph.fromJSON(structuredClone(data));
		const segment = graph.segments.get('cut')!;
		const at = roadAt(graph, segment, 0.4)!.line;
		const node = graph.createNode(at.x, at.y);
		const { left, right } = splitSegment(graph, segment, 0.4, node.id)!;
		// Each sample of the road where it showed, on the half that holds it
		// (the halves blend a shift by their own lengths: within 2 mm).
		const now = shown.map((_, i) => {
			const t = i / 20;
			return t <= 0.4
				? roadAt(graph, left, t / 0.4)!.point
				: roadAt(graph, right, (t - 0.4) / 0.6)!.point;
		});
		const off = Math.max(...now.map((p, i) => Math.hypot(p.x - shown[i].x, p.y - shown[i].y)));
		expect([shifted, off]).toEqual([shifted, expect.closeTo(0, shifted ? 2 : 6)]);
		// The crossing is drawn where it was, within a centimetre.
		const was = crossingsOn(data, ['cut']);
		const moved = crossingsOn(graph.toJSON(), [left.id, right.id]);
		expect(moved).toHaveLength(1);
		expect(Math.hypot(moved[0].x - was[0].x, moved[0].y - was[0].y)).toBeLessThan(0.01);
	}
});

test('a road attached at an edge, its end shifted and its control point 5 m out, shows where it did once cut', () => {
	// A street east from `a`, attached at the south edge of an avenue ending
	// there, shifted 2 m at that end and heading for a control point 5 m from
	// the node; cut a fifth, two fifths and three fifths of the way along.
	const failures: string[] = [];
	for (const [cx, cy] of [
		[5, 0],
		[5, 0.5],
		[4, 3],
		[3, 4],
		[4, -3]
	])
		for (const t of [0.2, 0.4, 0.6]) {
			const data: GraphData = {
				nodes: [
					{ id: 'w', x: -100, y: 0 },
					{ id: 'a', x: 0, y: 0 },
					{ id: 'b', x: 100, y: 0 }
				],
				segments: [
					{ id: 'avenue', startNodeId: 'w', endNodeId: 'a', lanes: preset('avenue') },
					{
						id: 'cut',
						startNodeId: 'a',
						endNodeId: 'b',
						controlX: cx,
						controlY: cy,
						lanes: preset('street'),
						offsetStart: 2
					}
				]
			};
			attach(data, 'a', { cut: { x: 0, y: 1 } });
			const before = new Graph();
			before.fromJSON(structuredClone(data));
			const road = before.segments.get('cut')!;
			const graph = new Graph();
			graph.fromJSON(structuredClone(data));
			const segment = graph.segments.get('cut')!;
			const at = roadAt(graph, segment, t)!.line;
			const { left } = splitSegment(graph, segment, t, graph.createNode(at.x, at.y).id)!;
			// The near half, sampled, against the road where it showed (the
			// halves blend a shift by their own lengths: within 2 mm).
			for (let i = 0; i <= 10; i++) {
				const was = roadAt(before, road, (t * i) / 10)!.point;
				const now = roadAt(graph, left, i / 10)!.point;
				const off = Math.hypot(now.x - was.x, now.y - was.y);
				if (off > 0.002) failures.push(`control (${cx}, ${cy}), cut at ${t}: ${off.toFixed(3)} m`);
			}
		}
	expect(failures).toEqual([]);
});

// The road model of a graph as a plain record to compare: each road's lanes,
// shift, crossings and length (to the millimetre), and each junction's ends,
// connections, walkways, controls and sides, with the road `from` named
// `to`; and each road's line, sampled every metre (`lines`).
function modelOf(data: GraphData, from: string, to: string) {
	const { place } = buildModel(data).derived;
	const mm = (x: number) => Math.round(x * 1000) / 1000;
	const name = (text: string) =>
		JSON.parse(text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}:`, `"${to}:`));
	const lines = new Map<string, { x: number; y: number }[]>();
	const roads = place.roads.map((r) => {
		const id = r.id === from ? to : r.id;
		const path = samplePath(r);
		const n = Math.ceil(path.length);
		lines.set(
			id,
			Array.from({ length: n + 1 }, (_, i) => frameAt(path, (path.length * i) / n).p)
		);
		return {
			id,
			lanes: r.lanes,
			offset: mm(r.offset),
			lean: mm(r.lean ?? 0),
			length: mm(path.length),
			crossings: (r.crossings ?? []).map((c) => ({ ...c, at: mm(c.at) }))
		};
	});
	const junctions = place.junctions.map((drawn) => {
		const j: typeof drawn = name(JSON.stringify(drawn));
		return {
			members: j.members,
			ends: unordered(j.ends),
			connections: unordered(j.connections),
			walkways: unordered(j.walkways.map(({ a, b }) => [a, b])),
			control: j.control,
			link: j.link,
			sides: j.sides
		};
	});
	return { roads: roads.sort((a, b) => a.id.localeCompare(b.id)), junctions, lines };
}

test('a road cut where it only carries on builds as the uncut road, near a junction or far from one, straight or curved', () => {
	// A street from w ending in a T on a north-south street at j, 120 m
	// east; and the same road on its own, curving north on the way.
	const tee = (lanes: string, curve?: { x: number; y: number }): GraphData => ({
		nodes: [
			{ id: 'w', x: -60, y: 0 },
			{ id: 'j', x: 60, y: 0 },
			{ id: 'n', x: 60, y: 50 },
			{ id: 's', x: 60, y: -50 }
		],
		segments: [
			{
				id: 'r',
				startNodeId: 'w',
				endNodeId: 'j',
				lanes: preset(lanes),
				...(curve && { controlX: curve.x, controlY: curve.y })
			},
			{ id: 'up', startNodeId: 'j', endNodeId: 'n', lanes: preset('street') },
			{ id: 'down', startNodeId: 'j', endNodeId: 's', lanes: preset('street') }
		]
	});
	const alone = (curve?: { x: number; y: number }, offsets?: [number, number]): GraphData => ({
		nodes: [
			{ id: 'w', x: -60, y: 0 },
			{ id: 'e', x: 60, y: 0 }
		],
		segments: [
			{
				id: 'r',
				startNodeId: 'w',
				endNodeId: 'e',
				lanes: preset('street'),
				...(curve && { controlX: curve.x, controlY: curve.y }),
				...(offsets && { offsetStart: offsets[0], offsetEnd: offsets[1] })
			}
		]
	});
	const cases: [string, GraphData, number][] = [
		['straight, alone', alone(), 0.5],
		['straight, its shift growing along it', alone(undefined, [0, 4]), 0.3],
		['curved, alone', alone({ x: 0, y: 40 }), 0.5],
		['curved, alone, near its end', alone({ x: 0, y: 40 }), 0.15],
		['straight, 4 m short of a junction', tee('street'), 116 / 120],
		['straight, 10 m short of a junction', tee('street'), 110 / 120],
		['an avenue, 6 m short of a junction', tee('avenue'), 114 / 120],
		['curved, near a junction', tee('street', { x: 0, y: 30 }), 0.95],
		['straight, far from a junction', tee('street'), 0.25]
	];
	for (const [name, data, t] of cases) {
		const { graph, left, node } = cut(data, 'r', t);
		const { lines, ...cutModel } = modelOf(graph.toJSON(), left, 'r');
		const { lines: uncutLines, ...uncut } = modelOf(data, 'r', 'r');
		expect([name, cutModel]).toEqual([name, uncut]);
		// Each road on the same line, within a millimetre.
		for (const [id, line] of uncutLines) {
			const off = line.map((p, i) =>
				Math.hypot(p.x - lines.get(id)![i].x, p.y - lines.get(id)![i].y)
			);
			expect([name, id, Math.max(...off) < 0.001]).toEqual([name, id, true]);
		}
		// No node is drawn where it is cut.
		expect([name, cutModel.junctions.some((j) => j.members.includes(node))]).toEqual([name, false]);
	}
});

test('a road attached at an edge and leaving it nearly square draws as it did once cut, however near its end', () => {
	// A street or an avenue north from a node in the middle of an avenue,
	// attached at its north edge, shifted 8 m at that end and curving off
	// toward (30, 40). Heading nearly square to the avenue, its end has more
	// than one place it could go (core/attach.ts); a half cut off it, heading
	// for its own control point, has others. The road drawn reads it whole.
	const failures: string[] = [];
	for (const [lanes, cx, t] of [
		['avenue', 12, 0.03],
		['street', 1, 0.57],
		['street', 0, 0.27],
		['street', -12, 0.27]
	] as const) {
		const data: GraphData = {
			nodes: [
				{ id: 'w', x: -60, y: 0 },
				{ id: 'm', x: 0, y: 0 },
				{ id: 'e', x: 60, y: 0 },
				{ id: 'f', x: 30, y: 40 }
			],
			segments: [
				{ id: 'west', startNodeId: 'w', endNodeId: 'm', lanes: preset('avenue') },
				{ id: 'east', startNodeId: 'm', endNodeId: 'e', lanes: preset('avenue') },
				{
					id: 'r',
					startNodeId: 'm',
					endNodeId: 'f',
					controlX: cx,
					controlY: 25,
					lanes: preset(lanes),
					offsetStart: -8
				}
			]
		};
		attach(data, 'm', { r: { x: 0, y: 1 } });
		const { graph, left, right } = cut(data, 'r', t);
		const diff = carDiff(
			carPart(buildModel(data).scene),
			carPart(buildModel(graph.toJSON()).scene)
		);
		if (diff.length) failures.push(`${lanes}, control (${cx}, 25), cut at ${t}: ${diff[0]}`);
		// The editor reads each half where the road is drawn, as the uncut
		// road (which the drawing above is) shows: picking, the selection band
		// and the handles all read the line each half shows on
		// (core/road-line.ts). Within a centimetre: the halves blend their
		// shifts along themselves, which reads a millimetre or so apart from
		// the whole's blend.
		const whole = new Graph();
		whole.fromJSON(structuredClone(data));
		const uncut = roadLine(whole, whole.segments.get('r')!, 400);
		const off = (p: Pt) => Math.min(...uncut.slice(1).map((q, i) => toSegment(p, uncut[i], q)));
		const worst = Math.max(
			...[left, right].flatMap((id) => roadLine(graph, graph.segments.get(id)!, 400).map(off))
		);
		if (worst > 0.01)
			failures.push(`${lanes}, control (${cx}, 25), cut at ${t}: shown ${worst} m off`);
	}
	expect(failures).toEqual([]);
});

test('after a road is cut and a piece of it turned into a footpath, every node lists its roads as a reload would', () => {
	// A street cut in two by the split tool, and one half turned into a
	// footpath in the lane panel (its own node at the cut, Graph.setLanes).
	const listed = (graph: Graph) =>
		[...graph.nodes.values()].map((node) => [node.id, [...node.connectedSegments]]);
	const reloaded = (graph: Graph) => {
		const fresh = new Graph();
		fresh.fromJSON(graph.toJSON());
		return listed(fresh);
	};
	const { graph, left } = cut(
		{
			nodes: [
				{ id: 'w', x: -58, y: 0 },
				{ id: 'e', x: 58, y: 0 }
			],
			segments: [{ id: 'street', startNodeId: 'w', endNodeId: 'e', lanes: preset('lane') }]
		},
		'street',
		0.4
	);
	expect(listed(graph)).toEqual(reloaded(graph));
	const half = graph.segments.get(left)!;
	graph.setLanes([
		[
			half,
			half
				.cloneLanes()
				.map((l) => ({ ...l, role: 'pedestrian' as const, direction: 'bidirectional' as const }))
		]
	]);
	expect(listed(graph)).toEqual(reloaded(graph));
});
