// The lab's scene: a place, cached road and junction drawings that rebuild
// only when something they read changes, and a canvas renderer.

import { fromPath, toPath, type Paths } from './clip';
import { effectiveJunctions } from './merge';
import { crossSection, frameAt, samplePath } from './geometry';
import {
	approachSetback,
	buildJunction,
	crossingReach,
	type JunctionDraw,
	type RoadGeo
} from './junction';
import { endKey, type Control, type Junction, type Place, type Pt } from './model';
import { buildRoad, isRoadway, type EndCut, type Fill, type RoadDraw } from './road';

export const COLOURS: Record<Fill | 'ground' | 'white' | 'yellow', string> = {
	ground: '#6aa86f',
	asphalt: '#3d3d3d',
	pavement: '#a3a39e',
	grass: '#4f9a55',
	concrete: '#8f8f8a',
	hatch: '#3d3d3d',
	trail: '#55555a',
	white: '#ecece4',
	yellow: '#e6c34a'
};

export interface View {
	x: number;
	y: number;
	zoom: number;
	width: number;
	height: number;
}

export interface Handle {
	kind: 'end' | 'stretch' | 'badge' | 'crossing';
	road?: string;
	end?: 'start' | 'end';
	index?: number;
	junction?: string;
	key?: string;
	x: number;
	y: number;
}

export class Scene {
	place: Place;
	geos = new Map<string, RoadGeo>();
	private roadDraws = new Map<string, { key: string; draw: RoadDraw }>();
	private junctionDraws = new Map<string, { key: string; draw: JunctionDraw }>();
	private versions = new Map<string, number>();
	private touching = new Map<string, { key: string; touching: boolean }>();
	lastBuildMs = 0;

	constructor(place: Place) {
		this.place = place;
	}

	touch(id: string) {
		this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
	}

	private version(id: string) {
		return this.versions.get(id) ?? 0;
	}

	// Junctions as drawn: stored ones, with any too close together merged.
	effective: Junction[] = [];
	hidden = new Set<string>();

	junctionOf(road: string, end: 'start' | 'end') {
		return this.effective.find((j) => j.ends.some((e) => e.road === road && e.end === end));
	}

	// The stored junctions an effective one stands for.
	members(id: string) {
		const ids = id.split('+');
		return this.place.junctions.filter((j) => ids.includes(j.id));
	}

	setControl(id: string, key: string, control: Control) {
		const owner = this.members(id).find((m) => m.ends.some((e) => endKey(e) === key));
		if (owner) owner.control[key] = control;
		for (const m of this.members(id)) this.touch(`junction:${m.id}`);
	}

	toggleWalkway(id: string, walkway: string) {
		const members = this.members(id);
		const stored = members.flatMap((m) => m.walkways).find((w) => w.id === walkway);
		const current = this.effective.find((j) => j.id === id)?.walkways.find((w) => w.id === walkway);
		const on = !(current?.on ?? stored?.on);
		if (stored) stored.on = on;
		else if (current && members[0]) members[0].walkways.push({ ...current, on });
		for (const m of members) this.touch(`junction:${m.id}`);
		return on;
	}

