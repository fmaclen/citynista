import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WALK } from '../src/lib/core/footpaths';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { Networks, type Scene } from '../src/lib/core/networks';
import type { Derived } from '../src/lib/core/place';
import type { GraphData, Lane, SegmentData } from '../src/lib/core/types';
import {
	fromPath,
	inside,
	intersect,
	offset,
	type Paths,
	piecesOf,
	toPath,
	union
} from '../src/lib/road-model/clip';
import type { RoadDescription } from '../src/lib/road-model/description';
import {
	cutLine,
	frameAt,
	type PathSample,
	project,
	sampled
} from '../src/lib/road-model/geometry';
import { walkwayId } from '../src/lib/road-model/model';
import { boxOf, shapeOf } from '../src/lib/road-model/overlay';
import { JOIN, type Links, linksOf } from '../src/lib/rendering/links';
import { frame, openEditor } from './editor.svelte';
import {
	at,
	junction,
	junctions,
	seeded,
	slid,
	SWEEP_SEED,
	sweepCase,
	withPaths
} from './junctions';
import { buildModel, liveShape } from './model';

// The connection overlay (rendering/links.ts): blue is a way to drive,
// orange a way to walk, and every walking link a footpath has is shown,
// read off the build as it stands.

type Pt = { x: number; y: number };
const preset = (id: string): Lane[] => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
const path = (width: number): Lane[] => [{ ...preset('path')[0], width }];
const lane = (
	id: string,
	role: Lane['role'],
	width: number,
	direction: Lane['direction'] = 'bidirectional'
): Lane => ({
	id,
	role,
	width,
	direction,
	material: role === 'vehicle' ? 'asphalt' : 'concrete'
});
// A segment from a to b, stored the other way round where `flip`.
const seg = (id: string, a: string, b: string, lanes: Lane[], flip: boolean): SegmentData => ({
	id,
	startNodeId: flip ? b : a,
	endNodeId: flip ? a : b,
	lanes
});
const nodes = (pts: Record<string, [number, number]>) =>
	Object.entries(pts).map(([id, [x, y]]) => ({ id, x, y }));
// What the overlay shows of a graph, a fresh build of it, held to the rule
// for its lines and dots (expectRule).
const links = (g: GraphData, label = '') => {
	const { scene, derived } = buildModel(g);
	const l = linksOf(scene, derived);
	expectRule(scene, derived, l, label);
	return l;
};
const mid = (p: Pt, q: Pt) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
// The middle of each walkway the car pieces draw, and the surface it is
// drawn on where it may leave it: a road's walk lanes halfway between their
// edges; a junction's sidewalks through it and round its corners (its walk
// paths and walkways), on its walk paving.
const walkwaysOf = (scene: Scene) => {
	const out: { line: Pt[]; on?: Paths }[] = [];
	for (const { id } of scene.place.roads) {
		const d = scene.footpathNodes(id) ? undefined : scene.road(id);
		d?.lanes.forEach((span, i) => {
			if (d.surfaces.some((s) => s.role === 'walk' && s.lane?.lane === span.lane.id))
				out.push({ line: d.edges[i].map((p, k) => mid(p, d.edges[i + 1][k])) });
		});
	}
	for (const { id } of scene.place.junctions) {
		const d = id.startsWith(WALK) ? undefined : scene.node(id);
		if (!d) continue;
		const on = d.surfaces.filter((s) => s.role === 'walk').flatMap(shapeOf);
		for (const line of [
			...d.paths.filter((p) => p.kind === 'walk').map((p) => p.line),
			...(d.walkways ?? []).map((w) => w.line)
		])
			out.push({ line, on });
	}
	return out;
};
// Where the segments from a to b and from c to d meet, ends included.
const meet = (a: Pt, b: Pt, c: Pt, d: Pt) => {
	const [dx, dy, ex, ey] = [b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y];
	const den = dx * ey - dy * ex;
	if (Math.abs(den) < 1e-12) return null;
	const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
	const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + dx * t, y: a.y + dy * t } : null;
};
// How far p lies from a line.
const offLine = (p: Pt, line: Pt[]) =>
	Math.min(
		...line.slice(1).map((b, k) => {
			const a = line[k];
			const [dx, dy] = [b.x - a.x, b.y - a.y];
			const t = Math.max(
				0,
				Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
			);
			return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
		})
	);
// The footpaths' walking lines the overlay draws.
const walkingLines = (l: Links) => [...l.strips, ...l.walk, ...l.cross, ...l.onto];
// Where the build joins a footpath to a car road's sidewalk at a dead end
// of the road: a footpath's own walk paving (its strip, or the bend or
// joint at one of its nodes) sharing an edge with the sidewalk's end there,
// which the footpath, laid over the sidewalk there, is: each stretch of the
// sidewalk's end, across it from edge to edge, the paving reaches (within
// 2 cm, read every centimetre), with its middle (`at`).
const deadEndJoins = (scene: Scene, derived: Derived) => {
	const out: { at: Pt; line: Pt[]; paving: Paths }[] = [];
	const pavings = scene.place.roads
		.filter((r) => scene.footpathNodes(r.id))
		.map((r) => {
			const paving = union(
				scene
					.footpathPaving(r.id)
					.flatMap((p) => p.description.surfaces.filter((s) => s.role === 'walk').flatMap(shapeOf))
			);
			return { paving, box: boxOf(paving.flatMap(fromPath)) };
		});
	for (const here of derived.ends.values()) {
		if (here.length !== 1) continue;
		const d = scene.road(here[0].geo.road.id);
		d?.lanes.forEach((span, i) => {
			if (!d.surfaces.some((s) => s.role === 'walk' && s.lane?.lane === span.lane.id)) return;
			const line = d.edges[i].map((p, k) => mid(p, d.edges[i + 1][k]));
			const end = (edge: Pt[]) => (here[0].end === 'start' ? edge[0] : edge.at(-1)!);
			const [a, b] = [end(d.edges[i]), end(d.edges[i + 1])];
			const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 0.01));
			const across = Array.from({ length: n + 1 }, (_, k) => ({
				x: a.x + ((b.x - a.x) * k) / n,
				y: a.y + ((b.y - a.y) * k) / n
			}));
			const edgeBox = boxOf(across, 1);
			for (const { paving, box } of pavings) {
				if (
					box[0] > edgeBox[2] ||
					edgeBox[0] > box[2] ||
					box[1] > edgeBox[3] ||
					edgeBox[1] > box[3]
				)
					continue;
				const reach = offset(paving, 0.02);
				const on = across.map((p) => inside(reach, p));
				for (let k = 0; k < on.length; k++) {
					if (!on[k] || on[k - 1]) continue;
					let j = k;
					while (on[j + 1]) j++;
					if (j > k) out.push({ at: mid(across[k], across[j]), line, paving });
				}
			}
		});
	}
	return out;
};
// The overlay's dots stand wherever one of the footpaths' walking lines it
// draws crosses a drawn walkway's middle, each such point under a dot (within
// its radius, JOIN), and for every join the build makes: wherever a
// footpath end's line onto a walkway arrives (Derived.sidewalks), and
// wherever a footpath's paving reaches a sidewalk's end at a dead end
// (deadEndJoins), where it stands at the sidewalk middle's end unless the
// footpath is joined to that sidewalk on its paving already. A dot stands
// nowhere else: each on a walking line and on a walkway's middle where it
// is drawn, or at a sidewalk's end so joined. An end's line onto a walkway
// ends on its middle (within 1 cm, as the build lays it).
const expectJoins = (scene: Scene, derived: Derived, l: Links, label: string) => {
	const ways = walkwaysOf(scene).map((w) => ({
		...w,
		box: boxOf(w.line, 0.02),
		grown: undefined as Paths | undefined
	}));
	const lines = walkingLines(l);
	const meets = (a: number[], b: number[]) =>
		a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
	for (const line of lines)
		for (const { line: m, on } of ways.filter((w) => meets(w.box, boxOf(line))))
			for (let i = 1; i < line.length; i++)
				for (let k = 1; k < m.length; k++) {
					const p = meet(line[i - 1], line[i], m[k - 1], m[k]);
					if (p && (!on || inside(on, p)))
						expect(
							l.joins.some((q) => near(p, q, JOIN)),
							`${label}: no dot where a walking line crosses a walkway at ${p.x}, ${p.y}`
						).toBe(true);
				}
	for (const here of derived.sidewalks.values())
		for (const { line } of here)
			expect(
				l.joins.some((q) => near(line.at(-1)!, q, JOIN)),
				`${label}: no dot where an end's line arrives on a walkway`
			).toBe(true);
	const dead = deadEndJoins(scene, derived);
	for (const { at, line, paving } of dead)
		expect(
			l.joins.some(
				(q) => near(q, at, JOIN) || (offLine(q, line) < 0.015 && inside(offset(paving, JOIN), q))
			),
			`${label}: no dot where a footpath's paving joins a sidewalk's end at ${at.x}, ${at.y}`
		).toBe(true);
	for (const p of l.joins) {
		if (dead.some(({ at }) => near(p, at, 0.015))) continue;
		expect(Math.min(...lines.map((line) => offLine(p, line))), label).toBeLessThan(0.01);
		const drawn = ways.filter(
			(w) =>
				meets(w.box, [p.x - 1, p.y - 1, p.x + 1, p.y + 1]) &&
				(!w.on || inside((w.grown ??= offset(w.on, 0.015)), p))
		);
		expect(Math.min(...drawn.map((w) => offLine(p, w.line))), label).toBeLessThan(0.015);
	}
	for (const here of derived.sidewalks.values())
		for (const { line } of here)
			expect(Math.min(...ways.map((w) => offLine(line.at(-1)!, w.line))), label).toBeLessThan(
				0.015
			);
};
// Points every 10 cm along a line.
const samples = (line: Pt[]) =>
	line.slice(1).flatMap((b, k) => {
		const a = line[k];
		const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1));
		return Array.from({ length: n + 1 }, (_, j) => ({
			x: a.x + ((b.x - a.x) * j) / n,
			y: a.y + ((b.y - a.y) * j) / n
		}));
	});
