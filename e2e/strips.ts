import { expect, type Page } from '@playwright/test';
import { WALK } from '../src/lib/core/footpaths';
import { roadLine } from '../src/lib/core/road-line';
import { check } from '../src/lib/road-model/checks';
import { inside, piecesOf, toPath, union } from '../src/lib/road-model/clip';
import type { Description } from '../src/lib/road-model/description';
import { liveShape } from '../unit/model';
import { drawingOf, expectFreshDrawing, liveGraph, type Pt } from './app';

// Every piece's ground, joined.
function groundOf(pieces: Description[]) {
	const rings = pieces.flatMap((d) =>
		d.surfaces.flatMap((s) =>
			'left' in s.shape ? [[...s.shape.left, ...[...s.shape.right].reverse()]] : s.shape
		)
	);
	return union(rings.map(toPath));
}

// The nearest point of a polyline to `p`: how far, how far along it, and
// where (the segment and the fraction of the way along it).
const nearest = (line: Pt[], p: Pt) => {
	let best = { d: Infinity, s: 0, i: 0, f: 0 };
	let run = 0;
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const [dx, dy] = [b.x - a.x, b.y - a.y];
		const l = Math.hypot(dx, dy);
		const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (l * l || 1)));
		const d = Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
		if (d < best.d) best = { d, s: run + l * f, i: i - 1, f };
		run += l;
	}
	return best;
};

// The points of a line every half metre or closer, from `from` to `to`
// metres along it, each with its left normal.
const sampled = (line: Pt[], from: number, to: number) => {
	const out: { p: Pt; n: Pt }[] = [];
	let run = 0;
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const l = Math.hypot(b.x - a.x, b.y - a.y);
		if (!l) continue;
		const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
		const at = (s: number) => ({
			p: { x: a.x + ((b.x - a.x) * s) / l, y: a.y + ((b.y - a.y) * s) / l },
			n
		});
		const [s0, s1] = [Math.max(0, from - run), Math.min(l, to - run)];
		if (s0 <= s1) {
			const steps = Math.max(1, Math.ceil((s1 - s0) / 0.5));
			for (let k = 0; k <= steps; k++) out.push(at(s0 + ((s1 - s0) * k) / steps));
		}
		run += l;
	}
	return out;
};

const lengthOf = (line: Pt[]) =>
	line.reduce((s, p, i) => (i ? s + Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y) : 0), 0);