	build() {
		const t = performance.now();
		for (const road of this.place.roads) {
			const key = `${this.version(`road:${road.id}`)}`;
			const cached = this.geos.get(road.id) as (RoadGeo & { key?: string }) | undefined;
			if (!cached || cached.key !== key) {
				this.geos.set(road.id, Object.assign({ road, path: samplePath(road) }, { key }));
			}
		}
		// Whether two junctions joined by a short road touch: kept until the
		// road, either junction, or any road either one ends changes.
		const touchMemo = new Map<string, { key: string; touching: boolean }>();
		const { junctions, hidden } = effectiveJunctions(
			this.place,
			this.geos,
			(road, a, b, gap, test) => {
				const key = [
					gap,
					...[a, b].flatMap((j) => [
						this.version(`junction:${j.id}`),
						...j.ends.map((e) => `${e.road}:${this.version(`road:${e.road}`)}`)
					])
				].join('|');
				const known = this.touching.get(road);
				if (known?.key === key) {
					touchMemo.set(road, known);
					return known.touching;
				}
				const touching = test();
				touchMemo.set(road, { key, touching });
				return touching;
			}
		);
		this.touching = touchMemo;
		this.effective = junctions;
		this.hidden = hidden;
		const live = new Set<string>();
		const stored = new Map(this.place.junctions.map((j) => [j.id, j]));
		for (const j of junctions) {
			live.add(j.id);
			// A merged junction also reads the hidden roads between its members.
			const ids = j.id.split('+');
			const inside =
				ids.length > 1
					? ids.flatMap((id) =>
							(stored.get(id)?.ends ?? []).filter((e) => hidden.has(e.road)).map((e) => e.road)
						)
					: [];
			const key = [
				...ids.map((id) => this.version(`junction:${id}`)),
				...j.ends.map((e) => this.version(`road:${e.road}`)),
				...inside.map((r) => `${r}:${this.version(`road:${r}`)}`)
			].join('|');
			if (this.junctionDraws.get(j.id)?.key !== key) {
				this.junctionDraws.set(j.id, { key, draw: buildJunction(j, this.geos) });
			}
		}
		for (const id of [...this.junctionDraws.keys()])
			if (!live.has(id)) this.junctionDraws.delete(id);
		for (const road of this.place.roads) {
			const cut = (end: 'start' | 'end'): EndCut => {
				const j = this.junctionOf(road.id, end);
				if (!j) return { paint: 0, nose: null };
				const key = endKey({ road: road.id, end });
				// A walk-only road's paint stops short of the sidewalk it meets.
				const walkOnly = !road.stretches.some((st) => st.lanes.some(isRoadway));
				const length = this.geos.get(road.id)?.path.length ?? 0;
				const crossing = crossingReach(road, length, end) > 0;
				if (!crossing && this.junctionDraws.get(j.id)?.draw.carriedEnds.has(key))
					return { paint: 0, nose: 0 };
				// Lines stop half a metre short of the outline, clear of anything
				// painted across the junction; further back at a stop line.
				const setback =
					this.junctionDraws.get(j.id)?.draw.setbacks.get(key) ??
					approachSetback(j, road, length, end);
				const paint = walkOnly ? 2 : Math.max(0.5, setback);
				return { paint, nose: road.noses?.[end] ?? paint + 0.5 };
			};
			const c = { start: cut('start'), end: cut('end') };
			const key = `${this.version(`road:${road.id}`)}|${JSON.stringify(c)}`;
			if (this.roadDraws.get(road.id)?.key !== key) {
				this.roadDraws.set(road.id, { key, draw: buildRoad(road, c) });
			}
		}
		this.lastBuildMs = performance.now() - t;
	}

	junctionDraw(id: string) {
		return this.junctionDraws.get(id)?.draw;
	}

	roadDraw(id: string) {
		return this.roadDraws.get(id)?.draw;
	}

	// Islands that belong to the place rather than a junction.
	placeIslands() {
		return this.place.islands.map((i) => ({ path: toPath(i.shape), surface: i.surface }));
	}

	handles(): Handle[] {
		const out: Handle[] = [];
		for (const road of this.place.roads) {
			const geo = this.geos.get(road.id);
			if (!geo) continue;
			const first = road.points[0];
			const last = road.points[road.points.length - 1];
			out.push({ kind: 'end', road: road.id, end: 'start', x: first.x, y: first.y });
			out.push({ kind: 'end', road: road.id, end: 'end', x: last.x, y: last.y });
			road.stretches.forEach((s, index) => {
				if (index === 0) return;
				const f = frameAt(geo.path, s.at);
				out.push({ kind: 'stretch', road: road.id, index, x: f.p.x, y: f.p.y });
			});
		}
		for (const j of this.effective) {
			const draw = this.junctionDraws.get(j.id)?.draw;
			if (!draw) continue;
			for (const b of draw.badges)
				out.push({ kind: 'badge', junction: j.id, key: b.key, x: b.p.x, y: b.p.y });
			for (const c of draw.crossings) {
				const pts = c.hit.flatMap(fromPath);
				if (!pts.length) continue;
				const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length;
				const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
				out.push({ kind: 'crossing', junction: j.id, key: c.id, x: cx, y: cy });
			}
		}
		return out;
	}

