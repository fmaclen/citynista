import type { Lane, LaneMaterial } from './types';

// Every rule about how lanes render and connect is keyed to a render layer's
// SURFACE CLASS, not to a lane's function or material name.
//
// - roadway: vehicle-level paving. Roadways always flow into each other
//   across transitions (material changes are a color seam), stop at junction
//   stop lines, and are covered by the patch inside junctions.
// - island: centre dividers between opposing vehicle flows. Islands flow into
//   other islands or verges across transitions and end in a rounded nose when
//   nothing continues them.
// - verge: side buffer strips. Verges flow into islands/verges and end in a
//   square cut everywhere else - never a sliver.
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

export function medianBufferIndex(lanes: readonly Lane[]) {
	const bounds = laneBoundaryOffsets(lanes);
	const forward: number[] = [];
	const backward: number[] = [];
	for (let i = 0; i < lanes.length; i++) {
		const lane = lanes[i];
		if (lane.role !== 'vehicle') continue;
		if (lane.direction === 'forward') forward.push(i);
		else if (lane.direction === 'backward') backward.push(i);
	}
	if (forward.length === 0 || backward.length === 0) return null;

	const maxBackward = Math.max(...backward);
	const minForward = Math.min(...forward);
	const maxForward = Math.max(...forward);
	const minBackward = Math.min(...backward);
	const dividerOffset =
		maxBackward < minForward
			? (bounds[maxBackward + 1] + bounds[minForward]) / 2
			: (bounds[maxForward + 1] + bounds[minBackward]) / 2;

	for (let i = 0; i < lanes.length; i++) {
		if (lanes[i].role !== 'buffer') continue;
		if (bounds[i] - 0.001 <= dividerOffset && dividerOffset <= bounds[i + 1] + 0.001) {
			return i;
		}
	}
	return null;
}

export function surfaceClassForLane(lanes: readonly Lane[], index: number): SurfaceClass {
	const lane = lanes[index];
	if (lane.role === 'vehicle') return 'roadway';
	if (lane.role === 'pedestrian') return 'walkway';
	return medianBufferIndex(lanes) === index ? 'island' : 'verge';
}

export function laneLayer(lanes: readonly Lane[], index: number): LaneLayerId {
	const lane = lanes[index];
	return `${surfaceClassForLane(lanes, index)}:${lane.material}`;
}

export function surfaceClassOf(layer: RoadLayerId): SurfaceClass {
	if (layer === 'plate') return 'walkway';
	return layer.split(':')[0] as SurfaceClass;
}

export function isRoadway(layer: RoadLayerId): boolean {
	return surfaceClassOf(layer) === 'roadway';
}

// Islands and verges pool together when matching strips across a node: a
// centre median can flow into a side buffer and vice versa.
export function isIslandLike(layer: RoadLayerId): boolean {
	const surfaceClass = surfaceClassOf(layer);
	return surfaceClass === 'island' || surfaceClass === 'verge';
}

export function laneColor(layer: RoadLayerId): string {
	if (layer === 'plate') return MATERIAL_COLOR.pavement;
	return MATERIAL_COLOR[materialOf(layer)];
}

// Structural identity is independent of exact material color and of whether a
// buffer's position classifies it as a centre island or side verge.
export function laneStructureToken(lane: Lane) {
	const materialClass =
		lane.role === 'vehicle' ? 'roadway' : lane.role === 'pedestrian' ? 'walkway' : 'buffer';
	return `${lane.role}:${materialClass}:${lane.direction}:${lane.width}`;
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

function laneBoundaryOffsets(lanes: readonly Lane[]) {
	const total = lanes.reduce((sum, lane) => sum + lane.width, 0);
	const bounds = [-total / 2];
	for (const lane of lanes) {
		bounds.push(bounds[bounds.length - 1] + lane.width);
	}
	return bounds;
}