// What the editor draws for its footpaths, held to the strip rule
// (core/footpaths.ts) and the drawing rules (road-model/checks.ts):
// - each footpath's ground across its whole width along its line, from
//   node to node but where a bend takes it over: there it stops the same
//   way short of the node as the other footpath of the bend, and nowhere
//   else short of a node;
// - each bend's ground across the whole width its walker's line is drawn
//   at, all along that line;
// - at a node of three or more, or on a car road's dead end, the gap
//   between each two footpaths next to each other filled;
// - no footpath ground further from every footpath's line than its half
//   width, but a bend's, no further from its walker's line than half the
//   width drawn there, and at a node of three or more (or on a car road's
//   dead end), where an inside corner is rounded by a circle at most as wide
//   as the widest footpath there, no further than that widest half width
//   past a footpath's own.
// With no car road, the footpaths' ground is one piece; `apart` names
// footpaths laid over a car road, whose ground over its lanes is the
// crossing's.
export async function expectStrips(page: Page, apart: string[] = []) {
	await expectFreshDrawing(page);
	const graph = await liveGraph(page);
	const scene = await drawingOf(page);
	expect(check(scene)).toEqual([]);
	const car = graph.segments.filter((s) => s.lanes.some((l) => l.role === 'vehicle'));
	const carNodes = new Set(car.flatMap((s) => [s.startNodeId, s.endNodeId]));
	const walks = graph.segments.filter((s) => !car.includes(s));
	const pieces = [
		...scene.place.roads
			.filter((r) => !car.some((s) => s.id === r.id))
			.map((r) => scene.road(r.id)!),
		...scene.place.junctions
			.filter((j) => !j.members.every((m) => carNodes.has(m)))
			.map((j) => scene.node(j.id)!)
	];
	const ground = groundOf(pieces);
	if (!car.length) expect(piecesOf(ground)).toHaveLength(1);
	const live = liveShape(graph);
	const half = (id: string) =>
		graph.segments.find((s) => s.id === id)!.lanes.reduce((w, l) => w + l.width, 0) / 2;
	const lines = new Map(
		walks.map((s) => [s.id, roadLine(live as never, live.segments.get(s.id)! as never)])
	);
	const endsAt = (node: string) =>
		walks.filter((s) => s.startNodeId === node || s.endNodeId === node);
	// The bends: nodes of two footpaths drawn with a fill, lying where no
	// car node does (a car road's dead end is a joint).
	const bends = graph.nodes.filter(
		(n) =>
			endsAt(n.id).length === 2 &&
			scene.node(WALK + n.id) &&
			!graph.nodes.some((c) => carNodes.has(c.id) && Math.hypot(c.x - n.x, c.y - n.y) < 0.01)
	);
	const bent = new Set(bends.map((n) => n.id));
	// How far along its line from each end a footpath is drawn from: where
	// its drawn road stops, read onto its line (a footpath shifted more at
	// one end than the other reads a hair off its node there).
	const cuts = new Map(
		walks.map((s) => {
			const line = lines.get(s.id)!;
			const road = scene.place.roads.find((r) => r.id === s.id)!;
			const length = lengthOf(line);
			return [
				s.id,
				[nearest(line, road.points[0]).s, length - nearest(line, road.points.at(-1)!).s]
			] as const;
		})
	);
	// Across its whole width: from node to node, or from where a bend takes
	// it over, which is short of the node there and nowhere else.
	for (const [id, line] of lines) {
		if (apart.includes(id)) continue;
		const s = walks.find((w) => w.id === id)!;
		const [c0, c1] = cuts.get(id)!;
		for (const [node, c] of [
			[s.startNodeId, c0],
			[s.endNodeId, c1]
		] as const)
			expect([id, node, c > 0.05]).toEqual([id, node, bent.has(node)]);
		const h = half(id) - 0.05;
		for (const { p, n } of sampled(line, c0 + 0.05, lengthOf(line) - c1 - 0.05))
			for (const k of [-h, 0, h])
				expect([id, p, k, inside(ground, { x: p.x + n.x * k, y: p.y + n.y * k })]).toEqual([
					id,
					p,
					k,
					true
				]);
	}
	// Each bend: both footpaths stop the same way short of it, and its ground
	// is as wide as its walker's line is drawn, all along it.
	for (const node of bends) {
		const [a, b] = endsAt(node.id).map((s) => cuts.get(s.id)![s.startNodeId === node.id ? 0 : 1]);
		expect([node.id, a]).toEqual([node.id, expect.closeTo(b, 3)]);
		const { line, widths } = scene.node(WALK + node.id)!.paths[0];
		for (const [i, p] of line.entries()) {
			const [q, o] = [line[Math.min(i + 1, line.length - 1)], line[Math.max(i - 1, 0)]];
			const d = Math.hypot(q.x - o.x, q.y - o.y) || 1;
			const n = { x: -(q.y - o.y) / d, y: (q.x - o.x) / d };
			const h = widths[i] / 2 - 0.05;
			for (const k of [-h, 0, h])
				expect([node.id, i, k, inside(ground, { x: p.x + n.x * k, y: p.y + n.y * k })]).toEqual([
					node.id,
					i,
					k,
					true
				]);
		}
	}
	// The gap between each two footpaths next to each other round a node of
	// three or more, or on a car road's dead end.
	for (const node of graph.nodes) {
		if (bent.has(node.id)) continue;
		const ends = endsAt(node.id)
			.filter((s) => !apart.includes(s.id))
			.map((s) => {
				const line = lines.get(s.id)!;
				const [p, q] =
					s.startNodeId === node.id ? [line[0], line[1]] : [line.at(-1)!, line.at(-2)!];
				const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
				const out = { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
				const h = half(s.id) - 0.05;
				return {
					angle: Math.atan2(out.y, out.x),
					left: { x: p.x - out.y * h, y: p.y + out.x * h },
					right: { x: p.x + out.y * h, y: p.y - out.x * h }
				};
			})
			.sort((a, b) => a.angle - b.angle);
		if (ends.length < 2) continue;
		for (const [i, a] of ends.entries()) {
			const b = ends[(i + 1) % ends.length];
			const mid = { x: (a.left.x + b.right.x) / 2, y: (a.left.y + b.right.y) / 2 };
			expect([node.id, i, inside(ground, mid)]).toEqual([node.id, i, true]);
		}
	}
	// Nothing past any footpath's half width, but a bend's ground and a
	// rounded inside corner of a joint, each as far as above.
	const joint = new Map(
		graph.nodes.map((n) => {
			const here = endsAt(n.id);
			const widest = Math.max(0, ...here.map((s) => half(s.id)));
			return [n.id, here.length > 1 && !bent.has(n.id) ? widest : 0];
		})
	);
	const walked = bends.map((n) => scene.node(WALK + n.id)!.paths[0]);
	for (const ring of ground)
		for (const v of ring) {
			const p = { x: v.X / 1000, y: v.Y / 1000 };
			const near =
				[...lines].some(([id, line]) => {
					const s = walks.find((w) => w.id === id)!;
					const past = Math.max(joint.get(s.startNodeId)!, joint.get(s.endNodeId)!);
					return nearest(line, p).d <= half(id) + past + 0.02;
				}) ||
				walked.some(({ line, widths }) => {
					const q = nearest(line, p);
					const w =
						widths[q.i] + (widths[Math.min(q.i + 1, widths.length - 1)] - widths[q.i]) * q.f;
					return q.d <= w / 2 + 0.02;
				});
			expect([p, near]).toEqual([p, true]);
		}
	return { graph, scene };
}
