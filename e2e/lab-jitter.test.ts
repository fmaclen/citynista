import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { check } from '../src/lib/lab/checks';
import { blockedTarget, dragEnd, dragFrom, dragStart, majorEnds } from '../src/lib/lab/edit';
import { samplePath } from '../src/lib/lab/geometry';
import { MERGE_GAP, SPLIT_GAP } from '../src/lib/lab/merge';
import type { End, Place } from '../src/lib/lab/model';
import { PLACES } from '../src/lib/lab/places';
import { SCENES } from '../src/lib/lab/scenes';
import { Scene } from '../src/lib/lab/scene';

// Robustness for /lab. Every road end in every place is dragged 0.25 to 5 m
// in eight directions through the same drag the page uses, and every stretch
// boundary is dragged both ways. Each result has to pass the geometry rules,
// and a drag that gets less than half way to a target that isn't out of
// bounds (inside its junction, or across another road or an island) is a
// frozen drag, which fails too. Dragging a minor road's end (a driveway, a
// side street) must never move the through road it joins, except along its
// own line. A clamp may shorten a drag but never turn it: the end never
// moves more than 90 degrees off the pointer's direction. Free road ends
// are dragged the same way. Out-and-back drags, in one gesture or two, must
// leave every road end where it was. Failures save a minimal repro under
// test-results/lab-jitter.

const DISTANCES = [0.25, 0.5, 1, 2, 5];
const DIRECTIONS = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
const REPRO = 'test-results/lab-jitter';

type Move = { road: string; end: End; dx: number; dy: number };

const endPoint = (place: Place, road: string, end: End) => {
	const r = place.roads.find((x) => x.id === road)!;
	const p = end === 'start' ? r.points[0] : r.points[r.points.length - 1];
	return { x: p.x, y: p.y };
};

// Through-road ends that a drag on a minor road's end moved off their own
// line, or whose road moved anywhere else.
function bentStreet(before: Place, after: Place, m: Move) {
	const major = majorEnds(before, m.road, m.end);
	if (major.has(`${m.road}:${m.end}`)) return [];
	const bent: string[] = [];
	for (const key of major) {
		const [road, end] = key.split(':') as [string, End];
		const r0 = before.roads.find((r) => r.id === road)!;
		const r1 = after.roads.find((r) => r.id === road)!;
		const pts = samplePath(r0).pts;
		const p0 = endPoint(before, road, end);
		const p1 = endPoint(after, road, end);
		const q = end === 'start' ? pts[1] : pts[pts.length - 2];
		const l = Math.hypot(q.x - p0.x, q.y - p0.y) || 1;
		const side = Math.abs(((p1.x - p0.x) * (q.y - p0.y) - (p1.y - p0.y) * (q.x - p0.x)) / l);
		const i = end === 'start' ? 0 : r0.points.length - 1;
		const rest = r0.points.some(
			(p, k) => k !== i && (p.x !== r1.points[k].x || p.y !== r1.points[k].y)
		);
		if (side > 0.02 || rest) bent.push(`${key} moved ${side.toFixed(2)} m sideways`);
	}
	return bent;
}

// Drags an end; returns the fraction of the requested distance it got.
// Drags an end; returns the fraction of the requested distance it got. A
// move off at more than a right angle from the pointer throws.
function apply(place: Place, m: Move) {
	const from = endPoint(place, m.road, m.end);
	const got = dragEnd(place, m.road, m.end, { x: from.x + m.dx, y: from.y + m.dy });
	const gx = got.x - from.x;
	const gy = got.y - from.y;
	if (Math.hypot(gx, gy) > 1e-3 && gx * m.dx + gy * m.dy < 0)
		throw new Error(
			`moved (${gx.toFixed(2)}, ${gy.toFixed(2)}) for a drag of (${m.dx.toFixed(2)}, ${m.dy.toFixed(2)})`
		);
	return Math.hypot(gx, gy) / Math.hypot(m.dx, m.dy);
}

// Every road end's position, by key.
const allEnds = (place: Place) =>
	Object.fromEntries(
		place.roads.flatMap((r) => [
			[`${r.id}:start`, { x: r.points[0].x, y: r.points[0].y }],
			[`${r.id}:end`, { x: r.points[r.points.length - 1].x, y: r.points[r.points.length - 1].y }]
		])
	);

// Road ends more than 1 cm from where they were.
function shifted(before: ReturnType<typeof allEnds>, after: ReturnType<typeof allEnds>) {
	return Object.keys(before)
		.map((k) => ({ k, d: Math.hypot(after[k].x - before[k].x, after[k].y - before[k].y) }))
		.filter(({ d }) => d > 0.01)
		.map(({ k, d }) => `${k} ${d.toFixed(2)} m`);
}

