import { expect, test } from 'bun:test';
import { carries } from '../src/lib/core/lane-types';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { nodePoint, roadAt, shownAt } from '../src/lib/core/road-line';
import type { GraphData, Lane } from '../src/lib/core/types';
import { attachedEnd, buildModel, readScene } from './model';
import { openEditor } from './editor.svelte';

// A node holds car roads or footpaths, never both (core/separate.ts): no
// footpath operation the editor offers changes a car node or car segment,
// done with the editor's own gestures, keys and undo, and the editor draws
// after each what a fresh build of its graph draws.

type Pt = { x: number; y: number };
const p = (x: number, y: number): Pt => ({ x, y });
type Ui = ReturnType<typeof openEditor>;
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

// Every footpath operation the editor offers, over a street of each shape:
// drawn to its side and to its other side, drawn across it, pasted, an end
// dragged, a piece dragged, an end of the one across dragged and deleted, a
// piece deleted, each undone and redone, and a piece turned into a car road
// and back in the lane panel. After each the car nodes and segments are as
// they were and no node holds both kinds. Each shape's operations run in
// several tests, the footpaths a later one acts on laid first without
// undoing them.
type Shape = { name: string; graph: GraphData; road: string; t: number; zoom: number };
const shapes: Shape[] = [
	{
		name: 'a curved street shifted 0 m at one end and 16 m at the other',
		graph: {
			...street,
			segments: [{ ...street.segments[0], controlX: 0, controlY: 400, offsetEnd: 16 }]
		},
		road: 'street',
		t: 0.3,
		zoom: 4
	},
	{
		name: 'a ramp attached at an edge',
		graph: readScene('attached-ramp'),
		road: 'ramp',
		t: 0.6,
		zoom: 4
	},
	{
		name: 'a road next to its junction',
		graph: readScene('curved-tee'),
		road: 'side',
		t: 0.4,
		zoom: 4
	}
];

// Opens the shape's city in the editor, with the operations done on it at
// the road's point at `t`: `edit` makes one, then undoes and redoes it, each
// state exactly as it was; `lay` only makes it.
function onShape(shape: Shape) {
	const segment = shape.graph.segments.find((s) => s.id === shape.road)!;
	// Its ends as drawn (an end attached at an edge moved there).
	const [a, b] = [segment.startNodeId, segment.endNodeId].map((id) =>
		attachedEnd(shape.graph, segment.id, id)
	);
	const shifted = {
		...segment,
		offsetStart: segment.offsetStart ?? 0,
		offsetEnd: segment.offsetEnd ?? 0
	};
	const at = shownAt(shifted, a, b, shape.t);
	const ui = openEditor(structuredClone(shape.graph), perPixel(shape.zoom));
	const before = carGraph(ui.graph());
	const half = segment.lanes.reduce((s, l) => s + l.width, 0) / 2;
	const reach = half + 9;
	// A point `d` along the street from `at` and `across` to its right.
	const along = (d: number, across = 0) => ({
		x: at.point.x + at.tangent.x * d + at.normal.x * across,
		y: at.point.y + at.tangent.y * d + at.normal.y * across
	});
	// A click where the pointer has moved to first, as a page click is.
	const click = (q: Pt) => {
		ui.hover(q.x, q.y);
		ui.click(q.x, q.y);
	};
	const drag = (from: Pt, to: Pt) => {
		ui.hover(from.x, from.y);
		ui.drag(from, to);
	};
	const holds = (step: string) => {
		const graph = ui.graph();
		expect([step, carGraph(graph)]).toEqual([step, before]);
		expect([step, mixed(graph)]).toEqual([step, []]);
		expect([step, ui.stale()]).toEqual([step, []]);
	};
	const changes = (step: string, act: () => void) => {
		const was = ui.graph();
		act();
		expect([step, JSON.stringify(ui.graph())]).not.toEqual([step, JSON.stringify(was)]);
		holds(step);
		return was;
	};
	const lay = (step: string, act: () => void) => {
		changes(step, act);
		ui.key('Escape');
	};
	// An edit, then undone and redone: each state exactly as it was.
	const edit = (step: string, act: () => void) => {
		const was = changes(step, act);
		const now = ui.graph();
		ui.key('z', { ctrl: true });
		expect([step, ui.graph()]).toEqual([step, was]);
		holds(`${step}, undone`);
		ui.key('z', { ctrl: true, shift: true });
		expect([step, ui.graph()]).toEqual([step, now]);
		holds(`${step}, redone`);
		ui.key('Escape');
	};
	// The one across: the last footpath laid once it is drawn.
	const across = () => walks(ui.graph()).at(-1)!;
	const ops = {
		toSide: [
			'drawn to its side',
			() => ui.draw('Path', [along(-6, reach), along(-6, half - 1.2)], [false, true])
		],
		toOtherSide: [
			'drawn to its other side at the same spot',
			() => ui.draw('Path', [along(-14, -reach), along(-14, -half + 1.2)], [false, true])
		],
		across: ['drawn across', () => ui.draw('Path', [along(6, reach), along(6, -reach)])],
		pasted: [
			'pasted',
			() => {
				click(along(6, reach / 2 + 1));
				ui.key('c', { ctrl: true });
				ui.key('v', { ctrl: true });
				const to = along(16, reach / 2 + 1);
				ui.hover(to.x, to.y);
				ui.click(to.x, to.y);
			}
		],
		endDragged: ['an end dragged', () => drag(along(-6, reach), along(-9, reach + 2))],
		pieceDragged: [
			'a piece dragged',
			() => drag(along(6, -reach / 2 - 1), along(4, -reach / 2 - 3))
		]
	} satisfies Record<string, [string, () => void]>;
	return { ui, click, drag, before, half, reach, along, holds, lay, edit, across, ops, at };
}

