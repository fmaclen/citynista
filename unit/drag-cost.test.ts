import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { copySegments, layPaste } from '../src/lib/clipboard';
import { splitSegment } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { filed, viewed } from '../src/lib/core/networks';
import { visited } from '../src/lib/core/place';
import { Networks } from '../src/lib/core/networks';
import { LineBook, roadAt } from '../src/lib/core/road-line';
import { looked } from '../src/lib/road-model/drawing';
import type { GraphData } from '../src/lib/core/types';
import { ringsPlaced } from '../src/lib/rendering/node-renderer';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { cityOf, openEditor } from './editor.svelte';
import { pieces } from './model';

// What a drag frame reads follows what the drag changes, not the size of
// the map: the car roads' model is the one already built while nothing a
// build reads of them changes, and is read again only where the drag reaches
// (PlaceBuilder.build); the car roads' part of the graph is kept up to date
// from what was written (Networks.carsOf); and node rings are placed again
// only where their roads changed (Editor.placeRings).

// A grid of `n` by `n` blocks of streets 80 m apart, a footpath across the
// first block's street from `p` to `q`, and one well inside the last block
// from `r` to `s`.
function grid(n: number) {
	const nodes: Record<string, [number, number]> = {};
	const roads: Parameters<typeof cityOf>[1] = [];
	for (let i = 0; i <= n; i++)
		for (let k = 0; k <= n; k++) {
			nodes[`g${i}_${k}`] = [i * 80, k * 80];
			if (i > 0)
				roads.push({ id: `h${i}_${k}`, from: `g${i - 1}_${k}`, to: `g${i}_${k}`, lanes: 'street' });
			if (k > 0)
				roads.push({ id: `v${i}_${k}`, from: `g${i}_${k - 1}`, to: `g${i}_${k}`, lanes: 'street' });
		}
	Object.assign(nodes, {
		p: [40, -20],
		q: [40, 20],
		r: [n * 80 - 50, n * 80 - 50],
		s: [n * 80 - 30, n * 80 - 30]
	});
	roads.push(
		{ id: 'walk', from: 'p', to: 'q', lanes: 'path' },
		{ id: 'far', from: 'r', to: 's', lanes: 'path' }
	);
	return cityOf(nodes, roads);
}

test('a footpath dragged, across a street or far from any, leaves the car roads as last built; a street dragged builds them again', () => {
	const ui = openEditor(grid(3));
	const cars = () => ui.editor.roadRenderer.derived!.through;
	for (const id of ['q', 's']) {
		const built = cars();
		const p = { x: ui.node(id).x, y: ui.node(id).y };
		ui.fire('mousedown', p.x, p.y);
		for (let k = 1; k <= 4; k++) {
			ui.fire('mousemove', p.x + k * 0.5, p.y + k * 0.25);
			expect(cars()).toBe(built);
		}
		ui.fire('mouseup', p.x + 2, p.y + 1);
		expect(cars()).toBe(built);
	}
	const built = cars();
	const g = ui.node('g1_1');
	ui.drag({ x: g.x, y: g.y }, { x: g.x + 2, y: g.y + 1 }, {}, 2);
	expect(cars()).not.toBe(built);
	expect(ui.stale()).toEqual([]);
});

test('a drag frame walks as many kept views of the shown lines on its hundredth frame as on its second', () => {
	const ui = openEditor(grid(1));
	LineBook.walked.on = true;
	try {
		// A footpath end, writing the footpaths' lines, and a street's node,
		// writing the car roads'.
		for (const id of ['q', 'g1_1']) {
			const p = { x: ui.node(id).x, y: ui.node(id).y };
			const walked: number[] = [];
			ui.fire('mousedown', p.x, p.y);
			for (let k = 1; k <= 100; k++) {
				LineBook.walked.count = 0;
				ui.fire('mousemove', p.x + k * 0.02, p.y + k * 0.01);
				walked.push(LineBook.walked.count);
			}
			ui.fire('mouseup', p.x + 2, p.y + 1);
			expect([id, walked[99]]).toEqual([id, walked[1]]);
		}
	} finally {
		LineBook.walked.on = false;
	}
	expect(ui.stale()).toEqual([]);
});

