import { expect, test } from 'bun:test';
import { AlwaysDepth, BufferGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { check } from '../src/lib/road-model/checks';
import { toPath, toRings } from '../src/lib/road-model/clip';
import type { Material, RoadDescription, Role } from '../src/lib/road-model/description';
import { crossesItself, ribbonOf, samplePath, signedArea } from '../src/lib/road-model/geometry';
import type { Drawing } from '../src/lib/road-model/drawing';
import {
	LAYERS,
	layerOf,
	paintOf,
	signShapes,
	trianglesOf
} from '../src/lib/rendering/road-meshes';
import { COLOURS } from '../src/lib/rendering/road-palette';
import { RoadRenderer } from '../src/lib/rendering/road-renderer';
import { liveShape, readScene } from './model';

// A description drawn by hand, as a native drawer will hand one over: the
// renderer's triangles cover what it describes, and nothing else.

const area = (tris: number[]) => {
	let s = 0;
	for (let i = 0; i < tris.length; i += 6) {
		const [ax, ay, bx, by, cx, cy] = tris.slice(i, i + 6);
		s += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
	}
	return s;
};

// 30 m of one 3.5 m asphalt lane along y = 0, a dashed white line down its
// middle, and a 2 m concrete sidewalk ring beside it.
function road(): RoadDescription {
	const along = [0, 10, 20, 30];
	const line = (y: number) => along.map((x) => ({ x, y }));
	return {
		path: samplePath({ id: 'r', points: line(0), lanes: [], offset: 0 }),
		lanes: [],
		edges: [line(-1.75), line(1.75)],
		along,
		surfaces: [
			{ role: 'lane', material: 'asphalt', shape: { left: line(-1.75), right: line(1.75) } },
			{
				role: 'walk',
				material: 'concrete',
				shape: [
					[
						{ x: 0, y: 1.75 },
						{ x: 30, y: 1.75 },
						{ x: 30, y: 3.75 },
						{ x: 0, y: 3.75 }
					]
				]
			}
		],
		markings: [{ colour: 'white', dashed: true, line: line(0), along }],
		crossings: [],
		cut: { start: { paint: 0, nose: null }, end: { paint: 0, nose: null } },
		faults: []
	};
}

test('ribbons, rings and markings become triangles covering just them', () => {
	const batches = new Map(trianglesOf(road()).map((b) => [b.layer, b]));
	expect(area(batches.get('asphalt')!.tris)).toBeCloseTo(30 * 3.5, 6);
	expect(area(batches.get('pavement')!.tris)).toBeCloseTo(30 * 2, 6);
	// Three 3 m dashes, 15 cm wide.
	expect(area(batches.get('white')!.tris)).toBeCloseTo(3 * 3 * 0.15, 6);
	expect(paintOf(road())[0].rings).toHaveLength(3);
	// The sidewalk sits under the lane, the paint over both.
	const level = (layer: string) => batches.get(layer as never)!.level;
	expect(level('pavement')).toBeLessThan(level('asphalt'));
	expect(level('asphalt')).toBeLessThan(level('white'));
});

test('ground stacks by material, paving with the asphalt', () => {
	const at = (s: Parameters<typeof layerOf>[0]) => LAYERS.indexOf(layerOf(s));
	const s = (role: Role, material: Material) => ({ role, material, shape: [] });
	expect(at(s('lane', 'concrete'))).toBe(at(s('walk', 'concrete')));
	expect(at(s('paving', 'concrete'))).toBe(at(s('lane', 'asphalt')));
	expect(at(s('lane', 'asphalt'))).toBeLessThan(at(s('verge', 'grass')));
	expect(at(s('verge', 'grass'))).toBeLessThan(at(s('median', 'concrete')));
});

test('a concrete car lane is painted in the concrete of the sidewalk, not asphalt', () => {
	const concrete = road();
	concrete.surfaces[0].material = 'concrete';
	const batches = trianglesOf(concrete).filter((b) => b.layer !== 'white');
	expect(batches.map((b) => [b.layer, b.colour])).toEqual([['pavement', COLOURS.concrete]]);
	expect(area(batches[0].tris)).toBeCloseTo(30 * 3.5 + 30 * 2, 6);
});

test('a strip folded over by a tight bend leaves as rings', () => {
	const left = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 2, y: 0 }
	];
	const straight = left.map((p) => ({ x: p.x, y: p.y + 1 }));
	expect('left' in ribbonOf(left, straight, [])).toBe(true);
	// The right side doubles back past the left between the last two samples.
	const right = [
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
		{ x: 1, y: -1 }
	];
	const folded = ribbonOf(left, right, []);
	expect(Array.isArray(folded) && folded.length > 0).toBe(true);
});

// The drawing rules (road-model/checks.ts) read off roads described by hand.
const rules = (roads: Record<string, RoadDescription>) =>
	check({
		build: () => {},
		place: { roads: Object.keys(roads).map((id) => ({ id })), junctions: [] },
		road: (id: string) => roads[id],
		node: () => undefined
	} as unknown as Drawing);

