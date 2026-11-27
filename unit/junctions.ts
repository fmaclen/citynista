// Junctions with footpaths through them, as the sweep of a footpath over a
// junction's ground builds them (unit/runs.test.ts) and the connection
// overlay's rule is held to over them (unit/overlay-links.test.ts). The
// seeded cases store a control by the junction's node (`nodes`), as cities
// saved with crossings over junctions held them: read without error, it
// names nothing.

import { createLanesFrom } from '../src/lib/core/lane-template';
import type { CrossingControl, GraphData, Lane } from '../src/lib/core/types';
import { endKey, type Pt } from '../src/lib/road-model/model';

export type Kind = 'street' | 'avenue' | 'highway' | 'lane' | 'bare';
export const lanesOf = (kind: Kind): Lane[] => {
	const lanes =
		kind === 'bare'
			? createLanesFrom('street').filter((l) => l.role === 'vehicle')
			: createLanesFrom(kind);
	return lanes.map((l, i) => ({ ...l, id: `l${i}` }));
};
export const reversed = (lanes: Lane[]): Lane[] =>
	[...lanes].reverse().map((l) => ({
		...l,
		direction:
			l.direction === 'forward' ? 'backward' : l.direction === 'backward' ? 'forward' : l.direction
	}));

// A junction at the origin with an arm out to each point, each stored
// outwards or (`flip`) inwards, every approach's own control none, so every
// line drawn stands for a crossing.
export function junction(arms: { to: Pt; kind: Kind }[], flip: boolean): GraphData {
	const control: Record<string, 'none'> = {};
	const segments = arms.map(({ kind }, i) => {
		const lanes = lanesOf(kind);
		const s = flip
			? { id: `arm${i}`, startNodeId: `n${i}`, endNodeId: 'j', lanes: reversed(lanes) }
			: { id: `arm${i}`, startNodeId: 'j', endNodeId: `n${i}`, lanes };
		control[endKey({ road: s.id, end: flip ? 'end' : 'start' })] = 'none';
		return s;
	});
	return {
		nodes: [
			{ id: 'j', x: 0, y: 0, junction: { control } },
			...arms.map(({ to }, i) => ({ id: `n${i}`, x: to.x, y: to.y }))
		],
		segments
	};
}

// Footpaths along polylines, each a chain of Path segments through its own
// nodes (two polylines sharing a point share that node), stored along it or
// (`flip`) against it, each storing `controls`.
export function withPaths(
	graph: GraphData,
	lines: Pt[][],
	flip: boolean,
	controls?: CrossingControl[]
): GraphData {
	const nodes = [...graph.nodes];
	const segments = [...graph.segments];
	const nodeAt = (p: Pt) => {
		const id = `w${p.x.toFixed(3)},${p.y.toFixed(3)}`;
		if (!nodes.some((n) => n.id === id)) nodes.push({ id, x: p.x, y: p.y });
		return id;
	};
	lines.forEach((line, k) =>
		line.slice(1).forEach((q, i) => {
			const [a, b] = [nodeAt(line[i]), nodeAt(q)];
			segments.push({
				id: `path${k}-${i}`,
				startNodeId: flip ? b : a,
				endNodeId: flip ? a : b,
				lanes: [
					{
						id: 'p',
						role: 'pedestrian',
						material: 'concrete',
						width: 2,
						direction: 'bidirectional'
					}
				],
				...(controls && { controls })
			});
		})
	);
	return { nodes, segments };
}

export const at = (angle: number, r = 45): Pt => ({
	x: Math.cos((angle * Math.PI) / 180) * r,
	y: Math.sin((angle * Math.PI) / 180) * r
});

// The junctions swept, by the app's presets: arms out to these angles.
export const junctions: { name: string; arms: { to: Pt; kind: Kind }[] }[] = [
	{
		name: 'a four-way of Streets',
		arms: [0, 90, 180, 270].map((a) => ({ to: at(a), kind: 'street' }))
	},
	{
		name: 'a T of Streets',
		arms: [0, 90, 180].map((a) => ({ to: at(a), kind: 'street' }))
	},
	{
		name: 'an X of Streets at unequal angles',
		arms: [
			{ to: { x: -18, y: -40 }, kind: 'street' },
			{ to: { x: 24, y: -36 }, kind: 'street' },
			{ to: { x: -24, y: 38 }, kind: 'street' },
			{ to: { x: 17, y: 40 }, kind: 'street' }
		]
	},
	{
		name: 'a four-way of Avenues',
		arms: [0, 90, 180, 270].map((a) => ({ to: at(a), kind: 'avenue' }))
	},
	{
		name: 'an Avenue across a Street',
		arms: [0, 90, 180, 270].map((a) => ({ to: at(a), kind: a % 180 ? 'street' : 'avenue' }))
	},
	{
		name: 'a Highway across Streets with no sidewalks',
		arms: [0, 90, 180, 270].map((a) => ({ to: at(a, 60), kind: a % 180 ? 'bare' : 'highway' }))
	}
];

