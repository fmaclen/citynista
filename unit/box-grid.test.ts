import { expect, test } from 'bun:test';
import { BoxGrid } from '../src/lib/road-model/overlay';

// The grid kept from build to build holds cells only where something is
// filed: whatever came and went leaves none behind, however it was taken out.

const cellsOf = (grid: BoxGrid<number>) =>
	(grid as unknown as { cells: Map<number, Set<number>> }).cells;

test('a grid gives back the cells of what it takes out', () => {
	const grid = new BoxGrid<number>();
	for (let i = 0; i < 1000; i++) {
		grid.add([64 * i + 1, 1, 64 * i + 80, 20], i);
		if (i % 2 === 0) grid.remove(i);
		else grid.keepOnly(new Set());
	}
	expect(cellsOf(grid).size).toBe(0);
	// What stays filed keeps its cells, and is still found there.
	grid.add([0, 0, 100, 10], 1);
	grid.add([200, 0, 210, 10], 2);
	grid.keepOnly(new Set([2]));
	expect(cellsOf(grid).size).toBe(1);
	expect(grid.near([205, 5, 206, 6])).toEqual([2]);
	expect(grid.near([5, 5, 6, 6])).toEqual([]);
});
