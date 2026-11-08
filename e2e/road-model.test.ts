import { expect, test } from '@playwright/test';
import { PlaceBuilder } from '../src/lib/core/place';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { JunctionData, Lane } from '../src/lib/core/types';
import { Scene } from '../src/lib/lab/scene';
import { serializeLanes } from '../src/lib/core/lane-template';

// The default rules the drawing runs on, read straight off the road model
// (no browser): a graph is built by hand and read the way the editor reads
// it. Each test protects one rule the editor's look depends on.

type Seg = { id: string; from: string; to: string; lanes: Lane[]; offset?: number };

function graphOf(nodes: Record<string, [number, number, JunctionData?]>, segs: Seg[]) {
	const nodeMap = new Map(
		Object.entries(nodes).map(([id, [x, y, junction]]) => [
			id,
			{ id, x, y, junction, connectedSegments: [] as string[] }
		])
	);
	const segments = new Map(
		segs.map((s) => {
			s.lanes.forEach((l, i) => (l.id ??= `l${i}`));
			return [
				s.id,
				{
					id: s.id,
					startNodeId: s.from,
					endNodeId: s.to,
					controlX: undefined,
					controlY: undefined,
					hasControlPoint: false,
					offset: s.offset ?? 0,
					lanes: s.lanes,
					lanesKey: serializeLanes(s.lanes),
					totalWidth: s.lanes.reduce((a, l) => a + l.width, 0)
				}
			];
		})
	);
	for (const s of segments.values()) {
		nodeMap.get(s.startNodeId)!.connectedSegments.push(s.id);
		nodeMap.get(s.endNodeId)!.connectedSegments.push(s.id);
	}
	return { nodes: nodeMap, segments };
}

function build(graph: ReturnType<typeof graphOf>) {
	const derived = new PlaceBuilder().build(graph as never);
	const scene = new Scene(derived.place);
	scene.build();
	return { derived, scene };
}

// Two roads crossing at node c: a west-east one (w → c → e) and a
// north-south one (n → c → s).
function crossroads(ew: () => Lane[], ns: () => Lane[], junction?: JunctionData) {
	return graphOf({ c: [0, 0, junction], w: [-120, 0], e: [120, 0], n: [0, -120], s: [0, 120] }, [
		{ id: 'west', from: 'w', to: 'c', lanes: ew() },
		{ id: 'east', from: 'c', to: 'e', lanes: ew() },
		{ id: 'north', from: 'n', to: 'c', lanes: ns() },
		{ id: 'south', from: 'c', to: 's', lanes: ns() }
	]);
}
const avenue = () => createLanesFrom('avenue');
const street = () => createLanesFrom('street');

test('two Avenues crossing are signalled; an Avenue crossing a Street gives way to nobody', () => {
	const big = build(crossroads(avenue, avenue)).derived.junctions.get('c')!;
	expect(Object.values(big.control)).toEqual(['signal', 'signal', 'signal', 'signal']);

	const mixed = build(crossroads(avenue, street)).derived.junctions.get('c')!;
	expect(mixed.control['west:end']).toBe('none');
	expect(mixed.control['east:start']).toBe('none');
	expect(mixed.control['north:end']).toBe('stop');
	expect(mixed.control['south:start']).toBe('stop');
});

test('a controlled junction has a crossing on every arm; one switched off is gone', () => {
	const on = build(crossroads(avenue, avenue));
	const crossed = (d: typeof on) =>
		d.derived.place.roads.filter((r) => (r.crossings ?? []).length > 0).map((r) => r.id);
	expect(crossed(on).sort()).toEqual(['east', 'north', 'south', 'west']);

	const off = build(
		crossroads(avenue, avenue, {
			connections: [],
			crossings: [{ road: 'north', end: 'end', lanes: ['l0', 'l8'], on: false }]
		})
	);
	expect(crossed(off).sort()).toEqual(['east', 'south', 'west']);
});

