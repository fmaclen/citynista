import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { Networks } from '../src/lib/core/networks';
import { carries } from '../src/lib/core/lane-types';
import type { CrossingControl, GraphData, Lane } from '../src/lib/core/types';
import type { Control } from '../src/lib/road-model/model';
import { check } from '../src/lib/road-model/checks';
import { linesAt, linesNear, zebras } from './crossing-reads';
import { frame, openEditor } from './editor.svelte';
import { buildModel } from './model';

// A crossing's control is set on the crossing itself (double-click its
// zebra, step its badge) and stored for its footpath segment and the
// carriageway it crosses, which every crossing that segment makes of that
// carriageway takes (core/crossing-controls.ts), here through the editor's
// gestures, tools and undo: nothing tells two crossings of one carriageway
// apart, so no edit moves a control from one crossing to another. How the
// carrying works through each edit that replaces a car segment is held in
// unit/crossing-controls.test.ts; the badge's button, the lane panel and a
// save and reload are in e2e/crossing-controls.test.ts.

type Pt = { x: number; y: number };
const p = (x: number, y: number): Pt => ({ x, y });
// Metres a pixel at the browser's top-down camera at zoom 6 (720 px for
// 500 m at zoom 1), so snap rings measured in pixels are the page's.
const perPixel = 500 / 720 / 6;

const lane = (
	id: string,
	role: Lane['role'],
	width: number,
	direction: Lane['direction'] = 'bidirectional'
) =>
	({ id, role, width, direction, material: role === 'vehicle' ? 'asphalt' : 'concrete' }) as Lane;
const sidewalk = (id: string) => lane(id, 'pedestrian', 2);
const path = [sidewalk('path')];
// Two carriageways running the same way either side of a 4 m walkway:
// sidewalk, the near lane (y -5.5 to -2), the walkway, the far lane (2 to
// 5.5), sidewalk.
const sameWay = [
	sidewalk('left'),
	lane('near', 'vehicle', 3.5, 'forward'),
	lane('middle', 'pedestrian', 4),
	lane('far', 'vehicle', 3.5, 'forward'),
	sidewalk('right')
];
// One carriageway, a lane each way: y -3.5 to 0 and 0 to 3.5.
const twoWay = [
	sidewalk('left'),
	lane('back', 'vehicle', 3.5, 'backward'),
	lane('forward', 'vehicle', 3.5, 'forward'),
	sidewalk('right')
];

// A street `r` along y = 0 from (-x, 0) to (x, 0), and a footpath `w`, either
// straight across at x = 0 or bowed through (0, 60) from (-32, -20) to
// (32, -20), crossing the street near x -22 and x 22; storing `controls`.
function crossed(
	lanes: Lane[],
	shape: 'straight' | 'bowed',
	controls?: CrossingControl[],
	x = shape === 'bowed' ? 40 : 35
): GraphData {
	const [from, to] = shape === 'bowed' ? [p(-32, -20), p(32, -20)] : [p(0, -20), p(0, 24)];
	return {
		nodes: [
			{ id: 'a', x: -x, y: 0 },
			{ id: 'b', x, y: 0 },
			{ id: 'p', ...from },
			{ id: 'q', ...to }
		],
		segments: [
			{ id: 'r', startNodeId: 'a', endNodeId: 'b', lanes: structuredClone(lanes) },
			{
				id: 'w',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: structuredClone(path),
				...(shape === 'bowed' && { controlX: 0, controlY: 60 }),
				...(controls && { controls })
			}
		]
	};
}

