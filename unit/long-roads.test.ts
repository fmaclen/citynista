import { expect, test } from 'bun:test';
import type { GraphData } from '../src/lib/core/types';
import { copySegments } from '../src/lib/clipboard';
import { olderId, roadThrough } from '../src/lib/core/place';
import { check } from '../src/lib/road-model/checks';
import { clipped, offsetLine, piecesOf, toRings, union, wholly } from '../src/lib/road-model/clip';
import { cityOf, frame, openEditor } from './editor.svelte';
import {
	cityWith,
	circleLoop,
	curveLoop,
	type LongRoad,
	longRoads,
	openRoad,
	selfMeeting
} from './long-roads';
import { buildModel, liveShape } from './model';
import { Networks } from '../src/lib/core/networks';

// Roads made of many segments joined through the nodes they only carry on
// through (Derived.units), and loops, whose two ends would meet at one node:
// everything that reads a road reads such a road as it reads a short one.
// A loop is two roads parted at its two oldest nodes (roadThrough in
// core/place.ts), so no reader meets a road ending where it starts. Each
// sweep slides what it tests through nodes of the road (the two a loop is
// parted at, and nodes it only carries on through) and a few metres either
// side, on a loop as the Curve
// tool draws one, a ring as the Circle tool lays one, and open roads of
// eight pieces, straight and curved.

type Pt = { x: number; y: number };
type Ui = ReturnType<typeof openEditor>;
type Paths = Parameters<typeof cityWith>[2];
type Joint = LongRoad['joints'][number];
const OFFSETS = [-3, -1, 0, 1, 3];
const along = (j: Joint, d: number): Pt => ({ x: j.at.x + j.way.x * d, y: j.at.y + j.way.y * d });
// The way square to the road at a joint, to its left.
const leftOf = (j: Joint): Pt => ({ x: j.way.y, y: -j.way.x });
const off = (p: Pt, n: Pt, d: number): [number, number] => [p.x + n.x * d, p.y + n.y * d];

// A footpath across the road at each joint, `d` metres past it, at `angle`
// degrees to the road, 12 m out each side, stored from the left or the
// right.
function acrossEach(road: LongRoad, d: number, angle: number, fromLeft: boolean) {
	const nodes: Record<string, [number, number]> = {};
	const paths: Paths = [];
	const a = (angle * Math.PI) / 180;
	for (const [i, j] of road.joints.entries()) {
		const c = along(j, d);
		const n = leftOf(j);
		const dir = {
			x: n.x * Math.sin(a) + j.way.x * Math.cos(a),
			y: n.y * Math.sin(a) + j.way.y * Math.cos(a)
		};
		const [p, q] = [off(c, dir, 12), off(c, dir, -12)];
		nodes[`pa${i}`] = fromLeft ? p : q;
		nodes[`pb${i}`] = fromLeft ? q : p;
		paths.push({ id: `walk${i}`, from: `pa${i}`, to: `pb${i}`, lanes: 'path' });
	}
	return cityWith(road, nodes, paths);
}

test('a footpath across a long road clear of every junction crosses it once, at, before and after every node of the road', () => {
	for (const lanes of ['street', 'avenue'] as const)
		for (const road of longRoads(lanes))
			for (const d of OFFSETS)
				for (const angle of [90, 60])
					for (const fromLeft of [true, false]) {
						const { scene } = buildModel(acrossEach(road, d, angle, fromLeft));
						const crossings = road.joints.map((j, i) => [
							j.node,
							scene.walking().runsOf(`walk${i}`).length
						]);
						// Just past a node of two roads, a loop's parting nodes among
						// them, a footpath may cross both (docs/backlog.md).
						const twice = new Set(
							crossings.filter(([node, n]) => parted(road).has(node as string) && n === 2)
						);
						const want = crossings.map((c) => (twice.has(c) ? c : [c[0], 1]));
						const at = { road: road.name, d, angle, fromLeft };
						expect({ ...at, crossings }).toEqual({ ...at, crossings: want });
						if (angle === 90 && fromLeft)
							expect({ ...at, faults: check(scene) }).toEqual({ ...at, faults: [] });
					}
}, 60000);

// The nodes a long road is parted at: a loop's two oldest, its first two.
const parted = (road: LongRoad) =>
	new Set(road.closed ? [road.joints[0].node, road.joints[1].node] : []);

// The road each segment is drawn as, by its first segment, grouped, and
// the car nodes drawn as nodes.
function roadsOf(graph: GraphData) {
	const { derived } = buildModel(graph);
	const by = new Map<string, string[]>();
	for (const s of graph.segments) {
		const road = (derived.units.get(s.id) ?? [s.id])[0];
		by.set(road, [...(by.get(road) ?? []), s.id]);
	}
	return {
		roads: [...by.values()].map((g) => g.sort().join()).sort(),
		nodes: derived.place.junctions.map((j) => j.id).sort()
	};
}

test('a loop is two roads parted at its two oldest nodes, however it is listed', () => {
	for (const [loop, parted] of [
		[curveLoop(), ['n0', 'n1']],
		[circleLoop(), ['c0', 'c1']]
	] as const) {
		const graph = cityWith(loop);
		const whole = roadsOf(graph);
		expect({ loop: loop.name, nodes: whole.nodes, roads: whole.roads.length }).toEqual({
			loop: loop.name,
			nodes: [...parted],
			roads: 2
		});
		for (let k = 1; k < graph.segments.length; k++) {
			const turned = {
				nodes: [...graph.nodes.slice(k), ...graph.nodes.slice(0, k)],
				segments: [...graph.segments.slice(k), ...graph.segments.slice(0, k)]
			};
			expect({ loop: loop.name, k, ...roadsOf(turned) }).toEqual({ loop: loop.name, k, ...whole });
		}
	}
});

// The roads a graph's car segments are drawn as, each by its segments'
// ids, and those of them starting and ending at one node.
function meetingThemselves(graph: GraphData) {
	const { derived } = buildModel(graph);
	const byId = new Map(graph.segments.map((s) => [s.id, s]));
	const roads = new Set(
		graph.segments
			.filter((s) => s.lanes.some((l) => l.role === 'vehicle'))
			.map((s) => (derived.units.get(s.id) ?? [s.id]).join())
	);
	return [...roads].filter((r) => {
		const ids = r.split(',');
		return byId.get(ids[0])!.startNodeId === byId.get(ids.at(-1)!)!.endNodeId;
	});
}

