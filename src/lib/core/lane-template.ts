import type { Lane, LaneTemplate, LaneType } from './types';
import { LANE_TYPE_SPECS } from './lane-types';

export const LANE_COLORS = Object.fromEntries(
	Object.entries(LANE_TYPE_SPECS).map(([type, spec]) => [type, spec.color])
) as Record<LaneType, string>;

// Templates are presets: drawing (or applying one in the lane editor) copies
// its lanes onto the segment, which owns them from then on.
export const LANE_TEMPLATES: LaneTemplate[] = [
	{
		id: 'street',
		name: 'Street',
		lanes: [
			{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
			{ type: 'road', width: 3, direction: 'backward' },
			{ type: 'road', width: 3, direction: 'forward' },
			{ type: 'sidewalk', width: 2, direction: 'bidirectional' }
		]
	},
	{
		id: 'avenue',
		name: 'Avenue',
		lanes: [
			{ type: 'sidewalk', width: 3, direction: 'bidirectional' },
			{ type: 'grass', width: 1, direction: 'bidirectional' },
			{ type: 'road', width: 3.5, direction: 'backward' },
			{ type: 'road', width: 3.5, direction: 'backward' },
			{ type: 'median', width: 2, direction: 'bidirectional' },
			{ type: 'road', width: 3.5, direction: 'forward' },
			{ type: 'road', width: 3.5, direction: 'forward' },
			{ type: 'grass', width: 1, direction: 'bidirectional' },
			{ type: 'sidewalk', width: 3, direction: 'bidirectional' }
		]
	},
	{
		id: 'highway',
		name: 'Highway',
		lanes: [
			{ type: 'road', width: 3.5, direction: 'backward' },
			{ type: 'road', width: 3.5, direction: 'backward' },
			{ type: 'road', width: 3.5, direction: 'backward' },
			{ type: 'median', width: 3, direction: 'bidirectional' },
			{ type: 'road', width: 3.5, direction: 'forward' },
			{ type: 'road', width: 3.5, direction: 'forward' },
			{ type: 'road', width: 3.5, direction: 'forward' }
		]
	},
	{
		id: 'path',
		name: 'Path',
		lanes: [{ type: 'sidewalk', width: 2, direction: 'bidirectional' }]
	}
];

export function getLaneTemplate(id: string): LaneTemplate | undefined {
	return LANE_TEMPLATES.find((t) => t.id === id);
}

export function getDefaultTemplate(): LaneTemplate {
	return LANE_TEMPLATES[0];
}

export function createLanesFrom(templateId: string): Lane[] {
	const template = getLaneTemplate(templateId) ?? getDefaultTemplate();
	return template.lanes.map((lane) => ({ ...lane }));
}

export function getTotalWidth(lanes: Lane[]): number {
	return lanes.reduce((sum, lane) => sum + lane.width, 0);
}

export function serializeLanes(lanes: Lane[]): string {
	return lanes.map((lane) => `${lane.type}:${lane.width}:${lane.direction}`).join(',');
}
