import { expect, test } from 'bun:test';
import { cityOf, openEditor } from './editor.svelte';
import { closestOnRoad, roadAt } from '../src/lib/core/road-line';
import { walkwayOf } from '../src/lib/modes/picking';
import { readScene } from './model';
import { createSnapping } from '../src/lib/modes/draw';
import { createLanesFrom } from '../src/lib/core/lane-template';

// Draw mode lays a footpath's end on the walkway under the pointer as
// drawn, a junction's corner sidewalk included, where it reaches past the
// streets' bodies (modes/draw.ts resolveSnap); with Shift, where the
// locked line meets that walkway's middle.

const PATH = 3;

// The nodes a draw added, with the walkway each lies on.
function added(ui: ReturnType<typeof openEditor>, before: Set<string>) {
	const derived = ui.editor.roadRenderer.derived!;
	return [...ui.editor.graph.nodes.values()]
		.filter((n) => !before.has(n.id))
		.map((n) => ({ x: n.x, y: n.y, on: derived.sidewalks.get(n.id)?.[0] }));
}

test("a path started on a corner's sidewalk off the streets' bodies starts on its middle", () => {
	// (-14.75, -4) lies on the corner between the south and north streets,
	// past the reach of either street's body.
	const ui = openEditor(readScene('curved-tee'), 0.04);
	const under = ui.editor.roadRenderer.walkwayAt({ x: -14.75, y: -4 });
	expect(under && 'corner' in under.lane).toBe(true);
	ui.editor.activateSlot(PATH);
	const before = new Set(ui.editor.graph.nodes.keys());
	ui.click(-14.75, -4);
	ui.click(-30, -20);

	const [start] = added(ui, before);
	expect(start.x).toBeCloseTo(under!.middle.x, 9);
	expect(start.y).toBeCloseTo(under!.middle.y, 9);
	expect(start.on?.corner).toBeDefined();
});

test('a path held to its line with Shift ends where the line meets the corner', () => {
	const ui = openEditor(readScene('curved-tee'), 0.04);
	ui.editor.activateSlot(PATH);
	const before = new Set(ui.editor.graph.nodes.keys());
	// A free start, then a horizontal line toward the corner.
	ui.click(-40, -3.75, { ctrl: true });
	ui.hover(-14.75, -3.75, { shift: true });
	ui.click(-14.75, -3.75, { shift: true });

	const [, end] = added(ui, before);
	expect(end.y).toBeCloseTo(-3.75, 9);
	expect(end.on?.corner).toBeDefined();
	// On the corner's middle line.
	const line = end.on!.corner!.line;
	const off = Math.min(
		...line.slice(1).map((q, k) => {
			const p = line[k];
			const [dx, dy] = [q.x - p.x, q.y - p.y];
			const f = Math.max(
				0,
				Math.min(1, ((end.x - p.x) * dx + (end.y - p.y) * dy) / (dx * dx + dy * dy))
			);
			return Math.hypot(p.x + dx * f - end.x, p.y + dy * f - end.y);
		})
	);
	expect(off).toBeLessThan(1e-6);
});

// With Shift, a footpath's end aimed at a street's sidewalk lies on the
// locked line and on that sidewalk's middle as drawn, wherever along the
// street, on either sidewalk, the street straight or curved either way,
// shifted along its length or not and stored either way, the line coming in
// at any angle.
test("a path held to its line with Shift ends on the line and on the sidewalk's middle", () => {
	const step = Math.PI / 8;
	for (const control of [undefined, { x: 0, y: 100 }, { x: 0, y: -100 }])
		for (const reversed of [false, true])
			for (const shift of [0, 2]) {
				const graph = cityOf({ a: [-100, 0], b: [100, 0] }, [
					reversed
						? { id: 'street', from: 'b', to: 'a', lanes: 'street', control }
						: { id: 'street', from: 'a', to: 'b', lanes: 'street', control }
				]);
				Object.assign(graph.segments[0], { offsetStart: -shift, offsetEnd: shift });
				for (const t of [0.25, 0.6])
					for (const side of [1, -1])
						for (let k = 0; k < 16; k++) {
							const ui = openEditor(graph, 0.05);
							const street = ui.editor.graph.segments.get('street')!;
							const on = roadAt(ui.editor.graph, street, t)!;
							const n = { x: on.normal.x * side, y: on.normal.y * side };
							const probe = { x: on.point.x + n.x * 4.5, y: on.point.y + n.y * 4.5 };
							const walk = ui.editor.roadRenderer.walkwayAt(probe);
							expect(walk).not.toBeNull();
							// Aimed 0.4 m off the sidewalk's middle, from 30 m off at
							// 5° past one of the lock's angles, from outside the street.
							const aim = { x: walk!.middle.x + n.x * 0.4, y: walk!.middle.y + n.y * 0.4 };
							const heading = k * step + (5 * Math.PI) / 180;
							const start = {
								x: aim.x - Math.cos(heading) * 30,
								y: aim.y - Math.sin(heading) * 30
							};
							const outward = (start.x - aim.x) * n.x + (start.y - aim.y) * n.y;
							const clear = closestOnRoad(ui.editor.graph, street, start.x, start.y).distance > 12;
							if (outward < 12 || !clear) continue;
							ui.editor.activateSlot(PATH);
							const before = new Set(ui.editor.graph.nodes.keys());
							ui.click(start.x, start.y, { ctrl: true });
							ui.hover(aim.x, aim.y, { shift: true });
							ui.click(aim.x, aim.y, { shift: true });
							const [from, end] = added(ui, before);
							const angle = Math.atan2(end.y - from.y, end.x - from.x) / step;
							// On the middle of the walkway it is joined to, as a joined
							// end reads it (walkwayOf).
							const lines = end.on ? (walkwayOf(ui.editor, end.on)?.lines ?? []) : [];
							const off = Math.min(...lines.map((l) => toLine(l, end)));
							expect({
								control,
								reversed,
								shift,
								t,
								side,
								k,
								angle: Math.abs(angle - Math.round(angle)) < 1e-9,
								off: off < 1e-6,
								on: end.on?.lane
							}).toEqual({
								control,
								reversed,
								shift,
								t,
								side,
								k,
								angle: true,
								off: true,
								on: walk!.lane.lane
							});
						}
			}
}, 30_000);

