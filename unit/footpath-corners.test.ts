import { expect, test } from 'bun:test';
import type { GraphData, Lane } from '../src/lib/core/types';
import { nearestOf, walkAt } from '../src/lib/road-model/overlay';
import { buildModel } from './model';
import { openEditor } from './editor.svelte';

// A footpath's end joined to a junction's corner sidewalk: whatever draws
// the corner anew (a road of the junction moved, a road beside it renamed by
// a cut) keeps the end on it at its place round it (Editor.followWalkways),
// and every move it makes there is that edit's: a gesture refused or
// cancelled with Escape leaves the graph as the press found it, byte for
// byte, with no undo step and nothing unsaved; one kept holds the end's move
// in its one undo step; and nothing is left for a later click to record. A
// street's sidewalk and the corner it runs into are one walkway, which the
// end slides along from one onto the other and back (modes/picking.ts).

type Pt = { x: number; y: number };
type Ui = ReturnType<typeof openEditor>;
const p = (x: number, y: number): Pt => ({ x, y });
// Metres a pixel at the browser's top-down camera at `zoom` (720 px for
// 500 m at zoom 1), so snap rings measured in pixels are the page's.
const perPixel = (zoom: number) => 500 / 720 / zoom;
const ZOOM = 8;

const lane = (id: string, role: Lane['role'], width: number, direction: Lane['direction']) =>
	({ id, role, width, direction, material: role === 'vehicle' ? 'asphalt' : 'concrete' }) as Lane;
// A two-way street 11 m wide (sidewalks 2 m, lanes 3.5 m), and a 2 m
// footpath.
const STREET = [
	lane('left', 'pedestrian', 2, 'bidirectional'),
	lane('back', 'vehicle', 3.5, 'backward'),
	lane('forward', 'vehicle', 3.5, 'forward'),
	lane('right', 'pedestrian', 2, 'bidirectional')
];
const PATH = [lane('path', 'pedestrian', 2, 'bidirectional')];

const graphOf = (
	points: [string, number, number][],
	roads: [string, string, string, Lane[], Record<string, number>?][]
): GraphData => ({
	nodes: points.map(([id, x, y]) => ({ id, x, y })),
	segments: roads.map(([id, startNodeId, endNodeId, lanes, more]) => ({
		id,
		startNodeId,
		endNodeId,
		lanes: structuredClone(lanes),
		...more
	}))
});

// Streets meeting at j: west and east along x, south down y.
const junction = (): GraphData =>
	graphOf(
		[
			['j', 0, 0],
			['a', -27, 0],
			['b', 27, 0],
			['c', 0, 26]
		],
		[
			['west', 'a', 'j', STREET],
			['east', 'j', 'b', STREET],
			['south', 'j', 'c', STREET]
		]
	);
// A point on the east-south corner's middle, about a third of the way round
// from east: off its middle, so an end kept there is told from one put
// anywhere else on the corner.
const ON_CORNER = { x: 6.68, y: 4.94 };
// The junction with a footpath out from its east-south corner, at
// ON_CORNER, to (19, 19).
const withPath = () => {
	const g = junction();
	g.nodes.push({ id: 'end', ...ON_CORNER }, { id: 'far', x: 19, y: 19 });
	g.segments.push({ id: 'w', startNodeId: 'end', endNodeId: 'far', lanes: structuredClone(PATH) });
	return g;
};

// How far round the east-south corner of the junction, as a fresh build
// draws it, the point of its middle nearest `q` lies.
const roundAt = (q: Pt) => {
	const corner = buildModel(junction())
		.scene.node('j')!
		.walkways!.find((w) => w.a.road === 'east' && w.b.road === 'south')!;
	const near = nearestOf([corner.line], (l) => l, q)!;
	return near.along / near.length;
};