test('a crossing moved past the far end of its road stops short of it', () => {
	const { derived } = build(
		crossroads(avenue, avenue, {
			connections: [],
			crossings: [{ road: 'east', end: 'start', lanes: ['l0', 'l8'], at: 500 }]
		})
	);
	const road = derived.place.roads.find((r) => r.id === 'east')!;
	const span = derived.spans.get('east')!;
	const at = road.crossings![0].at;
	expect(at).toBeLessThan(span.length);
	expect(at).toBeGreaterThan(span.length - 3);
});

test('a lane added on the kerb side turns right only; the lanes beside it go straight', () => {
	// The west approach gains a third eastbound lane on its kerb side (right
	// of the existing eastbound pair), as a right-turn lane does.
	const graph = crossroads(avenue, avenue);
	const west = graph.segments.get('west')!;
	const lanes = avenue();
	lanes.splice(7, 0, {
		role: 'vehicle',
		material: 'asphalt',
		width: 3.5,
		direction: 'forward',
		id: 'l9'
	});
	west.lanes = lanes;
	west.lanesKey = serializeLanes(lanes);
	west.totalWidth += 3.5;
	// Slid half a lane toward its kerb, as a pocket is, so its through lanes
	// line up with the road beyond.
	west.offset = 1.75;
	const j = build(graph).derived.junctions.get('c')!;
	const from = (lane: string) =>
		j.connections
			.filter((c) => c.from.road === 'west' && c.from.lane === lane)
			.map((c) => c.to.road)
			.sort();
	// Eastbound on a road drawn west to east: the south arm is to the right.
	expect(from('l9')).toEqual(['south']);
	expect(from('l6')).toEqual(['east']);
	expect(from('l5')).toEqual(['east', 'north']);
});

test('swapping two lanes across a node keeps both kerb lines', () => {
	// An Avenue cut in two at node m, its eastbound lanes swapped there.
	const ref = (road: string, end: 'start' | 'end', lane: string) => ({ road, end, lane });
	const graph = graphOf(
		{
			a: [-100, 0],
			b: [100, 0],
			m: [
				0,
				0,
				{
					connections: [],
					removed: [
						{ from: ref('one', 'end', 'l5'), to: ref('two', 'start', 'l5') },
						{ from: ref('one', 'end', 'l6'), to: ref('two', 'start', 'l6') }
					],
					added: [
						{ from: ref('one', 'end', 'l5'), to: ref('two', 'start', 'l6') },
						{ from: ref('one', 'end', 'l6'), to: ref('two', 'start', 'l5') }
					],
					taper: 30
				}
			]
		},
		[
			{ id: 'one', from: 'a', to: 'm', lanes: avenue() },
			{ id: 'two', from: 'm', to: 'b', lanes: avenue() }
		]
	);
	const { scene } = build(graph);
	const draw = scene.junctionDraw('m')!;
	// The eastbound kerb sits 8 m south of the line (y = 7.8 inside it); the
	// node's paint keeps a solid white line along it the whole way across.
	const kerb = draw.marks.filter(
		(m) => !m.dashed && m.colour === 'white' && m.pts.every((p) => Math.abs(p.y - 7.8) < 0.2)
	);
	expect(kerb.length).toBe(1);
	const xs = kerb[0].pts.map((p) => p.x);
	expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(25);
});

const oneLane = (direction: 'forward' | 'backward'): Lane[] => [
	{ id: 'l0', role: 'vehicle', material: 'asphalt', width: 3.5, direction }
];

test('an on-ramp attached at the freeway edge feeds only its acceleration lane', () => {
	// A freeway drawn southward; the stretch after the ramp has a fourth
	// southbound lane on the outside, slid half a lane so the median runs on.
	const accel = createLanesFrom('highway');
	accel.push({ ...accel[accel.length - 1], id: 'l7' });
	const graph = graphOf(
		{
			n: [0, -200],
			m: [0, 0, { connections: [], sides: { ramp: 'left' } }],
			s: [0, 200],
			r: [-60, -150]
		},
		[
			{ id: 'north', from: 'n', to: 'm', lanes: createLanesFrom('highway') },
			{ id: 'south', from: 'm', to: 's', lanes: accel, offset: 1.75 },
			{ id: 'ramp', from: 'r', to: 'm', lanes: oneLane('forward') }
		]
	);
	const j = build(graph).derived.junctions.get('m')!;
	const from = (road: string, lane: string) =>
		j.connections
			.filter((c) => c.from.road === road && c.from.lane === lane)
			.map((c) => `${c.to.road}:${c.to.lane}`);
	expect(from('ramp', 'l0')).toEqual(['south:l7']);
	expect(from('north', 'l6')).toEqual(['south:l6']);
	expect(Object.values(j.control).every((c) => c === 'none')).toBe(true);
});