test('a drag walks as many kept views of the shown lines after twenty drags let go as on the first', () => {
	const ui = openEditor(grid(1));
	LineBook.walked.on = true;
	try {
		// A footpath end, writing the footpaths' lines, and a street's node,
		// writing the car roads', each pressed, moved and let go in turn.
		for (const id of ['q', 'g1_1']) {
			const p = { x: ui.node(id).x, y: ui.node(id).y };
			const walked: number[] = [];
			for (let k = 0; k < 20; k++) {
				const dy = k % 2 ? 0 : 1;
				LineBook.walked.count = 0;
				ui.fire('mousedown', p.x, p.y + 1 - dy);
				ui.fire('mousemove', p.x, p.y + dy);
				walked.push(LineBook.walked.count);
				ui.fire('mouseup', p.x, p.y + dy);
			}
			expect([id, walked[19]]).toEqual([id, walked[0]]);
		}
	} finally {
		LineBook.walked.on = false;
	}
	expect(ui.stale()).toEqual([]);
});

test('a node held while a road carries on through it, parted there, leaves the car roads as last built once a footpath moves', () => {
	const ui = openEditor(
		cityOf({ a: [-60, 0], m: [0, 0], b: [60, 0], p: [30, -20], q: [30, 20] }, [
			{ id: 's1', from: 'a', to: 'm', lanes: 'street' },
			{ id: 's2', from: 'm', to: 'b', lanes: 'street' },
			{ id: 'fp', from: 'p', to: 'q', lanes: 'path' }
		])
	);
	const { editor } = ui;
	const cars = () => editor.roadRenderer.derived!.through;
	editor.roadRenderer.holdTaper('m');
	editor.rebuildRoads();
	const [s1, s2] = [editor.graph.segments.get('s1')!, editor.graph.segments.get('s2')!];
	ui.node('m').junction = {
		removed: [
			{
				from: { road: 's1', end: 'end', lane: s1.lanes[1].id! },
				to: { road: 's2', end: 'start', lane: s2.lanes[1].id! }
			}
		]
	};
	editor.rebuildRoads();
	const parted = cars();
	ui.node('q').x += 1;
	editor.rebuildRoads();
	expect(cars()).toBe(parted);
	editor.roadRenderer.holdTaper(null);
	editor.rebuildRoads();
	expect(ui.stale()).toEqual([]);
});

test('a footpath cut in two leaves the car roads as last built; a street cut builds them again', () => {
	const graph = new Graph();
	graph.fromJSON(grid(2));
	const networks = new Networks();
	const cut = (id: string) => {
		const segment = graph.segments.get(id)!;
		const at = roadAt(graph, segment, 0.5)!.point;
		splitSegment(graph, segment, 0.5, graph.createNode(at.x, at.y).id);
		const { derived, scene } = networks.build(graph);
		expect(pieces(scene)).toEqual(pieces(new Networks().build(graph).scene));
		return derived.through;
	};
	const built = networks.build(graph).derived.through;
	expect(cut('walk')).toBe(built);
	expect(cut('h1_1')).not.toBe(built);
});

// A street with `n` side streets 6 m apart along it, too close to stand
// apart, so their junctions are drawn as one (road-model/merge.ts).
function tees(n: number) {
	const nodes: Record<string, [number, number]> = { w: [-70, 0], e: [n * 6 + 70, 0] };
	const roads: Parameters<typeof cityOf>[1] = [];
	for (let i = 0; i < n; i++) {
		nodes[`t${i}`] = [i * 6, 0];
		nodes[`s${i}`] = [i * 6, 70];
		roads.push({ id: `side${i}`, from: `t${i}`, to: `s${i}`, lanes: 'street' });
	}
	const along = ['w', ...Array.from({ length: n }, (_, i) => `t${i}`), 'e'];
	for (let i = 1; i < along.length; i++)
		roads.push({ id: `main${i}`, from: along[i - 1], to: along[i], lanes: 'street' });
	return cityOf(nodes, roads);
}

