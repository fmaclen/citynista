import { expect, test } from '@playwright/test';

test.describe('Editor', () => {
	test.beforeEach(async ({ page }) => {
		// Clear localStorage before each test
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('page loads with canvas', async ({ page }) => {
		await page.goto('/');
		const canvas = page.locator('canvas#canvas');
		await expect(canvas).toBeVisible();
	});

	test('toolbar buttons are visible', async ({ page }) => {
		await page.goto('/');

		// Check for draw, select, and clear buttons
		const toolbar = page.locator('nav');
		await expect(toolbar).toBeVisible();

		// Should have 3 buttons
		const buttons = toolbar.locator('button');
		await expect(buttons).toHaveCount(3);
	});

	test('can enter and exit draw mode', async ({ page }) => {
		await page.goto('/');

		// Click draw button
		const drawButton = page.locator('button').first();
		await drawButton.click();

		// Button should have 'default' variant (active state)
		await expect(drawButton).toHaveClass(/bg-primary/);

		// Press Escape to exit draw mode
		await page.keyboard.press('Escape');

		// Button should no longer be active
		await expect(drawButton).not.toHaveClass(/bg-primary/);
	});

	test('can draw a segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		// Enter draw mode
		await page.locator('button').first().click();

		// Draw a line by clicking two points on the canvas
		// Use force: true to bypass Fabric.js upper-canvas overlay
		await canvas.click({
			position: { x: 100, y: 100 },
			force: true
		});

		await canvas.click({
			position: { x: 200, y: 200 },
			force: true
		});

		// Check that data was saved to localStorage
		const savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData).not.toBeNull();
		expect(savedData.nodes).toHaveLength(2);
		expect(savedData.segments).toHaveLength(1);
	});

	test('can select and move a segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		// First, draw a segment
		await page.locator('button').first().click(); // Enter draw mode
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await page.keyboard.press('Escape'); // Exit draw mode

		// Enter select mode
		await page.locator('button').nth(1).click();

		// Click on the segment to select it
		await canvas.click({ position: { x: 150, y: 150 }, force: true });

		// Get canvas bounding box to calculate absolute positions
		const canvasBox = await canvas.boundingBox();
		if (!canvasBox) throw new Error('Canvas not found');

		// Drag the segment by dragging from one node to a new position
		await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150);
		await page.mouse.up();

		// Wait for save to complete
		await page.waitForTimeout(200);

		// Check that nodes moved
		const finalData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		const finalNode1 = finalData.nodes[0];

		// Nodes should have moved (they moved 50px in both x and y)
		expect(finalNode1.x).toBeCloseTo(150, 0);
		expect(finalNode1.y).toBeCloseTo(150, 0);
	});

	test('can delete a segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		// Draw a segment
		await page.locator('button').first().click(); // Enter draw mode
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await page.keyboard.press('Escape'); // Exit draw mode

		// Enter select mode
		await page.locator('button').nth(1).click();

		// Click on the segment to select it
		await canvas.click({ position: { x: 150, y: 150 }, force: true });

		// Delete the segment
		await page.keyboard.press('Delete');

		// Wait for save
		await page.waitForTimeout(100);

		// Check that segment and nodes were deleted
		const savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes).toHaveLength(0);
		expect(savedData.segments).toHaveLength(0);
	});

	test('can clear all', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		// Draw multiple segments
		await page.locator('button').first().click(); // Enter draw mode
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await canvas.click({ position: { x: 300, y: 100 }, force: true });
		await page.keyboard.press('Escape'); // Exit draw mode

		// Verify data exists
		let savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes.length).toBeGreaterThan(0);
		expect(savedData.segments.length).toBeGreaterThan(0);

		// Click clear all button
		await page.locator('button').nth(2).click();

		// Wait for save
		await page.waitForTimeout(100);

		// Verify everything is cleared
		savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes).toHaveLength(0);
		expect(savedData.segments).toHaveLength(0);
	});

	test('data persists across page reloads', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		// Draw a segment
		await page.locator('button').first().click(); // Enter draw mode
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });

		// Wait for save
		await page.waitForTimeout(100);

		// Get saved data
		const savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		// Reload page
		await page.reload();

		// Check data persisted
		const loadedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(loadedData).toEqual(savedData);
		expect(loadedData.nodes).toHaveLength(2);
		expect(loadedData.segments).toHaveLength(1);
	});

	test('escape key clears selection in select mode', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');
		const selectButton = page.locator('button').nth(1);

		// Draw a segment
		await page.locator('button').first().click(); // Enter draw mode
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await page.keyboard.press('Escape'); // Exit draw mode

		const canvasBox = await canvas.boundingBox();
		if (!canvasBox) throw new Error('Canvas not found');

		// Enter select mode and select segment
		await selectButton.click();
		await canvas.click({ position: { x: 150, y: 150 }, force: true });

		// Drag the node to verify we're in select mode
		await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120);
		await page.mouse.up();

		// Verify node moved
		let data = await page.evaluate(() => {
			const d = localStorage.getItem('citynista-graph');
			return d ? JSON.parse(d) : null;
		});
		expect(data.nodes[0].x).toBeCloseTo(120, 0);

		// Press Escape to clear selection
		await page.keyboard.press('Escape');

		// Press Escape again to exit mode
		await page.keyboard.press('Escape');

		// Select button should no longer be active
		await expect(selectButton).not.toHaveClass(/bg-primary/);

		// BUG TEST: After exiting select mode, should NOT be able to move nodes
		await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 140, canvasBox.y + 140);
		await page.mouse.up();

		// Verify node did NOT move
		data = await page.evaluate(() => {
			const d = localStorage.getItem('citynista-graph');
			return d ? JSON.parse(d) : null;
		});
		expect(data.nodes[0].x).toBeCloseTo(120, 0);
		expect(data.nodes[0].y).toBeCloseTo(120, 0);

		// BUG TEST: Re-entering select mode should work
		await selectButton.click();
		await expect(selectButton).toHaveClass(/bg-primary/);

		// Should be able to move nodes again
		await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 160, canvasBox.y + 160);
		await page.mouse.up();

		// Verify node moved
		data = await page.evaluate(() => {
			const d = localStorage.getItem('citynista-graph');
			return d ? JSON.parse(d) : null;
		});
		expect(data.nodes[0].x).toBeCloseTo(160, 0);
		expect(data.nodes[0].y).toBeCloseTo(160, 0);
	});
});
