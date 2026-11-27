import { expect, test } from 'bun:test';
import type { GraphData, Lane } from '../src/lib/core/types';
import { openEditor } from './editor.svelte';

// A crossing's badge opened by double-clicking its zebra (Editor.opened)
// stays on that crossing while it is drawn and closes once it is gone, even
// where another crossing of the footpath is drawn with its id: a footpath's
// crossings are numbered along it, so taking one away renumbers the rest.

const lane = (role: Lane['role'], width: number, direction: Lane['direction']): Lane => ({
	role,
	width,
	direction,
	material: role === 'vehicle' ? 'asphalt' : 'concrete'
});

test("a lane edit taking away an opened badge's carriageway closes it", () => {
	// Two one-lane carriageways parted by a walkway, and a path across both.
	const city: GraphData = {
		nodes: [
			{ id: 'a', x: -50, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'p', x: 0, y: -20 },
			{ id: 'q', x: 0, y: 20 }
		],
		segments: [
			{
				id: 'street',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: [
					lane('pedestrian', 2, 'bidirectional'),
					lane('vehicle', 3.5, 'backward'),
					lane('pedestrian', 2, 'bidirectional'),
					lane('vehicle', 3.5, 'forward'),
					lane('pedestrian', 2, 'bidirectional')
				]
			},
			{
				id: 'path',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: [lane('pedestrian', 2, 'bidirectional')]
			}
		]
	};
	const ui = openEditor(city, 0.05);
	ui.click(30, 0);
	const badges = ui.editor.crossingBadges;
	expect(badges.map((b) => Math.sign(b.y))).toEqual([-1, 1]);
	const [first, second] = badges;
	ui.fire('dblclick', first.x + 0.5, first.y);
	expect(ui.editor.opened).toBe(first.id);

	// The first carriageway's only car lane taken away.
	ui.editor.editLanes((lanes) => lanes.splice(1, 1));

	expect(ui.editor.opened).toBeNull();
	// The crossing left, the second carriageway's, shows its own badge.
	expect(ui.editor.crossingBadges).toHaveLength(1);
	expect(ui.editor.crossingBadges[0].y).toBeGreaterThan(0);
	expect(second.y).toBeGreaterThan(0);

	// Opened on the crossing left, it stays open through a lane edit of
	// its carriageway.
	const [left] = ui.editor.crossingBadges;
	ui.fire('dblclick', left.x + 0.5, left.y);
	expect(ui.editor.opened).toBe(left.id);
	ui.editor.editLanes((lanes) => (lanes[2].width = 4));
	expect(ui.editor.opened).toBe(left.id);
	expect(ui.editor.crossingBadges.map((b) => b.id)).toEqual([left.id]);
});

// A badge opened stays on its own zebra, whatever ids the footpath's
// crossings are drawn with as others come and go: at every step of an edit
// it is on the crossing drawn nearest where it was, if one is near, and
// closed if none is.
const NEAR = 4;
const badgeFollows = (ui: ReturnType<typeof openEditor>, steps: (() => void)[], path: string) => {
	const trail: string[] = [];
	for (const step of steps) {
		const was = ui.editor.crossingBadges.find((b) => b.id === ui.editor.opened)!;
		step();
		// The footpath's crossings drawn now, by where their badges sit.
		const drawn = ui.editor.roadRenderer
			.crossingsOn([path])
			.map((id) => ui.editor.roadRenderer.crossingOf(id)!.mid);
		const near = drawn.filter((p) => Math.hypot(p.x - was.x, p.y - was.y) < NEAR);
		const open = ui.editor.crossingBadges.find((b) => b.id === ui.editor.opened);
		trail.push(open ? `open at ${open.x.toFixed(1)},${open.y.toFixed(1)}` : 'closed');
		if (!near.length) {
			expect(trail).toEqual([...trail.slice(0, -1), 'closed']);
			return trail;
		}
		expect(open && Math.hypot(open.x - was.x, open.y - was.y) < NEAR ? 'near' : trail).toBe('near');
	}
	return trail;
};

