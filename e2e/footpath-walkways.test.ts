import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { buildModel } from '../unit/model';
import {
	editorLook,
	expectFreshDrawing,
	expectSelectMode,
	gestures,
	graphOf,
	isCar,
	liveGraph,
	nodeOf,
	openAt,
	openEditor,
	p,
	roadModel,
	shot,
	sidewalk,
	snapshot,
	throughHistory
} from './app';
import { PATH, STREET } from './paths';

// A footpath whose end lies on a street's walkway is joined to it: it slides
// along it however it is dragged, its shown end staying on it however the
// footpath is shifted, and shows so when selected (joinedTo in
// modes/picking.ts); whatever draws the walkway anew under it keeps it on
// that walkway (Editor.followWalkways), and where the walkway is drawn no
// more it stays where it is, joined to nothing, never pulled onto another.
// A footpath snaps to every walkway of a street, one down its middle
// included. Each case is set up as a city and acted on through the editor's
// gestures, and leaves a screenshot.

test.afterEach(async ({ page }, testInfo) => {
	await expectFreshDrawing(page);
	await shot(page, testInfo.outputPath('end.png'));
});

const ZOOM = 10;
const GROUND = p(-25, -15);
const nodeAt = async (page: Page, id: string) => nodeOf(await liveGraph(page), id);

// A street along x, and a footpath from out in the open down onto its
// sidewalk, its end on the sidewalk's middle, 4.5 m right of the street's
// line, as a footpath drawn there lands; with `more` footpaths from that end
// to the points given.
const onSidewalk = (more: [string, number, number][] = []): GraphData =>
	graphOf(
		[['w', -30, 0], ['e', 25, 0], ['far', -8, 14], ['end', 0, 4.5], ...more],
		[
			['street', 'w', 'e', 'street'],
			['walk', 'far', 'end', 'path'],
			...more.map(([id]) => [`walk-${id}`, 'end', id, 'path'] as [string, string, string, 'path'])
		]
	);
const joinedAtEnd = [{ node: 'end', lane: 'street:3' }];