// A walking line is drawn only on ground a walker has, read off the drawing
// independently of links.ts: the walk paving of every piece drawn (sidewalks,
// a footpath's paving as laid over the cars) and every crossing's paint and
// paving, to within 3 cm. Every piece of paint the footpaths' crossings lay
// over car lanes or a median has a line on it, and each of those lines ends
// at the edge of the paint (where it meets the curb, or the paint stops) or
// runs on there as another line; and none runs along another walking line,
// within 2 cm of it for a metre or more, as two lines drawn over one stretch
// of ground would (lines fanning out from one point part sooner). The lines
// of one footpath join up: where a crossing's line stops at paving, a line
// of the footpath runs on from that point (its strip's, or a link's through
// a node in the roadway), within 3 cm; where a link or a line onto a
// walkway does, it runs on along another (it leaves a strip's line).
const expectLines = (scene: Scene, l: Links, label: string) => {
	const pieces = [
		...scene.place.roads.map((r) => scene.road(r.id)),
		...scene.place.junctions.map((j) => scene.node(j.id))
	].flatMap((d) => (d ? [d] : []));
	const crossings = pieces.flatMap((d) => d.crossings);
	const paint = crossings.filter((c) => c.of !== undefined && c.body.length);
	// Each piece of walking ground with its box, read near each line alone.
	const boxed = (paths: Paths) => ({ paths, box: boxOf(paths.flatMap(fromPath)) });
	const meets = (a: number[], b: number[]) =>
		a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
	const grounds = [
		...pieces.map((d) => d.surfaces.filter((s) => s.role === 'walk').flatMap(shapeOf)),
		...crossings.map((c) => [...c.body, ...c.runs.flatMap((r) => r.rings)].map(toPath))
	]
		.filter((paths) => paths.length)
		.map(boxed);
	const groundNear = (box: number[]) =>
		offset(union(grounds.filter((g) => meets(g.box, box)).flatMap((g) => g.paths)), 0.03);
	const lines = walkingLines(l);
	for (const line of lines) {
		const ground = groundNear(boxOf(line, 1));
		const off = samples(line).find((p) => !inside(ground, p));
		expect(off, `${label}: a walking line off walking ground`).toBeUndefined();
	}
	// Where a crossing's line, a link or a line onto a walkway stops with a
	// piece's walk paving 5 cm on, the walkway runs on there as another line:
	// a crossing's from an end of it, a link's or an onto-line's along it.
	const pavings = pieces
		.map((d) => d.surfaces.filter((s) => s.role === 'walk').flatMap(shapeOf))
		.filter((paths) => paths.length)
		.map(boxed);
	for (const [kind, list] of [
		['crossing', l.cross],
		['link', l.walk],
		['onto', l.onto]
	] as const)
		for (const line of list)
			for (const [p, q] of kind === 'onto'
				? [[line[0], line[1]]]
				: [
						[line[0], line[1]],
						[line.at(-1)!, line.at(-2)!]
					]) {
				const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
				const on = { x: p.x + ((p.x - q.x) / d) * 0.05, y: p.y + ((p.y - q.y) / d) * 0.05 };
				const ahead = pavings.filter((g) => meets(g.box, boxOf([on], 1)));
				if (!inside(union(ahead.flatMap((g) => g.paths)), on)) continue;
				const others = lines.filter((o) => o !== line);
				const gap =
					kind === 'crossing'
						? Math.min(...others.flatMap(ends).map((e) => Math.hypot(e.x - p.x, e.y - p.y)))
						: Math.min(...others.map((o) => offLine(p, o)));
				expect(
					gap,
					`${label}: a ${kind} line stops at ${p.x}, ${p.y} with paving ahead`
				).toBeLessThan(0.03);
			}
	const bodies = crossings.filter((c) => c.body.length).map((c) => boxed(c.body.map(toPath)));
	const paints = union(paint.flatMap((c) => c.body.map(toPath)));
	// Each piece of paint, joined to any other painted ground it touches (a
	// street's own crosswalk at a junction included).
	for (const c of paint) {
		const paths = c.body.map(toPath);
		const all = offset(
			union(
				bodies.filter((b) => meets(b.box, boxOf(fromPath(paths[0]), 30))).flatMap((b) => b.paths)
			),
			0.03
		);
		for (const piece of piecesOf(all).filter((piece) =>
			paths.some((q) => fromPath(q).some((p) => inside(piece, p)))
		))
			expect(
				l.cross.some(
					(line) =>
						meets(boxOf(line), boxOf(piece.flatMap(fromPath))) &&
						samples(line).some((p) => inside(piece, p))
				),
				`${label}: no line on a crossing's paint`
			).toBe(true);
	}
	// An end inside the paint is where the line runs on as another.
	const painted = offset(paints, -0.03);
	const others = (line: Pt[]) => lines.filter((other) => other !== line);
	for (const line of l.cross)
		for (const p of ends(line))
			if (inside(painted, p))
				expect(
					others(line).some((other) => ends(other).some((q) => near(p, q, 0.01))),
					`${label}: a crossing's line ends inside its paint at ${p.x}, ${p.y}`
				).toBe(true);
	for (const line of l.cross) {
		const along = samples(line);
		for (const other of others(line)) {
			let [run, longest] = [0, 0];
			for (const [k, p] of along.entries()) {
				run =
					offLine(p, other) < 0.02
						? run + (k ? Math.hypot(p.x - along[k - 1].x, p.y - along[k - 1].y) : 0)
						: 0;
				longest = Math.max(longest, run);
			}
			expect(longest, `${label}: a crossing's line runs along another line`).toBeLessThan(1);
		}
	}
};
// The overlay's rule for its lines and dots.
const expectRule = (scene: Scene, derived: Derived, l: Links, label: string) => {
	expectLines(scene, l, label);
	expectJoins(scene, derived, l, label);
};
// How far a point lies from a straight line through a and b, signed (+ left).
const across = (p: Pt, a: Pt, b: Pt) => {
	const l = Math.hypot(b.x - a.x, b.y - a.y);
	return ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / l;
};
const near = (p: Pt, q: Pt, by = 0.05) => Math.hypot(p.x - q.x, p.y - q.y) < by;
const ends = (line: Pt[]) => [line[0], line.at(-1)!];
// The street's half width over its lanes (two 3.5 m lanes) and to its
// sidewalks' middles (2 m wide).
const CURB = 3.5;
const SIDEWALK = 4.5;

test('a footpath joint, the crossing its wide footpath makes and the sidewalks it passes over are each one walking link, stored either way', () => {
	const at = { s0: [-16, -30], s1: [14, 30], a: [-22, 0], b: [24, 2], c: [-42, 4] } as const;
	const pt = (id: keyof typeof at) => ({ x: at[id][0], y: at[id][1] });
	for (let flip = 0; flip < 8; flip++) {
		const g: GraphData = {
			nodes: nodes(at as never),
			segments: [
				seg('street', 's0', 's1', preset('street'), !!(flip & 1)),
				seg('big', 'a', 'b', path(8), !!(flip & 2)),
				seg('small', 'c', 'a', path(2), !!(flip & 4))
			]
		};
		const l = links(g, `${flip}`);
		const onBig = (p: Pt) => Math.abs(across(p, pt('a'), pt('b'))) < 0.05;
		const onSmall = (p: Pt) => Math.abs(across(p, pt('c'), pt('a'))) < 0.05;
		const street = (p: Pt) => across(p, pt('s0'), pt('s1'));
		expect(l.drive, `${flip}`).toEqual([]);
		expect(l.onto, `${flip}`).toEqual([]);
		// Through the joint, from the small footpath's middle to the big one's.
		const joint = l.walk;
		expect(joint, `${flip}`).toHaveLength(1);
		const [p, q] = ends(joint[0]);
		expect((onSmall(p) && onBig(q)) || (onBig(p) && onSmall(q)), `${flip}`).toBe(true);
		// Over the street, along the big footpath's middle from curb to curb.
		const crossing = l.cross;
		expect(crossing, `${flip}`).toHaveLength(1);
		expect(crossing[0].every(onBig), `${flip}`).toBe(true);
		expect(
			ends(crossing[0])
				.map((p) => Math.round(street(p) * 100) / 100)
				.sort(),
			`${flip}`
		).toEqual([-CURB, CURB].sort());
		// Onto each sidewalk it passes over, at the sidewalk's middle.
		expect(l.joins.every(onBig), `${flip}`).toBe(true);
		expect(l.joins.map((p) => Math.round(street(p) * 100) / 100).sort(), `${flip}`).toEqual(
			[-SIDEWALK, SIDEWALK].sort()
		);
	}
});

