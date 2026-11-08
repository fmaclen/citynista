// Helpers for writing places by hand, and the step that turns a written
// place into stored data: each junction gets its defaults once (its set of
// ends is new), then the place's own edits are applied on top.

import { settleMerges } from '../edit';
import { samplePath } from '../geometry';
import {
	CROSSING_FROM_END,
	SHORT_LINK,
	defaultCrossings,
	defaults,
	endsOf,
	type RoadGeo
} from '../junction';
import {
	connectionKey,
	endKey,
	parseEndKey,
	parseLaneKey,
	type Align,
	type Connection,
	type Control,
	type Dir,
	type Island,
	type Junction,
	type Lane,
	type PathPoint,
	type Place,
	type Pt,
	type Road,
	type Stretch,
	type Surface
} from '../model';

export const walk = (id: string, width = 2): Lane => ({
	id,
	kind: 'walk',
	width,
	dir: 'none',
	surface: 'pavement'
});
export const trail = (id: string, width = 3.5): Lane => ({
	id,
	kind: 'trail',
	width,
	dir: 'both',
	surface: 'asphalt'
});
export const drive = (id: string, dir: Dir, width = 3.3): Lane => ({
	id,
	kind: 'drive',
	width,
	dir,
	surface: 'asphalt'
});
export const bus = (id: string, dir: Dir, width = 3.6): Lane => ({
	id,
	kind: 'bus',
	width,
	dir,
	surface: 'asphalt'
});
export const buffer = (id: string, width: number, surface: Surface = 'grass'): Lane => ({
	id,
	kind: 'buffer',
	width,
	dir: 'none',
	surface
});

export function stretch(
	at: number,
	lanes: Lane[],
	opts: { taper?: number; align?: Align } = {}
): Stretch {
	return { at, lanes, taper: opts.taper ?? 0, align: opts.align ?? 'centre' };
}

export function road(id: string, points: PathPoint[], stretches: Stretch[] | Lane[]): Road {
	const list = (stretches[0] as Stretch).lanes
		? (stretches as Stretch[])
		: [stretch(0, stretches as Lane[])];
	return { id, points, stretches: list, height: 0 };
}

export const p = (x: number, y: number): PathPoint => ({ x, y });

// A point `d` metres from `from` along a heading in degrees (0 = east,
// 90 = south, screen convention).
export function along(from: Pt, deg: number, d: number): PathPoint {
	const a = (deg * Math.PI) / 180;
	return { x: from.x + Math.cos(a) * d, y: from.y + Math.sin(a) * d };
}

// Points on a circular arc (cubic pieces of at most 45 degrees), from angle
// a0 to a1 in degrees, the first point included.
export function arc(c: Pt, r: number, a0: number, a1: number): PathPoint[] {
	const pieces = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 45));
	const step = (a1 - a0) / pieces;
	const rad = (d: number) => (d * Math.PI) / 180;
	const at = (d: number) => ({ x: c.x + r * Math.cos(rad(d)), y: c.y + r * Math.sin(rad(d)) });
	const k = (4 / 3) * Math.tan(rad(step) / 4) * r;
	const out: PathPoint[] = [at(a0)];
	for (let i = 0; i < pieces; i++) {
		const d0 = a0 + step * i;
		const d1 = d0 + step;
		const p0 = at(d0);
		const p1 = at(d1);
		const t0 = { x: -Math.sin(rad(d0)), y: Math.cos(rad(d0)) };
		const t1 = { x: -Math.sin(rad(d1)), y: Math.cos(rad(d1)) };
		out.push({
			...p1,
			c1: { x: p0.x + t0.x * k, y: p0.y + t0.y * k },
			c2: { x: p1.x - t1.x * k, y: p1.y - t1.y * k }
		});
	}
	return out;
}

