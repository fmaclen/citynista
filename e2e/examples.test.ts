import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../src/lib/core/city-store';
import { liveGraph, openEditor, openScene, toScreen } from './app';
import { readScene } from '../unit/model';

const EXAMPLE = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8'));
const EXAMPLE_SEGMENTS: number = EXAMPLE.graph.segments.length;

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
		const graph = await liveGraph(page);
		expect(graph.nodes).toHaveLength(3);
		expect(graph.segments).toHaveLength(2);
		const corner = graph.nodes.find((node) => node.id === 'node-1');
		expect(corner).toEqual({ id: 'node-1', x: 0, y: 0 });
		expect(graph.segments[0].lanes.length).toBeGreaterThan(0);
	});

	test('cities saved with another schema version, or none, are ignored and cleared', async ({
		page
	}) => {
		const graph = readScene('median-corner');
		const stale = { nodes: [], segments: [] };
		await page.goto('/robots.txt');
		await page.evaluate(
			({ graph, stale, version }) => {
				localStorage.clear();
				const put = (key: string, value: unknown) =>
					localStorage.setItem(key, JSON.stringify(value));
				put('citynista:cities', [
					{ id: 'current', name: 'current', version },
					{ id: 'unversioned', name: 'unversioned' },
					{ id: 'newer', name: 'newer', version: version + 1 },
					// Listed at this version, but the record itself is older.
					{ id: 'old-record', name: 'old-record', version }
				]);
				put('citynista:city:current', {
					id: 'current',
					name: 'current',
					graph,
					camera: null,
					version
				});
				put('citynista:city:unversioned', {
					id: 'unversioned',
					name: 'unversioned',
					graph: stale,
					camera: null
				});
				put('citynista:cam:unversioned', { zoom: 1, targetX: 0, targetZ: 0, azimuth: 0, polar: 0 });
				put('citynista:city:newer', {
					id: 'newer',
					name: 'newer',
					graph: stale,
					camera: null,
					version: version + 1
				});
				put('citynista:city:old-record', {
					id: 'old-record',
					name: 'old-record',
					graph: stale,
					camera: null
				});
				localStorage.setItem('citynista:current-city', 'current');
			},
			{ graph, stale, version: SCHEMA_VERSION }
		);
		await openEditor(page, 'topdown&model', 'current');

		// The current city loads, and stays stored, as it was.
		expect((await liveGraph(page)).segments).toHaveLength(graph.segments.length);
		expect((await storedCity(page, 'current')).graph).toEqual(graph);

		// The others drop out of the library, their keys gone with them.
		await cityBar(page).getByLabel('City menu').click();
		for (const id of ['unversioned', 'newer', 'old-record'])
			await expect(page.getByRole('menuitem', { name: id, exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		expect(await storedIndex(page)).toEqual([
			{ id: 'current', name: 'current', version: SCHEMA_VERSION }
		]);
		const left = await page.evaluate(() =>
			Object.keys(localStorage).filter((k) => k.startsWith('citynista:'))
		);
		expect(left.sort()).toEqual([
			'citynista:cities',
			'citynista:city:current',
			'citynista:current-city'
		]);
	});

	test('a stale current city boots a fresh empty one instead', async ({ page }) => {
		await page.goto('/robots.txt');
		await page.evaluate((graph) => {
			localStorage.clear();
			localStorage.setItem('citynista:cities', JSON.stringify([{ id: 'old', name: 'old' }]));
			localStorage.setItem(
				'citynista:city:old',
				JSON.stringify({ id: 'old', name: 'old', graph, camera: null })
			);
			localStorage.setItem('citynista:current-city', 'old');
		}, readScene('median-corner'));
		await openEditor(page);
		expect(await storedCity(page, 'old')).toBeNull();
		expect((await storedCity(page, 'untitled')).graph).toEqual({ nodes: [], segments: [] });
	});

	test('an example opens untouched; Save makes a city of your own from it', async ({ page }) => {
		// The example is the largest map there is, and this opens it twice and
		// edits and saves it twice: each step rebuilds or redraws all of it.
		// About 10 s on a quiet machine, three times that on a busy one.
		test.setTimeout(90_000);
		const cities = page.getByRole('toolbar', { name: 'Cities' });
		const saveAs = page.getByRole('dialog');
		await openEditor(page, 'example=neighbourhood&topdown', 'Neighbourhood');

		// Its name is read-only: the menu's Rename is disabled.
		await cities.getByText('Neighbourhood', { exact: true }).click();
		await expect(page.getByRole('menuitem', { name: 'Rename…' })).toBeDisabled();
		await page.keyboard.press('Escape');
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
		expect(await page.evaluate(() => localStorage.getItem('citynista:current-city'))).toBe(
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
		const name = cities.getByTestId('city-name');
		const input = cities.getByRole('textbox', { name: 'City name' });
		await expect(name).toHaveText('median-corner');

		await menuItem(page, 'Rename…');
		await expect(input).toBeFocused();
		await input.fill('Downtown');
		await input.press('Escape');
		await expect(input).toHaveCount(0);
		await expect(name).toHaveText('median-corner');

		await menuItem(page, 'Rename…');
		await expect(input).toBeFocused();
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

		await menuItem(page, 'Rename…');
		await expect(input).toBeFocused();
		await input.fill('Downtown');
		await input.press('Enter');
		await expect(name).toHaveText('Downtown');
		await expect(cities.getByLabel('Unsaved changes')).toBeVisible();

		page.once('dialog', (dialog) => dialog.accept());
		await page.reload();
		await expect(name).toHaveText('Downtown');
		expect(await storedIndex(page)).toEqual([
			{ id: 'median-corner', name: 'Downtown', version: SCHEMA_VERSION }
		]);
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
		await expect(cities.getByTestId('city-name')).toHaveText('copy');
		await expect(cities.getByLabel('Unsaved changes')).toHaveCount(0);

		expect(await storedIndex(page)).toEqual([
			{ id: 'median-corner', name: 'median-corner', version: SCHEMA_VERSION },
			{ id: 'copy', name: 'copy', version: SCHEMA_VERSION }
		]);
		expect((await storedCity(page, 'copy')).graph.segments).toHaveLength(3);
		expect((await storedCity(page, 'median-corner')).graph.segments).toHaveLength(2);
	});

	test('New, Open and Delete work from the city menu', async ({ page }) => {
		await openScene(page, 'median-corner');
		const name = cityBar(page).getByTestId('city-name');
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
		expect(await storedIndex(page)).toEqual([
			{ id: 'fresh', name: 'fresh', version: SCHEMA_VERSION }
		]);
		expect(await storedCity(page, 'median-corner')).toBeNull();
	});
});
