import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import {
	button,
	editorLook,
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	nextFrame,
	nodeOf,
	openAt,
	openScene,
	p,
	redoButton,
	saveCity,
	screenAt,
	segmentOf,
	storedGraph,
	undoButton,
	unsavedMarker,
	type Pt
} from './app';

// One rule holds every press in every mode that takes a release: any command
// given while one is in hand (Save, Undo, Redo, Delete, Cut, Copy, Paste, a
// tool switched) settles it first (Editor.settlePress), so none meets a
// gesture half done. A press moved past CLICK_SLOP_PX is given its release
// where the pointer last was (refused and put back, joined, or kept as one
// undo step); one that has not is taken back as Escape takes it, since a
// command is no click. A move with the button up arriving is the release
// that never came. Escape takes a press back: the graph as the newest undo
// step left it, the mode set up again holding nothing and the selection the
// press found. Another button let go while the left is held ends nothing.
// What Save writes is the newest undo step, so a draw's start with nothing
// laid from it is no part of the saved city.

// What follows the drag's last move in its task: a key pressed on the page,
// the left button let go there, or the pointer gone out of the window and
// back to `hover` with no button held (a release that never arrived).
type Then = { key: string; ctrl?: boolean; shift?: boolean } | { release: true } | { hover: Pt };

// Moves the held pointer on to `to` and, in the same task, does `then`:
// before the frame that move queued is drawn, so whatever settles the drag
// must read that last move first.
const inOneTask = (page: Page, view: (q: Pt) => Pt, to: Pt, then: Then) =>
	page.evaluate(
		({ p, then, back }) => {
			const canvas = document.querySelector('canvas')!;
			const mouse = (type: string, init: MouseEventInit) =>
				canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
			mouse('mousemove', { buttons: 1, clientX: p.x, clientY: p.y });
			if ('release' in then) mouse('mouseup', { button: 0, clientX: p.x, clientY: p.y });
			else if ('hover' in then) {
				mouse('mouseleave', { buttons: 1, clientX: -10, clientY: 350 });
				window.dispatchEvent(new Event('blur'));
				mouse('mousemove', { buttons: 0, clientX: back!.x, clientY: back!.y });
			} else {
				const { key, ctrl, shift } = then;
				document.body.dispatchEvent(
					new KeyboardEvent('keydown', { key, ctrlKey: !!ctrl, shiftKey: !!shift, bubbles: true })
				);
			}
		},
		{ p: view(to), then, back: 'hover' in then ? view(then.hover) : null }
	);

// One street, `main`, along y = 0.
const street = () =>
	graphOf(
		[
			['a', -60, 0],
			['b', 60, 0]
		],
		[['main', 'a', 'b']]
	);

// `moving`, pressed at (0, 25), lies across `bar` held at (0, 0) and clear
// of it held at (0, 17) or above.
const crossing = () =>
	graphOf(
		[
			['a', -65, 0],
			['b', 65, 0],
			['c', -40, 15],
			['d', 40, 35]
		],
		[
			['bar', 'a', 'b'],
			['moving', 'c', 'd']
		]
	);

const streetButton = (page: Page) => page.getByRole('button', { name: 'Street', exact: true });

