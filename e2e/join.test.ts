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

// node-1 passes through two same-section halves of one straight road.
const PASS_THROUGH = {
	nodes: [
		{ id: 'node-0', x: -100, y: 0 },
		{ id: 'node-1', x: 0, y: 0 },
		{ id: 'node-2', x: 100, y: 0 }
	],
	segments: [
		{ id: 'segment-0', startNodeId: 'node-0', endNodeId: 'node-1', lanes: LANES },
		{ id: 'segment-1', startNodeId: 'node-1', endNodeId: 'node-2', lanes: LANES }
	]
};

// A four-arm junction at the origin — never joinable.
const JUNCTION = {
	nodes: [
		{ id: 'node-0', x: 0, y: 0 },
		{ id: 'node-1', x: -100, y: 0 },
		{ id: 'node-2', x: 100, y: 0 },
		{ id: 'node-3', x: 0, y: -100 },
		{ id: 'node-4', x: 0, y: 100 }
	],
	segments: [
		{ id: 'segment-0', startNodeId: 'node-1', endNodeId: 'node-0', lanes: LANES },
		{ id: 'segment-1', startNodeId: 'node-0', endNodeId: 'node-2', lanes: LANES },
		{ id: 'segment-2', startNodeId: 'node-3', endNodeId: 'node-0', lanes: LANES },
		{ id: 'segment-3', startNodeId: 'node-0', endNodeId: 'node-4', lanes: LANES }
	]
};

interface SavedGraph {
	nodes: { id: string }[];
	segments: { id: string; lanes: unknown[] }[];
}

const savedGraph = (page: import('@playwright/test').Page) =>
	page.evaluate((key) => {
		const data = localStorage.getItem(key);
		return data ? (JSON.parse(data) as SavedGraph) : null;
	}, STORAGE_KEY);

async function seed(page: import('@playwright/test').Page, data: unknown) {
	await page.goto('/?topdown');
	await expect(page.locator('canvas')).toBeVisible();
	await page.evaluate(({ key, data }) => localStorage.setItem(key, JSON.stringify(data)), {
		key: STORAGE_KEY,
		data
	});
	await page.reload();
	await expect(page.locator('nav')).toBeVisible();
}

const joinButton = (page: import('@playwright/test').Page) =>
	page.getByTitle('Join — dissolve this node back into one road');

test.describe('Join', () => {
	test('appears for a pass-through node and merges the two halves', async ({ page }) => {
		await seed(page, PASS_THROUGH);

		await page.locator('canvas').click({ position: toScreen(0, 0) });
		await expect(joinButton(page)).toBeVisible();

		await joinButton(page).click();

		await expect.poll(async () => (await savedGraph(page))?.nodes.length).toBe(2);
		const graph = (await savedGraph(page))!;
		expect(graph.segments.length).toBe(1);
		expect(graph.segments[0].lanes.length).toBe(4);
	});

	test('does not appear for a junction with three or more arms', async ({ page }) => {
		await seed(page, JUNCTION);

		await page.locator('canvas').click({ position: toScreen(0, 0) });
		await expect(joinButton(page)).not.toBeVisible();
	});
});