test("a footpath ended on a street's sidewalk is joined to its middle, and one across joins both sidewalks it passes over", () => {
	for (let flip = 0; flip < 8; flip++) {
		const g: GraphData = {
			nodes: nodes({
				s0: [-40, 0],
				s1: [40, 0],
				e0: [-10, 18],
				e1: [-10, 5],
				x0: [4, 18],
				x1: [12, -18]
			}),
			segments: [
				seg('street', 's0', 's1', preset('street'), !!(flip & 1)),
				seg('end', 'e0', 'e1', path(2), !!(flip & 2)),
				seg('across', 'x0', 'x1', path(2), !!(flip & 4))
			]
		};
		const l = links(g, `${flip}`);
		const onAcross = (p: Pt) => Math.abs(across(p, { x: 4, y: 18 }, { x: 12, y: -18 })) < 0.05;
		expect(l.drive, `${flip}`).toEqual([]);
		// The end's line runs from along its footpath onto the sidewalk's
		// middle, where it is joined.
		expect(l.onto, `${flip}`).toHaveLength(1);
		const [from, to] = ends(l.onto[0]);
		expect(from.x, `${flip}`).toBeCloseTo(-10, 2);
		expect(from.y, `${flip}`).toBeGreaterThan(5);
		expect(near(to, { x: -10, y: SIDEWALK }), `${flip}`).toBe(true);
		expect(l.joins.filter((p) => near(p, to))).toHaveLength(1);
		// The footpath across is joined to each sidewalk at its middle, and
		// crosses from curb to curb.
		const over = l.joins.filter((p) => !near(p, to));
		expect(over.every(onAcross), `${flip}`).toBe(true);
		expect(over.map((p) => Math.round(p.y * 100) / 100).sort(), `${flip}`).toEqual(
			[-SIDEWALK, SIDEWALK].sort()
		);
		expect(l.cross, `${flip}`).toHaveLength(1);
		expect(l.cross[0].every(onAcross), `${flip}`).toBe(true);
		expect(ends(l.cross[0]).map((p) => Math.round(Math.abs(p.y) * 100) / 100)).toEqual([
			CURB,
			CURB
		]);
	}
});

test("a junction's movements are ways to drive between its lane ends, its sidewalks' links ways to walk", () => {
	const g: GraphData = {
		nodes: nodes({ w: [-40, 0], m: [0, 0], e: [40, 0], s: [0, -40] }),
		segments: [
			seg('a', 'w', 'm', preset('street'), false),
			seg('b', 'm', 'e', preset('street'), true),
			seg('c', 'm', 's', preset('street'), false)
		]
	};
	const l = links(g);
	const laneEnd = (p: Pt) => l.ends.some((e) => near(e.point, p));
	expect(l.drive.length).toBeGreaterThan(0);
	for (const line of l.drive) expect(ends(line).every(laneEnd)).toBe(true);
	expect(l.street.length).toBeGreaterThan(0);
	for (const line of l.street) expect(ends(line).some(laneEnd)).toBe(false);
	expect(walkingLines(l)).toEqual([]);
	expect(l.joins).toEqual([]);
	// The crosswalk over the stem, sidewalk to sidewalk.
	expect(
		l.street.some(
			(w) =>
				ends(w).every((p) => Math.abs(Math.abs(p.x) - SIDEWALK) < 0.05) && w[0].x * w.at(-1)!.x < 0
		)
	).toBe(true);
});

// Every walking link a footpath has at a street it meets is shown, the
// footpath taken as it shows: its strips, bends and joints together. Each
// sidewalk it reaches on its way is joined at the sidewalk's middle, and
// only those; an end on a sidewalk is joined by its line onto it; and each
// way it crosses the roadway has a line from curb to curb. Swept over bends and joints of two, three and four paths, the
// joint moved across each sidewalk and each curb and through the roadway,
// paths 2, 4 and 8 m wide, the car presets, each road stored either way. A
// hairpin is joined where the line round its bend crosses a sidewalk's
// middle, which its joint's place does not tell.
test('every sidewalk a footpath reaches on its way is joined, and every way it crosses a street has its line', () => {
	// The street's sidewalk middles' distance from its line (`walk`), half
	// their width (`half`), and its curbs' (`curb`).
	const streets = {
		street: { walk: 4.5, half: 1, curb: 3.5 },
		avenue: { walk: 10.5, half: 1.5, curb: 8 },
		highway: { walk: 0, half: 0, curb: 12 },
		lane: { walk: 0, half: 0, curb: 1.75 }
	};
	// The far ends of the footpaths from the joint, which all run on
	// straight across the street but for the hairpin.
	const shapes: Record<string, [number, number][]> = {
		bend: [
			[0, -36],
			[22, 36]
		],
		hairpin: [
			[0, -36],
			[16, -36]
		],
		fork: [
			[0, -36],
			[-22, 36],
			[22, 36]
		],
		'fork back': [
			[-14, -36],
			[14, -36],
			[0, 36]
		],
		four: [
			[-14, -36],
			[14, -36],
			[-16, 36],
			[16, 36]
		]
	};
	let flips = 0;
	let checked = 0;
	for (const [kind, { walk, half, curb }] of Object.entries(streets)) {
		const offsets = walk
			? [walk + half + 3, walk + half + 0.5, walk + 0.4, walk - 0.4, curb - 0.5, curb / 2, 0]
			: [curb + 3, curb + 0.5, curb - 0.5, curb / 2, 0];
		const ys = [...new Set([...offsets, ...offsets.map((o) => -o)])];
		for (const wide of kind === 'lane' ? [2, 4] : [2, 4, 8])
			for (const [shape, far] of Object.entries(shapes))
				for (const jy of ys) {
					const flip = flips++;
					const g: GraphData = {
						nodes: nodes({
							s0: [-70, 0],
							s1: [70, 0],
							j: [0, jy],
							...Object.fromEntries(far.map((p, i) => [`e${i}`, p]))
						}),
						segments: [
							seg('street', 's0', 's1', preset(kind), !!(flip & 1)),
							...far.map((_, i) =>
								seg(`p${i}`, 'j', `e${i}`, path(wide), !!((flip >> (i + 1)) & 1))
							)
						]
					};
					const label = `${kind}, ${wide} m, ${shape}, joint at ${jy}, ${flip % 32}`;
					const { scene, derived } = buildModel(g);
					const l = linksOf(scene, derived);
					expectRule(scene, derived, l, label);
					const paving = union(
						far.flatMap((_, i) =>
							scene.footpathPaving(`p${i}`).flatMap((p) => p.description.surfaces.flatMap(shapeOf))
						)
					);
					const middles = walk ? [-walk, walk] : [];
					// Each join on a sidewalk's middle, where the footpath reaches it.
					const grown = offset(paving, half + 0.05);
					for (const p of l.joins) {
						expect(
							middles.some((m) => Math.abs(p.y - m) < 0.01),
							label
						).toBe(true);
						expect(inside(grown, p), label).toBe(true);
					}
					// Ends on a sidewalk, all of them where the joint lies on one.
					const onWalk = middles.find((m) => Math.abs(jy - m) < half);
					expect(l.onto.length, label).toBe(onWalk === undefined ? 0 : far.length);
					// Each sidewalk a footpath passes over or ends on is joined, and
					// no other (where on it, expectJoins says: the links through a
					// joint inside the roadway may cross a sidewalk's middle
					// beside the footpaths themselves).
					const spans = (y: number) => far.filter(([, fy]) => (jy - y) * (fy - y) < 0).length;
					if (shape !== 'hairpin')
						for (const m of middles)
							expect(
								l.joins.some((p) => Math.abs(p.y - m) < 0.01),
								`${label}, sidewalk at ${m}`
							).toBe(m === onWalk || spans(m) > 0);
					// A line for each way across the roadway, curb to curb: from
					// each footpath leaving the joint one way to each leaving it the
					// other, where the joint lies in the roadway, and along each
					// footpath crossing all of it from a joint beside it.
					const lines = l.cross;
					for (const line of lines)
						expect(
							[line[0].y, line.at(-1)!.y].map((y) => Math.round(y * 100) / 100).sort(),
							label
						).toEqual([-curb, curb]);
					if (shape !== 'hairpin') {
						const ways =
							Math.abs(jy) < curb
								? spans(-curb) * spans(curb)
								: far.filter(
										([, fy]) => (jy - curb) * (fy - curb) < 0 && (jy + curb) * (fy + curb) < 0
									).length;
						expect(lines.length, label).toBe(ways);
					}
					checked++;
				}
	}
	expect(checked).toBeGreaterThan(500);
}, 30_000);

// A walking line is drawn only on ground a walker has (expectLines, on every
// step): a footpath laid along a street, on its lanes, its curb or its
// sidewalk, straight and curved, beside a Street, an Avenue and a street with
// no sidewalks, stored either way. Where it lies on asphalt with neither
// paving nor paint it has no line; along a sidewalk's middle each end's
// arrival has its dot (expectJoins).
test('a footpath along a street has a line only where it is paved', () => {
	const plain = preset('street').filter((l) => l.role === 'vehicle');
	const streets = { street: preset('street'), avenue: preset('avenue'), plain };
	let checked = 0;
	for (const [kind, lanes] of Object.entries(streets))
		for (const y of [0, 1.75, 3.5, 4.5, 5.5, 10.5, -1.75, -4.5, -10.5])
			for (const bow of [0, 3])
				for (let flip = 0; flip < 4; flip++) {
					const g: GraphData = {
						nodes: nodes({ s0: [-50, 0], s1: [50, 0], p: [-15, y], q: [15, y] }),
						segments: [
							seg('street', 's0', 's1', lanes, !!(flip & 1)),
							{ ...seg('p', 'p', 'q', path(2), !!(flip & 2)), controlX: 0, controlY: y + bow }
						]
					};
					const label = `${kind}, along at ${y}, bow ${bow}, ${flip}`;
					const l = links(g, label);
					// On a street with no sidewalks, all of it lies on asphalt.
					if (kind === 'plain' && Math.abs(y) < 1)
						expect([...l.strips, ...l.cross, ...l.onto], label).toEqual([]);
					checked++;
				}
	expect(checked).toBe(216);
});

