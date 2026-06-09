import type { LaneTemplate } from './types';

export const LANE_COLORS = {
	road: '#4a4a4a',
	sidewalk: '#9ca3af',
	grass: '#22c55e',
	median: '#71717a'
};

export const LANE_TEMPLATES: LaneTemplate[] = [
	{
		id: 'street',
		name: 'Street',
		lanes: [
			{ type: 'sidewalk', width: 2, color: LANE_COLORS.sidewalk, direction: 'bidirectional' },
			{ type: 'road', width: 3, color: LANE_COLORS.road, direction: 'backward' },
			{ type: 'road', width: 3, color: LANE_COLORS.road, direction: 'forward' },
			{ type: 'sidewalk', width: 2, color: LANE_COLORS.sidewalk, direction: 'bidirectional' }
		]
	},
	{
		id: 'avenue',
		name: 'Avenue',
		lanes: [
			{ type: 'sidewalk', width: 3, color: LANE_COLORS.sidewalk, direction: 'bidirectional' },
			{ type: 'grass', width: 1, color: LANE_COLORS.grass, direction: 'bidirectional' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'backward' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'backward' },
			{ type: 'median', width: 2, color: LANE_COLORS.median, direction: 'bidirectional' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'forward' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'forward' },
			{ type: 'grass', width: 1, color: LANE_COLORS.grass, direction: 'bidirectional' },
			{ type: 'sidewalk', width: 3, color: LANE_COLORS.sidewalk, direction: 'bidirectional' }
		]
	},
	{
		id: 'highway',
		name: 'Highway',
		lanes: [
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'backward' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'backward' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'backward' },
			{ type: 'median', width: 3, color: LANE_COLORS.median, direction: 'bidirectional' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'forward' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'forward' },
			{ type: 'road', width: 3.5, color: LANE_COLORS.road, direction: 'forward' }
		]
	},
	{
		id: 'path',
		name: 'Path',
		lanes: [{ type: 'sidewalk', width: 2, color: LANE_COLORS.sidewalk, direction: 'bidirectional' }]
	}
];

export function getLaneTemplate(id: string): LaneTemplate | undefined {
	return LANE_TEMPLATES.find((t) => t.id === id);
}

export function getDefaultTemplate(): LaneTemplate {
	return LANE_TEMPLATES[0];
}

export function getTotalWidth(template: LaneTemplate): number {
	return template.lanes.reduce((sum, lane) => sum + lane.width, 0);
}

export function getLaneOffsets(template: LaneTemplate): number[] {
	const totalWidth = getTotalWidth(template);
	const offsets: number[] = [];
	let currentOffset = -totalWidth / 2;

	for (const lane of template.lanes) {
		offsets.push(currentOffset + lane.width / 2);
		currentOffset += lane.width;
	}

	return offsets;
}