// The editor on `graph`, its gestures at world points (a click and a drag
// first moving the pointer there, as the page's do), and what it draws and
// stores.
function on(graph: GraphData) {
	const ui = openEditor(graph, perPixel);
	const graphNow = () => ui.graph();
	// The drawing of the editor's graph, built fresh, once the editor draws
	// it so too (`drawingOf` in e2e/app.ts).
	const drawing = () => {
		expect(ui.stale()).toEqual([]);
		return buildModel(graphNow()).scene;
	};
	const lines = (x: number) => linesAt(drawing(), x);
	const stored = () => graphNow().segments.flatMap((s) => s.controls ?? []);
	const node = (id: string) => graphNow().nodes.find((n) => n.id === id)!;
	const click = (q: Pt) => {
		ui.hover(q.x, q.y);
		ui.click(q.x, q.y);
	};
	const drag = (from: Pt, to: Pt, steps = 8) => {
		ui.hover(from.x, from.y);
		ui.drag(from, to, {}, steps);
	};
	const dragSelected = (from: Pt, to: Pt) => {
		click(from);
		drag(from, to, 10);
		ui.key('Escape');
	};
	// The Split tool (the toolbar's button), a click on the road at `at`.
	const split = (at: Pt) => {
		ui.editor.mode = 'split';
		frame();
		click(at);
		ui.key('Escape');
	};
	// Selects the node at `at` and joins its two roads back into one (the
	// toolbar's Join button).
	const joinAt = (at: Pt) => {
		click(at);
		ui.editor.joinNode(ui.editor.joinableNodeId!);
		ui.key('Escape');
	};
	// The badge of the crossing at `q`, opened by double-clicking its zebra.
	const opened = () => ui.editor.crossingBadges.find((b) => b.id === ui.editor.opened);
	const openBadge = (q: Pt) => {
		ui.dblclick(q.x, q.y);
		expect(opened()).toBeDefined();
	};
	const closeBadge = () => {
		ui.key('Escape');
		expect(ui.editor.opened).toBeNull();
	};
	// The control the badge of the crossing at `q` reads.
	const badgeAt = (q: Pt) => {
		openBadge(q);
		const control = opened()!.control;
		closeBadge();
		return control;
	};
	// Steps the badge of the crossing at `q` on, as its button does
	// (ControlBadges.svelte), until it reads `control`.
	const setControl = (q: Pt, control: Control) => {
		openBadge(q);
		for (let k = 0; k < 4 && opened()?.control !== control; k++)
			ui.editor.cycleCrossing(ui.editor.opened!);
		expect(opened()?.control).toBe(control);
		closeBadge();
	};
	const undo = () => ui.key('z', { ctrl: true });
	const redo = () => ui.key('z', { ctrl: true, shift: true });
	return {
		ui,
		graph: graphNow,
		drawing,
		lines,
		stored,
		node,
		click,
		drag,
		dragSelected,
		split,
		joinAt,
		badgeAt,
		setControl,
		undo,
		redo
	};
}
type On = ReturnType<typeof on>;

// After an edit (the graph `before` it), one undo step that gives back the
// graph as it was and a redo that makes it again; `reads` checks what the
// edit made in each state it is in, `readsBefore` what stood before it
// (`throughHistory` in e2e/app.ts, whose save and reload the browser tests
// keep).
function throughHistory(g: On, before: string, reads: () => void, readsBefore: () => void) {
	const after = JSON.stringify(g.graph());
	expect(after).not.toBe(before);
	reads();
	g.undo();
	expect(JSON.stringify(g.graph())).toBe(before);
	readsBefore();
	g.redo();
	expect(JSON.stringify(g.graph())).toBe(after);
	reads();
}

// Stop on one carriageway and Signal on the other of a divided street. Both
// carriageways run the same way, so each holds its own traffic alone: a stop
// line across the near lane, and one for the signal across the far lane.
function held() {
	const g = on(crossed(sameWay, 'straight'));
	g.setControl(p(0.3, -3.75), 'stop');
	g.setControl(p(0.3, 3.75), 'signal');
	return g;
}
// The lines at x, and each carriageway's badge there, as set.
function expectHeld(g: On, x: number, y = 0) {
	expect(g.lines(x)).toEqual(['stop far', 'stop near']);
	expect(g.badgeAt(p(x + 0.3, y - 3.75))).toBe('stop');
	expect(g.badgeAt(p(x + 0.3, y + 3.75))).toBe('signal');
	expect(check(g.drawing())).toEqual([]);
}
const kept: CrossingControl[] = [
	{ roads: ['r'], lanes: ['far'], control: 'signal' },
	{ roads: ['r'], lanes: ['near'], control: 'stop' }
];
// The lines at x as set and the entries stored.
function linesHeld(g: On, x: number, stored = kept) {
	expect(g.lines(x)).toEqual(['stop far', 'stop near']);
	expect(g.stored()).toEqual(stored);
}

const divided = 'Stop on one carriageway and Signal on the other of a divided street';

