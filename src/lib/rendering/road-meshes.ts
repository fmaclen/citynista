// A road's or a node's description (road-model/description.ts) as flat triangles,
// one list per layer and colour; rendering/road-renderer.ts makes the meshes.
// Rings are triangulated by three's earcut (ShapeUtils) exactly as
// THREE.ShapeGeometry does it, but nothing here touches a scene.

import { ShapeUtils, Vector2 } from 'three';
import { arrowOutline } from '../road-model/arrows';
import type { Description, Ribbon, Ring, Sign, Surface } from '../road-model/description';
import { offsetPoint, quad } from '../road-model/geometry';
import type { Pt } from '../road-model/model';
import {
	LINE,
	paintLine,
	STOP_LINE,
	YIELD_BASE,
	YIELD_GAP,
	YIELD_HEIGHT
} from '../road-model/paint';
import { COLOURS } from './road-palette';

// The order layers are painted in, bottom first (all lie in one plane:
// rendering/road-renderer.ts). Ground surfaces stack by what they are made
// of: concrete lanes and sidewalks lowest, then asphalt (with every node's
// paving, in whatever material), dirt, grass, raised concrete. Then hatch
// bars, crossings, paint.
export const LAYERS = [
	'pavement',
	'asphalt',
	'dirt',
	'grass',
	'concrete',
	'bars',
	'refuge',
	'zebra',
	'white',
	'yellow'
] as const;
export type Layer = (typeof LAYERS)[number];

export function layerOf(s: Surface): Layer {
	if (s.role === 'paving') return 'asphalt';
	if (s.material === 'concrete')
		return s.role === 'walk' || s.role === 'lane' ? 'pavement' : 'concrete';
	return s.material;
}

// Within a layer, colours in this order, bottom first: where two of them
// share ground (a node paved in concrete lapping a road's asphalt), the order
// decides, never which was drawn first.
const RANK = [
	COLOURS.asphalt,
	COLOURS.concrete,
	COLOURS.dirt,
	COLOURS.grass,
	COLOURS.white,
	COLOURS.yellow
];

export interface Batch {
	layer: Layer;
	colour: string;
	// When it is painted: its layer's index, plus a fraction for its colour's
	// rank within the layer.
	level: number;
	// x, y of each corner, three corners a triangle.
	tris: number[];
}

// A simple polygon's triangles, as THREE.ShapeGeometry makes them.
function fill(ring: Pt[], out: number[]) {
	let contour: Vector2[] = [];
	for (const p of ring) {
		const v = new Vector2(p.x, p.y);
		if (!contour.length || !contour[contour.length - 1].equals(v)) contour.push(v);
	}
	if (!ShapeUtils.isClockWise(contour)) contour = contour.reverse();
	for (const face of ShapeUtils.triangulateShape(contour, []))
		for (const i of face) out.push(contour[i].x, contour[i].y);
}

function strip({ left, right }: Ribbon, out: number[]) {
	for (let i = 1; i < left.length; i++) {
		const [a, b, c, d] = [left[i - 1], right[i - 1], right[i], left[i]];
		out.push(a.x, a.y, b.x, b.y, c.x, c.y, a.x, a.y, c.x, c.y, d.x, d.y);
	}
}

// A sign's white polygons.
export function signShapes(sign: Sign): Pt[][] {
	if (sign.kind === 'arrow') {
		const side = { x: -sign.dir.y, y: sign.dir.x };
		return [
			arrowOutline(new Set(sign.moves)).map((q) =>
				offsetPoint(offsetPoint(sign.at, side, q.x * sign.scale), sign.dir, q.y * sign.scale)
			)
		];
	}
	if (sign.kind !== 'yield')
		return [quad(sign.a, sign.b, (sign.kind === 'stop' ? STOP_LINE : LINE) / 2)];
	// A row of teeth across a to b, centred, each pointing `toward`: as many
	// as fit, and on a row too short for one, one as wide as the row, so a
	// line is always paint.
	const { a, b, toward } = sign;
	const length = Math.hypot(b.x - a.x, b.y - a.y);
	if (length < 1e-6) return [];
	const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
	// The length is read back off two points: a row that fits exactly can
	// come back a hair short of it.
	const n = Math.max(1, Math.floor((length + YIELD_GAP) / (YIELD_BASE + YIELD_GAP) + 1e-6));
	const base = Math.min(YIELD_BASE, length);
	const first = Math.max(0, (length - n * (base + YIELD_GAP) + YIELD_GAP) / 2);
	return Array.from({ length: n }, (_, i) => {
		const x = first + i * (base + YIELD_GAP);
		const apex = offsetPoint(a, u, x + base / 2);
		return [
			offsetPoint(a, u, x),
			offsetPoint(a, u, x + base),
			offsetPoint(apex, toward, YIELD_HEIGHT)
		];
	});
}

// Everything painted but hatching: the markings stroked, and the signs.
export function paintOf(d: Description) {
	const white: Pt[][] = [];
	const yellow: Pt[][] = [];
	for (const m of d.markings)
		paintLine(m.line, m.along, m.dashed, m.colour === 'white' ? white : yellow, m.rhythm);
	for (const sign of 'signs' in d ? d.signs : []) white.push(...signShapes(sign));
	return [
		{ colour: 'white' as const, rings: white },
		{ colour: 'yellow' as const, rings: yellow }
	];
}

export function trianglesOf(d: Description): Batch[] {
	const batches = new Map<string, Batch>();
	const into = (layer: Layer, colour: string) => {
		const key = `${layer}|${colour}`;
		let b = batches.get(key);
		if (!b) {
			const level = LAYERS.indexOf(layer) + RANK.indexOf(colour) / RANK.length;
			batches.set(key, (b = { layer, colour, level, tris: [] }));
		}
		return b.tris;
	};
	const rings = (rings: Ring[], out: number[]) => rings.forEach((r) => fill(r, out));

	for (const s of d.surfaces) {
		const out = into(layerOf(s), COLOURS[s.material]);
		if ('left' in s.shape) strip(s.shape, out);
		else rings(s.shape, out);
		if (s.bars) rings(s.bars.rings, into('bars', COLOURS[s.bars.colour]));
	}
	for (const c of d.crossings)
		for (const run of c.runs)
			rings(
				run.rings,
				run.kind === 'zebra' ? into('zebra', COLOURS.white) : into('refuge', COLOURS.pavement)
			);
	for (const p of paintOf(d)) rings(p.rings, into(p.colour, COLOURS[p.colour]));
	return [...batches.values()].filter((b) => b.tris.length > 0);
}
