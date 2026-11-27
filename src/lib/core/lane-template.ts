import type { Brush, Lane, LaneMaterial, LaneRole, LaneTemplate } from './types';
import { MATERIAL_COLOR } from './lane-types';

export function laneSwatchColor(lane: { role: LaneRole; material: LaneMaterial }) {
	return MATERIAL_COLOR[lane.material];
}

// Templates are presets: drawing (or applying one in the lane editor) copies
// its lanes onto the segment, which owns them from then on.
const LANE_TEMPLATES: LaneTemplate[] = [
	{
		id: 'street',
		name: 'Street',
		lanes: [
			{ role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
		]
	},
	{
		id: 'avenue',
		name: 'Avenue',
		lanes: [
			{ role: 'pedestrian', material: 'concrete', width: 3, direction: 'bidirectional' },
			{ role: 'buffer', material: 'grass', width: 1, direction: 'bidirectional' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
			{
				role: 'buffer',
				material: 'concrete',
				width: 2,
				direction: 'bidirectional'
			},
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
			{ role: 'buffer', material: 'grass', width: 1, direction: 'bidirectional' },
			{ role: 'pedestrian', material: 'concrete', width: 3, direction: 'bidirectional' }
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
		lanes: [{ role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }]
	},
	{
		id: 'lane',
		name: 'One-way lane',
		lanes: [{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }]
	}
];

function getLaneTemplate(id: string): LaneTemplate | undefined {
	return LANE_TEMPLATES.find((t) => t.id === id);
}

function getDefaultTemplate(): LaneTemplate {
	return LANE_TEMPLATES[0];
}

export function cloneLanes(lanes: readonly Lane[]): Lane[] {
	return lanes.map((lane) => ({ ...lane }));
}

export function createLanesFrom(templateId: string): Lane[] {
	const template = getLaneTemplate(templateId) ?? getDefaultTemplate();
	return cloneLanes(template.lanes);
}

export const HOTBAR_SIZE = 9;

export function defaultHotbar(): (Brush | null)[] {
	const slots: (Brush | null)[] = Array(HOTBAR_SIZE).fill(null);
	LANE_TEMPLATES.forEach((template, i) => {
		if (i < HOTBAR_SIZE) slots[i] = { name: template.name, lanes: cloneLanes(template.lanes) };
	});
	return slots;
}

export function getTotalWidth(lanes: readonly Lane[]): number {
	return lanes.reduce((sum, lane) => sum + lane.width, 0);
}

// The one way a cross-section's vehicle lanes all run, if they all run one
// way; null for none or for two-way traffic.
export function oneWay(lanes: readonly Lane[]) {
	const vehicles = lanes.filter((lane) => lane.role === 'vehicle');
	const dir = vehicles[0]?.direction;
	if (dir === 'bidirectional' || !vehicles.every((lane) => lane.direction === dir)) return null;
	return dir ?? null;
}

export function serializeLanes(lanes: readonly Lane[]): string {
	return lanes
		.map((lane) => `${lane.role}:${lane.material}:${lane.width}:${lane.direction}`)
		.join(',');
}

// The same cross-section read end-to-end the other way: lane order reverses and
// travel directions flip, so two segments meeting at a node can be compared in a
// shared flow direction.
export function reverseLanes(lanes: readonly Lane[]): Lane[] {
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
