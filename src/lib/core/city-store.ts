import type { CameraState, CityRecord, CitySummary, GraphData } from './types';

// The user's own cities live in localStorage, in dev exactly as in production.
const INDEX_KEY = 'citynista:cities';
const CURRENT_KEY = 'citynista:current-city';
const cityKey = (id: string) => `citynista:city:${id}`;
// The single-graph slot the editor used before cities existed; migrated once.
const LEGACY_GRAPH_KEY = 'citynista-graph-v2';

const EMPTY_GRAPH: GraphData = { nodes: [], segments: [] };

// Examples are read-only files under static/examples/<id>.json, built by
// scripts/examples/. Opening one never writes; the first edit forks it into a
// city of your own.
export const EXAMPLES: CitySummary[] = [{ id: 'neighbourhood', name: 'Neighbourhood' }];

export function slugify(name: string) {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'untitled';
}

export class CityStore {
	list(): CitySummary[] {
		try {
			const raw = localStorage.getItem(INDEX_KEY);
			return raw ? (JSON.parse(raw) as CitySummary[]) : [];
		} catch {
			return [];
		}
	}

	load(id: string): CityRecord | null {
		try {
			const raw = localStorage.getItem(cityKey(id));
			return raw ? (JSON.parse(raw) as CityRecord) : null;
		} catch {
			return null;
		}
	}

	save(city: CityRecord) {
		try {
			localStorage.setItem(cityKey(city.id), JSON.stringify(city));
		} catch {
			// Quota exceeded: keep the index untouched rather than point at nothing.
			return;
		}
		const index = this.list();
		const at = index.findIndex((c) => c.id === city.id);
		if (at >= 0) index[at] = { id: city.id, name: city.name };
		else index.push({ id: city.id, name: city.name });
		localStorage.setItem(INDEX_KEY, JSON.stringify(index));
	}

	remove(id: string) {
		localStorage.removeItem(cityKey(id));
		const index = this.list().filter((c) => c.id !== id);
		localStorage.setItem(INDEX_KEY, JSON.stringify(index));
	}

	currentId() {
		return localStorage.getItem(CURRENT_KEY);
	}

	setCurrentId(id: string) {
		localStorage.setItem(CURRENT_KEY, id);
	}

	create(name: string, graph: GraphData = EMPTY_GRAPH, camera: CameraState | null = null) {
		const taken = new Set(this.list().map((c) => c.id));
		const base = slugify(name);
		let id = base;
		let n = 2;
		while (taken.has(id)) id = `${base}-${n++}`;
		const city: CityRecord = { id, name: id, graph, camera };
		this.save(city);
		return city;
	}

	// The working city on boot: the current one, else a fresh city seeded from the
	// legacy single-graph slot (a one-time migration of pre-city saves).
	ensureCurrent() {
		const id = this.currentId();
		if (id) {
			const current = this.load(id);
			if (current) return current;
		}
		let graph = EMPTY_GRAPH;
		try {
			const legacy = localStorage.getItem(LEGACY_GRAPH_KEY);
			if (legacy) graph = JSON.parse(legacy) as GraphData;
		} catch {
			graph = EMPTY_GRAPH;
		}
		const city = this.create('untitled', graph);
		this.setCurrentId(city.id);
		return city;
	}
}

export function getExample(id: string) {
	return EXAMPLES.find((example) => example.id === id) ?? null;
}

// Fetch an example's original graph and camera. Never cached or written back.
export async function loadExample(id: string): Promise<CityRecord | null> {
	const example = getExample(id);
	if (!example) return null;
	try {
		const response = await fetch(`/examples/${id}.json`);
		if (!response.ok) return null;
		const data = await response.json();
		const graph: GraphData = data?.graph;
		const camera: CameraState | null = data?.camera ?? null;
		if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.segments)) return null;
		return { id, name: example.name, graph, camera };
	} catch {
		return null;
	}
}
