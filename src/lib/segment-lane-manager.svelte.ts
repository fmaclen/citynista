import { type Canvas } from 'fabric';
import type { Segment } from './segment.svelte';
import type { Graph } from './graph.svelte';
import { LaneGroup } from './lane-group.svelte';
import { LaneConfigManager } from './lane-config.svelte';

/**
 * Manages lane lifecycle for a segment (creation, updates, cleanup)
 * Separates lane concerns from segment logic
 */
export class SegmentLaneManager {
	private laneGroup: LaneGroup | null = null;
	laneConfigId = $state<string>('default');

	constructor(
		private segment: Segment,
		private canvas: Canvas,
		private graph: Graph
	) {
		this.createLaneGroup();
	}

	private createLaneGroup(): void {
		if (this.laneGroup) {
			this.laneGroup.cleanup();
		}

		const configManager = LaneConfigManager.getInstance();
		const config = configManager.getOrDefault(this.laneConfigId);
		this.laneGroup = new LaneGroup(this.segment, this.canvas, this.graph, config);
	}

	update(): void {
		if (this.laneGroup) {
			this.laneGroup.update();
		}
	}

	setConfigId(configId: string): void {
		if (configId !== this.laneConfigId) {
			this.laneConfigId = configId;
			this.createLaneGroup();
		}
	}

	cleanup(): void {
		if (this.laneGroup) {
			this.laneGroup.cleanup();
			this.laneGroup = null;
		}
	}

	getConfigId(): string {
		return this.laneConfigId;
	}
}