// Across a street, at its dead ends and by them, and curved across it:
// each run across has one line, along the middle of its paint from curb to
// curb, and no line of the footpath's own runs beside it (expectLines).
test('a footpath across a street has one line on its crossing, at a dead end and curved', () => {
	const plain = preset('street').filter((l) => l.role === 'vehicle');
	const streets = { street: preset('street'), avenue: preset('avenue'), plain };
	let checked = 0;
	for (const [kind, lanes] of Object.entries(streets))
		for (let flip = 0; flip < 4; flip++) {
			const street = seg('street', 's0', 's1', lanes, !!(flip & 1));
			const at: Record<string, [number, number]> = { s0: [-50, 0], s1: [50, 0] };
			for (const x of [-50.5, -50, -49.5, 49.5, 50, 50.5]) {
				const g: GraphData = {
					nodes: nodes({ ...at, p: [x, -20], q: [x, 20] }),
					segments: [street, seg('p', 'p', 'q', path(2), !!(flip & 2))]
				};
				const label = `${kind}, across at ${x}, ${flip}`;
				const l = links(g, label);
				if (Math.abs(x) <= 50) expect(l.cross, label).toHaveLength(1);
				checked++;
			}
			for (const bend of [4, 10, 16, 22, 28]) {
				const g: GraphData = {
					nodes: nodes({ ...at, p: [-8, -20], q: [-8, 20] }),
					segments: [
						street,
						{ ...seg('p', 'p', 'q', path(2), !!(flip & 2)), controlX: bend, controlY: 0 }
					]
				};
				const label = `${kind}, curved by ${bend}, ${flip}`;
				expect(links(g, label).cross, label).toHaveLength(1);
				checked++;
			}
		}
	expect(checked).toBe(132);
});

// A footpath whose curve hooks back at its tip (its handle beyond its end) is
// paved short of where its middle line ends: over a One-way lane and a
// Street, the handle either side of the end and at three depths, mirrored,
// stored either way.
test('a footpath whose curve hooks back at its tip has no line past its paving', () => {
	let checked = 0;
	for (const kind of ['lane', 'street'])
		for (let flip = 0; flip < 4; flip++)
			for (const side of [-1, 1])
				for (const [hx, hy] of [
					[-5, -18],
					[-6, -20],
					[1, -19]
				]) {
					const g: GraphData = {
						nodes: nodes({ s0: [-50, 0], s1: [50, 0], p: [0, 35], q: [-3 * side, -16] }),
						segments: [
							seg('street', 's0', 's1', preset(kind), !!(flip & 1)),
							{
								...seg('p', 'p', 'q', path(2), !!(flip & 2)),
								controlX: hx * side,
								controlY: hy
							}
						]
					};
					const label = `${kind}, handle ${hx * side},${hy}, ${flip}`;
					expect(links(g, label).cross, label).toHaveLength(1);
					checked++;
				}
	expect(checked).toBe(48);
});

// Through junctions: a footpath across a four-way junction of Streets at a
// slant, and across the hairpin of three Streets whose short middle one is
// merged into its neighbours, at every distance from it; stored either way.
test('a footpath through a junction has a line only on its paving and its paint', () => {
	const street = preset('street');
	let checked = 0;
	for (let flip = 0; flip < 4; flip++) {
		const four = ['w', 'e', 'n', 's'].map((id, i) =>
			seg(id, 'j', id, street, !!((flip >> i % 2) & 1))
		);
		for (const [dx, dy] of [
			[18, 15],
			[18, 6],
			[6, 18],
			[18, -10]
		])
			for (const by of [-4, 0, 3]) {
				const g: GraphData = {
					nodes: nodes({
						j: [0, 0],
						w: [-50, 0],
						e: [50, 0],
						n: [0, 50],
						s: [0, -50],
						p: [-dx, -dy + by],
						q: [dx, dy + by]
					}),
					segments: [...four, seg('p', 'p', 'q', path(2), !!(flip & 2))]
				};
				links(g, `four-way, ${dx} ${dy} by ${by}, ${flip}`);
				checked++;
			}
		const hairpin = [
			seg('left', 'p', 'q', street, !!(flip & 1)),
			seg('link', 'q', 'r', street, !!(flip & 1)),
			seg('right', 'r', 's', street, !!(flip & 1))
		];
		for (let y = -8; y <= 12; y += 2) {
			const g: GraphData = {
				nodes: nodes({ p: [38, -10], q: [0, 0], r: [5, 0], s: [6, 40], a: [-15, y], b: [26, y] }),
				segments: [...hairpin, seg('path', 'a', 'b', path(2), !!(flip & 2))]
			};
			links(g, `merged, at ${y}, ${flip}`);
			checked++;
		}
	}
	expect(checked).toBe(92);
});

// The overlay draws what a fresh build of the graph shows, kept up through
// each edit: a footpath bent across a street, its bend moved across the
// roadway and onto the sidewalk, then each of its two paths deleted.
test('the overlay draws the walking links of the footpaths as they stand, through a move and each deletion', () => {
	const ui = openEditor(
		{
			nodes: nodes({ s0: [-40, 0], s1: [40, 0], a: [0, -20], j: [0, 8], b: [18, 20] }),
			segments: [
				seg('street', 's0', 's1', preset('street'), false),
				seg('in', 'a', 'j', path(4), false),
				seg('out', 'j', 'b', path(4), true)
			]
		},
		0.05
	);
	ui.editor.toggleConnections();
	const key = (p: Pt) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
	const lineKey = (line: Pt[]) => [line[0], line.at(-1)!].map(key).join('>');
	// What the overlay draws, against what a fresh build of the graph shows.
	const expectFresh = (label: string) => {
		frame();
		const shown = ui.editor.roadRenderer.overlayShown();
		const fresh = links(ui.graph());
		expect(shown.joins.map(key).sort(), label).toEqual(fresh.joins.map(key).sort());
		expect(shown.walk.map(lineKey).sort(), label).toEqual(
			[...fresh.street, ...walkingLines(fresh)].map(lineKey).sort()
		);
		return shown;
	};
	// Joined to both sidewalks, and across between them.
	expect(
		expectFresh('bent')
			.joins.map((p) => p.y)
			.sort()
	).toEqual([-SIDEWALK, SIDEWALK]);
	for (const y of [7, 2, 4.5]) {
		const at = ui.node('j');
		ui.drag({ x: at.x, y: at.y }, { x: 0, y });
		expect(ui.node('j').y, `moved to ${y}`).toBeCloseTo(y, 1);
		expect(expectFresh(`moved to ${y}`).joins.length, `moved to ${y}`).toBeGreaterThan(1);
	}
	for (const id of ['out', 'in']) {
		ui.editor.graph.deleteSegment(id);
		ui.editor.graph.save();
		expectFresh(`${id} deleted`);
	}
	expect(ui.editor.roadRenderer.overlayShown().joins).toEqual([]);
});

