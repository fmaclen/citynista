import { expect, spyOn, test } from 'bun:test';
import * as attach from '../src/lib/core/attach';
import { crossingPairs, linesOf, splitSegment } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { Networks } from '../src/lib/core/networks';
import { PlaceBuilder } from '../src/lib/core/place';
import * as roadLine from '../src/lib/core/road-line';
import * as setbacksModule from '../src/lib/core/setbacks';
import { copyAround, laidOver } from '../src/lib/core/trial';
import * as geometry from '../src/lib/road-model/geometry';
import * as overlay from '../src/lib/road-model/overlay';
import type { Arm } from '../src/lib/core/setbacks';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import {
	buildModel,
	editorDrawing,
	liveShape,
	nodeOf,
	pieces,
	readScene,
	segmentOf
} from './model';

// How the drawing at a node of two sides (two roads, or roads attached at an
// edge beside the ones they join) is read: its connections and taper come
// off its roads at the node, before any trim, so one build settles it and the
// same graph draws the same whatever was built before.

type Live = ReturnType<typeof liveShape>;

const live = (name: string) => liveShape(readScene(name));
const fresh = (graph: Live) => pieces(editorDrawing()(graph));
const moveTo = (graph: Live, id: string, x: number, y: number) =>
	Object.assign(graph.nodes.get(id)!, { x, y });

// The trims of a node's roads at it, by segment id.
function trimsAt(builder: PlaceBuilder | Networks, graph: Live, nodeId: string) {
	const built = builder.build(graph as never);
	const derived = 'derived' in built ? built.derived : built;
	return graph.nodes.get(nodeId)!.connectedSegments.map((id) => {
		const s = graph.segments.get(id)!;
		const span = derived.spans.get(id)!;
		return [id, s.startNodeId === nodeId ? span.d0 : span.total - span.d0 - span.length];
	});
}

test('a node dragged to a place directly or by a detour draws the same there', () => {
	// The far end of the road the ramp is attached beside: moving it swings
	// that road at the ramp's node.
	const direct = live('attached-ramp');
	const drawDirect = editorDrawing();
	drawDirect(direct);
	moveTo(direct, 's', 5, 200);
	const viaDirect = pieces(drawDirect(direct));

	const detour = live('attached-ramp');
	const drawDetour = editorDrawing();
	drawDetour(detour);
	// The drawing of the build that arrives there, not of one after it.
	let arrived = new Map<string, unknown>();
	for (const [x, y] of [
		[2, 200],
		[8, 204],
		[-3, 196],
		[5, 200]
	]) {
		moveTo(detour, 's', x, y);
		arrived = pieces(drawDetour(detour));
	}
	expect(arrived).toEqual(viaDirect);
	expect(viaDirect).toEqual(fresh(direct));
});

test('a ramp bent sharply into the road it joins goes with one side of the node, for its connections and its drawing alike', () => {
	// The ramp's far end brought close and the ramp bent through a point
	// beside the node: it heads one way at the node and another a few metres
	// out, where it is trimmed back to.
	const data = readScene('attached-ramp');
	Object.assign(nodeOf(data, 'r'), { x: -60, y: -60 });
	Object.assign(segmentOf(data, 'ramp'), { controlX: -10, controlY: 5 });
	const { derived, scene } = buildModel(data);
	// It goes with the road from the north, so its lane carries on into the
	// road south, and is drawn doing so.
	const into = derived.junctions
		.get('m')!
		.connections.filter((c) => c.from.road === 'ramp')
		.map((c) => `${c.to.road}:${c.to.lane}`);
	expect(into).toEqual(['south:l4']);
	expect(check(scene)).toEqual([]);
});

test('a ramp bent into the road it joins goes with the same side when the whole place is drawn four times the size', () => {
	const data = readScene('attached-ramp');
	Object.assign(nodeOf(data, 'r'), { x: -60, y: -60 });
	Object.assign(segmentOf(data, 'ramp'), { controlX: -10, controlY: 5 });
	// Every coordinate, lane width and shift, times four.
	for (const n of data.nodes) Object.assign(n, { x: n.x * 4, y: n.y * 4 });
	for (const s of data.segments) {
		for (const key of ['controlX', 'controlY', 'offsetStart', 'offsetEnd'] as const)
			if (s[key] !== undefined) s[key] *= 4;
		s.lanes = s.lanes.map((l) => ({ ...l, width: l.width * 4 }));
	}
	const { derived, scene } = buildModel(data);
	const into = derived.junctions
		.get('m')!
		.connections.filter((c) => c.from.road === 'ramp')
		.map((c) => `${c.to.road}:${c.to.lane}`);
	expect(into).toEqual(['south:l4']);
	expect(check(scene)).toEqual([]);
});

