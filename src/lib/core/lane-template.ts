import type {
	Lane,
	LaneMaterial,
	LaneRole,
	LaneTemplate,
	LegacyLaneSurface,
	LegacyLaneType,
	StoredLane
} from './types';
import { laneColor, laneLayer } from './lane-types';

export function laneSwatchColor(lane: {
	role: LaneRole;
	material: LaneMaterial;
	raised?: boolean;
}) {
	return laneColor(laneLayer(lane));
}

// Templates are presets: drawing (or applying one in the lane editor) copies
// its lanes onto the segment, which owns them from then on.
export const LANE_TEMPLATES: LaneTemplate[] = [
	{
		id: 'street',
		name: 'Street',
		lanes: [
			{ role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' },
			{ role: 'vehicle', material: 'asphalt', width: 3, direction: 'backward' },
			{ role: 'vehicle', material: 'asphalt', width: 3, direction: 'forward' },
			{ role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' }
		]
	},
	{
		id: 'avenue',
		name: 'Avenue',
		lanes: [
			{ role: 'pedestrian', material: 'pavement', width: 3, direction: 'bidirectional' },
			{ role: 'buffer', material: 'grass', width: 1, direction: 'bidirectional' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{
				role: 'buffer',
				material: 'concrete',
				raised: true,
				width: 2,
				direction: 'bidirectional'
			},
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'buffer', material: 'grass', width: 1, direction: 'bidirectional' },
			{ role: 'pedestrian', material: 'pavement', width: 3, direction: 'bidirectional' }
		]
	},
	{
		id: 'highway',
		name: 'Highway',
		lanes: [
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{
				role: 'buffer',
				material: 'concrete',
				raised: true,
				width: 3,
				direction: 'bidirectional'
			},
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
		]
	},
	{
		id: 'path',
		name: 'Path',
		lanes: [{ role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' }]
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
		.map((lane) => {
			const raised = lane.role === 'buffer' && lane.raised ? ':raised' : '';
			const markings = lane.markings === false ? ':nomark' : '';
			return `${lane.role}:${lane.material}:${lane.width}:${lane.direction}${raised}${markings}`;
		})
		.join(',');
}

const LEGACY_TYPE_MAP: Record<
	LegacyLaneType,
	{ role: LaneRole; material: LaneMaterial; raised?: boolean }
> = {
	road: { role: 'vehicle', material: 'asphalt' },
	concrete: { role: 'vehicle', material: 'concrete' },
	bike: { role: 'vehicle', material: 'asphalt' },
	parking: { role: 'vehicle', material: 'asphalt' },
	transit: { role: 'vehicle', material: 'asphalt' },
	turn: { role: 'vehicle', material: 'asphalt' },
	sidewalk: { role: 'pedestrian', material: 'pavement' },
	grass: { role: 'buffer', material: 'grass' },
	median: { role: 'buffer', material: 'concrete', raised: true }
};

function legacySurfaceMaterial(surface: LegacyLaneSurface): {
	material: LaneMaterial;
	raised?: boolean;
} {
	switch (surface) {
		case 'curb':
			return { material: 'concrete', raised: true };
		case 'paint':
			return { material: 'asphalt' };
		case 'grass':
			return { material: 'grass' };
		case 'concrete':
			return { material: 'concrete' };
		case 'asphalt':
			return { material: 'asphalt' };
	}
}

export function migrateLane(stored: StoredLane): Lane {
	const base = stored.type
		? LEGACY_TYPE_MAP[stored.type]
		: {
				role: stored.role ?? ('vehicle' as const),
				material: stored.material ?? ('asphalt' as const),
				raised: stored.raised
			};

	let material = base.material;
	let raised = base.raised;

	if (!stored.material && stored.surface) {
		const legacy = legacySurfaceMaterial(stored.surface);
		material = base.role === 'pedestrian' ? 'pavement' : legacy.material;
		raised = base.role === 'buffer' ? (legacy.raised ?? stored.raised) : undefined;
	}

	if (stored.material) {
		material = stored.material;
		raised = base.role === 'buffer' ? stored.raised : undefined;
	}

	const lane: Lane = {
		role: base.role,
		material,
		width: stored.width,
		direction: base.role === 'vehicle' ? stored.direction : 'bidirectional'
	};
	if (base.role === 'buffer' && raised) lane.raised = true;
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
