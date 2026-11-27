import type { GraphData } from '../src/lib/core/types';
import { cityOf } from './editor.svelte';

// Long car roads made of many segments joined through the nodes they only
// carry on through (carriedOn in core/place.ts), for sweeps that slide
// something along a road through those nodes: a closed loop as the Curve
// tool draws one (straight sides and quarter turns, closed at `tl`), a ring
// as the Circle tool lays one (eight quadratic pieces), and open roads of
// eight pieces, straight and curved. Each comes with the points along its
// middle line where a piece ends (`joints`), in order, and the way the road
// runs there.

type Pt = { x: number; y: number };
type Lanes = 'street' | 'avenue';
export interface LongRoad {
	name: string;
	closed: boolean;
	nodes: Record<string, [number, number]>;
	roads: Parameters<typeof cityOf>[1];
	joints: { node: string; at: Pt; way: Pt }[];
}

const unit = (p: Pt) => {
	const l = Math.hypot(p.x, p.y) || 1;
	return { x: p.x / l, y: p.y / l };
};

// The loop the Curve tool draws through six clicks: two straight sides and
// four quarter turns, drawn from `n0` (the top left corner, so the oldest
// node, as the editor numbers them) round to `n0`. Scaled by `k`.
export function curveLoop(lanes: Lanes = 'street', k = 1): LongRoad {
	const corners: [number, number, Pt][] = [
		[-40, -40, { x: 1, y: 0 }],
		[40, -40, { x: 1, y: 0 }],
		[80, 0, { x: 0, y: 1 }],
		[40, 40, { x: -1, y: 0 }],
		[-40, 40, { x: -1, y: 0 }],
		[-80, 0, { x: 0, y: -1 }]
	];
	const nodes: LongRoad['nodes'] = {};
	for (const [i, [x, y]] of corners.entries()) nodes[`n${i}`] = [x * k, y * k];
	const c = (x: number, y: number) => ({ x: x * k, y: y * k });
	const roads = [
		{ id: 'top', from: 'n0', to: 'n1', lanes },
		{ id: 'ne', from: 'n1', to: 'n2', lanes, control: c(80, -40) },
		{ id: 'se', from: 'n2', to: 'n3', lanes, control: c(80, 40) },
		{ id: 'bottom', from: 'n3', to: 'n4', lanes },
		{ id: 'sw', from: 'n4', to: 'n5', lanes, control: c(-80, 40) },
		{ id: 'nw', from: 'n5', to: 'n0', lanes, control: c(-80, -40) }
	];
	return {
		name: `curve-drawn loop (${lanes}${k === 1 ? '' : ` x${k}`})`,
		closed: true,
		nodes,
		roads,
		joints: corners.map(([x, y, way], i) => ({ node: `n${i}`, at: { x: x * k, y: y * k }, way }))
	};
}

// The ring the Circle tool lays: eight quadratic pieces of 45° each, counter-
// clockwise on screen, closed at `c0`.
export function circleLoop(lanes: Lanes = 'street', radius = 60): LongRoad {
	const n = 8;
	const angle = (i: number) => (-2 * Math.PI * i) / n;
	const point = (i: number, r = radius) => ({
		x: r * Math.cos(angle(i)),
		y: r * Math.sin(angle(i))
	});
	const nodes: LongRoad['nodes'] = {};
	const roads: LongRoad['roads'] = [];
	const joints: LongRoad['joints'] = [];
	for (let i = 0; i < n; i++) {
		const p = point(i);
		nodes[`c${i}`] = [p.x, p.y];
		joints.push({
			node: `c${i}`,
			at: p,
			way: unit({ x: Math.sin(angle(i)), y: -Math.cos(angle(i)) })
		});
		roads.push({
			id: `arc${i}`,
			from: `c${i}`,
			to: `c${(i + 1) % n}`,
			lanes,
			control: point(i + 0.5, radius / Math.cos(Math.PI / n))
		});
	}
	return { name: `circle-drawn ring (${lanes})`, closed: true, nodes, roads, joints };
}

// An open road of eight pieces, 30 m each: straight along x, or bent along
// a quarter of a circle (`curved`).
export function openRoad(curved: boolean, lanes: Lanes = 'street'): LongRoad {
	const n = 8;
	const nodes: LongRoad['nodes'] = {};
	const roads: LongRoad['roads'] = [];
	const joints: LongRoad['joints'] = [];
	const R = (n * 30) / (Math.PI / 2);
	const point = (u: number) =>
		curved
			? { x: R * Math.sin((u / R) * 1), y: R - R * Math.cos(u / R) }
			: { x: u - (n * 30) / 2, y: 0 };
	const way = (u: number) => (curved ? { x: Math.cos(u / R), y: Math.sin(u / R) } : { x: 1, y: 0 });
	for (let i = 0; i <= n; i++) {
		const p = point(i * 30);
		nodes[`o${i}`] = [p.x, p.y];
		if (i > 0 && i < n) joints.push({ node: `o${i}`, at: p, way: way(i * 30) });
	}
	for (let i = 0; i < n; i++) {
		const [a, b] = [point(i * 30), point((i + 1) * 30)];
		const [ta, tb] = [way(i * 30), way((i + 1) * 30)];
		// The control point where the tangents at the two ends meet.
		const den = ta.x * tb.y - ta.y * tb.x;
		const t = den ? ((b.x - a.x) * tb.y - (b.y - a.y) * tb.x) / den : 0;
		roads.push({
			id: `piece${i}`,
			from: `o${i}`,
			to: `o${i + 1}`,
			lanes,
			...(curved && { control: { x: a.x + ta.x * t, y: a.y + ta.y * t } })
		});
	}
	return {
		name: `open ${curved ? 'curved' : 'straight'} road of 8 pieces (${lanes})`,
		closed: false,
		nodes,
		roads,
		joints
	};
}

