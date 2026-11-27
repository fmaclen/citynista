import { describe, expect, test } from 'bun:test';
import { resolveCrossings } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { area, subtract, toPath, union } from '../src/lib/road-model/clip';
import type { Surface } from '../src/lib/road-model/description';
import { offsetPoint } from '../src/lib/road-model/geometry';
import { buildModel, carDiff, carPart, nodeOf, readScene, withoutFootpaths } from './model';

// Footpaths meeting at a node of their own, in e2e/scenes/footpaths-meeting.json:
// - tee (10, 25): the editor's T, a path drawn from a street's south sidewalk
//   at foot (10, 0) south to (10, 40), and a second drawn from (-15, 25) onto
//   it, cutting it at tee; all 2 m wide;
// - four (100, 30): four paths 2, 3, 2 and 4 m wide, at 0°, 80°, 180°, 250°;
// - five (180, 30): five, 2, 2, 3, 2.5 and 2 m wide, at 10°, 80°, 150°, 220°,
//   290°.
// Wherever their node is dragged, the paths are paved together: no ground
// shows between their ends, and none is trimmed back further than its
// neighbours' widths need.

const scene = readScene('footpaths-meeting');

const moved = (data: GraphData, id: string, x: number, y: number): GraphData => ({
	...data,
	nodes: data.nodes.map((n) => (n.id === id ? { ...n, x, y } : n))
});

const shapeOf = (s: Surface) =>
	'left' in s.shape
		? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
		: s.shape.map(toPath);

// A footpath junction as drawn from `data`: how much of the ground between
// its paths' ends shows (m²), the polygon through the middle of each end,
// round the node, less every surface of the node and its roads; and the ends
// trimmed further back than their neighbours need, each no further than it
// takes to clear each neighbour as wide as it is at the angle they meet, as
// two straight roads would, the steepest read no more steeply than
// core/setbacks.ts reads it.
function drawnAt(data: GraphData, id: string) {
	const { scene } = buildModel(data);
	const d = scene.node(`walk:${id}`)!;
	const node = nodeOf(data, id);
	const middles = d.ends.map((e) =>
		offsetPoint(e.frame.p, e.frame.n, (e.lanes[0].left + e.lanes[e.lanes.length - 1].right) / 2)
	);
	middles.sort(
		(p, q) => Math.atan2(p.y - node.y, p.x - node.x) - Math.atan2(q.y - node.y, q.x - node.x)
	);
	const roads = d.ends.map((e) => scene.road(e.ref.road)!);
	const ground = union([d, ...roads].flatMap((x) => x.surfaces.flatMap(shapeOf)));
	const half = (e: (typeof d.ends)[number]) =>
		(e.lanes[e.lanes.length - 1].right - e.lanes[0].left) / 2;
	const overTrimmed = d.ends.filter((e) => {
		const trim = Math.hypot(e.frame.p.x - node.x, e.frame.p.y - node.y);
		const need = Math.max(
			...d.ends
				.filter((o) => o !== e)
				.map((o) => {
					const cos = e.frame.out.x * o.frame.out.x + e.frame.out.y * o.frame.out.y;
					if (cos < -0.9) return 0;
					const sin = Math.max(0.3, Math.sqrt(1 - cos * cos));
					return (half(o) + half(e) * Math.max(0, cos)) / sin;
				})
		);
		return trim > need + 0.01;
	});
	return {
		scene,
		ends: d.ends.length,
		bare: subtract([toPath(middles)], ground).reduce((s, p) => s + Math.abs(area(p)), 0),
		overTrimmed: overTrimmed.map((e) => e.key)
	};
}

// The editor's drag (modes/select.ts) moves the node to the pointer: round a
// circle of radius r about where it was.
const around = (r: number) =>
	Array.from({ length: 12 }, (_, k) => ({
		x: r * Math.cos((k * Math.PI) / 6),
		y: r * Math.sin((k * Math.PI) / 6)
	}));

