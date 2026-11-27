import { readFileSync } from 'node:fs';
import { attachShift } from '../src/lib/core/attach';
import { mapJunction } from '../src/lib/core/junction-data';
import { serializeLanes } from '../src/lib/core/lane-template';
import { separateKinds } from '../src/lib/core/separate';
import { Networks } from '../src/lib/core/networks';
import type { Ground } from '../src/lib/core/drag';
import type { GraphData } from '../src/lib/core/types';
import { area, type Paths, subtract, toPath, union } from '../src/lib/road-model/clip';
import { crossSection, frameAt, offsetPoint, samplePath } from '../src/lib/road-model/geometry';
import type { Description } from '../src/lib/road-model/description';
import type { Road } from '../src/lib/road-model/model';
import type { Scene } from '../src/lib/core/networks';

// Reading a plain saved graph in Node, without the browser: the road model
// the editor would draw from it, and points on it.

// Test-only graphs live in e2e/scenes/, outside anything the app serves.
export function readScene(name: string): GraphData {
	return JSON.parse(readFileSync(`e2e/scenes/${name}.json`, 'utf8'));
}

export const nodeOf = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id)!;
export const segmentOf = (graph: GraphData, id: string) => graph.segments.find((s) => s.id === id)!;

// A saved graph in the shape the editor's live graph has: nodes listing
// their roads, segments with their lanes keyed and their shifts filled in,
// and each node holding one kind of road, as a load leaves it
// (core/separate.ts: a node split off is named as the Graph names it).
export function liveShape(data: GraphData) {
	data = structuredClone(data);
	const nodes = new Map(data.nodes.map((n) => [n.id, { ...n, connectedSegments: [] as string[] }]));
	const segments = new Map(
		data.segments.map((s) => [
			s.id,
			{
				...s,
				hasControlPoint: s.controlX !== undefined && s.controlY !== undefined,
				offsetStart: s.offsetStart ?? 0,
				offsetEnd: s.offsetEnd ?? 0,
				lanesKey: serializeLanes(s.lanes),
				totalWidth: s.lanes.reduce((a, l) => a + l.width, 0)
			}
		])
	);
	for (const s of segments.values()) {
		nodes.get(s.startNodeId)!.connectedSegments.push(s.id);
		nodes.get(s.endNodeId)!.connectedSegments.push(s.id);
	}
	const numbers = data.nodes.map((n) => parseInt(n.id.replace('node-', ''), 10));
	let next = Math.max(-1, ...numbers.filter((k) => !isNaN(k)));
	const createNode = (x: number, y: number) => {
		const node = { id: `node-${++next}`, x, y, connectedSegments: [] as string[] };
		nodes.set(node.id, node);
		return node;
	};
	const reattach = (id: string, from: string, to: string) => {
		const s = segments.get(id)!;
		if (s.startNodeId === from) s.startNodeId = to;
		if (s.endNodeId === from) s.endNodeId = to;
		const list = nodes.get(from)!.connectedSegments;
		list.splice(list.indexOf(id), 1);
		nodes.get(to)!.connectedSegments.push(id);
	};
	separateKinds({ nodes, segments, createNode, reattach });
	return { nodes, segments };
}

// A graph in the live shape (liveShape) that logs each write to a node's
// place, a curve's handle or a road's shift, as a Graph logs every write
// (Graph.changesSince): a Networks kept across builds of it reads again only
// what those writes reach, as it does in the editor.
export function logged(graph: ReturnType<typeof liveShape>) {
	const log: string[] = [];
	const watch = (o: object, keys: string[], entry: string) => {
		for (const key of keys) {
			let value = (o as Record<string, unknown>)[key];
			Object.defineProperty(o, key, {
				get: () => value,
				set: (v) => {
					value = v;
					log.push(entry);
				},
				enumerable: true,
				configurable: true
			});
		}
	};
	for (const [id, n] of graph.nodes) watch(n, ['x', 'y'], `n${id}`);
	for (const [id, s] of graph.segments)
		watch(s, ['controlX', 'controlY', 'offsetStart', 'offsetEnd'], `s${id}`);
	const rank = (ids: Iterable<string>) => new Map([...ids].map((id, i) => [id, i]));
	const [nodes, segments] = [rank(graph.nodes.keys()), rank(graph.segments.keys())];
	return Object.defineProperties(graph, {
		stamp: { get: () => log.length },
		changesSince: {
			value: (stamp: number) => {
				if (stamp > log.length) return null;
				const out = { nodes: [] as string[], segments: [] as string[], reordered: [] as string[] };
				for (const entry of log.slice(stamp))
					(entry[0] === 'n' ? out.nodes : out.segments).push(entry.slice(1));
				return out;
			}
		},
		nodeRank: { value: (id: string) => nodes.get(id) },
		segmentRank: { value: (id: string) => segments.get(id) }
	});
}