// The seed of the seeded junctions (sweepCase).
export const SWEEP_SEED = 20261123;

export function seeded(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface SweepCase {
	graph: GraphData;
	// The footpath's two ends at each step, and its width.
	lines: Pt[][];
	width: number;
	label: string;
}

export function sweepCase(random: () => number): SweepCase {
	const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
	const range = (a: number, b: number) => a + (b - a) * random();
	const count = random() < 0.35 ? 3 : 4;
	const turn = range(0, 90);
	const arms = Array.from({ length: count }, (_, i) => {
		const angle = turn + i * 90 + (random() < 0.5 ? -1 : 1) * range(0.5, 4);
		const kind = pick(['street', 'avenue', 'highway', 'lane'] as const);
		return { angle, kind, length: range(55, 95), flip: random() < 0.5 };
	});
	const control: Record<string, 'none'> = {};
	const segments = arms.map(({ kind, flip }, i) => {
		const lanes = lanesOf(kind);
		const s = flip
			? { id: `arm${i}`, startNodeId: `n${i}`, endNodeId: 'j', lanes: reversed(lanes) }
			: { id: `arm${i}`, startNodeId: 'j', endNodeId: `n${i}`, lanes };
		control[endKey({ road: s.id, end: flip ? 'end' : 'start' })] = 'none';
		return s;
	});
	const junctionGraph: GraphData = {
		nodes: [
			{ id: 'j', x: 0, y: 0, junction: { control } },
			...arms.map(({ angle, length }, i) => ({ id: `n${i}`, ...at(angle, length) }))
		],
		segments
	};
	// Where it runs through: the middle, a corner between two arms, or an
	// arm's mouth, a little to one side.
	const where = pick(['middle', 'corner', 'mouth'] as const);
	const k = Math.floor(random() * count);
	const through =
		where === 'middle'
			? { x: range(-4, 4), y: range(-4, 4) }
			: where === 'corner'
				? at(arms[k].angle + (count === 3 && k === 2 ? 90 : 45), range(6, 14))
				: (() => {
						const along = at(arms[k].angle, range(7, 20));
						const side = at(arms[k].angle + 90, range(-4, 4));
						return { x: along.x + side.x, y: along.y + side.y };
					})();
	const slant = range(0, 180);
	const u = at(slant, 1);
	const [back, ahead] = [range(25, 55), range(25, 55)];
	const width = pick([2, 4, 8]);
	const control0 = pick(['none', 'yield', 'stop', 'signal'] as const);
	const lines = [0, 0.6, 1.3].map((off) => [
		{ x: through.x - u.x * back - u.y * off, y: through.y - u.y * back + u.x * off },
		{ x: through.x + u.x * ahead - u.y * off, y: through.y + u.y * ahead + u.x * off }
	]);
	const controls: CrossingControl[] = [
		{ roads: [], nodes: ['j'], control: control0 } as CrossingControl,
		...arms.map((_, i) => ({ roads: [`arm${i}`], control: control0 }))
	];
	const flipPath = random() < 0.5;
	const graph = withPaths(junctionGraph, [lines[0]], flipPath, controls);
	const path = graph.segments.find((s) => s.id === 'path0-0')!;
	path.lanes = [{ ...path.lanes[0], width }];
	const label = `${arms.map((a) => `${a.kind} ${a.angle.toFixed(1)}°${a.flip ? ' in' : ''}`).join(', ')}; ${width} m path ${where} at ${slant.toFixed(1)}°, ${control0}`;
	return { graph, lines, width, label };
}

// The same graph with its footpath's ends moved to `line`.
export function slid(graph: GraphData, line: Pt[]): GraphData {
	const path = graph.segments.find((s) => s.id === 'path0-0')!;
	const [a, b] = [path.startNodeId, path.endNodeId];
	const flip = graph.nodes.findIndex((n) => n.id === a) > graph.nodes.findIndex((n) => n.id === b);
	const [p, q] = flip ? [line[1], line[0]] : line;
	return {
		...graph,
		nodes: graph.nodes.map((n) => (n.id === a ? { ...n, ...p } : n.id === b ? { ...n, ...q } : n))
	};
}