// What a fresh build of the editor's graph finds node `id`'s first footpath
// end lying on, once the editor draws it so too, and, on a corner, which
// streets' sidewalks the corner joins and how far round it the end joins it
// (`joinOf` in e2e/paths.ts).
function joinOf(ui: Ui, id: string) {
	expect(ui.stale()).toEqual([]);
	const on = buildModel(ui.graph()).derived.sidewalks.get(id)?.[0];
	const corner = on?.corner;
	const near = corner && nearestOf([corner.line], (l) => l, on.line.at(-1)!);
	return {
		on,
		corner: corner && [corner.a.road, corner.b.road].sort().join('/'),
		round: near ? near.along / near.length : null
	};
}

// Gestures at world points, a click and a drag first moving the pointer
// there as the page's do.
function open(graph: GraphData, zoom = ZOOM) {
	const ui = openEditor(graph, perPixel(zoom));
	const click = (q: Pt) => {
		ui.hover(q.x, q.y);
		ui.click(q.x, q.y);
	};
	const drag = (from: Pt, to: Pt, steps = 8) => {
		ui.hover(from.x, from.y);
		ui.drag(from, to, {}, steps);
	};
	const endAt = () => ui.graph().nodes.find((n) => n.id === 'end')!;
	const snapshot = () => JSON.stringify(ui.graph());
	return { ui, click, drag, endAt, snapshot };
}

test("an end slides from the corner onto either street's sidewalk and back without a stop", () => {
	const { drag, endAt, ui } = open(withPath());
	const backOnCorner = (label: string) => {
		const back = endAt();
		expect([label, Math.hypot(back.x - ON_CORNER.x, back.y - ON_CORNER.y) < 0.1]).toEqual([
			label,
			true
		]);
		const join = joinOf(ui, 'end');
		expect([label, join.corner]).toEqual([label, 'east/south']);
		expect(join.round).toBeCloseTo(roundAt(ON_CORNER), 1);
	};
	// Onto south's sidewalk, and back onto the corner.
	drag(ON_CORNER, { x: 8, y: 16 }, 9);
	const south = endAt();
	expect(south.x).toBeCloseTo(4.5, 1);
	expect(south.y).toBeCloseTo(16, 0);
	drag(south, ON_CORNER, 9);
	backOnCorner('back from the south sidewalk');
	// Onto east's sidewalk (its right lane), and on round its corner.
	drag(ON_CORNER, { x: 16, y: 8 }, 9);
	const east = endAt();
	expect(east.x).toBeCloseTo(16, 0);
	expect(east.y).toBeCloseTo(4.5, 1);
	const on = joinOf(ui, 'end').on;
	expect([on?.road, on?.lane]).toEqual(['east', 'right']);
	drag(east, ON_CORNER, 9);
	backOnCorner('back from the east sidewalk');
});

// The follower's scene: a T at j (west, east and south), `bar` (unless left
// out) a street up x = 8 from y = -25 to -2, which east moved up crosses,
// and a footpath heading north-east from the east-south corner (at
// ON_CORNER) across east, its far node clear of east's ground (which a node
// lying on rides). Shifted, its line sits 4 m to its left, its node 4 m out
// from the corner, off every street's ground, where its end shows on the
// corner (core/road-line.ts).
const scene = (shifted: boolean, withBar = true): GraphData => {
	const shift = shifted ? -4 : 0;
	const right = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
	const end = { x: ON_CORNER.x - right.x * shift, y: ON_CORNER.y - right.y * shift };
	return graphOf(
		[
			['j', 0, 0],
			['a', -27, 0],
			['b', 27, 0],
			['c', 0, 26],
			...(withBar
				? ([
						['bar0', 8, -25],
						['bar1', 8, -2]
					] as [string, number, number][])
				: []),
			['end', end.x, end.y],
			['far', end.x + 16, end.y - 16]
		],
		[
			['west', 'a', 'j', STREET],
			['east', 'j', 'b', STREET],
			['south', 'j', 'c', STREET],
			...(withBar ? [['bar', 'bar0', 'bar1', STREET] as [string, string, string, Lane[]]] : []),
			['w', 'end', 'far', PATH, shifted ? { offsetStart: shift, offsetEnd: shift } : {}]
		]
	);
};

