import { expect, test } from 'bun:test';
import { PlaceBuilder } from '../src/lib/core/place';
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
function trimsAt(builder: PlaceBuilder, graph: Live, nodeId: string) {
	const derived = builder.build(graph as never);
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
	// 5 m right at b. The lane runs straight from a to b across the line.
	const lanes: Lane[] = [
		{ id: 'l0', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
	];
	const data: GraphData = {
		nodes: [
			{ id: 'a', x: -100, y: 0 },
			{ id: 'm', x: 0, y: 0 },
			{ id: 'b', x: 100, y: 0 }
		],
		segments: [
			{ id: 'in', startNodeId: 'a', endNodeId: 'm', offsetStart: -5, offsetEnd: 0, lanes },
			{ id: 'out', startNodeId: 'm', endNodeId: 'b', offsetStart: 0, offsetEnd: 5, lanes }
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
	const builder = new PlaceBuilder();
	const draw = editorDrawing(builder);
	draw(graph);
	const before = trimsAt(builder, graph, 't');
	builder.hold('t');
	// With every connection gone the lanes shift nowhere: no taper is needed.
	const removed = builder.build(graph as never).junctions.get('t')!.connections;
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