test('a ramp that never gets clear of the roads it joins goes with the side it arrives on', () => {
	// Its far end brought in beside the road north and bent out past it: the
	// whole ramp lies over that road's width, and at the node it heads the way
	// that road does.
	const data = readScene('attached-ramp');
	Object.assign(nodeOf(data, 'r'), { x: -5, y: -150 });
	Object.assign(segmentOf(data, 'ramp'), { controlX: -5, controlY: -300 });
	const { derived } = buildModel(data);
	const into = derived.junctions
		.get('m')!
		.connections.filter((c) => c.from.road === 'ramp')
		.map((c) => `${c.to.road}:${c.to.lane}`);
	expect(into).toEqual(['south:l7']);
});

test('two roads whose lanes line up at their node need no taper, however far apart their far ends are shifted', () => {
	// One lane carrying on through m: shifted 5 m left at a, on the line at m,
	// 5 m right at b. The lane runs straight from a to b across the line. The
	// two roads' lanes are named apart (two roads drawn on their own), so m
	// stays a node: one road cut there is drawn whole (core/place.ts).
	const lane = (id: string): Lane[] => [
		{ id, role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
	];
	const data: GraphData = {
		nodes: [
			{ id: 'a', x: -100, y: 0 },
			{ id: 'm', x: 0, y: 0 },
			{ id: 'b', x: 100, y: 0 }
		],
		segments: [
			{
				id: 'in',
				startNodeId: 'a',
				endNodeId: 'm',
				offsetStart: -5,
				offsetEnd: 0,
				lanes: lane('a')
			},
			{
				id: 'out',
				startNodeId: 'm',
				endNodeId: 'b',
				offsetStart: 0,
				offsetEnd: 5,
				lanes: lane('b')
			}
		]
	};
	const graph = liveShape(data);
	const trims = trimsAt(new PlaceBuilder(), graph, 'm');
	// Each stops the little any road carrying straight on does.
	expect(trims.map(([id]) => id)).toEqual(['in', 'out']);
	for (const [, trim] of trims) expect(trim).toBeCloseTo(0.6, 6);
	// Across the node the lane stays within a centimetre of that straight
	// line (5 m across for every 100 m along): no kink.
	const { scene } = buildModel(data);
	const across = scene.node('m')!.paths.flatMap((path) => path.line);
	expect(across.length).toBeGreaterThan(2);
	for (const p of across) expect(Math.abs(p.y - 0.05 * p.x)).toBeLessThan(0.01);
	expect(check(scene)).toEqual([]);
});

test('a held taper draws as it was while connections change, and follows them once let go', () => {
	// Two roads of different widths, their taper left to the shifts.
	const graph = live('handles');
	const node = graph.nodes.get('t')!;
	node.junction = undefined;
	const builder = new Networks();
	const draw = editorDrawing(builder);
	draw(graph);
	const before = trimsAt(builder, graph, 't');
	builder.hold('t');
	// With every connection gone the lanes shift nowhere: no taper is needed.
	const removed = builder.build(graph as never).derived.junctions.get('t')!.connections;
	node.junction = { removed };
	// Held, the whole drawing is the one a taper set by hand to the lengths
	// it had would give, not the one this graph draws left to itself.
	const pinned = live('handles');
	pinned.nodes.get('t')!.junction = { removed, setbacks: Object.fromEntries(before) };
	const held = pieces(draw(graph));
	expect(held).toEqual(fresh(pinned));
	expect(held).not.toEqual(fresh(graph));
	builder.hold(null);
	expect(pieces(draw(graph))).toEqual(fresh(graph));
});

test('a taper set by hand below the least its shifts allow is clamped in one build', () => {
	const graph = live('handles');
	// The shifts allow no less than 7 m a side; left to themselves they take
	// 10.5 m.
	graph.nodes.get('t')!.junction = { setbacks: { narrow: 0, wide: 10 } };
	const builder = new PlaceBuilder();
	// The first build stops the side set too short at the least, and the
	// other where it was set.
	expect(trimsAt(builder, graph, 't')).toEqual([
		['narrow', 7],
		['wide', 10]
	]);
	expect(builder.limits.get('t')!.get('narrow')!.min).toBe(7);
});

test('a road with different shifts at its two ends tapers the same however it got them', () => {
	const graph = live('road-joints');
	const draw = editorDrawing();
	draw(graph);
	const road = graph.segments.get('widen-narrow')!;
	road.offsetStart = 0.5;
	road.offsetEnd = -0.5;
	expect(pieces(draw(graph))).toEqual(fresh(graph));
	// Building it again changes nothing: one build settled it.
	expect(pieces(draw(graph))).toEqual(fresh(graph));
});

test('moving one node reads nothing of the lanes of roads elsewhere', () => {
	// A hundred streets apart, each of two pieces carrying on through a node;
	// every lane counts the times its role is read. The editing cost stays
	// with what changed (AGENTS.md): what a node reads of its roads' lanes is
	// kept by their cross-section.
	const data: GraphData = { nodes: [], segments: [] };
	for (let i = 0; i < 100; i++) {
		for (let j = 0; j < 3; j++) data.nodes.push({ id: `${i}-${j}`, x: j * 50, y: i * 100 });
		for (let j = 0; j < 2; j++)
			data.segments.push({
				id: `${i}-s${j}`,
				startNodeId: `${i}-${j}`,
				endNodeId: `${i}-${j + 1}`,
				lanes: createLanesFrom('street').map((l, k) => ({ ...l, id: `l${k}` }))
			});
	}
	const graph = liveShape(data);
	const reads = new Map<string, number>();
	for (const s of graph.segments.values())
		s.lanes = s.lanes.map((lane) => {
			const counted = { ...lane };
			Object.defineProperty(counted, 'role', {
				get() {
					reads.set(s.id, (reads.get(s.id) ?? 0) + 1);
					return lane.role;
				}
			});
			return counted;
		});
	const builder = new PlaceBuilder();
	builder.build(graph as never);
	reads.clear();
	graph.nodes.get('0-0')!.y += 1;
	builder.build(graph as never);
	expect([...reads].filter(([id]) => !id.startsWith('0-'))).toEqual([]);
});

test('a rebuild sets back and attaches again only at nodes whose roads changed', () => {
	// The roundabout: ramps attached at the splits' edges, and junctions
	// round the ring. Building again with nothing moved works out no setback
	// and no attached end; moving a ring node, only at it and at the nodes
	// its roads lead to.
	const graph = new Graph();
	graph.fromJSON(readScene('roundabout'));
	const live = liveShape(graph.toJSON());
	const builder = new PlaceBuilder();
	builder.build(live as never);
	const attached = spyOn(attach, 'attachShift');
	const setBack = spyOn(setbacksModule, 'setbacks');
	builder.build(live as never);
	expect(attached).not.toHaveBeenCalled();
	expect(setBack).not.toHaveBeenCalled();
	const near = new Set(['ring-e']);
	for (const id of live.nodes.get('ring-e')!.connectedSegments) {
		const s = live.segments.get(id)!;
		near.add(s.startNodeId).add(s.endNodeId);
	}
	live.nodes.get('ring-e')!.x += 0.1;
	builder.build(live as never);
	const nodeOfArm = (a: Arm) => (a.end === 'start' ? a.segment.startNodeId : a.segment.endNodeId);
	expect(setBack).toHaveBeenCalled();
	expect(
		setBack.mock.calls.map(([arms]) => nodeOfArm(arms[0])).filter((n) => !near.has(n))
	).toEqual([]);
	expect(attached.mock.calls.map(([, , n]) => n).filter((n) => !near.has(n))).toEqual([]);
	attached.mockRestore();
	setBack.mockRestore();
});

test('laying the footpaths over the cars again reads only what lies near a change, however many there are', () => {
	// Rows of a street crossed by a footpath, built once, then again with
	// nothing moved and with one street's end moved: each rebuild works out
	// as many footpath ends and tests as many boxes with 256 rows as with 32.
	const work = (count: number) => {
		const nodes: GraphData['nodes'] = [];
		const segments: GraphData['segments'] = [];
		for (let k = 0; k < count; k++) {
			const n = (letter: string, x: number, y: number) => {
				nodes.push({ id: `${k}-${letter}`, x, y: y + k * 100 });
				return `${k}-${letter}`;
			};
			const s = (id: string, a: string, b: string, preset: string) =>
				segments.push({
					id: `${k}-${id}`,
					startNodeId: a,
					endNodeId: b,
					lanes: createLanesFrom(preset).map((l, i) => ({ ...l, id: `l${i}` }))
				});
			s('road', n('a', -30, 0), n('b', 30, 0), 'street');
			s('walk', n('c', 0, -12), n('d', 0, 12), 'path');
		}
		const graph = liveShape({ nodes, segments });
		const networks = new Networks();
		networks.build(graph as never);
		const ends = spyOn(geometry, 'endFrame');
		const boxes = spyOn(overlay, 'overlap');
		const near = spyOn(overlay.BoxGrid.prototype, 'near');
		const counts = [];
		for (const move of [false, true]) {
			if (move) graph.nodes.get('0-a')!.x += 3;
			networks.build(graph as never);
			counts.push([ends.mock.calls.length, boxes.mock.calls.length, near.mock.calls.length]);
			for (const spy of [ends, boxes, near]) spy.mockClear();
		}
		for (const spy of [ends, boxes, near]) spy.mockRestore();
		return counts;
	};
	expect(work(256)).toEqual(work(32));
});

test('a footpath node on a sidewalk far from a change is not read again, however many there are', () => {
	// Rows of a street with two footpaths leaving one node on its sidewalk;
	// one street's end moved. Whether a node lies on a sidewalk, and whether
	// on a car road's dead end, is read again only near the change: as many
	// footpath ends are placed and tested on a walk with 256 rows as with 32.
	const work = (count: number) => {
		const nodes: GraphData['nodes'] = [];
		const segments: GraphData['segments'] = [];
		for (let k = 0; k < count; k++) {
			const n = (letter: string, x: number, y: number) => {
				nodes.push({ id: `${k}-${letter}`, x, y: y + k * 100 });
				return `${k}-${letter}`;
			};
			const s = (id: string, a: string, b: string, preset: string) =>
				segments.push({
					id: `${k}-${id}`,
					startNodeId: a,
					endNodeId: b,
					lanes: createLanesFrom(preset).map((l, i) => ({ ...l, id: `l${i}` }))
				});
			s('road', n('a', -50, 0), n('b', 50, 0), 'street');
			const p = n('p', 0, 4.5);
			s('west', p, n('q', -10, 20), 'path');
			s('east', p, n('r', 10, 20), 'path');
		}
		const graph = liveShape({ nodes, segments });
		const networks = new Networks();
		networks.build(graph as never);
		const placed = spyOn(roadLine, 'roadAt');
		const walked = spyOn(overlay, 'walkAt');
		graph.nodes.get('0-a')!.x += 0.25;
		networks.build(graph as never);
		const counts = [placed.mock.calls.length, walked.mock.calls.length];
		placed.mockRestore();
		walked.mockRestore();
		return counts;
	};
	expect(work(256)).toEqual(work(32));
});

test('a nudge far from every footpath reads no more of the footpaths elsewhere than their keys, however many there are', () => {
	// Groups 200 m apart, each a street and two footpaths leaving one node
	// on its sidewalk; the first street's end nudged. Of every other group's
	// footpaths and their nodes a build reads only what each strip's cache
	// compares (core/footpaths.ts: its nodes, where they lie, the edits on
	// them, its curve's handle, its shift and its cross-section), and as many
	// footpath pieces are laid again and filed afresh with 256 groups as with
	// 32.
	const key = {
		segment: new Set<PropertyKey>([
			'id',
			'lanes',
			'startNodeId',
			'endNodeId',
			'controlX',
			'controlY',
			'offsetStart',
			'offsetEnd'
		]),
		node: new Set<PropertyKey>(['id', 'x', 'y', 'junction'])
	};
	const work = (count: number) => {
		const nodes: GraphData['nodes'] = [];
		const segments: GraphData['segments'] = [];
		for (let k = 0; k < count; k++) {
			const n = (letter: string, x: number, y: number) => {
				nodes.push({ id: `${k}-${letter}`, x: x + k * 200, y });
				return `${k}-${letter}`;
			};
			const s = (id: string, a: string, b: string, preset: string) =>
				segments.push({
					id: `${k}-${id}`,
					startNodeId: a,
					endNodeId: b,
					lanes: createLanesFrom(preset).map((l, i) => ({ ...l, id: `l${i}` }))
				});
			s('road', n('a', -50, 0), n('b', 50, 0), 'street');
			const p = n('p', 0, 4.5);
			s('west', p, n('q', -10, 20), 'path');
			s('east', p, n('r', 10, 20), 'path');
		}
		const graph = liveShape({ nodes, segments });
		const networks = new Networks();
		networks.build(graph as never);
		// Every read of another group's footpaths and footpath nodes beyond
		// their keys.
		const beyond: string[] = [];
		const counted = <T extends object>(id: string, of: T, keys: Set<PropertyKey>) =>
			new Proxy(of, {
				get(target, prop, receiver) {
					if (!keys.has(prop)) beyond.push(`${id}.${String(prop)}`);
					return Reflect.get(target, prop, receiver);
				}
			});
		const far = (id: string) => !id.startsWith('0-');
		for (const [id, s] of graph.segments)
			if (far(id) && !id.endsWith('road')) graph.segments.set(id, counted(id, s, key.segment));
		for (const [id, n] of graph.nodes)
			if (far(id) && !/-[ab]$/.test(id)) graph.nodes.set(id, counted(id, n, key.node));
		const laid = spyOn(overlay, 'layOver');
		const filed = spyOn(overlay.BoxGrid.prototype, 'remove');
		graph.nodes.get('0-a')!.x += 0.25;
		networks.build(graph as never);
		const counts = [laid.mock.calls.length, filed.mock.calls.length];
		laid.mockRestore();
		filed.mockRestore();
		return { beyond, counts };
	};
	const [few, many] = [work(32), work(256)];
	expect(many.beyond).toEqual([]);
	expect(many.counts).toEqual(few.counts);
});

test('a drop held over its marker reads only the roads the join changes, however many there are', () => {
	// Rows 200 m apart, each a street, a dead end street off it and a
	// footpath; the first dead end joined onto its street in a copy (as a
	// drop held over its marker is checked, modes/select.ts). The dead end's
	// road runs on in a line through two nodes of two roads to an end
	// attached at the edge of a cross street, placed as that whole road
	// places it (wholeOf in core/attach.ts), so the join bending its last
	// piece reads that end again, two pieces away. Nothing of the graph is
	// walked whole, as many road ends and lines are read with 256 rows as
	// with 32, and what is read matches the graph the join makes.
	const work = (count: number) => {
		const nodes: GraphData['nodes'] = [];
		const segments: GraphData['segments'] = [];
		for (let k = 0; k < count; k++) {
			const n = (letter: string, x: number, y: number) => {
				nodes.push({ id: `${k}-${letter}`, x, y: y + k * 200 });
				return `${k}-${letter}`;
			};
			const s = (id: string, a: string, b: string, preset: string) =>
				segments.push({
					id: `${k}-${id}`,
					startNodeId: a,
					endNodeId: b,
					lanes: createLanesFrom(preset).map((l, i) => ({ ...l, id: `l${i}` }))
				});
			s('host', n('a', -60, 0), n('b', 60, 0), 'street');
			const lead = n('lead', 75, 80);
			s('cross', n('c', 115, 40), lead, 'street');
			s('cross2', lead, n('d', 35, 120), 'street');
			s('own0', lead, n('p', 55, 60), 'street');
			s('own1', `${k}-p`, n('far', 35, 40), 'street');
			s('own', `${k}-far`, n('tip', 15, 20), 'street');
			nodes.find((v) => v.id === lead)!.junction = { sides: { [`${k}-own0`]: 'right' } };
			s('walk', n('w', -40, 30), n('z', -10, 60), 'path');
		}
		const graph = new Graph();
		graph.fromJSON({ nodes, segments });
		const networks = new Networks();
		networks.build(graph);
		// Every walk over the graph's segments, counted.
		let walked = 0;
		for (const key of ['keys', 'values', 'entries', Symbol.iterator, 'forEach'] as const) {
			const own = graph.segments[key].bind(graph.segments) as () => Iterable<unknown>;
			Object.defineProperty(graph.segments, key, {
				value: (...args: never[]) => {
					walked++;
					return (own as (...a: never[]) => Iterable<unknown>)(...args);
				}
			});
		}
		const ends = spyOn(attach, 'endAt');
		const lines = spyOn(roadLine, 'sameLine');
		const copy = copyAround(graph, ['0-own', '0-host']);
		const known = new Set(copy.segments.keys());
		const at = copy.createNode(20, 0);
		splitSegment(copy, copy.segments.get('0-host')!, 80 / 120, at.id);
		expect(copy.merge('0-tip', at.id)).toBe(true);
		const view = laidOver(graph, copy, known);
		const roads = networks.shownIn(view, [...known, ...copy.segments.keys()]);
		const pairs = crossingPairs(roads, roads.relined);
		const counts = [walked, ends.mock.calls.length, lines.mock.calls.length];
		const read = [
			...new Set(lines.mock.calls.map(([, s]) => ('id' in s ? String(s.id) : '')))
		].sort();
		ends.mockRestore();
		lines.mockRestore();
		// Every road shows as in the joined graph read afresh.
		const joined = new Graph();
		joined.fromJSON({
			nodes: [...view.nodes.values()].map(({ id, x, y, junction }) => ({
				id,
				x,
				y,
				...(junction && { junction })
			})),
			segments: [...view.segments.values()].map((s) => s.toJSON())
		});
		const fresh = linesOf(joined);
		const ids = [...joined.segments.keys()];
		const shown = (of: typeof fresh) => ids.map((id) => JSON.stringify(of.road(id)?.line));
		expect(shown(roads)).toEqual(shown(fresh));
		return { counts, read, relined: [...roads.relined].sort(), pairs: [...pairs] };
	};
	const [few, many] = [work(32), work(256)];
	expect(few.relined.length).toBeGreaterThan(0);
	expect(few.pairs).toEqual([]);
	// No walk over the graph's segments, and of the roads the last build
	// showed only the dead end's road is read again, the whole of it.
	expect(few.counts[0]).toBe(0);
	expect(few.read).toEqual(['0-own', '0-own0', '0-own1']);
	expect(many.read).toEqual(few.read);
	expect(many.counts).toEqual(few.counts);
}, 30_000);

test('a kept build draws every footpath over the cars as a fresh build does, edit after edit', () => {
	// A footpath crossing a street at p runs on inside the roadway through q
	// and r before it leaves it at z: whether it crosses is read from z, three
	// pieces away. z dragged back across the street ends the crossing; a
	// setback set at q, on a footpath that only carries on through it, and
	// taken off again, changes nothing else.
	const lanes = (preset: string) => createLanesFrom(preset).map((l, i) => ({ ...l, id: `l${i}` }));
	const s = (id: string, a: string, b: string, preset: string) => ({
		id,
		startNodeId: a,
		endNodeId: b,
		lanes: lanes(preset)
	});
	const graph = liveShape({
		nodes: [
			{ id: 'w', x: -65, y: 0 },
			{ id: 'e', x: 65, y: 0 },
			{ id: 'a', x: 0, y: -24 },
			{ id: 'p', x: 0, y: 0 },
			{ id: 'q', x: 12, y: 1 },
			{ id: 'r', x: 24, y: -1 },
			{ id: 'z', x: 40, y: 22 }
		],
		segments: [
			s('street', 'w', 'e', 'street'),
			s('ap', 'a', 'p', 'path'),
			s('pq', 'p', 'q', 'path'),
			s('qr', 'q', 'r', 'path'),
			s('rz', 'r', 'z', 'path')
		]
	});
	const kept = new Networks();
	// Every piece drawn, but the keys its caches go by.
	const json = (d: unknown) => JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v));
	const drawn = (networks: Networks) => {
		const { scene } = networks.build(graph as never);
		return [
			...scene.place.roads.map((r) => json(scene.road(r.id))),
			...scene.place.junctions.map((j) => json(scene.node(j.id)))
		];
	};
	const zebras = () =>
		new Networks()
			.build(graph as never)
			.scene.road('street')!
			.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra')).length;
	const edits: [string, () => void][] = [
		['as saved', () => {}],
		['z dragged back across', () => (graph.nodes.get('z')!.y = -19)],
		['z dragged over again', () => (graph.nodes.get('z')!.y = 22)],
		['a setback at q', () => (graph.nodes.get('q')!.junction = { setbacks: { pq: 2 } })],
		['none at q', () => (graph.nodes.get('q')!.junction = undefined)]
	];
	const crossed: number[] = [];
	for (const [label, edit] of edits) {
		edit();
		expect([label, drawn(kept)]).toEqual([label, drawn(new Networks())]);
		crossed.push(zebras());
	}
	expect(crossed[1]).toBe(0);
	expect(crossed[2]).toBeGreaterThan(0);
});

