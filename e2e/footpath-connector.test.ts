import { expect, test } from '@playwright/test';
import { inside } from '../src/lib/road-model/clip';
import { buildModel } from '../unit/model';
import {
	drawingOf,
	editorLook,
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	openAt,
	openEditor,
	p,
	type Pt,
	shot,
	sidewalk,
	lane
} from './app';
import { along, deg, PATH, pavingOf, STREET } from './paths';

// What the connector shows on a footpath node: each footpath there joined to
// every other its paving meets (all of them at a bend or joint; of ends on
// walkways, those on one walkway, two on one corner included), and to the
// walkway its own end lies on, each link drawn along the walker's line the
// model holds, on the paving (footpathJoin in modes/connector.ts). Each case
// is set up as a city and leaves a screenshot.

test.afterEach(async ({ page }, testInfo) => {
	await expectFreshDrawing(page);
	await shot(page, testInfo.outputPath('end.png'));
});

// Lines to the micrometre: the browser's trigonometry may differ in the
// last bit.
const um = (lines: Pt[][]) =>
	lines.map((l) => l.map((q) => [Math.round(q.x * 1e6), Math.round(q.y * 1e6)]));
const pairs = (links: [string, string][]) => links.map((l) => [...l].sort().join(' ')).sort();

test("the connector on a footpath node shows each footpath joined to every other, along the walker's lines, and to the sidewalk it lies on", async ({
	page
}, testInfo) => {
	const ZOOM = 4;
	const centre = p(0, 10);
	const g = gestures(page, ZOOM, centre);
	await openAt(
		page,
		graphOf(
			[
				['h', 0, 20],
				['a', -20, 30],
				['b', 20, 30],
				['s', 0, 4.5],
				['w', -60, 0],
				['e', 60, 0]
			],
			[
				[
					'street',
					'w',
					'e',
					[
						sidewalk('s0'),
						lane('f', 'vehicle', 3.5, 'forward'),
						lane('g', 'vehicle', 3.5, 'backward'),
						sidewalk('s1')
					]
				],
				['ha', 'h', 'a', PATH],
				['hb', 'h', 'b', PATH],
				['hs', 'h', 's', PATH]
			]
		),
		ZOOM,
		centre
	);
	const look = async () => (await editorLook(page)).connector;
	// At the hub: each of its three footpaths joined to the other two, each
	// link along the walker's line its joint holds, on the paving.
	await g.dblclick(p(0, 20));
	await expect.poll(async () => (await look())?.node).toBe('h');
	const hub = (await look())!;
	expect(pairs(hub.links)).toEqual(['ha:0 hb:0', 'ha:0 hs:0', 'hb:0 hs:0']);
	const scene = await drawingOf(page);
	expect(hub.lines).toHaveLength(3);
	expect(um(hub.lines)).toEqual(um(scene.node('walk:h')!.paths.map((q) => q.line)));
	const ground = pavingOf(scene);
	for (const line of hub.lines)
		for (const q of along(line)) expect([q, inside(ground, q)]).toEqual([q, true]);
	await shot(page, testInfo.outputPath('connector-hub.png'));
	await page.keyboard.press('Escape');
	await expect.poll(look).toBeNull();
	// At the end on the street's sidewalk: joined to that sidewalk (s1, the
	// street's last lane).
	await g.dblclick(p(0, 4.5));
	await expect.poll(async () => (await look())?.node).toBe('s');
	expect(pairs((await look())!.links)).toEqual(['hs:0 street:3']);
	await shot(page, testInfo.outputPath('connector-sidewalk.png'));
	await page.keyboard.press('Escape');
});

test("the connector's link round a footpath's bend follows the paving", async ({
	page
}, testInfo) => {
	// A footpath drawn from up the left down to a node at the origin and on
	// out to the right, 95° apart.
	const ZOOM = 10;
	const g = gestures(page, ZOOM);
	await openEditor(page, `topdown&model&cam=0,0,${ZOOM}`);
	await g.draw('Path', [deg(120, 15), p(0, 0), deg(25, 15)]);
	await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(2);
	const node = (await liveGraph(page)).nodes.find((n) => Math.hypot(n.x, n.y) < 0.01)!;
	await g.dblclick(node);
	await expect.poll(async () => (await editorLook(page)).connector?.node).toBe(node.id);
	const look = (await editorLook(page)).connector!;
	const scene = await drawingOf(page);
	// It draws the walker's line the node's bend holds.
	expect(um(look.lines)).toEqual(um(scene.node(`walk:${node.id}`)!.paths.map((q) => q.line)));
	expect(look.lines).toHaveLength(1);
	const ground = pavingOf(scene);
	for (const q of along(look.lines[0])) expect([q, inside(ground, q)]).toEqual([q, true]);
	await shot(page, testInfo.outputPath('connector-bend.png'));
	await page.keyboard.press('Escape');
});

