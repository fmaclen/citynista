import type { CameraState, CityRecord, CitySummary, GraphData } from './types';

// The shape of saved cities and examples. Bump it whenever the saved graph's
// shape changes: anything written with another version is ignored, never
// migrated, so a library from an older build starts clean.
export const SCHEMA_VERSION = 3;

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
// their scripts under scripts/. Opening one never writes; saving it asks for a
// name and stores it as a city of your own.
export const EXAMPLES: CitySummary[] = [{ id: 'neighbourhood', name: 'Neighbourhood' }];

function slugify(name: string) {
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

	// True only when the city and its index entry are both stored. The index is
	// written only when the entry is new or renamed; if that write fails a new
	// city's record is removed, and a renamed one's is put back as it was.
	// Putting it back can itself be refused: the record then carries the name
	// the menu doesn't show until the city is next saved under its listed name.
	save(city: CityRecord) {
		const stored: StoredCity = { ...city, version: SCHEMA_VERSION };
		const key = cityKey(city.id);
		const index = this.list();
		const at = index.findIndex((c) => c.id === city.id);
		const indexed = at >= 0 && index[at].name === city.name;
		const before = indexed ? null : localStorage.getItem(key);
		try {
			localStorage.setItem(key, JSON.stringify(stored));
		} catch {
			// Quota exceeded: nothing was written.
			return false;
		}
		if (indexed) return true;
		if (at >= 0) index[at] = { id: city.id, name: city.name };
		else index.push({ id: city.id, name: city.name });
		if (this.writeIndex(index)) return true;
		if (before === null) this.removeKeys(city.id);
		else {
			try {
				localStorage.setItem(key, before);
			} catch {
				// best-effort: the old record no longer fits
			}
		}
		return false;
	}

	private writeIndex(index: CitySummary[]) {
		const stored: StoredSummary[] = index.map(({ id, name }) => ({
			id,
			name,
			version: SCHEMA_VERSION
		}));
		try {
			localStorage.setItem(INDEX_KEY, JSON.stringify(stored));
			return true;
		} catch {
			return false;
		}
	}

	private removeKeys(id: string) {
		localStorage.removeItem(cityKey(id));
		localStorage.removeItem(cameraKey(id));
	}

	// A rename touches only the name; the stored map stays as last saved.
	rename(id: string, name: string) {
		const city = this.load(id);
		return city ? this.save({ ...city, name }) : false;
	}

	remove(id: string) {
		this.removeKeys(id);
		this.writeIndex(this.list().filter((c) => c.id !== id));
	}

	currentId() {
		return localStorage.getItem(CURRENT_KEY);
	}

	setCurrentId(id: string) {
		try {
			localStorage.setItem(CURRENT_KEY, id);
		} catch {
			// best-effort: a reload then opens another city
		}
	}

	// The first id from the name that no city in the index uses.
	private freeId(name: string) {
		const taken = new Set(this.list().map((c) => c.id));
		const base = slugify(name);
		let id = base;
		let n = 2;
		while (taken.has(id)) id = `${base}-${n++}`;
		return id;
	}

	create(name: string, graph: GraphData = EMPTY_GRAPH, camera: CameraState | null = null) {
		const id = this.freeId(name);
		const city: CityRecord = { id, name: id, graph, camera };
		return this.save(city) ? city : null;
	}

	// The working city on boot: the current one, else a fresh empty city.
	// `stored` is false when storage refused that fresh city: it is worked on
	// unstored, under an id no other city has, until a save succeeds.
	ensureCurrent() {
		this.prune();
		const id = this.currentId();
		if (id) {
			const current = this.load(id);
			if (current) return { city: current, stored: true };
		}
		const created = this.create('untitled');
		const free = this.freeId('untitled');
		const city = created ?? { id: free, name: free, graph: EMPTY_GRAPH, camera: null };
		this.setCurrentId(city.id);
		return { city, stored: !!created };
	}
}

function getExample(id: string) {
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