for (const moved of ['street', 'footpath'] as const)
	test(`a kept build draws as a fresh one after a ${moved} is laid across a ${moved === 'street' ? 'footpath' : 'street'} by both its nodes, its control point and its shift`, () => {
		// `b` slants from (20, 15) to (60, 35), clear of `a` along y = 0, and
		// is laid across it each way a move can and taken back off it: the
		// other kind, so it crosses it as a zebra and nothing is cut.
		const preset = (kind: string) => createLanesFrom(kind === 'street' ? 'street' : 'path');
		const under = moved === 'street' ? 'footpath' : 'street';
		const graph = liveShape({
			nodes: [
				{ id: 'a1', x: -60, y: 0 },
				{ id: 'a2', x: 100, y: 0 },
				{ id: 'b1', x: 20, y: 15 },
				{ id: 'b2', x: 60, y: 35 }
			],
			segments: [
				{ id: 'a', startNodeId: 'a1', endNodeId: 'a2', lanes: preset(under) },
				{ id: 'b', startNodeId: 'b1', endNodeId: 'b2', lanes: preset(moved) }
			]
		});
		const b = graph.segments.get('b')!;
		const at = (id: string, x: number, y: number) => Object.assign(graph.nodes.get(id)!, { x, y });
		const kept = new Networks();
		const json = (d: unknown) => JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v));
		const drawn = (networks: Networks) => {
			const { scene } = networks.build(graph as never);
			return [
				...scene.place.roads.map((r) => json(scene.road(r.id))),
				...scene.place.junctions.map((j) => json(scene.node(j.id)))
			];
		};
		const street = moved === 'street' ? 'b' : 'a';
		const zebras = () =>
			new Networks()
				.build(graph as never)
				.scene.road(street)!
				.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra')).length;
		// Shifted 30 m to its left (a shift is metres to its right), `b` lies
		// across `a` halfway along.
		const edits: [string, boolean, () => void][] = [
			['as saved', false, () => {}],
			['both nodes moved across', true, () => (at('b1', 20, -10), at('b2', 60, 10))],
			['both nodes moved back', false, () => (at('b1', 20, 15), at('b2', 60, 35))],
			[
				'its control point bent across',
				true,
				() => Object.assign(b, { controlX: 40, controlY: -40, hasControlPoint: true })
			],
			[
				'straightened',
				false,
				() => Object.assign(b, { controlX: undefined, controlY: undefined, hasControlPoint: false })
			],
			['shifted across', true, () => Object.assign(b, { offsetStart: -30, offsetEnd: -30 })],
			['shifted back', false, () => Object.assign(b, { offsetStart: 0, offsetEnd: 0 })]
		];
		for (const [label, across, edit] of edits) {
			edit();
			expect([label, drawn(kept)]).toEqual([label, drawn(new Networks())]);
			expect([label, zebras() > 0]).toEqual([label, across]);
			expect([label, graph.segments.size, graph.nodes.size]).toEqual([label, 2, 4]);
		}
	});