// The car build's node reads when the first of those junctions is moved
// 10 cm.
function mergedReads(n: number) {
	const graph = new Graph();
	graph.fromJSON(tees(n));
	const networks = new Networks();
	networks.build(graph);
	graph.nodes.get('t0')!.y = 0.1;
	visited.nodes = 0;
	visited.on = true;
	const { scene } = networks.build(graph);
	visited.on = false;
	expect(pieces(scene)).toEqual(pieces(new Networks().build(graph).scene));
	return visited.nodes;
}

test('a junction drawn as one with others is read again with them once, however many they are', () => {
	const [eight, sixteen] = [mergedReads(8), mergedReads(16)];
	expect(sixteen / eight).toBeLessThan(2);
});

// The neighbourhood example, and the same with a copy of itself pasted
// beside it, far enough off to share nothing with it.
const neighbourhood = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8'))
	.graph as GraphData;
function doubled() {
	const ui = openEditor(structuredClone(neighbourhood));
	const { graph } = ui.editor;
	const xs = [...graph.nodes.values()].map((n) => n.x);
	const clipboard = copySegments({ graph, selectedSegments: [...graph.segments.keys()] })!;
	layPaste(
		graph,
		clipboard,
		{ translation: { dx: Math.max(...xs) - Math.min(...xs) + 500, dy: 0 }, snap: null },
		true
	);
	return graph.toJSON();
}

// The drag kinds of the neighbourhood that cost most: a node between two
// long streets, the busiest car node (5 roads), the longest unshifted
// street by its middle (320 m), the busiest footpath node and the longest
// unshifted footpath by its middle.
const kinds = {
	'street node': { node: 'node-51' },
	junction: { node: 'node-103' },
	'whole street': { segment: 'segment-152' },
	'footpath node': { node: 'node-184' },
	'footpath segment': { segment: 'segment-480' }
};

// What each drag kind reads in `city` while it moves (three frames after
// the press), one after the other in one editor: the car build's node and
// segment reads, the shown lines it writes, the graph's reads for the car
// roads' part of it and the footpaths' lines and controls, and the rings
// placed; and for a footpath drag, which draws no car piece again, the car
// pieces filed and those the car drawing's paint looks at. With `fresh`,
// each drag's drawing is held to a fresh build's.
function dragReads(city: GraphData, fresh: boolean) {
	const ui = openEditor(structuredClone(city));
	const out: Record<
		string,
		{ cars: number[]; lines: number; view: number; rings: number; paint?: number[] }
	> = {};
	for (const [kind, pick] of Object.entries(kinds)) {
		const at = (() => {
			if ('node' in pick) return ui.node(pick.node);
			const s = ui.editor.graph.segments.get(pick.segment)!;
			const [a, b] = [ui.node(s.startNodeId), ui.node(s.endNodeId)];
			const c = s.hasControlPoint
				? { x: s.controlX!, y: s.controlY! }
				: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			return { x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4 };
		})();
		const from = { x: at.x, y: at.y };
		const before = JSON.stringify(ui.graph());
		ui.fire('mousedown', from.x, from.y);
		ui.fire('mousemove', from.x + 0.1, from.y + 0.05);
		const counters = [visited, viewed, ringsPlaced, filed, looked, LineBook.written];
		visited.nodes = visited.segments = 0;
		for (const c of [viewed, ringsPlaced, filed, looked, LineBook.written]) c.count = 0;
		for (const c of counters) c.on = true;
		for (let k = 2; k <= 4; k++) ui.fire('mousemove', from.x + k * 0.1, from.y + k * 0.05);
		for (const c of counters) c.on = false;
		ui.fire('mouseup', from.x + 0.4, from.y + 0.2);
		ui.key('Escape');
		expect(JSON.stringify(ui.graph())).not.toBe(before);
		if (fresh) expect(ui.stale()).toEqual([]);
		out[kind] = {
			cars: [visited.nodes, visited.segments],
			lines: LineBook.written.count,
			view: viewed.count,
			rings: ringsPlaced.count,
			...(kind.startsWith('footpath') && { paint: [filed.count, looked.count] })
		};
	}
	return out;
}

