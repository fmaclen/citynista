import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../src/lib/core/city-store';

// Test-only graphs live in e2e/scenes/, outside anything the app serves. A scene
// boots as the current city of a fresh localStorage library, the same way a
// city of your own would.
export function readScene(name: string) {
	return JSON.parse(readFileSync(`e2e/scenes/${name}.json`, 'utf8'));
}

export async function openScene(page: Page, name: string, query = 'topdown') {
	await openGraph(page, readScene(name), query, name);
}

// Boot the editor on a graph, stored as the only city at the current schema
// version, so scene files and inline graphs stay plain graphs.
export async function openGraph(page: Page, graph: object, query = 'topdown', id = 'test') {
	// Any same-origin page that doesn't boot the editor, so nothing saves first.
	await page.goto('/robots.txt');
	await page.evaluate(
		({ id, graph, version }) => {
			localStorage.clear();
			localStorage.setItem(
				`citynista:city:${id}`,
				JSON.stringify({ id, name: id, graph, camera: null, version })
			);
			localStorage.setItem('citynista:cities', JSON.stringify([{ id, name: id, version }]));
			localStorage.setItem('citynista:current-city', id);
			localStorage.setItem('citynista-graph-v2', JSON.stringify(graph));
		},
		{ id, graph, version: SCHEMA_VERSION }
	);
	await page.goto(`/?${query}`);
}