test('a short road between two junctions keeps its touching test only while it is short enough to merge them, whichever end moves away', () => {
	const graph = new Graph();
	const networks = new Networks();
	const lanes = createLanesFrom('street');
	const tested = () =>
		(networks as unknown as { cars: { touching: Map<string, unknown> } }).cars.touching;
	const links: string[] = [];
	// Two T junctions joined by a 10 m link, pulled apart past the merge limit
	// one way or the other, at each of 6 places, then one pushed back.
	for (let i = 0; i < 6; i++) {
		const x = i * 400;
		const [a, b] = [graph.createNode(x, 0), graph.createNode(x + 10, 0)];
		const [side, far] = [graph.createNode(x + 10, -70), graph.createNode(x + 180, 0)];
		links.push(graph.createSegment(a.id, b.id, lanes).id);
		graph.createSegment(graph.createNode(x - 70, 0).id, a.id, lanes);
		graph.createSegment(a.id, graph.createNode(x, 70).id, lanes);
		graph.createSegment(b.id, far.id, lanes);
		graph.createSegment(b.id, side.id, lanes);
		networks.build(graph);
		expect([i, tested().has(links[i])]).toEqual([i, true]);
		const moved = i % 2 ? a : b;
		const by = i % 2 ? -90 : 90;
		if (moved === b) side.x += by;
		moved.x += by;
		networks.build(graph);
		expect([i, tested().has(links[i])]).toEqual([i, false]);
	}
	expect([...tested().keys()]).toEqual([]);
	const b = graph.segments.get(links[0])!.endNodeId;
	graph.nodes.get(b)!.x -= 85;
	networks.build(graph);
	expect([...tested().keys()]).toEqual([links[0]]);
});