test.describe('a footpath joined to a sidewalk stays joined', () => {
	test('a joined end dragged with its footpath, in a group, or as a node of two footpaths slides along the sidewalk', async ({
		page
	}, testInfo) => {
		const g = gestures(page, ZOOM, p(0, 0), { ground: GROUND });
		await openAt(page, onSidewalk(), ZOOM);
		const opened = await snapshot(page);
		const [end, far] = [await nodeAt(page, 'end'), await nodeAt(page, 'far')];

		// Dragged with its footpath, by a point a third of the way along,
		// clear of its curve's handle.
		const on = { x: (2 * end.x + far.x) / 3, y: (2 * end.y + far.y) / 3 };
		await g.click(on);
		await g.drag(on, { x: on.x + 5, y: on.y + 8 });
		let [e, f] = [await nodeAt(page, 'end'), await nodeAt(page, 'far')];
		expect(f.x).toBeCloseTo(far.x + 5, 1);
		expect(f.y).toBeCloseTo(far.y + 8, 1);
		expect(e.x).toBeCloseTo(end.x + 5, 1);
		expect(e.y).toBeCloseTo(4.5, 6);
		await shot(page, testInfo.outputPath('dragged-with-footpath.png'));
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => snapshot(page)).toBe(opened);

		// Dragged in a group, its far node and its end selected.
		await g.deselect();
		await g.click(far);
		await page.keyboard.down('Shift');
		await g.click(end);
		await page.keyboard.up('Shift');
		await expect.poll(async () => (await editorLook(page)).selection.nodes.length).toBe(2);
		await g.drag(far, { x: far.x + 4, y: far.y - 3 });
		[e, f] = [await nodeAt(page, 'end'), await nodeAt(page, 'far')];
		expect(f.x).toBeCloseTo(far.x + 4, 1);
		expect(f.y).toBeCloseTo(far.y - 3, 1);
		expect(e.x).toBeCloseTo(end.x + 4, 1);
		expect(e.y).toBeCloseTo(4.5, 6);
		await shot(page, testInfo.outputPath('dragged-in-group.png'));

		// A node of two footpaths there, dragged away from the street: no
		// fill, held or let go, sliding along the sidewalk it stays joined to.
		await openAt(page, onSidewalk([['far2', 10, 16]]), ZOOM);
		const isJunction = async () =>
			!!(await roadModel(page))?.junctions.some((j) => j.id === 'walk:end');
		expect(await isJunction()).toBe(false);
		await g.click(end);
		await expect.poll(async () => (await editorLook(page)).joins).toEqual(joinedAtEnd);
		await g.deselect();
		await g.hold(end, { x: end.x + 3, y: 12 }, async () => {
			await expectFreshDrawing(page);
			expect(await isJunction()).toBe(false);
		});
		await page.mouse.up();
		await expectFreshDrawing(page);
		const slid = await nodeAt(page, 'end');
		expect(slid.x).toBeCloseTo(end.x + 3, 0);
		expect(slid.y).toBeCloseTo(end.y, 6);
		expect(await isJunction()).toBe(false);
		await g.deselect();
		await g.click(slid);
		await expect.poll(async () => (await editorLook(page)).joins).toEqual(joinedAtEnd);
		await shot(page, testInfo.outputPath('pair-slid.png'));
	});

	test('its node or its footpath selected shows it joined, without the connector', async ({
		page
	}, testInfo) => {
		const g = gestures(page, ZOOM);
		await openAt(page, onSidewalk(), ZOOM);
		const [end, far] = [await nodeAt(page, 'end'), await nodeAt(page, 'far')];
		await g.click(end);
		await expect.poll(async () => (await editorLook(page)).joins).toEqual(joinedAtEnd);
		expect((await editorLook(page)).connector).toBeNull();
		await shot(page, testInfo.outputPath('node-selected.png'));
		await page.keyboard.press('Escape');
		await expect.poll(async () => (await editorLook(page)).joins).toEqual([]);
		await g.click({ x: (end.x + far.x) / 2, y: (end.y + far.y) / 2 });
		await expect.poll(async () => (await editorLook(page)).joins).toEqual(joinedAtEnd);
		await shot(page, testInfo.outputPath('footpath-selected.png'));
	});

	test('it comes off once its street is deleted', async ({ page }) => {
		const g = gestures(page, ZOOM);
		await openAt(page, onSidewalk(), ZOOM);
		const end = await nodeAt(page, 'end');
		await g.click(p(-20, -1));
		await page.keyboard.press('Delete');
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(1);
		await g.click(end);
		await expect.poll(async () => (await editorLook(page)).selection.nodes).toEqual(['end']);
		expect((await editorLook(page)).joins).toEqual([]);
		await g.drag(end, { x: end.x + 6, y: end.y + 10 });
		const now = await nodeAt(page, 'end');
		expect(now.x).toBeCloseTo(end.x + 6, 1);
		expect(now.y).toBeCloseTo(end.y + 10, 1);
	});

	test('it stays on its sidewalk when the street is widened', async ({ page }, testInfo) => {
		const g = gestures(page, ZOOM, p(0, 0), { ground: GROUND });
		await openAt(page, onSidewalk(), ZOOM);
		const end = await nodeAt(page, 'end');
		await g.click(p(-20, -1));
		const input = page.locator('aside').locator('input[type="number"]').nth(2);
		await input.fill('5');
		await input.press('Tab');
		await g.deselect();
		await expect
			.poll(async () => (await liveGraph(page)).segments.find(isCar)!.lanes[2].width)
			.toBe(5);
		// Lanes of 2, 3.5, 5 and 2: the sidewalk's middle 5.25 m right.
		const now = await nodeAt(page, 'end');
		expect(now.x).toBeCloseTo(end.x, 6);
		expect(now.y).toBeCloseTo(5.25, 6);
		await g.click(now);
		await expect.poll(async () => (await editorLook(page)).joins).toEqual(joinedAtEnd);
		await shot(page, testInfo.outputPath('street-widened.png'));
	});
});