test.describe('select', () => {
	const ZOOM = 2;
	const setup = async (page: Page, graph: GraphData, zoom = ZOOM) => {
		await openAt(page, graph, zoom);
		const at = gestures(page, zoom);
		return {
			...at,
			inTask: (to: Pt, then: Then) => inOneTask(page, at.view, to, then),
			before: await liveGraph(page),
			saved: await storedGraph(page)
		};
	};

	test('Save during a refused move saves the city as it was, and the move stays refused', async ({
		page
	}) => {
		const { hold, inTask, before } = await setup(page, crossing());
		expect((await hold(p(0, 25), p(0, 20))).refused).toEqual([]);
		await inTask(p(0, 0), { key: 's', ctrl: true });
		expect(await liveGraph(page)).toEqual(before);
		expect(await storedGraph(page)).toEqual(before);
		expect((await editorLook(page)).refused).toEqual([]);
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
	});

	test('Delete during a refused move deletes with the move put back', async ({ page }) => {
		const graph = graphOf(
			[
				['a', -65, 0],
				['b', 65, 0],
				['j', -25, 10],
				['k', 35, 10],
				['f', -45, 22]
			],
			[
				['bar', 'a', 'b'],
				['main', 'j', 'k'],
				['arm', 'f', 'j']
			]
		);
		const { click, hold, inTask, before, saved } = await setup(page, graph);
		// `main` selected first, so the press keeps it selected.
		await click(p(10, 10));
		expect((await hold(p(10, 10), p(10, 5))).refused).toEqual([]);
		await inTask(p(10, -8), { key: 'Delete' });
		const deleted = await liveGraph(page);
		expect(deleted.segments.map((s) => s.id)).toEqual(['bar', 'arm']);
		expect(nodeOf(deleted, 'j')).toEqual(nodeOf(before, 'j'));
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(deleted);
		await expect(undoButton(page)).toBeEnabled();
		await expect(unsavedMarker(page)).toHaveCount(1);
		await expectFreshDrawing(page);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
		expect(await storedGraph(page)).toEqual(saved);
	});

	test('Escape cancels a drag over a drop marker: nothing joins, nothing moves, nothing is saved', async ({
		page
	}) => {
		// `own`'s end dragged to (28, 0) snaps to `j` at (20, 0), short of `third`.
		const graph = graphOf(
			[
				['a', -55, 0],
				['tip', -24, 14],
				['j', 20, 0],
				['t', 20, -40],
				['b', 20, 40],
				['u', 25, -25],
				['v', 25, 25]
			],
			[
				['own', 'a', 'tip', 'path'],
				['north', 't', 'j', 'path'],
				['south', 'j', 'b', 'path'],
				['third', 'u', 'v', 'path']
			]
		);
		const { hold, inTask, before, saved } = await setup(page, graph, 1);
		expect((await hold(p(-24, 14), p(28, 0))).drop).toEqual({ x: 20, y: 0 });
		await inTask(p(27, 1), { key: 'Escape' });
		expect(await liveGraph(page)).toEqual(before);
		const look = await editorLook(page);
		expect(look.drop).toBeNull();
		expect(look.selection).toEqual({ nodes: [], segments: [] });
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
		expect(await storedGraph(page)).toEqual(saved);
	});

	test('Escape cancels a drag of a road: it goes back, still selected as the press left it', async ({
		page
	}) => {
		const { click, hold, inTask, before, saved } = await setup(page, street());
		await click(p(20, 0));
		await hold(p(20, 0), p(20, 10));
		expect(nodeOf(await liveGraph(page), 'a').y).toBeGreaterThan(9);
		await inTask(p(20, 12), { key: 'Escape' });
		expect(await liveGraph(page)).toEqual(before);
		expect((await editorLook(page)).selection).toEqual({ nodes: [], segments: ['main'] });
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
		expect(await storedGraph(page)).toEqual(saved);
	});

	test('a drag let go outside the window ends at the first move back with no button held', async ({
		page
	}) => {
		const { hold, inTask, before, saved } = await setup(page, crossing());
		expect((await hold(p(0, 25), p(0, 0))).refused).toEqual(['moving']);
		await inTask(p(0, 30), { hover: p(0, 45) });
		await nextFrame(page);
		const kept = await liveGraph(page);
		expect(nodeOf(kept, 'c').y).toBeCloseTo(20, 0);
		await expect(undoButton(page)).toBeEnabled();
		await expect(unsavedMarker(page)).toHaveCount(1);
		await expectFreshDrawing(page);
		expect(await storedGraph(page)).toEqual(saved);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
		await page.mouse.up();
	});

	for (const which of ['right', 'middle'] as const)
		test(`the ${which} button let go during a drag ends nothing`, async ({ page }) => {
			const { hold, inTask, before, saved } = await setup(page, crossing());
			expect((await hold(p(0, 25), p(0, 0))).refused).toEqual(['moving']);
			await page.mouse.down({ button: which });
			await page.mouse.up({ button: which });
			await nextFrame(page);
			await expect(undoButton(page)).toBeDisabled();
			await expect(unsavedMarker(page)).toHaveCount(0);
			await inTask(p(0, 30), { release: true });
			const after = await liveGraph(page);
			expect(nodeOf(after, 'c').y).toBeCloseTo(20, 0);
			await expect(undoButton(page)).toBeEnabled();
			await expect(unsavedMarker(page)).toHaveCount(1);
			await page.mouse.up();
			await expectFreshDrawing(page);
			expect(await storedGraph(page)).toEqual(saved);
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => liveGraph(page)).toEqual(before);
		});

	test('Undo during a drag keeps the move as a step and takes it back', async ({ page }) => {
		const { hold, inTask, before, saved } = await setup(page, crossing());
		await hold(p(0, 25), p(0, 30));
		await page.mouse.up();
		const first = await liveGraph(page);
		expect(nodeOf(first, 'c').y).toBeCloseTo(20, 0);
		// Pressed off its middle, where the selected road shows its curve's handle.
		expect((await hold(p(10, 32.5), p(10, 7.5))).refused).toEqual(['moving']);
		await inTask(p(10, 37.5), { key: 'z', ctrl: true });
		expect(await liveGraph(page)).toEqual(first);
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(first);
		await expect(undoButton(page)).toBeEnabled();
		await expect(redoButton(page)).toBeEnabled();
		await expect(unsavedMarker(page)).toHaveCount(1);
		await expectFreshDrawing(page);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(async () => nodeOf(await liveGraph(page), 'c').y).toBeCloseTo(25, 0);
		expect(await storedGraph(page)).toEqual(saved);
		await page.keyboard.press('ControlOrMeta+z');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
	});

	test('Redo during a drag keeps the move as the newest step, so nothing is redone', async ({
		page
	}) => {
		const { hold, inTask, before, saved } = await setup(page, crossing());
		await hold(p(0, 25), p(0, 30));
		await page.mouse.up();
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
		await expect(redoButton(page)).toBeEnabled();
		expect((await hold(p(0, 25), p(0, 0))).refused).toEqual(['moving']);
		await inTask(p(0, 17), { key: 'z', ctrl: true, shift: true });
		const moved = await liveGraph(page);
		expect(nodeOf(moved, 'c').y).toBeCloseTo(7, 0);
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(moved);
		await expect(redoButton(page)).toBeDisabled();
		await expect(undoButton(page)).toBeEnabled();
		await expect(unsavedMarker(page)).toHaveCount(1);
		await expectFreshDrawing(page);
		expect(await storedGraph(page)).toEqual(saved);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
	});

	test('a tool switched mid-drag puts a refused move back and keeps a clean one', async ({
		page
	}) => {
		const { hold, inTask, before, saved } = await setup(page, crossing());
		expect((await hold(p(0, 25), p(0, 20))).refused).toEqual([]);
		await inTask(p(0, 0), { key: '1' });
		await expect(streetButton(page)).toHaveAttribute('aria-pressed', 'true');
		expect(await liveGraph(page)).toEqual(before);
		expect((await editorLook(page)).refused).toEqual([]);
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
		expect(await storedGraph(page)).toEqual(saved);
		// Back in select, a clean move ended by a tool switch is kept, one
		// undo step.
		await page.keyboard.press('Escape');
		expect((await hold(p(0, 25), p(0, 30))).refused).toEqual([]);
		await page.keyboard.press('1');
		await page.mouse.up();
		expect(nodeOf(await liveGraph(page), 'c').y).toBeCloseTo(20, 0);
		await expect(undoButton(page)).toBeEnabled();
		await expect(unsavedMarker(page)).toHaveCount(1);
		await expectFreshDrawing(page);
		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
	});
});