const square = (x: number, y: number, side: number) => [
	{ x, y },
	{ x: x + side, y },
	{ x: x + side, y: y + side },
	{ x, y: y + side }
];

test('the rules pass a sound road, and report a ring that touches itself', () => {
	expect(rules({ r: road() })).toEqual([]);
	// Two squares of sidewalk joined at one corner, drawn as one ring: it
	// passes through that corner twice without crossing itself.
	const pinched = road();
	pinched.surfaces[1].shape = [
		[
			...square(0, 1.75, 1).slice(0, 3),
			...square(1, 2.75, 1).slice(1),
			...square(0, 1.75, 1).slice(2)
		]
	];
	expect(rules({ r: pinched })).toEqual(['ring not simple: r']);
});

test('the rules report ground one material covers twice, within a surface and between roads', () => {
	const lapped = road();
	lapped.surfaces[1].shape = [square(0, 1.75, 2), square(1, 1.75, 2)];
	expect(rules({ r: lapped })).toEqual(['double cover: r walk|concrete within one surface']);
	// A second road laid over the first: nearly all of its 105 m² of lane
	// and 60 m² of sidewalk.
	expect(rules({ a: road(), b: road() })).toEqual([
		'double cover: a and b lane|asphalt 102.99 m²',
		'double cover: a and b walk|concrete 58.08 m²'
	]);
});

test('a ring left covering a hole is reported with its road, every time the rules run', () => {
	const holed = { ...road(), faults: [{ x: 3, y: 2 }] };
	expect(rules({ r: holed })).toEqual(['ring left with a hole: r at (3.0, 2.0)']);
	expect(rules({ r: holed })).toEqual(['ring left with a hole: r at (3.0, 2.0)']);
	expect(rules({ r: road() })).toEqual([]);
});

test('a sliver of no width running out along an edge and back is left off a ring', () => {
	// The asphalt freed at a median's nose, as clipper cut it: from the nose
	// at the left it runs 14 m out along the median's side and back.
	const out = [-185.991, -183.991, -181.991, -179.991, -177.991, -175.991, -173.991];
	const side = (x: number) => ({ x, y: 2.511 + Math.round((x + 185.991) * 0.75) / 1000 });
	const spiked = [
		{ x: -186.815, y: 1.01 },
		{ x: -187.295, y: 1.21 },
		{ x: -187.491, y: 1.681 },
		{ x: -187.492, y: 1.831 },
		{ x: -187.289, y: 2.317 },
		{ x: -186.817, y: 2.51 },
		...out.map(side),
		...out.reverse().map((x) => ({ ...side(x), x: x - 0.001 })),
		{ x: -187.992, y: 2.509 },
		{ x: -187.991, y: 1.009 }
	];
	expect(crossesItself(spiked, true)).toBe(true);
	const rings = toRings([toPath(spiked)], []);
	expect(rings.length).toBe(1);
	expect(crossesItself(rings[0], true)).toBe(false);
	expect(signedArea(rings[0])).toBeCloseTo(signedArea(spiked), 3);
});

test('a row of give-way teeth that just fits is drawn whole however the road is turned', () => {
	// 3.3 m across: four 0.6 m teeth with 0.3 m between them, exactly.
	const misses: number[] = [];
	for (let deg = 0; deg < 360; deg++) {
		const t = (deg * Math.PI) / 180;
		const a = { x: 12.3 * Math.cos(t + 1), y: 45.6 * Math.sin(t + 1) };
		const b = { x: a.x + 3.3 * Math.cos(t), y: a.y + 3.3 * Math.sin(t) };
		const teeth = signShapes({
			kind: 'yield',
			lanes: [],
			a,
			b,
			toward: { x: -Math.sin(t), y: Math.cos(t) }
		});
		if (teeth.length !== 4) misses.push(deg);
	}
	expect(misses).toEqual([]);
});

test('the renderer paints every layer in one plane, bottom layer first', () => {
	const three = new Scene();
	new RoadRenderer(three).update(liveShape(readScene('setbacks')) as never);
	const meshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
	three.traverse((o) => {
		if (o instanceof Mesh) meshes.push(o);
	});
	const orders = (colour: string) =>
		meshes
			.filter((m) => `#${m.material.color.getHexString()}` === colour)
			.map((m) => m.renderOrder);
	// No step between two surfaces to see under at a tilt.
	expect(new Set(meshes.map((m) => m.getWorldPosition(new Vector3()).y)).size).toBe(1);
	// Each painted over what is there, before anything else in its pass...
	expect(meshes.every((m) => m.material.depthFunc === AlwaysDepth && m.renderOrder < 0)).toBe(true);
	// ...in layer order: sidewalk, then asphalt, then paint.
	expect(Math.max(...orders(COLOURS.pavement))).toBeLessThan(Math.min(...orders(COLOURS.asphalt)));
	expect(Math.max(...orders(COLOURS.asphalt))).toBeLessThan(Math.min(...orders(COLOURS.white)));
});