for (const shape of shapes) {
	const name = `every footpath operation on ${shape.name}`;

	test(`${name}: drawn to either side and across`, () => {
		const { ui, edit, ops } = onShape(shape);
		edit(...ops.toSide);
		edit(...ops.toOtherSide);
		const was = new Set(ui.graph().nodes.map((n) => n.id));
		edit(...ops.across);
		// Cut nowhere: the crossing is paint.
		expect(crossingNodes(ui.graph(), was)).toEqual([]);
	});

	test(`${name}: pasted`, () => {
		const { edit, lay, ops } = onShape(shape);
		lay(...ops.toSide);
		lay(...ops.across);
		edit(...ops.pasted);
	});

	test(`${name}: an end and a piece dragged`, () => {
		const { edit, lay, ops } = onShape(shape);
		lay(...ops.toSide);
		lay(...ops.across);
		edit(...ops.endDragged);
		edit(...ops.pieceDragged);
	});

	test(`${name}: an end of the one across dragged and deleted`, () => {
		const { ui, click, drag, lay, edit, across, ops, at } = onShape(shape);
		lay(...ops.toSide);
		lay(...ops.across);
		const crossing = across();
		const node = (id: string) => ui.graph().nodes.find((n) => n.id === id)!;
		edit('an end of the one across dragged', () => {
			const end = node(crossing.startNodeId);
			drag(end, { x: end.x + at.tangent.x * 2, y: end.y + at.tangent.y * 2 });
		});
		edit('an end of the one across deleted', () => {
			click(node(crossing.endNodeId));
			ui.key('Delete');
		});
	});

	test(`${name}: a piece deleted, turned into a car road and back`, () => {
		const { ui, click, before, half, reach, along, holds, lay, edit, ops } = onShape(shape);
		lay(...ops.toSide);
		lay(...ops.toOtherSide);
		// The footpath to the side's far end moved, as the car road press
		// below finds it.
		lay(...ops.endDragged);
		edit('a piece deleted', () => {
			click(along(-14, -(reach + half) / 2));
			ui.key('Delete');
		});

		// The footpath to the street's side turned into a car road in the lane
		// panel (LaneEditor's setRole): the car nodes and segments there before
		// are as they were. Then back.
		const role = (to: 'vehicle' | 'pedestrian') => {
			click(along(-7.5, reach - 3));
			expect(ui.editor.selectedSegments.size).toBe(1);
			ui.editor.editLanes((lanes) => {
				lanes[0].role = to;
				lanes[0].direction = to === 'vehicle' ? 'forward' : 'bidirectional';
			});
			ui.key('Escape');
		};
		const footpaths = walks(ui.graph()).length;
		role('vehicle');
		expect(walks(ui.graph()).length).toBe(footpaths - 1);
		const turned = ui.graph();
		const now = carGraph(turned);
		expect(now.segments.filter((s) => before.segments.every((b) => b.id !== s.id))).toHaveLength(1);
		expect(now.segments.filter((s) => before.segments.some((b) => b.id === s.id))).toEqual(
			before.segments
		);
		expect(now.nodes.filter((n) => before.nodes.some((b) => b.id === n.id))).toEqual(before.nodes);
		expect(mixed(turned)).toEqual([]);
		role('pedestrian');
		expect(walks(ui.graph()).length).toBe(footpaths);
		holds('turned into a car road and back');
	});
}

