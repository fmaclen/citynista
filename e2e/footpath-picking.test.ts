import { expect, test } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { inside, toPath, union } from '../src/lib/road-model/clip';
import { bendAt } from '../unit/bends';
import {
	drawingOf,
	editorLook,
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	nodeOf,
	openAt,
	p,
	type Pt,
	shot,
	walks
} from './app';
import { carGraph, deg, mixed, PATH, STREET } from './paths';
import { expectStrips } from './strips';

// What a click, a double-click or a drag picks is read off what is drawn: a
// footpath on its paving as drawn, a bend's included, and nowhere off it
// (segmentHitAt in modes/picking.ts); a node by its ring, whatever is drawn
// there; where a footpath's node and a car node show at one spot, the
// footpath's where the car node is a cut its road is drawn whole through
// (nodeHitAt); and a double-click on a zebra opens its badge wherever on it
// it lands (pressCrossing in ControlBadges.svelte). Each case is set up as
// a city and leaves a screenshot.

test.afterEach(async ({ page }, testInfo) => {
	await expectFreshDrawing(page);
	await shot(page, testInfo.outputPath('end.png'));
});

test("a click on a bend picks by what is drawn: the bend's paving picks a footpath, bare ground inside it nothing, the node's ring the node", async ({
	page
}) => {
	const ZOOM = 10;
	const g = gestures(page, ZOOM);
	// Two footpaths, from (25, 0) into j at the origin and out again at
	// `turn` degrees.
	const bend = (turn: number) => {
		const out = deg(turn, 25);
		return graphOf(
			[
				['a', 25, 0],
				['j', 0, 0],
				['b', out.x, out.y]
			],
			[
				['p', 'a', 'j', PATH],
				['q', 'j', 'b', PATH]
			]
		);
	};
	// All the footpaths' own paving drawn.
	const pavingOf = async () => {
		const scene = await drawingOf(page);
		return union(
			[...scene.place.roads.map((r) => scene.road(r.id)!), scene.node('walk:j')!].flatMap((d) =>
				d.surfaces.flatMap((x) =>
					('left' in x.shape ? [[...x.shape.left, ...[...x.shape.right].reverse()]] : x.shape).map(
						toPath
					)
				)
			)
		);
	};

	await test.step("on a bend's paving, off both strips' lines, it picks a footpath", async () => {
		await openAt(page, bend(50), ZOOM);
		const a = (50 * Math.PI) / 180;
		const q = { x: 2.85 * Math.cos(a / 2), y: 2.85 * Math.sin(a / 2) };
		expect(inside(await pavingOf(), q)).toBe(true);
		await g.click(q);
		await expect.poll(async () => (await editorLook(page)).selection.segments).toHaveLength(1);
	});

	await test.step('on bare ground inside a sharp bend, on a strip as it would run on to the node, it picks nothing', async () => {
		await openAt(page, bend(30), ZOOM);
		const q = p(1.6, 0);
		expect(inside(await pavingOf(), q)).toBe(false);
		await g.click(q);
		await expect(page.getByTestId('city-name')).toHaveText('test');
		expect((await editorLook(page)).selection).toEqual({ nodes: [], segments: [] });
	});

	await test.step("on a sharp bend's node, which its paving no longer covers, it picks the node", async () => {
		const [a, b] = [deg(80, 15), deg(40, 15)];
		await openAt(
			page,
			graphOf(
				[
					['a', a.x, a.y],
					['j', 0, 0],
					['b', b.x, b.y]
				],
				[
					['in', 'a', 'j', PATH],
					['out', 'j', 'b', PATH]
				]
			),
			ZOOM
		);
		const { scene } = await expectStrips(page);
		const node = nodeOf(await liveGraph(page), 'j');
		expect(bendAt(scene, node.id, node).coversNode).toBe(false);
		await g.click(node);
		await expect
			.poll(async () => (await editorLook(page)).selection)
			.toEqual({ nodes: ['j'], segments: [] });
	});
});

