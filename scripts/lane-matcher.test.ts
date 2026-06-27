import { describe, expect, test } from 'bun:test';
import {
	matchTransitionArm,
	type MatcherArm,
	type MatcherResult
} from '../src/lib/core/lane-matcher';
import { getTotalWidth } from '../src/lib/core/lane-template';
import { getLaneIntervals } from '../src/lib/core/road-geometry';
import type { Lane, LaneMaterial } from '../src/lib/core/types';

const ped = (width = 3): Lane => ({
	role: 'pedestrian',
	material: 'pavement',
	width,
	direction: 'bidirectional'
});

const verge = (width = 1, material: LaneMaterial = 'grass'): Lane => ({
	role: 'buffer',
	material,
	width,
	direction: 'bidirectional'
});

const median = (width = 2, material: LaneMaterial = 'grass'): Lane => ({
	role: 'buffer',
	material,
	width,
	direction: 'bidirectional'
});

const fwd = (width = 3.5, material: LaneMaterial = 'asphalt'): Lane => ({
	role: 'vehicle',
	material,
	width,
	direction: 'forward'
});

const back = (width = 3.5, material: LaneMaterial = 'asphalt'): Lane => ({
	role: 'vehicle',
	material,
	width,
	direction: 'backward'
});

const sidewalks = (lanes: Lane[]) => [ped(), ...lanes, ped()];

const street = () => [ped(2), back(3), fwd(3), ped(2)];

const avenueGrass = () => sidewalks([verge(), back(), back(), median(), fwd(), fwd(), verge()]);

const twoway = (backCount: number, fwdCount: number, divider: Lane | null = median()) =>
	sidewalks([
		...Array.from({ length: backCount }, () => back()),
		...(divider ? [divider] : []),
		...Array.from({ length: fwdCount }, () => fwd())
	]);

const oneway = (count: number) => sidewalks(Array.from({ length: count }, () => fwd()));

const mirror = (lanes: Lane[]) =>
	[...lanes].reverse().map((lane) => ({
		...lane,
		direction:
			lane.direction === 'forward'
				? 'backward'
				: lane.direction === 'backward'
					? 'forward'
					: lane.direction
	}));

const arm = (segmentId: string, lanes: Lane[], startsHere = false): MatcherArm => ({
	segmentId,
	lanes,
	startsHere
});

const closeTo = (actual: number | null, expected: number) => {
	expect(actual).not.toBeNull();
	expect(actual!).toBeCloseTo(expected, 6);
};

const bounds = (lanes: Lane[]) => {
	const offsets = [-getTotalWidth(lanes) / 2];
	for (const lane of lanes) offsets.push(offsets[offsets.length - 1] + lane.width);
	return offsets;
};

const expectIntervalIdentity = (result: MatcherResult, lanes: Lane[]) => {
	const intervals = getLaneIntervals(lanes);
	expect(result.targets).toHaveLength(intervals.length);
	for (let i = 0; i < intervals.length; i++) {
		expect(result.targets[i].start).toBeCloseTo(intervals[i].start, 6);
		expect(result.targets[i].end).toBeCloseTo(intervals[i].end, 6);
	}
};

const expectBoundaryIdentity = (result: MatcherResult, lanes: Lane[]) => {
	const offsets = bounds(lanes);
	expect(result.laneBoundaries).toHaveLength(lanes.length - 1);
	for (let i = 0; i < result.laneBoundaries.length; i++) {
		closeTo(result.laneBoundaries[i], offsets[i + 1]);
	}
};

const expectMonotoneTargets = (result: MatcherResult) => {
	let previous = -Infinity;
	for (const target of result.targets) {
		expect(Number.isNaN(target.start)).toBe(false);
		expect(Number.isNaN(target.end)).toBe(false);
		expect(target.start).toBeLessThanOrEqual(target.end);
		expect(target.start + 1e-6).toBeGreaterThanOrEqual(previous);
		previous = target.end;
	}
};

