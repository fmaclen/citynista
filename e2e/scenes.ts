import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Test-only graphs live in e2e/scenes/, outside anything the app serves. A scene
// boots as the current city of a fresh localStorage library, the same way a
// city of your own would.
export function readScene(name: string) {
	return JSON.parse(readFileSync(`e2e/scenes/${name}.json`, 'utf8'));
}

export async function openScene(page: Page, name: string, query = 'topdown') {
	const graph = readScene(name);
	// Any same-origin page that doesn't boot the editor, so nothing saves first.
	await page.goto('/robots.txt');
	await page.evaluate(
		({ id, graph }) => {
			localStorage.clear();
			localStorage.setItem(
				`citynista:city:${id}`,
				JSON.stringify({ id, name: id, graph, camera: null })
			);
			localStorage.setItem('citynista:cities', JSON.stringify([{ id, name: id }]));
			localStorage.setItem('citynista:current-city', id);
			localStorage.setItem('citynista-graph-v2', JSON.stringify(graph));
		},
		{ id: name, graph }
	);
	await page.goto(`/?${query}`);
}