test('a badge opened on a bowed footpath closes when its zebra goes, never jumping to the other', () => {
	const city: GraphData = {
		nodes: [
			{ id: 'a', x: -60, y: 0 },
			{ id: 'b', x: 60, y: 0 },
			{ id: 'p', x: -35, y: 6 },
			{ id: 'q', x: 35, y: 20 }
		],
		segments: [
			{
				id: 'street',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: [lane('vehicle', 3.5, 'backward'), lane('vehicle', 3.5, 'forward')]
			},
			{
				id: 'path',
				startNodeId: 'p',
				endNodeId: 'q',
				controlX: 0,
				controlY: -36,
				lanes: [lane('pedestrian', 2, 'bidirectional')]
			}
		]
	};
	for (const k of [0, 1]) {
		const ui = openEditor(city, 0.05);
		ui.click(50, 0);
		const badges = [...ui.editor.crossingBadges].sort((p, q) => p.x - q.x);
		expect(badges).toHaveLength(2);
		ui.fire('dblclick', badges[k].x + 0.3, badges[k].y);
		expect(ui.editor.opened).toBe(badges[k].id);
		// The last car lane widened a metre at a time, to 11.5 m.
		const steps = Array.from(
			{ length: 8 },
			(_, i) => () => ui.editor.editLanes((lanes) => (lanes[1].width = 4.5 + i))
		);
		badgeFollows(ui, steps, 'path');
	}
});

test("a badge opened on a divided street's second crossing stays on it when the first carriageway goes", () => {
	const city: GraphData = {
		nodes: [
			{ id: 'a', x: -50, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'p', x: 0, y: -20 },
			{ id: 'q', x: 0, y: 20 }
		],
		segments: [
			{
				id: 'street',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: [
					lane('pedestrian', 2, 'bidirectional'),
					lane('vehicle', 3.5, 'backward'),
					lane('pedestrian', 2, 'bidirectional'),
					lane('vehicle', 3.5, 'forward'),
					lane('pedestrian', 2, 'bidirectional')
				]
			},
			{
				id: 'path',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: [lane('pedestrian', 2, 'bidirectional')]
			}
		]
	};
	const ui = openEditor(city, 0.05);
	ui.click(30, 0);
	const [, second] = [...ui.editor.crossingBadges].sort((p, q) => p.y - q.y);
	ui.fire('dblclick', second.x + 0.5, second.y);
	expect(ui.editor.opened).toBe(second.id);
	const trail = badgeFollows(
		ui,
		[() => ui.editor.editLanes((lanes) => lanes.splice(1, 1))],
		'path'
	);
	expect(trail[0]).toStartWith('open');
});

test('a badge opened stays on its zebra while its footpath slides along the street through a cut', () => {
	// A street cut at (0, 0), drawn as one road, and a path across it that
	// slides from x = -9 to x = 9 a metre at a time.
	const city: GraphData = {
		nodes: [
			{ id: 'a', x: -50, y: 0 },
			{ id: 'm', x: 0, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'p', x: -9, y: -20 },
			{ id: 'q', x: -7, y: 20 }
		],
		segments: [
			...[
				['west', 'a', 'm'],
				['east', 'm', 'b']
			].map(([id, startNodeId, endNodeId]) => ({
				id,
				startNodeId,
				endNodeId,
				lanes: [
					{ ...lane('vehicle', 3.5, 'backward'), id: 'v0' },
					{ ...lane('vehicle', 3.5, 'forward'), id: 'v1' }
				]
			})),
			{
				id: 'path',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: [lane('pedestrian', 2, 'bidirectional')]
			}
		]
	};
	const ui = openEditor(city, 0.05);
	ui.click(-8, -15);
	const [badge] = ui.editor.crossingBadges;
	ui.fire('dblclick', badge.x + 0.3, badge.y);
	expect(ui.editor.opened).toBe(badge.id);
	const steps = Array.from({ length: 18 }, () => () => {
		for (const id of ['p', 'q']) ui.node(id).x += 1;
		ui.editor.rebuildRoads();
	});
	const trail = badgeFollows(ui, steps, 'path');
	expect(trail.every((t) => t.startsWith('open'))).toBe(true);
});

