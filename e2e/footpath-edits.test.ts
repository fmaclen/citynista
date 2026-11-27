import { expect, test, type Page } from '@playwright/test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import {
	drawingOf,
	editorLook,
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	openAt,
	p,
	type Pt,
	shot,
	undoButton,
	walks
} from './app';
import { carGraph, mixed, undoRedo } from './paths';

// A node holds car roads or footpaths, never both (core/separate.ts): no
// footpath operation the editor offers changes a car node or car segment,
// and a footpath meets a street only where it is drawn: on its sidewalk, at
// its curb, or across it, where the crossing is paint. A footpath pasted
// joins a footpath node only where the two lie and show at one spot, and
// one laid within the footpaths already there is taken out; a footpath node
// holds no junction edits. Each test leaves a screenshot.

test.describe.configure({ mode: 'parallel' });

// Whatever a test here edits, the editor draws as a fresh build of its graph
// would.
test.afterEach(({ page }) => expectFreshDrawing(page));

// The sidewalk lanes the connector shows its node joined to.
const joined = async (page: Page) => (await editorLook(page)).joined;

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
			]
		}
	]
} satisfies GraphData;

// The footpath gestures on the page; every operation over streets of
// several shapes, with undo and redo after each, is in
// unit/footpath-gestures.test.ts. A footpath drawn with the toolbar's Path
// brush, its node double-clicked open in the connector, and the street
// dragged by its body, undone and redone with the keys.
test('a footpath drawn to a street joins its sidewalk and rides the street dragged by its body, the car nodes otherwise as they were', async ({
	page
}, testInfo) => {
	const g = gestures(page, 4);
	await openAt(page, street, 4);
	const before = carGraph(await liveGraph(page));

	// Drawn from 20 m south to the street's south side: its end on the
	// near sidewalk's middle (y 4.5), joined to it, offering no control.
	await g.draw('Path', [p(0, 24), p(0.3, 2.8)], [false, true]);
	await expect.poll(async () => walks(await liveGraph(page)).length).toBe(1);
	const drawn = await liveGraph(page);
	const end = drawn.nodes.find((n) => n.id === walks(drawn)[0].endNodeId)!;
	expect([end.x, end.y]).toEqual([expect.closeTo(0.3, 0), expect.closeTo(4.5, 6)]);
	expect(carGraph(drawn)).toEqual(before);
	await g.dblclick(end);
	await expect.poll(() => joined(page)).toEqual(['s1']);
	await expect(page.getByRole('button', { name: /^Approach control/ })).toHaveCount(0);
	await page.keyboard.press('Escape');

	// The street dragged 6 m south by its body: the footpath's end rides
	// with it.
	await g.drag(p(-40, 1), p(-40, 7), 6);
	await expect
		.poll(async () => (await liveGraph(page)).nodes.find((n) => n.id === 'w')!.y)
		.toBeGreaterThan(5);
	const dragged = await liveGraph(page);
	const moved = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id)!;
	const by = { x: moved(dragged, 'w').x + 65, y: moved(dragged, 'w').y };
	expect([moved(dragged, end.id).x - end.x, moved(dragged, end.id).y - end.y]).toEqual([
		expect.closeTo(by.x, 6),
		expect.closeTo(by.y, 6)
	]);
	expect(mixed(dragged)).toEqual([]);
	await page.keyboard.press('Escape');
	await undoRedo(page, drawn, dragged);
	await shot(page, testInfo.outputPath('street-dragged.png'));
});

// Pasting footpaths: the copy is centred where the pointer clicks, its
// nodes laid onto a footpath node only where the two lie and show at one
// spot, and a footpath laid whose strip lies within the footpaths already
// there taken out.
const ZOOM = 4;
// The lanes of a footpath `width` m wide.
const pathOf = (width = 2) => {
	const lanes = createLanesFrom('path');
	lanes[0].width = width;
	return lanes;
};
const ends = (graph: GraphData, id: string) => {
	const s = graph.segments.find((x) => x.id === id)!;
	return [s.startNodeId, s.endNodeId];
};
// Copies the road under `from` and pastes it centred on `to`.
async function copyPaste(page: Page, from: Pt, to: Pt) {
	const g = gestures(page, ZOOM);
	await g.click(from);
	await expect.poll(async () => (await editorLook(page)).selection.segments.length).toBe(1);
	await page.keyboard.press('ControlOrMeta+c');
	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+v');
	await g.move(to);
	await g.click(to);
	await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual([]);
}

