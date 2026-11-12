import type { CameraState, CityRecord, CitySummary, GraphData } from './types';

// The shape of saved cities and examples. Bump it whenever the saved graph's
// shape changes: anything written with another version is ignored, never
// migrated, so a library from an older build starts clean.
export const SCHEMA_VERSION = 2;

// The user's own cities live in localStorage, in dev exactly as in production.
const INDEX_KEY = 'citynista:cities';
const CURRENT_KEY = 'citynista:current-city';
const cityKey = (id: string) => `citynista:city:${id}`;
const cameraKey = (id: string) => `citynista:cam:${id}`;

// What is stored: each index entry and each city carries the version it was
// written with.
type StoredSummary = CitySummary & { version: number };
type StoredCity = CityRecord & { version: number };

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
			const index: StoredSummary[] = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]');
			return index.map(({ id, name }) => ({ id, name }));
		} catch {
			return [];
		}
	}

	// Drop every city written with another version, or none: its index entry
	// or its record. Run once on boot, so the library holds current cities only.
	prune() {
		let index: StoredSummary[] = [];
		try {
			index = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]');
		} catch {
			// unreadable: rewritten empty below
		}
		if (!Array.isArray(index)) index = [];
		const kept = index.filter((c) => c?.version === SCHEMA_VERSION && this.load(c.id));
		for (const c of index)
			if (!kept.includes(c) && typeof c?.id === 'string') this.removeKeys(c.id);
		if (kept.length !== index.length) this.writeIndex(kept);
	}

	// A city from another version (or none) reads as absent.
	load(id: string): CityRecord | null {
		let city: StoredCity | null = null;
		try {
			city = JSON.parse(localStorage.getItem(cityKey(id)) ?? 'null');
		} catch {
			city = null;
		}
		if (city?.version !== SCHEMA_VERSION) return null;
		return { id: city.id, name: city.name, graph: city.graph, camera: city.camera ?? null };
	}

	save(city: CityRecord) {
		const stored: StoredCity = { ...city, version: SCHEMA_VERSION };
		try {
			localStorage.setItem(cityKey(city.id), JSON.stringify(stored));
		} catch {
			// Quota exceeded: keep the index untouched rather than point at nothing.
			return;
		}
		const index = this.list();
		const at = index.findIndex((c) => c.id === city.id);
		if (at >= 0) index[at] = { id: city.id, name: city.name };
		else index.push({ id: city.id, name: city.name });
		this.writeIndex(index);
	}

	private writeIndex(index: CitySummary[]) {
		const stored: StoredSummary[] = index.map(({ id, name }) => ({
			id,
			name,
			version: SCHEMA_VERSION
		}));
		localStorage.setItem(INDEX_KEY, JSON.stringify(stored));
	}

	private removeKeys(id: string) {
		localStorage.removeItem(cityKey(id));
		localStorage.removeItem(cameraKey(id));
	}

	// A rename touches only the name; the stored map stays as last saved.
	rename(id: string, name: string) {
		const city = this.load(id);
		if (city) this.save({ ...city, name });
	}

	remove(id: string) {
		this.removeKeys(id);
		this.writeIndex(this.list().filter((c) => c.id !== id));
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

	// The working city on boot: the current one, else a fresh empty city.
	ensureCurrent() {
		this.prune();
		const id = this.currentId();
		if (id) {
			const current = this.load(id);
			if (current) return current;
		}
		const city = this.create('untitled');
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
		// A stale example fails loudly rather than drawing wrong.
		if (data?.version !== SCHEMA_VERSION) {
			console.error(`Example ${id} is version ${data?.version}, expected ${SCHEMA_VERSION}`);
			return null;
		}
		const graph: GraphData = data?.graph;
		const camera: CameraState | null = data?.camera ?? null;
		if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.segments)) return null;
		return { id, name: example.name, graph, camera };
	} catch {
		return null;
	}
}