export interface JunctionEdits {
	// Replace the connections leaving an incoming lane: 'road:end/lane' to
	// a list of 'road:end/lane'.
	turns?: Record<string, string[]>;
	add?: string[];
	remove?: string[];
	control?: Record<string, Control>;
	walk?: Record<string, boolean>;
	bare?: string[];
	paved?: Record<string, boolean>;
	islands?: Island[];
	// Hand-shaped outline corners: 'a>b' (road end keys) to the points the
	// curb runs through.
	corners?: Record<string, Pt[]>;
	// Approaches that get turn arrows though nobody stops.
	arrows?: string[];
}

export interface WrittenJunction {
	id: string;
	ends: string[];
	edits?: JunctionEdits;
}

export const junction = (id: string, ends: string[], edits?: JunctionEdits): WrittenJunction => ({
	id,
	ends,
	edits
});

const conn = (key: string): Connection => {
	const [from, to] = key.split('>');
	return { from: parseLaneKey(from), to: parseLaneKey(to) };
};

export function place(def: {
	id: string;
	title: string;
	photo?: string;
	note?: string;
	view: Place['view'];
	roads: Road[];
	junctions: WrittenJunction[];
	islands?: Island[];
}): Place {
	const geos = new Map<string, RoadGeo>(
		def.roads.map((r) => [r.id, { road: r, path: samplePath(r) }])
	);
	const junctions: Junction[] = def.junctions.map((w) => {
		const j: Junction = {
			id: w.id,
			ends: w.ends.map(parseEndKey),
			connections: [],
			walkways: [],
			control: {},
			corners: [],
			islands: []
		};
		const d = defaults(j, geos);
		j.connections = d.connections;
		j.walkways = d.walkways;
		j.control = d.control;
		j.corners = d.corners;
		const e = w.edits ?? {};
		for (const [from, tos] of Object.entries(e.turns ?? {})) {
			j.connections = j.connections.filter((c) => connectionKey(c).split('>')[0] !== from);
			for (const to of tos) j.connections.push(conn(`${from}>${to}`));
		}
		const removed = new Set(e.remove ?? []);
		j.connections = j.connections.filter((c) => !removed.has(connectionKey(c)));
		for (const key of e.add ?? []) j.connections.push(conn(key));
		Object.assign(j.control, e.control ?? {});
		for (const w of j.walkways) {
			if (e.walk && w.id in e.walk) {
				w.on = e.walk[w.id];
			}
			if (e.paved && w.id in e.paved) w.paved = e.paved[w.id];
			if (e.bare?.includes(w.id)) w.bare = true;
		}
		j.islands = e.islands ?? [];
		for (const c of j.corners) {
			const via = e.corners?.[`${c.a}>${c.b}`];
			if (via) c.via = via;
		}
		if (e.arrows) j.arrows = e.arrows;
		return j;
	});
	// Crossings across each junction's road ends, by the default rule unless
	// switched by hand (`walk`, keyed 'x:' and the road end).
	const size = new Map(junctions.flatMap((j) => j.ends.map((e) => [endKey(e), j.ends.length])));
	const shortLink = (road: string) =>
		(size.get(`${road}:start`) ?? 0) > 2 &&
		(size.get(`${road}:end`) ?? 0) > 2 &&
		(geos.get(road)?.path.length ?? Infinity) < SHORT_LINK;
	junctions.forEach((j, i) => {
		const walk = def.junctions[i].edits?.walk ?? {};
		for (const c of defaultCrossings(j, endsOf(j, geos), shortLink)) {
			if (!(walk[`x:${c.end.key}`] ?? c.on)) continue;
			const road = c.end.geo.road;
			const length = c.end.geo.path.length;
			const at = c.end.ref.end === 'start' ? CROSSING_FROM_END : length - CROSSING_FROM_END;
			road.crossings = [...(road.crossings ?? []), { at, lanes: c.lanes, type: 'painted' }];
		}
	});
	const made: Place = {
		id: def.id,
		title: def.title,
		photo: def.photo,
		note: def.note,
		view: def.view,
		roads: def.roads,
		junctions,
		islands: def.islands ?? []
	};
	settleMerges(made);
	return made;
}