// The drawing of the editor's graph, built fresh, once the editor draws it
// so too (`drawingOf` in e2e/app.ts).
function drawingOf(ui: Ui) {
	expect(ui.stale()).toEqual([]);
	return buildModel(ui.graph()).scene;
}

// The stop and give-way lines drawn and the zebras laid over the car roads.
function stopsAndZebras(ui: Ui) {
	const scene = drawingOf(ui);
	const pieces = [
		...scene.place.roads.map((r) => scene.road(r.id)!),
		...scene.place.junctions.map((j) => scene.node(j.id)!)
	];
	return {
		stops: pieces.flatMap((d) => d.signs.filter((s) => s.kind === 'stop')).length,
		yields: pieces.flatMap((d) => d.signs.filter((s) => s.kind === 'yield')).length,
		zebras: pieces.flatMap((d) => d.crossings.filter((c) => c.runs.some((x) => x.kind === 'zebra')))
			.length
	};
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

// Gestures at world points, a click and a drag first moving the pointer
// there as the page's do, at the browser's top-down zoom 4.
function onStreet(graph: GraphData) {
	const ui = openEditor(structuredClone(graph), perPixel(4));
	const click = (q: Pt, o: { shift?: boolean } = {}) => {
		ui.hover(q.x, q.y, o);
		ui.click(q.x, q.y, o);
	};
	const drag = (from: Pt, to: Pt, steps = 8) => {
		ui.hover(from.x, from.y);
		ui.drag(from, to, {}, steps);
	};
	// Opens the connector on a node by double-clicking it: the approach
	// control badges it shows.
	const connectorAt = (q: Pt) => {
		ui.dblclick(q.x, q.y);
		return ui.editor.controlBadges;
	};
	const node = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id)!;
	return { ui, click, drag, connectorAt, node };
}