test.describe('draw', () => {
	for (const [start, brush, y] of [
		['on open ground', 'Street', 45],
		['on a sidewalk', 'Path', 4.5]
	] as const)
		test(`Save with a draw started ${start} saves the city without the start`, async ({ page }) => {
			await openAt(page, street(), 2);
			const { click, move } = gestures(page, 2);
			const before = await liveGraph(page);
			await button(page, brush);
			await click(p(0, y));
			await move(p(15, 42), 4);
			expect((await liveGraph(page)).nodes).toHaveLength(3);
			await saveCity(page);
			expect(await storedGraph(page)).toEqual(before);
			// Undo is offered where it would take something back: a start on a
			// sidewalk is one, a start on open ground is not.
			if (brush === 'Path') await expect(undoButton(page)).toBeEnabled();
			else await expect(undoButton(page)).toBeDisabled();
			await page.keyboard.press('Escape');
			expect(await liveGraph(page)).toEqual(before);
			await expect(unsavedMarker(page)).toHaveCount(0);
			await expect(undoButton(page)).toBeDisabled();
			await expectFreshDrawing(page);
		});

	test("Escape after a draw's first click cut a road keeps the redo that stood before it", async ({
		page
	}) => {
		const graph = graphOf(
			[
				['a', -65, 0],
				['b', 65, 0]
			],
			[['main', 'a', 'b']]
		);
		await openAt(page, graph, 3);
		const { hold, click } = gestures(page, 3);
		const before = await liveGraph(page);
		await hold(p(10, 0), p(10, 10));
		await page.mouse.up();
		const moved = await liveGraph(page);
		expect(nodeOf(moved, 'a').y).toBeGreaterThan(8);
		await page.keyboard.press('ControlOrMeta+z');
		await expect(redoButton(page)).toBeEnabled();
		await button(page, 'Street');
		await click(p(0, 0));
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(2);
		await page.keyboard.press('Escape');
		await expect.poll(() => liveGraph(page)).toEqual(before);
		await expect(redoButton(page)).toBeEnabled();
		await expect(undoButton(page)).toBeDisabled();
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(() => liveGraph(page)).toEqual(moved);
	});
});