// What rides a car road a drag moves (core/drag.ts), read off the graph
// drawn as it stands now.
export function groundOf(graph: Parameters<Networks['build']>[0]): Ground {
	const networks = new Networks();
	networks.build(graph);
	return (segments, nodes) => networks.onGround(segments, nodes);
}

// The node a saved graph's footpaths at node `id` are moved to on load
// where the node holds streets too (core/separate.ts), or `id` itself.
export function footpathNode(data: GraphData, id: string) {
	const at = data.nodes.find((n) => n.id === id)!;
	const known = new Set(data.nodes.map((n) => n.id));
	const split = [...liveShape(data).nodes.values()].find(
		(n) => !known.has(n.id) && Math.hypot(n.x - at.x, n.y - at.y) < 1
	);
	return split?.id ?? id;
}

// The road model and its drawing, built the way the editor builds them.
export function buildModel(graph: GraphData) {
	return new Networks().build(liveShape(graph) as never);
}

// The editor's renderer without Three.js (rendering/road-renderer.ts, update):
// one Networks kept across builds, so the caches are exercised as a drag
// exercises them.
export function editorDrawing(builder = new Networks()) {
	return (graph: ReturnType<typeof liveShape>) => builder.build(graph as never).scene;
}

// What the renderer is handed (rendering/road-renderer.ts, update), by piece:
// each road's description, and each junction's ends and description. A
// node's ends leave out the roads they belong to (whose keys are build
// counters): each road is a piece of its own.
export function pieces(scene: Scene) {
	const out = new Map<string, unknown>();
	for (const r of scene.place.roads) out.set(`road:${r.id}`, scene.road(r.id));
	for (const j of scene.place.junctions) {
		const node = scene.node(j.id);
		out.set(`junction:${j.id}`, {
			ends: j.ends,
			description: node && { ...node, ends: node.ends.map((e) => ({ ...e, geo: undefined })) }
		});
	}
	return out;
}

// Where a road's end at `nodeId` shows: the node, moved to the edge it is
// attached at (core/attach.ts).
export function attachedEnd(data: GraphData, segmentId: string, nodeId: string) {
	const graph = liveShape(data);
	const node = graph.nodes.get(nodeId)!;
	const shift = attachShift(graph as never, graph.segments.get(segmentId)!, nodeId);
	return { x: node.x + shift.x, y: node.y + shift.y };
}

// The middle of a road's cross-section as drawn, at a fraction of its length.
export function drawnCentre(road: Road, f: number) {
	const path = samplePath(road);
	const d = path.length * f;
	const frame = frameAt(path, d);
	const spans = crossSection(road, d);
	return offsetPoint(frame.p, frame.n, (spans[0].left + spans.at(-1)!.right) / 2);
}

// The car part of a drawing, all of it but its paint (core/networks.ts): each
// car road's line, cross-section and ground (every surface, without the
// hatching painted on it), and each car node's road ends, connections, curb
// outline, lane paths and ground. Road ids are left out, so a road reads the
// same whatever segment names it (a road cut and joined again is named by its
// first piece), and so is the order a node lists its roads in, the order
// they were made. Compare two with carDiff.
export function carPart(scene: Scene) {
	const ground = (d: Description) => {
		const by = new Map<string, Paths>();
		for (const s of d.surfaces) {
			const key = `${s.role}/${s.material}`;
			const shape =
				'left' in s.shape ? [[...s.shape.left, ...[...s.shape.right].reverse()]] : s.shape;
			by.set(key, [...(by.get(key) ?? []), ...shape.map(toPath)]);
		}
		return new Map([...by].map(([k, paths]) => [k, union(paths)]));
	};
	const cars = [...scene.place.roads, ...scene.place.hidden].filter((r) =>
		r.lanes.some((l) => l.kind === 'drive')
	);
	// Each road named by where it starts and ends, to the centimetre, and the
	// lanes it carries.
	const nameOf = (r: Road) =>
		JSON.stringify(round([r.points[0], r.points[r.points.length - 1], r.lanes], 1e2));
	const name = new Map(cars.map((r) => [r.id, nameOf(r)]));
	const renamed = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(renamed)
			: v && typeof v === 'object'
				? Object.fromEntries(
						Object.entries(v).map(([k, x]) => [
							k,
							k === 'road' && typeof x === 'string' ? (name.get(x) ?? x) : renamed(x)
						])
					)
				: v;
	// In no particular order: sorted by what each reads to the centimetre.
	const unordered = (list: unknown[]) =>
		(renamed(list) as unknown[])
			.map((x) => ({ x, key: JSON.stringify(round(x, 1e2)) }))
			.sort((a, b) => (a.key < b.key ? -1 : 1))
			.map(({ x }) => x);
	// A connection or path either way round: from its first road end.
	const first = (from: unknown, to: unknown) =>
		JSON.stringify(renamed(from)) <= JSON.stringify(renamed(to));
	const shown = new Set(scene.place.roads.map((r) => r.id));
	const roads = new Map(
		cars.map((r) => [
			nameOf(r),
			{
				shape: [r.points, r.lanes, r.offset, r.lean ?? 0],
				hidden: !shown.has(r.id),
				ground: shown.has(r.id) ? ground(scene.road(r.id)!) : null
			}
		])
	);
	const junctions = new Map(
		scene.place.junctions
			.filter((j) => !j.id.startsWith('walk:'))
			.map((j) => {
				const d = scene.node(j.id)!;
				const fixed = {
					ends: unordered(j.ends),
					connections: unordered(
						j.connections.map((c) => (first(c.from, c.to) ? [c.from, c.to] : [c.to, c.from]))
					),
					paths: unordered(
						d.paths.map((p) =>
							first(p.from, p.to)
								? [p.from, p.to, p.line, p.widths]
								: [p.to, p.from, [...p.line].reverse(), [...p.widths].reverse()]
						)
					)
				};
				const outline = union(d.outline.rings.map(toPath));
				return [j.id, { fixed, outline, ground: ground(d) }];
			})
	);
	return { roads, junctions };
}