// A drag of something at the junction: `select` clicked first, pressed at
// `from` and held at `refuse` (where a road of the junction crosses `bar`)
// or `keep` (where it crosses nothing). A setback handle's drag reshapes no
// road's line, so nothing refuses it.
interface Drag {
	name: string;
	select?: Pt;
	from: (ui: Ui) => Pt;
	refuse?: Pt;
	keep: Pt;
}
const fixed = (q: Pt) => () => q;
const drags: Drag[] = [
	{ name: "a road's end", from: fixed(p(27, 0)), refuse: p(27, -30), keep: p(27, 6) },
	{ name: "the junction's node", from: fixed(p(0, 0)), refuse: p(-3, -20), keep: p(1, -1) },
	{ name: 'a road', from: fixed(p(18, 0)), refuse: p(18, -14), keep: p(18, -1) },
	{
		name: 'a curve handle',
		select: p(18, 0),
		from: fixed(p(13.5, 0)),
		refuse: p(13.5, -30),
		keep: p(13.5, -2)
	},
	{
		name: 'a shift handle',
		select: p(18, 0),
		from: fixed(p(6.75, 0)),
		refuse: p(6.75, -6),
		keep: p(6.75, -1)
	},
	{
		name: 'a setback handle',
		select: p(0, 0),
		// East's setback guide, across east where it stops short of j.
		from: (ui) => {
			const guide = ui.editor.guideRenderer.shown.find(
				([a, b]) => Math.abs(a.x - b.x) < 0.01 && a.x > 0
			)!;
			return { x: guide[0].x, y: 0 };
		},
		keep: p(16, 0)
	}
];

// Each drag ends each way it can on one city, the refused and escaped ones
// leaving it as it was for the next: refused (where it can be), escaped,
// then kept.
for (const drag of drags)
	for (const shifted of [false, true])
		test(`${drag.name}: ${drag.refuse ? 'refused, escaped' : 'escaped'} and kept, ${shifted ? 'shifted' : 'unshifted'} corner end`, () => {
			const { ui, click, endAt, snapshot } = open(scene(shifted));
			const joined = joinOf(ui, 'end');
			expect(joined.corner).toBe('east/south');
			const endings = drag.refuse
				? (['refused', 'escape', 'kept'] as const)
				: (['escape', 'kept'] as const);
			for (const ending of endings) {
				if (drag.select) click(drag.select);
				const before = snapshot();
				const end = endAt();

				const from = drag.from(ui);
				const to = ending === 'kept' ? drag.keep : (drag.refuse ?? drag.keep);
				ui.hover(from.x, from.y);
				ui.fire('mousedown', from.x, from.y);
				for (let k = 1; k <= 10; k++)
					ui.fire(
						'mousemove',
						from.x + ((to.x - from.x) * k) / 10,
						from.y + ((to.y - from.y) * k) / 10
					);
				// The corner drawn anew under it, the end is kept on it.
				const now = endAt();
				expect([ending, Math.hypot(now.x - end.x, now.y - end.y) > 0.01]).toEqual([ending, true]);
				if (ending === 'refused') expect(ui.editor.refused).toContain('east');
				if (ending === 'escape') ui.key('Escape');
				ui.fire('mouseup', to.x, to.y);

				if (ending === 'kept') {
					const after = snapshot();
					expect(after).not.toBe(before);
					expect(ui.editor.canUndo).toBe(true);
					expect(ui.editor.dirty).toBe(true);
					// On the corner, as far round it as it was.
					const now = joinOf(ui, 'end');
					expect(now.corner).toBe('east/south');
					expect(now.round).toBeCloseTo(joined.round!, 1);
					// Nothing waits for a later click to record.
					click(p(-20, -20));
					expect(snapshot()).toBe(after);
					// One Undo takes the drag back whole, the end's move with it.
					ui.key('z', { ctrl: true });
					expect(snapshot()).toBe(before);
					expect(ui.editor.canUndo).toBe(false);
					expect(ui.stale()).toEqual([]);
					continue;
				}
				expect([ending, snapshot()]).toEqual([ending, before]);
				expect([ending, ui.editor.canUndo, ui.editor.dirty]).toEqual([ending, false, false]);
				// Nothing waits for a later click to record.
				click(p(-20, -20));
				expect([ending, snapshot()]).toEqual([ending, before]);
				expect([ending, ui.editor.canUndo, ui.editor.dirty]).toEqual([ending, false, false]);
			}
		});