test.describe('connector', () => {
	type Junction = GraphData['nodes'][number]['junction'];
	const junction = async (page: Page) => nodeOf(await liveGraph(page), 'j').junction;
	const storedJunction = async (page: Page) =>
		nodeOf(await storedGraph(page, 'handles'), 'j').junction;
	const east = (j: Junction) => j?.crossings?.find((c) => c.road === 'je')?.at;
	const connectorOpen = async (page: Page) => (await editorLook(page)).connector?.node;
	// Opens the connector on `j` of the handles scene. The junction as it was.
	const connector = async (page: Page) => {
		await openScene(page, 'handles', 'topdown&model&cam=0,0,4');
		const before = await junction(page);
		await gestures(page, 4).dblclick(p(70, -30));
		await expect(page.getByRole('button', { name: /^Approach control/ })).toHaveCount(3);
		return before;
	};
	// Slides the crossing on `je` 6 m on from `x`, held there.
	const slide = async (page: Page, x: number) => {
		await gestures(page, 4).hold(p(x, -30), p(x + 6, -30));
		expect(east(await junction(page))).toBeCloseTo(x + 6 - 70, 0);
	};

	test('Save, then Delete, mid-slide keep it as a step', async ({ page }) => {
		const before = await connector(page);
		await slide(page, 80.5);
		await saveCity(page);
		const slid = await junction(page);
		expect(east(slid)).toBeCloseTo(16.5, 0);
		expect(await storedJunction(page)).toEqual(slid);
		await expect(undoButton(page)).toBeEnabled();
		await page.mouse.up();
		expect(await junction(page)).toEqual(slid);
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => junction(page)).toEqual(before);
		await expect(unsavedMarker(page)).toHaveCount(1);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(() => junction(page)).toEqual(slid);
		await expect(unsavedMarker(page)).toHaveCount(0);
		// Slid on again, Delete keeps that slide as a step too, the connector
		// open and the handle out of hand.
		await slide(page, 86.5);
		await page.keyboard.press('Delete');
		const again = await junction(page);
		expect(east(again)).toBeCloseTo(22.5, 0);
		await expect(undoButton(page)).toBeEnabled();
		await expect(unsavedMarker(page)).toHaveCount(1);
		await gestures(page, 4).move(p(96, -30));
		await page.mouse.up();
		expect(await junction(page)).toEqual(again);
		expect(await connectorOpen(page)).toBe('j');
		await expectFreshDrawing(page);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => junction(page)).toEqual(slid);
		await expect(unsavedMarker(page)).toHaveCount(0);
	});

	test('Save with the handle pressed and not moved saves it as it was', async ({ page }) => {
		const before = await connector(page);
		await gestures(page, 4).move(p(80.5, -30), 4);
		await page.mouse.down();
		await saveCity(page);
		expect(await junction(page)).toEqual(before);
		expect(await storedJunction(page)).toEqual(before);
		await page.mouse.up();
		expect(await junction(page)).toEqual(before);
		expect(await connectorOpen(page)).toBe('j');
		await expect(undoButton(page)).toBeDisabled();
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
	});

	// Open ground south of `je`: a click there leaves the connector.
	for (const [press, to] of [
		['not moved', p(90, -12)],
		['moved', p(96, -10)]
	] as const)
		test(`a tool switched with open ground pressed and ${press} arms the tool`, async ({
			page
		}) => {
			const before = await connector(page);
			const graph = await liveGraph(page);
			await gestures(page, 4).hold(p(90, -12), to);
			await page.keyboard.press('1');
			await expect(streetButton(page)).toHaveAttribute('aria-pressed', 'true');
			expect(await connectorOpen(page)).toBeUndefined();
			await page.mouse.up();
			await expect(streetButton(page)).toHaveAttribute('aria-pressed', 'true');
			expect(await liveGraph(page)).toEqual(graph);
			expect(await junction(page)).toEqual(before);
			await expect(undoButton(page)).toBeDisabled();
			await expect(unsavedMarker(page)).toHaveCount(0);
			await expectFreshDrawing(page);
		});

	test('Escape takes the slide back and the connector stays open', async ({ page }) => {
		const before = await connector(page);
		await slide(page, 80.5);
		await page.keyboard.press('Escape');
		expect(await junction(page)).toEqual(before);
		expect(await connectorOpen(page)).toBe('j');
		await gestures(page, 4).move(p(90, -30), 4);
		await page.mouse.up();
		expect(await junction(page)).toEqual(before);
		expect(await connectorOpen(page)).toBe('j');
		await expect(undoButton(page)).toBeDisabled();
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
	});

	test('a press on empty ground in the connector closes it when let go, dragged or not', async ({
		page
	}) => {
		const graph = graphOf(
			[
				['a', -65, 0],
				['j', 0, 0],
				['b', 65, 0],
				['k', 0, 55]
			],
			[
				['west', 'a', 'j'],
				['east', 'j', 'b'],
				['south', 'j', 'k']
			]
		);
		await openAt(page, graph, 3);
		const { dblclick, hold } = gestures(page, 3);
		for (const to of [p(25, 25), p(37, 31)]) {
			await dblclick(p(0, 0));
			await expect.poll(() => connectorOpen(page)).toBe('j');
			await hold(p(25, 25), to);
			await page.mouse.up();
			await expect.poll(async () => (await editorLook(page)).connector).toBeNull();
		}
		await expect(undoButton(page)).toBeDisabled();
	});
});