// A badge opened stays on the carriageway its control stays on, whatever an
// edit of its street's lanes does to their ids: the opened crossing set to
// signal, the other left giving way, after the edit the badge is open
// exactly where a crossing of the footpath reads signal, on such a one.
// Swept: a divided street stored either way, the badge opened on either
// carriageway, and lanes pasted from another street (its car lane ids the
// same, swapped or new, or one carriageway alone) or edited in place (a car
// lane widened, one carriageway's car lane taken off, the walkway between
// them made a car lane, merging the two).
const id = (lane: Lane, laneId: string): Lane => ({ ...lane, id: laneId });
const divided = (left: string, right: string) => [
	id(lane('pedestrian', 2, 'bidirectional'), 'w0'),
	id(lane('vehicle', 3.5, 'backward'), left),
	id(lane('pedestrian', 2, 'bidirectional'), 'mid'),
	id(lane('vehicle', 3.5, 'forward'), right),
	id(lane('pedestrian', 2, 'bidirectional'), 'w1')
];
const pasting: [string, Lane[]][] = [
	['the same lanes', divided('va', 'vb')],
	['its car lane ids swapped', divided('vb', 'va')],
	['new car lane ids', divided('x0', 'x1')],
	[
		'one carriageway alone',
		[
			id(lane('pedestrian', 2, 'bidirectional'), 'w0'),
			id(lane('vehicle', 3.5, 'backward'), 'x0'),
			id(lane('pedestrian', 2, 'bidirectional'), 'w1')
		]
	]
];
const editing: [string, (lanes: Lane[]) => void][] = [
	['a car lane widened', (lanes) => (lanes[1].width = 4.5)],
	['the first car lane taken off', (lanes) => lanes.splice(1, 1)],
	['the walkway between made a car lane', (lanes) => (lanes[2] = { ...lanes[3], id: 'm2' })]
];
for (const [edit, run] of [
	...pasting.map(([name, lanes]) => [`lanes pasted with ${name}`, lanes] as const),
	...editing.map(([name, change]) => [name, change] as const)
])
	test(`a badge opened stays on its carriageway's control through ${edit}`, () => {
		const wrong: string[] = [];
		for (const reversed of [false, true])
			for (const side of [0, 1]) {
				const lanes = divided('va', 'vb');
				const city: GraphData = {
					nodes: [
						{ id: 'a', x: -50, y: 0 },
						{ id: 'b', x: 50, y: 0 },
						{ id: 'c', x: -50, y: 80 },
						{ id: 'd', x: 50, y: 80 },
						{ id: 'p', x: 0, y: -20 },
						{ id: 'q', x: 0, y: 20 }
					],
					segments: [
						{
							id: 'street',
							startNodeId: reversed ? 'b' : 'a',
							endNodeId: reversed ? 'a' : 'b',
							lanes
						},
						{
							id: 'other',
							startNodeId: 'c',
							endNodeId: 'd',
							lanes: Array.isArray(run) ? run : lanes
						},
						{
							id: 'path',
							startNodeId: 'p',
							endNodeId: 'q',
							lanes: [lane('pedestrian', 2, 'bidirectional')]
						}
					]
				};
				const ui = openEditor(city, 0.05);
				ui.click(30, 80);
				ui.key('c', { ctrl: true });
				ui.click(30, 0);
				const badge = [...ui.editor.crossingBadges].sort((p, q) => p.y - q.y)[side];
				ui.fire('dblclick', badge.x + 0.5, badge.y);
				ui.editor.cycleCrossing(ui.editor.opened!);
				expect(ui.editor.crossingBadges.map((b) => b.control)).toEqual(['signal']);
				if (Array.isArray(run)) ui.key('v', { ctrl: true });
				else ui.editor.editLanes(run as (lanes: Lane[]) => void);
				// The footpath's crossings drawn now, and the control of each.
				const signalled = ui.editor.roadRenderer
					.crossingsOn(['path'])
					.filter((c) => ui.editor.roadRenderer.crossingOf(c)!.control === 'signal');
				const opened = ui.editor.opened;
				const ok = signalled.length ? !!opened && signalled.includes(opened) : opened === null;
				if (!ok)
					wrong.push(
						`${reversed ? 'reversed ' : ''}side ${side}: opened ${opened}, signal on ${signalled}`
					);
			}
		expect(wrong).toEqual([]);
	});
