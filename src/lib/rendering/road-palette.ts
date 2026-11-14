// The colours roads and nodes are drawn in, by surface and paint.

import type { Surface } from '../road-model/model';

// Sidewalk paving and raised concrete medians are the same concrete.
const CONCRETE = '#a3a39e';

export const COLOURS: Record<Surface | 'ground' | 'white' | 'yellow', string> = {
	ground: '#6aa86f',
	asphalt: '#3d3d3d',
	pavement: CONCRETE,
	grass: '#4f9a55',
	concrete: CONCRETE,
	dirt: '#9c7f5a',
	hatch: '#3d3d3d',
	white: '#ecece4',
	yellow: '#e6c34a'
};