test('footpaths drawn to each sidewalk of a street and across it, and the street dragged by its body', () => {
	const { ui, drag, connectorAt, node } = onStreet(street);
	const before = carGraph(ui.graph());

	// Drawn from 20 m south to the street's south side: its end on the
	// near sidewalk's middle (y 4.5), joined to it.
	ui.draw('Path', [p(0, 24), p(0.3, 2.8)], [false, true]);
	let graph = ui.graph();
	expect(walks(graph)).toHaveLength(1);
	const southEnd = node(graph, walks(graph)[0].endNodeId);
	expect([southEnd.x, southEnd.y]).toEqual([expect.closeTo(0.3, 0), expect.closeTo(4.5, 6)]);
	expect(carGraph(graph)).toEqual(before);
	expect(connectorAt(southEnd)).toHaveLength(0);
	expect(ui.editor.connectorJoined).toEqual(['s1']);
	ui.key('Escape');

	// The other side at the same spot: its end on the north sidewalk.
	ui.draw('Path', [p(0, -24), p(0.3, -2.8)], [false, true]);
	graph = ui.graph();
	expect(walks(graph)).toHaveLength(2);
	const northEnd = node(graph, walks(graph)[1].endNodeId);
	expect(northEnd.y).toBeCloseTo(-4.5, 6);
	expect(carGraph(graph)).toEqual(before);
	connectorAt(northEnd);
	expect(ui.editor.connectorJoined).toEqual(['s0']);
	ui.key('Escape');

	// Drawn across 20 m east: cut nowhere, its node in the roadway offering
	// no control.
	const was = new Set(graph.nodes.map((n) => n.id));
	ui.draw('Path', [p(20, 24), p(20, -24)]);
	graph = ui.graph();
	expect(walks(graph)).toHaveLength(3);
	expect(carGraph(graph)).toEqual(before);
	expect(crossingNodes(graph, was)).toEqual([]);
	const across = walks(graph)[2];
	expect(connectorAt(p(20, 0))).toHaveLength(0);
	ui.key('Escape');

	// The street dragged 6 m south by its body: the footpath ends on its
	// sidewalks ride with it, the one across stays where it is.
	const nodesBefore = ui.graph();
	drag(p(-40, 1), p(-40, 7), 6);
	graph = ui.graph();
	expect(node(graph, 'w').y).toBeGreaterThan(5);
	const by = { x: node(graph, 'w').x + 65, y: node(graph, 'w').y };
	for (const id of [southEnd.id, northEnd.id]) {
		const [was, now] = [nodesBefore, graph].map((graph) => node(graph, id));
		expect([id, now.x - was.x, now.y - was.y]).toEqual([
			id,
			expect.closeTo(by.x, 6),
			expect.closeTo(by.y, 6)
		]);
	}
	for (const id of [across.startNodeId, across.endNodeId])
		expect(node(graph, id)).toEqual(node(nodesBefore, id));
	expect(graph.nodes.map((n) => n.id)).toEqual(nodesBefore.nodes.map((n) => n.id));
	expect(mixed(graph)).toEqual([]);
	ui.key('Escape');
	connectorAt(p(southEnd.x + by.x, southEnd.y + by.y));
	expect(ui.editor.connectorJoined).toEqual(['s1']);
	ui.key('Escape');
	expect(ui.stale()).toEqual([]);
});