// A footpath crossing's line is the way a walker takes over it: the
// footpath's middle as its crossing shows, from the curb where it leaves
// paving to the curb where it reaches paving again, carried straight across
// and bent only as the street bends. Swept over the car presets, footpaths
// 2 m and 8 m wide, a range of slants, a curved and a shifted street and
// footpath, each stored either way.
test("a footpath crossing's line runs along the footpath's middle from curb to curb, bent as the street is", () => {
	const middleOf = (d: RoadDescription) => {
		const [l, r] = [d.edges[0], d.edges.at(-1)!];
		return l.map((p, i) => ({ x: (p.x + r[i].x) / 2, y: (p.y + r[i].y) / 2 }));
	};
	// Where a point lies on the street: how far along its line and how far to
	// the side of it.
	const onStreet = (path: PathSample, p: Pt) => {
		const { s } = project(path, p);
		const f = frameAt(path, s);
		return { s, d: (p.x - f.p.x) * f.n.x + (p.y - f.p.y) * f.n.y };
	};
	const shapes = ['plain', 'street curved', 'street shifted', 'path curved', 'path shifted'];
	let checked = 0;
	// A footpath wider than the road it crosses at a slant draws a crossing
	// short of its width (docs/backlog.md), so an 8 m one crosses the wider
	// presets alone.
	for (const kind of ['street', 'avenue', 'highway', 'lane'])
		for (const wide of kind === 'lane' ? [2] : [2, 8])
			for (const [k, degrees] of [30, 55, 90, 125, 150].entries())
				for (const shape of shapes) {
					const flip = (k + shapes.indexOf(shape) + wide) % 4;
					const a = (degrees * Math.PI) / 180;
					const [u, v] = [Math.cos(a) * 40, Math.sin(a) * 40];
					const car = {
						...(shape === 'street curved' && { controlX: 0, controlY: 16 }),
						...(shape === 'street shifted' && { offsetStart: -1, offsetEnd: 2 })
					};
					const walk = {
						...(shape === 'path curved' && { controlX: -v / 8, controlY: u / 8 }),
						...(shape === 'path shifted' && { offsetStart: 1.5, offsetEnd: -1 })
					};
					const g: GraphData = {
						nodes: nodes({ s0: [-60, 0], s1: [60, 0], p: [-u, -v], q: [u, v] }),
						segments: [
							{ ...seg('street', 's0', 's1', preset(kind), !!(flip & 1)), ...car },
							{ ...seg('w', 'p', 'q', path(wide), !!(flip & 2)), ...walk }
						]
					};
					const { scene, derived } = buildModel(g);
					const middle = middleOf(scene.footpathPaving('w')[0].description as RoadDescription);
					const crossings = scene.road('street')!.crossings.filter((c) => c.of !== undefined);
					const label = `${kind}, ${wide} m, ${degrees}°, ${shape}, ${flip}`;
					// One run across, one line.
					const l = linksOf(scene, derived);
					expectRule(scene, derived, l, label);
					const lines = l.cross;
					expect(lines.length, label).toBe(1);
					const [line] = lines;
					const street = derived.geos.get('street')!.path;
					// A crossing is carried straight from curb to curb, bent only as
					// the street bends: between the curbs its middle strays from a
					// curved footpath's, and follows a curved street's bend.
					const along = shape.endsWith('curved') ? Infinity : 0.05;
					const near = shape.endsWith('curved') ? 0.3 : 0.05;
					const ground = union(
						crossings.flatMap((c) => [...c.body, ...c.runs.flatMap((r) => r.rings)]).map(toPath)
					);
					const cut = cutLine(middle, ground.map(fromPath)).flatMap((piece) => [
						piece.line[0],
						piece.line.at(-1)!
					]);
					const grown = offset(ground, 0.05);
					for (const p of line) {
						expect(inside(grown, p), label).toBe(true);
						expect(offLine(p, middle), label).toBeLessThan(along + 0.02);
					}
					for (const p of [line[0], line.at(-1)!])
						expect(
							Math.min(...cut.map((q) => Math.hypot(p.x - q.x, p.y - q.y))),
							label
						).toBeLessThan(near);
					expect(
						Math.hypot(line[0].x - line.at(-1)!.x, line[0].y - line.at(-1)!.y),
						label
					).toBeGreaterThan(1);
					// Read along and across the street, it runs straight: it keeps as
					// far to the side of the street's line as straight across from
					// one curb to the other, wherever the street bends (within 0.3 m;
					// a line cut straight across the curved street here strays from
					// that by well over a metre).
					const [p0, p1] = [onStreet(street, line[0]), onStreet(street, line.at(-1)!)];
					if (Math.abs(p1.s - p0.s) > 0.5)
						for (const q of sampled(line, 0.25)) {
							const at = onStreet(street, q);
							const f = (at.s - p0.s) / (p1.s - p0.s);
							expect(Math.abs(at.d - (p0.d + (p1.d - p0.d) * f)), label).toBeLessThan(0.3);
						}
					checked++;
				}
	expect(checked).toBe(35 * 5);
});

// A footpath bent across a Street is joined to each sidewalk it passes over
// once, wherever its bend lies: slid away from the street in 5 cm steps, in
// millimetre steps through the stretch where the 8 m path's strip stops on
// the north sidewalk's middle and its bend takes over, and in millimetre
// steps across that middle, where both paths end on the sidewalk and are
// each joined where their line onto it arrives. Built as a drag builds, one Networks
// through every step, and against a fresh build every tenth.
test('a bent footpath is joined once to each sidewalk it passes over, wherever its bend lies', () => {
	const steps = (from: number, to: number, by: number) =>
		Array.from({ length: Math.round((to - from) / by) + 1 }, (_, i) => from + i * by);
	let checked = 0;
	for (const wide of [2, 4, 8]) {
		const g: GraphData = {
			nodes: nodes({ s0: [-55, 0], s1: [55, 0], p: [0, -20], j: [0, 8], q: [35, 20] }),
			segments: [
				seg('street', 's0', 's1', preset('street'), wide === 4),
				seg('p', 'p', 'j', path(wide), wide === 2),
				seg('q', 'j', 'q', path(wide), wide === 8)
			]
		};
		const live = liveShape(g);
		const builder = new Networks();
		const ys = [
			...steps(5.6, 12, 0.05),
			...(wide === 8 ? steps(8.87, 8.91, 0.001) : []),
			...steps(4.45, 4.55, 0.001)
		];
		for (const [k, y] of ys.entries()) {
			live.nodes.get('j')!.y = y;
			g.nodes.find((n) => n.id === 'j')!.y = y;
			const { scene, derived } = builder.build(live as never);
			const l = linksOf(scene, derived);
			const label = `${wide} m, bend at ${y.toFixed(3)}`;
			expectRule(scene, derived, l, label);
			// On the footpath's paving, strips and bend.
			const paving = offset(
				union(
					['p', 'q'].flatMap((id) =>
						scene.footpathPaving(id).flatMap((p) => p.description.surfaces.flatMap(shapeOf))
					)
				),
				0.05
			);
			const onPath = (p: Pt) => inside(paving, p);
			const onWalk = y < SIDEWALK + 1;
			// Once on the south sidewalk; on the north one once, or where each
			// path's end arrives on it where the bend lies on it.
			const ys = l.joins.map((p) => Math.round(p.y * 10) / 10);
			expect(ys.filter((y) => y === -SIDEWALK).length, label).toBe(1);
			expect(ys.filter((y) => y === SIDEWALK).length, label).toBeGreaterThan(0);
			expect(ys.filter((y) => y === SIDEWALK).length, label).toBeLessThanOrEqual(onWalk ? 2 : 1);
			expect(ys.length, label).toBe(ys.filter((y) => Math.abs(y) === SIDEWALK).length);
			expect(l.joins.every(onPath), label).toBe(true);
			expect(l.onto.length, label).toBe(onWalk ? 2 : 0);
			expect(l.cross.length, label).toBe(1);
			expect(
				ends(l.cross[0])
					.map((p) => Math.round(p.y * 100) / 100)
					.sort((a, b) => a - b),
				label
			).toEqual([-CURB, CURB]);
			if (k % 10 === 0) expect(l, label).toEqual(links(g));
			checked++;
		}
	}
	expect(checked).toBeGreaterThan(500);
});

// A footpath straight across a street, of every length from wholly inside
// the roadway to well beyond both sidewalks, both ends moved out together or
// one end held beyond its sidewalk: joined to each sidewalk it reaches, by
// its line onto it where its end lies on the sidewalk and where it crosses
// the sidewalk's middle where it runs on past, and with a line across from
// curb to curb where it reaches past both curbs. On a Street and an Avenue,
// paths 2, 4 and 8 m wide, each road stored either way.
test('a footpath straight across a street of any length is joined to each sidewalk it reaches', () => {
	const streets = {
		street: { walk: 4.5, half: 1, curb: 3.5 },
		avenue: { walk: 10.5, half: 1.5, curb: 8 }
	};
	let checked = 0;
	for (const [kind, { walk, half, curb }] of Object.entries(streets))
		for (const wide of [2, 4, 8])
			for (const held of [false, true])
				for (let h = 0.26; h < walk + half + 3; h += 0.25) {
					const south = held ? -(walk + half + 3) : -h;
					const flip = checked % 4;
					const g: GraphData = {
						nodes: nodes({ s0: [-40, 0], s1: [40, 0], p: [0, south], q: [0, h] }),
						segments: [
							seg('street', 's0', 's1', preset(kind), !!(flip & 1)),
							seg('w', 'p', 'q', path(wide), !!(flip & 2))
						]
					};
					const label = `${kind}, ${wide} m, ${south.toFixed(2)} to ${h.toFixed(2)}, ${flip}`;
					const l = links(g, label);
					// Each sidewalk the footpath reaches, joined once at its middle.
					const reached = [south, h].filter((e) => Math.abs(e) > walk - half);
					expect(
						l.joins.map((p) => Math.round(p.y * 10) / 10).sort((a, b) => a - b),
						label
					).toEqual(reached.map((e) => Math.sign(e) * walk).sort((a, b) => a - b));
					expect(
						l.joins.every((p) => Math.abs(p.x) < 0.01),
						label
					).toBe(true);
					expect(l.onto.length, label).toBe(
						reached.filter((e) => Math.abs(e) < walk + half).length
					);
					// A line from curb to curb where it reaches past both.
					const over = Math.abs(south) > curb && h > curb;
					expect(l.cross.length, label).toBe(over ? 1 : 0);
					for (const line of l.cross) {
						expect(
							line.every((p) => Math.abs(p.x) < 0.01),
							label
						).toBe(true);
						expect(
							ends(line)
								.map((p) => Math.round(p.y * 100) / 100)
								.sort((a, b) => a - b),
							label
						).toEqual([-curb, curb]);
					}
					checked++;
				}
	expect(checked).toBeGreaterThan(200);
});

