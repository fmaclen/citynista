import type { Lane, LaneMaterial, LaneRole } from './types';

// Every rule about how lanes render and connect is keyed to a render layer's
// SURFACE CLASS, not to a lane's function or material name.
//
// - roadway: vehicle-level paving. Roadways always flow into each other
//   across transitions (material changes are a color seam), stop at junction
//   stop lines, and are covered by the patch inside junctions.
// - island: raised strips inside the roadway. Islands flow into other islands
//   or verges across transitions and end in a rounded nose when nothing
//   continues them.
// - verge: flush buffer strips. Verges flow into islands/verges and end in a
//   square cut everywhere else — never a sliver.
// - walkway: pedestrian paving. Pavement walkways render via the full-width
//   plate; other materials draw bands over that plate.
export type SurfaceClass = 'roadway' | 'island' | 'verge' | 'walkway';
export type LaneLayerId = `${SurfaceClass}:${LaneMaterial}`;
export type RoadLayerId = 'plate' | LaneLayerId;

export const MATERIAL_COLOR: Record<LaneMaterial, string> = {
	asphalt: '#3D3D3D',
	concrete: '#5B5B54',
	pavement: '#9A9A94',
	grass: '#52A06B',
	dirt: '#9C7F5A'
};

const CLASS_ORDER: Record<'plate' | SurfaceClass, number> = {
	plate: 0,
	walkway: 1,
	verge: 2,
	roadway: 3,
	island: 4
};

const MATERIAL_ORDER: Record<LaneMaterial, number> = {
	asphalt: 0,
	concrete: 1,
	pavement: 2,
	grass: 3,
	dirt: 4
};

const LANE_MATERIALS: LaneMaterial[] = ['asphalt', 'concrete', 'pavement', 'grass', 'dirt'];
const SURFACE_CLASSES: SurfaceClass[] = ['walkway', 'verge', 'roadway', 'island'];

const roadLayers: RoadLayerId[] = ['plate'];
for (const surfaceClass of SURFACE_CLASSES) {
	for (const material of LANE_MATERIALS) {
		roadLayers.push(`${surfaceClass}:${material}`);
	}
}

export const ROAD_LAYER_LIST = roadLayers.sort((a, b) => {
	const classDiff = layerClassOrder(a) - layerClassOrder(b);
	if (classDiff !== 0) return classDiff;
	return materialOrder(a) - materialOrder(b);
});

export function surfaceClassForLane(lane: { role: LaneRole; raised?: boolean }): SurfaceClass {
	if (lane.role === 'vehicle') return 'roadway';
	if (lane.role === 'pedestrian') return 'walkway';
	return lane.raised ? 'island' : 'verge';
}

export function laneLayer(lane: {
	role: LaneRole;
	material: LaneMaterial;
	raised?: boolean;
}): LaneLayerId {
	return `${surfaceClassForLane(lane)}:${lane.material}`;
}

export function surfaceClassOf(layer: RoadLayerId): SurfaceClass {
	if (layer === 'plate') return 'walkway';
	return layer.split(':')[0] as SurfaceClass;
}

export function isRoadway(layer: RoadLayerId): boolean {
	return surfaceClassOf(layer) === 'roadway';
}

// Islands and verges pool together when matching strips across a node: a
// raised median can flow into a flush buffer and vice versa.
export function isIslandLike(layer: RoadLayerId): boolean {
	const surfaceClass = surfaceClassOf(layer);
	return surfaceClass === 'island' || surfaceClass === 'verge';
}

export function laneColor(layer: RoadLayerId): string {
	if (layer === 'plate') return MATERIAL_COLOR.pavement;
	return MATERIAL_COLOR[materialOf(layer)];
}

// Material-agnostic structural identity: asphalt and concrete share a token
// inside a class, while raised buffers change class and therefore structure.
export function laneStructureToken(lane: Lane) {
	return `${surfaceClassForLane(lane)}:${lane.direction}:${lane.width}`;
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

// Lane layers render between the ground plane and the interaction layers.
// Material sub-order spacing is larger than the per-piece jitter budget, so
// same-class materials can overlap without z-fighting.
export function laneLayerY(layer: RoadLayerId): number {
	if (layer === 'plate') return 0.02;
	return 0.02 + CLASS_ORDER[surfaceClassOf(layer)] * 0.06 + materialOrder(layer) * 0.012;
}

function materialOf(layer: LaneLayerId): LaneMaterial {
	return layer.split(':')[1] as LaneMaterial;
}

function materialOrder(layer: RoadLayerId): number {
	if (layer === 'plate') return 0;
	return MATERIAL_ORDER[materialOf(layer)];
}

function layerClassOrder(layer: RoadLayerId): number {
	if (layer === 'plate') return CLASS_ORDER.plate;
	return CLASS_ORDER[surfaceClassOf(layer)];
}
