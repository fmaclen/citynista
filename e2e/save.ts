import { expect, type Page } from '@playwright/test';

// Edits only reach storage on Save. Press ⌘S/Ctrl+S and wait for the unsaved
// marker to clear before reading what was stored.
export async function saveCity(page: Page) {
	await page.keyboard.press('ControlOrMeta+s');
	await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
}
