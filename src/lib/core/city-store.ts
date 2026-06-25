import { dev } from '$app/environment';
import type { CameraState, CityRecord, CitySummary, GraphData } from './types';

// Where the "which city am I in" pointer and (in prod) the cities themselves live.
const INDEX_KEY = 'citynista:cities';
const CURRENT_KEY = 'citynista:current-city';
const cityKey = (id: string) => `citynista:city:${id}`;
// The single-graph slot the editor used before cities existed; migrated once.
const LEGACY_GRAPH_KEY = 'citynista-graph-v2';

const EMPTY_GRAPH: GraphData = { nodes: [], segments: [] };

// City ids double as kebab-case filenames in dev, so every name is slugged.
export function slugify(name: string) {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'untitled';
}

export interface CityStore {
	list(): Promise<CitySummary[]>;
	load(id: string): Promise<CityRecord | null>;
	save(city: CityRecord): Promise<void>;
	remove(id: string): Promise<void>;
	create(name: string, graph?: GraphData): Promise<CityRecord>;
	ensureCurrent(): Promise<CityRecord>;
	currentId(): string | null;
	setCurrentId(id: string): void;
}

abstract class BaseCityStore implements CityStore {
	abstract list(): Promise<CitySummary[]>;
	abstract load(id: string): Promise<CityRecord | null>;
	abstract save(city: CityRecord): Promise<void>;
	abstract remove(id: string): Promise<void>;

	currentId() {
		return localStorage.getItem(CURRENT_KEY);
	}

	setCurrentId(id: string) {
		localStorage.setItem(CURRENT_KEY, id);
	}

	async create(name: string, graph: GraphData = EMPTY_GRAPH) {
		const taken = new Set((await this.list()).map((c) => c.id));
		const base = slugify(name);
		let id = base;
		let n = 2;
		while (taken.has(id)) id = `${base}-${n++}`;
		const city: CityRecord = { id, name: id, graph, camera: null };
		await this.save(city);
		return city;
	}

	// The working city on boot: the current one, else a fresh city seeded from the
	// legacy single-graph slot (a one-time migration of pre-city saves).
	async ensureCurrent() {
		const id = this.currentId();
		if (id) {
			const current = await this.load(id);
			if (current) return current;
		}
		let graph = EMPTY_GRAPH;
		try {
			const legacy = localStorage.getItem(LEGACY_GRAPH_KEY);
			if (legacy) graph = JSON.parse(legacy) as GraphData;
		} catch {
			graph = EMPTY_GRAPH;
		}
		const city = await this.create('untitled', graph);
		this.setCurrentId(city.id);
		return city;
	}
}

// Production: cities live entirely in localStorage.
class LocalCityStore extends BaseCityStore {
	async list() {
		try {
			const raw = localStorage.getItem(INDEX_KEY);
			return raw ? (JSON.parse(raw) as CitySummary[]) : [];
		} catch {
			return [];
		}
	}

	async load(id: string) {
		try {
			const raw = localStorage.getItem(cityKey(id));
			return raw ? (JSON.parse(raw) as CityRecord) : null;
		} catch {
			return null;
		}
	}

	async save(city: CityRecord) {
		localStorage.setItem(cityKey(city.id), JSON.stringify(city));
		const index = await this.list();
		const at = index.findIndex((c) => c.id === city.id);
		if (at >= 0) index[at] = { id: city.id, name: city.name };
		else index.push({ id: city.id, name: city.name });
		localStorage.setItem(INDEX_KEY, JSON.stringify(index));
	}

	async remove(id: string) {
		localStorage.removeItem(cityKey(id));
		const index = (await this.list()).filter((c) => c.id !== id);
		localStorage.setItem(INDEX_KEY, JSON.stringify(index));
	}
}

// Dev: cities ARE the JSON files under static/fixtures, so they're shared with
// the e2e harness, the headless screenshots, and `?fixture=<name>`. Writes are
// debounced (and flushed on a switch) so a drag/pan doesn't hammer the disk.
class FileCityStore extends BaseCityStore {
	private pending: { id: string; body: string } | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;

	async list() {
		try {
			const response = await fetch('/api/fixtures');
			if (!response.ok) return [];
			const names: string[] = await response.json();
			return names.filter((name) => !name.startsWith('_')).map((name) => ({ id: name, name }));
		} catch {
			return [];
		}
	}

	async load(id: string) {
		try {
			const response = await fetch(`/fixtures/${id}.json`);
			if (!response.ok) return null;
			const data = await response.json();
			const graph: GraphData = data?.graph ?? data;
			const camera: CameraState | null = data?.camera ?? null;
			if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.segments)) return null;
			return { id, name: id, graph, camera };
		} catch {
			return null;
		}
	}

	async save(city: CityRecord) {
		// kebab-only filenames; protected (underscore) fixtures are never rewritten.
		if (!/^[a-z0-9][a-z0-9-]*$/.test(city.id)) return;
		const body = JSON.stringify({ graph: city.graph, camera: city.camera });
		if (this.pending && this.pending.id !== city.id) await this.flush();
		this.pending = { id: city.id, body };
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), 600);
	}

	private async flush() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const pending = this.pending;
		this.pending = null;
		if (!pending) return;
		try {
			await fetch(`/api/fixtures/${pending.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: pending.body
			});
		} catch {
			// best-effort; the next save retries
		}
	}

	async remove(id: string) {
		if (this.pending?.id === id) this.pending = null;
		try {
			await fetch(`/api/fixtures/${id}`, { method: 'DELETE' });
		} catch {
			// best-effort
		}
	}
}

export function createCityStore(): CityStore {
	return dev ? new FileCityStore() : new LocalCityStore();
}

// Load a static fixture file directly, independent of the active backend. Used by
// the ?fixture= deep-link so it works in the production preview (e2e) too.
export async function loadStaticCity(id: string): Promise<CityRecord | null> {
	try {
		const response = await fetch(`/fixtures/${id}.json`);
		if (!response.ok) return null;
		const data = await response.json();
		const graph: GraphData = data?.graph ?? data;
		const camera: CameraState | null = data?.camera ?? null;
		if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.segments)) return null;
		return { id, name: id, graph, camera };
	} catch {
		return null;
	}
}
