import { expect, test, type Page } from '@playwright/test';
import type { CrossingControl, GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { linesAt, linesNear, storedControls } from './crossing';
import {
	drawingOf,
	editorLook,
	expectFreshDrawing,
	gestures,
	isCar,
	lane,
	liveGraph,
	openAt,
	p,
	type Pt,
	saveCity,
	shot,
	sidewalk,
	snapshot,
	storedGraph,
	throughHistory,
	undoButton,
	unsavedMarker
} from './app';

// A crossing's control is set on the crossing itself (double-click its
// zebra, click its badge) and stored for its footpath segment and the
// carriageway it crosses, which every crossing that segment makes of that
// carriageway takes (core/crossing-controls.ts): nothing tells two
// crossings of one carriageway apart, so no edit moves a control from one
// crossing to another, and only an edit the user saves writes one. How the
// carrying works through each edit that replaces a car segment is held in
// unit/crossing-controls.test.ts, and the editor's gestures, tools and undo
// carrying it in unit/crossing-gestures.test.ts; here are the routes that
// need the page: the badge's button, the toolbar, the lane panel, and a save
// and reload.

test.afterEach(({ page }) => expectFreshDrawing(page));

const ZOOM = 6;
const path = [sidewalk('path')];
// Two carriageways running the same way either side of a 4 m walkway:
// sidewalk, the near lane (y -5.5 to -2), the walkway, the far lane (2 to
// 5.5), sidewalk.
const sameWay = [
	sidewalk('left'),
	lane('near', 'vehicle', 3.5, 'forward'),
	lane('middle', 'pedestrian', 4),
	lane('far', 'vehicle', 3.5, 'forward'),
	sidewalk('right')
];
// One carriageway, a lane each way: y -3.5 to 0 and 0 to 3.5.
const twoWay = [
	sidewalk('left'),
	lane('back', 'vehicle', 3.5, 'backward'),
	lane('forward', 'vehicle', 3.5, 'forward'),
	sidewalk('right')
];

// A street `r` along y = 0 from (-x, 0) to (x, 0), and a footpath `w`, either
// straight across at x = 0 or bowed through (0, 60) from (-32, -20) to
// (32, -20), crossing the street near x -22 and x 22; storing `controls`.
function crossed(
	lanes: Lane[],
	shape: 'straight' | 'bowed',
	controls?: unknown[],
	x = shape === 'bowed' ? 40 : 35
): GraphData {
	const [from, to] = shape === 'bowed' ? [p(-32, -20), p(32, -20)] : [p(0, -20), p(0, 24)];
	return {
		nodes: [
			{ id: 'a', x: -x, y: 0 },
			{ id: 'b', x, y: 0 },
			{ id: 'p', ...from },
			{ id: 'q', ...to }
		],
		segments: [
			{ id: 'r', startNodeId: 'a', endNodeId: 'b', lanes },
			{
				id: 'w',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: path,
				...(shape === 'bowed' && { controlX: 0, controlY: 60 }),
				...(controls && { controls: controls as CrossingControl[] })
			}
		]
	};
}

const lines = async (page: Page, x: number) => linesAt(await drawingOf(page), x);
const crossingButtons = (page: Page) => page.getByRole('button', { name: /^Crossing control/ });

// The editor's gestures at ZOOM, and the Split tool from the toolbar.
function on(page: Page) {
	const g = gestures(page, ZOOM);
	const split = async (at: Pt) => {
		await page.getByTitle('Split (click a road to cut it at that point)').click();
		await g.click(at);
		await page.keyboard.press('Escape');
	};
	return { ...g, split };
}

test.describe('Stop on one carriageway and Signal on the other of a divided street', () => {
	// Both carriageways run the same way, so each holds its own traffic
	// alone: a stop line across the near lane, and one for the signal across
	// the far lane.
	async function held(page: Page) {
		await openAt(page, crossed(sameWay, 'straight'), ZOOM);
		const g = on(page);
		await g.setControl(p(0.3, -3.75), 'stop');
		await g.setControl(p(0.3, 3.75), 'signal');
		return g;
	}
	// The lines at x, and each carriageway's badge there, as set.
	async function expectHeld(page: Page, x: number, y = 0) {
		const g = on(page);
		await expect.poll(() => lines(page, x)).toEqual(['stop far', 'stop near']);
		expect(await g.badgeAt(p(x + 0.3, y - 3.75))).toBe('stop');
		expect(await g.badgeAt(p(x + 0.3, y + 3.75))).toBe('signal');
		expect(check(await drawingOf(page))).toEqual([]);
	}
	const kept = [
		{ roads: ['r'], lanes: ['far'], control: 'signal' },
		{ roads: ['r'], lanes: ['near'], control: 'stop' }
	];
	// The lines at x as set and the entries stored.
	async function linesHeld(page: Page, x: number, stored = kept) {
		await expect.poll(() => lines(page, x)).toEqual(['stop far', 'stop near']);
		expect(await storedControls(page)).toEqual(stored);
	}

	// Each badge step undone and redone is in unit/crossing-gestures.test.ts.
	test('through a save and reload', async ({ page }) => {
		await held(page);
		await expectHeld(page, 0);
		await saveCity(page);
		await page.reload();
		await expect(page.getByTestId('city-name')).toHaveText('test');
		await expectHeld(page, 0);
		expect(await storedControls(page)).toEqual(kept);
	});

	test('through the street cut with the Split tool', async ({ page }, testInfo) => {
		const g = await held(page);
		const before = await snapshot(page);
		// Cut west of the crossing: each entry names both halves of the street.
		await g.split(p(-20, 0));
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(3);
		const halves = (await liveGraph(page)).segments
			.filter(isCar)
			.map((s) => s.id)
			.sort();
		const named = async () =>
			(await storedControls(page)).map((k) => ({ ...k, roads: [...k.roads].sort() }));
		await throughHistory(
			page,
			before,
			async () => {
				await expect.poll(() => lines(page, 0)).toEqual(['stop far', 'stop near']);
				expect(await named()).toEqual(kept.map((k) => ({ ...k, roads: halves })));
			},
			() => linesHeld(page, 0)
		);
		await shot(page, testInfo.outputPath('street-cut.png'));
	});

	test('through lane edits', async ({ page }, testInfo) => {
		const g = await held(page);
		await g.click(p(-20, 0));
		await expect(page.locator('aside')).toBeVisible();
		const rows = page.locator('aside').getByRole('listitem');
		// The far lane widened to 4 m, then the near lane copied: the near
		// carriageway two lanes wide.
		const width = rows.nth(3).locator('input[type="number"]');
		await width.fill('4');
		await width.press('Tab');
		await expect
			.poll(async () => (await liveGraph(page)).segments.find(isCar)!.lanes[3].width)
			.toBe(4);
		await linesHeld(page, 0);
		const before = await snapshot(page);
		await rows.nth(1).getByTitle('Copy lane').click();
		await expect
			.poll(async () => (await liveGraph(page)).segments.find(isCar)!.lanes.length)
			.toBe(6);
		await page.keyboard.press('Escape');
		const lanes = (await liveGraph(page)).segments.find(isCar)!.lanes;
		const near = lanes.slice(1, 3).map((l) => l.id);
		expect(lanes.map((l) => l.role)).toEqual([
			'pedestrian',
			'vehicle',
			'vehicle',
			'pedestrian',
			'vehicle',
			'pedestrian'
		]);
		await throughHistory(
			page,
			before,
			async () => {
				await expect.poll(() => lines(page, 0)).toEqual(['stop far', `stop ${[...near].sort()}`]);
				expect(await storedControls(page)).toEqual([
					{ roads: ['r'], lanes: ['far'], control: 'signal' },
					{ roads: ['r'], lanes: near, control: 'stop' }
				]);
				expect(check(await drawingOf(page))).toEqual([]);
			},
			() => linesHeld(page, 0)
		);
		await shot(page, testInfo.outputPath('lanes-edited.png'));
	});
});

test.describe('a control stays on its carriageway', () => {
	// A lane each way either side of a 4 m walkway, drawn from west to east:
	// the north carriageway (y -5.5 to -2) and the south one (2 to 5.5).
	const divided = [
		sidewalk('left'),
		lane('back', 'vehicle', 3.5, 'backward'),
		lane('middle', 'pedestrian', 4),
		lane('forward', 'vehicle', 3.5, 'forward'),
		sidewalk('right')
	];
	// Another divided street's lanes: the same carriageways, its south lane
	// 4 m wide, its lanes named the other way round, so the id the north lane
	// had names the south one.
	const pasted = [
		sidewalk('s-left'),
		lane('forward', 'vehicle', 3.5, 'backward'),
		lane('s-middle', 'pedestrian', 4),
		lane('back', 'vehicle', 4, 'forward'),
		sidewalk('s-right')
	];

	test('through lanes pasted, the street drawn west to east', async ({ page }, testInfo) => {
		// Footpaths straight across the street at x -22 and x 22, saved
		// holding Stop north and Signal south, and the other way round.
		const entry = (lanes: string[], control: string) => ({ roads: ['street'], lanes, control });
		const walk = (id: string, x: number, controls: unknown[]) => ({
			id,
			startNodeId: `${id}-n`,
			endNodeId: `${id}-s`,
			lanes: path,
			controls: controls as CrossingControl[]
		});
		await openAt(
			page,
			{
				nodes: [
					{ id: 'a', x: -40, y: 0 },
					{ id: 'b', x: 40, y: 0 },
					{ id: 'c', x: -60, y: -34 },
					{ id: 'd', x: -20, y: -34 },
					{ id: 'w1-n', x: -22, y: -20 },
					{ id: 'w1-s', x: -22, y: 24 },
					{ id: 'w2-n', x: 22, y: -20 },
					{ id: 'w2-s', x: 22, y: 24 }
				],
				segments: [
					{ id: 'street', startNodeId: 'a', endNodeId: 'b', lanes: divided },
					{ id: 'source', startNodeId: 'c', endNodeId: 'd', lanes: pasted },
					walk('w1', -22, [entry(['back'], 'stop'), entry(['forward'], 'signal')]),
					walk('w2', 22, [entry(['back'], 'signal'), entry(['forward'], 'stop')])
				]
			},
			ZOOM
		);
		const g = on(page);
		await g.click(p(-40, -34));
		await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['source']);
		await page.keyboard.press('ControlOrMeta+c');
		await page.keyboard.press('Escape');
		await g.click(p(0, 0));
		await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['street']);
		await page.keyboard.press('ControlOrMeta+v');
		await expect
			.poll(async () =>
				(await liveGraph(page)).segments.find((s) => s.id === 'street')!.lanes.map((l) => l.width)
			)
			.toEqual([2, 3.5, 4, 4, 2]);
		await page.keyboard.press('Escape');
		// Each by place: the north carriageway's control on the north lane
		// pasted (`forward` now), the south one's on the south lane (`back`).
		for (const x of [-22, 22])
			await expect.poll(() => lines(page, x)).toEqual(['stop back', 'stop forward']);
		expect(await storedControls(page)).toEqual([
			entry(['back'], 'signal'),
			entry(['forward'], 'stop'),
			entry(['back'], 'stop'),
			entry(['forward'], 'signal')
		]);
		expect(check(await drawingOf(page))).toEqual([]);
		await shot(page, testInfo.outputPath('pasted.png'));
	});
});

