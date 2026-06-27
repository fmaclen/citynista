import { describe, expect, test } from 'bun:test';
import { classifyCrossSection, marksByBoundary, type LaneMark } from '../src/lib/core/lane-markings';
import type { Lane, LaneMaterial } from '../src/lib/core/types';

const ped = (w = 3): Lane => ({ role: 'pedestrian', material: 'pavement', width: w, direction: 'bidirectional' });
const buf = (material: LaneMaterial = 'grass', w = 2): Lane => ({ role: 'buffer', material, width: w, direction: 'bidirectional' });
const f = (material: LaneMaterial = 'asphalt'): Lane => ({ role: 'vehicle', material, width: 3.5, direction: 'forward' });
const b = (material: LaneMaterial = 'asphalt'): Lane => ({ role: 'vehicle', material, width: 3.5, direction: 'backward' });

const at = (marks: LaneMark[], boundaryIndex: number) =>
	marks.filter((m) => m.boundaryIndex === boundaryIndex);
const colors = (marks: LaneMark[], i: number) => at(marks, i).map((m) => `${m.color}${m.dashed ? '-dash' : ''}`).sort();

describe('lane-markings classifier', () => {
	test('undivided two-way → white shoulders, double yellow centre, dashed interiors', () => {
		const m = classifyCrossSection([ped(), b(), b(), f(), f(), ped()]); // boundaries 0..6
		expect(colors(m, 1)).toEqual(['white']); // ped|b — back outer edge
		expect(colors(m, 2)).toEqual(['white-dash']); // b|b interior
		expect(colors(m, 3)).toEqual(['yellow', 'yellow']); // b|f — both inner edges = double yellow
		expect(colors(m, 4)).toEqual(['white-dash']); // f|f interior
		expect(colors(m, 5)).toEqual(['white']); // f|ped — fwd outer edge
		expect(at(m, 0)).toEqual([]); // road edge / ped — no mark
		expect(at(m, 6)).toEqual([]);
		// the two centre yellows carry opposite inset sides
		expect(at(m, 3).map((x) => x.side).sort()).toEqual([-1, 1]);
	});

	test('grass-median divided → single yellow on each side of the median', () => {
		const m = classifyCrossSection([ped(), b(), b(), buf('grass'), f(), f(), ped()]); // boundaries 0..7
		expect(colors(m, 1)).toEqual(['white']); // back outer
		expect(colors(m, 3)).toEqual(['yellow']); // b|median — back inner (single)
		expect(colors(m, 4)).toEqual(['yellow']); // median|f — fwd inner (single)
		expect(colors(m, 6)).toEqual(['white']); // fwd outer
		expect(colors(m, 2)).toEqual(['white-dash']);
		expect(colors(m, 5)).toEqual(['white-dash']);
	});

	test('centre buffer same material as road (#1 N–S) → yellow on each edge of the buffer', () => {
		const m = classifyCrossSection([ped(), b(), b(), buf('asphalt'), f(), f(), ped()]);
		expect(colors(m, 3)).toEqual(['yellow']); // invisible buffer now bounded by yellow
		expect(colors(m, 4)).toEqual(['yellow']);
	});

	test('dirt shoulders, no sidewalk (#3) → solid white outer edge against the shoulder', () => {
		const m = classifyCrossSection([buf('dirt'), b(), b(), f(), f(), buf('dirt')]); // boundaries 0..6
		expect(colors(m, 1)).toEqual(['white']); // shoulder|b — outer white
		expect(colors(m, 3)).toEqual(['yellow', 'yellow']); // double yellow centre
		expect(colors(m, 5)).toEqual(['white']); // f|shoulder — outer white
	});

	test('one-way → white edges, no yellow', () => {
		const m = classifyCrossSection([ped(), f(), f(), ped()]); // boundaries 0..4
		expect(colors(m, 1)).toEqual(['white']);
		expect(colors(m, 2)).toEqual(['white-dash']);
		expect(colors(m, 3)).toEqual(['white']);
		expect(m.every((x) => x.color === 'white')).toBe(true);
	});

	test('marksByBoundary groups the double-yellow boundary', () => {
		const map = marksByBoundary([ped(), b(), f(), ped()]); // street: boundary 2 = b|f double yellow
		expect(map.get(2)?.length).toBe(2);
		expect(map.get(2)?.every((x) => x.color === 'yellow')).toBe(true);
	});
});