// A footpath across a road at each of some joints, `d` metres past it,
// square to it and 12 m out each side, laid on a graph.
function withPathsAcross(graph: GraphData, joints: Joint[], d: number) {
	const nodes: Record<string, [number, number]> = {};
	const paths: Paths = [];
	for (const [i, j] of joints.entries()) {
		const c = along(j, d);
		nodes[`pa${i}`] = off(c, leftOf(j), 12);
		nodes[`pb${i}`] = off(c, leftOf(j), -12);
		paths.push({ id: `walk${i}`, from: `pa${i}`, to: `pb${i}`, lanes: 'path' });
	}
	const laid = cityOf(nodes, paths);
	return {
		nodes: [...graph.nodes, ...laid.nodes],
		segments: [...graph.segments, ...laid.segments]
	} as GraphData;
}

test('a chain of segments whose two ends would be one node is parted at its oldest inner node, and a footpath at and beside each of its nodes crosses it', () => {
	for (const { name, road, graph, junction } of selfMeeting()) {
		expect({ name, meeting: meetingThemselves(graph) }).toEqual({ name, meeting: [] });
		const joints = road.joints.filter((j) => j.node !== junction);
		for (const d of OFFSETS) {
			const { scene } = buildModel(withPathsAcross(graph, joints, d));
			// Nodes drawn as nodes of two roads: just past one a footpath may
			// cross both (docs/backlog.md).
			const two = new Set(scene.place.junctions.map((j) => j.id));
			const crossings = joints.map((j, i) => {
				const n = scene.walking().runsOf(`walk${i}`).length;
				return [j.node, two.has(j.node) && n === 2 ? 1 : n];
			});
			const at = { name, d };
			expect({ ...at, crossings }).toEqual({ ...at, crossings: joints.map((j) => [j.node, 1]) });
			expect({ ...at, faults: check(scene) }).toEqual({ ...at, faults: [] });
		}
	}
}, 60000);

test('each road meeting a node holds its own setback there, a loop parted at it included', () => {
	const loop = curveLoop();
	const graph = cityWith(loop);
	graph.nodes.find((n) => n.id === 'n0')!.junction = { setbacks: { top: 6, nw: 10 } };
	const { derived } = buildModel(graph);
	const top = derived.spans.get('top')!;
	const nw = derived.spans.get('nw')!;
	expect(meetingThemselves(graph)).toEqual([]);
	expect({ top: top.d0, nw: nw.total - nw.d0 - nw.length }).toEqual({ top: 6, nw: 10 });
});

test('a setback handle dragged at a node a loop is parted at keeps every road apart, drawn as a fresh build draws it', () => {
	for (const at of ['n0', 'n1']) {
		const loop = curveLoop();
		const j = loop.joints.find((j) => j.node === at)!;
		const c = along(j, 2);
		const { ui, runs } = editorOn(loop, { p: off(c, leftOf(j), 12), q: off(c, leftOf(j), -12) }, [
			{ id: 'walk', from: 'p', to: 'q', lanes: 'path' }
		]);
		ui.click(j.at.x, j.at.y);
		for (const h of ui.editor.currentTaperHandles) {
			ui.click(j.at.x, j.at.y);
			const handle = ui.editor.currentTaperHandles.find((k) => k.segmentId === h.segmentId)!;
			const { x, y } = handle.handle;
			ui.drag({ x, y }, { x: x + handle.dir.x * 4, y: y + handle.dir.y * 4 });
			const state = { at, road: h.segmentId, stored: !!ui.node(at).junction?.setbacks };
			// Just past a node of two roads a footpath may cross both
			// (docs/backlog.md): read as one.
			const now = () => ({
				...state,
				meeting: meetingThemselves(ui.graph()),
				crossings: runs('walk') === 2 ? 1 : runs('walk'),
				stale: ui.stale()
			});
			const want = { ...state, stored: true, meeting: [], crossings: 1, stale: [] };
			expect(now()).toEqual(want);
			ui.editor.undo();
			expect(now()).toEqual(want);
			ui.editor.redo();
			expect(now()).toEqual(want);
		}
	}
});

// A ring of `ids.length` pieces of a Street, of radius 62 m round (62, 0),
// its nodes named `ids` in order round it from (0, 0).
function ring(ids: string[]) {
	const [r, n] = [62, ids.length];
	const step = (2 * Math.PI) / n;
	const nodes: Record<string, [number, number]> = {};
	const roads: Paths = [];
	for (let i = 0; i < n; i++) {
		const t = step * i;
		const d = r / Math.cos(step / 2);
		nodes[ids[i]] = [r - r * Math.cos(t), r * Math.sin(t)];
		roads.push({
			id: `u${i}`,
			from: ids[i],
			to: ids[(i + 1) % n],
			lanes: 'street',
			control: { x: r - d * Math.cos(t + step / 2), y: d * Math.sin(t + step / 2) }
		});
	}
	return { nodes, roads };
}

test('a loop whose node ids read as one number is parted alike from every segment and however it is listed', () => {
	const ids = ['node-01', 'node-1', 'node-2', 'node-3', 'node-4', 'node-5', 'node-6', 'node-7'];
	expect(olderId('node-01', 'node-1')).toBeLessThan(0);
	const { nodes, roads } = ring(ids);
	const graph = cityOf({ ...nodes, pa: [-14, 15], pb: [20, 15] }, [
		...roads,
		{ id: 'walk', from: 'pa', to: 'pb', lanes: 'path' }
	]);
	// Asked from every segment.
	const segments = graph.segments.filter((s) => s.id !== 'walk');
	const pairs = new Map(
		ids.map((id) => {
			const into = segments.find((s) => s.endNodeId === id)!;
			const out = segments.find((s) => s.startNodeId === id)!;
			return [id, [into, out] as const];
		})
	);
	const asked = segments.map((s) =>
		roadThrough(s, (id) => pairs.get(id) ?? null)
			.map((p) => p.id)
			.join()
	);
	expect([...new Set(asked)].sort()).toEqual(['u0', 'u1,u2,u3,u4,u5,u6,u7']);
	// Built, listed from every segment.
	for (let k = 0; k < segments.length; k++) {
		const turned = {
			nodes: graph.nodes,
			segments: [...graph.segments.slice(k), ...graph.segments.slice(0, k)]
		} as GraphData;
		const { scene } = buildModel(turned);
		const junctions = scene.place.junctions.map((j) => j.id).sort();
		expect({ k, junctions, crossings: scene.walking().runsOf('walk').length }).toEqual({
			k,
			junctions: ['node-01', 'node-1'],
			crossings: 1
		});
	}
});

// The controls of a footpath's crossings, as drawn, from left to right.
const controlsOf = (ui: ReturnType<typeof openEditor>, path: string) => {
	const r = ui.editor.roadRenderer;
	return r
		.crossingsOn([path])
		.map((id) => r.crossingOf(id)!)
		.sort((a, b) => a.mid.x - b.mid.x)
		.map((c): string => c.control);
};

