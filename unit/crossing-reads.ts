import type { Scene } from '../src/lib/core/networks';
import type { Description, Sign } from '../src/lib/road-model/description';

// Reading what a drawing holds where footpaths cross streets: its pieces,
// the lines drawn across car lanes and the zebras. The browser tests read
// them too (e2e/crossing.ts).

type Pt = { x: number; y: number };

// Every piece's description: each road's and each junction's.
export const piecesOf = (scene: Scene): Description[] => [
	...scene.place.roads.map((r) => scene.road(r.id)!),
	...scene.place.junctions.map((j) => scene.node(j.id)!)
];

type Line = Extract<Sign, { kind: 'stop' | 'yield' }>;
const linesOf = (scene: Scene) =>
	piecesOf(scene).flatMap((d) =>
		d.signs.filter((s): s is Line => s.kind === 'stop' || s.kind === 'yield')
	);
const mid = (s: Line) => ({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 });

// The lines drawn within 8 m of `x` along a street running along x, each by
// its kind and the lanes it stands across, sorted: a signal paints a stop
// line.
export const linesAt = (scene: Scene, x: number) =>
	linesOf(scene)
		.filter((s) => Math.abs(mid(s).x - x) < 8)
		.map((s) => `${s.kind} ${s.lanes.map((l) => l.lane).sort()}`)
		.sort();

// The lines drawn within `reach` m of a point, by kind, sorted.
export const linesNear = (scene: Scene, near: Pt, reach = 8) =>
	linesOf(scene)
		.filter((s) => Math.hypot(mid(s).x - near.x, mid(s).y - near.y) < reach)
		.map((s) => s.kind)
		.sort();

// The middle of each zebra a footpath's crossing draws over car lanes.
export const zebras = (scene: Scene) =>
	piecesOf(scene).flatMap((d) =>
		d.crossings.flatMap((c) => {
			const pts = c.runs.filter((r) => r.kind === 'zebra').flatMap((r) => r.rings.flat());
			if (!pts.length || !c.id.includes('~')) return [];
			return [
				{
					x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
					y: pts.reduce((s, p) => s + p.y, 0) / pts.length
				}
			];
		})
	);
