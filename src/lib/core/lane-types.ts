import type { Lane, LaneRole, LaneSurface } from './types';

// Every rule about how lanes render and connect is keyed to a render layer's
// SURFACE CLASS, not to a lane's function or material name.
//
// - roadway: vehicle-level paving. Roadways always flow into each other
//   across transitions (material changes are a color seam), stop at junction
//   stop lines, and are covered by the asphalt patch inside junctions.
// - island: raised strips inside the roadway. Islands flow into other islands
//   or verges across transitions and end in a rounded nose when nothing
//   continues them.
// - verge: planted strips. Verges flow into islands/verges and end in a square
//   cut everywhere else — never a sliver.
// - walkway: pedestrian paving. Rendered via the full-width pavement plate;
//   wraps junction corners.
export type SurfaceClass = 'roadway' | 'island' | 'verge' | 'walkway';

// A render layer: the bucket a lane's geometry draws into (color + stacking +
// surface class). Pedestrians render via the full-width pavement plate; every
// other lane renders by its material.
export type RoadLayerId = 'pavement' | 'grass' | 'asphalt' | 'concrete' | 'paint' | 'curb';

interface RoadLayerSpec {
	surface: SurfaceClass;
	color: string;
	// Bottom-to-top draw order; upper layers visually carve lower ones.
	order: number;
}

const ROAD_LAYER_SPECS: Record<RoadLayerId, RoadLayerSpec> = {
	pavement: { surface: 'walkway', color: '#9A9A94', order: 0 },
	grass: { surface: 'verge', color: '#52A06B', order: 1 },
	asphalt: { surface: 'roadway', color: '#3D3D3D', order: 2 },
	concrete: { surface: 'roadway', color: '#5B5B54', order: 3 },
	// Dormant in this slice: a flush painted buffer (hatch). No fixture
	// produces it yet; its real hatched render lands in a later slice.
	paint: { surface: 'roadway', color: '#C9C7BD', order: 4 },
	curb: { surface: 'island', color: '#6E6E68', order: 5 }
};

export const ROAD_LAYER_LIST = (Object.keys(ROAD_LAYER_SPECS) as RoadLayerId[]).sort(
	(a, b) => ROAD_LAYER_SPECS[a].order - ROAD_LAYER_SPECS[b].order
);

export function laneLayer(lane: { role: LaneRole; surface: LaneSurface }): RoadLayerId {
	if (lane.role === 'pedestrian') return 'pavement';
	return lane.surface;
}

export function laneSurface(layer: RoadLayerId): SurfaceClass {
	return ROAD_LAYER_SPECS[layer].surface;
}

export function isRoadway(layer: RoadLayerId): boolean {
	return ROAD_LAYER_SPECS[layer].surface === 'roadway';
}

// Islands and verges pool together when matching strips across a node: a
// median can flow into a grass strip and vice versa.
export function isIslandLike(layer: RoadLayerId): boolean {
	const surface = ROAD_LAYER_SPECS[layer].surface;
	return surface === 'island' || surface === 'verge';
}

export function laneColor(layer: RoadLayerId): string {
	return ROAD_LAYER_SPECS[layer].color;
}

// Material-agnostic structural identity: road and concrete share a token (a
// material change is a color seam, not a transition), while grass (verge) and
// median (island) stay structurally distinct.
export function laneStructureToken(lane: Lane) {
	return `${laneSurface(laneLayer(lane))}:${lane.direction}:${lane.width}`;
}

export function lanesStructureKey(lanes: Lane[]) {
	return lanes.map(laneStructureToken).join('|');
}

export interface LanePaint {
	color: 'lane' | 'center';
	dashed: boolean;
}

// Paint on the boundary between two adjacent lanes. Only two vehicle lanes get
// a painted boundary; anything touching a pedestrian or buffer lane is a curb
// edge. Same-direction travel gets dashed white; opposing flow gets a solid
// yellow centre line.
export function lanePaintBetween(a: Lane, b: Lane): LanePaint | null {
	if (a.markings === false || b.markings === false) return null;
	if (a.role !== 'vehicle' || b.role !== 'vehicle') return null;
	if (a.direction !== b.direction) return { color: 'center', dashed: false };
	return { color: 'lane', dashed: true };
}

// Lane layers render between the ground plane and the interaction layers;
// jitter between pieces stays well below the 0.01 step.
export function laneLayerY(layer: RoadLayerId): number {
	return 0.02 + ROAD_LAYER_SPECS[layer].order * 0.01;
}