test('a footpath across a loop twice holds one control for both crossings, wherever the loop is parted, through a drag of its oldest node, undo and redo, and a paste in any order', () => {
	const ids = Array.from({ length: 9 }, (_, i) => `node-${i}`);
	const { nodes, roads } = ring(ids);
	nodes['node-0'] = [0, -1.1];
	const ui = openEditor(
		cityOf({ ...nodes, a: [-18, 8], b: [145, 8] }, [
			...roads,
			{ id: 'across', from: 'a', to: 'b', lanes: 'path' }
		])
	);
	const r = ui.editor.roadRenderer;
	const left = r.crossingsOn(['across']).find((id) => r.crossingOf(id)!.mid.x < 60)!;
	for (let k = 0; k < 3; k++) ui.editor.cycleCrossing(left);
	// One footpath segment across one road twice holds one control for both
	// crossings, the loop read as one road however it is parted.
	const want: string[] = ['stop', 'stop'];
	expect(controlsOf(ui, 'across')).toEqual(want);
	// Dragged across y = 0, where halving the loop's length would part it
	// elsewhere.
	ui.fire('mousedown', 0, -1.1);
	for (let k = 1; k <= 22; k++) {
		ui.fire('mousemove', 0, -1.1 + 0.1 * k);
		expect({ k, controls: controlsOf(ui, 'across') }).toEqual({ k, controls: want });
	}
	ui.fire('mouseup', 0, 1.1);
	const steps: [string, () => void][] = [
		['let go', () => {}],
		['undone', () => ui.editor.undo()],
		['redone', () => ui.editor.redo()],
		['dragged back', () => ui.drag({ x: 0, y: 1.1 }, { x: 0, y: -1.1 })]
	];
	for (const [step, act] of steps) {
		act();
		expect({ step, controls: controlsOf(ui, 'across'), stale: ui.stale() }).toEqual({
			step,
			controls: want,
			stale: []
		});
	}
	for (let k = 0; k < roads.length; k++) {
		const order = [...roads.slice(k), ...roads.slice(0, k)].map((s) => s.id);
		const clip = copySegments({ graph: ui.editor.graph, selectedSegments: [...order, 'across'] })!;
		const into = openEditor(cityOf({}, []));
		into.editor.startPlacement(clip);
		into.hover(200, 200);
		const ghost = into.editor.ghost!;
		const walk = [...ghost.graph.segments.values()].find((s) =>
			s.lanes.every((l) => l.role === 'pedestrian')
		)!;
		const shown = ghost.renderer
			.crossingsOn([walk.id])
			.map((id) => ghost.renderer.crossingOf(id)!)
			.sort((a, b) => a.mid.x - b.mid.x)
			.map((c): string => c.control);
		into.click(200, 200);
		const pasted = into
			.graph()
			.segments.find((s) => s.lanes.every((l) => l.role === 'pedestrian'))!;
		expect({ k, shown, pasted: controlsOf(into, pasted.id) }).toEqual({
			k,
			shown: want,
			pasted: want
		});
	}
});

test("two footpaths' controls either side of a node a road carries on through stay their own as the node is bent and straightened", () => {
	const ui = openEditor(
		cityOf(
			{
				a: [-60, 0],
				x: [0, 0],
				b: [60, 0],
				p: [-20, -14],
				q: [-20, 14],
				r: [20, -14],
				t: [20, 14]
			},
			[
				{ id: 's1', from: 'a', to: 'x', lanes: 'street' },
				{ id: 's2', from: 'x', to: 'b', lanes: 'street' },
				{ id: 'w1', from: 'p', to: 'q', lanes: 'path' },
				{ id: 'w2', from: 'r', to: 't', lanes: 'path' }
			]
		)
	);
	const bend = (from: number, to: number) => {
		ui.click(0, from);
		ui.drag({ x: 0, y: from }, { x: 0, y: to });
		ui.editor.clearSelection();
	};
	const r = ui.editor.roadRenderer;
	const drawn = () => [...controlsOf(ui, 'w1'), ...controlsOf(ui, 'w2')];
	bend(0, 10);
	ui.editor.cycleCrossing(r.crossingsOn(['w1'])[0]);
	const want = drawn();
	expect(want[0]).not.toEqual(want[1]);
	for (const [step, act] of [
		['straightened', () => bend(10, 0)],
		['bent again', () => bend(0, 10)],
		['undone', () => ui.editor.undo()],
		['undone again', () => ui.editor.undo()]
	] as const) {
		act();
		expect({ step, controls: drawn(), stale: ui.stale() }).toEqual({
			step,
			controls: want,
			stale: []
		});
	}
});

// A node a loop is parted at is, to every gesture, the node of two roads it
// is drawn as: a draw ending on it joins it, and it is picked before a
// footpath node lying on it.
test("a street drawn with Shift locked onto a loop's parting node joins that node, no second node and no road of no length", () => {
	for (const x of [-40.6, -40, -39.4])
		for (const y of [-44, -42, -40]) {
			const loop = curveLoop();
			const ui = openEditor(cityWith(loop));
			ui.brush('Street');
			ui.editor.setDrawStyle('straight');
			ui.click(x, -76, { ctrl: true });
			ui.key('Shift', { shift: true });
			ui.hover(-37, y, { shift: true });
			ui.click(-37, y, { shift: true });
			ui.key('Escape');
			ui.key('Escape');
			const graph = ui.graph();
			const at = (id: string) => graph.nodes.find((n) => n.id === id)!;
			const short = graph.segments.filter((s) => {
				const [a, b] = [at(s.startNodeId), at(s.endNodeId)];
				return Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
			});
			const here = graph.nodes.filter((n) => Math.hypot(n.x + 40, n.y + 40) < 0.01);
			expect({ x, y, short: short.length, here: here.length, stale: ui.stale() }).toEqual({
				x,
				y,
				short: 0,
				here: 1,
				stale: []
			});
		}
});

test("a click on a loop's parting node with a footpath node lying on it picks the car node, and a drag moves it", () => {
	const loop = curveLoop();
	const graph = cityOf({ ...loop.nodes, p: [-40, -40], a: [-40, -75], b: [-40, -5] }, [
		...loop.roads,
		{ id: 'walk-a', from: 'a', to: 'p', lanes: 'path' },
		{ id: 'walk-b', from: 'p', to: 'b', lanes: 'path' }
	]);
	const ui = openEditor(graph);
	ui.click(-40, -40);
	expect([...ui.editor.selectedNodes]).toEqual(['n0']);
	const moved = openEditor(graph);
	moved.drag({ x: -40, y: -40 }, { x: -44, y: -44 }, { ctrl: true }, 1);
	expect([moved.node('n0').x, moved.node('n0').y]).toEqual([-44, -44]);
	expect(moved.stale()).toEqual([]);
});