test.describe('a footpath snaps to every walkway of a street', () => {
	// The street with a walkway down its middle, made in the lane editor from
	// a street: its back lane copied, the copy made a concrete pedestrian
	// lane 4 m wide. Sidewalk 2, back lane 3.5 (2 to 5.5 m left of its line),
	// walkway 4, forward lane 3.5 (2 to 5.5 m right), sidewalk 2.
	async function parted(page: Page) {
		const g = gestures(page, ZOOM, p(0, 0), { ground: GROUND });
		await openEditor(page, `topdown&model&cam=0,0,${ZOOM}`);
		await g.draw('Street', [p(-30, 0), p(25, 0)]);
		await g.click(p(-20, -1));
		const rows = page.locator('aside').getByRole('listitem');
		await rows.nth(1).getByTitle('Copy lane').click();
		await rows.nth(2).getByText('Vehicle').click();
		await page.getByRole('option', { name: 'Pedestrian' }).click();
		await rows.nth(2).getByText('Asphalt').click();
		await page.getByRole('option', { name: 'Concrete' }).click();
		const width = rows.nth(2).locator('input[type="number"]');
		await width.fill('4');
		await width.press('Tab');
		await g.deselect();
		const lanes = async () =>
			(await liveGraph(page)).segments[0].lanes.map((l) => [l.role, l.material, l.width]);
		await expect.poll(lanes).toEqual([
			['pedestrian', 'concrete', 2],
			['vehicle', 'asphalt', 3.5],
			['pedestrian', 'concrete', 4],
			['vehicle', 'asphalt', 3.5],
			['pedestrian', 'concrete', 2]
		]);
		return (await liveGraph(page)).segments[0];
	}

	test('drawn onto the walkway down the middle, it lands there and is joined to it', async ({
		page
	}, testInfo) => {
		const g = gestures(page, ZOOM);
		const street = await parted(page);
		await g.draw('Path', [p(-8, 14), p(0, 0.8)], [false, true]);
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(2);
		const graph = await liveGraph(page);
		const walk = graph.segments.find((s) => !isCar(s))!;
		const end = nodeOf(graph, walk.endNodeId);
		expect(end.y).toBeCloseTo(0, 6);
		// Joined to the walkway down the middle, along which it slides.
		await g.click(end);
		await expect
			.poll(async () => (await editorLook(page)).joins)
			.toEqual([{ node: end.id, lane: `${street.id}:2` }]);
		await shot(page, testInfo.outputPath('onto-middle.png'));
		await g.drag(end, { x: end.x - 5, y: end.y + 9 });
		const now = await nodeAt(page, end.id);
		expect(now.x).toBeCloseTo(end.x - 5, 1);
		expect(now.y).toBeCloseTo(0, 6);
		await shot(page, testInfo.outputPath('along-middle.png'));
	});

	test('dragged alone onto the walkway down the middle, its end lands there', async ({ page }) => {
		const g = gestures(page, ZOOM);
		await openAt(
			page,
			graphOf(
				[
					['w', -30, 0],
					['e', 25, 0],
					['far', -8, 24],
					['end', -8, 14]
				],
				[
					['street', 'w', 'e', [STREET[0], STREET[1], sidewalk('middle', 4), STREET[2], STREET[3]]],
					['walk', 'far', 'end', PATH]
				]
			),
			ZOOM
		);
		await g.drag(p(-8, 14), p(-6, -0.6));
		const now = await nodeAt(page, 'end');
		expect(now.x).toBeCloseTo(-6, 1);
		expect(now.y).toBeCloseTo(0, 6);
		await g.click(now);
		await expect
			.poll(async () => (await editorLook(page)).joins)
			.toEqual([{ node: 'end', lane: 'street:2' }]);
	});
});

test.describe('a footpath end on a walkway stays joined', () => {
	const Z = 8;

	test("a street added on the far side keeps an end on the junction's sidewalk joined, sliding along it", async ({
		page
	}) => {
		const g = gestures(page, Z);
		await openAt(
			page,
			graphOf(
				[
					['a', -35, 0],
					['b', 35, 0],
					['c', 0, 4.5],
					['d', 0, 20]
				],
				[
					['r', 'a', 'b', STREET],
					['w', 'c', 'd', PATH]
				]
			),
			Z
		);
		await g.click(p(0, 4.5));
		await expect
			.poll(async () => (await editorLook(page)).joins)
			.toEqual([{ node: 'c', lane: 'r:3' }]);
		await page.keyboard.press('Escape');
		await g.draw('Street', [p(0, -23), p(0, 0)], [false, true]);
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(4);
		// The end lies on the junction's sidewalk now, joined to the
		// through road's sidewalk there.
		await expectSelectMode(page);
		await g.click(p(0, 4.5));
		await expect.poll(async () => (await editorLook(page)).selection.nodes).toEqual(['c']);
		const joins = (await editorLook(page)).joins;
		expect(joins).toHaveLength(1);
		expect(joins[0].lane).toMatch(/:3$/);
		// Dragged out into the open it slides along that sidewalk.
		await g.drag(p(0, 4.5), p(2, 10), 9);
		const now = await nodeAt(page, 'c');
		expect(now.x).toBeCloseTo(2, 0);
		expect(now.y).toBeCloseTo(4.5, 1);
		expect((await editorLook(page)).joins).toHaveLength(1);
	});

	test('a shifted footpath dragged along its sidewalk keeps its shown end on it', async ({
		page
	}) => {
		const g = gestures(page, Z);
		await openAt(
			page,
			graphOf(
				[
					['a', -36, 0],
					['b', 36, 0],
					['c', 3, 4.5],
					['d', 3, 19]
				],
				[
					['r', 'a', 'b', STREET],
					['w', 'c', 'd', PATH, { offsetStart: 3, offsetEnd: 3 }]
				]
			),
			Z
		);
		// Where the straight footpath's start shows: its node moved by its
		// shift, to the right of the way it runs.
		const shownStart = async () => {
			const graph = await liveGraph(page);
			const w = graph.segments.find((x) => x.id === 'w')!;
			const [a, b] = [nodeOf(graph, w.startNodeId), nodeOf(graph, w.endNodeId)];
			const l = Math.hypot(b.x - a.x, b.y - a.y);
			const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
			return { x: a.x - t.y * w.offsetStart!, y: a.y + t.x * w.offsetStart! };
		};
		await g.click(p(0, 4.5));
		await expect
			.poll(async () => (await editorLook(page)).joins)
			.toEqual([{ node: 'c', lane: 'r:3' }]);
		await g.drag(p(0, 4.5), p(15, 4.5), 9);
		const shown = await shownStart();
		expect(shown.y).toBeCloseTo(4.5, 2);
		expect(shown.x).toBeCloseTo(15, 0);
		await expect
			.poll(async () => (await editorLook(page)).joins)
			.toEqual([{ node: 'c', lane: 'r:3' }]);
	});
});

