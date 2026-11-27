import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { storedControls as stored } from './crossing';
import {
	editorLook,
	expectFreshDrawing,
	graphOf,
	type Kind,
	lane,
	openGraph,
	type Pt,
	screenAt,
	shot,
	sidewalk,
	undoButton
} from './app';

// A crossing's control badge shows on every crossing a selected road is part
// of or lies across, so a zebra's control is found without knowing to
// double-click it (Editor.crossingBadges, Networks.crossingsOn). Clicking one
// steps its crossing as the double-clicked badge does (a badge opened alone
// by a double-click on its zebra: crossing-controls.test.ts). Each case
// leaves a screenshot.

test.afterEach(({ page }) => expectFreshDrawing(page));

const ZOOM = 6;
const view = screenAt(ZOOM);
const at = (p: Pt) => view(p.x, p.y);
const click = (page: Page, p: Pt) => page.mouse.click(at(p).x, at(p).y);

// A divided street `r` along y = 0 from x -35 to 35 (sidewalk, the near lane
// at y -5.5 to -2, a 4 m walkway, the far lane at 2 to 5.5, sidewalk), and a
// footpath `w` straight across it at x 0: two crossings, one per
// carriageway.
async function open(page: Page) {
	const graph: GraphData = {
		nodes: [
			{ id: 'a', x: -35, y: 0 },
			{ id: 'b', x: 35, y: 0 },
			{ id: 'p', x: 0, y: -20 },
			{ id: 'q', x: 0, y: 24 }
		],
		segments: [
			{
				id: 'r',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: [
					sidewalk('left'),
					lane('near', 'vehicle', 3.5, 'forward'),
					lane('middle', 'pedestrian', 4),
					lane('far', 'vehicle', 3.5, 'forward'),
					sidewalk('right')
				]
			},
			{ id: 'w', startNodeId: 'p', endNodeId: 'q', lanes: [sidewalk('path')] }
		]
	};
	await openGraph(page, graph, `topdown&model&cam=0,0,${ZOOM}`);
}

const FOOTPATH = { x: 0, y: -12 };
const STREET = { x: -20, y: -3.75 };

// The crossing buttons shown, near carriageway first, and the buttons on the
// page.
const shown = async (page: Page) =>
	[...(await editorLook(page)).crossings].sort((a, b) => a.y - b.y);
const buttons = (page: Page) => page.getByRole('button', { name: /^Crossing control/ });

test('selecting a footpath or its street shows a button on each crossing once; deselecting clears them', async ({
	page
}, testInfo) => {
	await open(page);
	await expect.poll(async () => (await editorLook(page)).crossings).toEqual([]);
	// The footpath: one button per carriageway it crosses.
	await click(page, FOOTPATH);
	await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['w']);
	await expect.poll(async () => (await shown(page)).length).toBe(2);
	const [near, far] = await shown(page);
	expect([near.control, far.control]).toEqual(['yield', 'yield']);
	expect(near.y).toBeLessThan(0);
	expect(far.y).toBeGreaterThan(0);
	await expect(buttons(page)).toHaveCount(2);
	await shot(page, testInfo.outputPath('footpath-selected.png'));
	const ids = (await shown(page)).map((b) => b.id);
	// The street: the same buttons.
	await click(page, STREET);
	await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['r']);
	await expect.poll(async () => (await shown(page)).map((b) => b.id)).toEqual(ids);
	await expect(buttons(page)).toHaveCount(2);
	// Both selected: each crossing once.
	await page.keyboard.down('Shift');
	await click(page, FOOTPATH);
	await page.keyboard.up('Shift');
	await expect
		.poll(async () => [...(await editorLook(page)).selection.segments].sort())
		.toEqual(['r', 'w']);
	expect((await shown(page)).map((b) => b.id)).toEqual(ids);
	await expect(buttons(page)).toHaveCount(2);
	await shot(page, testInfo.outputPath('both-selected.png'));
	// Escape: none.
	await page.keyboard.press('Escape');
	await expect.poll(async () => (await editorLook(page)).crossings).toEqual([]);
	await expect(buttons(page)).toHaveCount(0);
	// The street again, then a click on open ground: none.
	await click(page, STREET);
	await expect.poll(async () => (await shown(page)).length).toBe(2);
	await click(page, { x: -20, y: 16 });
	await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual([]);
	await expect.poll(async () => (await editorLook(page)).crossings).toEqual([]);
	await expect(buttons(page)).toHaveCount(0);
});

test('a button steps its crossing alone, keeping the selection, and undo takes a click back', async ({
	page
}, testInfo) => {
	await open(page);
	await click(page, FOOTPATH);
	await expect.poll(async () => (await shown(page)).length).toBe(2);
	const [near, far] = await shown(page);
	const nearButton = page.locator(`[data-crossing="${near.id}"]`);
	await nearButton.click();
	await expect
		.poll(async () => (await shown(page)).map((b) => b.control))
		.toEqual(['signal', 'yield']);
	expect((await editorLook(page)).selection.segments).toEqual(['w']);
	expect((await shown(page)).map((b) => b.id)).toEqual([near.id, far.id]);
	// The next click steps the same crossing on.
	await nearButton.click();
	await expect
		.poll(async () => (await shown(page)).map((b) => b.control))
		.toEqual(['none', 'yield']);
	expect(await stored(page)).toEqual([{ roads: ['r'], lanes: ['near'], control: 'none' }]);
	await shot(page, testInfo.outputPath('stepped.png'));
	// One click, one undo step.
	await page.keyboard.press('ControlOrMeta+z');
	await expect
		.poll(() => stored(page))
		.toEqual([{ roads: ['r'], lanes: ['near'], control: 'signal' }]);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => stored(page)).toEqual([]);
});