// A street of three segments carried straight through `b` (x = 0) and `c`
// (x = 80), and a straight footpath across its first 20 m short of `b`,
// Stop on its crossing.
function joinedStreetStop() {
	const ui = openEditor(
		cityOf({ a: [-150, 0], b: [0, 0], c: [80, 0], d: [210, 0], p: [-20, -48], q: [-20, 48] }, [
			{ id: 'r0', from: 'a', to: 'b', lanes: 'street' },
			{ id: 'r1', from: 'b', to: 'c', lanes: 'street' },
			{ id: 'r2', from: 'c', to: 'd', lanes: 'street' },
			{ id: 'w', from: 'p', to: 'q', lanes: 'path' }
		])
	);
	for (let k = 0; k < PRESSES.stop; k++)
		ui.editor.cycleCrossing(ui.editor.roadRenderer.crossingsOn(['w'])[0]);
	return ui;
}

test('a footpath slid 40 m along a joined street past a node it carries on through keeps its Stop on every frame, saved, undone and redone', () => {
	const ui = joinedStreetStop();
	ui.click(-20, 29);
	ui.fire('mousedown', -20, 29);
	for (let k = 1; k <= 80; k++) {
		ui.fire('mousemove', -20 + k * 0.5, 29, { ctrl: true });
		expect({ k, controls: controlsOf(ui, 'w') }).toEqual({ k, controls: ['stop'] });
	}
	ui.fire('mouseup', 20, 29, { ctrl: true });
	expect(ui.node('p').x).toBe(20);
	for (const [step, act] of [
		['saved', () => {}],
		['undone', () => ui.editor.undo()],
		['redone', () => ui.editor.redo()]
	] as const) {
		act();
		frame();
		expect({ step, controls: controlsOf(ui, 'w'), stale: ui.stale() }).toEqual({
			step,
			controls: ['stop'],
			stale: []
		});
	}
});

test('the node a joined street carries on through, dragged past a crossing in one step with its badge open, leaves the badge open and the Stop on it', () => {
	const ui = joinedStreetStop();
	ui.fire('mousedown', 0, 0);
	const id = ui.editor.roadRenderer.crossingsOn(['w'])[0];
	ui.editor.openCrossing(id);
	frame();
	ui.fire('mousemove', -40, 0, { ctrl: true });
	expect({ open: ui.editor.opened, controls: controlsOf(ui, 'w') }).toEqual({
		open: id,
		controls: ['stop']
	});
	ui.fire('mouseup', -40, 0, { ctrl: true });
	expect(ui.node('b').x).toBe(-40);
	expect(ui.editor.opened).not.toBeNull();
	for (const [step, act] of [
		['saved', () => {}],
		['undone', () => ui.editor.undo()],
		['redone', () => ui.editor.redo()]
	] as const) {
		act();
		frame();
		expect({ step, controls: controlsOf(ui, 'w'), stale: ui.stale() }).toEqual({
			step,
			controls: ['stop'],
			stale: []
		});
	}
});

// Where a loop is parted (roadThrough in core/place.ts) is a matter of
// drawing alone: a crossing's control names its road as it carries on, the
// whole loop (chainThrough). A sweep of loops crossed by one footpath
// segment twice or three times (one control for all its crossings) and by
// footpaths crossing once, each given a control, through every edit that
// moves, adds or removes a parting. After each, saved, undone and redone,
// every crossing shows the control it was given, which is what the same
// city shows with its nodes named so it is parted elsewhere; live equals
// fresh; and what is saved names the whole loop, as it did before loops
// were parted.

// A loop to sweep: its car nodes and roads, the footpaths across it with
// how many times each crosses it and the control each is given, its own
// segments, the nodes to edit and where to cut it.
interface Crossed {
	name: string;
	graph: GraphData;
	paths: { id: string; crossings: number; control: string }[];
	loop: string[];
	nodes: string[];
	cuts: Pt[];
	everyOrder: boolean;
}

// How many presses of a crossing's badge give each control from give-way
// (nextControl in modes/connector.ts).
const PRESSES: Record<string, number> = { signal: 1, none: 2, stop: 3 };