test('each kind of drag in the neighbourhood reads as much with a copy of the neighbourhood beside it', () => {
	const one = dragReads(neighbourhood, true);
	const two = dragReads(doubled(), false);
	expect(two).toEqual(one);
	for (const [kind, reads] of Object.entries(one)) {
		expect(reads.rings).toBeGreaterThan(0);
		if (kind.startsWith('footpath')) {
			expect(reads.cars).toEqual([0, 0]);
			expect(reads.paint![0]).toBe(0);
		} else expect(reads.cars[0]).toBeGreaterThan(0);
	}
}, 60_000);

test('the car roads read again only where each edit reaches draw as a fresh build draws them, through every kind of edit and its undo', () => {
	// Two junctions of three streets each, joined by a street 30 m long.
	const ui = openEditor(
		cityOf(
			{
				a: [0, 0],
				w: [-80, 0],
				an: [0, -80],
				as: [0, 80],
				b: [30, 0],
				e: [110, 0],
				bn: [30, -80],
				bs: [30, 80]
			},
			[
				{ id: 'link', from: 'a', to: 'b', lanes: 'street' },
				{ id: 'west', from: 'a', to: 'w', lanes: 'street' },
				{ id: 'aN', from: 'a', to: 'an', lanes: 'street' },
				{ id: 'aS', from: 'a', to: 'as', lanes: 'street' },
				{ id: 'east', from: 'b', to: 'e', lanes: 'street' },
				{ id: 'bN', from: 'b', to: 'bn', lanes: 'street' },
				{ id: 'bS', from: 'b', to: 'bs', lanes: 'street' }
			]
		),
		0.25
	);
	const merged = () =>
		ui.editor.roadRenderer.scene!.place.junctions.some((j) => j.members.length > 1);
	const steps: string[] = [];
	// Each edit changes the graph and leaves the drawing a fresh build's.
	const edit = (label: string, run: () => void) => {
		const before = JSON.stringify(ui.graph());
		run();
		expect(JSON.stringify(ui.graph()), label).not.toBe(before);
		expect(ui.stale(), label).toEqual([]);
		steps.push(label);
	};
	const moveB = (x: number) => {
		const b = ui.node('b');
		ui.click(b.x, b.y);
		ui.drag({ x: b.x, y: b.y }, { x, y: 0 }, {}, 6);
		ui.key('Escape');
	};
	edit('two junctions merged', () => moveB(4));
	expect(merged()).toBe(true);
	edit('two junctions parted', () => moveB(30));
	expect(merged()).toBe(false);
	edit('a setback set', () => {
		ui.click(0, 0);
		const handle = ui.editor.currentTaperHandles.find((h) => h.segmentId === 'west')!;
		const { x, y } = handle.handle;
		ui.drag({ x, y }, { x: x + handle.dir.x * 4, y: y + handle.dir.y * 4 });
		ui.key('Escape');
	});
	edit('a street made an avenue', () => {
		ui.click(-40, 0);
		ui.editor.editLanes((lanes) => lanes.splice(0, lanes.length, ...createLanesFrom('avenue')));
		ui.key('Escape');
	});
	edit('a street cut', () => {
		ui.editor.mode = 'split';
		ui.click(-40, 0);
		ui.key('Escape');
	});
	edit('the cut joined', () => {
		ui.click(-40, 0);
		ui.editor.joinNode(ui.editor.joinableNodeId!);
		ui.key('Escape');
	});
	edit('a street pasted', () => {
		ui.click(0, -40);
		ui.key('c', { ctrl: true });
		ui.key('Escape');
		ui.key('v', { ctrl: true });
		ui.hover(60, -40);
		ui.click(60, -40);
		ui.key('Escape');
	});
	const done = [...steps];
	for (const label of [...done].reverse()) edit(`${label}, undone`, () => ui.editor.undo());
	for (const label of done) edit(`${label}, redone`, () => ui.editor.redo());
});