// Footpaths across one Street side by side, apart or one inside another's
// crossing, with their ids in every order: each run across has its line from
// curb to curb along its own footpath's middle, and each footpath is joined
// to both sidewalks, whichever crossing paints the ground they share.
test('footpaths crossing side by side each have their line and their joins, whatever their ids', () => {
	const sets: [number, number][][] = [
		[
			[0, 8],
			[1, 2]
		],
		[
			[0, 4],
			[6, 4]
		],
		[
			[0, 8],
			[1, 2],
			[-2.5, 4]
		]
	];
	const orders = (ids: string[]): string[][] =>
		ids.length < 2
			? [ids]
			: ids.flatMap((id, i) =>
					orders([...ids.slice(0, i), ...ids.slice(i + 1)]).map((o) => [id, ...o])
				);
	let checked = 0;
	for (const set of sets)
		for (const ids of orders(['a', 'm', 'z'].slice(0, set.length)))
			for (const flip of [0, 1]) {
				const g: GraphData = {
					nodes: [
						...nodes({ s0: [-40, 0], s1: [40, 0] }),
						...set.flatMap(([x], i) => nodes({ [`p${i}`]: [x, -22], [`q${i}`]: [x, 22] }))
					],
					segments: [
						seg('street', 's0', 's1', preset('street'), !!flip),
						...set.map(([, wide], i) =>
							seg(ids[i], `p${i}`, `q${i}`, path(wide), !!((flip + i) % 2))
						)
					]
				};
				const label = `${JSON.stringify(set)}, ${ids}, ${flip}`;
				const l = links(g, label);
				const xs = set.map(([x]) => x).sort((a, b) => a - b);
				const at = (pts: Pt[]) => pts.map((p) => Math.round(p.x * 100) / 100).sort((a, b) => a - b);
				expect(at(l.cross.map((line) => line[0])), label).toEqual(xs);
				for (const line of l.cross) {
					expect(
						line.every((p) => Math.abs(p.x - line[0].x) < 0.01),
						label
					).toBe(true);
					expect(
						ends(line)
							.map((p) => Math.abs(Math.round(p.y * 100) / 100))
							.sort(),
						label
					).toEqual([CURB, CURB]);
				}
				for (const y of [-SIDEWALK, SIDEWALK])
					expect(at(l.joins.filter((p) => Math.abs(p.y - y) < 0.01)), label).toEqual(xs);
				expect(l.joins.length, label).toBe(2 * set.length);
				checked++;
			}
	expect(checked).toBe(2 * (2 + 2 + 6));
});

// A joint of footpaths on or beside a Street's north sidewalk, its arms
// running along the street, each shifted to one side or the other, so their
// shown ends lie either side of the sidewalk and the links through the joint
// cross its middle: each point a drawn walking line crosses the middle has a
// dot (expectJoins). Joints of three and four 4 m paths, every arm shifted
// 1.6 m either way, the joint on the sidewalk's middle, on the sidewalk
// beside its middle, in the roadway and beyond the sidewalk, each road stored
// either way.
test('the links through a joint of shifted footpaths are joined where they cross a sidewalk', () => {
	const arms: Record<string, [number, number][]> = {
		three: [
			[-24, 0],
			[24, 0],
			[-24, -1]
		],
		four: [
			[-24, 0],
			[24, 0],
			[-24, -1],
			[24, 1]
		]
	};
	let checked = 0;
	let crossed = 0;
	for (const [kind, far] of Object.entries(arms))
		for (let shifts = 0; shifts < 1 << far.length; shifts++)
			for (const jy of [SIDEWALK, 4, 2.8, 6.5]) {
				const flip = checked;
				const g: GraphData = {
					nodes: nodes({
						s0: [-55, 0],
						s1: [55, 0],
						j: [0, jy],
						...Object.fromEntries(far.map(([x, dy], i) => [`e${i}`, [x, jy + dy]]))
					}),
					segments: [
						seg('street', 's0', 's1', preset('street'), !!(flip & 1)),
						...far.map((_, i) => {
							const back = !!((flip >> (i + 1)) & 1);
							const d = (shifts >> i) & 1 ? 1.6 : -1.6;
							return {
								...seg(`p${i}`, 'j', `e${i}`, path(4), back),
								offsetStart: back ? -d : d,
								offsetEnd: back ? -d : d
							};
						})
					]
				};
				const l = links(g, `${kind}, shifts ${shifts}, joint at ${jy}, ${flip % 32}`);
				if (
					l.walk.some(
						(line) => line.some((p) => p.y > SIDEWALK) && line.some((p) => p.y < SIDEWALK)
					)
				)
					crossed++;
				checked++;
			}
	expect(checked).toBe(4 * (8 + 16));
	// The links through the joint cross the sidewalk's middle in many of them.
	expect(crossed).toBeGreaterThan(20);
	// West arms shifted south, the east one north, the joint on the middle:
	// the links through it cross the middle where the joint lies.
	const l = links({
		nodes: nodes({
			s0: [-55, 0],
			s1: [55, 0],
			j: [0, 4.5],
			w: [-24, 4.5],
			e: [24, 4.5],
			t: [-24, 3.5]
		}),
		segments: [
			seg('street', 's0', 's1', preset('street'), false),
			{ ...seg('west', 'w', 'j', path(4), false), offsetStart: -1.6, offsetEnd: -1.6 },
			{ ...seg('east', 'j', 'e', path(4), false), offsetStart: 1.6, offsetEnd: 1.6 },
			{ ...seg('west2', 't', 'j', path(4), false), offsetStart: -2, offsetEnd: -2 }
		]
	});
	expect(l.joins.some((p) => near(p, { x: 0, y: SIDEWALK }, JOIN))).toBe(true);
});

// A street with a second sidewalk beyond a 0.4 m verge, on one side or on
// both, and a footpath straight across from beyond the south side, its north
// end stepped from the roadway over the inner sidewalk, the verge and the
// outer sidewalk and on beyond: joined once at the middle of each sidewalk it
// reaches, whether it ends on it or passes over it on its way to another.
// Paths 2 and 4 m wide, each road stored either way.
test('a footpath is joined to each of two sidewalks side by side it reaches', () => {
	const walk = (id: string) => lane(id, 'pedestrian', 2);
	const verge = (id: string): Lane => ({ ...lane(id, 'buffer', 0.4), material: 'grass' });
	const cars = [lane('v0', 'vehicle', 3.5, 'backward'), lane('v1', 'vehicle', 3.5, 'forward')];
	const streets = {
		'one side': [walk('w0'), ...cars, walk('w1'), verge('g1'), walk('w2')],
		'both sides': [
			walk('w3'),
			verge('g0'),
			walk('w0'),
			...cars,
			walk('w1'),
			verge('g1'),
			walk('w2')
		]
	};
	let checked = 0;
	for (const [kind, lanes] of Object.entries(streets)) {
		// Each lane's span across the street, from its right (south) side.
		const total = lanes.reduce((sum, l) => sum + l.width, 0);
		let y = -total / 2;
		const spans = lanes.map((l) => {
			const span = { lane: l, lo: y, hi: (y += l.width) };
			return span;
		});
		const walks = spans.filter((s) => s.lane.role === 'pedestrian');
		const edges = spans.map((s) => s.lo);
		for (const wide of [2, 4])
			for (let h = 0.5; h < total / 2 + 3; h += 0.25) {
				if (edges.some((e) => Math.abs(e - h) < 0.06)) continue;
				const flip = checked % 4;
				const south = -total / 2 - 6;
				const label = `${kind}, ${wide} m, to ${h}, ${flip}`;
				const l = links(
					{
						nodes: nodes({ s0: [-55, 0], s1: [55, 0], p: [0, south], q: [0, h] }),
						segments: [
							// Stored the other way, its lanes run the other way round.
							seg('street', 's0', 's1', flip & 1 ? [...lanes].reverse() : lanes, !!(flip & 1)),
							seg('w', 'p', 'q', path(wide), !!(flip & 2))
						]
					},
					label
				);
				const reached = walks.filter((s) => s.lo < h).map((s) => (s.lo + s.hi) / 2);
				expect(
					l.joins.map((p) => Math.round(p.y * 100) / 100).sort((a, b) => a - b),
					label
				).toEqual(reached.map((m) => Math.round(m * 100) / 100).sort((a, b) => a - b));
				expect(
					l.joins.every((p) => Math.abs(p.x) < 0.01),
					label
				).toBe(true);
				checked++;
			}
	}
	expect(checked).toBeGreaterThan(100);
});

// In the editor, stored either way: the links through a joint of shifted
// footpaths on a sidewalk are joined where they cross its middle, and a
// footpath ending on a second sidewalk beyond a verge is joined to the first
// one it passes over; as a fresh build shows them.
test('the overlay joins shifted joints and second sidewalks as a fresh build does', () => {
	const key = (p: Pt) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
	for (const back of [false, true]) {
		const shift = (s: SegmentData, d: number) => ({
			...s,
			offsetStart: back ? -d : d,
			offsetEnd: back ? -d : d
		});
		const fork: GraphData = {
			nodes: nodes({
				s0: [-55, 0],
				s1: [55, 0],
				j: [0, 4.5],
				w: [-24, 4.5],
				e: [24, 4.5],
				t: [-24, 3.5]
			}),
			segments: [
				seg('street', 's0', 's1', preset('street'), back),
				shift(seg('west', 'w', 'j', path(4), back), -1.6),
				shift(seg('east', 'j', 'e', path(4), back), 1.6),
				shift(seg('west2', 't', 'j', path(4), back), -2)
			]
		};
		const lanes = [
			...preset('street'),
			{ ...lane('g', 'buffer', 0.4), material: 'grass' as const },
			lane('outer', 'pedestrian', 2)
		];
		const two: GraphData = {
			nodes: nodes({ s0: [-55, 0], s1: [55, 0], p: [0, -16], q: [0, 5.9] }),
			segments: [
				seg('street', 's0', 's1', back ? [...lanes].reverse() : lanes, back),
				seg('w', 'p', 'q', path(2), back)
			]
		};
		for (const [name, g, at] of [
			['shifted joint', fork, { x: 0, y: 4.5 }],
			['two sidewalks', two, { x: 0, y: 3.3 }]
		] as const) {
			const ui = openEditor(g);
			ui.editor.toggleConnections();
			frame();
			const shown = ui.editor.roadRenderer.overlayShown().joins;
			const label = `${name}, ${back}`;
			expect(shown.map(key).sort(), label).toEqual(links(g, label).joins.map(key).sort());
			expect(
				shown.some((p) => near(p, at, JOIN)),
				label
			).toBe(true);
		}
	}
});