test.describe('A footpath pasted over one already there', () => {
	test('is kept where it bows away from it', async ({ page }) => {
		// A 10 m wide curve pasted with its ends on the line of a 2 m path,
		// beyond its nodes: cut at both, its middle bows 15 m off the path.
		const graph = graphOf(
			[
				['a', -37, 0],
				['b', 37, 0],
				['s', -45, 10],
				['t', 45, 10]
			],
			[
				['straight', 'a', 'b', 'path'],
				['curved', 's', 't', 'path']
			]
		);
		graph.segments[1].lanes[0].width = 10;
		Object.assign(graph.segments[1], { controlX: 0, controlY: 40 });
		await openAt(page, graph, ZOOM);
		await copyPaste(page, p(0, 25), p(0, 0));
		const after = await liveGraph(page);
		// The curve cut at a and b, all three of its pieces laid.
		expect(after.segments.length).toBe(5);
		const between = after.segments.filter(
			(s) => [s.startNodeId, s.endNodeId].sort().join() === 'a,b'
		);
		expect(between.map((s) => s.controlX !== undefined).sort()).toEqual([false, true]);
		await expectFreshDrawing(page);
	});

	test('exactly over itself lays nothing', async ({ page }) => {
		await openAt(
			page,
			graphOf(
				[
					['a', -25, 0],
					['b', 25, 0]
				],
				[['path', 'a', 'b', 'path']]
			),
			ZOOM
		);
		const before = await liveGraph(page);
		await copyPaste(page, p(0, 0), p(0, 0));
		expect(await liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expectFreshDrawing(page);
	});
});

test('a shifted footpath pasted with its nodes on a footpath’s nodes, showing beside it, keeps nodes of its own', async ({
	page
}) => {
	// `source` shows 4 m off its nodes; pasted with them on a and b it shows
	// 4 m beside `target`, clear of it.
	await openAt(
		page,
		graphOf(
			[
				['a', -25, 0],
				['b', 25, 0],
				['c', -25, 25],
				['d', 25, 25]
			],
			[
				['target', 'a', 'b', pathOf()],
				['source', 'c', 'd', pathOf(), { offsetStart: 4, offsetEnd: 4 }]
			]
		),
		ZOOM
	);
	await copyPaste(page, p(0, 29), p(0, 0));
	const after = await liveGraph(page);
	const pasted = after.segments.filter((s) => !['target', 'source'].includes(s.id));
	expect(pasted).toHaveLength(1);
	const [start, end] = ends(after, pasted[0].id);
	expect([start, end].some((id) => id === 'a' || id === 'b')).toBe(false);
	for (const id of ['a', 'b']) expect(after.nodes.some((n) => n.id === id)).toBe(true);
	expect(after.segments.filter((s) => [s.startNodeId, s.endNodeId].includes('a'))).toHaveLength(1);
	expect(check(await drawingOf(page))).toEqual([]);
});

test('a short footpath pasted along the middle of a longer one lays nothing', async ({ page }) => {
	await openAt(
		page,
		graphOf(
			[
				['a', -60, 0],
				['b', 60, 0],
				['c', -18, 25],
				['d', 18, 25]
			],
			[
				['target', 'a', 'b', pathOf()],
				['source', 'c', 'd', pathOf()]
			]
		),
		ZOOM
	);
	const before = await liveGraph(page);
	await copyPaste(page, p(0, 25), p(0, 0));
	expect(await liveGraph(page)).toEqual(before);
	await expect(undoButton(page)).toBeDisabled();
});

test('a footpath node holds no junction edits: none read, none pasted where it lands', async ({
	page
}) => {
	// `source`'s node d is saved with a setback; pasted, c lands on b.
	const graph = graphOf(
		[
			['a', -24, 0],
			['b', 24, 0],
			['c', 24, 0],
			['d', 24, 28],
			['e', -38, -12],
			['f', 24, -20]
		],
		[
			['west', 'e', 'a', pathOf()],
			['east', 'b', 'f', pathOf()],
			['source', 'c', 'd', pathOf()]
		]
	);
	graph.nodes[3].junction = { setbacks: { source: 12 } };
	graph.nodes[1].junction = { setbacks: { east: 9 } };
	await openAt(page, graph, ZOOM);
	const read = await liveGraph(page);
	expect(read.nodes.filter((n) => n.junction)).toEqual([]);
	await copyPaste(page, p(24, 14), p(-24, 14));
	const after = await liveGraph(page);
	expect(after.nodes.filter((n) => n.junction)).toEqual([]);
	const pasted = after.segments.find((s) => !['west', 'east', 'source'].includes(s.id))!;
	expect(ends(after, pasted.id)).toContain('a');
});