test(`${divided}: through undo and redo, a badge step each`, () => {
	const g = held();
	// Stop takes three steps of the badge (give-way, signal, none, stop),
	// Signal one, each one undo step.
	g.undo();
	expect(g.lines(0)).toEqual(['stop near', 'yield far']);
	for (let k = 0; k < 3; k++) g.undo();
	expect(g.lines(0)).toEqual(['yield far', 'yield near']);
	expect(g.stored()).toEqual([]);
	for (let k = 0; k < 4; k++) g.redo();
	expectHeld(g, 0);
	expect(g.stored()).toEqual(kept);
});

test(`${divided}: through a drag of either road, and of the footpath along itself`, () => {
	const g = held();
	// The footpath 6 m along the street.
	g.dragSelected(p(0, -12), p(6, -12));
	expect(g.node('p').x).toBeCloseTo(6, 0);
	linesHeld(g, 6);
	// The street 3 m across it.
	g.dragSelected(p(-20, 0), p(-20, 3));
	expect(g.node('a').y).toBeCloseTo(3, 0);
	linesHeld(g, 6);
	// The footpath 6 m along its own line.
	g.dragSelected(p(6, -12), p(6, -6));
	expect(g.node('p').y).toBeCloseTo(-14, 0);
	linesHeld(g, 6);
	expect(g.badgeAt(p(6.3, 3 - 3.75))).toBe('stop');
	expect(g.badgeAt(p(6.3, 3 + 3.75))).toBe('signal');
	expect(g.ui.stale()).toEqual([]);
});

test(`${divided}: through a footpath cut and joined`, () => {
	const g = held();
	// Cut north of the street: the piece north of the cut crosses no
	// carriageway and stores nothing once the editor writes the controls
	// again after the cut, the piece across holds both.
	g.split(p(0, -12));
	expect(g.graph().segments).toHaveLength(3);
	const north = g
		.graph()
		.segments.filter((s) => !carries(s.lanes) && (s.startNodeId === 'p' || s.endNodeId === 'p'));
	expect(north.map((s) => s.controls)).toEqual([undefined]);
	linesHeld(g, 0);
	// Joined again (joinedControls): one footpath holding both.
	g.joinAt(p(0, -12));
	expect(g.graph().segments).toHaveLength(2);
	linesHeld(g, 0);
	expect(g.ui.stale()).toEqual([]);
});

test(`${divided}: through the street cut with the Split tool, undone and redone`, () => {
	const g = held();
	const before = JSON.stringify(g.graph());
	// Cut west of the crossing: each entry names both halves of the street.
	g.split(p(-20, 0));
	expect(g.graph().segments).toHaveLength(3);
	const halves = g
		.graph()
		.segments.filter((s) => carries(s.lanes))
		.map((s) => s.id)
		.sort();
	const named = () => g.stored().map((k) => ({ ...k, roads: [...k.roads].sort() }));
	throughHistory(
		g,
		before,
		() => {
			expect(g.lines(0)).toEqual(['stop far', 'stop near']);
			expect(named()).toEqual(kept.map((k) => ({ ...k, roads: halves })));
		},
		() => linesHeld(g, 0)
	);
});

test(`${divided}: through lane edits, undone and redone`, () => {
	const g = held();
	g.click(p(-20, 0));
	expect([...g.ui.editor.selectedSegments]).toEqual(['r']);
	const car = () => g.graph().segments.find((s) => carries(s.lanes))!;
	// The far lane widened to 4 m, then the near lane copied (LaneEditor's
	// setWidth and copyLane): the near carriageway two lanes wide.
	g.ui.editor.editLanes((lanes) => (lanes[3].width = 4));
	expect(car().lanes[3].width).toBe(4);
	linesHeld(g, 0);
	const before = JSON.stringify(g.graph());
	g.ui.editor.editLanes((lanes) => lanes.splice(2, 0, { ...lanes[1] }));
	expect(car().lanes).toHaveLength(6);
	g.ui.key('Escape');
	const lanes = car().lanes;
	const near = lanes.slice(1, 3).map((l) => l.id!);
	expect(lanes.map((l) => l.role)).toEqual([
		'pedestrian',
		'vehicle',
		'vehicle',
		'pedestrian',
		'vehicle',
		'pedestrian'
	]);
	throughHistory(
		g,
		before,
		() => {
			expect(g.lines(0)).toEqual(['stop far', `stop ${[...near].sort()}`]);
			expect(g.stored()).toEqual([
				{ roads: ['r'], lanes: ['far'], control: 'signal' },
				{ roads: ['r'], lanes: near, control: 'stop' }
			]);
			expect(check(g.drawing())).toEqual([]);
		},
		() => linesHeld(g, 0)
	);
});