test("the connector's link from a footpath onto the sidewalk its end lies on follows the paving", async ({
	page
}, testInfo) => {
	// A street along x, and a footpath from the open down at a slant onto
	// its sidewalk, its end on the sidewalk's middle as a footpath drawn
	// there lands.
	const ZOOM = 10;
	const g = gestures(page, ZOOM);
	await openAt(
		page,
		graphOf(
			[
				['w', -30, 0],
				['e', 25, 0],
				['far', -8, 14],
				['end', 0, 4.5]
			],
			[
				['street', 'w', 'e', 'street'],
				['walk', 'far', 'end', 'path']
			]
		),
		ZOOM
	);
	await g.dblclick(p(0, 4.5));
	await expect.poll(async () => (await editorLook(page)).connector?.node).toBe('end');
	const look = (await editorLook(page)).connector!;
	expect(look.links).toHaveLength(1);
	const ground = pavingOf(await drawingOf(page));
	for (const q of along(look.lines[0])) expect([q, inside(ground, q)]).toEqual([q, true]);
	// From along the footpath onto the sidewalk's middle.
	expect(look.lines[0].length).toBeGreaterThan(2);
	await shot(page, testInfo.outputPath('connector-sidewalk.png'));
	await page.keyboard.press('Escape');
});

test('two footpaths ended on one corner are linked to each other in the connector', async ({
	page
}) => {
	const ZOOM = 8;
	const g = gestures(page, ZOOM);
	await openAt(
		page,
		graphOf(
			[
				['j', 0, 0],
				['a', -27, 0],
				['b', 27, 0],
				['c', 0, 26],
				['d', 0, -26],
				['jwalk', 5.67, 5.67],
				['p', 14, 20],
				['q', 20, 14]
			],
			[
				['west', 'a', 'j', STREET],
				['east', 'j', 'b', STREET],
				['south', 'j', 'c', STREET],
				['north', 'd', 'j', STREET],
				['p', 'jwalk', 'p', PATH, { offsetStart: 1.8, offsetEnd: 1.8 }],
				['q', 'jwalk', 'q', PATH, { offsetStart: -1.8, offsetEnd: -1.8 }]
			]
		),
		ZOOM
	);
	// Their ends lie on the corner's two halves, named after its two lanes.
	await expectFreshDrawing(page);
	const ends = buildModel(await liveGraph(page)).derived.sidewalks.get('jwalk')!;
	expect(ends.map((on) => on.road).sort()).toEqual(['east', 'south']);
	await g.dblclick(p(5.67, 5.67));
	await expect
		.poll(async () => (await editorLook(page)).connector?.links.map((l) => [...l].sort().join()))
		.toContain('p:0,q:0');
});

test('the connector links two footpaths on opposite sidewalks to their own alone, not to each other, listed either way', async ({
	page
}) => {
	// The node in the street's middle; west shifted onto its south sidewalk,
	// east onto its north one. Lanes run left to right of the way the street
	// is drawn: `west`, shifted to its right, lies on the last, `east`,
	// shifted to its left, on the first.
	const ZOOM = 8;
	const g = gestures(page, ZOOM);
	const graph = graphOf(
		[
			['a', -50, 0],
			['b', 50, 0],
			['c', -30, 0],
			['j', 0, 0],
			['d', 30, 0]
		],
		[
			['r', 'a', 'b', STREET],
			['west', 'c', 'j', PATH, { offsetStart: 4.5, offsetEnd: 4.5 }],
			['east', 'j', 'd', PATH, { offsetStart: -4.5, offsetEnd: -4.5 }]
		]
	);
	for (const order of [
		['west', 'east'],
		['east', 'west']
	])
		await test.step(`listed ${order.join(' then ')}`, async () => {
			await openAt(
				page,
				{
					...graph,
					segments: [
						graph.segments[0],
						...order.map((id) => graph.segments.find((s) => s.id === id)!)
					]
				},
				ZOOM
			);
			await g.dblclick(p(0, 0));
			await expect.poll(async () => (await editorLook(page)).connector?.node).toBe('j');
			const look = await editorLook(page);
			expect([...look.joined].sort()).toEqual(['left', 'right']);
			expect(pairs(look.connector!.links)).toEqual(['east:0 r:0', 'r:3 west:0']);
			await page.keyboard.press('Escape');
		});
});