const round = (v: unknown, by = 1e4): unknown =>
	typeof v === 'number'
		? Math.round(v * by) / by
		: Array.isArray(v)
			? v.map((x) => round(x, by))
			: v && typeof v === 'object'
				? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x, by)]))
				: v;

// How far apart two drawings' points may lie and be the same (m): the last
// digits of a curve read back from its two halves (rejoined in
// core/segment-curve.ts), nothing a drawing could show.
const SAME = 1e-9;
// Ground two drawings may lay differently and be the same (m²): a strip a
// millimetre wide along a road end read past its trim's last digits.
const GROUND = 1e-2;

// Whether two values are the same, numbers to within SAME.
const same = (a: unknown, b: unknown): boolean =>
	typeof a === 'number' && typeof b === 'number'
		? Math.abs(a - b) <= SAME
		: Array.isArray(a) && Array.isArray(b)
			? a.length === b.length && a.every((x, i) => same(x, b[i]))
			: a && b && typeof a === 'object' && typeof b === 'object'
				? Object.keys(a).length === Object.keys(b).length &&
					Object.entries(a).every(([k, x]) => same(x, (b as Record<string, unknown>)[k]))
				: a === b;

// Where two car parts (carPart) differ: a road or node in one and not the
// other, or what one holds that the other doesn't, ground by the area laid
// one way and not the other.
export function carDiff(a: ReturnType<typeof carPart>, b: ReturnType<typeof carPart>) {
	const out: string[] = [];
	const apart = (p: Paths, q: Paths) =>
		[...subtract(p, q), ...subtract(q, p)].reduce((s, r) => s + Math.abs(area(r)), 0);
	const grounds = (id: string, g: Map<string, Paths> | null, h: Map<string, Paths> | null) => {
		for (const key of new Set([...(g?.keys() ?? []), ...(h?.keys() ?? [])])) {
			const m2 = apart(g?.get(key) ?? [], h?.get(key) ?? []);
			if (m2 > GROUND) out.push(`${id} ${key}: ${m2.toFixed(3)} m²`);
		}
	};
	for (const id of new Set([...a.roads.keys(), ...b.roads.keys()])) {
		const [r, s] = [a.roads.get(id), b.roads.get(id)];
		const label = `road ${id.slice(0, 60)}`;
		if (!r || !s) out.push(`${label}: only in ${r ? 'the first' : 'the second'}`);
		else if (!same(r.shape, s.shape)) out.push(`${label}: line or lanes`);
		else if (r.hidden !== s.hidden) out.push(`${label}: hidden in one`);
		else grounds(label, r.ground, s.ground);
	}
	for (const id of new Set([...a.junctions.keys(), ...b.junctions.keys()])) {
		const [j, k] = [a.junctions.get(id), b.junctions.get(id)];
		if (!j || !k) out.push(`junction ${id}: only in ${j ? 'the first' : 'the second'}`);
		else {
			if (!same(j.fixed, k.fixed)) out.push(`junction ${id}: ends, connections or paths`);
			const m2 = apart(j.outline, k.outline);
			if (m2 > GROUND) out.push(`junction ${id} outline: ${m2.toFixed(3)} m²`);
			grounds(`junction ${id}`, j.ground, k.ground);
		}
	}
	return out;
}

// A graph's car roads alone, as if no footpath had been drawn: its car
// segments, and of each node's edits those naming them alone.
export function withoutFootpaths(data: GraphData): GraphData {
	const segments = data.segments.filter((s) => s.lanes.some((l) => l.role === 'vehicle'));
	const ids = new Set(segments.map((s) => s.id));
	const nodes = data.nodes.map(({ junction, ...node }) => {
		const kept =
			junction && mapJunction(junction, (road, end) => (ids.has(road) ? { road, end } : null));
		return kept ? { ...node, junction: kept } : node;
	});
	return { nodes, segments };
}