test('double-clicking a zebra opens its badge alone, which steps it as an approach badge does', async ({
	page
}, testInfo) => {
	// A street along x and a footpath straight across it: a crossing, and
	// nothing cut.
	await openAt(page, crossed(twoWay, 'straight', undefined, 30), ZOOM);
	const g = on(page);
	const zebra = p(0.3, -1.75);
	const near = async () => linesNear(await drawingOf(page), zebra);
	expect(await near()).toEqual(['yield', 'yield']);
	expect(await storedControls(page)).toEqual([]);
	// Opened alone: its badge the one shown, nothing selected.
	await g.dblclick(zebra);
	await expect.poll(async () => (await editorLook(page)).crossing?.control).toBe('yield');
	const look = await editorLook(page);
	expect(look.crossings).toEqual([look.crossing]);
	await expect(crossingButtons(page)).toHaveCount(1);
	await shot(page, testInfo.outputPath('badge-open.png'));
	// Signal, none, stop and back to give-way, each painted on both
	// approaches behind the crossing and stored on the footpath alone.
	for (const [control, drawn] of [
		['signal', ['stop', 'stop']],
		['none', []],
		['stop', ['stop', 'stop']],
		['yield', ['yield', 'yield']]
	] as const) {
		await crossingButtons(page).click();
		await expect.poll(async () => (await editorLook(page)).crossing?.control).toBe(control);
		expect(await near()).toEqual(drawn);
		expect(await storedControls(page)).toEqual(
			control === 'yield' ? [] : [{ roads: ['r'], lanes: ['back', 'forward'], control }]
		);
	}
	// Nothing but the footpath stores it: no node, no cut, the street as drawn.
	const graph = await liveGraph(page);
	expect(graph.segments).toHaveLength(2);
	expect(graph.nodes).toHaveLength(4);
	expect(graph.nodes.every((n) => !n.junction)).toBe(true);
	await page.keyboard.press('Escape');
	await expect.poll(async () => (await editorLook(page)).crossings).toEqual([]);
	expect((await editorLook(page)).crossing).toBeNull();
});