const expectMatcherInvariants = (result: MatcherResult) => {
	let previousTargetIndex = -Infinity;
	for (const disposition of result.dispositions) {
		if (disposition.kind !== 'continue') continue;
		expect(Number.isNaN(disposition.targetIntervalIndex)).toBe(false);
		expect(disposition.targetIntervalIndex).toBeGreaterThanOrEqual(previousTargetIndex);
		previousTargetIndex = disposition.targetIntervalIndex;
	}

	for (const boundary of result.laneBoundaries) {
		if (boundary !== null) expect(Number.isNaN(boundary)).toBe(false);
	}
	for (const underfill of result.roadwayUnderfills) {
		if (!underfill) continue;
		expect(Number.isNaN(underfill.node.start)).toBe(false);
		expect(Number.isNaN(underfill.node.end)).toBe(false);
	}
};

const runCase = (
	name: string,
	self: Lane[],
	other: Lane[],
	check: (result: MatcherResult) => void,
	flippedOther = other
) => {
	describe(name, () => {
		test('normal orientation', () => {
			const result = matchTransitionArm(arm('self', self, false), arm('other', other, true));
			expectMatcherInvariants(result);
			check(result);
		});

		test('flipped orientation', () => {
			const result = matchTransitionArm(
				arm('self', self, false),
				arm('other', flippedOther, false)
			);
			expectMatcherInvariants(result);
			check(result);
		});
	});
};

