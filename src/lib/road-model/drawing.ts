// A place's drawing: cached road and node descriptions that rebuild only when
// their keys (set by core/place.ts) or a road's end cuts change.
// rendering/road-renderer.ts turns them into meshes.

import type { EndCut, NodeDescription, RoadDescription } from './description';
import { samplePath } from './geometry';
import { endsOf, type RoadGeo } from './ends';
import { describeJunction } from './node';
import { endKey, type Junction, type Place, type Surface } from './model';
import { describeRoad } from './road';

// A node is paved in the material that carries the most car-lane width
// across its arms, each arm counting its car lanes where it meets the node.
// It reads only lane widths and materials, so dragging a road never changes
// it. Ties go to the first material in this order, asphalt first.
const PAVING_ORDER: Surface[] = ['asphalt', 'pavement', 'concrete', 'dirt', 'grass', 'hatch'];

function pavingOf(junction: Junction, roads: Map<string, RoadGeo>) {
	const width = new Map<Surface, number>();
	for (const e of junction.ends) {
		for (const lane of roads.get(e.road)?.road.lanes ?? [])
			if (lane.kind === 'drive')
				width.set(lane.surface, (width.get(lane.surface) ?? 0) + lane.width);
	}
	let best: Surface = 'asphalt';
	for (const surface of PAVING_ORDER)
		if ((width.get(surface) ?? 0) > (width.get(best) ?? 0)) best = surface;
	return best;
}

export class Drawing {
	place: Place;
	geos: Map<string, RoadGeo>;
	private roads = new Map<string, { key: string; description: RoadDescription }>();
	private nodes = new Map<string, { key: string; description: NodeDescription }>();

	// `geos` are the place's roads with their paths sampled (core/place.ts
	// hands them over; a place read back without them samples its own).
	constructor(place: Place, geos?: Map<string, RoadGeo>) {
		this.place = place;
		this.geos = geos ?? new Map(place.roads.map((r) => [r.id, { road: r, path: samplePath(r) }]));
	}

	// Nodes first: each says where the paint of the roads ending at it stops.
	build() {
		const live = new Set<string>();
		const cuts = new Map<string, EndCut>();
		for (const j of this.place.junctions) {
			live.add(j.id);
			let node = this.nodes.get(j.id);
			if (node?.key !== j.key) {
				const description = describeJunction(j, endsOf(j, this.geos), pavingOf(j, this.geos));
				node = { key: j.key, description };
				this.nodes.set(j.id, node);
			}
			for (const [end, cut] of node.description.cuts) cuts.set(end, cut);
		}
		for (const id of [...this.nodes.keys()]) if (!live.has(id)) this.nodes.delete(id);
		const free: EndCut = { paint: 0, nose: null };
		// Only the roads drawn now are kept for next time.
		const roads: typeof this.roads = new Map();
		for (const road of this.place.roads) {
			const c = {
				start: cuts.get(endKey({ road: road.id, end: 'start' })) ?? free,
				end: cuts.get(endKey({ road: road.id, end: 'end' })) ?? free
			};
			const key = `${road.key}|${JSON.stringify(c)}`;
			const known = this.roads.get(road.id);
			if (known?.key === key) roads.set(road.id, known);
			else {
				const path = this.geos.get(road.id)?.path ?? samplePath(road);
				roads.set(road.id, { key, description: describeRoad(road, path, c) });
			}
		}
		this.roads = roads;
	}

	road(id: string) {
		return this.roads.get(id)?.description;
	}

	node(id: string) {
		return this.nodes.get(id)?.description;
	}
}