test.describe('marquee', () => {
	// `main` selected, then a marquee pressed on open ground drawn round it.
	const marquee = async (page: Page) => {
		await openAt(page, street(), 2);
		const { click, hold } = gestures(page, 2);
		const before = await liveGraph(page);
		await click(p(13, 0));
		expect((await editorLook(page)).selection).toEqual({ nodes: [], segments: ['main'] });
		await hold(p(-67, -10), p(68, 12));
		return before;
	};

	test('Escape takes it back with the selection the press found', async ({ page }) => {
		const before = await marquee(page);
		await page.keyboard.press('Escape');
		expect((await editorLook(page)).selection).toEqual({ nodes: [], segments: ['main'] });
		await page.mouse.up();
		expect((await editorLook(page)).selection).toEqual({ nodes: [], segments: ['main'] });
		expect(await liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expect(unsavedMarker(page)).toHaveCount(0);
		await expectFreshDrawing(page);
	});

	test('Delete deletes what it holds', async ({ page }) => {
		const before = await marquee(page);
		await page.keyboard.press('Delete');
		expect(await liveGraph(page)).toEqual({ nodes: [], segments: [] });
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual({ nodes: [], segments: [] });
		await expect(undoButton(page)).toBeEnabled();
		await expect(unsavedMarker(page)).toHaveCount(1);
		await expectFreshDrawing(page);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
	});
});

// Cut, Copy and Paste during a drag each settle it first, each on the
// city opened afresh.
test.describe('clipboard during a drag', () => {
	const ZOOM = 2;
	// `moving` selected and pressed off its middle, dragged 5 m down, clear
	// of `bar`.
	const dragMoving = async (page: Page) => {
		const { click, hold } = gestures(page, ZOOM);
		await click(p(0, 25));
		await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['moving']);
		expect((await hold(p(10, 27.5), p(10, 32.5))).refused).toEqual([]);
	};

	test('Cut settles it first: the move kept as a step, then the selection cut', async ({
		page
	}) => {
		await openAt(page, crossing(), ZOOM);
		const before = await liveGraph(page);
		await dragMoving(page);
		await page.keyboard.press('ControlOrMeta+x');
		const cut = await liveGraph(page);
		expect(cut.segments.map((s) => s.id)).toEqual(['bar']);
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(cut);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(async () => nodeOf(await liveGraph(page), 'c').y).toBeCloseTo(20, 0);
		expect((await liveGraph(page)).segments.map((s) => s.id)).toEqual(['bar', 'moving']);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
	});

	// The road copied where the move left it: its curve's handle, pressed at
	// its middle, dragged 10 m on, so a paste lays it bent.
	test('Copy settles it first: the move kept as a step, the road copied as it left it', async ({
		page
	}) => {
		const { click, hold, move } = gestures(page, ZOOM);
		await openAt(page, crossing(), ZOOM);
		await click(p(0, 25));
		await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['moving']);
		expect((await hold(p(0, 25), p(0, 35))).handle?.ref.kind).toBe('curve');
		await page.keyboard.press('ControlOrMeta+c');
		const bent = await liveGraph(page);
		const moving = segmentOf(bent, 'moving');
		expect(moving.controlX).toBeDefined();
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(bent);
		await expect(undoButton(page)).toBeEnabled();
		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+v');
		await move(p(0, -40), 4);
		await page.mouse.click(screenAt(ZOOM)(0, -40).x, screenAt(ZOOM)(0, -40).y);
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(3);
		const pasted = (await liveGraph(page)).segments.at(-1)!;
		const bend = (graph: GraphData, s: GraphData['segments'][number]) => {
			const a = nodeOf(graph, s.startNodeId);
			return [s.controlX! - a.x, s.controlY! - a.y];
		};
		const [dx, dy] = bend(await liveGraph(page), pasted);
		const [mx, my] = bend(bent, moving);
		expect([dx, dy]).toEqual([expect.closeTo(mx, 1), expect.closeTo(my, 1)]);
	});

	// Pasted with only the roads copied selected, it lays a copy; with others
	// selected it would paste lanes onto them (clipboard.ts, paste).
	test('Paste settles it first: the move kept as a step, then the copy armed to lay', async ({
		page
	}) => {
		const { click, move } = gestures(page, ZOOM);
		const ghost = () =>
			page.evaluate(
				() =>
					(window as unknown as { __ghostGraph: () => GraphData | undefined }).__ghostGraph()
						?.segments.length ?? 0
			);
		await openAt(page, crossing(), ZOOM);
		const original = await liveGraph(page);
		await click(p(0, 25));
		await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['moving']);
		await page.keyboard.press('ControlOrMeta+c');
		await dragMoving(page);
		await page.keyboard.press('ControlOrMeta+v');
		const kept = await liveGraph(page);
		expect(nodeOf(kept, 'c').y).toBeCloseTo(20, 0);
		await expect(undoButton(page)).toBeEnabled();
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(kept);
		await move(p(0, -40), 4);
		await expect.poll(ghost).toBe(1);
		await page.keyboard.press('Escape');
		await expect.poll(ghost).toBe(0);
		expect(await liveGraph(page)).toEqual(kept);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(original);
	});
});

test.describe('bulldoze', () => {
	test('a bulldoze press settles under a command', async ({ page }) => {
		await openAt(page, crossing(), 2);
		const { move, hold } = gestures(page, 2);
		const before = await liveGraph(page);
		const bulldoze = page.locator('nav').getByTitle(/^Bulldoze/);
		await bulldoze.click();
		await expect(bulldoze).toHaveAttribute('aria-pressed', 'true');

		// Pressed on open ground and not moved, Save takes the press back:
		// nothing demolished, and the tool stays Bulldoze.
		await move(p(-45, 10));
		await page.mouse.down();
		await saveCity(page);
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(before);
		expect(await storedGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expect(bulldoze).toHaveAttribute('aria-pressed', 'true');

		// A red marquee drawn round `moving` and Save: let go there, it
		// demolishes what it holds as one undo step, and that is saved.
		await hold(p(-45, 10), p(45, 40));
		await saveCity(page);
		const demolished = await liveGraph(page);
		expect(demolished.segments.map((s) => s.id)).toEqual(['bar']);
		expect(await storedGraph(page)).toEqual(demolished);
		await page.mouse.up();
		expect(await liveGraph(page)).toEqual(demolished);
		await expect(bulldoze).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
	});
});