test('a street drawn onto a road of the junction, cutting it, keeps the end on its corner', () => {
	const { ui, snapshot } = open(scene(false, false), 4);
	const joined = joinOf(ui, 'end');
	expect(joined.corner).toBe('east/south');
	const before = snapshot();
	ui.draw('Street', [p(12, -23), p(12, 0)], [false, true]);
	const graph = ui.graph();
	// East is cut where the street meets it: no road of the junction keeps
	// the name the corner was read by.
	expect(graph.segments.some((x) => x.id === 'east')).toBe(false);
	const now = joinOf(ui, 'end');
	const [first, second] = now.corner?.split('/') ?? [];
	expect([first, second].filter((id) => id !== 'south')).toHaveLength(1);
	expect([first, second]).toContain('south');
	expect(now.round).toBeCloseTo(joined.round!, 1);
	// The end's move is the draw's: one Undo takes both back.
	ui.key('z', { ctrl: true });
	expect(snapshot()).toBe(before);
	expect(ui.stale()).toEqual([]);
});

// Three roads meeting, two avenues (sidewalk, grass verge, lanes, median)
// curved and shifted differently at their two ends, so their lanes run at a
// slant to the lines they are drawn on: a footpath ending on the corner just
// in front of one avenue's end, near the sidewalk's outer edge, is joined to
// that corner, as one anywhere on the corner is.
test("a footpath ending on a corner by a slanted avenue's end joins the corner", () => {
	const AVENUE = [
		lane('walk', 'pedestrian', 3, 'bidirectional'),
		{ ...lane('verge', 'buffer', 1, 'bidirectional'), material: 'grass' } as Lane,
		lane('b1', 'vehicle', 3.5, 'backward'),
		lane('b2', 'vehicle', 3.5, 'backward'),
		lane('median', 'buffer', 2, 'bidirectional'),
		lane('f1', 'vehicle', 3.5, 'forward'),
		lane('f2', 'vehicle', 3.5, 'forward'),
		{ ...lane('verge2', 'buffer', 1, 'bidirectional'), material: 'grass' } as Lane,
		lane('walk2', 'pedestrian', 3, 'bidirectional')
	];
	const g = graphOf(
		[
			['centre', 0, 0],
			['a0', 27.157876842809287, -57.41423096228928],
			['a2', -7.745679463592828, 25.087770913819234],
			['a3', -90.15475979259541, -41.56185154082495],
			['end', 5.748, 21.025],
			['far', 12.748, 22.025]
		],
		[
			[
				'arm-0',
				'centre',
				'a0',
				AVENUE,
				{
					controlX: 4.136938556206841,
					controlY: -33.17333692469734,
					offsetStart: -0.7040263414382935,
					offsetEnd: -3.5574387926608324
				}
			],
			[
				'arm-2',
				'centre',
				'a2',
				AVENUE,
				{
					controlX: -3.5016349405119263,
					controlY: 12.658492423726894,
					offsetStart: 2.661855272948742,
					offsetEnd: -1.4632512126117945
				}
			],
			[
				'arm-3',
				'a3',
				'centre',
				STREET,
				{
					controlX: -62.38623233072511,
					controlY: 16.76493360927553,
					offsetStart: 2.73279083147645,
					offsetEnd: 0.5473071206361055
				}
			],
			['w', 'end', 'far', PATH]
		]
	);
	const on = buildModel(g).derived.sidewalks.get('end')?.[0];
	expect(on?.road).toBe('arm-2');
	expect(on?.corner).toBeDefined();
});

