import { expect, type Page } from '@playwright/test';

// Select is the default mode and has no button of its own: the editor is in it
// when no preset slot (draw), Split or Bulldoze is pressed. The grid and lane
// connection toggles are independent and may be on.
export async function expectSelectMode(page: Page) {
	const nav = page.locator('nav');
	await expect(nav.locator('button[aria-label][aria-pressed="true"]')).toHaveCount(0);
	await expect(nav.getByTitle(/^Split/)).toHaveAttribute('aria-pressed', 'false');
	await expect(nav.getByTitle(/^Bulldoze/)).toHaveAttribute('aria-pressed', 'false');
}