// A pointer drag in frames, each worked out from the drag's start as the
// page does: out to the target and, when `back`, back to the start.
function gesture(place: Place, m: Move, back: boolean, frames = 4) {
	const from = endPoint(place, m.road, m.end);
	const start = dragStart(place);
	const path = Array.from({ length: frames }, (_, i) => (i + 1) / frames);
	if (back) path.push(...path.slice(0, -1).reverse(), 0);
	let got = from;
	for (const f of path)
		got = dragFrom(place, start, m.road, m.end, { x: from.x + m.dx * f, y: from.y + m.dy * f });
	return got;
}

const freeEnds = (place: Place) => {
	const tied = new Set(place.junctions.flatMap((j) => j.ends.map((e) => `${e.road}:${e.end}`)));
	return place.roads
		.flatMap((r) => (['start', 'end'] as const).map((end) => ({ road: r.id, end })))
		.filter((e) => !tied.has(`${e.road}:${e.end}`));
};

function save(name: string, data: unknown) {
	mkdirSync(REPRO, { recursive: true });
	writeFileSync(`${REPRO}/${name}.json`, JSON.stringify(data, null, 1));
}

const endsInJunctions = (place: Place) =>
	place.junctions.flatMap((j) => j.ends.map((e) => ({ road: e.road, end: e.end })));

for (const make of PLACES) {
	const id = make().id;
	test(`${id}: clean at rest`, () => {
		expect(check(new Scene(make()))).toEqual([]);
	});

	test(`${id}: every road end jittered stays clean and moves`, () => {
		test.setTimeout(900_000);
		const broken: string[] = [];
		const frozen: string[] = [];
		let cases = 0;
		let blocked = 0;
		for (const e of endsInJunctions(make())) {
			for (const d of DISTANCES) {
				for (const a of DIRECTIONS) {
					const move: Move = { ...e, dx: Math.cos(a) * d, dy: Math.sin(a) * d };
					const name = `${id}-${e.road}-${e.end}-${d}-${Math.round((a * 180) / Math.PI)}`;
					const place = make();
					const from = endPoint(place, e.road, e.end);
					const why = blockedTarget(make(), e.road, e.end, {
						x: from.x + move.dx,
						y: from.y + move.dy
					});
					const before = structuredClone(place);
					let share = 0;
					try {
						share = apply(place, move);
					} catch (err) {
						save(`${name}-turned`, { place: id, moves: [move], turned: String(err) });
						broken.push(`${name}: ${err}`);
					}
					cases++;
					for (const b of bentStreet(before, place, move)) {
						save(`${name}-bent`, { place: id, moves: [move], bent: b });
						broken.push(`${name}: ${b}`);
					}
					if (why) blocked++;
					if (share < 0.5 && !why) {
						save(name, { place: id, moves: [move], frozen: share });
						frozen.push(`${name}: moved ${(share * 100).toFixed(0)}%`);
					}
					const problems = check(new Scene(place));
					if (problems.length) {
						save(name, { place: id, moves: [move], problems });
						broken.push(`${name}: ${problems[0]}`);
					}
				}
			}
		}
		console.log(
			`${id}: ${cases} jitter cases, ${blocked} with an out-of-bounds target, ${frozen.length} frozen, ${broken.length} broken`
		);
		for (const f of frozen) console.log(`  frozen ${f}`);
		expect(broken).toEqual([]);
		expect(frozen).toEqual([]);
	});

	test(`${id}: free road ends dragged stay clean and move the right way`, () => {
		test.setTimeout(900_000);
		const failures: string[] = [];
		for (const e of freeEnds(make())) {
			for (const d of [1, 5]) {
				for (const a of DIRECTIONS) {
					const move: Move = { ...e, dx: Math.cos(a) * d, dy: Math.sin(a) * d };
					const name = `${id}-free-${e.road}-${e.end}-${d}-${Math.round((a * 180) / Math.PI)}`;
					const place = make();
					const from = endPoint(place, e.road, e.end);
					const why = blockedTarget(make(), e.road, e.end, {
						x: from.x + move.dx,
						y: from.y + move.dy
					});
					try {
						const share = apply(place, move);
						if (share < 0.5 && !why) failures.push(`${name}: moved ${(share * 100).toFixed(0)}%`);
					} catch (err) {
						failures.push(`${name}: ${err}`);
					}
					const problems = check(new Scene(place));
					if (problems.length) failures.push(`${name}: ${problems[0]}`);
					if (failures.length) save(name, { place: id, moves: [move], failures });
				}
			}
		}
		console.log(`${id}: free ends, ${failures.length} broken`);
		expect(failures).toEqual([]);
	});

	test(`${id}: out-and-back drags leave every end where it was`, () => {
		test.setTimeout(900_000);
		const failures: string[] = [];
		for (const e of endsInJunctions(make())) {
			for (let k = 0; k < 4; k++) {
				const a = (k * Math.PI) / 2;
				const move: Move = { ...e, dx: Math.cos(a) * 3, dy: Math.sin(a) * 3 };
				const name = `${id}-outback-${e.road}-${e.end}-${k * 90}`;
				// One gesture: out and back without letting go.
				const one = make();
				const before = allEnds(one);
				gesture(one, move, true);
				for (const s of shifted(before, allEnds(one))) failures.push(`${name} one gesture: ${s}`);
				// Two gestures: out, let go, then back to where it started.
				const two = make();
				const from = endPoint(two, e.road, e.end);
				const got = gesture(two, move, false);
				gesture(two, { ...e, dx: from.x - got.x, dy: from.y - got.y }, false);
				for (const s of shifted(before, allEnds(two))) failures.push(`${name} two gestures: ${s}`);
			}
		}
		if (failures.length) save(`${id}-outback`, { place: id, failures });
		console.log(`${id}: out-and-back, ${failures.length} broken`);
		expect(failures).toEqual([]);
	});

	test(`${id}: stretch boundaries dragged both ways stay clean`, () => {
		const failures: string[] = [];
		let cases = 0;
		for (const road of make().roads) {
			road.stretches.forEach((_, index) => {
				if (index === 0) return;
				for (const shift of [-8, -3, -1, 1, 3, 8]) {
					const place = make();
					const r = place.roads.find((x) => x.id === road.id)!;
					const length = samplePath(r).length;
					const prev = r.stretches[index - 1];
					const next = r.stretches[index + 1];
					// The page keeps a boundary between its neighbours.
					const lo = prev.at + 0.5;
					const hi = next ? next.at - 0.5 : length - 0.5;
					const want = r.stretches[index].at + shift;
					r.stretches[index].at = Math.max(lo, Math.min(hi, want));
					cases++;
					const problems = check(new Scene(place));
					if (problems.length) {
						const name = `${id}-stretch-${road.id}-${index}-${shift}`;
						save(name, {
							place: id,
							stretch: { road: road.id, index, at: r.stretches[index].at },
							problems
						});
						failures.push(`${name}: ${problems[0]}`);
					}
				}
			});
		}
		console.log(`${id}: ${cases} stretch drags, ${failures.length} broken`);
		expect(failures).toEqual([]);
	});

	test(`${id}: seeded random drags stay clean`, () => {
		test.setTimeout(900_000);
		let seed = id.length * 7919;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const failures: string[] = [];
		for (let run = 0; run < 3; run++) {
			const place = make();
			const ends = endsInJunctions(place);
			const moves: Move[] = [];
			for (let step = 0; step < 8; step++) {
				const e = ends[Math.floor(rand() * ends.length)];
				const a = rand() * Math.PI * 2;
				const d = 0.5 + rand() * 9.5;
				const move: Move = { ...e, dx: Math.cos(a) * d, dy: Math.sin(a) * d };
				moves.push(move);
				const before = structuredClone(place);
				try {
					apply(place, move);
				} catch (err) {
					save(`${id}-random-${run}-${step}`, { place: id, moves, turned: String(err) });
					failures.push(`${id} run ${run} step ${step}: ${err}`);
					break;
				}
				const problems = [...bentStreet(before, place, move), ...check(new Scene(place))];
				if (problems.length) {
					save(`${id}-random-${run}-${step}`, { place: id, moves, problems });
					failures.push(`${id} run ${run} step ${step}: ${problems[0]}`);
					break;
				}
			}
		}
		expect(failures).toEqual([]);
	});
}

