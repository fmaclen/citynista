import { expect, test } from 'bun:test';
import { carries } from '../src/lib/core/lane-types';
import type { GraphData, Lane } from '../src/lib/core/types';
import { openEditor } from './editor.svelte';
import { buildModel } from './model';

// Drawing footpaths with the editor's own gestures: a footpath meets a
// street only where it is drawn, on the walkway under the pointer or across
// it, where the crossing is paint and cuts nothing; it lands on a footpath
// node lying and showing at the spot it snapped to, so none is laid twice
// and none has no length; a road drawn on after the brush is switched takes
// a node of its own and moves nothing of the other kind; and each cut and
// road laid is an undo step of its own. The lane panel's part is in
// e2e/footpath-drawing.test.ts.

type Pt = { x: number; y: number };
type Ui = ReturnType<typeof openEditor>;
const p = (x: number, y: number): Pt => ({ x, y });
// Metres a pixel at the browser's top-down camera at `zoom` (720 px for
// 500 m at zoom 1), so snap rings measured in pixels are the page's.
const perPixel = (zoom: number) => 500 / 720 / zoom;

const walks = (graph: GraphData) => graph.segments.filter((s) => !carries(s.lanes));
// The car part of a graph: its car segments and the nodes they meet at, as
// saved, by id.
function carGraph(graph: GraphData) {
	const segments = graph.segments.filter((s) => carries(s.lanes));
	const ids = new Set(segments.flatMap((s) => [s.startNodeId, s.endNodeId]));
	const byId = <T extends { id: string }>(list: T[]) =>
		[...list].sort((a, b) => (a.id < b.id ? -1 : 1));
	return { nodes: byId(graph.nodes.filter((n) => ids.has(n.id))), segments: byId(segments) };
}
// The nodes holding both kinds of road.
const mixed = (graph: GraphData) =>
	graph.nodes
		.filter((n) => {
			const here = graph.segments.filter((s) => s.startNodeId === n.id || s.endNodeId === n.id);
			return here.some((s) => carries(s.lanes)) && here.some((s) => !carries(s.lanes));
		})
		.map((n) => n.id);
// The footpath nodes two footpaths meet at, none of `was`.
const crossingNodes = (graph: GraphData, was: Set<string>) =>
	graph.nodes.filter(
		(n) =>
			!was.has(n.id) &&
			walks(graph).filter((s) => s.startNodeId === n.id || s.endNodeId === n.id).length === 2
	);

