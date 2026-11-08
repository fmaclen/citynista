import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openScene } from './scenes';

// A loaded scene lands in the current city of the localStorage city library.
const CURRENT_KEY = 'citynista:current-city';

const EXAMPLE = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8'));
const EXAMPLE_SEGMENTS: number = EXAMPLE.graph.segments.length;

// World -> screen at the default top-down camera.
const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });
// A stub of the neighbourhood's top street, west of its first junction.
const TOP_STREET_STUB = toScreen(-240, -180);

const storedCity = (page: Page, id: string) =>
	page.evaluate((id) => {
		const raw = localStorage.getItem(`citynista:city:${id}`);
		return raw ? JSON.parse(raw) : null;
	}, id);

async function bulldozeStub(page: Page) {
	await page.mouse.click(TOP_STREET_STUB.x, TOP_STREET_STUB.y);
}

test.describe('Cities', () => {
	test('booting into a stored city loads its graph', async ({ page }) => {
		await openScene(page, 'median-corner');
		await expect(page.locator('canvas')).toBeVisible();

		await page.waitForFunction(
			(key) => {
				const id = localStorage.getItem(key);
				if (!id) return false;
				const raw = localStorage.getItem('citynista:city:' + id);
				if (!raw) return false;
				const graph = JSON.parse(raw).graph;
				return graph?.nodes?.length === 3 && graph?.segments?.length === 2;
			},
			CURRENT_KEY,
			{ timeout: 5000 }
		);

		const graph = await page.evaluate((key) => {
			const id = localStorage.getItem(key)!;
			return JSON.parse(localStorage.getItem('citynista:city:' + id)!).graph;
		}, CURRENT_KEY);
		const corner = graph.nodes.find((node: { id: string }) => node.id === 'node-1');
		expect(corner).toEqual({ id: 'node-1', x: 0, y: 0 });
		expect(graph.segments[0].lanes.length).toBeGreaterThan(0);
	});

	test('an example opens untouched; Save makes a city of your own from it', async ({ page }) => {
		const cities = page.getByRole('toolbar', { name: 'Cities' });
		const saveAs = page.getByRole('dialog');
		await page.goto('/?example=neighbourhood&topdown');
		await expect(cities.getByText('Neighbourhood', { exact: true })).toBeVisible();

		// Opening it, and editing it, store nothing.
		await page.getByTitle('Bulldoze (click or drag to demolish)').click();
		await bulldozeStub(page);
		await expect(cities.getByLabel('Unsaved changes')).toBeVisible();
		expect(await storedCity(page, 'neighbourhood')).toBeNull();

		// Save asks for a name, prefilled with the example's.
		await page.keyboard.press('ControlOrMeta+s');
		await expect(saveAs.getByRole('textbox')).toHaveValue('Neighbourhood');
		await saveAs.getByRole('button', { name: 'Save' }).click();
		await expect(cities.getByLabel('Unsaved changes')).toHaveCount(0);
		expect((await storedCity(page, 'neighbourhood')).graph.segments.length).toBe(
			EXAMPLE_SEGMENTS - 1
		);
		expect(await page.evaluate((key) => localStorage.getItem(key), CURRENT_KEY)).toBe(
			'neighbourhood'
		);
		await expect(cities.getByText('neighbourhood', { exact: true })).toBeVisible();

		// Reopening the example starts from the original again: the same edit
		// saves a second city with one segment fewer than the example, not two.
		await cities.locator('[data-slot="select-trigger"]').click();
		await page.getByRole('option', { name: 'Neighbourhood', exact: true }).click();
		await expect(cities.getByText('Neighbourhood', { exact: true })).toBeVisible();
		await bulldozeStub(page);
		await page.keyboard.press('ControlOrMeta+s');
		await saveAs.getByRole('button', { name: 'Save' }).click();
		await expect(cities.getByLabel('Unsaved changes')).toHaveCount(0);
		expect((await storedCity(page, 'neighbourhood-2')).graph.segments.length).toBe(
			EXAMPLE_SEGMENTS - 1
		);
		expect((await storedCity(page, 'neighbourhood')).graph.segments.length).toBe(
			EXAMPLE_SEGMENTS - 1
		);

		// The example file itself never changes.
		const served = await page.evaluate(() =>
			fetch('/examples/neighbourhood.json').then((response) => response.json())
		);
		expect(served.graph.segments.length).toBe(EXAMPLE_SEGMENTS);
	});
});