test('the cross-sections kept from build to build are those the roads have now, however often a road is widened', () => {
	const graph = new Graph();
	const [a, b, c] = [graph.createNode(0, 0), graph.createNode(80, 0), graph.createNode(80, 70)];
	const street = graph.createSegment(a.id, b.id, createLanesFrom('street'));
	graph.createSegment(b.id, c.id, createLanesFrom('street'));
	const networks = new Networks();
	networks.build(graph);
	const sections = () =>
		(networks as unknown as { cars: { sections: Map<string, unknown> } }).cars.sections;
	for (let i = 1; i <= 20; i++) {
		const lanes = street.cloneLanes();
		lanes[1].width = 3 + i / 100;
		graph.setLanes([[street, lanes]]);
		networks.build(graph);
	}
	expect([...sections().keys()].sort()).toEqual(
		[...new Set([...graph.segments.values()].map((s) => s.lanesKey))].sort()
	);
});

test('a short road keeps its touching test only while it links two junctions, however the roads at one of them go', () => {
	const graph = new Graph();
	const networks = new Networks();
	const lanes = createLanesFrom('street');
	const tested = () =>
		(networks as unknown as { cars: { touching: Map<string, unknown> } }).cars.touching;
	const ways = [
		'both deleted',
		'both footpaths',
		'one deleted',
		'both deleted, set clear'
	] as const;
	const links: string[] = [];
	const trims = () =>
		(
			networks as unknown as {
				cars: { kept: { spans: Map<string, { d0: number; length: number }> } };
			}
		).cars.kept.spans;
	// Two T junctions joined by a 10 m link, at each place the two side roads
	// at one end (either end) deleted, turned to footpaths, or one deleted so
	// the link carries on into the other; or, the side road shifted clear of
	// the link so that end trims it none, both deleted, its shape the same;
	// the last place left as it is.
	for (let i = 0; i <= 2 * ways.length; i++) {
		const x = i * 400;
		const [a, b] = [graph.createNode(x, 0), graph.createNode(x + 10, 0)];
		links.push(graph.createSegment(a.id, b.id, lanes).id);
		// Straight on from the link, stored the way it runs, and off to the side.
		const on = (at: { id: string }) => {
			const to = graph.createNode(at === a ? x - 10 : x + 20, 0);
			return at === a
				? graph.createSegment(to.id, a.id, lanes)
				: graph.createSegment(b.id, to.id, lanes);
		};
		const sides = (at: { id: string }, dx: number) => [
			on(at),
			graph.createSegment(at.id, graph.createNode(x + dx, 70).id, lanes)
		];
		const [atA, atB] = [sides(a, 0), sides(b, 10)];
		const way = ways[i % ways.length];
		const gone = i < ways.length ? atB : atA;
		const clear = way === 'both deleted, set clear' && i < 2 * ways.length;
		if (clear) {
			// Running north, a road's right is west: these lie clear of the link.
			const side = gone[1];
			side.offsetStart = side.offsetEnd = gone === atB ? -15 : 15;
		}
		networks.build(graph);
		expect([i, tested().has(links[i])]).toEqual([i, true]);
		if (i === 2 * ways.length) break;
		const span = trims().get(links[i])!;
		const trimmed = gone === atB ? 10 - span.d0 - span.length : span.d0;
		if (clear) expect([way, i, trimmed]).toEqual([way, i, 0]);
		if (way === 'both footpaths')
			graph.setLanes(gone.map((s) => [s, createLanesFrom('path')] as const));
		else for (const s of way === 'one deleted' ? gone.slice(1) : gone) graph.deleteSegment(s.id);
		networks.build(graph);
		expect([way, i, tested().has(links[i])]).toEqual([way, i, false]);
	}
	expect([...tested().keys()]).toEqual([links[2 * ways.length]]);
});