const street = {
	nodes: [
		{ id: 'w', x: -65, y: 0 },
		{ id: 'e', x: 65, y: 0 }
	],
	segments: [
		{
			id: 'street',
			startNodeId: 'w',
			endNodeId: 'e',
			lanes: [
				{
					id: 's0',
					role: 'pedestrian',
					material: 'concrete',
					width: 2,
					direction: 'bidirectional'
				},
				{ id: 'b', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
				{ id: 'f', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
				{ id: 's1', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
			] satisfies Lane[]
		}
	]
} satisfies GraphData;

// The editor on `graph` at the browser's `zoom`, a click first moving the
// pointer there as the page's does, and the toolbar's draw style.
function open(graph: GraphData, zoom = 4) {
	const ui = openEditor(structuredClone(graph), perPixel(zoom));
	const click = (q: Pt, o: { ctrl?: boolean } = {}) => {
		ui.hover(q.x, q.y, o);
		ui.click(q.x, q.y, o);
	};
	const drag = (from: Pt, to: Pt) => {
		ui.hover(from.x, from.y);
		ui.drag(from, to);
	};
	const straight = () => ui.editor.setDrawStyle('straight');
	const escape = () => {
		ui.key('Escape');
		ui.key('Escape');
	};
	return { ui, click, drag, straight, escape };
}

// Undoes the last edit and redoes it: the graph as it was before it (`was`),
// then exactly as it was after (`now`), no node holding both kinds either
// time.
function undoRedo(ui: Ui, was: GraphData, now: GraphData) {
	ui.key('z', { ctrl: true });
	expect(ui.graph()).toEqual(was);
	expect(mixed(ui.graph())).toEqual([]);
	ui.key('z', { ctrl: true, shift: true });
	expect(ui.graph()).toEqual(now);
	expect(mixed(ui.graph())).toEqual([]);
}

test("a road drawn on after the brush is switched takes a node of its own, moves nothing of the other kind, and leaves a car node's edits byte for byte", () => {
	// The street's west end w holds edits, empty lists and all.
	const held = {
		...street,
		nodes: street.nodes.map((n) =>
			n.id === 'w' ? { ...n, junction: { added: [], removed: [] } } : n
		)
	};
	const { ui, click, drag, straight, escape } = open(held);
	const opened = ui.graph();
	const before = carGraph(opened);
	// Anchored at the street's west end with the Street brush, then switched
	// to Path: the footpath starts on a node of its own where the end is,
	// and w's edits stay as stored.
	ui.brush('Street');
	straight();
	click(p(-65, 0));
	ui.brush('Path');
	click(p(-60, 25));
	escape();
	const drawn = ui.graph();
	expect(walks(drawn)).toHaveLength(1);
	expect(JSON.stringify(carGraph(drawn))).toBe(JSON.stringify(carGraph(opened)));
	expect(mixed(drawn)).toEqual([]);
	const start = drawn.nodes.find((n) => n.id === walks(drawn)[0].startNodeId)!;
	expect([start.id === 'w', start.x, start.y]).toEqual([false, -65, 0]);

	// Dragged by its body, the footpath moves alone; deleted, so does it.
	drag(p(-62.5, 12.5), p(-62.5, 19.5));
	const dragged = ui.graph();
	expect(dragged.nodes.find((n) => n.id === start.id)!.y).toBeGreaterThan(5);
	expect(carGraph(dragged)).toEqual(before);
	click(p(-62.5, 19.5));
	ui.key('Delete');
	expect(walks(ui.graph())).toHaveLength(0);
	expect(carGraph(ui.graph())).toEqual(before);

	// The other way round: a street drawn on from a footpath's end leaves it
	// where it is.
	ui.key('z', { ctrl: true });
	expect(ui.graph()).toEqual(dragged);
	const end = dragged.nodes.find((n) => n.id === walks(dragged)[0].endNodeId)!;
	// (Path is still the armed slot: picking it again would put it down.)
	ui.brush('Street');
	ui.brush('Path');
	click(end);
	ui.brush('Street');
	click(p(end.x + 25, end.y));
	escape();
	const both = ui.graph();
	expect(both.segments).toHaveLength(3);
	expect(mixed(both)).toEqual([]);
	expect(walks(both)).toEqual(walks(dragged));
	expect(ui.stale()).toEqual([]);
});

// A first click on a street's middle with the Street brush cuts it there,
// one undo step, as a cut always is. Switched to the Path brush, the
// footpath starts on the street's sidewalk nearest that click, and the
// street keeps that one cut and nothing else of it changes. Escaped with
// nothing laid, the street is whole again.
test('a street clicked with the Street brush is cut there, and a footpath drawn on after switching to Path leaves that cut as it is', () => {
	const { ui, click, straight, escape } = open(street);
	const before = ui.graph();
	const anchor = () => {
		ui.brush('Street');
		straight();
		// A metre south of its middle: the side a footpath starting there
		// takes.
		click(p(-18, 1));
		expect(carGraph(ui.graph()).segments).toHaveLength(2);
	};

	// The click cuts the street; then the brush switched, the footpath
	// starts on the street's south sidewalk.
	anchor();
	const cut = ui.graph();
	const [node] = cut.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
	expect([node.x, node.y]).toEqual([expect.closeTo(-18, 0), expect.closeTo(0, 6)]);
	ui.brush('Path');
	click(p(-18, 25));
	escape();
	const drawn = ui.graph();
	expect(walks(drawn)).toHaveLength(1);
	expect(carGraph(drawn)).toEqual(carGraph(cut));
	expect(mixed(drawn)).toEqual([]);
	const start = drawn.nodes.find((n) => n.id === walks(drawn)[0].startNodeId)!;
	expect([start.x, start.y]).toEqual([expect.closeTo(-18, 0), expect.closeTo(4.5, 6)]);
	// Undo takes back the footpath and leaves the cut; the next, the cut.
	undoRedo(ui, cut, drawn);
	ui.key('z', { ctrl: true });
	expect(ui.graph()).toEqual(cut);
	ui.key('z', { ctrl: true });
	expect(ui.graph()).toEqual(before);

	// Then Escape with nothing laid: the street whole, nothing to undo.
	anchor();
	escape();
	expect(ui.graph()).toEqual(before);
	expect(ui.editor.canUndo).toBe(false);

	// Then Undo takes back the cut, and Redo puts it back.
	anchor();
	undoRedo(ui, before, cut);
	ui.key('z', { ctrl: true });
	expect(ui.graph()).toEqual(before);

	// Finished with the Street brush: the cut and the road laid from it are
	// an undo step each.
	anchor();
	click(p(-18, 25));
	escape();
	const tee = ui.graph();
	expect(tee.segments).toHaveLength(3);
	expect(mixed(tee)).toEqual([]);
	undoRedo(ui, cut, tee);
	expect(ui.stale()).toEqual([]);
});

// A footpath laid in two pieces, the first ending just past the street's
// middle, the second on across its far curb, crosses it: the zebra is drawn
// and nothing is cut.
test('a crossing drawn in two clicks through the roadway is drawn, cut nowhere', () => {
	const { ui, click, straight, escape } = open(street, 8);
	const before = carGraph(ui.graph());
	ui.brush('Path');
	straight();
	for (const q of [p(0, -18), p(0, 2), p(12, 18)]) click(q, { ctrl: true });
	escape();
	const graph = ui.graph();
	expect(walks(graph)).toHaveLength(2);
	expect(carGraph(graph)).toEqual(before);
	// The footpath's one inner node, where the first piece ended, at y = 2.
	const inner = crossingNodes(graph, new Set(street.nodes.map((n) => n.id)));
	expect(inner.map((n) => [n.x, n.y])).toEqual([[expect.closeTo(0, 1), expect.closeTo(2, 1)]]);
	expect(ui.stale()).toEqual([]);
	const zebras = buildModel(graph)
		.scene.road('street')!
		.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra'));
	expect(zebras.length).toBeGreaterThan(0);
});

// What no drawing stores: a segment of no length, two segments joining the
// same two nodes, two nodes of one kind at one spot.
function flaws(graph: GraphData) {
	const node = new Map(graph.nodes.map((n) => [n.id, n]));
	const ends = (s: GraphData['segments'][number]) => [s.startNodeId, s.endNodeId].sort().join(' ');
	const kind = (id: string) =>
		graph.segments.some((s) => carries(s.lanes) && (s.startNodeId === id || s.endNodeId === id));
	const length = (s: GraphData['segments'][number]) => {
		const [a, b] = [node.get(s.startNodeId)!, node.get(s.endNodeId)!];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};
	return [
		...graph.segments.filter((s) => length(s) < 0.001).map((s) => `${s.id} has no length`),
		...graph.segments.flatMap((s, i) =>
			graph.segments
				.slice(i + 1)
				.filter((t) => ends(t) === ends(s))
				.map((t) => `${s.id} and ${t.id} join the same nodes`)
		),
		...graph.nodes.flatMap((a, i) =>
			graph.nodes
				.slice(i + 1)
				.filter((b) => kind(a.id) === kind(b.id) && Math.hypot(a.x - b.x, a.y - b.y) < 0.001)
				.map((b) => `${a.id} and ${b.id} lie at one spot`)
		)
	];
}

// Footpaths drawn through clicks that land an end where a footpath node
// already lies, or that would lay a footpath already there: each end lands
// on that node, so no footpath has no length, none is laid twice, and no two
// footpath nodes (nor two car nodes) lie at one spot.
const lane = street.segments[0].lanes[0];
const paths = {
	nodes: [
		{ id: 'a', x: -40, y: 23 },
		{ id: 'b', x: 29, y: 23 }
	],
	segments: [{ id: 'path', startNodeId: 'a', endNodeId: 'b', lanes: [lane] }]
} satisfies GraphData;
// A footpath leading off the street's east end, its node where the end is.
const offEnd = {
	nodes: [...street.nodes, { id: 'x', x: 65, y: 0 }, { id: 'y', x: 80, y: 22 }],
	segments: [...street.segments, { id: 'off', startNodeId: 'x', endNodeId: 'y', lanes: [lane] }]
} satisfies GraphData;
type Step = Pt | 'Path' | 'Street' | 'Control' | 'release' | { double: Pt };
// Each case: its city, the zoom, the brush and the clicks, how many
// footpaths it leaves, whether its car roads stay as they were, and how many
// nodes its footpaths end on.
const cases: [string, GraphData, number, Step[], number, boolean?, number?][] = [
	['a sidewalk spot clicked twice', street, 8, ['Path', p(-10, 2), p(-10, 0.5), p(15, 23)], 1],
	['a sidewalk spot double-clicked', street, 4, ['Path', { double: p(1, 2) }, p(17, 23)], 1],
	[
		'Ctrl-double-click on open ground',
		street,
		4,
		['Path', 'Control', { double: p(12, 25) }, 'release', p(31, 25)],
		1
	],
	['back onto the endpoint before', street, 4, ['Path', p(-27, -24), p(1, -22), p(-27, -24)], 1],
	['again between its ends', paths, 4, ['Path', p(-40, 23), p(29, 23)], 1],
	['again along its middle', paths, 4, ['Path', p(-18, 23), p(12, 23)], 1],
	[
		'from a Street click on the street, the same spot again',
		street,
		8,
		['Street', p(-10, 2), 'Path', p(-10, 2), p(15, 22)],
		1
	],
	[
		"from a Street click on the street's end, onto the footpath node there",
		offEnd,
		4,
		['Street', p(65, 0), 'Path', p(65, 0), p(57, 26)],
		2
	],
	[
		"from a Street click on the street's end, a footpath node there",
		offEnd,
		4,
		['Street', p(65, 0), 'Path', p(55, 25)],
		2
	],
	// Drawn back to the sidewalk spot it started from, a footpath closes: its
	// last end lands on its first node.
	[
		'back to its start on a sidewalk',
		street,
		8,
		['Path', p(0, 1), p(0, 18), p(26, 18), p(0, 1)],
		3,
		true,
		3
	]
];
for (const [name, graph, zoom, steps, footpaths, carsKept, endNodes] of cases)
	test(`footpath clicks onto a footpath node already there join it, and none lays a footpath twice: ${name}`, () => {
		const { ui, straight, escape } = open(graph, zoom);
		const before = carGraph(ui.graph());
		ui.brush(steps[0] as string);
		straight();
		// Control held as the page's keyboard holds it: on every pointer
		// event until let go.
		let ctrl = false;
		for (const step of steps.slice(1)) {
			if (step === 'Path' || step === 'Street') ui.brush(step);
			else if (step === 'Control') {
				ctrl = true;
				ui.key('Control', { ctrl });
			} else if (step === 'release') ctrl = false;
			else {
				const q = 'double' in step ? step.double : step;
				ui.hover(q.x, q.y, { ctrl });
				if ('double' in step) {
					for (let k = 0; k < 2; k++) ui.click(q.x, q.y, { ctrl });
					ui.fire('dblclick', q.x, q.y, { ctrl });
				} else ui.click(q.x, q.y, { ctrl });
			}
		}
		escape();
		const drawn = ui.graph();
		expect([walks(drawn).length, flaws(drawn)]).toEqual([footpaths, []]);
		if (carsKept) expect(carGraph(drawn)).toEqual(before);
		if (endNodes)
			expect(new Set(walks(drawn).flatMap((s) => [s.startNodeId, s.endNodeId])).size).toBe(
				endNodes
			);
		expect(ui.stale()).toEqual([]);
	});

test("Undo at a footpath's start on a sidewalk takes back that start alone, and Redo puts nothing back", () => {
	const { ui, click, straight } = open(street);
	ui.brush('Path');
	straight();
	click(p(-30, 25));
	click(p(-14, 25));
	ui.key('Escape');
	const drawn = ui.graph();
	expect(walks(drawn)).toHaveLength(1);
	click(p(12, 2));
	expect(ui.graph().nodes).toHaveLength(drawn.nodes.length + 1);
	ui.key('z', { ctrl: true });
	expect(ui.graph()).toEqual(drawn);
	ui.key('z', { ctrl: true, shift: true });
	expect(ui.graph()).toEqual(drawn);
	// The next click starts afresh, off the sidewalk.
	click(p(20, 30));
	click(p(40, 30));
	ui.key('Escape');
	const after = ui.graph();
	expect(walks(after)).toHaveLength(2);
	expect(flaws(after)).toEqual([]);
	expect(after.nodes.filter((n) => Math.abs(n.x - 12) < 3 && n.y > 0 && n.y < 10)).toEqual([]);
	expect(ui.stale()).toEqual([]);
});
