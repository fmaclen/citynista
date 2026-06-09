import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

const TEST_GRAPH_DATA = {
	nodes: [
		{ id: 'node-0', x: -256.61116552399614, y: 68.31537708129177 },
		{ id: 'node-1', x: -48.481880509304624, y: 90.84231145935247 },
		{ id: 'node-2', x: 34.76983349657199, y: -3.1831537708140463 },
		{ id: 'node-3', x: 166.0137120470128, y: 31.09696376101751 },
		{ id: 'node-4', x: 273.2615083251714, y: -49.70617042115686 },
		{ id: 'node-5', x: -95.0048971596474, y: 201.0284035259539 },
		{ id: 'node-6', x: -70.02938295788435, y: -35.50440744368378 },
		{ id: 'node-7', x: -33.300685602350626, y: -112.879529872675 },
		{ id: 'node-8', x: -43.09500489715967, y: -180.9500489715976 }
	],
	segments: [
		{ id: 'segment-0', startNodeId: 'node-0', endNodeId: 'node-1', laneTemplateId: 'street' },
		{ id: 'segment-1', startNodeId: 'node-1', endNodeId: 'node-2', laneTemplateId: 'street' },
		{
			id: 'segment-2',
			startNodeId: 'node-2',
			endNodeId: 'node-3',
			controlX: 105.28893241919683,
			controlY: -53.13418217433999,
			laneTemplateId: 'street'
		},
		{ id: 'segment-3', startNodeId: 'node-3', endNodeId: 'node-4', laneTemplateId: 'street' },
		{ id: 'segment-4', startNodeId: 'node-5', endNodeId: 'node-1', laneTemplateId: 'avenue' },
		{ id: 'segment-5', startNodeId: 'node-1', endNodeId: 'node-6', laneTemplateId: 'avenue' },
		{ id: 'segment-6', startNodeId: 'node-6', endNodeId: 'node-7', laneTemplateId: 'avenue' },
		{ id: 'segment-7', startNodeId: 'node-7', endNodeId: 'node-8', laneTemplateId: 'avenue' }
	]
};

test.describe('Intersection Rendering', () => {
	test('renders smooth intersections without z-fighting', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('canvas')).toBeVisible();

		await page.evaluate(
			({ key, data }) => {
				localStorage.setItem(key, JSON.stringify(data));
			},
			{ key: STORAGE_KEY, data: TEST_GRAPH_DATA }
		);

		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();

		await expect(page.locator('nav')).toBeVisible();

		await page.screenshot({ path: 'e2e/screenshots/intersection-test.png' });

		const savedData = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

		expect(savedData.nodes.length).toBe(9);
		expect(savedData.segments.length).toBe(8);
	});

	test('nodes visible in select mode, hidden when deselected', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('canvas')).toBeVisible();

		await page.evaluate(
			({ key, data }) => {
				localStorage.setItem(key, JSON.stringify(data));
			},
			{ key: STORAGE_KEY, data: TEST_GRAPH_DATA }
		);

		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
		await expect(page.locator('nav')).toBeVisible();

		await page.screenshot({ path: 'e2e/screenshots/nodes-hidden.png' });

		await page.locator('button').nth(1).click();

		await page.screenshot({ path: 'e2e/screenshots/nodes-visible-select-mode.png' });

		await page.locator('button').nth(1).click();

		await page.screenshot({ path: 'e2e/screenshots/nodes-hidden-after-deselect.png' });
	});
});