// Where a footpath's node and a car node show at one spot, a click, a
// double-click and a drag all pick the same one: the footpath's where the
// car node is a cut its road is drawn whole through (nothing of its own to
// edit there), the car node anywhere else.
test("a footpath's node and a car node at one spot: every gesture picks the footpath's over a hidden cut, the car node anywhere else", async ({
	page
}) => {
	const ZOOM = 4;
	const g = gestures(page, ZOOM);
	const walkNodeAt = (graph: GraphData, q: Pt) =>
		graph.nodes.find(
			(n) =>
				Math.hypot(n.x - q.x, n.y - q.y) < 0.01 &&
				walks(graph).some((s) => s.startNodeId === n.id || s.endNodeId === n.id)
		)!;
	const lanes = [
		{ id: 's0', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' },
		{ id: 'b', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
		{ id: 'f', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
		{ id: 's1', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
	] satisfies GraphData['segments'][number]['lanes'];
	const path = [
		{ id: 'p', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
	] satisfies GraphData['segments'][number]['lanes'];
	// Opens the connector on a node by double-clicking it: the control
	// badges it shows.
	const connectorAt = async (q: Pt) => {
		await g.dblclick(q);
		return page.getByRole('button', { name: /^Approach control/ });
	};

	// A street cut at c, drawn whole through it, footpaths across it there
	// (each kind its own node at c once loaded).
	const crossed: GraphData = {
		nodes: [
			{ id: 'w', x: -65, y: 0 },
			{ id: 'c', x: 0, y: 0 },
			{ id: 'e', x: 65, y: 0 },
			{ id: 'n', x: 0, y: -24 },
			{ id: 's', x: 0, y: 24 }
		],
		segments: [
			{ id: 'street-a', startNodeId: 'w', endNodeId: 'c', lanes },
			{ id: 'street-b', startNodeId: 'c', endNodeId: 'e', lanes },
			{ id: 'path-n', startNodeId: 'n', endNodeId: 'c', lanes: path },
			{ id: 'path-s', startNodeId: 'c', endNodeId: 's', lanes: path }
		]
	};
	await openAt(page, crossed, ZOOM);
	const loaded = await liveGraph(page);
	const cars = carGraph(loaded);
	const walk = walkNodeAt(loaded, p(0, 0)).id;
	expect(walk).not.toBe('c');
	// Clicked and deleted: the footpaths go, the street stays.
	await g.click(p(0, 0));
	await page.keyboard.press('Delete');
	await expect.poll(async () => walks(await liveGraph(page)).length).toBe(0);
	expect(carGraph(await liveGraph(page))).toEqual(cars);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => liveGraph(page)).toEqual(loaded);
	// Double-clicked: the footpaths' connector, with no control to offer.
	const badge = await connectorAt(p(0, 0));
	await expect(badge).toHaveCount(0);
	await page.keyboard.press('Escape');
	// Dragged: the footpaths' node slides along the street, c stays.
	await g.drag(p(0, 0), p(4, 0));
	await expect.poll(async () => nodeOf(await liveGraph(page), walk).x).toBeGreaterThan(2);
	expect(nodeOf(await liveGraph(page), 'c')).toEqual(nodeOf(loaded, 'c'));
	expect(carGraph(await liveGraph(page))).toEqual(cars);

	// A street's end w, a footpath leaving it there (its own node at w).
	const ended: GraphData = {
		nodes: [
			{ id: 'w', x: -65, y: 0 },
			{ id: 'e', x: 65, y: 0 },
			{ id: 'p', x: -60, y: 25 }
		],
		segments: [
			{ id: 'street', startNodeId: 'w', endNodeId: 'e', lanes },
			{ id: 'path', startNodeId: 'w', endNodeId: 'p', lanes: path }
		]
	};
	await openAt(page, ended, ZOOM);
	const start = await liveGraph(page);
	expect(walkNodeAt(start, p(-65, 0)).id).not.toBe('w');
	// Clicked and deleted: the street goes, the footpath stays.
	await g.click(p(-65, 0));
	await page.keyboard.press('Delete');
	await expect.poll(async () => carGraph(await liveGraph(page)).segments.length).toBe(0);
	expect(walks(await liveGraph(page))).toHaveLength(1);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => liveGraph(page)).toEqual(start);
	// Double-clicked: the street carried on from its end.
	await g.dblclick(p(-65, 0));
	await g.click(p(-80, -17));
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await expect.poll(async () => carGraph(await liveGraph(page)).segments.length).toBe(2);
	expect(walks(await liveGraph(page))).toEqual(walks(start));
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => liveGraph(page)).toEqual(start);
	// Dragged: the street's end moves.
	await g.drag(p(-65, 0), p(-65, -10));
	await expect.poll(async () => nodeOf(await liveGraph(page), 'w').y).toBeLessThan(-8);
	expect(mixed(await liveGraph(page))).toEqual([]);
});

test('a double-click anywhere on a zebra opens its badge, the footpath node in it keeping its ring for clicks', async ({
	page
}) => {
	const ZOOM = 2;
	const g = gestures(page, ZOOM);
	await openAt(
		page,
		graphOf(
			[
				['a', -35, 0],
				['b', 35, 0],
				['c', 0, -20],
				['j', 0, 0],
				['d', 0, 24]
			],
			[
				['r', 'a', 'b', STREET],
				['p', 'c', 'j', PATH],
				['q', 'j', 'd', PATH]
			]
		),
		ZOOM
	);
	const scene = await drawingOf(page);
	const stripes = scene
		.road('r')!
		.crossings.flatMap((c) => c.runs.filter((r) => r.kind === 'zebra').flatMap((r) => r.rings));
	expect(stripes.length).toBeGreaterThan(2);
	for (const stripe of [stripes[0], stripes.at(-1)!]) {
		const q = stripe.reduce(
			(m, x) => ({ x: m.x + x.x / stripe.length, y: m.y + x.y / stripe.length }),
			{ x: 0, y: 0 }
		);
		await page.mouse.dblclick(g.view(q).x, g.view(q).y);
		await expect.poll(async () => (await editorLook(page)).crossing?.control).toBe('yield');
		expect((await editorLook(page)).connector).toBeNull();
		await page.keyboard.press('Escape');
		await expect.poll(async () => (await editorLook(page)).crossing).toBeNull();
		// A single click there still picks the node.
		await page.mouse.click(g.view(q).x, g.view(q).y);
		await expect.poll(async () => (await editorLook(page)).selection.nodes).toEqual(['j']);
		await page.keyboard.press('Escape');
	}
});