	render(
		ctx: CanvasRenderingContext2D,
		view: View,
		overlay: {
			connections: boolean;
			outlines: boolean;
			handles: boolean;
			selected?: { road: string; index: number };
		}
	) {
		const { width, height } = view;
		ctx.save();
		ctx.fillStyle = COLOURS.ground;
		ctx.fillRect(0, 0, width, height);
		ctx.translate(width / 2, height / 2);
		ctx.scale(view.zoom, view.zoom);
		ctx.translate(-view.x, -view.y);
		const fillPaths = (paths: Paths, colour: string) => {
			if (!paths.length) return;
			ctx.beginPath();
			for (const path of paths) {
				path.forEach((q, i) =>
					i ? ctx.lineTo(q.X / 1000, q.Y / 1000) : ctx.moveTo(q.X / 1000, q.Y / 1000)
				);
				ctx.closePath();
			}
			ctx.fillStyle = colour;
			ctx.fill('nonzero');
		};
		const fillPolys = (polys: Pt[][], colour: string) => {
			if (!polys.length) return;
			ctx.beginPath();
			for (const poly of polys) {
				poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
				ctx.closePath();
			}
			ctx.fillStyle = colour;
			ctx.fill('nonzero');
		};
		const roads = [...this.roadDraws.entries()]
			.filter(([id]) => !this.hidden.has(id))
			.map(([, r]) => r.draw);
		const junctions = [...this.junctionDraws.values()].map((j) => j.draw);
		// Ground-level surfaces first, raised ones on top, paint last. Each
		// surface is one fill across every road and junction, so no seam shows
		// where a road meets its junction.
		const all = (pick: (r: RoadDraw) => Paths, pickJ: (j: JunctionDraw) => Paths = () => []) => [
			...roads.flatMap(pick),
			...junctions.flatMap(pickJ)
		];
		fillPaths(
			all(
				(r) => r.fills.get('pavement') ?? [],
				(j) => j.pavement
			),
			COLOURS.pavement
		);
		fillPaths(
			all(
				(r) => r.fills.get('trail') ?? [],
				(j) => j.trail
			),
			COLOURS.trail
		);
		fillPaths(
			all(
				(r) => r.fills.get('asphalt') ?? [],
				(j) => [
					...j.asphalt,
					...j.carried.filter((c) => c.surface === 'hatch').flatMap((c) => c.paths)
				]
			),
			COLOURS.asphalt
		);
		for (const island of this.placeIslands()) fillPaths([island.path], COLOURS[island.surface]);
		for (const fill of ['grass', 'concrete'] as const) {
			fillPaths(
				all(
					(r) => r.fills.get(fill) ?? [],
					(j) => [
						...j.carried.filter((c) => c.surface === fill).flatMap((c) => c.paths),
						...(fill === 'grass' ? j.verges : [])
					]
				),

				COLOURS[fill]
			);
		}
		for (const j of junctions) {
			for (const c of j.carried) if (c.surface === 'hatch') fillPaths(c.bars, COLOURS[c.line]);
			for (const island of j.islands) {
				fillPaths([island.path], COLOURS[island.surface]);
				ctx.strokeStyle = '#c9c9c0';
				ctx.lineWidth = 0.25;
				ctx.stroke();
			}
		}
		for (const j of junctions) {
			for (const c of j.crossings) {
				if (!c.on) continue;
				fillPaths(c.refuge, COLOURS.pavement);
				fillPaths(c.paving, COLOURS.pavement);
				fillPaths(c.trail, COLOURS.trail);
				fillPaths(c.zebra, COLOURS.white);
			}
		}
		for (const r of roads) {
			for (const c of r.crossings) {
				fillPaths([...c.refuge, ...c.paving], COLOURS.pavement);
				fillPaths(c.zebra, COLOURS.white);
			}
		}
		for (const r of roads) {
			fillPolys(r.white, COLOURS.white);
			fillPolys(r.yellow, COLOURS.yellow);
		}
		for (const j of junctions) {
			fillPolys(j.white, COLOURS.white);
			fillPolys(j.yellow, COLOURS.yellow);
		}
		const px = 1 / view.zoom;
		if (overlay.connections) {
			ctx.setLineDash([3 * px, 3 * px]);
			ctx.lineWidth = 1.5 * px;
			ctx.strokeStyle = '#7fd3ff';
			for (const j of junctions) {
				for (const c of j.curves) {
					ctx.beginPath();
					c.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
					ctx.stroke();
				}
			}
			ctx.setLineDash([]);
			for (const j of junctions) {
				for (const d of j.laneDots) {
					ctx.beginPath();
					ctx.arc(d.p.x, d.p.y, 2.5 * px, 0, Math.PI * 2);
					ctx.fillStyle = d.flow === 'in' ? '#ffffff' : 'rgba(0,0,0,0)';
					ctx.fill();
					ctx.strokeStyle = '#111';
					ctx.lineWidth = 1 * px;
					ctx.stroke();
				}
			}
		}
		if (overlay.outlines) {
			ctx.setLineDash([6 * px, 4 * px]);
			ctx.strokeStyle = '#ff4fa3';
			ctx.lineWidth = 1.5 * px;
			for (const j of junctions) {
				if (j.outline.length < 3) continue;
				ctx.beginPath();
				j.outline.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
				ctx.closePath();
				ctx.stroke();
			}
			ctx.setLineDash([]);
		}
		if (overlay.selected) {
			// The selected stretch: a translucent ribbon over the whole road
			// width, like the editor's selection, never a line that could pass
			// for paint.
			const geo = this.geos.get(overlay.selected.road);
			const road = geo?.road;
			if (geo && road) {
				const s = road.stretches[overlay.selected.index];
				const next = road.stretches[overlay.selected.index + 1];
				const to = next ? next.at : geo.path.length;
				const left: Pt[] = [];
				const right: Pt[] = [];
				for (let d = s.at; d <= to + 0.01; d += 1) {
					const at = Math.min(d, to);
					const f = frameAt(geo.path, at);
					const spans = crossSection(road, at);
					const lo = spans[0]?.left ?? 0;
					const hi = spans[spans.length - 1]?.right ?? 0;
					left.push({ x: f.p.x + f.n.x * lo, y: f.p.y + f.n.y * lo });
					right.push({ x: f.p.x + f.n.x * hi, y: f.p.y + f.n.y * hi });
				}
				ctx.beginPath();
				[...left, ...right.reverse()].forEach((q, i) =>
					i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)
				);
				ctx.closePath();
				ctx.fillStyle = 'rgba(56, 189, 248, 0.28)';
				ctx.fill();
				ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
				ctx.lineWidth = 1.5 * px;
				ctx.stroke();
			}
		}
		if (overlay.handles) {
			for (const h of this.handles()) {
				ctx.beginPath();
				if (h.kind === 'end') {
					ctx.arc(h.x, h.y, 5 * px, 0, Math.PI * 2);
					ctx.fillStyle = 'rgba(255,255,255,0.85)';
					ctx.fill();
					ctx.strokeStyle = '#1d4ed8';
					ctx.lineWidth = 2 * px;
					ctx.stroke();
				} else if (h.kind === 'stretch') {
					const r = 6 * px;
					ctx.moveTo(h.x, h.y - r);
					ctx.lineTo(h.x + r, h.y);
					ctx.lineTo(h.x, h.y + r);
					ctx.lineTo(h.x - r, h.y);
					ctx.closePath();
					ctx.fillStyle = '#ffd84d';
					ctx.fill();
					ctx.strokeStyle = '#111';
					ctx.lineWidth = 1 * px;
					ctx.stroke();
				} else if (h.kind === 'badge') {
					const j = this.effective.find((x) => x.id === h.junction) as Junction;
					const control = j.control[h.key!] ?? 'none';
					ctx.arc(h.x, h.y, 8 * px, 0, Math.PI * 2);
					ctx.fillStyle = { none: '#ffffff', stop: '#dc2626', yield: '#f59e0b', signal: '#16a34a' }[
						control
					];
					ctx.fill();
					ctx.strokeStyle = '#111';
					ctx.lineWidth = 1 * px;
					ctx.stroke();
					ctx.fillStyle = control === 'none' ? '#111' : '#fff';
					ctx.font = `bold ${10 * px}px sans-serif`;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(
						{ none: '–', stop: 'S', yield: 'Y', signal: 'G' }[control],
						h.x,
						h.y + 0.5 * px
					);
				}
			}
		}
		ctx.restore();
	}
}