test('a node pasted onto a node of the other kind, and lanes pasted onto one half of a street, leave every car node as it was', () => {
	const lanes = street.segments[0].lanes;
	const path = [
		{ id: 'p', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
	] as const;
	const walk = (id: string, from: string, to: string) => ({
		id,
		startNodeId: from,
		endNodeId: to,
		lanes: [...path]
	});
	const city: GraphData = {
		nodes: [
			...street.nodes,
			{ id: 'mid', x: 0, y: 0, junction: { setbacks: { left: 8, right: 9 } } },
			{ id: 'a', x: 25, y: -24 },
			{ id: 'p', x: 25, y: 0, junction: { setbacks: { up: 3 } } },
			{ id: 'b', x: 25, y: 24 },
			{ id: 'c', x: -25, y: -24 },
			{ id: 'q', x: -25, y: 0 },
			{ id: 'd', x: -25, y: 24 }
		],
		segments: [
			{ id: 'left', startNodeId: 'w', endNodeId: 'mid', lanes: [...lanes] },
			{ id: 'right', startNodeId: 'mid', endNodeId: 'e', lanes: [...lanes] },
			walk('up', 'a', 'p'),
			walk('down', 'p', 'b'),
			walk('up2', 'c', 'q'),
			walk('down2', 'q', 'd')
		]
	};
	const { ui, click, drag, node } = onStreet(city);
	const opened = ui.graph();

	// A footpath node holds no edits: p's saved setback reads as none.
	expect(node(ui.graph(), 'p').junction).toBeUndefined();
	// The street node's setbacks copied onto a footpath node, which has two
	// roads as it does: nothing is pasted, every node as it was.
	click(p(0, 0));
	ui.key('c', { ctrl: true });
	click(p(25, 0));
	ui.key('v', { ctrl: true });
	ui.key('Escape');
	expect(ui.graph()).toEqual(opened);

	// The footpath's lanes pasted onto the street's west half: it is a
	// footpath on a node of its own at the middle, its setback there gone
	// (a footpath node holds none); the east half and every other car node
	// as they were.
	click(p(25, 12));
	ui.key('c', { ctrl: true });
	click(p(-45, 0));
	ui.key('v', { ctrl: true });
	const pasted = ui.graph();
	expect(walks(pasted)).toHaveLength(5);
	expect(mixed(pasted)).toEqual([]);
	const left = pasted.segments.find((s) => s.id === 'left')!;
	expect(left.endNodeId).not.toBe('mid');
	const cars = carGraph(pasted);
	const was = carGraph(opened);
	expect(cars.segments).toEqual(was.segments.filter((s) => s.id === 'right'));
	expect(cars.nodes).toEqual([
		{ id: 'e', x: 65, y: 0 },
		{ id: 'mid', x: 0, y: 0, junction: { setbacks: { right: 9 } } }
	]);
	undoRedo(ui, opened, pasted);
	ui.key('Escape');

	// Dragging the new footpath moves no car node: along its line, so it
	// still crosses up2 and down2 at q, its end slid onto the street.
	drag(p(-45, 0), p(-36, 0));
	expect(node(ui.graph(), 'w').x).toBeGreaterThan(-60);
	expect(carGraph(ui.graph())).toEqual(cars);
	expect(mixed(ui.graph())).toEqual([]);
	expect(ui.stale()).toEqual([]);
});

test("a footpath's end dragged along a street stays on its sidewalk; the street's curve dragged carries the footpath nodes on it", () => {
	const { ui, click, drag, connectorAt, node } = onStreet(street);
	const before = carGraph(ui.graph());
	ui.draw('Path', [p(-20, 24), p(-20, 3)], [false, true]);
	let graph = ui.graph();
	expect(walks(graph)).toHaveLength(1);
	const end = walks(graph)[0].endNodeId;
	expect(node(graph, end).y).toBeCloseTo(4.5, 6);

	// Dragged along and into the roadway: it lands on the sidewalk on the
	// pointer's side, joined to it.
	drag(p(-20, 4.5), p(-7, 1));
	graph = ui.graph();
	expect([node(graph, end).x, node(graph, end).y]).toEqual([
		expect.closeTo(-7, 0),
		expect.closeTo(4.5, 6)
	]);
	connectorAt(node(graph, end));
	expect(ui.editor.connectorJoined).toEqual(['s1']);
	ui.key('Escape');
	// Dragged off the street, joined to the sidewalk, it slides along it.
	drag(node(graph, end), p(-3, 11));
	expect(node(ui.graph(), end).x).toBeCloseTo(-3, 0);
	expect(node(ui.graph(), end).y).toBeCloseTo(4.5, 6);

	// Across 20 m east, given way to each way.
	ui.draw('Path', [p(20, 24), p(20, -24)]);
	expect(walks(ui.graph())).toHaveLength(2);
	const across = walks(ui.graph())[1];
	expect(stopsAndZebras(ui).yields).toBe(2);

	// The street's curve handle (in its middle) dragged 20 m south: the end
	// stays on its sidewalk, the footpath across stays where it is, the zebra
	// and its give-ways drawn where they cross.
	graph = ui.graph();
	click(p(-40, 0));
	drag(p(0, 0), p(0, 20));
	const bent = ui.graph();
	expect(bent.segments.find((s) => s.id === 'street')!.controlY).toBeGreaterThan(15);
	expect(mixed(bent)).toEqual([]);
	expect(carGraph(bent).nodes).toEqual(before.nodes);
	expect(node(bent, end).y).toBeGreaterThan(node(graph, end).y + 4);
	for (const id of [across.startNodeId, across.endNodeId])
		expect(node(bent, id)).toEqual(node(graph, id));
	expect(bent.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
	expect(stopsAndZebras(ui)).toEqual({ stops: 0, yields: 2, zebras: 1 });
	ui.key('Escape');
	connectorAt(node(bent, end));
	expect(ui.editor.connectorJoined).toEqual(['s1']);
	ui.key('Escape');
	undoRedo(ui, graph, bent);
	expect(ui.stale()).toEqual([]);
});

test('a street and the footpaths across it, selected together, are dragged and pasted with no node holding both kinds', () => {
	const path = [
		{ id: 'p', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
	] as const;
	const { ui, click, drag } = onStreet({
		nodes: [
			...street.nodes,
			{ id: 'a', x: 0, y: -25 },
			{ id: 'mid', x: 0, y: 0 },
			{ id: 'b', x: 0, y: 25 }
		],
		segments: [
			...street.segments,
			{ id: 'one', startNodeId: 'a', endNodeId: 'mid', lanes: [...path] },
			{ id: 'two', startNodeId: 'mid', endNodeId: 'b', lanes: [...path] }
		]
	});
	click(p(-30, 0));
	click(p(0, -14), { shift: true });
	click(p(0, 14), { shift: true });
	const before = ui.graph();
	drag(p(-30, 0), p(-20, 5));
	const moved = ui.graph();
	expect(moved.nodes.find((n) => n.id === 'w')!.y).toBeGreaterThan(4);
	// Every node selected moved as one.
	for (const n of moved.nodes) {
		const was = before.nodes.find((m) => m.id === n.id)!;
		expect([n.id, n.x - was.x, n.y - was.y]).toEqual([
			n.id,
			expect.closeTo(moved.nodes[0].x - before.nodes[0].x, 6),
			expect.closeTo(moved.nodes[0].y - before.nodes[0].y, 6)
		]);
	}
	expect(mixed(moved)).toEqual([]);
	expect(stopsAndZebras(ui)).toEqual({ stops: 0, yields: 2, zebras: 1 });
	undoRedo(ui, before, moved);

	// Copied and pasted 36 m north: a second street with its crossing and
	// its give-ways, nothing joined to the first.
	click(p(-20, 5));
	click(p(10, -9), { shift: true });
	click(p(10, 19), { shift: true });
	ui.key('c', { ctrl: true });
	ui.key('v', { ctrl: true });
	ui.hover(0, -36);
	ui.click(0, -36);
	const pasted = ui.graph();
	expect(pasted.segments).toHaveLength(6);
	expect(mixed(pasted)).toEqual([]);
	expect(carGraph(pasted).segments).toHaveLength(2);
	expect(stopsAndZebras(ui)).toEqual({ stops: 0, yields: 4, zebras: 2 });
	undoRedo(ui, moved, pasted);
});

// A free footpath end shifted off its node, dragged by where it shows onto
// a street: onto its near sidewalk, its roadway near that side, or its far
// sidewalk. It lands with its end showing on the middle of the sidewalk
// nearest where it was let go (within a millimetre), where it was let go
// along the street, its far node where it lay, whichever way the footpath
// leaves it, whichever way it is stored and whichever way it is shifted, a
// long footpath shifted alike all along or a short one shifted only at the
// end dragged and swung round past its far node, however many pointer
// updates the drag took, on the app's Street and Avenue alike. Let go
// nearer its far node than its shift lets it show, its node moves as far as
// its end was dragged, as one with no shift does.
for (const [preset, walkway] of [
	['street', 4.5],
	['avenue', 10.5]
] as const)
	test(`a shifted footpath end dragged onto a ${preset} shows on the sidewalk where it is let go`, () => {
		const wrong: string[] = [];
		let k = 0;
		for (const heading of [60, 90, 120])
			for (const shift of [-4, 1.5, 6])
				for (const eased of [false, true])
					for (const out of [true, false])
						for (const [onto, y, side] of [
							['near sidewalk', -walkway, -1],
							['roadway', -1, -1],
							['far sidewalk', walkway, 1]
						] as const) {
							// Long and leaving the street, or short and pointing at it
							// from just short of its outer edge, so the drag swings
							// the end round past its far node.
							const r = (heading * Math.PI) / 180;
							const q = eased ? p(0, -walkway - 9) : p(0, -20);
							const [length, toward] = eased ? [6.5, 1] : [25, -1];
							const f = p(q.x + Math.cos(r) * length, q.y + toward * Math.sin(r) * length);
							const ui = openEditor({
								nodes: [
									{ id: 'w', x: -80, y: 0 },
									{ id: 'e', x: 80, y: 0 },
									{ id: 'q', ...q },
									{ id: 'f', ...f }
								],
								segments: [
									{
										id: 'street',
										startNodeId: 'w',
										endNodeId: 'e',
										lanes: createLanesFrom(preset)
									},
									{
										id: 'path',
										startNodeId: out ? 'q' : 'f',
										endNodeId: out ? 'f' : 'q',
										lanes: createLanesFrom('path'),
										// Its shift at q, the end dragged; eased, none at f.
										offsetStart: out || !eased ? shift : 0,
										offsetEnd: !out || !eased ? shift : 0
									}
								]
							} as GraphData);
							const path = ui.editor.graph.segments.get('path')!;
							const shown = () => roadAt(ui.editor.graph, path, out ? 0 : 1)!.point;
							const from = shown();
							ui.click(from.x, from.y);
							ui.drag(from, p(from.x, y), {}, k++ % 2 ? 1 : 8);
							const name = `${preset} ${heading}° shift ${shift}${eased ? ' eased' : ''} ${out ? 'out' : 'in'} onto ${onto}`;
							const on = ui.editor.roadRenderer.derived?.sidewalks.get('q')?.[0];
							const end = shown();
							const far = ui.node('f');
							// Where it is let go: the middle of that sidewalk. Its end
							// shows no nearer its far node, which shows no shift, than
							// its shift square to it and a footpath a metre long put
							// it; asked to, its node moves by as much as its end was
							// (endsAt in core/road-line.ts), as one with no shift does.
							const to = p(from.x, side * walkway);
							const [d, reach] = [Math.hypot(to.x - f.x, to.y - f.y), Math.hypot(1, shift)];
							if (d < reach) {
								const node = ui.node('q');
								const moved = p(to.x + q.x - from.x, to.y + q.y - from.y);
								if (Math.hypot(node.x - moved.x, node.y - moved.y) > 1e-9)
									wrong.push(`${name}: out of reach, lying at ${node.x}, ${node.y}`);
							} else if (!on) wrong.push(`${name}: on no sidewalk, showing at ${end.x}, ${end.y}`);
							else if (Math.sign(on.end.y) !== side) wrong.push(`${name}: on the other sidewalk`);
							else if (
								Math.hypot(end.x - on.line.at(-1)!.x, end.y - on.line.at(-1)!.y) > 0.001 ||
								Math.abs(end.x - from.x) > 0.001
							)
								wrong.push(`${name}: showing at ${end.x}, ${end.y}`);
							if (far.x !== f.x || far.y !== f.y) wrong.push(`${name}: its far node moved`);
							if (ui.stale().length) wrong.push(`${name}: stale`);
						}
		expect(wrong).toEqual([]);
	});

// A 2 m path meeting an 8 m one end to end at (0, 0), the wide one shifted
// 3 m so their edges at y = -1 run straight through, worked as a user would.
// After each gesture the editor draws what a fresh build does, no node holds
// both kinds, and the wide path keeps its shift.
const widened = (more: { nodes?: GraphData['nodes']; segments?: GraphData['segments'] } = {}) => {
	const path = (width: number): Lane[] => [
		{ id: 'l0', role: 'pedestrian', material: 'concrete', width, direction: 'bidirectional' }
	];
	return {
		nodes: [
			{ id: 'w', x: -20, y: 0 },
			{ id: 'j', x: 0, y: 0 },
			{ id: 'e', x: 20, y: 0 },
			...(more.nodes ?? [])
		],
		segments: [
			{ id: 'narrow', startNodeId: 'w', endNodeId: 'j', lanes: path(2) },
			{
				id: 'wide',
				startNodeId: 'j',
				endNodeId: 'e',
				lanes: path(8),
				offsetStart: 3,
				offsetEnd: 3
			},
			...(more.segments ?? [])
		]
	} as GraphData;
};
const keptWide = (ui: Ui) => {
	expect(ui.stale()).toEqual([]);
	expect(mixed(ui.graph())).toEqual([]);
	const wide = ui.graph().segments.find((s) => s.id === 'wide');
	expect([wide?.offsetStart, wide?.offsetEnd]).toEqual([3, 3]);
};
const roadsAtJ = (ui: Ui) => ui.editor.graph.nodes.get('j')!.connectedSegments.length;

// Drawn through where the joint's ring shows (0, 1.5), between the two
// paths' ends, square across or either way slanted, it joins the joint there
// with its pieces showing along the line drawn.
test('a third path drawn through the joint of a 2 m and an 8 m path widened to one side joins it, straight', () => {
	for (const [from, to] of [
		[p(0, -15), p(0, 15)],
		[p(-12, -10.5), p(12, 13.5)],
		[p(12, -10.5), p(-12, 13.5)]
	]) {
		const ui = openEditor(widened());
		ui.draw('Path', [from, to]);
		expect(ui.graph().segments).toHaveLength(4);
		expect(roadsAtJ(ui)).toBe(4);
		// Its pieces show along the line drawn.
		const [dx, dy] = [to.x - from.x, to.y - from.y];
		const off = (q: Pt) => Math.abs((q.x - from.x) * dy - (q.y - from.y) * dx) / Math.hypot(dx, dy);
		for (const s of ui.editor.graph.segments.values())
			if (s.id !== 'narrow' && s.id !== 'wide')
				for (const t of [0, 0.5, 1]) {
					const at = roadAt(ui.editor.graph, s, t)!.point;
					expect(off(at)).toBeLessThan(0.01);
				}
		keptWide(ui);
	}
});

test('the joint of a 2 m and an 8 m path widened to one side: drawn to, dragged, dropped on, copied and pasted', () => {
	// Drawn to where the joint shows, it ends on it.
	let ui = openEditor(widened());
	const ring = () => nodePoint(ui.editor.graph, ui.editor.graph.nodes.get('j')!);
	ui.draw('Path', [p(0, -15), ring()], [false, true]);
	expect(roadsAtJ(ui)).toBe(3);
	keptWide(ui);
	// Dragged by its ring, both paths go with it, the wide one's shift kept.
	ui.click(ring().x, ring().y);
	ui.drag(ring(), p(ring().x + 2, ring().y + 3));
	expect([ui.node('j').x, ui.node('j').y]).toEqual([expect.closeTo(2, 6), expect.closeTo(3, 6)]);
	keptWide(ui);

	// A path's dead end dropped on its ring becomes it.
	ui = openEditor(
		widened({
			nodes: [
				{ id: 'a', x: 0, y: -25 },
				{ id: 'b', x: 0, y: -10 }
			],
			segments: [{ id: 'stub', startNodeId: 'a', endNodeId: 'b', lanes: createLanesFrom('path') }]
		})
	);
	ui.click(0, -10);
	ui.drag(p(0, -10), ring());
	expect(ui.editor.graph.nodes.has('b')).toBe(false);
	expect(roadsAtJ(ui)).toBe(3);
	keptWide(ui);

	// The pair copied and pasted 40 m north: the copy is joined, widened
	// to the same side.
	ui = openEditor(widened());
	ui.click(-10, 0);
	ui.click(10, 3, { shift: true });
	expect(ui.editor.selectedSegments.size).toBe(2);
	ui.key('c', { ctrl: true });
	ui.key('v', { ctrl: true });
	ui.hover(0, -40);
	ui.click(0, -40);
	const graph = ui.graph();
	expect(graph.segments).toHaveLength(4);
	const copy = graph.segments.filter((s) => s.id !== 'narrow' && s.id !== 'wide');
	expect(copy.map((s) => [s.offsetStart ?? 0, s.offsetEnd ?? 0]).sort()).toEqual([
		[0, 0],
		[3, 3]
	]);
	expect(new Set(copy.flatMap((s) => [s.startNodeId, s.endNodeId])).size).toBe(3);
	keptWide(ui);
});
