import { expect, test, type Page } from '@playwright/test';
import { liveGraph, openEditor, saveCity } from './app';

// What the editor shows when storage refuses a write. The store's own
// handling of refused writes is checked in unit/city-store.test.ts.

// Makes storage refuse every write to a key starting with `prefix`, the way
// a full quota does, until `allowWrites`.
const refuseWrites = (page: Page, prefix: string) =>
	page.evaluate((prefix) => {
		const setItem = Storage.prototype.setItem;
		const w = window as unknown as { allowWrites: () => void };
		w.allowWrites = () => (Storage.prototype.setItem = setItem);
		Storage.prototype.setItem = function (key: string, value: string) {
			if (key.startsWith(prefix)) throw new DOMException('full', 'QuotaExceededError');
			setItem.call(this, key, value);
		};
	}, prefix);
const allowWrites = (page: Page) =>
	page.evaluate(() => (window as unknown as { allowWrites: () => void }).allowWrites());

const drawRoad = async (page: Page, y: number) => {
	await page.getByRole('button', { name: 'Street' }).click();
	await page.mouse.click(300, y);
	await page.mouse.click(700, y);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
};

const refusal = (page: Page) => page.getByRole('alert').filter({ hasText: "Couldn't save" });
const cityMenu = (page: Page, item: string) =>
	page
		.getByRole('button', { name: 'City menu' })
		.click()
		.then(() => page.getByRole('menuitem', { name: item }).click());

test('a refused save says so and keeps the change unsaved; a retry clears both', async ({
	page
}) => {
	await openEditor(page);
	await drawRoad(page, 360);
	await refuseWrites(page, 'citynista:city:');
	const unsaved = page.getByLabel('Unsaved changes');
	await page.keyboard.press('ControlOrMeta+s');
	await expect(refusal(page)).toBeVisible();
	await expect(unsaved).toBeVisible();

	await allowWrites(page);
	await saveCity(page);
	await expect(refusal(page)).toHaveCount(0);
});

test('a refused Save As or New City says so inside its dialog', async ({ page }) => {
	await openEditor(page);
	const dialog = page.getByRole('dialog');
	await refuseWrites(page, 'citynista:city:');

	await cityMenu(page, 'Duplicate…');
	await dialog.getByRole('textbox').fill('copy');
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog.getByRole('alert')).toHaveText(
		"Couldn't save: this browser's storage is full"
	);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);

	await cityMenu(page, 'New city…');
	await dialog.getByRole('textbox').fill('fresh');
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(dialog.getByRole('alert')).toHaveText(
		"Couldn't save: this browser's storage is full"
	);
	await expect(page.getByTestId('city-name')).toHaveText('untitled');
});

test('a reload reopens the city as last saved, even when recording it failed on boot', async ({
	page
}) => {
	// Storage refuses to record the current city on boot, though it takes the
	// fresh city itself.
	await page.addInitScript(() => {
		if (sessionStorage.getItem('allow')) return;
		const setItem = Storage.prototype.setItem;
		const w = window as unknown as { allowWrites: () => void };
		w.allowWrites = () => {
			Storage.prototype.setItem = setItem;
			sessionStorage.setItem('allow', '1');
		};
		Storage.prototype.setItem = function (key: string, value: string) {
			if (key === 'citynista:current-city') throw new DOMException('full', 'QuotaExceededError');
			setItem.call(this, key, value);
		};
	});
	await openEditor(page);
	expect(await page.evaluate(() => localStorage.getItem('citynista:current-city'))).toBeNull();
	await allowWrites(page);
	const roads = async () => (await liveGraph(page)).segments.length;

	await drawRoad(page, 300);
	await saveCity(page);
	await page.reload();
	await expect(page.getByTestId('city-name')).toHaveText('untitled');
	await expect.poll(roads).toBe(1);

	// An edit left unsaved is gone after the reload (past the leave-page prompt).
	await drawRoad(page, 450);
	await expect.poll(roads).toBe(2);
	page.once('dialog', (dialog) => dialog.accept());
	await page.reload();
	await expect(page.getByTestId('city-name')).toHaveText('untitled');
	await expect.poll(roads).toBe(1);
});