// Where a footpath's paving meets a car road's sidewalk at the road's dead
// end, the build joins the two (deadEndJoins), and a dot stands for it
// (expectJoins): a footpath straight across just past or over the end, at
// every distance from it, one ending part way onto a sidewalk's end from
// beside it, a footpath node on the dead end with its footpath running on
// straight or turning off, on a Street and an Avenue, at either end,
// footpaths 2 and 4 m wide, each stored either way.
test("a footpath's paving joining a street's sidewalks at its dead end has a dot on each", () => {
	let checked = 0;
	let joined = 0;
	for (const kind of ['street', 'avenue'])
		for (const wide of [2, 4])
			for (let flip = 0; flip < 4; flip++) {
				const street = seg('street', 's0', 's1', preset(kind), !!(flip & 1));
				const at = { s0: [-50, 0], s1: [50, 0] } as Record<string, [number, number]>;
				const graphs: [string, GraphData][] = [];
				for (const end of [-50, 50])
					for (let dx = -3; dx <= 3; dx += 0.25) {
						const x = end + Math.sign(end) * dx;
						graphs.push([
							`across at ${x}`,
							{
								nodes: nodes({ ...at, p: [x, -20], q: [x, 20] }),
								segments: [street, seg('p', 'p', 'q', path(wide), !!(flip & 2))]
							}
						]);
					}
				for (const end of [-50, 50])
					for (const dx of [-0.5, 0.5, 1])
						for (const y of [3.2, 4.2, 4.7, 5.3]) {
							const x = end + Math.sign(end) * dx;
							graphs.push([
								`ending at ${x}, ${y}`,
								{
									nodes: nodes({ ...at, p: [x, y], q: [x, 20] }),
									segments: [street, seg('p', 'p', 'q', path(wide), !!(flip & 2))]
								}
							]);
						}
				for (const [name, far] of [
					['straight on', [70, 0]],
					['turning off', [50, 20]]
				] as const)
					graphs.push([
						`on the dead end, ${name}`,
						{
							nodes: nodes({ ...at, j: [50, 0], q: far as [number, number] }),
							segments: [street, seg('p', 'j', 'q', path(wide), !!(flip & 2))]
						}
					]);
				for (const [name, g] of graphs) {
					const label = `${kind}, ${wide} m, ${name}, ${flip}`;
					const { scene, derived } = buildModel(g);
					const l = linksOf(scene, derived);
					expectRule(scene, derived, l, label);
					if (deadEndJoins(scene, derived).length) joined++;
					checked++;
				}
			}
	expect(checked).toBe(2 * 2 * 4 * (2 * 25 + 2 * 3 * 4 + 2));
	expect(joined).toBeGreaterThan(checked / 4);
	// A 2 m path just past a Street's dead end, its paving over the ends of
	// both sidewalks: a dot at each sidewalk middle's end.
	const l = links({
		nodes: nodes({ s0: [-50, 0], s1: [50, 0], p: [50.5, -15], q: [50.5, 15] }),
		segments: [
			seg('street', 's0', 's1', preset('street'), false),
			seg('p', 'p', 'q', path(2), false)
		]
	});
	for (const y of [-SIDEWALK, SIDEWALK])
		expect(l.joins.some((p) => near(p, { x: 50, y }, 0.01))).toBe(true);
	// One ending at y 4.7 beside the north sidewalk's end shares its outer
	// 0.8 m with it: a dot at the middle of that.
	const short = links({
		nodes: nodes({ s0: [-50, 0], s1: [50, 0], p: [50.5, 4.7], q: [50.5, 15] }),
		segments: [
			seg('street', 's0', 's1', preset('street'), false),
			seg('p', 'p', 'q', path(2), false)
		]
	});
	expect(short.joins.filter((p) => near(p, { x: 50, y: 5.1 }, 0.02))).toHaveLength(1);
});

// The example city, whole: every walking line on a walker's ground, every
// join the build makes with its dot.
test('the example city keeps the overlay rule', () => {
	const g = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8')).graph;
	links(g, 'neighbourhood');
}, 30_000);

// Every corner sidewalk a junction carries round its corner is shown once,
// along its middle, over any road's mouth it crosses on the way too, so its
// crossing there draws no line of its own; and no junction keeps a crossing
// with nothing of it painted or paved.
test("every corner's sidewalk in the example city is shown along its middle, once", () => {
	const g = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8')).graph;
	const { scene, derived } = buildModel(g);
	const l = linksOf(scene, derived);
	let corners = 0;
	for (const { id } of scene.place.junctions) {
		const node = id.startsWith(WALK) ? undefined : scene.node(id);
		if (!node) continue;
		for (const c of node.crossings) expect(c.runs.length, `${id} ${c.id}`).toBeGreaterThan(0);
		for (const w of node.walkways ?? []) {
			corners++;
			const name = `${id} ${walkwayId(w.a, w.b)}`;
			expect(l.street.filter((line) => line === w.line).length, name).toBe(1);
			const crossing = node.crossings.find((c) => c.id === walkwayId(w.a, w.b));
			if (crossing) expect(l.street.includes(crossing.line), name).toBe(false);
		}
	}
	expect(corners).toBeGreaterThan(300);
}, 30_000);

// Dragging a node of the example city with the overlay on: after each move
// what the overlay draws is what a fresh build shows, though most of it is
// kept from the move before.
test("the overlay drawn through a drag in the example city is a fresh build's", () => {
	const g = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8'))
		.graph as GraphData;
	const ui = openEditor(g, 0.2);
	ui.editor.toggleConnections();
	frame();
	// Each of one list matched by one of the other, point for point within
	// a centimetre (the overlay's points are held in single precision).
	const expectSame = (shown: Pt[][], fresh: Pt[][], label: string) => {
		expect(shown.length, label).toBe(fresh.length);
		const left = [...shown];
		for (const line of fresh) {
			const k = left.findIndex(
				(other) => other.length === line.length && other.every((p, i) => near(p, line[i], 0.01))
			);
			expect(k, `${label}: ${JSON.stringify(line[0])}`).toBeGreaterThanOrEqual(0);
			left.splice(k, 1);
		}
	};
	const at = ui.node('node-227');
	const from = { x: at.x, y: at.y };
	ui.fire('mousedown', from.x, from.y);
	for (const [k, d] of [
		[1, 3],
		[2, 6],
		[3, 2]
	].entries()) {
		ui.fire('mousemove', from.x + d[0], from.y + d[1]);
		const shown = ui.editor.roadRenderer.overlayShown();
		const { scene, derived } = buildModel(ui.graph());
		const fresh = linksOf(scene, derived);
		expectSame(
			shown.joins.map((p) => [p]),
			fresh.joins.map((p) => [p]),
			`move ${k}, dots`
		);
		expectSame(shown.walk, [...fresh.street, ...walkingLines(fresh)], `move ${k}, walking`);
		expectSame(shown.drive, fresh.drive, `move ${k}, driving`);
	}
	ui.fire('mouseup', from.x + 3, from.y + 2);
}, 30_000);

// A street's dead end moved under a footpath that passes it, the footpath
// itself unchanged: the overlay's dots follow the sidewalks' ends, as a
// fresh build shows them, each road stored either way.
test("the overlay's dots follow a street's dead end moved under a footpath", () => {
	for (const back of [false, true]) {
		const ui = openEditor({
			nodes: nodes({ s0: [-50, 0], s1: [50, 0], p: [50.5, -15], q: [50.5, 15] }),
			segments: [
				seg('street', 's0', 's1', preset('street'), back),
				seg('p', 'p', 'q', path(2), back)
			]
		});
		ui.editor.toggleConnections();
		frame();
		const key = (p: Pt) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
		ui.fire('mousedown', 50, 0);
		for (const x of [49.9, 49.7, 49.6, 50.2]) {
			ui.fire('mousemove', x, 0);
			const label = `${back}, end at ${x}`;
			expect(ui.node('s1').x, label).toBeCloseTo(x, 1);
			const shown = ui.editor.roadRenderer.overlayShown().joins;
			expect(shown.map(key).sort(), label).toEqual(links(ui.graph(), label).joins.map(key).sort());
			expect(shown.length, label).toBe(2);
		}
		ui.fire('mouseup', 50.2, 0);
	}
});