// How far a point lies from a line.
function toLine(line: { x: number; y: number }[], p: { x: number; y: number }) {
	return Math.min(
		...line.slice(1).map((q, k) => {
			const a = line[k];
			const [dx, dy] = [q.x - a.x, q.y - a.y];
			const f = Math.max(
				0,
				Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
			);
			return Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
		})
	);
}

// Aimed with Shift at a street's asphalt, the end goes to the walkway an
// unlocked click there lands on as drawn (its side, Networks.walkwayAt), and
// lies where the locked line meets that walkway's middle, never on a stretch
// of sidewalk the junction has replaced: near a T, crossroads or bent
// junction, the streets stored either way, from any side.
test('a path held to its line with Shift onto asphalt ends on the drawn walkway it aims at', () => {
	const step = Math.PI / 8;
	const junctions = [{ arms: [180, 0, 90] }, { arms: [180, 0, 60] }, { arms: [180, 0, 90, 270] }];
	let joined = 0;
	for (const { arms } of junctions)
		for (const reversed of [false, true]) {
			const nodes: Record<string, [number, number]> = { o: [0, 0] };
			const roads = arms.map((deg, k) => {
				const r = (deg * Math.PI) / 180;
				nodes[`a${k}`] = [100 * Math.cos(r), 100 * Math.sin(r)];
				return reversed
					? { id: `r${k}`, from: `a${k}`, to: 'o', lanes: 'street' as const }
					: { id: `r${k}`, from: 'o', to: `a${k}`, lanes: 'street' as const };
			});
			const graph = cityOf(nodes, roads);
			for (const aim of [
				{ x: 2, y: 5 },
				{ x: -2, y: 5 },
				{ x: 2.5, y: 2.5 },
				{ x: 1, y: -2.5 },
				{ x: 2, y: 12 },
				{ x: 12, y: 2 }
			])
				for (const heading of [0, 1, 2, 3, 5, 7].map((k) => k * 2 * step + 0.09)) {
					const ui = openEditor(graph, 0.05);
					if (ui.editor.roadRenderer.walkwayAt(aim)) continue;
					// The walkway an unlocked click there lands on.
					const snap = createSnapping(
						ui.editor,
						() => createLanesFrom('path'),
						() => null,
						() => false
					).resolveSnap(aim.x, aim.y);
					const aimed = snap.kind === 'side' ? snap.walk : undefined;
					expect(aimed).toBeTruthy();
					const start = { x: aim.x + Math.cos(heading) * 40, y: aim.y + Math.sin(heading) * 40 };
					ui.editor.activateSlot(PATH);
					const before = new Set(ui.editor.graph.nodes.keys());
					ui.click(start.x, start.y, { ctrl: true });
					ui.hover(aim.x, aim.y, { shift: true });
					ui.click(aim.x, aim.y, { shift: true });
					const [from, end] = added(ui, before);
					// Only where the locked line meets that walkway's middle.
					const toward = angleOf(from, aim, step);
					const meets = walkwayOf(ui.editor, aimed!)!.lines.some((l) => crosses(l, from, toward));
					if (!meets) continue;
					const angle = Math.atan2(end.y - from.y, end.x - from.x) / step;
					const lines = end.on ? (walkwayOf(ui.editor, end.on)?.lines ?? []) : [];
					const off = lines.length ? Math.min(...lines.map((l) => toLine(l, end))) : Infinity;
					if (end.on) joined++;
					expect({
						arms,
						reversed,
						aim,
						heading,
						angle: Math.abs(angle - Math.round(angle)) < 1e-9,
						joined: !!end.on,
						off: off < 1e-6
					}).toEqual({ arms, reversed, aim, heading, angle: true, joined: true, off: true });
				}
		}
	expect(joined).toBeGreaterThan(50);
}, 30_000);

// The way the locked line runs from `from` toward `to`, its angle rounded
// to the lock's `step`.
function angleOf(from: { x: number; y: number }, to: { x: number; y: number }, step: number) {
	const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
	return { x: Math.cos(a), y: Math.sin(a) };
}

// Whether the line through `a` along `d` crosses a polyline.
function crosses(
	line: { x: number; y: number }[],
	a: { x: number; y: number },
	d: { x: number; y: number }
) {
	const side = (p: { x: number; y: number }) => (p.x - a.x) * d.y - (p.y - a.y) * d.x;
	return line.slice(1).some((q, k) => side(line[k]) * side(q) <= 0);
}