test(`${divided}: through a paste`, () => {
	const g = held();
	g.click(p(0, -12));
	expect([...g.ui.editor.selectedSegments]).toEqual(['w']);
	g.ui.key('c', { ctrl: true });
	g.ui.key('Escape');
	// Laid with its middle where the pointer is: across the street at x 15.
	g.ui.key('v', { ctrl: true });
	g.ui.hover(15, 2);
	g.ui.click(15, 2);
	expect(g.graph().segments).toHaveLength(3);
	linesHeld(g, 15, [...kept, ...kept]);
	expectHeld(g, 0);
});

test('a footpath bowed over each carriageway twice shares one control, kept when either crossing goes', () => {
	// The footpath bowed across both carriageways twice: Stop set at its west
	// crossing of the near lane, Signal at its east crossing of the far lane,
	// each holding both crossings of its carriageway.
	const g = on(crossed(sameWay, 'bowed'));
	g.setControl(p(-24.66, -3.75), 'stop');
	g.setControl(p(20.4, 3.75), 'signal');
	for (const x of [-22, 22]) expect(g.lines(x)).toEqual(['stop far', 'stop near']);
	expect(g.stored()).toEqual(kept);
	// The street's west end dragged past the west crossings, then back, then
	// its east end past the east ones: those left keep their controls.
	for (const [from, to, gone, left] of [
		[p(-40, 0), p(-18, 0), -22, 22],
		[p(-18, 0), p(-40, 0), null, null],
		[p(40, 0), p(18, 0), 22, -22]
	] as const) {
		g.dragSelected(from, to);
		expect(g.graph().nodes.some((n) => Math.abs(n.x - to.x) < 0.5 && Math.abs(n.y) < 0.5)).toBe(
			true
		);
		if (gone === null || left === null) continue;
		expect(g.lines(gone)).toEqual([]);
		expect(g.lines(left)).toEqual(['stop far', 'stop near']);
		expect(g.stored()).toEqual(kept);
	}
	// Set otherwise on the pair left, each holds that.
	g.setControl(p(-24.66, -3.75), 'none');
	expect(g.lines(-22)).toEqual(['stop far']);
	g.setControl(p(-20.4, 3.75), 'none');
	expect(g.lines(-22)).toEqual([]);
	expect(g.stored()).toEqual([
		{ roads: ['r'], lanes: ['far'], control: 'none' },
		{ roads: ['r'], lanes: ['near'], control: 'none' }
	]);
	expect(g.badgeAt(p(-24.66, -3.75))).toBe('none');
	expect(g.badgeAt(p(-20.4, 3.75))).toBe('none');
	expect(g.ui.stale()).toEqual([]);
});

test('moved off the street, the footpath drops its control, and back across it gives way', () => {
	// A street from (-30, 0) to a dead end at (30, 0), crossed at x 0 by a
	// footpath saved stopping both ways.
	const g = on(
		crossed(twoWay, 'straight', [{ roads: ['r'], lanes: ['back', 'forward'], control: 'stop' }], 30)
	);
	const count = () => zebras(g.drawing()).length;
	expect(linesNear(g.drawing(), p(0, 0))).toEqual(['stop', 'stop']);
	// Past the street's dead end: no crossing, and the entry goes.
	g.click(p(0, 10));
	g.drag(p(0, 10), p(40, 10), 10);
	expect(count()).toBe(0);
	expect(g.stored()).toEqual([]);
	// Back across: a crossing given way to, nothing stored.
	g.drag(p(40, 10), p(0, 10), 10);
	g.ui.key('Escape');
	expect(count()).toBe(1);
	expect(linesNear(g.drawing(), p(0.3, -1.75))).toEqual(['yield', 'yield']);
	expect(g.stored()).toEqual([]);
});