for (const scene of SCENES) {
	test(`scene ${scene.id} is clean`, () => {
		const make = PLACES.find((f) => f().id === scene.place)!;
		expect(check(new Scene(make()))).toEqual([]);
	});
}

test('close junctions merge when nudged together and split when pulled apart', () => {
	const make = PLACES.find((f) => f().id === 'close')!;
	const place = make();
	const link = place.roads.find((r) => r.id === 'b')!;
	const failures: string[] = [];
	const log: string[] = [];
	const length = () => link.points[1].x - link.points[0].x;
	// In: shorten the link a little; out: drag its end 0.5 m at a time until
	// it is well past the split distance.
	const steps = [...Array(4).fill(-0.25), ...Array(Math.ceil((SPLIT_GAP + 4) / 0.5)).fill(0.5)];
	let merged = false;
	for (const dx of steps) {
		apply(place, { road: 'b', end: 'end', dx, dy: 0 });
		const scene = new Scene(place);
		scene.build();
		const problems = check(scene);
		merged = scene.effective.length === 1;
		log.push(`${length().toFixed(2)}${merged ? 'M' : ''}`);
		if (length() < MERGE_GAP && !merged) failures.push(`link ${length().toFixed(2)} m: not merged`);
		if (length() > SPLIT_GAP + 0.5 && merged)
			failures.push(`link ${length().toFixed(2)} m: still merged`);
		if (problems.length) failures.push(`link ${length().toFixed(2)} m: ${problems[0]}`);
	}
	console.log(`close merge: ${log.join(' ')}`);
	if (failures.length) save('close-merge', { place: 'close', log, failures });
	expect(length()).toBeGreaterThan(SPLIT_GAP + 2);
	expect(merged).toBe(false);
	expect(failures).toEqual([]);
});