// Four streets meeting where two of them, curved and shifted, bend in so
// close that the junction's curb outline turns back through itself: the curb
// between two of them runs from one road's side of the outline to the other's,
// so the sidewalk lies on one side of it at one end and on the other side at
// the other. The corner is paved all the same, from one road's sidewalk round
// to the other's, and a footpath ending on it joins it.
const pinched = (
	nodes: [string, number, number][],
	roads: [string, string, string, Record<string, number>][],
	end: Pt
) => {
	const g = graphOf(
		[...nodes, ['end', end.x, end.y], ['far', end.x + 7, end.y + 1]],
		roads.map(([id, from, to, more]) => [id, from, to, STREET, more])
	);
	g.segments.push({ id: 'w', startNodeId: 'end', endNodeId: 'far', lanes: structuredClone(PATH) });
	const { scene, derived } = buildModel(g);
	const pieces = [
		...scene.place.roads.map((r) => scene.road(r.id)),
		...scene.place.junctions.map((j) => scene.node(j.id))
	];
	return {
		walked: (q: Pt) => pieces.some((d) => d && walkAt(d, q)),
		joined: derived.sidewalks.get('end')?.[0]
	};
};

test('a corner whose curb turns back through a pinched junction is paved round, and a footpath on it joins it', () => {
	const corner = pinched(
		[
			['centre', 0, 0],
			['arm-0', 66.06071075619602, 14.716213555190805],
			['arm-1', -43.7224893917118, -9.768103471084949],
			['arm-2', -101.1040715190706, -29.21528722576607],
			['arm-3', 14.654651766518318, -39.42588911860734]
		],
		[
			['arm-0', 'centre', 'arm-0', { offsetStart: 0, offsetEnd: 3.2694564163684845 }],
			['arm-1', 'arm-1', 'centre', { offsetStart: 0, offsetEnd: 1.0000301469117403 }],
			[
				'arm-2',
				'centre',
				'arm-2',
				{
					offsetStart: -1.8763252645730972,
					offsetEnd: 3.577530248090625,
					controlX: -52.93865342553402,
					controlY: -6.3483798470624
				}
			],
			[
				'arm-3',
				'arm-3',
				'centre',
				{
					offsetStart: -0.2292482890188694,
					offsetEnd: -3.619735350832343,
					controlX: -8.878325364966742,
					controlY: -25.736605179307524
				}
			]
		],
		p(8.136, -2.445)
	);
	// Round the corner from arm-3's sidewalk to arm-0's.
	for (const q of [p(4.73, -8.04), p(5.62, -7.25), p(4.38, -4.36), p(7.8, -3.31), p(11.77, -2.17)])
		expect(corner.walked(q), `${q.x}, ${q.y}`).toBe(true);
	expect(corner.joined?.road).toBe('arm-0');
	expect(corner.joined?.corner).toBeDefined();
});

test("the sidewalks wrapping a road's nose into a pinched junction are paved, and a footpath on one joins it", () => {
	const nose = pinched(
		[
			['centre', 0, 0],
			['arm-0', 12.71828118240662, -62.85681968360269],
			['arm-1', -16.58526235756413, 84.59231418605542],
			['arm-2', -25.960148148159686, 101.6201495294759],
			['arm-3', -98.74358502811151, -0.7907556809908708]
		],
		[
			['arm-0', 'centre', 'arm-0', { offsetStart: 0, offsetEnd: -3.545855313539505 }],
			['arm-1', 'arm-1', 'centre', { offsetStart: 0, offsetEnd: 3.6447725761681795 }],
			[
				'arm-2',
				'centre',
				'arm-2',
				{
					offsetStart: -1.7073936015367508,
					offsetEnd: 2.5539458226412535,
					controlX: -11.049164090788299,
					controlY: 51.30335005963868
				}
			],
			[
				'arm-3',
				'arm-3',
				'centre',
				{
					offsetStart: 1.7237624488770962,
					offsetEnd: -0.4212390687316656,
					controlX: -49.46483986118269,
					controlY: 11.223670689331072
				}
			]
		],
		p(-9.11, -2.7085)
	);
	// Both sides of arm-3's end, where its sidewalks wrap round its nose.
	for (const q of [p(-9.38, -3.22), p(-8.86, -2.17), p(-9.68, -2.1), p(-8.1, 6.13), p(-7.73, 5.4)])
		expect(nose.walked(q), `${q.x}, ${q.y}`).toBe(true);
	expect(nose.joined?.road).toBe('arm-3');
	expect(nose.joined?.corner).toBeDefined();
});
