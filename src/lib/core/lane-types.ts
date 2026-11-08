import type { LaneMaterial } from './types';

// Each lane material's swatch colour in the lane panel and the preset buttons.
export const MATERIAL_COLOR: Record<LaneMaterial, string> = {
	asphalt: '#3D3D3D',
	concrete: '#5B5B54',
	pavement: '#9A9A94',
	grass: '#52A06B',
	dirt: '#9C7F5A'
};