describe('lane matcher', () => {
	runCase('same-section street', street(), street(), (result) => {
		expect(result.anchor).toBe(true);
		expect(result.dispositions.every((disposition) => disposition.kind === 'continue')).toBe(true);
		expectIntervalIdentity(result, street());
		expectBoundaryIdentity(result, street());
	});

	runCase('same-section avenue+grass', avenueGrass(), avenueGrass(), (result) => {
		expect(result.anchor).toBe(true);
		expect(result.dispositions.every((disposition) => disposition.kind === 'continue')).toBe(true);
		expectIntervalIdentity(result, avenueGrass());
		expectBoundaryIdentity(result, avenueGrass());
	});

	runCase('born-outside twoway 2x2 to 2x3', twoway(2, 3), twoway(2, 2), (result) => {
		const anchorBounds = bounds(twoway(2, 2));
		expect(result.anchor).toBe(false);
		expectMonotoneTargets(result);
		closeTo(result.laneBoundaries[4], anchorBounds[5]);
		expect(result.laneBoundaries[5]).toBeNull();
	});

	runCase(
		'born-median twoway turn pocket',
		sidewalks([back(), back(), fwd(), fwd(), fwd()]),
		twoway(2, 2),
		(result) => {
			const anchorBounds = bounds(twoway(2, 2));
			expect(result.anchor).toBe(false);
			expectMonotoneTargets(result);
			expect(result.laneBoundaries[3]).toBeNull();
			closeTo(result.laneBoundaries[4], anchorBounds[5]);
		}
	);

	runCase(
		'dropped-outside twoway 3x2 to 2x2',
		sidewalks([back(), back(), back(), median(), fwd(), fwd()]),
		twoway(2, 2),
		(result) => {
			const anchorBounds = bounds(twoway(2, 2));
			expect(result.anchor).toBe(false);
			expectMonotoneTargets(result);
			expect(result.laneBoundaries[1]).toBeNull();
			closeTo(result.laneBoundaries[2], anchorBounds[2]);
		}
	);

	runCase(
		'dropped-median twoway 3x2 to 2x2',
		sidewalks([back(), back(), back(), fwd(), fwd()]),
		twoway(2, 2),
		(result) => {
			const anchorBounds = bounds(twoway(2, 2));
			expect(result.anchor).toBe(false);
			expectMonotoneTargets(result);
			expect(result.laneBoundaries[3]).toBeNull();
			closeTo(result.laneBoundaries[1], anchorBounds[2]);
		}
	);

	runCase('center-vanishes', twoway(2, 2), twoway(2, 2, null), (result) => {
		expect(result.anchor).toBe(false);
		expectMonotoneTargets(result);
		const medianStrip = result.dispositions.find((disposition) => disposition.kind === 'terminate');
		expect(medianStrip).toBeDefined();
		const anchorCenter = bounds(twoway(2, 2, null))[3];
		closeTo(result.laneBoundaries[2], anchorCenter);
		closeTo(result.laneBoundaries[3], anchorCenter);
	});

	runCase('center-vanishes anchor side', twoway(2, 2, null), twoway(2, 2), (result) => {
		// The undivided side anchors; its painted centre has the other side's
		// nosing median as its counterpart, so the centre boundary is kept (the
		// double yellow rides to the seam) instead of cut to null.
		expect(result.anchor).toBe(true);
		closeTo(result.laneBoundaries[2], 0);
	});

	runCase(
		'same-direction buffer drop',
		sidewalks([back(), fwd(), verge(1, 'dirt'), fwd()]),
		sidewalks([back(), fwd(), fwd()]),
		(result) => {
			const anchorBounds = bounds(sidewalks([back(), fwd(), fwd()]));
			expect(result.anchor).toBe(false);
			expectMonotoneTargets(result);
			expect(result.dispositions[2].kind).toBe('terminate');
			expect(result.dispositions[3].kind).toBe('continue');
			closeTo(result.laneBoundaries[2], anchorBounds[3]);
			closeTo(result.laneBoundaries[3], anchorBounds[3]);
		},
		mirror(sidewalks([back(), fwd(), fwd()]))
	);

	runCase(
		'same-direction buffer drop anchor side',
		sidewalks([back(), fwd(), fwd()]),
		sidewalks([back(), fwd(), verge(1, 'dirt'), fwd()]),
		(result) => {
			const selfBounds = bounds(sidewalks([back(), fwd(), fwd()]));
			expect(result.anchor).toBe(true);
			closeTo(result.laneBoundaries[2], selfBounds[3]);
		},
		mirror(sidewalks([back(), fwd(), verge(1, 'dirt'), fwd()]))
	);

	runCase('symmetric-widen street to avenue', avenueGrass(), street(), (result) => {
		expect(result.anchor).toBe(false);
		expectMonotoneTargets(result);
	});

	runCase(
		'oneway-count oneway2 to oneway4',
		oneway(4),
		oneway(2),
		(result) => {
			const anchorBounds = bounds(oneway(2));
			expect(result.anchor).toBe(false);
			expectMonotoneTargets(result);
			expect(result.laneBoundaries[1]).toBeNull();
			closeTo(result.laneBoundaries[2], anchorBounds[2]);
			expect(result.laneBoundaries[3]).toBeNull();
		},
		mirror(oneway(2))
	);

	runCase(
		'shouldered roadway count drop fills vacated lane',
		[verge(3.5, 'dirt'), fwd(), fwd(), fwd(), fwd(), verge(3.5, 'dirt')],
		[verge(3.5, 'dirt'), fwd(), fwd(), fwd(), verge(3.5, 'dirt')],
		(result) => {
			const intervals = getLaneIntervals([
				verge(3.5, 'dirt'),
				fwd(),
				fwd(),
				fwd(),
				fwd(),
				verge(3.5, 'dirt')
			]);
			const roadwayIndex = intervals.findIndex(
				(interval) => interval.laneType === 'roadway:asphalt'
			);
			expect(result.anchor).toBe(false);
			expectMonotoneTargets(result);
			expect(result.targets[roadwayIndex].start).toBeCloseTo(-5.25, 6);
			expect(result.targets[roadwayIndex].end).toBeCloseTo(5.25, 6);
			expect(result.roadwayUnderfills[roadwayIndex]?.laneType).toBe('roadway:asphalt');
			expect(result.roadwayUnderfills[roadwayIndex]?.node.start).toBeCloseTo(-7, 6);
			expect(result.roadwayUnderfills[roadwayIndex]?.node.end).toBeCloseTo(7, 6);
		},
		mirror([verge(3.5, 'dirt'), fwd(), fwd(), fwd(), verge(3.5, 'dirt')])
	);
});