test('a footpath crossing two streets holds a control for each', () => {
	// Streets along y 0 and y 12 from x -30 to 30, a footpath across both at
	// x 0.
	const g = on({
		nodes: [
			{ id: 'a', x: -30, y: 0 },
			{ id: 'b', x: 30, y: 0 },
			{ id: 'c', x: -30, y: 12 },
			{ id: 'd', x: 30, y: 12 },
			{ id: 'p', x: 0, y: -16 },
			{ id: 'q', x: 0, y: 18 }
		],
		segments: [
			{ id: 'r', startNodeId: 'a', endNodeId: 'b', lanes: structuredClone(twoWay) },
			{ id: 's', startNodeId: 'c', endNodeId: 'd', lanes: structuredClone(twoWay) },
			{ id: 'w', startNodeId: 'p', endNodeId: 'q', lanes: structuredClone(path) }
		]
	});
	const kinds = () =>
		g
			.graph()
			.segments.filter((s) => !carries(s.lanes))
			.flatMap((s) => (s.controls ?? []).map((c) => c.control))
			.sort();
	expect(zebras(g.drawing())).toHaveLength(2);
	g.setControl(p(0.3, -1.75), 'stop');
	g.setControl(p(0.3, 10.25), 'signal');
	expect(g.badgeAt(p(0.3, -1.75))).toBe('stop');
	expect(kinds()).toEqual(['signal', 'stop']);
	g.undo();
	expect(kinds()).toEqual(['stop']);
	expect(g.ui.stale()).toEqual([]);
});

// A control stays with the street it was set on: a footpath across two
// parallel streets, Stop on the first and Signal on the second, the first
// dragged across the second to lie beyond it, in one pointer update and in
// eight: each crossing keeps its own street's control.
test('a footpath crossing two streets, one dragged past the other, keeps each street its control', () => {
	for (const steps of [1, 8]) {
		const g = on({
			nodes: [
				{ id: 'a', x: -60, y: 0 },
				{ id: 'b', x: 60, y: 0 },
				{ id: 'c', x: -60, y: 9 },
				{ id: 'd', x: 60, y: 9 },
				{ id: 'p', x: 0, y: -24 },
				{ id: 'q', x: 0, y: 30 }
			],
			segments: [
				{ id: 'r', startNodeId: 'a', endNodeId: 'b', lanes: structuredClone(twoWay) },
				{ id: 's', startNodeId: 'c', endNodeId: 'd', lanes: structuredClone(twoWay) },
				{ id: 'w', startNodeId: 'p', endNodeId: 'q', lanes: structuredClone(path) }
			]
		});
		g.setControl(p(0.3, -1.75), 'stop');
		g.setControl(p(0.3, 7.25), 'signal');
		const stored = g.stored();
		g.click(p(-20, 0));
		g.drag(p(-20, 0), p(-20, 18), steps);
		g.ui.key('Escape');
		expect([steps, g.node('a').y, g.node('b').y]).toEqual([steps, 18, 18]);
		expect([steps, g.badgeAt(p(0.3, 16.25))]).toEqual([steps, 'stop']);
		expect([steps, g.badgeAt(p(0.3, 7.25))]).toEqual([steps, 'signal']);
		expect(g.stored()).toEqual(stored);
	}
});

// A footpath bowed over one carriageway twice holds one control for both
// crossings (setting either sets both), and a cut or a paste hands that
// control on whole: drawn through the bow's lowest point, the footpath is
// cut in two, each piece's one crossing holding it; pasted so that one leg
// alone crosses the street, the copy's crossing holds it too.
test('a bowed footpath cut, or pasted with one leg across, keeps its one control on each crossing', () => {
	const g = on(crossed(twoWay, 'bowed', undefined, 55));
	g.setControl(p(-22.5, -1.75), 'stop');
	g.setControl(p(22.5, 1.75), 'signal');
	expect([g.badgeAt(p(-22.5, -1.75)), g.badgeAt(p(22.5, 1.75))]).toEqual(['signal', 'signal']);
	const entry: CrossingControl = { roads: ['r'], lanes: ['back', 'forward'], control: 'signal' };
	expect(g.stored()).toEqual([entry]);
	// Pasted 70 m east: its west leg alone crosses the street, near x 40.
	g.click(p(0, 20));
	g.ui.key('c', { ctrl: true });
	g.ui.key('Escape');
	g.ui.key('v', { ctrl: true });
	g.ui.hover(70, -5);
	g.ui.click(70, -5, { ctrl: true });
	g.ui.key('Escape');
	expect(g.graph().segments).toHaveLength(3);
	expect(g.badgeAt(p(40.1, -1.75))).toBe('signal');
	expect(g.stored()).toEqual([entry, entry]);
	g.undo();
	// Drawn through the bow's lowest point, (0, 20): cut in two.
	g.ui.draw('Path', [p(0, 7), p(0, 21)]);
	expect(g.graph().segments.filter((s) => !carries(s.lanes))).toHaveLength(4);
	expect([g.badgeAt(p(-22.5, -1.75)), g.badgeAt(p(22.5, 1.75))]).toEqual(['signal', 'signal']);
	expect(g.stored()).toEqual([entry, entry]);
	expect(g.ui.stale()).toEqual([]);
});

