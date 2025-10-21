import { expect, test } from '@playwright/test';

test.describe('Intersections', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('drawing across segment creates intersection node', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();

		await canvas.click({ position: { x: 100, y: 150 }, force: true });
		await canvas.click({ position: { x: 300, y: 150 }, force: true });

		await page.waitForTimeout(100);

		let savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes).toHaveLength(2);
		expect(savedData.segments).toHaveLength(1);

		await canvas.click({ position: { x: 200, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });

		await page.waitForTimeout(100);

		await page.keyboard.press('Escape');

		savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes).toHaveLength(5);
		expect(savedData.segments).toHaveLength(5);

		const intersectionNode = savedData.nodes.find(
			(node: { x: number; y: number }) => Math.abs(node.x - 200) < 1 && Math.abs(node.y - 150) < 1
		);
		expect(intersectionNode).toBeDefined();

		expect(intersectionNode.connectedSegments).toHaveLength(4);
	});

	test('preserves curve shape when drawing across curved segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();

		await canvas.click({ position: { x: 100, y: 200 }, force: true });
		await canvas.click({ position: { x: 500, y: 200 }, force: true });

		const beforeIntersection = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(beforeIntersection.segments).toHaveLength(1);

		await canvas.click({ position: { x: 300, y: 100 }, force: true });
		await canvas.click({ position: { x: 300, y: 300 }, force: true });

		await page.keyboard.press('Escape');

		const afterIntersection = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(afterIntersection.segments.length).toBeGreaterThanOrEqual(4);

		const horizontalSegments = afterIntersection.segments.filter(
			(seg: { startNodeId: string; endNodeId: string }) => {
				const start = afterIntersection.nodes.find((n: { id: string }) => n.id === seg.startNodeId);
				const end = afterIntersection.nodes.find((n: { id: string }) => n.id === seg.endNodeId);
				return start && end && Math.abs(start.y - end.y) < 50;
			}
		);

		expect(horizontalSegments).toHaveLength(2);

		const leftSegment = horizontalSegments.find((seg: { startNodeId: string }) => {
			const start = afterIntersection.nodes.find((n: { id: string }) => n.id === seg.startNodeId);
			return start && start.x < 200;
		});

		const rightSegment = horizontalSegments.find((seg: { endNodeId: string }) => {
			const end = afterIntersection.nodes.find((n: { id: string }) => n.id === seg.endNodeId);
			return end && end.x > 400;
		});

		expect(leftSegment).toBeDefined();
		expect(rightSegment).toBeDefined();
	});

	test('preserves curve shape with manual control point adjustment', async ({ page }) => {
		await page.goto('/');
		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();

		await canvas.click({ position: { x: 100, y: 300 }, force: true });
		await canvas.click({ position: { x: 600, y: 300 }, force: true });

		await page.waitForTimeout(100);

		await page.keyboard.press('Escape');
		await page.locator('button').nth(1).click();

		await canvas.click({ position: { x: 350, y: 300 }, force: true });

		const canvasBox = await canvas.boundingBox();
		if (!canvasBox) throw new Error('Canvas not found');

		await page.mouse.move(canvasBox.x + 350, canvasBox.y + 300);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 350, canvasBox.y + 150);
		await page.mouse.up();

		await page.waitForTimeout(100);

		const beforeData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await page.locator('button').first().click();

		await canvas.click({ position: { x: 350, y: 100 }, force: true });
		await canvas.click({ position: { x: 350, y: 400 }, force: true });

		await page.keyboard.press('Escape');
		await page.waitForTimeout(100);

		const afterData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(beforeData).toBeDefined();
		expect(afterData).toBeDefined();
		expect(afterData.segments.length).toBeGreaterThan(beforeData.segments.length);
	});
});
