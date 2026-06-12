import type { LaneType } from './types';

// Every rule about how lanes render and connect is keyed to a lane type's
// SURFACE CLASS, never to its name — adding a lane type is one row here.
//
// - roadway: vehicle-level paving (asphalt, concrete, bike, parking,
//   transit). Roadways always flow into each other across transitions
//   (material changes are a color seam), stop at junction stop lines, and
//   are covered by the asphalt patch inside junctions.
// - island: raised strips inside the roadway (medians). Islands flow into
//   other islands or verges across transitions and end in a rounded nose
//   when nothing continues them.
// - verge: planted strips (grass). Verges flow into islands/verges and end
//   in a square cut everywhere else — never a sliver.
// - walkway: pedestrian paving (sidewalks). Rendered via the full-width
//   pavement plate; wraps junction corners.
export type SurfaceClass = 'roadway' | 'island' | 'verge' | 'walkway';

export interface LaneTypeSpec {
	label: string;
	surface: SurfaceClass;
	color: string;
	// Stacking among lane layers, bottom to top. Order resolves which side
	// of a shared boundary wins where bands intentionally overlap.
	order: number;
	// Whether the lane carries a direction of travel.
	directional: boolean;
	// Accessory roadways (bike, parking, transit) ride on the main roadway
	// and merge into it before junctions and across transitions with no
	// counterpart — they never end square against a stop line.
	accessory?: boolean;
}

export const LANE_TYPE_SPECS: Record<LaneType, LaneTypeSpec> = {
	sidewalk: {
		label: 'Sidewalk',
		surface: 'walkway',
		color: '#9A9A94',
		order: 0,
		directional: false
	},
	grass: { label: 'Grass', surface: 'verge', color: '#52A06B', order: 1, directional: false },
	road: { label: 'Road', surface: 'roadway', color: '#3D3D3D', order: 2, directional: true },
	concrete: {
		label: 'Concrete',
		surface: 'roadway',
		color: '#5B5B54',
		order: 3,
		directional: true
	},
	transit: {
		label: 'Transit',
		surface: 'roadway',
		color: '#5C4444',
		order: 4,
		directional: true,
		accessory: true
	},
	bike: {
		label: 'Bike',
		surface: 'roadway',
		color: '#7E564D',
		order: 5,
		directional: true,
		accessory: true
	},
	parking: {
		label: 'Parking',
		surface: 'roadway',
		color: '#48484F',
		order: 6,
		directional: false,
		accessory: true
	},
	median: { label: 'Median', surface: 'island', color: '#6E6E68', order: 7, directional: false }
};

export const LANE_TYPE_LIST = (Object.keys(LANE_TYPE_SPECS) as LaneType[]).sort(
	(a, b) => LANE_TYPE_SPECS[a].order - LANE_TYPE_SPECS[b].order
);

export function laneSurface(type: LaneType): SurfaceClass {
	return LANE_TYPE_SPECS[type].surface;
}

export function isRoadway(type: LaneType): boolean {
	return LANE_TYPE_SPECS[type].surface === 'roadway';
}

// Islands and verges pool together when matching strips across a node: a
// median can flow into a grass strip and vice versa.
export function isIslandLike(type: LaneType): boolean {
	const surface = LANE_TYPE_SPECS[type].surface;
	return surface === 'island' || surface === 'verge';
}

export function isAccessoryRoadway(type: LaneType): boolean {
	return LANE_TYPE_SPECS[type].accessory === true;
}

export function laneColor(type: LaneType): string {
	return LANE_TYPE_SPECS[type].color;
}

// Lane layers render between the ground plane and the interaction layers;
// jitter between pieces stays well below the 0.01 step.
export function laneLayerY(type: LaneType): number {
	return 0.02 + LANE_TYPE_SPECS[type].order * 0.01;
}
