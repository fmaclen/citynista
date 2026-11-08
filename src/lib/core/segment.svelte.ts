import type { Lane, SegmentData } from './types';
import { createLanesFrom, getTotalWidth, migrateLanes, serializeLanes } from './lane-template';

export class Segment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX = $state<number | undefined>(undefined);
	controlY = $state<number | undefined>(undefined);
	lanes = $state<Lane[]>([]);
	// Metres the cross-section sits to the right of the drawn line, looking
	// from the start node to the end node (0 = centred on the line).
	offset = $state(0);

	lanesKey = $derived(serializeLanes(this.lanes));
	totalWidth = $derived(getTotalWidth(this.lanes));

	constructor(id: string, startNodeId: string, endNodeId: string, lanes: Lane[]) {
		this.id = id;
		this.startNodeId = startNodeId;
		this.endNodeId = endNodeId;
		this.lanes = lanes;
		this.ensureLaneIds();
	}

	// Gives every lane without one an id unused anywhere on the segment.
	ensureLaneIds() {
		const used = this.lanes.flatMap((l) => (l.id ? [l.id] : []));
		let n = 0;
		for (const lane of this.lanes) {
			if (lane.id && this.lanes.filter((l) => l.id === lane.id).length === 1) continue;
			while (used.includes(`l${n}`)) n++;
			lane.id = `l${n}`;
			used.push(lane.id);
		}
	}

	get hasControlPoint() {
		return this.controlX !== undefined && this.controlY !== undefined;
	}

	setControlPoint(x: number, y: number) {
		this.controlX = x;
		this.controlY = y;
	}

	clearControlPoint() {
		this.controlX = undefined;
		this.controlY = undefined;
	}

	cloneLanes(): Lane[] {
		return this.lanes.map((lane) => ({ ...lane }));
	}

	toJSON(): SegmentData {
		const data: SegmentData = {
			id: this.id,
			startNodeId: this.startNodeId,
			endNodeId: this.endNodeId,
			controlX: this.controlX,
			controlY: this.controlY,
			lanes: this.cloneLanes()
		};
		if (this.offset) data.offset = this.offset;
		return data;
	}

	static fromJSON(data: SegmentData) {
		const lanes =
			data.lanes && data.lanes.length > 0
				? migrateLanes(data.lanes)
				: createLanesFrom(data.laneTemplateId ?? 'street');
		const segment = new Segment(data.id, data.startNodeId, data.endNodeId, lanes);
		if (data.controlX !== undefined && data.controlY !== undefined) {
			segment.setControlPoint(data.controlX, data.controlY);
		}
		segment.offset = data.offset ?? 0;
		return segment;
	}
}