function crossedLoops(): Crossed[] {
	const out: Crossed[] = [];
	const curve = curveLoop();
	const circle = circleLoop();
	// One footpath segment across the top and the bottom (Stop), one across
	// a side once (Signal); or, on the Curve loop, one bowed through the top
	// once and the bottom twice (None). Each crossing at least 13 m from
	// every node.
	const across = (twice: [Pt, Pt], once: [Pt, Pt]) => ({
		nodes: { ta: twice[0], tb: twice[1], oa: once[0], ob: once[1] },
		paths: [
			{ id: 'twice', from: 'ta', to: 'tb' },
			{ id: 'once', from: 'oa', to: 'ob' }
		],
		want: [
			{ id: 'twice', crossings: 2, control: 'stop' },
			{ id: 'once', crossings: 1, control: 'signal' }
		]
	});
	const thrice = (from: Pt, control: Pt, to: Pt) => ({
		nodes: { ha: from, hb: to },
		paths: [{ id: 'thrice', from: 'ha', to: 'hb', control }],
		want: [{ id: 'thrice', crossings: 3, control: 'none' }]
	});
	const sets = {
		curve: [
			across(
				[
					{ x: 10, y: -60 },
					{ x: 10, y: 60 }
				],
				[
					{ x: -100, y: -20 },
					{ x: -50, y: -20 }
				]
			),
			thrice({ x: -30, y: -60 }, { x: 0, y: 120 }, { x: 30, y: 20 })
		],
		circle: [
			across(
				[
					{ x: 20, y: -80 },
					{ x: 20, y: 80 }
				],
				[
					{ x: -90, y: 25 },
					{ x: -40, y: 25 }
				]
			)
		]
	};
	type Base = {
		name: string;
		road: LongRoad;
		extra?: GraphData;
		junction?: string[];
		set: keyof typeof sets;
	};
	const side = curve.nodes.n3;
	const mirror = (id: string) => (id === 'c0' ? id : `d${id.slice(1)}`);
	const other: Record<string, [number, number]> = {};
	for (const [id, [x, y]] of Object.entries(circle.nodes)) other[mirror(id)] = [120 - x, y];
	// The ring with node ids that do not sort by age: the oldest by id
	// (olderId) is no node the ring was drawn from first.
	const scramble = (id: string) => `k${(Number(id.slice(1)) * 5 + 3) % 8}`;
	const scrambled: LongRoad = {
		...circle,
		name: 'ring with scrambled node ids',
		nodes: Object.fromEntries(Object.entries(circle.nodes).map(([id, p]) => [scramble(id), p])),
		roads: circle.roads.map((r) => ({ ...r, from: scramble(r.from), to: scramble(r.to) }))
	};
	const bases: Base[] = [
		{ name: 'Curve loop', road: curve, set: 'curve' },
		{ name: 'Circle ring', road: circle, set: 'circle' },
		{
			name: 'Curve loop with a side street at n3',
			road: curve,
			extra: cityOf({ n3: side, side: [side[0] * 1.6, side[1] * 1.6] }, [
				{ id: 'side', from: 'n3', to: 'side', lanes: 'street' }
			]),
			junction: ['n3'],
			set: 'curve'
		},
		{
			name: 'two rings sharing a node',
			road: circle,
			extra: cityOf(
				other,
				circle.roads.map((r) => ({
					...r,
					id: `mirror-${r.id}`,
					from: mirror(r.from),
					to: mirror(r.to),
					control: r.control && { x: 120 - r.control.x, y: r.control.y }
				}))
			),
			junction: ['c0'],
			set: 'circle'
		},
		{ name: scrambled.name, road: scrambled, set: 'circle' }
	];
	// Every order of selection pasted from the plain loop and ring with
	// their straight footpaths (the others pasted in two orders).
	for (const [b, base] of bases.entries())
		for (const [k, paths] of sets[base.set].entries()) {
			const g = cityWith(
				base.road,
				Object.fromEntries(Object.entries(paths.nodes).map(([id, p]) => [id, [p.x, p.y]])),
				paths.paths.map((p) => ({ ...p, lanes: 'path' as const }))
			);
			for (const n of base.extra?.nodes ?? [])
				if (!g.nodes.some((m) => m.id === n.id)) g.nodes.push(n);
			g.segments.push(...(base.extra?.segments ?? []));
			// Cut halfway along each of the loop's segments clear of every
			// crossing (the curve's top and bottom carry the crossings).
			const cuts = base.road.roads.flatMap((r) => {
				const [a, b] = [base.road.nodes[r.from], base.road.nodes[r.to]];
				const c = r.control ?? { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
				const m = {
					x: 0.25 * a[0] + 0.5 * c.x + 0.25 * b[0],
					y: 0.25 * a[1] + 0.5 * c.y + 0.25 * b[1]
				};
				return Math.abs(m.y) > 35 && Math.abs(m.x) < 30 ? [] : [m];
			});
			// The nodes the loop is parted at, one halfway round from them (on
			// the plain loop and ring), and the node other roads meet it at.
			const byAge = Object.keys(base.road.nodes).sort(olderId);
			const nodes = [
				byAge[0],
				byAge[1],
				...(b > 1 ? [] : [byAge[Math.floor(byAge.length / 2)]]),
				...(base.junction ?? [])
			];
			out.push({
				name: `${base.name}, ${paths.want.map((w) => w.id).join(' and ')}`,
				graph: g,
				paths: paths.want,
				loop: base.road.roads.map((r) => r.id).sort(),
				nodes: [...new Set(nodes)],
				cuts: [cuts[0], cuts[Math.floor(cuts.length / 2)]],
				everyOrder: b <= 1 && !k
			});
		}
	return out;
}

// A saved graph with every node renamed so the order of their ids (olderId)
// is turned round by `by`: the same city, its loops parted elsewhere.
function partedElsewhere(g: GraphData, by: number): GraphData {
	const ids = g.nodes.map((n) => n.id).sort(olderId);
	const name = new Map(ids.map((id, i) => [id, `node-${(i + by) % ids.length}`]));
	return {
		...g,
		nodes: g.nodes.map((n) => ({ ...n, id: name.get(n.id)! })),
		segments: g.segments.map((s) => ({
			...s,
			startNodeId: name.get(s.startNodeId)!,
			endNodeId: name.get(s.endNodeId)!
		}))
	};
}

// Each footpath's crossings as drawn, from left to right (then up): where
// each is, to the metre, and its control.
const crossingsShown = (
	r: {
		crossingsOn(ids: string[]): string[];
		crossingOf(id: string): { mid: Pt; control: string } | null;
	},
	paths: string[]
) =>
	paths.map((p) =>
		r
			.crossingsOn([p])
			.map((id) => r.crossingOf(id)!)
			.map((c) => ({ x: Math.round(c.mid.x), y: Math.round(c.mid.y), control: c.control }))
			.sort((a, b) => a.x - b.x || a.y - b.y)
	);

test('where a loop is parted never matters to a control: each edit moving, adding or taking away a parting leaves every crossing with the control it was given, as the city parted elsewhere shows it', () => {
	// Each footpath's crossings, saved, undone or redone: every one shows
	// the control its footpath was given, and live equals fresh; once saved,
	// the city parted elsewhere shows the same crossings with the same
	// controls, and each footpath stores one entry for each road and
	// carriageway its crossings lie across there, naming the road whole.
	const verify = (ui: Ui, at: object, paths: { id: string; control: string }[], saved: boolean) => {
		frame();
		const ids = paths.map((p) => p.id);
		const shown = crossingsShown(ui.editor.roadRenderer, ids);
		const stored = ui.saved();
		const got = {
			...at,
			controls: shown.map((cs) => [...new Set(cs.map((c) => c.control))]),
			stale: ui.stale()
		};
		const want = { ...at, controls: paths.map((p) => [p.control]), stale: [] };
		if (!saved) return expect(got).toEqual(want);
		const there = new Networks();
		there.build(liveShape(partedElsewhere(stored, 3)) as never);
		// The same crossings, each where it is there to 2 m (a crossing
		// beside a parting is drawn up to the junction there), in order.
		const elsewhere = crossingsShown(there, ids);
		const apart = shown.flatMap((cs, i) =>
			cs.flatMap((c, k) => {
				const d = elsewhere[i][k];
				return d && Math.hypot(c.x - d.x, c.y - d.y) <= 2 ? [] : [{ ...c, there: d }];
			})
		);
		const entry = (e: { roads: readonly string[]; lanes?: readonly string[]; control: string }) =>
			JSON.stringify([[...e.roads].sort(), e.lanes, e.control]);
		expect({
			...got,
			shown: shown.map((cs) => cs.map((c) => c.control)),
			apart,
			stored: ids.map((p) =>
				(stored.segments.find((s) => s.id === p)?.controls ?? []).map(entry).sort()
			)
		}).toEqual({
			...want,
			shown: elsewhere.map((cs) => cs.map((c) => c.control)),
			apart: [],
			stored: paths.map((p) =>
				[
					...new Set(
						there
							.crossingsOn([p.id])
							.map((id) => entry({ ...there.crossingOf(id)!.across, control: p.control }))
					)
				].sort()
			)
		});
	};
	for (const city of crossedLoops()) {
		const ui = openEditor(city.graph);
		const r = ui.editor.roadRenderer;
		for (const p of city.paths) {
			const shown = r.crossingsOn([p.id]);
			expect({ city: city.name, path: p.id, crossings: shown.length }).toEqual({
				city: city.name,
				path: p.id,
				crossings: p.crossings
			});
			for (let k = 0; k < PRESSES[p.control]; k++) ui.editor.cycleCrossing(shown[0]);
		}
		verify(ui, { city: city.name }, city.paths, true);
		// A saved edit checked saved, undone and redone, then undone back to
		// the city as given (`edits` saved steps).
		const check = (step: string, edits = 1) => {
			verify(ui, { city: city.name, step, when: 'saved' }, city.paths, true);
			ui.editor.undo();
			verify(ui, { city: city.name, step, when: 'undone' }, city.paths, false);
			ui.editor.redo();
			verify(ui, { city: city.name, step, when: 'redone' }, city.paths, false);
			for (let k = 0; k < edits; k++) ui.editor.undo();
			frame();
		};
		const node = (id: string) => ui.editor.graph.nodes.get(id)!;
		for (const at of city.cuts) {
			ui.editor.mode = 'split';
			frame();
			ui.hover(at.x, at.y);
			ui.click(at.x, at.y);
			ui.key('Escape');
			ui.editor.mode = 'select';
			check(`cut at ${Math.round(at.x)},${Math.round(at.y)}`);
		}
		for (const id of city.nodes) {
			const { x, y } = node(id);
			// Bent past straight, outward, then straightened again.
			const out = { x: x * 1.12, y: y * 1.12 };
			ui.drag({ x, y }, out, {}, 2);
			check(`${id} bent`);
			ui.drag({ x, y }, out, {}, 2);
			ui.drag(out, { x, y }, {}, 2);
			check(`${id} bent and straightened`, 2);
			const seg = node(id).connectedSegments[0];
			node(id).junction = { ...node(id).junction, setbacks: { [seg]: 3 } };
			ui.editor.rebuildRoads();
			ui.editor.graph.save();
			check(`${id} given a setback`);
			ui.draw(
				'Street',
				[
					{ x, y },
					{ x: x * 1.5, y: y * 1.5 }
				],
				[true, false]
			);
			ui.editor.mode = 'select';
			check(`${id} given a side street`);
		}
		// Pasted into a city of its own, free in every order of selection
		// and snapped onto a lone node.
		const ids = city.paths.map((p) => p.id);
		const selections = [...city.loop.keys()]
			.slice(0, city.everyOrder ? undefined : 1)
			.map((k) => [...city.loop.slice(k), ...city.loop.slice(0, k), ...ids]);
		const graph = ui.editor.graph;
		for (const [k, selectedSegments] of [
			...selections,
			[...ids, ...city.loop].reverse()
		].entries()) {
			const clip = copySegments({ graph, selectedSegments })!;
			const snapped = k === selections.length;
			const into = openEditor(snapped ? cityOf({ 'node-15': [300, 0] }, []) : cityOf({}, []));
			into.editor.startPlacement(clip);
			const first = clip.nodes.find((n: { id: string }) => n.id === city.nodes[0])!;
			const to = snapped ? { x: 300, y: 0 } : { x: 300 + first.x, y: first.y };
			into.hover(to.x, to.y);
			into.click(to.x, to.y);
			const pasted = into
				.graph()
				.segments.filter((s) => s.lanes.every((l) => l.role === 'pedestrian'))
				.map((s) => {
					// Told apart by how many times each crosses the loop.
					const n = into.editor.roadRenderer.crossingsOn([s.id]).length;
					return { id: s.id, control: city.paths.find((p) => p.crossings === n)?.control ?? '?' };
				});
			verify(into, { city: city.name, paste: k, snapped }, pasted, true);
		}
	}
}, 120000);

// The editor on a long road with footpaths, and how many crossings a
// footpath segment holds as the editor drew them.
function editorOn(road: LongRoad, nodes: Record<string, [number, number]> = {}, paths: Paths = []) {
	const ui = openEditor(cityWith(road, nodes, paths));
	const runs = (id: string) => ui.editor.roadRenderer.scene!.walking().runsOf(id).length;
	return { ui, runs };
}

// The joints a sweep slides through: on a loop, the two it is parted at
// and one halfway round it carries on through; on an open road, three it
// carries on through.
const jointsOf = (road: LongRoad) =>
	road.closed
		? [road.joints[0], road.joints[1], road.joints[Math.floor(road.joints.length / 2)]]
		: [road.joints[0], road.joints[3], road.joints[6]];

test('a footpath dragged along a long road through its nodes crosses it once on every frame, drawn as a fresh build draws it', () => {
	for (const road of longRoads())
		for (const j of jointsOf(road)) {
			const n = leftOf(j);
			const start = along(j, -5);
			const { ui, runs } = editorOn(road, { p: off(start, n, 12), q: off(start, n, -12) }, [
				{ id: 'walk', from: 'p', to: 'q', lanes: 'path' }
			]);
			// The path selected, and dragged by its middle beyond the far curb.
			const [gx, gy] = off(start, n, -9);
			ui.click(gx, gy);
			ui.fire('mousedown', gx, gy);
			for (let k = 1; k <= 20; k++) {
				ui.fire('mousemove', gx + j.way.x * k * 0.5, gy + j.way.y * k * 0.5);
				const at = { road: road.name, node: j.node, slid: k * 0.5 };
				const crossings = runs('walk');
				// Just past a node of two roads a footpath may cross both
				// (docs/backlog.md).
				const want = parted(road).has(j.node) && crossings === 2 ? 2 : 1;
				expect({ ...at, crossings, stale: ui.stale() }).toEqual({
					...at,
					crossings: want,
					stale: []
				});
			}
			ui.fire('mouseup', gx + j.way.x * 10, gy + j.way.y * 10);
			const p = ui.node('p');
			const [px, py] = off(start, n, 12);
			const at = { road: road.name, node: j.node };
			expect({ ...at, moved: Math.hypot(p.x - px, p.y - py) > 5 }).toEqual({ ...at, moved: true });
		}
}, 60000);

// The middle of a street's left sidewalk, from its drawn line (lanes of 2,
// 3.5, 3.5 and 2 m).
const SIDEWALK = 4.5;

test('a footpath ended on a long road sidewalk at or near its nodes lies on that sidewalk, and slides along it through them', () => {
	for (const road of longRoads())
		for (const j of jointsOf(road))
			for (const d of OFFSETS) {
				const n = leftOf(j);
				const end = along(j, d);
				const on = off(end, n, SIDEWALK);
				const { ui } = editorOn(road, { p: off(end, n, 20), q: on }, [
					{ id: 'walk', from: 'p', to: 'q', lanes: 'path' }
				]);
				const cars = new Set(road.roads.map((r) => r.id));
				const lies = (what: string) => {
					const here = ui.editor.roadRenderer.derived?.sidewalks.get('q') ?? [];
					const at = { road: road.name, node: j.node, d, what };
					expect({ ...at, on: here.length === 1 && cars.has(here[0].road) }).toEqual({
						...at,
						on: true
					});
				};
				lies('laid');
				if (d !== -3) continue;
				// Its end slid along the sidewalk through the node.
				const [x, y] = on;
				ui.click(x, y);
				ui.fire('mousedown', x, y);
				for (let k = 1; k <= 12; k++) {
					ui.fire('mousemove', x + j.way.x * k * 0.5, y + j.way.y * k * 0.5);
					lies(`slid ${k * 0.5} m`);
					const at = { road: road.name, node: j.node, slid: k * 0.5 };
					expect({ ...at, stale: ui.stale() }).toEqual({ ...at, stale: [] });
				}
				ui.fire('mouseup', x + j.way.x * 6, y + j.way.y * 6);
				lies('let go');
			}
});

test('a click on a long road at or near its nodes picks a segment of it there, and its nodes drag as any node does', () => {
	for (const road of longRoads())
		for (const j of jointsOf(road)) {
			const { ui } = editorOn(road);
			const here = road.roads.filter((r) => r.from === j.node || r.to === j.node).map((r) => r.id);
			const n = leftOf(j);
			for (const d of [-3, -1, 1, 3]) {
				const [x, y] = off(along(j, d), n, 2);
				ui.editor.clearSelection();
				ui.click(x, y);
				const picked = [...ui.editor.selectedSegments];
				const at = { road: road.name, node: j.node, d };
				expect({ ...at, picked: picked.length === 1 && here.includes(picked[0]) }).toEqual({
					...at,
					picked: true
				});
			}
			ui.editor.clearSelection();
			// The node itself dragged 2 m off the road's line.
			const from = { ...j.at };
			const [tx, ty] = off(from, n, 2);
			ui.click(from.x, from.y);
			ui.drag(from, { x: tx, y: ty });
			const moved = ui.node(j.node);
			const at = { road: road.name, node: j.node };
			expect({
				...at,
				moved: Math.hypot(moved.x - tx, moved.y - ty) < 0.05,
				stale: ui.stale()
			}).toEqual({
				...at,
				moved: true,
				stale: []
			});
		}
});

test("a long road's nodes show setback handles as any node does, each on its own road beside the node", () => {
	for (const road of longRoads())
		for (const j of jointsOf(road))
			for (const side of [false, true]) {
				// With a street leaving the node to the left, the node is a
				// junction of three.
				const [sx, sy] = off(j.at, leftOf(j), 40);
				const { ui } = editorOn(
					road,
					side ? { s: [sx, sy] } : {},
					side ? [{ id: 'side', from: j.node, to: 's', lanes: 'street' }] : []
				);
				ui.click(j.at.x, j.at.y);
				const handles = ui.editor.currentTaperHandles;
				const at = { road: road.name, node: j.node, side };
				// A node the road only carries on through has none; one where
				// two roads meet (a loop's parting nodes) one on each, and a
				// junction one on each of its three roads.
				const want = side ? 3 : parted(road).has(j.node) ? 2 : 0;
				expect({ ...at, handles: handles.length }).toEqual({ ...at, handles: want });
				const reach = handles.map((h) => Math.hypot(h.handle.x - j.at.x, h.handle.y - j.at.y));
				expect({ ...at, beside: reach.every((d) => d < 12) }).toEqual({ ...at, beside: true });
				const roads = new Set(handles.map((h) => h.segmentId));
				expect({ ...at, roads: roads.size }).toEqual({ ...at, roads: want });
			}
});

// What the car roads draw: each road's drawn ends, and the nodes drawn.
function carsDrawn(graph: GraphData) {
	const { derived } = buildModel(graph);
	const r = (v: number) => Math.round(v * 1000) / 1000;
	return {
		ends: derived.place.roads
			.map((road) => {
				const pts = derived.geos.get(road.id)!.path.pts;
				return JSON.stringify([pts[0], pts.at(-1)!].map((p) => [r(p.x), r(p.y)]).sort());
			})
			.sort(),
		nodes: derived.place.junctions.map((j) => j.id).sort()
	};
}

test('a long road cut beside one of its nodes draws as before, and a footpath across it still crosses it once', () => {
	for (const road of longRoads())
		for (const j of jointsOf(road))
			for (const d of [-5, 5]) {
				const n = leftOf(j);
				const c = along(j, d < 0 ? -10 : 10);
				const { ui, runs } = editorOn(road, { p: off(c, n, 12), q: off(c, n, -12) }, [
					{ id: 'walk', from: 'p', to: 'q', lanes: 'path' }
				]);
				const before = carsDrawn(ui.graph());
				const p = along(j, d);
				ui.editor.mode = 'split';
				frame();
				ui.hover(p.x, p.y);
				ui.click(p.x, p.y);
				ui.key('Escape');
				const after = ui.graph();
				const at = { road: road.name, node: j.node, d };
				expect({ ...at, nodes: after.nodes.length }).toEqual({
					...at,
					nodes: Object.keys(road.nodes).length + 3
				});
				expect({ ...at, ...carsDrawn(after) }).toEqual({ ...at, ...before });
				expect({ ...at, crossings: runs('walk'), stale: ui.stale() }).toEqual({
					...at,
					crossings: 1,
					stale: []
				});
			}
});

test('the road about to be laid closing a loop or carrying on a long road is drawn before the click', () => {
	const drawn = (ui: ReturnType<typeof openEditor>, own: LongRoad['roads']) => {
		const ghost = ui.editor.ghost!;
		const ids = [...ghost.graph.segments.keys()].filter((id) => !own.some((r) => r.id === id));
		const shown = ghost.renderer.drawnSegments();
		return { pending: ids.length, drawn: ids.every((id) => shown.includes(id)) };
	};
	for (const style of ['straight', 'curve'] as const) {
		// A loop of six pieces, five of them laid, closed by the last from n5
		// back to n0 (a straight closing piece is one more road of its own).
		const loop = curveLoop();
		const open = { ...loop, roads: loop.roads.slice(0, 5) };
		const ui = openEditor(cityWith(open));
		ui.editor.activateSlot(0);
		ui.editor.setDrawStyle(style);
		const [bx, by] = loop.nodes.n5;
		ui.click(bx, by);
		const [cx, cy] = loop.nodes.n0;
		ui.hover(cx, cy);
		expect({ style, what: 'closing a loop', ...drawn(ui, open.roads) }).toEqual({
			style,
			what: 'closing a loop',
			pending: 1,
			drawn: true
		});
		// An open road of eight pieces carried on from its end, straight on.
		for (const curved of [false, true]) {
			const road = openRoad(curved);
			const ui = openEditor(cityWith(road));
			ui.editor.activateSlot(0);
			ui.editor.setDrawStyle(style);
			const [ex, ey] = road.nodes.o8;
			const last = road.joints.at(-1)!;
			const l = Math.hypot(ex - last.at.x, ey - last.at.y);
			const way = { x: (ex - last.at.x) / l, y: (ey - last.at.y) / l };
			ui.click(ex, ey);
			ui.hover(ex + way.x * 30, ey + way.y * 30);
			const what = `carrying on a ${curved ? 'curved' : 'straight'} road`;
			expect({ style, what, ...drawn(ui, road.roads) }).toEqual({
				style,
				what,
				pending: 1,
				drawn: true
			});
		}
	}
});

// A footpath zigzagging across a road four times, its middle node dragged:
// the points a frame hands Clipper (clip.ts, `clipped`) to place its
// crossings, hold traffic for them and lay the footpath over the road, less
// what reads the road whole (`wholly`: describing a car piece afresh, and
// the road's ground a footpath is laid over and a crossing cut from).
function frameWork(graph: GraphData, node = 'z2', step = { x: 0.3, y: 0.1 }) {
	const ui = openEditor(graph);
	const p = ui.node(node);
	const at = (k: number) => ({ x: p.x + k * step.x, y: p.y + k * step.y });
	ui.fire('mousedown', p.x, p.y);
	ui.fire('mousemove', at(1).x, at(1).y);
	clipped.on = true;
	const before = clipped.near;
	for (let k = 2; k <= 11; k++) ui.fire('mousemove', at(k).x, at(k).y);
	const work = (clipped.near - before) / 10;
	clipped.on = false;
	ui.fire('mouseup', at(11).x, at(11).y);
	return work;
}
test('the counter counts every array of points handed to Clipper, and with counting off a frame writes nothing to it', () => {
	const ring = [
		{ X: 0, Y: 0 },
		{ X: 1000, Y: 0 },
		{ X: 1000, Y: 1000 },
		{ X: 0, Y: 1000 }
	];
	const line = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 2, y: 1 }
	];
	clipped.on = true;
	const counts: number[] = [];
	for (const work of [
		() => union([ring]),
		() => offsetLine(line, 1),
		() => piecesOf([ring]),
		() => toRings([ring], [])
	]) {
		const before = clipped.near;
		work();
		counts.push(clipped.near - before);
	}
	const whole = clipped.whole;
	wholly(() => union([ring]));
	expect({ counts, whole: clipped.whole - whole }).toEqual({ counts: [4, 3, 4, 4], whole: 4 });
	clipped.on = false;
	const { nodes, paths } = zigzag(0);
	const ui = openEditor(cityWith(openRoad(false), nodes, paths));
	const was = { ...clipped };
	const p = ui.node('z2');
	ui.drag({ x: p.x, y: p.y }, { x: p.x + 1, y: p.y + 1 }, {}, 3);
	expect(clipped).toEqual(was);
});

