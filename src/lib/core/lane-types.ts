import type { Lane, LaneMaterial } from './types';

// Each lane material's swatch colour in the lane panel and the preset buttons.
export const MATERIAL_COLOR: Record<LaneMaterial, string> = {
	asphalt: '#3D3D3D',
	concrete: '#9A9A94',
	grass: '#52A06B',
	dirt: '#9C7F5A'
};

// Which network a road is of (core/networks.ts): the car roads, every road
// with a car lane, or the footpaths, every other road. Roads of one network
// meet at nodes; a node never holds both (core/separate.ts). Read once per
// cross-section: a lane edit gives a road a new one (editor.editLanes).
const known = new WeakMap<readonly Lane[], boolean>();
export function carries(lanes: readonly Lane[]) {
	let car = known.get(lanes);
	if (car === undefined) {
		car = lanes.some((l) => l.role === 'vehicle');
		known.set(lanes, car);
	}
	return car;
}
