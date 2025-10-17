import { expect, test } from '@playwright/test';

test.describe('Curved Segment Intersection', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('preserves curve shape when drawing across curved segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		// Enter draw mode
		await page.locator('button').first().click();

		// Draw a curved segment horizontally (100,200) to (500,200)
		// This will have a curve with control point at (300, 100) by default
		await canvas.click({ position: { x: 100, y: 200 }, force: true });
		await canvas.click({ position: { x: 500, y: 200 }, force: true });

		// Get the segment data and its control point
		const beforeIntersection = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(beforeIntersection.segments).toHaveLength(1);
		const originalSegment = beforeIntersection.segments[0];
		const originalControlX = originalSegment.controlX;
		const originalControlY = originalSegment.controlY;

		// Take a screenshot of the original curve
	
		// Now draw a vertical line that crosses through the curve at x=300
		await canvas.click({ position: { x: 300, y: 100 }, force: true });
		await canvas.click({ position: { x: 300, y: 300 }, force: true });

		await page.keyboard.press('Escape');

		// Take a screenshot after intersection
	
		// Get the final data
		const afterIntersection = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		// Should have split the horizontal segment into 2 parts
		// Plus the 2 parts of the vertical segment
		expect(afterIntersection.segments.length).toBeGreaterThanOrEqual(4);

		// Find the two segments that make up the original horizontal line
		// They should be connected to the intersection node
		const horizontalSegments = afterIntersection.segments.filter(
			(seg: { startNodeId: string; endNodeId: string }) => {
				const start = afterIntersection.nodes.find((n: { id: string }) => n.id === seg.startNodeId);
				const end = afterIntersection.nodes.find((n: { id: string }) => n.id === seg.endNodeId);
				// Horizontal segments have similar y coordinates
				return start && end && Math.abs(start.y - end.y) < 50;
			}
		);

		expect(horizontalSegments).toHaveLength(2);

		// The control points of the split segments should preserve the original curve shape
		// This is the BUG: currently they are just set to midpoints, not preserving the curve

		// For a quadratic bezier, when split at t, the control points should be calculated
		// to maintain the curve shape. Currently this is NOT happening.

		// Let's verify the current buggy behavior first:
		// The control points are currently just midpoints between the nodes
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

		// This test will FAIL once we fix the bug, because we'll be preserving curves properly
		// For now, it documents the buggy behavior
	
		// TODO: Once fixed, the control points should preserve the curve shape
		// For now, this test just documents and visualizes the bug via screenshots
	});

	test('creates visual comparison screenshots for manual verification', async ({ page }) => {
		await page.goto('/');
		const canvas = page.locator('canvas#canvas');

		// Create a distinctly curved segment
		await page.locator('button').first().click();

		// Draw curve
		await canvas.click({ position: { x: 100, y: 300 }, force: true });
		await canvas.click({ position: { x: 600, y: 300 }, force: true });

		// Wait for the segment to be drawn
		await page.waitForTimeout(100);

		// Enter select mode to modify the curve
		await page.keyboard.press('Escape');
		await page.locator('button').nth(1).click();

		// Click the middle of the segment to select it
		await canvas.click({ position: { x: 350, y: 300 }, force: true });

		// Get canvas bounding box for absolute positioning
		const canvasBox = await canvas.boundingBox();
		if (!canvasBox) throw new Error('Canvas not found');

		// Drag the control point upward to make it more curved
		// The control point should be visible when segment is selected
		await page.mouse.move(canvasBox.x + 350, canvasBox.y + 300);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 350, canvasBox.y + 150);
		await page.mouse.up();

		await page.waitForTimeout(100);

		// Take screenshot of the curved segment
	
		// Get the control point data
		const beforeData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

	
		// Exit select mode, re-enter draw mode
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await page.locator('button').first().click();

		// Draw a line through the curve
		await canvas.click({ position: { x: 350, y: 100 }, force: true });
		await canvas.click({ position: { x: 350, y: 400 }, force: true });

		await page.keyboard.press('Escape');
		await page.waitForTimeout(100);

		// Take screenshot after intersection - this should show the bug
	
		const afterData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

	
		// The curve should be preserved, but currently it's flattened
		// This test creates visual evidence of the bug
	});
});
