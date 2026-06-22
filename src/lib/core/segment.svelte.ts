import type { Lane, SegmentData } from './types';
import { createLanesFrom, getTotalWidth, serializeLanes } from './lane-template';

export class Segment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX = $state<number | undefined>(undefined);
	controlY = $state<number | undefined>(undefined);
	lanes = $state<Lane[]>([]);
	// Manual setback overrides — how far this end pulls back from its node,
	// at least as far as the auto-computed trim. Undefined = use the auto value.
	setbackStart = $state<number | undefined>(undefined);
	setbackEnd = $state<number | undefined>(undefined);

	lanesKey = $derived(serializeLanes(this.lanes));
	totalWidth = $derived(getTotalWidth(this.lanes));

	constructor(id: string, startNodeId: string, endNodeId: string, lanes: Lane[]) {
		this.id = id;
		this.startNodeId = startNodeId;
		this.endNodeId = endNodeId;
		this.lanes = lanes;
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
		if (this.setbackStart !== undefined) data.setbackStart = this.setbackStart;
		if (this.setbackEnd !== undefined) data.setbackEnd = this.setbackEnd;
		return data;
	}

	static fromJSON(data: SegmentData) {
		const lanes =
			data.lanes && data.lanes.length > 0
				? data.lanes.map((lane) => ({ ...lane }))
				: createLanesFrom(data.laneTemplateId ?? 'street');
		const segment = new Segment(data.id, data.startNodeId, data.endNodeId, lanes);
		if (data.controlX !== undefined && data.controlY !== undefined) {
			segment.setControlPoint(data.controlX, data.controlY);
		}
		segment.setbackStart = data.setbackStart;
		segment.setbackEnd = data.setbackEnd;
		return segment;
	}
}