test('an avenue splitting into two one-way roads carries every lane straight on', () => {
	const avenueLanes = createLanesFrom('avenue');
	const half = (dir: 'forward' | 'backward') =>
		createLanesFrom('avenue')
			.filter((l) => l.role === 'vehicle' && l.direction === dir)
			.map((l, i) => ({ ...l, id: `l${i}` }));
	const graph = graphOf(
		{
			w: [-200, 0],
			m: [0, 0, { connections: [], sides: { westbound: 'left', eastbound: 'right' } }],
			a: [200, -12],
			b: [200, 12]
		},
		[
			{ id: 'avenue', from: 'w', to: 'm', lanes: avenueLanes },
			{ id: 'westbound', from: 'm', to: 'a', lanes: half('backward') },
			{ id: 'eastbound', from: 'm', to: 'b', lanes: half('forward') }
		]
	);
	const j = build(graph).derived.junctions.get('m')!;
	const cars = j.connections.filter((c) =>
		['avenue', 'westbound', 'eastbound'].includes(c.from.road)
	);
	// Two lanes each way, each with one connection, and none between the
	// two one-way roads.
	const travel = cars.filter((c) => c.from.road !== c.to.road && c.from.lane.startsWith('l'));
	expect(travel.filter((c) => c.to.road === 'eastbound').length).toBe(2);
	expect(travel.filter((c) => c.from.road === 'westbound').length).toBe(2);
	expect(
		travel.some(
			(c) =>
				(c.from.road === 'westbound' && c.to.road === 'eastbound') ||
				(c.from.road === 'eastbound' && c.to.road === 'westbound')
		)
	).toBe(false);
	const outs = new Set(travel.map((c) => `${c.from.road}:${c.from.lane}`));
	expect(outs.size).toBe(travel.length);
});

test('two lane changes close enough to merge keep the sidewalks running through', () => {
	// A street with a turn lane added each side of a short plain piece, as a
	// street does between two pocketed junctions: the tapers use up the short
	// piece, so its two nodes draw as one.
	const pocket = (dir: 'forward' | 'backward') => {
		const lanes = street();
		lanes.forEach((l, i) => (l.id = `l${i}`));
		const at = dir === 'forward' ? 3 : 1;
		lanes.splice(at, 0, {
			role: 'vehicle',
			material: 'asphalt',
			width: 3.5,
			direction: dir,
			id: 'turn'
		});
		return lanes;
	};
	const graph = graphOf({ a: [0, -100], p: [0, -60], q: [0, -45], b: [0, 0] }, [
		{ id: 'north', from: 'a', to: 'p', lanes: pocket('backward'), offset: -1.75 },
		{ id: 'south', from: 'q', to: 'b', lanes: pocket('forward'), offset: 1.75 },
		// Listed last, as a piece split off later is: at both its nodes the
		// sidewalks then run from the outer road into it.
		{ id: 'middle', from: 'p', to: 'q', lanes: street() }
	]);
	const { scene } = build(graph);
	const joined = scene.effective.find((j) => j.id.includes('+'));
	expect(joined?.id.split('+').sort()).toEqual(['p', 'q']);
	const walks = joined!.connections
		.filter((c) => /^l0$|^l3$/.test(c.from.lane) && c.from.road !== c.to.road)
		.map((c) => [c.from.road, c.to.road].sort().join('-'));
	expect(walks).toEqual(['north-south', 'north-south']);
});