test("the editor's footpath T, its node dragged as the owner did, keeps its paths paved together", () => {
	for (const at of [
		{ x: 0, y: 0 },
		{ x: 1.85, y: 1.62 },
		{ x: 4.86, y: 3.01 },
		{ x: 9, y: 6 }
	]) {
		const { scene: drawn, ends, bare } = drawnAt(moved(scene, 'tee', 10 + at.x, 25 + at.y), 'tee');
		expect(ends).toBe(3);
		expect(bare).toBeLessThan(0.01);
		expect(check(drawn)).toEqual([]);
	}
});

for (const [id, ends] of [
	['tee', 3],
	['four', 4],
	['five', 5]
] as const)
	test(`${ends} footpaths meeting are paved together and trimmed no further than needed wherever their node is dragged`, () => {
		const home = nodeOf(scene, id);
		for (const r of [0, 2, 5, 9])
			for (const at of r ? around(r) : [{ x: 0, y: 0 }]) {
				const graph = moved(scene, id, home.x + at.x, home.y + at.y);
				const drawn = drawnAt(graph, id);
				const where = `${id} moved (${at.x.toFixed(1)}, ${at.y.toFixed(1)})`;
				expect(drawn.ends, where).toBe(ends);
				expect(drawn.bare, where).toBeLessThan(0.01);
				expect(drawn.overTrimmed, where).toEqual([]);
				expect(check(drawn.scene), where).toEqual([]);
			}
	});

// The T dragged up to within a few metres of the street's sidewalk (its
// outer edge at y = 5.5), its path north ending on the street's side: the
// street draws as it does without the footpaths, and the T is paved as it
// is anywhere.
test('a footpath junction near a street leaves the street as it was', () => {
	for (const at of [
		{ x: 10, y: 9 },
		{ x: 12, y: 8 },
		{ x: 16, y: 10 },
		{ x: 10, y: 6.5 }
	]) {
		const graph = moved(scene, 'tee', at.x, at.y);
		const drawn = drawnAt(graph, 'tee');
		const where = `tee at (${at.x}, ${at.y})`;
		expect(drawn.bare, where).toBeLessThan(0.01);
		expect(check(drawn.scene), where).toEqual([]);
		expect(
			carDiff(carPart(drawn.scene), carPart(buildModel(withoutFootpaths(graph)).scene)),
			where
		).toEqual([]);
	}
});

