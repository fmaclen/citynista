import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openScene } from './scenes';
import { saveCity } from './save';

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

const cityBar = (page: Page) => page.getByRole('toolbar', { name: 'Cities' });

async function menuItem(page: Page, name: string) {
	await cityBar(page).getByLabel('City menu').click();
	await page.getByRole('menuitem', { name, exact: true }).click();
}

const storedIndex = (page: Page) =>
	page.evaluate(() => JSON.parse(localStorage.getItem('citynista:cities') ?? '[]'));

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

		// Its name is read-only: clicking it opens no editor.
		await cities.getByText('Neighbourhood', { exact: true }).click();
		await expect(cities.getByRole('textbox')).toHaveCount(0);

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
		await menuItem(page, 'Neighbourhood');
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

	test('renaming the current city is stored at once; Escape and empty names cancel', async ({
		page
	}) => {
		await openScene(page, 'median-corner');
		const cities = cityBar(page);
		const name = cities.getByTitle('Rename this city');
		const input = cities.getByRole('textbox', { name: 'City name' });
		await expect(name).toHaveText('median-corner');

		await name.click();
		await input.fill('Downtown');
		await input.press('Escape');
		await expect(input).toHaveCount(0);
		await expect(name).toHaveText('median-corner');

		await name.click();
		await input.fill('  ');
		await input.press('Enter');
		await expect(name).toHaveText('median-corner');

		// An unsaved road stays unsaved through the rename.
		await page.getByRole('button', { name: 'Street' }).click();
		await page.mouse.click(300, 500);
		await page.mouse.click(700, 500);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(cities.getByLabel('Unsaved changes')).toBeVisible();

		await name.click();
		await input.fill('Downtown');
		await input.press('Enter');
		await expect(name).toHaveText('Downtown');
		await expect(cities.getByLabel('Unsaved changes')).toBeVisible();

		page.once('dialog', (dialog) => dialog.accept());
		await page.reload();
		await expect(name).toHaveText('Downtown');
		expect(await storedIndex(page)).toEqual([{ id: 'median-corner', name: 'Downtown' }]);
		expect((await storedCity(page, 'median-corner')).graph.segments).toHaveLength(2);
	});

	test('Duplicate saves the map, unsaved edits included, as a second city', async ({ page }) => {
		await openScene(page, 'median-corner');
		const cities = cityBar(page);
		const dialog = page.getByRole('dialog');

		await page.getByRole('button', { name: 'Street' }).click();
		await page.mouse.click(300, 500);
		await page.mouse.click(700, 500);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		await menuItem(page, 'Duplicate…');
		await expect(dialog.getByRole('textbox')).toHaveValue('median-corner');
		await dialog.getByRole('textbox').fill('copy');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(cities.getByTitle('Rename this city')).toHaveText('copy');
		await saveCity(page);

		expect(await storedIndex(page)).toEqual([
			{ id: 'median-corner', name: 'median-corner' },
			{ id: 'copy', name: 'copy' }
		]);
		expect((await storedCity(page, 'copy')).graph.segments).toHaveLength(3);
		expect((await storedCity(page, 'median-corner')).graph.segments).toHaveLength(2);
	});

	test('New, Open and Delete work from the city menu', async ({ page }) => {
		await openScene(page, 'median-corner');
		const name = cityBar(page).getByTitle('Rename this city');
		const dialog = page.getByRole('dialog');

		// The menu lists your cities, then the examples. The screenshot shows it
		// open beside a selected road's lane panel.
		const road = toScreen(-75, 0);
		await page.mouse.click(road.x, road.y);
		await expect(page.locator('aside')).toBeVisible();
		await cityBar(page).getByLabel('City menu').click();
		await expect(
			page.getByRole('menuitem').filter({ hasText: /median-corner|Neighbourhood/ })
		).toHaveText(['median-corner', 'Neighbourhood']);
		await page.screenshot({ path: 'test-results/city-menu.png' });
		await page.getByRole('menuitem', { name: 'New city…' }).click();
		await dialog.getByRole('textbox').fill('fresh');
		await dialog.getByRole('button', { name: 'Create' }).click();
		await expect(name).toHaveText('fresh');

		await menuItem(page, 'median-corner');
		await expect(name).toHaveText('median-corner');

		await menuItem(page, 'Delete this city');
		await expect(name).toHaveText('fresh');
		expect(await storedIndex(page)).toEqual([{ id: 'fresh', name: 'fresh' }]);
		expect(await storedCity(page, 'median-corner')).toBeNull();
	});
});