export const longRoads = (lanes: Lanes = 'street') => [
	curveLoop(lanes),
	circleLoop(lanes),
	openRoad(false, lanes),
	openRoad(true, lanes)
];

// A long road with footpaths laid on it, as a saved graph.
export const cityWith = (
	road: LongRoad,
	nodes: Record<string, [number, number]> = {},
	paths: Parameters<typeof cityOf>[1] = []
): GraphData => cityOf({ ...road.nodes, ...nodes }, [...road.roads, ...paths]);

// Chains of segments carried on through every node but one, whose two ends
// would meet at that one node, as users make them: a loop with a side
// street leaving one of its nodes (at its oldest and at a later one), a
// Circle ring with one, two rings sharing a node (a figure of eight), a
// teardrop (the loop closed at a sharp corner), and a loop given a setback
// or a connection edit at one of its nodes. Each with the loop it is made
// on, whose joints a sweep slides through, and `junction`, the node where
// other roads meet it, if any. Edits are stored as the editor stores them
// (on the node, by segment id).
export function selfMeeting() {
	const loop = curveLoop();
	const ring = circleLoop();
	const out: { name: string; road: LongRoad; graph: GraphData; junction?: string }[] = [];
	for (const [road, at] of [
		[loop, 'n0'],
		[loop, 'n3'],
		[ring, 'c2']
	] as const) {
		const [x, y] = road.nodes[at];
		out.push({
			name: `${road.name} with a side street at ${at}`,
			road,
			graph: cityOf({ ...road.nodes, side: [x * 1.6, y * 1.6] }, [
				...road.roads,
				{ id: 'side', from: at, to: 'side', lanes: 'street' }
			]),
			junction: at
		});
	}
	// The ring and its mirror image across x = 60, sharing c0 at (60, 0).
	const mirror = (id: string) => (id === 'c0' ? id : `d${id.slice(1)}`);
	const other: Record<string, [number, number]> = {};
	for (const [id, [x, y]] of Object.entries(ring.nodes)) other[mirror(id)] = [120 - x, y];
	out.push({
		name: 'two rings sharing a node',
		road: ring,
		graph: cityOf({ ...ring.nodes, ...other }, [
			...ring.roads,
			...ring.roads.map((r) => ({
				...r,
				id: `mirror-${r.id}`,
				from: mirror(r.from),
				to: mirror(r.to),
				control: r.control && { x: 120 - r.control.x, y: r.control.y }
			}))
		]),
		junction: 'c0'
	});
	// n0 moved down the left side, its two pieces bent to meet it at a corner.
	const tear: LongRoad = {
		...loop,
		name: 'teardrop',
		nodes: { ...loop.nodes, n0: [-40, -20] },
		roads: loop.roads.map((r) =>
			r.id === 'top'
				? { ...r, control: { x: 0, y: -40 } }
				: r.id === 'nw'
					? { ...r, control: { x: -80, y: -20 } }
					: r
		),
		joints: loop.joints.map((j) => (j.node === 'n0' ? { ...j, at: { x: -40, y: -20 } } : j))
	};
	out.push({ name: 'teardrop', road: tear, graph: cityWith(tear) });
	for (const [at, road] of [
		['n0', 'top'],
		['n1', 'ne'],
		['n3', 'bottom']
	]) {
		const graph = cityWith(loop);
		graph.nodes.find((n) => n.id === at)!.junction = { setbacks: { [road]: 4 } };
		out.push({ name: `${loop.name} with a setback at ${at}`, road: loop, graph });
	}
	for (const [at, into, outOf] of [
		['n0', 'nw', 'top'],
		['n3', 'se', 'bottom']
	]) {
		const graph = cityWith(loop);
		const lane = graph.segments.find((s) => s.id === into)!.lanes[1].id!;
		graph.nodes.find((n) => n.id === at)!.junction = {
			removed: [{ from: { road: into, end: 'end', lane }, to: { road: outOf, end: 'start', lane } }]
		};
		out.push({ name: `${loop.name} with a connection taken off at ${at}`, road: loop, graph });
	}
	return out;
}
