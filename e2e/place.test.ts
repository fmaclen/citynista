import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';
const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

const LANES = [
	{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
	{ type: 'road', width: 3, direction: 'backward' },
	{ type: 'road', width: 3, direction: 'forward' },
	{ type: 'sidewalk', width: 2, direction: 'bidirectional' }
];

const GRAPH_DATA = {
	nodes: [
		{ id: 'node-0', x: -100, y: 0 },
		{ id: 'node-1', x: 0, y: 0 }
	],
	segments: [{ id: 'segment-0', startNodeId: 'node-0', endNodeId: 'node-1', lanes: LANES }]
};

interface SavedGraph {
	nodes: { id: string; x: number; y: number }[];
	segments: { id: string; startNodeId: string; endNodeId: string }[];
}

const savedGraph = (page: import('@playwright/test').Page) =>
	page.evaluate((key) => {
		const data = localStorage.getItem(key);
		return data ? (JSON.parse(data) as SavedGraph) : null;
	}, STORAGE_KEY);

async function copySegment(page: import('@playwright/test').Page) {
	await page.locator('canvas').click({ position: toScreen(-50, 0) });
	await expect(page.locator('aside')).toBeVisible();
	await page.keyboard.press('Meta+c');
	await page.keyboard.press('Escape');
	await expect(page.locator('aside')).not.toBeVisible();
}

test.describe('Paste placement', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await expect(page.locator('canvas')).toBeVisible();
		await page.evaluate(({ key, data }) => localStorage.setItem(key, JSON.stringify(data)), {
			key: STORAGE_KEY,
			data: GRAPH_DATA
		});
		await page.reload();
		await expect(page.locator('nav')).toBeVisible();
	});

	test('an endpoint dropped on an existing node attaches instead of duplicating', async ({
		page
	}) => {
		await copySegment(page);

		// Drop so the clone's start endpoint lands on node-1 (its centroid (-50,0)
		// goes to the cursor at (50,0), shifting the clone by +100 in x).
		await page.keyboard.press('Meta+v');
		const drop = toScreen(50, 0);
		await page.mouse.move(drop.x, drop.y);
		await page.mouse.click(drop.x, drop.y);

		// node-1 was reused, so only one new node (the far end) appears: 3, not 4.
		await expect.poll(async () => (await savedGraph(page))?.nodes.length).toBe(3);

		const graph = (await savedGraph(page))!;
		expect(graph.segments.length).toBe(2);
		const clone = graph.segments.find((segment) => segment.id !== 'segment-0')!;
		expect([clone.startNodeId, clone.endNodeId]).toContain('node-1');
	});

	test('pasting onto the just-copied segment makes a floating copy', async ({ page }) => {
		// Copy segment-0 and leave it selected, then paste without deselecting:
		// this should place a floating copy, not do a no-op lane paste onto itself.
		await page.locator('canvas').click({ position: toScreen(-50, 0) });
		await expect(page.locator('aside')).toBeVisible();
		await page.keyboard.press('Meta+c');

		await page.keyboard.press('Meta+v');
		const drop = toScreen(0, 80);
		await page.mouse.move(drop.x, drop.y);
		await page.mouse.click(drop.x, drop.y);

		await expect.poll(async () => (await savedGraph(page))?.segments.length).toBe(2);
	});

	test('Escape cancels placement without creating anything', async ({ page }) => {
		await copySegment(page);

		await page.keyboard.press('Meta+v');
		const hover = toScreen(50, 60);
		await page.mouse.move(hover.x, hover.y);
		await page.keyboard.press('Escape');

		// A short settle, then assert nothing was added.
		await expect(page.locator('nav')).toBeVisible();
		const graph = (await savedGraph(page))!;
		expect(graph.segments.length).toBe(1);
		expect(graph.nodes.length).toBe(2);
	});
});
