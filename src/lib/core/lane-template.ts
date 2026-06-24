import type {
	Lane,
	LaneRole,
	LaneSurface,
	LaneTemplate,
	LegacyLaneType,
	StoredLane
} from './types';
import { laneColor, laneLayer } from './lane-types';

export function laneSwatchColor(lane: { role: LaneRole; surface: LaneSurface }) {
	return laneColor(laneLayer(lane));
}

// Templates are presets: drawing (or applying one in the lane editor) copies
// its lanes onto the segment, which owns them from then on.
export const LANE_TEMPLATES: LaneTemplate[] = [
	{
		id: 'street',
		name: 'Street',
		lanes: [
			{ role: 'pedestrian', surface: 'concrete', width: 2, direction: 'bidirectional' },
			{ role: 'vehicle', surface: 'asphalt', width: 3, direction: 'backward' },
			{ role: 'vehicle', surface: 'asphalt', width: 3, direction: 'forward' },
			{ role: 'pedestrian', surface: 'concrete', width: 2, direction: 'bidirectional' }
		]
	},
	{
		id: 'avenue',
		name: 'Avenue',
		lanes: [
			{ role: 'pedestrian', surface: 'concrete', width: 3, direction: 'bidirectional' },
			{ role: 'buffer', surface: 'grass', width: 1, direction: 'bidirectional' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'buffer', surface: 'curb', width: 2, direction: 'bidirectional' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'buffer', surface: 'grass', width: 1, direction: 'bidirectional' },
			{ role: 'pedestrian', surface: 'concrete', width: 3, direction: 'bidirectional' }
		]
	},
	{
		id: 'highway',
		name: 'Highway',
		lanes: [
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'buffer', surface: 'curb', width: 3, direction: 'bidirectional' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'vehicle', surface: 'asphalt', width: 3.5, direction: 'forward' }
		]
	},
	{
		id: 'path',
		name: 'Path',
		lanes: [{ role: 'pedestrian', surface: 'concrete', width: 2, direction: 'bidirectional' }]
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
	return lanes
		.map(
			(lane) =>
				`${lane.role}:${lane.surface}:${lane.width}:${lane.direction}${lane.markings === false ? ':nomark' : ''}`
		)
		.join(',');
}

const LEGACY_TYPE_MAP: Record<LegacyLaneType, { role: LaneRole; surface: LaneSurface }> = {
	road: { role: 'vehicle', surface: 'asphalt' },
	concrete: { role: 'vehicle', surface: 'concrete' },
	bike: { role: 'vehicle', surface: 'asphalt' },
	parking: { role: 'vehicle', surface: 'asphalt' },
	transit: { role: 'vehicle', surface: 'asphalt' },
	turn: { role: 'vehicle', surface: 'asphalt' },
	sidewalk: { role: 'pedestrian', surface: 'concrete' },
	grass: { role: 'buffer', surface: 'grass' },
	median: { role: 'buffer', surface: 'curb' }
};

export function migrateLane(stored: StoredLane): Lane {
	const base =
		stored.role && stored.surface
			? { role: stored.role, surface: stored.surface }
			: stored.type
				? LEGACY_TYPE_MAP[stored.type]
				: { role: 'vehicle' as const, surface: 'asphalt' as const };
	const lane: Lane = {
		role: base.role,
		surface: base.surface,
		width: stored.width,
		direction: base.role === 'vehicle' ? stored.direction : 'bidirectional'
	};
	if (stored.markings === false) lane.markings = false;
	return lane;
}

export function migrateLanes(stored: StoredLane[]): Lane[] {
	return stored.map(migrateLane);
}

// The same cross-section read end-to-end the other way: lane order reverses and
// travel directions flip, so two segments meeting at a node can be compared in a
// shared flow direction.
export function reverseLanes(lanes: Lane[]): Lane[] {
	return lanes
		.slice()
		.reverse()
		.map((lane) => ({
			...lane,
			direction:
				lane.direction === 'forward'
					? 'backward'
					: lane.direction === 'backward'
						? 'forward'
						: lane.direction
		}));
}