// A four-way of three Streets and a Highway (south), a slanted 4 m Path
// crossing the east arm a little way out, its band tipping towards the
// junction's mouth, storing a stop. Every lane edit of an arm (the north arm
// widened to an Avenue and narrowed back, each arm given other presets),
// undone and redone, and every drag of an arm's far node keeps the crossing
// of the east arm and its stop, the editor's drawing the one a fresh build
// makes, and nothing of the crossing painted on the junction, which paints
// no crossing whatever its arms do (drawJunction in road-model/node.ts).
test("a crossing near a junction keeps its stop and a fresh drawing through every edit of the junction's arms", () => {
	const preset = (id: string) => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
	const g = on({
		nodes: [
			{ id: 'j', x: 0, y: 0 },
			{ id: 'E', x: 80, y: 0 },
			{ id: 'W', x: -60, y: 0 },
			{ id: 'N', x: 0, y: -60 },
			{ id: 'S', x: 0, y: 60 },
			{ id: 'p', x: 18.31, y: -3.55 },
			{ id: 'q', x: 43.31, y: 12 }
		],
		segments: [
			{ id: 'e', startNodeId: 'j', endNodeId: 'E', lanes: preset('street') },
			{ id: 'w', startNodeId: 'j', endNodeId: 'W', lanes: preset('street') },
			{ id: 'n', startNodeId: 'j', endNodeId: 'N', lanes: preset('street') },
			{ id: 's', startNodeId: 'j', endNodeId: 'S', lanes: preset('highway') },
			{
				id: 'walk',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: [{ ...preset('path')[0], width: 4 }],
				controls: [{ roads: ['e'], control: 'stop' }]
			}
		]
	});
	const problems: string[] = [];
	const holds = (label: string) => {
		const stale = g.ui.stale();
		if (stale.length) problems.push(`${label}: drawn otherwise than fresh (${stale})`);
		const scene = buildModel(g.graph()).scene;
		const crossed = scene
			.walking()
			.runsOf('walk')
			.map((c) => c.roads.join());
		if (crossed.join('|') !== 'e') problems.push(`${label}: crossing ${crossed.join('|')}`);
		if (scene.node('j')!.crossings.some((c) => c.of?.startsWith('walk~')))
			problems.push(`${label}: painted on the junction`);
		const stored = g.stored().map((c) => `${c.roads}:${c.control}`);
		if (stored.join() !== 'e:stop') problems.push(`${label}: stores ${stored.join()}`);
	};
	holds('opened');
	const arms = { e: p(50, 0), w: p(-40, 0), n: p(0, -40), s: p(0, 40) };
	const setLanes = (arm: keyof typeof arms, id: string) => {
		g.click(arms[arm]);
		g.ui.editor.editLanes((lanes) => lanes.splice(0, lanes.length, ...preset(id)));
		g.ui.key('Escape');
	};
	const history = (label: string) => {
		holds(label);
		g.undo();
		holds(`${label}, undone`);
		g.redo();
		holds(`${label}, redone`);
	};
	// The north arm widened, then narrowed back by an edit of its own.
	setLanes('n', 'avenue');
	history('north widened to an Avenue');
	setLanes('n', 'street');
	history('north narrowed back to a Street');
	g.undo();
	g.undo();
	for (const [arm, ids] of [
		['n', ['highway', 'lane']],
		['w', ['avenue', 'highway', 'lane']],
		['s', ['street', 'avenue', 'lane']],
		['e', ['avenue']]
	] as const)
		for (const id of ids) {
			setLanes(arm, id);
			history(`${arm} made ${id}`);
			g.undo();
			holds(`${arm} made ${id}, undone again`);
		}
	// Each arm's far node dragged along the arm and across it.
	for (const [id, at, moves] of [
		['E', p(80, 0), [p(10, 0), p(0, 10)]],
		['W', p(-60, 0), [p(10, 0), p(0, 10), p(-10, -10)]],
		['N', p(0, -60), [p(10, 0), p(0, 10), p(-10, -10)]],
		['S', p(0, 60), [p(10, 0), p(0, 10), p(-10, -10)]]
	] as const)
		for (const by of moves) {
			const to = p(at.x + by.x, at.y + by.y);
			g.drag(at, to);
			g.ui.key('Escape');
			if (Math.hypot(g.node(id).x - to.x, g.node(id).y - to.y) > 0.5)
				problems.push(`${id} not dragged to ${to.x}, ${to.y}`);
			holds(`${id} dragged by ${by.x}, ${by.y}`);
			g.undo();
			holds(`${id} dragged by ${by.x}, ${by.y}, undone`);
		}
	expect(problems).toEqual([]);
});