test('a road read whole at a node of two sides is let go once its segment is gone, whether or not it led the road it carried on into', () => {
	const graph = new Graph();
	const networks = new Networks();
	const whole = () =>
		(networks as unknown as { cars: { wholeRoads: Map<string, unknown> } }).cars.wholeRoads;
	const [a, b] = [graph.createNode(0, 0), graph.createNode(40, 0)];
	const first = graph.createSegment(a.id, b.id, createLanesFrom('street'));
	networks.build(graph);
	// A Street carried on from either end of the first, stored the way it
	// runs: shifted at the node it is read whole there; unshifted it carries
	// on as part of the road, and its far node deleted takes it away.
	for (const [i, at] of [b, a, b, a].entries()) {
		const far = graph.createNode(at === b ? 120 : -80, 0);
		const next =
			at === b
				? graph.createSegment(b.id, far.id, first.lanes)
				: graph.createSegment(far.id, a.id, first.lanes);
		const shift = (by: number) => {
			if (at === b) next.offsetStart = by;
			else next.offsetEnd = by;
		};
		shift(2);
		networks.build(graph);
		expect([i, whole().has(next.id)]).toEqual([i, true]);
		shift(0);
		const joined = networks.build(graph);
		expect([i, joined.derived.units.get(next.id)?.length]).toEqual([i, 2]);
		graph.deleteNode(far.id);
		networks.build(graph);
		expect([i, [...whole().keys()].filter((id) => !graph.segments.has(id))]).toEqual([i, []]);
	}
});

test('the joined curves kept from build to build are those of the roads joined now, however often the graph is replaced', () => {
	const graph = new Graph();
	const networks = new Networks();
	const joined = () =>
		(networks as unknown as { cars: { joinedCache: Map<string, unknown> } }).cars.joinedCache;
	const lanes = createLanesFrom('street');
	// Two Streets carrying on through b, read in again under new ids, as
	// undo and redo replace the graph under a kept builder.
	for (let i = 1; i <= 5; i++) {
		const [first, next] = [`segment-${2 * i}`, `segment-${2 * i + 1}`];
		graph.fromJSON({
			nodes: [
				{ id: 'a', x: 0, y: 0 },
				{ id: 'b', x: 40, y: 0 },
				{ id: 'c', x: 80, y: 0 }
			],
			segments: [
				{ id: first, startNodeId: 'a', endNodeId: 'b', lanes },
				{ id: next, startNodeId: 'b', endNodeId: 'c', lanes }
			]
		} as GraphData);
		expect(networks.build(graph).derived.units.get(next)).toEqual([first, next]);
		expect([i, [...joined().keys()]]).toEqual([i, [first]]);
	}
});
