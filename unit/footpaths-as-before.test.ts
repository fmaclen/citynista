import { expect, test } from 'bun:test';
import { type Recorded, sweeps } from './footpaths-as-before';
import before from './footpaths-as-before.json';

// A footpath with no shift is placed, stored and drawn exactly as before
// footpaths took a shift, in every gesture that places a node by where its
// end shows (unit/footpaths-as-before.ts): the same saved graph and the same
// drawing, to the byte.
for (const [gesture, sweep] of Object.entries(sweeps))
	test(`a footpath is placed, stored and drawn as before footpaths took a shift where nothing is shifted: ${gesture}`, () => {
		const was = before as Recorded;
		const wrong: string[] = [];
		const steps = sweep();
		expect(steps.length).toBeGreaterThan(0);
		for (const { name, graph, drawing } of steps) {
			if (!was[name]) wrong.push(`${name}: not recorded`);
			else if (graph !== was[name].graph) wrong.push(`${name}: stored otherwise`);
			else if (drawing !== was[name].drawing) wrong.push(`${name}: drawn otherwise`);
		}
		expect(wrong).toEqual([]);
	}, 30_000);
