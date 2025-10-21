import { SvelteMap } from 'svelte/reactivity';

export enum LaneType {
	Road = 'road',
	Grass = 'grass',
	Sidewalk = 'sidewalk'
}

export interface Lane {
	type: LaneType;
	width: number;
	color: string;
}

export interface LaneConfigData {
	id: string;
	lanes: Lane[];
}

export class LaneConfiguration {
	id: string;
	lanes: Lane[];

	constructor(data: LaneConfigData) {
		this.id = data.id;
		this.lanes = data.lanes;
	}

	getTotalWidth(): number {
		return this.lanes.reduce((sum, lane) => sum + lane.width, 0);
	}

	getCenterOffset(): number {
		return this.getTotalWidth() / 2;
	}

	toJSON(): LaneConfigData {
		return {
			id: this.id,
			lanes: this.lanes
		};
	}
}

export class LaneConfigManager {
	private static instance: LaneConfigManager;
	private configs = new SvelteMap<string, LaneConfiguration>();

	private constructor() {
		this.initializeDefaults();
	}

	static getInstance(): LaneConfigManager {
		if (!LaneConfigManager.instance) {
			LaneConfigManager.instance = new LaneConfigManager();
		}
		return LaneConfigManager.instance;
	}

	private initializeDefaults(): void {
		const defaultConfig: LaneConfigData = {
			id: 'default',
			lanes: [
				{ type: LaneType.Sidewalk, width: 1, color: '#888888' },
				{ type: LaneType.Grass, width: 0.5, color: '#90EE90' },
				{ type: LaneType.Road, width: 2, color: '#CCCCCC' },
				{ type: LaneType.Road, width: 2, color: '#CCCCCC' },
				{ type: LaneType.Grass, width: 0.5, color: '#90EE90' },
				{ type: LaneType.Sidewalk, width: 1, color: '#888888' }
			]
		};

		this.configs.set('default', new LaneConfiguration(defaultConfig));
	}

	getDefault(): LaneConfiguration {
		const config = this.configs.get('default');
		if (!config) throw new Error('Default configuration not found');
		return config;
	}

	get(id: string): LaneConfiguration | undefined {
		return this.configs.get(id);
	}

	getOrDefault(id?: string): LaneConfiguration {
		if (!id) return this.getDefault();
		const config = this.configs.get(id);
		return config ?? this.getDefault();
	}

	add(config: LaneConfiguration): void {
		this.configs.set(config.id, config);
	}

	getAll(): LaneConfiguration[] {
		return Array.from(this.configs.values());
	}
}