test.describe('an end joined to a walkway follows it alone', () => {
	const Z = 8;

	// What a fresh build finds the footpath's end on, and how many zebras
	// the street `road` draws (none, where it is deleted).
	const endOf = async (page: Page, road: string) => {
		const graph = await liveGraph(page);
		const { derived, scene } = buildModel(graph);
		const on = derived.sidewalks.get('end')?.[0];
		const zebras = (scene.road(road)?.crossings ?? []).filter((c) =>
			c.runs.some((r) => r.kind === 'zebra')
		);
		return {
			node: graph.nodes.find((x) => x.id === 'end'),
			joined: on ? `${on.road} ${on.lane}` : null,
			zebras: zebras.length
		};
	};
	// The street selected (it runs along y 0 from x -40 to 40) and lane `k`
	// of its panel, of role `from`, given role `to`.
	async function retype(page: Page, k: number, from: string, to: string) {
		await gestures(page, Z).click(p(19, 0));
		await page
			.locator('[data-lane]')
			.nth(k)
			.getByRole('button', { name: from, exact: true })
			.first()
			.click();
		await page.getByRole('option', { name: to, exact: true }).click();
		await page.keyboard.press('Escape');
	}

	test('its sidewalk retyped as a buffer leaves it where it is, not on the far sidewalk', async ({
		page
	}) => {
		// A one-way lane 2.5 m wide between 1 m sidewalks, the path ended on
		// the north one's middle (y -1.75).
		const thin = [
			{ ...STREET[0], width: 1 },
			{ ...STREET[2], width: 2.5 },
			{ ...STREET[3], width: 1 }
		];
		await openAt(
			page,
			graphOf(
				[
					['a', -40, 0],
					['b', 40, 0],
					['end', 0, -1.75],
					['far', 0, -18]
				],
				[
					['r', 'a', 'b', thin],
					['w', 'end', 'far', PATH]
				]
			),
			Z
		);
		const was = await endOf(page, 'r');
		expect(was).toMatchObject({ joined: 'r left', zebras: 0 });
		const before = await snapshot(page);
		await retype(page, 0, 'Pedestrian', 'Buffer');
		await throughHistory(page, before, async () =>
			expect(await endOf(page, 'r')).toEqual({ node: was.node, joined: null, zebras: 0 })
		);
	});

	// Two streets 12 m apart, the path ended on the south sidewalk of the
	// north one (r, y 3.5 to 5.5), 3 m from the neighbour's north sidewalk.
	const parallel = () =>
		graphOf(
			[
				['a', -40, 0],
				['b', 40, 0],
				['c', -40, 12],
				['d', 40, 12],
				['end', 0, 4.5],
				['far', 19, 6]
			],
			[
				['r', 'a', 'b', STREET],
				['neighbour', 'c', 'd', STREET],
				['w', 'end', 'far', PATH]
			]
		);
	for (const [name, edit] of [
		[
			'its street deleted',
			async (page: Page) => {
				await gestures(page, Z).click(p(19, 0));
				await page.keyboard.press('Delete');
				await page.keyboard.press('Escape');
			}
		],
		['its sidewalk retyped as a buffer', (page: Page) => retype(page, 3, 'Pedestrian', 'Buffer')]
	] as const)
		test(`${name} leaves it where it is, not on the street beside`, async ({ page }) => {
			await openAt(page, parallel(), Z);
			const was = await endOf(page, 'neighbour');
			expect(was).toMatchObject({ joined: 'r right', zebras: 0 });
			const before = await snapshot(page);
			await edit(page);
			expect(await snapshot(page)).not.toBe(before);
			expect(await endOf(page, 'neighbour')).toEqual({ node: was.node, joined: null, zebras: 0 });
		});
});
