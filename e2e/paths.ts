import { expect, type Page } from '@playwright/test';
import type { Scene } from '../src/lib/core/networks';
import type { GraphData } from '../src/lib/core/types';
import { toPath, union } from '../src/lib/road-model/clip';
import { nearestOf } from '../src/lib/road-model/overlay';
import { buildModel } from '../unit/model';
import { expectFreshDrawing, isCar, lane, liveGraph, sidewalk, walks, type Pt } from './app';

// Reads the footpath tests share: the cross-sections they build streets and
// footpaths from, what a footpath's end is joined to, the walking ground
// drawn, and the car part of a graph a footpath edit must leave alone.

// A two-way street 11 m wide (sidewalks 2 m, lanes 3.5 m), and a 2 m
// footpath.
export const STREET = [
	sidewalk('left'),
	lane('back', 'vehicle', 3.5, 'backward'),
	lane('forward', 'vehicle', 3.5, 'forward'),
	sidewalk('right')
];
export const PATH = [sidewalk('path')];

// A point `r` m out from the origin at `d` degrees, and `p` moved by `f`
// times `q`.
export const deg = (d: number, r: number): Pt => ({
	x: Math.cos((d * Math.PI) / 180) * r,
	y: Math.sin((d * Math.PI) / 180) * r
});
export const plus = (p: Pt, q: Pt, f = 1) => ({ x: p.x + q.x * f, y: p.y + q.y * f });

// The points of a line, one every 10 cm along it.
export const along = (line: Pt[]) =>
	line.flatMap((q, k) => {
		if (!k) return [q];
		const p = line[k - 1];
		const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 0.1));
		return Array.from({ length: n }, (_, i) =>
			plus(p, { x: q.x - p.x, y: q.y - p.y }, (i + 1) / n)
		);
	});

// All the walking ground drawn: every surface walked on, footpaths' and
// sidewalks'.
export function pavingOf(scene: Scene) {
	const pieces = [
		...scene.place.roads.map((r) => scene.road(r.id)!),
		...scene.place.junctions.map((j) => scene.node(j.id)!)
	];
	return union(
		pieces.flatMap((d) =>
			d.surfaces
				.filter((s) => s.role === 'walk' || s.role === 'paving')
				.flatMap((s) =>
					'left' in s.shape ? [[...s.shape.left, ...[...s.shape.right].reverse()]] : s.shape
				)
				.map(toPath)
		)
	);
}

// What a fresh build of the editor's graph finds node `id`'s first
// footpath end lying on, and, on a corner, which streets' sidewalks the
// corner joins and how far round it the end joins it (0 at its first lane,
// 1 at its second).
export async function joinOf(page: Page, id: string) {
	await expectFreshDrawing(page);
	const on = buildModel(await liveGraph(page)).derived.sidewalks.get(id)?.[0];
	const corner = on?.corner;
	const near = corner && nearestOf([corner.line], (l) => l, on.line.at(-1)!);
	return {
		on,
		corner: corner && [corner.a.road, corner.b.road].sort().join('/'),
		round: near ? near.along / near.length : null
	};
}

// The car part of a graph: its car segments and the nodes they meet at, as
// saved, by id.
export function carGraph(graph: GraphData) {
	const segments = graph.segments.filter(isCar);
	const ids = new Set(segments.flatMap((s) => [s.startNodeId, s.endNodeId]));
	const byId = <T extends { id: string }>(list: T[]) =>
		[...list].sort((a, b) => (a.id < b.id ? -1 : 1));
	return { nodes: byId(graph.nodes.filter((n) => ids.has(n.id))), segments: byId(segments) };
}

// The nodes holding both kinds of road.
export const mixed = (graph: GraphData) =>
	graph.nodes
		.filter((n) => {
			const here = graph.segments.filter((s) => s.startNodeId === n.id || s.endNodeId === n.id);
			return here.some(isCar) && here.some((s) => !isCar(s));
		})
		.map((n) => n.id);

// The footpath nodes two footpaths meet at, none of `was`.
export const crossingNodes = (graph: GraphData, was: Set<string> = new Set()) =>
	graph.nodes.filter(
		(n) =>
			!was.has(n.id) &&
			walks(graph).filter((s) => s.startNodeId === n.id || s.endNodeId === n.id).length === 2
	);

// Undoes the last edit and redoes it: the graph as it was before it (`was`),
// then exactly as it was after (`now`), no node holding both kinds either
// time.
export async function undoRedo(page: Page, was: GraphData, now: GraphData) {
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => liveGraph(page)).toEqual(was);
	expect(mixed(await liveGraph(page))).toEqual([]);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect.poll(() => liveGraph(page)).toEqual(now);
	expect(mixed(await liveGraph(page))).toEqual([]);
}
