import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { GraphData } from '../src/lib/core/types';
import { byId, gestures, previewOf, type Driver } from '../unit/car-draw';
import { button, liveGraph, openGraph, saveCity, screenAt } from './app';

// Drawing car roads with car presets does what it always did, on the page:
// the gesture below (unit/car-draw.ts), done with the toolbar's Street
// preset and the pointer, leaves what e2e/car-draw.json records of it: the
// graph after the cut, the roads the preview shows while a road is pending,
// and the graph saved at the end. That file holds every gesture as the page
// drew it before footpaths were a network of their own, and
// unit/car-draw.test.ts holds every gesture in Node to it as well. It is
// never recorded again: a record made now could only show that the code
// agrees with itself.

const FILE = 'e2e/car-draw.json';
const view = screenAt(4);

function driver(page: Page): Driver {
	const at = (x: number, y: number) => view(x, y);
	const escape = async () => {
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
	};
	return {
		street: async (style = 'Straight') => {
			await button(page, 'Street');
			await button(page, style);
		},
		click: (x, y) => page.mouse.click(at(x, y).x, at(x, y).y),
		hover: (x, y) => page.mouse.move(at(x, y).x, at(x, y).y, { steps: 4 }),
		escape,
		undo: () => page.keyboard.press('ControlOrMeta+z'),
		redo: () => page.keyboard.press('ControlOrMeta+Shift+z'),
		split: () => page.getByTitle('Split (click a road to cut it at that point)').click(),
		key: (name) => page.keyboard.press(name),
		join: () => page.getByTitle('Join — dissolve this node back into one road').click()
	};
}

// The stored graph.
async function stored(page: Page) {
	await saveCity(page);
	return byId(
		await page.evaluate(
			() => JSON.parse(localStorage.getItem('citynista:city:test')!).graph as GraphData
		)
	);
}

// The roads the preview lays.
const preview = async (page: Page) =>
	previewOf(
		await page.evaluate(() =>
			(window as unknown as { __ghostGraph: () => GraphData | undefined }).__ghostGraph()
		)
	);

const name = 'a road from the street';
test(`car-only draw gestures do what they always did: ${name}`, async ({ page }) => {
	const recorded = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>;
	const check = (key: string, value: unknown) => expect([key, value]).toEqual([key, recorded[key]]);
	const gesture = gestures[name];
	await openGraph(page, gesture.graph, 'topdown&model&cam=0,0,4');
	await gesture.run(driver(page), async (label, what = 'graph') =>
		check(
			`${name} / ${label}`,
			what === 'graph' ? byId(await liveGraph(page)) : await preview(page)
		)
	);
	check(name, await stored(page));
});
