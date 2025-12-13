import type { SegmentData } from './types';

export class Segment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX = $state<number | undefined>(undefined);
	controlY = $state<number | undefined>(undefined);
	laneTemplateId: string;

	constructor(
		id: string,
		startNodeId: string,
		endNodeId: string,
		laneTemplateId: string = 'default'
	) {
		this.id = id;
		this.startNodeId = startNodeId;
		this.endNodeId = endNodeId;
		this.laneTemplateId = laneTemplateId;
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

	toJSON(): SegmentData {
		return {
			id: this.id,
			startNodeId: this.startNodeId,
			endNodeId: this.endNodeId,
			controlX: this.controlX,
			controlY: this.controlY,
			laneTemplateId: this.laneTemplateId
		};
	}

	static fromJSON(data: SegmentData) {
		const segment = new Segment(data.id, data.startNodeId, data.endNodeId, data.laneTemplateId);
		if (data.controlX !== undefined && data.controlY !== undefined) {
			segment.setControlPoint(data.controlX, data.controlY);
		}
		return segment;
	}
}