// Footpaths are strips paved right up to their nodes (core/footpaths.ts), so
// two ending at one node lap each other from that node outward, reaching the
// end of each there; that lap alone is theirs to share (checks.ts, "one
// owner per ground"). Any other ground two footpaths both cover is a double
// cover.
describe('footpaths lapping', () => {
	const path = createLanesFrom('path');
	const s = (
		id: string,
		a: string,
		b: string,
		lanes = path,
		handle: { controlX?: number; controlY?: number } = {}
	) => ({
		id,
		startNodeId: a,
		endNodeId: b,
		lanes,
		...handle
	});
	const covers = (data: GraphData) =>
		check(buildModel(data).scene).filter((f) => f.startsWith('double cover'));
	const ends = [
		{ id: 'w', x: -20, y: 0 },
		{ id: 'e', x: 20, y: 0 },
		{ id: 'n', x: 0, y: -20 },
		{ id: 's', x: 0, y: 20 }
	];

	test('from a node they end at is their lap', () => {
		// Cut at a node of all four at (0, 0), two 2 m paths crossing at right
		// angles lap there.
		expect(
			covers({
				nodes: [...ends, { id: 'm', x: 0, y: 0 }],
				segments: [s('wm', 'w', 'm'), s('me', 'm', 'e'), s('nm', 'n', 'm'), s('ms', 'm', 's')]
			})
		).toEqual([]);
		// Two leaving one node half a degree apart, a bend that tight, are
		// taken over by it as one piece.
		expect(
			covers({
				nodes: [
					{ id: 'a', x: 0, y: 0 },
					{ id: 'b', x: 40, y: 0.25 },
					{ id: 'c', x: 40, y: -0.25 }
				],
				segments: [s('u', 'a', 'b'), s('v', 'a', 'c')]
			})
		).toEqual([]);
	});

	// Two footpaths from a node `angle` degrees apart (between their far
	// ends), `length` long, `widths` wide, their far ends meeting nothing;
	// one of them (`curved`, the first or the second) bowed `bow` metres to
	// the left of the way it is drawn at its middle; or, with `onward`, the
	// second carried on from its far end by a third bending gently away.
	const hairpin = (
		angle: number,
		length: number,
		widths: [number, number],
		onward = false,
		curved?: { leg: 'p' | 'q'; bow: number }
	): GraphData => {
		const a = (angle * Math.PI) / 180;
		const lanes = (w: number) => path.map((l) => ({ ...l, width: w }));
		const far = { id: 'f', x: length * Math.cos(a), y: length * Math.sin(a) };
		const [j, k] = [
			{ id: 'j', x: 0, y: 0 },
			{ id: 'k', x: length, y: 0 }
		];
		// A handle twice as far out as the curve bows at its middle.
		const handle = (
			from: { x: number; y: number },
			to: { x: number; y: number },
			leg: 'p' | 'q'
		) => {
			if (curved?.leg !== leg) return {};
			const out = (2 * curved.bow) / length;
			return {
				controlX: (from.x + to.x) / 2 - (to.y - from.y) * out,
				controlY: (from.y + to.y) / 2 + (to.x - from.x) * out
			};
		};
		return {
			nodes: [j, k, far, ...(onward ? [{ id: 'o', x: far.x - 10, y: far.y + 20 }] : [])],
			segments: [
				s('p', 'k', 'j', lanes(widths[0]), handle(k, j, 'p')),
				s('q', 'j', 'f', lanes(widths[1]), handle(j, far, 'q')),
				...(onward ? [s('r', 'f', 'o', lanes(widths[1]))] : [])
			]
		};
	};

	test('a bend tighter than its footpaths are wide paves them as one piece, nothing twice, no seam', () => {
		// Stopped where the turn begins, the two would lap each other from
		// there out; the bend takes them over as far as they would, and on
		// until they lie further apart than a crack, whichever leg curves.
		const unsealed = (data: GraphData) =>
			check(buildModel(data).scene).filter(
				(f) => f.startsWith('double cover') || f.startsWith('crack')
			);
		const legs = [
			undefined,
			...(['p', 'q'] as const).flatMap((leg) =>
				[0.75, -0.75, 1.5, -1.5].map((bow) => ({ leg, bow }))
			)
		];
		for (const angle of [1, 5, 10, 20, 30, 45])
			for (const length of [4, 10, 40])
				for (const widths of [
					[2, 2],
					[2, 4],
					[4, 2]
				] as [number, number][])
					for (const curved of legs) {
						// Far ends nearer each other than their half widths lap
						// there, sharing no node, which a curved leg no longer
						// lying on the other all along leaves a double cover.
						const apart = 2 * length * Math.sin((angle * Math.PI) / 360);
						if (curved && apart < (widths[0] + widths[1]) / 2) continue;
						expect([
							angle,
							length,
							widths,
							curved,
							unsealed(hairpin(angle, length, widths, false, curved))
						]).toEqual([angle, length, widths, curved, []]);
					}
	});

	test('a footpath folded back over itself past where its bend may take it over is a double cover', () => {
		// The bend at j may take the second no further than JOINT.REACH of it,
		// the bend at its far end keeping apart from it: beyond, the first
		// lies on it, paved twice, from the ends of both at j outward. That
		// is no lap of theirs at j, which a bend's strips have only within its
		// ground.
		expect(covers(hairpin(5, 10, [2, 2], true))).toContainEqual(
			expect.stringMatching(/^double cover: (p and q|q and p) walk\|concrete/)
		);
	});

	test('two side by side, sharing no node, lapping 4 cm along 40 m, are a double cover', () => {
		const nodes = [
			{ id: 'a', x: 0, y: 0 },
			{ id: 'b', x: 40, y: 0 },
			{ id: 'c', x: 0, y: 1.96 },
			{ id: 'd', x: 40, y: 1.96 }
		];
		expect(covers({ nodes, segments: [s('u', 'a', 'b'), s('v', 'c', 'd')] })).toEqual([
			expect.stringMatching(/^double cover: u and v walk\|concrete/)
		]);
		// 2 m apart, edge to edge, they share no ground.
		nodes[2].y = nodes[3].y = 2;
		expect(covers({ nodes, segments: [s('u', 'a', 'b'), s('v', 'c', 'd')] })).toEqual([]);
	});

	test('crossing where they share no node is a double cover', () => {
		const twice = /^double cover: (across and down|down and across) walk\|concrete/;
		expect(covers({ nodes: ends, segments: [s('across', 'w', 'e'), s('down', 'n', 's')] })).toEqual(
			[expect.stringMatching(twice)]
		);
		// Ending at two nodes at one spot is not ending at one node: each
		// strip's 1 m² beside the other's end is drawn twice.
		expect(
			covers({
				nodes: [
					{ id: 'a', x: 0, y: 0 },
					{ id: 'b', x: 40, y: 0 },
					{ id: 'c', x: 0, y: 0 },
					{ id: 'd', x: 0, y: 40 }
				],
				segments: [s('across', 'a', 'b'), s('down', 'c', 'd')]
			})
		).toEqual([expect.stringMatching(twice)]);
		// The same with down's far end moved 6 m east, off square: still two.
		expect(
			covers({
				nodes: [
					{ id: 'a', x: 0, y: 0 },
					{ id: 'b', x: 30, y: 0 },
					{ id: 'c', x: 0, y: 0 },
					{ id: 'd', x: 6, y: 30 }
				],
				segments: [s('across', 'a', 'b'), s('down', 'c', 'd')]
			})
		).toEqual([expect.stringMatching(twice)]);
		// A third laid across `across` at x 10, as drawing lays it, is joined
		// to it at a node there (resolveCrossings), where their lap is that
		// node's: only `down`'s is left.
		const graph = new Graph();
		graph.fromJSON({ nodes: ends, segments: [s('across', 'w', 'e'), s('down', 'n', 's')] });
		const [p, q] = [graph.createNode(10, -15), graph.createNode(10, 15)];
		expect(resolveCrossings(graph, [graph.createSegment(p.id, q.id, path).id])).toBe(true);
		expect(graph.segments.size).toBe(5);
		expect(covers(graph.toJSON())).toEqual([
			expect.stringMatching(/^double cover: .*\bdown\b.* walk\|concrete/)
		]);
	});

	test('crossing away from the node they share, or over the end of one alone, is a double cover', () => {
		// `bent` leaves m due north and comes back south across y = 0 at
		// x ≈ 3.6, where `wide` (10 m wide, due south from m) ends: over the
		// end of `wide` there, never near its own. A third footpath west from
		// m makes it a joint, each strip paved right up to m (two alone would
		// be a bend). `far` also leaves m, north then curving back across
		// `east` 19 m along it. Coming back, `bent` also runs over the joint's
		// own paving at m, ground paved twice as well.
		const wide = path.map((l) => ({ ...l, width: 10 }));
		const nodes = [
			{ id: 'm', x: 0, y: 0 },
			{ id: 's', x: 0, y: 40 },
			{ id: 'e', x: 8, y: 20 },
			{ id: 'w', x: -30, y: 0 }
		];
		const bent = { ...s('bent', 'm', 'e'), controlX: 0, controlY: -20 };
		expect(
			covers({ nodes, segments: [s('wide', 'm', 's', wide), bent, s('west', 'm', 'w')] })
		).toEqual([
			expect.stringMatching(/^double cover: (bent and wide|wide and bent) walk\|concrete/),
			expect.stringMatching(/^double cover: bent and walk:m walk\|concrete/)
		]);
		// Without the third, `bent` and `wide` bend at m, both cut back short
		// of it: where `bent` comes back over `wide` lies outside the bend's
		// ground, so it counts still.
		expect(covers({ nodes, segments: [s('wide', 'm', 's', wide), bent] })).toEqual([
			expect.stringMatching(/^double cover: (bent and wide|wide and bent) walk\|concrete/)
		]);
		const far = { ...s('far', 'm', 'f'), controlX: 0, controlY: -40 };
		expect(
			covers({
				nodes: [
					{ id: 'm', x: 0, y: 0 },
					{ id: 'k', x: 40, y: 0 },
					{ id: 'f', x: 30, y: 20 }
				],
				segments: [s('east', 'm', 'k'), far]
			})
		).toEqual([expect.stringMatching(/^double cover: (east and far|far and east) walk\|concrete/)]);
	});
});