test('an old entry is read, selected and saved as it was; only an edit writes it again', async ({
	page
}) => {
	// A street of a lane each way with a walkway down its middle, crossed
	// straight at x 0, storing last round's shape: no lane ids, so the
	// stop holds both carriageways.
	const divided = [
		sidewalk('left'),
		lane('back', 'vehicle', 3.5, 'backward'),
		lane('middle', 'pedestrian', 4),
		lane('forward', 'vehicle', 3.5, 'forward'),
		sidewalk('right')
	];
	const old = [{ roads: ['r'], at: 0.5, control: 'stop' }];
	await openAt(page, crossed(divided, 'straight', old), ZOOM);
	const g = on(page);
	const untouched = async () => {
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expect(undoButton(page)).toBeDisabled();
		expect(await storedControls(page)).toEqual(old);
		expect((await storedGraph(page)).segments.find((s) => s.id === 'w')!.controls).toEqual(old);
	};

	// Loaded.
	await expect.poll(() => lines(page, 0)).toEqual(['stop back', 'stop forward']);
	await untouched();
	// Selected, by a click on it.
	await g.click(p(0, -12));
	await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['w']);
	await untouched();
	await page.keyboard.press('Escape');
	// Its crossing's badge opened and closed.
	expect(await g.badgeAt(p(0.3, -3.75))).toBe('stop');
	await untouched();
	// Saved with nothing changed.
	await page.keyboard.press('ControlOrMeta+s');
	await untouched();
	// Read the same again.
	await page.reload();
	await expect(page.getByTestId('city-name')).toHaveText('test');
	await expect.poll(() => lines(page, 0)).toEqual(['stop back', 'stop forward']);
	await untouched();

	// An edit: the forward carriageway stepped on from stop to signal, two
	// clicks of its badge, the first writing each carriageway's control on
	// its own.
	await g.setControl(p(0.3, 3.75), 'signal');
	await expect(unsavedMarker(page)).toHaveCount(1);
	await expect(undoButton(page)).toBeEnabled();
	expect(await storedControls(page)).toEqual([
		{ roads: ['r'], lanes: ['back'], control: 'stop' },
		{ roads: ['r'], lanes: ['forward'], control: 'signal' }
	]);
	expect(await lines(page, 0)).toEqual(['stop back', 'stop forward']);
	expect(await g.badgeAt(p(0.3, -3.75))).toBe('stop');
	// Undone, the old entry as it was, nothing unsaved.
	for (let k = 0; k < 2; k++) await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(async () => storedControls(page)).toEqual(old);
	await untouched();
});
