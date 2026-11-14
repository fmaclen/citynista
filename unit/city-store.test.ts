import { beforeEach, expect, test } from 'bun:test';
import { CityStore } from '../src/lib/core/city-store';
import type { CityRecord, GraphData } from '../src/lib/core/types';

// localStorage as a map whose setItem throws, as a full quota does, for the
// keys in `refused`, and records every key it does write.
class FakeStorage {
	data = new Map<string, string>();
	refused = new Set<string>();
	refuseAll = false;
	written: string[] = [];
	getItem(key: string) {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		if (this.refuseAll || this.refused.has(key)) throw new Error('QuotaExceededError');
		this.data.set(key, value);
		this.written.push(key);
	}
	removeItem(key: string) {
		this.data.delete(key);
	}
}

const INDEX = 'citynista:cities';
const ROAD: GraphData = {
	nodes: [
		{ id: 'a', x: 0, y: 0 },
		{ id: 'b', x: 10, y: 0 }
	],
	segments: [{ id: 's', startNodeId: 'a', endNodeId: 'b', lanes: [] }]
};

let storage: FakeStorage;
let store: CityStore;
let home: CityRecord;

beforeEach(() => {
	storage = new FakeStorage();
	Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
	store = new CityStore();
	home = store.create('home')!;
	storage.written = [];
});

const snapshot = () => new Map(storage.data);

test('a refused record write leaves the record and index as they were', () => {
	const before = snapshot();
	storage.refused.add('citynista:city:home');
	expect(store.save({ ...home, graph: ROAD })).toBe(false);
	expect(storage.data).toEqual(before);
});

test('a refused index write for a new city removes its record', () => {
	const before = snapshot();
	storage.refused.add(INDEX);
	expect(store.create('fresh')).toBeNull();
	expect(storage.data).toEqual(before);
});

test('a refused index write during a rename puts the old record back', () => {
	store.save({ ...home, graph: ROAD });
	const before = snapshot();
	storage.refused.add(INDEX);
	expect(store.rename('home', 'Downtown')).toBe(false);
	expect(storage.data).toEqual(before);
	expect(store.load('home')).toEqual({ ...home, graph: ROAD });
});

test('create takes the first id no city uses', () => {
	expect(store.create('home')!.id).toBe('home-2');
	expect(store.create('Home')!.id).toBe('home-3');
	expect(store.list().map((c) => c.id)).toEqual(['home', 'home-2', 'home-3']);
});

test("a first city storage refuses on boot never takes an existing city's id", () => {
	store.create('untitled');
	const before = snapshot();
	storage.refuseAll = true;
	const { city, stored } = store.ensureCurrent();
	expect(stored).toBe(false);
	expect(city.id).toBe('untitled-2');
	expect(storage.data).toEqual(before);
});

test('saving a city under its listed name writes its record only', () => {
	expect(store.save({ ...home, graph: ROAD })).toBe(true);
	expect(storage.written).toEqual(['citynista:city:home']);
	expect(store.load('home')!.graph).toEqual(ROAD);
});