const zigzag = (y: number) => {
	const nodes: Record<string, [number, number]> = {};
	const paths: Paths = [];
	for (let i = 0; i <= 4; i++) nodes[`z${i}`] = [-10 + i * 8, y + (i % 2 ? 15 : -15)];
	for (let i = 0; i < 4; i++)
		paths.push({ id: `w${i}`, from: `z${i}`, to: `z${i + 1}`, lanes: 'path' });
	return { nodes, paths };
};

test('a footpath dragged across a long road costs what lies near it, however long the road', () => {
	const near = zigzag(-40);
	const short = frameWork(
		cityOf({ a: [-40, -40], b: [40, -40], ...near.nodes }, [
			{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
			...near.paths
		])
	);
	const loop = frameWork(cityWith(curveLoop(), near.nodes, near.paths));
	const far = zigzag(-80);
	const twice = frameWork(cityWith(curveLoop('street', 2), far.nodes, far.paths));
	const open = zigzag(0);
	const eight = frameWork(cityWith(openRoad(false), open.nodes, open.paths));
	// Four crossings on a loop of six pieces, 420 m round, cost what four on
	// an 80 m street do, and as much on the loop twice as long; and four on
	// a road of eight pieces as much again.
	expect(loop / short).toBeLessThan(1.1);
	expect(twice / loop).toBeLessThan(1.02);
	expect(eight / short).toBeLessThan(1.1);
});

test('a footpath crossing a long road near a junction, or both legs of a long hairpin, costs what lies near it', () => {
	// A curved street coming `reach` metres into a T, crossed 13 m short of
	// it, its traffic held back from the crossing on the approach.
	const t = (reach: number) =>
		cityOf({ a: [-reach, -30], t: [0, 0], e: [60, 0], s: [0, 65], p: [-13, -22], q: [-13, 22] }, [
			{ id: 'approach', from: 'a', to: 't', lanes: 'street', control: { x: -reach / 2, y: 0 } },
			{ id: 'through', from: 't', to: 'e', lanes: 'street' },
			{ id: 'side', from: 't', to: 's', lanes: 'street' },
			{ id: 'walk', from: 'p', to: 'q', lanes: 'path' }
		]);
	const near = frameWork(t(80), 'q', { x: -0.06, y: 0.1 });
	const far = frameWork(t(1240), 'q', { x: -0.06, y: 0.1 });
	expect(far / near).toBeLessThan(1.1);
	// A street turning back on itself `reach` metres away, both legs crossed
	// by one footpath.
	const hairpin = (reach: number) =>
		cityOf(
			{
				a: [-65, -11],
				b: [0, -11],
				c: [reach, -11],
				d: [reach + 20, 0],
				e: [reach, 11],
				f: [0, 11],
				g: [-65, 11],
				p: [-18, -22],
				q: [-18, 24]
			},
			[
				{ id: 'a', from: 'a', to: 'b', lanes: 'street' },
				{ id: 'b', from: 'b', to: 'c', lanes: 'street' },
				{ id: 'c', from: 'c', to: 'd', lanes: 'street', control: { x: reach + 20, y: -11 } },
				{ id: 'd', from: 'd', to: 'e', lanes: 'street', control: { x: reach + 20, y: 11 } },
				{ id: 'e', from: 'e', to: 'f', lanes: 'street' },
				{ id: 'f', from: 'f', to: 'g', lanes: 'street' },
				{ id: 'walk', from: 'p', to: 'q', lanes: 'path' }
			]
		);
	const close = frameWork(hairpin(80), 'q');
	const long = frameWork(hairpin(1240), 'q');
	expect(long / close).toBeLessThan(1.1);
});