// A crossing near a bend holds the traffic coming round it from the road
// beyond, so it is laid on that road and the nodes at its ends: cut in two
// with the Split tool, the road's far piece and the node between them are
// what it is laid on, and the drawing stays as a fresh build draws it.
test('a crossing near a bend stays drawn as fresh when the road beyond the bend is split', () => {
	const preset = (id: string) => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
	const problems: string[] = [];
	for (const kind of ['street', 'avenue'])
		for (const x of [6, 16, 22])
			for (const lean of [0, 8]) {
				const g = on({
					nodes: [
						{ id: 'j', x: 0, y: 0 },
						{ id: 'E', x: 120, y: 0 },
						{ id: 'W', x: -80, y: 0 },
						{ id: 'p', x, y: -10 },
						{ id: 'q', x: x + lean, y: 10 }
					],
					segments: [
						{ id: 'e', startNodeId: 'j', endNodeId: 'E', lanes: preset(kind) },
						{ id: 'w', startNodeId: 'j', endNodeId: 'W', lanes: preset('street') },
						{
							id: 'walk',
							startNodeId: 'p',
							endNodeId: 'q',
							lanes: [{ ...preset('path')[0], width: 3 }],
							controls: [{ roads: ['e'], control: 'stop' }]
						}
					]
				});
				const label = `${kind}, the path from ${x} leaning ${lean}`;
				const fresh = (step: string) => {
					const stale = g.ui.stale();
					if (stale.length) problems.push(`${label}, ${step}: ${stale}`);
				};
				g.split(p(-40, 0));
				if (g.graph().segments.length !== 4) problems.push(`${label}: not split`);
				fresh('split');
				g.undo();
				fresh('undone');
				g.redo();
				fresh('redone');
			}
	expect(problems).toEqual([]);
});