// A street's dead end dragged to and fro past footpaths across its end, at
// distances from a few centimetres to a metre past it, a 2 m and a 4 m one,
// on a Street and an Avenue, each road stored either way: after every move,
// the release, the overlay hidden and shown again, undo and redo, what the
// overlay draws is what a fresh read of the graph shows, dots and lines.
// Among them, a 2 m path at x 51.01 and the end dragged from 46 through 50,
// 50.1 and 50 and back to 45.
test("the overlay drawn through edits around a dead end is a fresh read's", () => {
	const key = (p: Pt) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
	const lineKey = (line: Pt[]) => line.map(key).join('>');
	let steps = 0;
	for (const kind of ['street', 'avenue'])
		for (const [x, wide] of [
			[51.01, 2],
			[50.03, 2],
			[50.5, 4],
			[51, 4]
		])
			for (let flip = 0; flip < 4; flip++) {
				const ui = openEditor(
					{
						nodes: nodes({ s0: [-50, 0], s1: [46, 0], p: [x, -15], q: [x, 15] }),
						segments: [
							seg('street', 's0', 's1', preset(kind), !!(flip & 1)),
							seg('p', 'p', 'q', path(wide), !!(flip & 2))
						]
					},
					0.1
				);
				ui.editor.toggleConnections();
				frame();
				const expectFresh = (label: string) => {
					const shown = ui.editor.roadRenderer.overlayShown();
					const { scene, derived } = buildModel(ui.graph());
					const fresh = linksOf(scene, derived);
					expect(shown.joins.map(key).sort(), label).toEqual(fresh.joins.map(key).sort());
					expect(shown.walk.map(lineKey).sort(), label).toEqual(
						[...fresh.street, ...walkingLines(fresh)].map(lineKey).sort()
					);
					steps++;
				};
				const label = `${kind}, ${wide} m at ${x}, ${flip}`;
				expectFresh(`${label}, opened`);
				const before = ui.graph();
				ui.fire('mousedown', 46, 0);
				const moves = [49.9, 50, 50.1, 50, 49.9, 45, 49.98, 50.02, 50.6, 51.2, 50, 47];
				for (const to of moves) {
					ui.fire('mousemove', to, 0);
					expect(ui.node('s1').x, label).toBeCloseTo(to, 3);
					expectFresh(`${label}, end at ${to}`);
				}
				ui.fire('mouseup', moves.at(-1)!, 0);
				expectFresh(`${label}, released`);
				ui.editor.toggleConnections();
				ui.editor.toggleConnections();
				frame();
				expectFresh(`${label}, shown again`);
				const after = ui.graph();
				expect(after, label).not.toEqual(before);
				ui.key('z', { ctrl: true });
				expect(ui.graph(), label).toEqual(before);
				expectFresh(`${label}, undone`);
				ui.key('z', { ctrl: true, shift: true });
				expectFresh(`${label}, redone`);
			}
	expect(steps).toBe(2 * 4 * 4 * 17);
});

// A joint of three footpaths in a Street's roadway, its crossings held by the
// least of them: moving another one's far end turns the runs across, and the
// overlay's crossing lines follow, as a fresh build shows them.
test("the overlay's crossing lines follow a run turned by another footpath of the crossing", () => {
	const ui = openEditor({
		nodes: nodes({ s0: [-50, 0], s1: [50, 0], j: [0, 0], a: [0, -20], b: [10, 20], c: [-20, 20] }),
		segments: [
			seg('street', 's0', 's1', preset('street'), false),
			seg('a', 'a', 'j', path(2), false),
			seg('b', 'j', 'b', path(2), true),
			seg('c', 'j', 'c', path(2), false)
		]
	});
	ui.editor.toggleConnections();
	frame();
	const key = (line: Pt[]) => line.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('>');
	ui.fire('mousedown', 10, 20);
	for (const x of [14, 18, 22]) {
		ui.fire('mousemove', x, 20);
		const label = `far end at ${x}`;
		expect(ui.node('b').x, label).toBeCloseTo(x, 1);
		const fresh = links(ui.graph(), label);
		expect(ui.editor.roadRenderer.overlayShown().walk.map(key).sort(), label).toEqual(
			[...fresh.street, ...walkingLines(fresh)].map(key).sort()
		);
	}
	ui.fire('mouseup', 22, 20);
});

// A footpath whose paving reaches a junction's ground has no crossing there
// (onJunction in core/networks.ts), so the overlay draws no crossing line
// over the junction, and the footpath's own line stops at the asphalt:
// swept over junctions of the app's presets (a four-way, a T, an X at
// unequal angles, Avenues, a divided road across an undivided one, arms
// without sidewalks) with a footpath through the middle, a corner and an
// arm's mouth, a diagonal and two meeting in the middle, both ways stored; a
// curved footpath through a four-way; and seeded junctions of mixed presets
// a few degrees off square (sweepCase), each slid over three steps. Every
// scene keeps the overlay's rule (expectRule), and no crossing the overlay
// reads lies on the junction's ground.
test('a footpath through a junction has no crossing there and keeps the overlay rule', () => {
	const scenes: [string, GraphData][] = [];
	const u = at(30, 1);
	const c = 17;
	for (const { name, arms } of junctions)
		for (const flip of [false, true]) {
			const long = arms.map((a) => ({ ...a, to: { x: a.to.x * 2.5, y: a.to.y * 2.5 } }));
			for (const [where, off] of [
				['middle', 0],
				['corner', 9],
				['mouth', -16]
			] as const) {
				const line = [-1, 1].map((k) => ({
					x: -u.y * off + u.x * 70 * k,
					y: u.x * off + u.y * 70 * k
				}));
				scenes.push([`${name}, ${where}, ${flip}`, withPaths(junction(long, flip), [line], flip)]);
			}
			const corners = [
				{ x: -c, y: -c },
				{ x: c, y: -c },
				{ x: c, y: c },
				{ x: -c, y: c }
			];
			const middle = { x: 0, y: 0 };
			scenes.push([
				`${name}, diagonal, ${flip}`,
				withPaths(junction(arms, flip), [[corners[0], corners[2]]], flip)
			]);
			scenes.push([
				`${name}, two diagonals meeting in the middle, ${flip}`,
				withPaths(
					junction(arms, flip),
					[
						[corners[0], middle, corners[2]],
						[corners[1], middle, corners[3]]
					],
					flip
				)
			]);
		}
	const four = ['n', 's', 'e', 'w'].map((id, i) => seg(id, 'j', id, preset('street'), i % 2 === 1));
	for (let flip = 0; flip < 2; flip++)
		scenes.push([
			`curved through a four-way, ${flip}`,
			{
				nodes: nodes({
					j: [0, 0],
					n: [0, -40],
					s: [0, 40],
					e: [40, 0],
					w: [-40, 0],
					p: [-5, -16],
					q: [3, 16]
				}),
				segments: [
					...four,
					{ ...seg('p', 'p', 'q', preset('path'), !!flip), controlX: 8, controlY: 0 }
				]
			}
		]);
	const random = seeded(SWEEP_SEED);
	for (let n = 0; n < 12; n++) {
		const { graph, lines, label } = sweepCase(random);
		lines.forEach((line, step) => scenes.push([`${label}, step ${step}`, slid(graph, line)]));
	}
	const problems: string[] = [];
	for (const [label, g] of scenes) {
		const { scene, derived } = buildModel(g);
		const l = linksOf(scene, derived);
		try {
			expectRule(scene, derived, l, label);
		} catch (e) {
			problems.push((e as Error).message.split('\n')[0]);
		}
		const j = scene.node('j');
		const ground = union(
			(j?.surfaces ?? [])
				.filter((x) => x.role === 'lane' || x.role === 'paving' || x.role === 'median')
				.flatMap(shapeOf)
		);
		const walking = scene.walking();
		for (const s of g.segments)
			for (const { rings } of walking.runsOf(s.id))
				if (intersect(rings, ground).length)
					problems.push(`${label}: ${s.id} crosses the junction`);
	}
	expect(problems).toEqual([]);
	expect(scenes.length).toBeGreaterThan(80);
}, 60_000);

// A crossing's line lies on that crossing's paint, never on asphalt beside
// it: an Avenue bent to its dead end (its roadway's footprint reaching past
// where a footpath's crossing over it is painted) crossed at a slant at
// several places along it, through its end and past it, either way, the
// Avenue and the footpath each stored either way (expectLines).
test("a crossing's line lies on its paint where the roadway reaches past it", () => {
	let checked = 0;
	for (let flip = 0; flip < 4; flip++)
		for (const bow of [-5, 0, 5])
			for (const dx of [-30, -15, -6, 0, 4, 8])
				for (const way of [1, -1]) {
					const g: GraphData = {
						nodes: nodes({
							a: [-55, 0],
							b: [10, 0],
							p: [35 + dx, -25 * way],
							q: [-25 + dx, 25 * way]
						}),
						segments: [
							{
								...seg('avenue', 'a', 'b', preset('avenue'), !!(flip & 1)),
								controlX: 10,
								controlY: bow
							},
							seg('p', 'p', 'q', path(2), !!(flip & 2))
						]
					};
					links(g, `bow ${bow}, ${dx}, ${way}, ${flip}`);
					checked++;
				}
	expect(checked).toBe(144);
});

// The overlay keeps what it read only while it is shown, and only of the
// city open: hidden, it holds nothing, and a path deleted while it is hidden
// is gone from it; a city replaced (an empty one opened) leaves nothing of
// the one before, shown or hidden.
test('the overlay keeps nothing while hidden or of a city replaced', () => {
	const city = (): GraphData => ({
		nodes: nodes({ s0: [-40, 0], s1: [40, 0], a: [3, -20], b: [-3, 20] }),
		segments: [
			seg('street', 's0', 's1', preset('street'), false),
			seg('p', 'a', 'b', path(2), false)
		]
	});
	const ui = openEditor(city());
	const renderer = ui.editor.roadRenderer;
	const toggle = () => {
		ui.editor.toggleConnections();
		frame();
	};
	toggle();
	expect(renderer.overlayKept()).toBeGreaterThan(0);
	toggle();
	expect(renderer.overlayKept()).toBe(0);
	ui.editor.graph.deleteSegment('p');
	ui.editor.graph.save();
	frame();
	expect(renderer.overlayKept()).toBe(0);
	toggle();
	expect(renderer.showConnections).toBe(true);
	expect(renderer.overlayKept()).toBe(0);
	ui.editor.replaceGraph(city());
	frame();
	expect(renderer.overlayKept()).toBeGreaterThan(0);
	ui.editor.replaceGraph({ nodes: [], segments: [] });
	frame();
	expect(renderer.overlayShown().walk).toEqual([]);
	expect(renderer.overlayKept()).toBe(0);
});
