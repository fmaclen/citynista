import { test, expect, type Page } from '@playwright/test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { openGraph, openScene, liveGraph, roadModel, screenAt } from './app';
import { nodeOf } from '../unit/model';

// The lane connector is a per-junction mode entered by double-clicking a
// junction. Dragging from an incoming lane dot to an outgoing lane dot toggles
// that movement, persisted on the node as a hand edit (`junction.added` or
// `junction.removed`, depending on whether the movement is a default). Dot
// screen positions are for the connectors-demo scene's 4-way at zoom 18 (world
// origin = viewport centre).
const editCount = async (page: Page) => {
	const junction = nodeOf(await liveGraph(page), 'c').junction;
	return (junction?.added?.length ?? 0) + (junction?.removed?.length ?? 0);
};

async function openConnectorsDemo(page: Page) {
	await openScene(page, 'connectors-demo');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
}

// The handles scene at 4x: T junction j at (70, -30), its east arm `je` with
// a crossing on, its west arm `jw` with one switched off, each handle 10.5 m
// out along its arm.
const at = screenAt(4);
const junctionOf = async (page: Page) => nodeOf(await liveGraph(page), 'j').junction;

async function openHandlesConnector(page: Page) {
	await openScene(page, 'handles', 'topdown&model&cam=0,0,4');
	const junction = at(70, -30);
	await page.mouse.dblclick(junction.x, junction.y);
	await expect(page.getByRole('button', { name: /^Approach control/ })).toHaveCount(3);
}

// An avenue along y = 0 at 6x, cut at the origin once open, so undo can take
// the cut's node away again. With the connector open on that node, the inner
// eastbound lane (3 m right of the line) is joined to the outer one beyond
// (6.5 m right): a lane's width across, which needs a taper 21 m long. The
// lane dots sit 5 m either side of the node.
const at6 = screenAt(6);
const AVENUE = {
	nodes: [
		{ id: 'w', x: -60, y: 0 },
		{ id: 'e', x: 60, y: 0 }
	],
	segments: [{ id: 'avenue', startNodeId: 'w', endNodeId: 'e', lanes: createLanesFrom('avenue') }]
};

async function shiftLaneAtCut(page: Page) {
	await openGraph(page, AVENUE, 'topdown&model&cam=0,0,6');
	const cut = at6(0, 0);
	await page.getByTitle(/^Split/).click();
	await page.mouse.click(cut.x, cut.y);
	await expect.poll(async () => (await liveGraph(page)).nodes.length).toBe(3);
	await page.keyboard.press('Escape');
	await page.mouse.dblclick(cut.x, cut.y);
	const from = at6(-5, 3);
	const to = at6(5, 6.5);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	await expect.poll(() => addedAtCut(page)).toBe(1);
}

const addedAtCut = async (page: Page) =>
	(await liveGraph(page)).nodes.find((n) => n.id !== 'w' && n.id !== 'e')?.junction?.added?.length;

// How far apart the two roads' ends at the cut are drawn.
const gapAtCut = async (page: Page) => {
	const xs = (await roadModel(page))!.roads
		.flatMap((r) => [r.points[0].x, r.points[r.points.length - 1].x])
		.sort((a, b) => a - b);
	return xs[2] - xs[1];
};

test.describe('Lane connector', () => {
	test('the taper held while it is open follows its connections once undo takes its node away', async ({
		page
	}) => {
		await shiftLaneAtCut(page);
		// Open, the roads stay where they were: just short of the node.
		expect(await gapAtCut(page)).toBeCloseTo(1.2, 3);
		// Undo the connection, then the cut: its node goes, and the connector
		// with it. Redo brings both back with the connector closed.
		await page.keyboard.press('ControlOrMeta+z');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(async () => (await liveGraph(page)).nodes.length).toBe(2);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(() => addedAtCut(page)).toBe(1);
		expect(await gapAtCut(page)).toBeCloseTo(21, 3);
	});

	test('picking another tool while it is open lets its taper go', async ({ page }) => {
		await shiftLaneAtCut(page);
		await page.getByTitle(/^Split/).click();
		await expect.poll(() => gapAtCut(page)).toBeCloseTo(21, 3);
	});

	test('double-click opens it; dragging a movement toggles it on and off', async ({ page }) => {
		await openConnectorsDemo(page);

		const drag = async () => {
			// North incoming dot (filled) -> East outgoing dot (ring).
			await page.mouse.move(620, 322);
			await page.mouse.down();
			await page.mouse.move(649, 350, { steps: 5 });
			await page.mouse.move(678, 379, { steps: 5 });
			await page.mouse.up();
		};

		await drag();
		await expect.poll(() => editCount(page)).toBe(1);

		// Dragging the same movement again undoes the edit.
		await drag();
		await expect.poll(() => editCount(page)).toBe(0);
	});

	test('is modal: clicking a road is ignored until Escape returns to select', async ({ page }) => {
		await openConnectorsDemo(page);

		// Clicking the road next to the junction does nothing — no selection,
		// still in connector mode (the lane panel never opens).
		await page.mouse.click(640, 250);
		await expect(page.locator('aside')).not.toBeVisible();

		// Escape returns to select mode, where that road selects normally.
		await page.keyboard.press('Escape');
		await page.mouse.click(640, 250);
		await expect(page.locator('aside')).toBeVisible();
	});

	test('one click on a crossing handle switches it; another switches it back', async ({ page }) => {
		await openHandlesConnector(page);
		const westOn = async () =>
			(await junctionOf(page))?.crossings?.find((c) => c.road === 'jw')?.on;
		const handle = at(59.5, -30.2);
		await page.mouse.click(handle.x, handle.y);
		await expect.poll(westOn).toBe(true);
		await page.mouse.click(handle.x, handle.y);
		await expect.poll(westOn).toBe(false);
	});

	test('dragging a crossing handle slides the crossing along its road', async ({ page }) => {
		await openHandlesConnector(page);
		const east = async () => (await junctionOf(page))?.crossings?.find((c) => c.road === 'je');
		const from = at(80.5, -30);
		const to = at(86.5, -30);
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x, to.y, { steps: 8 });
		await page.mouse.up();
		// 6 m further from the junction, and still on.
		await expect.poll(async () => (await east())?.at).toBeCloseTo(16.5, 0);
		expect((await east())?.on).toBe(true);
	});

	test('clicking an approach badge cycles none, stop, yield, signal', async ({ page }) => {
		await openHandlesConnector(page);
		const order = ['none', 'stop', 'yield', 'signal'] as const;
		const titles = ['No control: traffic goes on', 'Stop sign', 'Yield', 'Traffic signals'];
		const badge = page.getByRole('button', { name: /^Approach control/ }).first();
		const label = (await badge.getAttribute('aria-label'))!;
		const first = titles.findIndex((t) => label.endsWith(t));
		expect(first).toBeGreaterThanOrEqual(0);

		// Four clicks step the one approach round the whole cycle and back.
		for (let i = 1; i <= 4; i++) {
			const next = (first + i) % 4;
			await badge.click();
			await expect(badge).toHaveAccessibleName(`Approach control: ${titles[next]}`);
			expect(Object.values((await junctionOf(page))?.control ?? {})).toEqual([order[next]]);
		}
	});
});