// An edit reads again the crossings whose ground it can change, and no
// others (Networks.build): those cut from a car piece drawn afresh or gone
// whose box meets their bands'.
test('an edit reads again only the crossings on the car ground it changed', () => {
	const preset = (id: string) => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
	const pathOf = (width = 2) => [{ ...preset('path')[0], width }];
	// The footpath segments whose crossings the builds an action runs read
	// again (Networks.reread), each build's.
	const reading = (ui: ReturnType<typeof openEditor>, action: () => void) => {
		const networks = (ui.editor.roadRenderer as unknown as { builder: Networks }).builder;
		const build = networks.build;
		const read = new Set<string>();
		networks.build = (graph) => {
			const out = build.call(networks, graph);
			for (const id of networks.reread) read.add(id);
			return out;
		};
		action();
		networks.build = build;
		return [...read].sort();
	};
	const nudge = (ui: ReturnType<typeof openEditor>, id: string, by: Pt) =>
		reading(ui, () => {
			const node = ui.node(id);
			node.x += by.x;
			node.y += by.y;
			ui.editor.rebuildRoads();
		});
	const setLanes = (ui: ReturnType<typeof openEditor>, at: Pt, id: string) => {
		ui.hover(at.x, at.y);
		ui.click(at.x, at.y);
		return reading(ui, () => {
			ui.editor.editLanes((lanes) => lanes.splice(0, lanes.length, ...preset(id)));
			ui.key('Escape');
		});
	};

	// The example city's busiest node nudged as a drag frame nudges it
	// (Editor.perfMove): no crossing lies on what it moves.
	const example = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8'));
	const city = openEditor(example.graph);
	expect(reading(city, () => city.editor.perfMove('move'))).toEqual([]);

	// A 12 by 12 grid of 80 m Streets with a footpath across the middle of
	// each: an Avenue made of one reads again those on the roads drawn
	// afresh, its own and those meeting it.
	const nodes: GraphData['nodes'] = [];
	const segments: GraphData['segments'] = [];
	for (let i = 0; i < 12; i++)
		for (let j = 0; j < 12; j++) {
			nodes.push({ id: `g${i}_${j}`, x: i * 80, y: j * 80 });
			for (const [k, di, dj] of [
				['h', 1, 0],
				['v', 0, 1]
			] as const) {
				if (i + di > 11 || j + dj > 11) continue;
				const id = `${k}${i}_${j}`;
				const mid = p(i * 80 + di * 40, j * 80 + dj * 40);
				segments.push({
					id,
					startNodeId: `g${i}_${j}`,
					endNodeId: `g${i + di}_${j + dj}`,
					lanes: preset('street')
				});
				nodes.push(
					{ id: `${id}a`, x: mid.x - dj * 14, y: mid.y - di * 14 },
					{ id: `${id}b`, x: mid.x + dj * 14, y: mid.y + di * 14 }
				);
				segments.push({
					id: `w${id}`,
					startNodeId: `${id}a`,
					endNodeId: `${id}b`,
					lanes: pathOf()
				});
			}
		}
	const grid = openEditor({ nodes, segments });
	const roads = () =>
		new Map(
			grid.editor.roadRenderer.scene!.place.roads.map((r) => [
				r.id,
				grid.editor.roadRenderer.scene!.road(r.id)
			])
		);
	const was = roads();
	const edited = setLanes(grid, p(6 * 80 + 20, 6 * 80), 'avenue');
	const afresh = [...roads()]
		.filter(([id, d]) => !id.startsWith('w') && d !== was.get(id))
		.map(([id]) => `w${id}`);
	expect(afresh.length).toBe(7);
	expect(edited).toEqual(afresh.sort());

	// A four-way with 60 footpaths across its long east arm: its north arm's
	// far node moved across the arm reads none of them again.
	const long = openEditor({
		nodes: [
			{ id: 'j', x: 0, y: 0 },
			{ id: 'E', x: 2000, y: 0 },
			{ id: 'W', x: -60, y: 0 },
			{ id: 'N', x: 0, y: -60 },
			{ id: 'S', x: 0, y: 60 },
			...Array.from({ length: 60 }, (_, k) => [
				{ id: `a${k}`, x: 70 + 22 * k, y: -10 },
				{ id: `b${k}`, x: 70 + 22 * k, y: 14 }
			]).flat()
		],
		segments: [
			{ id: 'e', startNodeId: 'j', endNodeId: 'E', lanes: preset('street') },
			{ id: 'w', startNodeId: 'j', endNodeId: 'W', lanes: preset('street') },
			{ id: 'n', startNodeId: 'j', endNodeId: 'N', lanes: preset('street') },
			{ id: 's', startNodeId: 'j', endNodeId: 'S', lanes: preset('highway') },
			...Array.from({ length: 60 }, (_, k) => ({
				id: `x${k}`,
				startNodeId: `a${k}`,
				endNodeId: `b${k}`,
				lanes: pathOf()
			}))
		]
	});
	expect(buildModel(long.graph()).scene.walking().runsOf('x0').length).toBe(1);
	expect(nudge(long, 'N', p(0.75, 0))).toEqual([]);

	// The slanted crossing beside a four-way's mouth, cut from the
	// junction's ground clear of its paving: read again when the junction
	// changes.
	const slanted = openEditor({
		nodes: [
			{ id: 'j', x: 0, y: 0 },
			{ id: 'E', x: 80, y: 0 },
			{ id: 'W', x: -60, y: 0 },
			{ id: 'N', x: 0, y: -60 },
			{ id: 'S', x: 0, y: 60 },
			{ id: 'p', x: 18.31, y: -3.55 },
			{ id: 'q', x: 43.31, y: 12 }
		],
		segments: [
			{ id: 'e', startNodeId: 'j', endNodeId: 'E', lanes: preset('street') },
			{ id: 'w', startNodeId: 'j', endNodeId: 'W', lanes: preset('street') },
			{ id: 'n', startNodeId: 'j', endNodeId: 'N', lanes: preset('street') },
			{ id: 's', startNodeId: 'j', endNodeId: 'S', lanes: preset('highway') },
			{ id: 'walk', startNodeId: 'p', endNodeId: 'q', lanes: pathOf(4) }
		]
	});
	expect(setLanes(slanted, p(0, -40), 'highway')).toEqual(['walk']);
});
