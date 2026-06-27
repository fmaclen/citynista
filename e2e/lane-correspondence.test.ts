import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
	checkInvariants,
	type LaneDump,
	type LaneManifest,
	type Violation
} from './lane-invariants';

const manifest = JSON.parse(
	readFileSync('static/fixtures/_lc-manifest.json', 'utf8')
) as LaneManifest;

function groupedReport(violations: Violation[]) {
	const grouped = new Map<string, Set<string>>();
	const casesByNode = new Map(manifest.cases.map((entry) => [entry.midNodeId, entry]));
	for (const violation of violations) {
		const entry = casesByNode.get(violation.nodeId);
		const cell = entry ? `#${entry.index} ${entry.cls}` : `${violation.nodeId} ${violation.cls}`;
		const cells = grouped.get(violation.invariant) ?? new Set<string>();
		cells.add(cell);
		grouped.set(violation.invariant, cells);
	}

	return [...grouped.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([invariant, cells]) => `${invariant}: ${cells.size} [${[...cells].join(', ')}]`)
		.join('\n');
}

test('lane correspondence invariant harness reports current breakage surface', async ({ page }) => {
	await page.goto('/?fixture=_lc-transitions&harness=lane&topdown');
	await expect(page.locator('canvas')).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const harnessWindow = window as Window & { __laneHarness?: () => unknown };
				return !!harnessWindow.__laneHarness;
			})
		)
		.toBe(true);

	const dump = (await page.evaluate(() => {
		const harnessWindow = window as Window & { __laneHarness: () => unknown };
		return harnessWindow.__laneHarness();
	})) as LaneDump;
	const { hard, gated } = checkInvariants(dump, manifest);

	console.log(
		[
			'LANE CORRESPONDENCE BREAKAGE REPORT',
			`total cells: ${manifest.cases.length}`,
			`hard violations: ${hard.length}`,
			`gated violations: ${gated.length}`,
			groupedReport(gated)
		]
			.filter(Boolean)
			.join('\n')
	);

	expect(hard).toEqual([]);
});