test("a double-click on a selected road's crossing button steps it twice, the selection kept", async ({
	page
}) => {
	await open(page);
	await click(page, STREET);
	await expect.poll(async () => (await shown(page)).length).toBe(2);
	const [near, far] = await shown(page);
	await page.locator(`[data-crossing="${near.id}"]`).dblclick();
	await expect
		.poll(async () => (await shown(page)).map((b) => b.control))
		.toEqual(['none', 'yield']);
	expect((await shown(page)).map((b) => b.id)).toEqual([near.id, far.id]);
	expect((await editorLook(page)).crossing).toBeNull();
	expect((await editorLook(page)).selection.segments).toEqual(['r']);
	expect(await stored(page)).toEqual([{ roads: ['r'], lanes: ['near'], control: 'none' }]);
});

test('a double-click on a zebra, its first click selecting the road, opens the badge and steps nothing', async ({
	page
}) => {
	await open(page);
	// At a hand's pace: the first click has put the button under the pointer
	// by the time the second lands.
	const middle = at({ x: 0, y: -3.75 });
	await page.mouse.click(middle.x, middle.y);
	await expect(buttons(page)).toHaveCount(2);
	await page.mouse.down({ clickCount: 2 });
	await page.mouse.up({ clickCount: 2 });
	await expect.poll(async () => (await editorLook(page)).crossing?.control).toBe('yield');
	expect((await editorLook(page)).crossings).toHaveLength(1);
	expect(await stored(page)).toEqual([]);
	await expect(undoButton(page)).toBeDisabled();
});

// A street of `kind` along y = 0 from x -100 to 100, and three paths across
// it: two 3 m apart either side of x 0, a third at x 40.
const closeTogether = (kind: Kind) =>
	graphOf(
		[
			['w', -100, 0],
			['e', 100, 0],
			['a', -1.5, -30],
			['b', -1.5, 30],
			['c', 1.5, -30],
			['d', 1.5, 30],
			['f', 40, -30],
			['g', 40, 30]
		],
		[
			['r', 'w', 'e', kind],
			['p0', 'a', 'b', 'path'],
			['p1', 'c', 'd', 'path'],
			['p2', 'f', 'g', 'path']
		]
	);

// Crossing buttons keep one size on screen whatever the zoom, so they are
// laid out on screen (components/badge-layout.ts): no two shown overlap, and
// each stands on its crossing's middle or is tied to it by a line. Swept over
// Streets, Avenues and One-way lanes crossed by paths close together,
// zoomed out, at zoom 1 and zoomed in (a test for each), from the street.
for (const kind of ['street', 'avenue', 'lane'] as const)
	for (const zoom of [0.5, 1, 6])
		test(`the buttons of crossings close together on a ${kind} stand apart at zoom ${zoom}, each tied to its crossing`, async ({
			page
		}, testInfo) => {
			await openGraph(page, closeTogether(kind), `topdown&model&cam=0,0,${zoom}`);
			const view = screenAt(zoom);
			// The street, clicked clear of the paths at this zoom.
			{
				const at = view(zoom < 1 ? -60 : -15, 0);
				await page.mouse.click(at.x, at.y);
				await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['r']);
				await expect.poll(async () => (await editorLook(page)).crossings.length).toBeGreaterThan(2);
				await expect(buttons(page)).toHaveCount((await editorLook(page)).crossings.length);
				const look = (await editorLook(page)).crossings;
				// Each button's box, and where its crossing's middle shows.
				const shown = await Promise.all(
					look.map(async (c) => {
						const box = (await page.locator(`[data-crossing="${c.id}"]`).boundingBox())!;
						const tie = page.locator(`[data-tie="${c.id}"]`);
						return {
							id: c.id,
							box,
							middle: view(c.x, c.y),
							tie: (await tie.count())
								? await tie.evaluate((l) =>
										['x1', 'y1', 'x2', 'y2'].map((k) => Number(l.getAttribute(k)))
									)
								: null
						};
					})
				);
				const label = `${kind} at zoom ${zoom}`;
				for (const [i, a] of shown.entries())
					for (const b of shown.slice(i + 1))
						expect(
							a.box.x + a.box.width <= b.box.x ||
								b.box.x + b.box.width <= a.box.x ||
								a.box.y + a.box.height <= b.box.y ||
								b.box.y + b.box.height <= a.box.y,
							`${label}: ${a.id} and ${b.id} overlap`
						).toBe(true);
				for (const b of shown) {
					const centre = { x: b.box.x + b.box.width / 2, y: b.box.y + b.box.height / 2 };
					const off = Math.hypot(centre.x - b.middle.x, centre.y - b.middle.y);
					if (off <= 3) continue;
					expect(b.tie, `${label}: ${b.id} stands apart untied`).not.toBeNull();
					const [x1, y1, x2, y2] = b.tie!;
					expect(Math.hypot(x1 - b.middle.x, y1 - b.middle.y), label).toBeLessThan(1.5);
					expect(Math.hypot(x2 - centre.x, y2 - centre.y), label).toBeLessThan(1.5);
				}
				if (zoom === 1) await shot(page, testInfo.outputPath(`${kind}-zoom-1.png`));
			}
		});
