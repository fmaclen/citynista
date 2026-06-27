import type { Interval, StripDisposition } from './node-resolution';
import { getTotalWidth } from './lane-template';
import {
	isIslandLike,
	isRoadway,
	laneLayer,
	lanesStructureKey,
	surfaceClassOf,
	type LaneLayerId,
	type RoadLayerId,
	type SurfaceClass
} from './lane-types';
import { getLaneIntervals } from './road-geometry';
import type { Lane, LaneDirection, LaneMaterial, LaneRole } from './types';

export interface MatcherArm {
	segmentId: string;
	lanes: Lane[];
	startsHere: boolean;
	laneMovements?: ('through' | 'turn' | 'none')[];
	alignmentOffset?: number;
}

export interface MatcherResult {
	targets: { start: number; end: number }[];
	roadwayUnderfills: ({ laneType: RoadLayerId; node: { start: number; end: number } } | null)[];
	laneBoundaries: (number | null)[];
	anchor: boolean;
	anchorHalfWidth: number;
	anchorPlateSpan: { start: number; end: number };
	dispositions: StripDisposition[];
}

interface LaneCell extends Interval {
	laneIndex: number;
	role: LaneRole;
	direction: LaneDirection;
	material: LaneMaterial;
	laneType: LaneLayerId;
	surfaceClass: SurfaceClass;
	movement: 'through' | 'turn' | 'none' | null;
}

interface VehicleGroup extends Interval {
	kind: 'group';
	id: number;
	direction: LaneDirection;
	laneIndexes: number[];
}

interface StructuralCell extends Interval {
	kind: 'cell';
	cell: LaneCell;
}

type SectionElement = VehicleGroup | StructuralCell;
type Side = 'low' | 'high';

interface Section {
	lanes: Lane[];
	cells: LaneCell[];
	intervals: (Interval & { laneType: LaneLayerId })[];
	elements: SectionElement[];
	groups: VehicleGroup[];
}

interface LaneMatch {
	selfToAnchor: Map<number, number>;
	anchorToSelf: Map<number, number>;
}

const EPSILON = 0.0001;

function at(interval: Interval) {
	return { start: interval.start, end: interval.end };
}

function center(interval: Interval) {
	return (interval.start + interval.end) / 2;
}

function roadwayLayer(material: LaneMaterial) {
	return `roadway:${material}` as const;
}

function armCarriageway(lanes: Lane[]) {
	let asphalt = 0;
	let concrete = 0;
	for (const lane of lanes) {
		if (lane.role !== 'vehicle') continue;
		if (lane.material === 'concrete') concrete += lane.width;
		else asphalt += lane.width;
	}
	return concrete > asphalt ? 'concrete' : 'asphalt';
}

function flipDirection(direction: LaneDirection) {
	if (direction === 'bidirectional') return direction;
	return direction === 'forward' ? 'backward' : 'forward';
}

function lanesInFrame(arm: MatcherArm, flipped: boolean) {
	if (!flipped) {
		return {
			lanes: arm.lanes,
			movements: arm.laneMovements ?? []
		};
	}

	const lanes = [...arm.lanes]
		.reverse()
		.map((lane) => ({ ...lane, direction: flipDirection(lane.direction) }) satisfies Lane);
	const movements = [...(arm.laneMovements ?? [])].reverse();
	return { lanes, movements };
}

function buildCells(lanes: Lane[], movements: ('through' | 'turn' | 'none')[]) {
	const cells: LaneCell[] = [];
	let offset = -getTotalWidth(lanes) / 2;
	for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
		const lane = lanes[laneIndex];
		const laneType = laneLayer(lanes, laneIndex);
		cells.push({
			laneIndex,
			start: offset,
			end: offset + lane.width,
			role: lane.role,
			direction: lane.direction,
			material: lane.material,
			laneType,
			surfaceClass: surfaceClassOf(laneType),
			movement: movements[laneIndex] ?? null
		});
		offset += lane.width;
	}
	return cells;
}

function buildSection(lanes: Lane[], movements: ('through' | 'turn' | 'none')[] = []) {
	const cells = buildCells(lanes, movements);
	const intervals = getLaneIntervals(lanes);
	const elements: SectionElement[] = [];
	const groups: VehicleGroup[] = [];
	let i = 0;
	while (i < cells.length) {
		const cell = cells[i];
		if (cell.role !== 'vehicle') {
			elements.push({ kind: 'cell', cell, start: cell.start, end: cell.end });
			i++;
			continue;
		}

		const laneIndexes: number[] = [];
		const start = cell.start;
		const direction = cell.direction;
		while (i < cells.length && cells[i].role === 'vehicle' && cells[i].direction === direction) {
			laneIndexes.push(cells[i].laneIndex);
			i++;
		}
		const end = cells[laneIndexes[laneIndexes.length - 1]].end;
		const group = {
			kind: 'group',
			id: groups.length,
			direction,
			laneIndexes,
			start,
			end
		} satisfies VehicleGroup;
		groups.push(group);
		elements.push(group);
	}
	return { lanes, cells, intervals, elements, groups } satisfies Section;
}

function laneBoundaryOffsets(lanes: Lane[]) {
	const bounds = [-getTotalWidth(lanes) / 2];
	for (const lane of lanes) {
		bounds.push(bounds[bounds.length - 1] + lane.width);
	}
	return bounds;
}

function groupForLane(section: Section, laneIndex: number) {
	return section.groups.find((group) => group.laneIndexes.includes(laneIndex)) ?? null;
}

function elementForLane(section: Section, laneIndex: number) {
	const cell = section.cells[laneIndex];
	if (!cell) return null;
	const group = cell.role === 'vehicle' ? groupForLane(section, laneIndex) : null;
	return (
		group ?? ({ kind: 'cell', cell, start: cell.start, end: cell.end } satisfies StructuralCell)
	);
}

function elementToken(element: SectionElement | null) {
	if (!element) return 'edge';
	if (element.kind === 'group') return `group:${element.direction}`;
	const cell = element.cell;
	return `${cell.surfaceClass}:${cell.material}:${Math.round((cell.end - cell.start) * 1000)}`;
}

function neighboringElement(section: Section, group: VehicleGroup, side: Side) {
	const laneIndex =
		side === 'low' ? Math.min(...group.laneIndexes) - 1 : Math.max(...group.laneIndexes) + 1;
	return elementForLane(section, laneIndex);
}

function isOpposingGroup(element: SectionElement | null, direction: LaneDirection) {
	return (
		element?.kind === 'group' &&
		element.direction !== direction &&
		element.direction !== 'bidirectional' &&
		direction !== 'bidirectional'
	);
}

function medianSide(section: Section, group: VehicleGroup): Side | null {
	const low = neighboringElement(section, group, 'low');
	const high = neighboringElement(section, group, 'high');
	if (isOpposingGroup(low, group.direction)) return 'low';
	if (isOpposingGroup(high, group.direction)) return 'high';
	if (low?.kind === 'cell' && low.cell.surfaceClass === 'island') return 'low';
	if (high?.kind === 'cell' && high.cell.surfaceClass === 'island') return 'high';
	return null;
}

function sideChanged(
	self: Section,
	selfGroup: VehicleGroup,
	anchor: Section,
	anchorGroup: VehicleGroup,
	side: Side
) {
	const selfNeighbor = neighboringElement(self, selfGroup, side);
	const anchorNeighbor = neighboringElement(anchor, anchorGroup, side);
	return elementToken(selfNeighbor) !== elementToken(anchorNeighbor);
}

function sideContinues(
	self: Section,
	selfGroup: VehicleGroup,
	anchor: Section,
	anchorGroup: VehicleGroup,
	side: Side
) {
	if (sideChanged(self, selfGroup, anchor, anchorGroup, side)) return false;
	const selfNeighbor = neighboringElement(self, selfGroup, side);
	const anchorNeighbor = neighboringElement(anchor, anchorGroup, side);
	if (!selfNeighbor || !anchorNeighbor) return false;
	if (
		isOpposingGroup(selfNeighbor, selfGroup.direction) &&
		isOpposingGroup(anchorNeighbor, anchorGroup.direction)
	) {
		return true;
	}
	return (
		selfNeighbor.kind === 'cell' &&
		anchorNeighbor.kind === 'cell' &&
		(selfNeighbor.cell.surfaceClass === 'island' || anchorNeighbor.cell.surfaceClass === 'island')
	);
}

function gapHasOnlyNonVehicle(section: Section, left: VehicleGroup, right: VehicleGroup) {
	const start = Math.max(...left.laneIndexes) + 1;
	const end = Math.min(...right.laneIndexes);
	for (let i = start; i < end; i++) {
		if (section.cells[i]?.role === 'vehicle') return false;
	}
	return true;
}

function buildCarriageways(section: Section) {
	const carriageways: VehicleGroup[] = [];
	let i = 0;
	while (i < section.groups.length) {
		const first = section.groups[i];
		const laneIndexes = [...first.laneIndexes];
		const start = first.start;
		let end = first.end;
		let j = i + 1;
		while (
			j < section.groups.length &&
			section.groups[j].direction === first.direction &&
			gapHasOnlyNonVehicle(section, section.groups[j - 1], section.groups[j])
		) {
			laneIndexes.push(...section.groups[j].laneIndexes);
			end = section.groups[j].end;
			j++;
		}
		carriageways.push({
			kind: 'group',
			id: carriageways.length,
			direction: first.direction,
			laneIndexes,
			start,
			end
		});
		i = j;
	}
	return carriageways;
}

function pairGroups(self: Section, anchor: Section) {
	const matches = new Map<number, number>();
	const selfGroups = buildCarriageways(self);
	const anchorGroups = buildCarriageways(anchor);
	const dp = Array.from({ length: selfGroups.length + 1 }, () =>
		Array.from({ length: anchorGroups.length + 1 }, () => 0)
	);

	for (let i = selfGroups.length - 1; i >= 0; i--) {
		for (let j = anchorGroups.length - 1; j >= 0; j--) {
			const paired =
				selfGroups[i].direction === anchorGroups[j].direction ? 1 + dp[i + 1][j + 1] : -Infinity;
			dp[i][j] = Math.max(paired, dp[i + 1][j], dp[i][j + 1]);
		}
	}

	let i = 0;
	let j = 0;
	while (i < selfGroups.length && j < anchorGroups.length) {
		if (
			selfGroups[i].direction === anchorGroups[j].direction &&
			dp[i][j] === 1 + dp[i + 1][j + 1]
		) {
			matches.set(selfGroups[i].id, anchorGroups[j].id);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}

	return { matches, selfGroups, anchorGroups };
}

function movementExtraScore(cells: LaneCell[]) {
	return cells.reduce(
		(score, cell) => score + (cell.movement === 'turn' ? 0 : cell.movement === 'none' ? 1 : 2),
		0
	);
}

function compareScores(a: number[], b: number[]) {
	for (let i = 0; i < a.length; i++) {
		const diff = a[i] - b[i];
		if (diff !== 0) return diff;
	}
	return 0;
}

function groupCells(section: Section, group: VehicleGroup) {
	return group.laneIndexes.map((laneIndex) => section.cells[laneIndex]);
}

function extraCells(cells: LaneCell[], lowCount: number, highCount: number) {
	return [...cells.slice(0, lowCount), ...cells.slice(cells.length - highCount)];
}

function matchGroupLanes(
	self: Section,
	selfGroup: VehicleGroup,
	anchor: Section,
	anchorGroup: VehicleGroup
) {
	const selfCells = groupCells(self, selfGroup);
	const anchorCells = groupCells(anchor, anchorGroup);
	const selfLarger = selfCells.length >= anchorCells.length;
	const extraCount = Math.abs(selfCells.length - anchorCells.length);
	const keep = Math.min(selfCells.length, anchorCells.length);
	const selfMedian = medianSide(self, selfGroup);
	const anchorMedian = medianSide(anchor, anchorGroup);
	const median = selfMedian ?? anchorMedian;
	let best: { selfOffset: number; anchorOffset: number } | null = null;
	let bestScore: number[] | null = null;

	for (let lowExtras = 0; lowExtras <= extraCount; lowExtras++) {
		const highExtras = extraCount - lowExtras;
		const selfOffset = selfLarger ? lowExtras : 0;
		const anchorOffset = selfLarger ? 0 : lowExtras;
		const lowExtraCount = lowExtras;
		const highExtraCount = highExtras;
		const continuingPenalty =
			(sideContinues(self, selfGroup, anchor, anchorGroup, 'low') ? lowExtraCount : 0) +
			(sideContinues(self, selfGroup, anchor, anchorGroup, 'high') ? highExtraCount : 0);
		const changedReward =
			(sideChanged(self, selfGroup, anchor, anchorGroup, 'low') ? -lowExtraCount : 0) +
			(sideChanged(self, selfGroup, anchor, anchorGroup, 'high') ? -highExtraCount : 0);
		const medianPenalty =
			median === null
				? 0
				: median === 'low'
					? -lowExtraCount + highExtraCount
					: lowExtraCount - highExtraCount;
		let displacement = 0;
		for (let i = 0; i < keep; i++) {
			displacement += Math.abs(
				center(selfCells[i + selfOffset]) - center(anchorCells[i + anchorOffset])
			);
		}

		const largerCells = selfLarger ? selfCells : anchorCells;
		const movementScore = movementExtraScore(extraCells(largerCells, lowExtras, highExtras));
		const score = [
			continuingPenalty,
			changedReward,
			medianPenalty,
			displacement,
			movementScore,
			lowExtras
		];
		if (!bestScore || compareScores(score, bestScore) < 0) {
			bestScore = score;
			best = { selfOffset, anchorOffset };
		}
	}

	const pairs: [number, number][] = [];
	if (!best) return pairs;
	for (let i = 0; i < keep; i++) {
		pairs.push([
			selfCells[i + best.selfOffset].laneIndex,
			anchorCells[i + best.anchorOffset].laneIndex
		]);
	}
	return pairs;
}

function structurallyMatchCells(selfCell: LaneCell, candidates: LaneCell[], used: Set<number>) {
	if (selfCell.surfaceClass === 'walkway') {
		let best: LaneCell | null = null;
		let bestDistance = Infinity;
		for (const candidate of candidates) {
			if (used.has(candidate.laneIndex) || candidate.surfaceClass !== 'walkway') continue;
			const distance = Math.abs(center(candidate) - center(selfCell));
			if (distance < bestDistance) {
				best = candidate;
				bestDistance = distance;
			}
		}
		return best;
	}

	let best: LaneCell | null = null;
	let bestOverlap = 0;
	for (const candidate of candidates) {
		if (used.has(candidate.laneIndex) || candidate.laneType !== selfCell.laneType) continue;
		const overlap =
			Math.min(selfCell.end, candidate.end) - Math.max(selfCell.start, candidate.start);
		if (overlap > bestOverlap) {
			best = candidate;
			bestOverlap = overlap;
		}
	}
	if (best) return best;

	let nearest: LaneCell | null = null;
	let nearestDistance = Infinity;
	for (const candidate of candidates) {
		if (used.has(candidate.laneIndex) || !isIslandLike(candidate.laneType)) continue;
		const distance = Math.abs(center(candidate) - center(selfCell));
		if (distance < nearestDistance) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	if (nearest && nearestDistance <= selfCell.end - selfCell.start + (nearest.end - nearest.start))
		return nearest;
	return null;
}

function matchLanes(self: Section, anchor: Section) {
	const match: LaneMatch = { selfToAnchor: new Map(), anchorToSelf: new Map() };
	const groupPairing = pairGroups(self, anchor);
	for (const selfGroup of groupPairing.selfGroups) {
		const anchorGroupId = groupPairing.matches.get(selfGroup.id);
		const anchorGroup =
			anchorGroupId === undefined ? null : groupPairing.anchorGroups[anchorGroupId];
		if (!anchorGroup) continue;
		for (const [selfLane, anchorLane] of matchGroupLanes(self, selfGroup, anchor, anchorGroup)) {
			match.selfToAnchor.set(selfLane, anchorLane);
			match.anchorToSelf.set(anchorLane, selfLane);
		}
	}

	const anchorNonVehicle = anchor.cells.filter((cell) => cell.role !== 'vehicle');
	const used = new Set<number>();
	for (const cell of self.cells) {
		if (cell.role === 'vehicle') continue;
		const counterpart = structurallyMatchCells(cell, anchorNonVehicle, used);
		if (!counterpart) continue;
		used.add(counterpart.laneIndex);
		match.selfToAnchor.set(cell.laneIndex, counterpart.laneIndex);
		match.anchorToSelf.set(counterpart.laneIndex, cell.laneIndex);
	}
	return match;
}

function intervalLaneIndexes(section: Section, interval: Interval & { laneType: LaneLayerId }) {
	return section.cells
		.filter(
			(cell) =>
				cell.laneType === interval.laneType &&
				interval.start <= cell.start + EPSILON &&
				cell.end <= interval.end + EPSILON
		)
		.map((cell) => cell.laneIndex);
}

function roadwayTarget(
	interval: Interval,
	anchorRoadways: (Interval & { laneType: LaneLayerId })[]
) {
	const boundStart = Math.min(...anchorRoadways.map((candidate) => candidate.start));
	const boundEnd = Math.max(...anchorRoadways.map((candidate) => candidate.end));
	const targetWidth = Math.min(interval.end - interval.start, boundEnd - boundStart);
	const targetCenter = Math.min(
		boundEnd - targetWidth / 2,
		Math.max(boundStart + targetWidth / 2, center(interval))
	);
	return { start: targetCenter - targetWidth / 2, end: targetCenter + targetWidth / 2 };
}

function roadwayUnderfillLayer(intervals: (Interval & { laneType: LaneLayerId })[], index: number) {
	const adjacent = [intervals[index - 1], intervals[index + 1]]
		.filter((interval) => interval && isRoadway(interval.laneType))
		.map((interval) => interval.laneType);
	return adjacent.length > 0 && adjacent.every((laneType) => laneType === 'roadway:concrete')
		? roadwayLayer('concrete')
		: roadwayLayer('asphalt');
}

// A necking roadway only fills its vacated span where it recedes from a VERGE
// (dirt/grass shoulder) — there the neutral plate would read as pavement, which
// is wrong, so an asphalt merge-gore is right. Against a walkway (the plate IS
// the sidewalk) or an island/median (which draws over it), the vacated span
// must stay the sidewalk/median, so no underfill — otherwise asphalt eats them.
function droppedRoadwayUnderfill(
	interval: Interval,
	target: Interval,
	lanes: Lane[],
	lowAdjacentVerge: boolean,
	highAdjacentVerge: boolean
) {
	const lowDrop = target.start > interval.start + EPSILON && lowAdjacentVerge;
	const highDrop = target.end < interval.end - EPSILON && highAdjacentVerge;
	if (!lowDrop && !highDrop) return null;
	const node =
		lowDrop && !highDrop
			? { start: interval.start, end: target.start }
			: highDrop && !lowDrop
				? { start: target.end, end: interval.end }
				: at(interval);
	return { laneType: roadwayLayer(armCarriageway(lanes)), node };
}

function mergeRoadwayUnderfill(
	current: { laneType: RoadLayerId; node: Interval } | null,
	next: { laneType: RoadLayerId; node: Interval }
) {
	if (!current) return next;
	return {
		laneType: current.laneType,
		node: {
			start: Math.min(current.node.start, next.node.start),
			end: Math.max(current.node.end, next.node.end)
		}
	};
}

function noseTarget(
	interval: Interval,
	anchorRoadways: (Interval & { laneType: LaneLayerId })[],
	fallback = center(interval)
) {
	if (anchorRoadways.length === 0) return { start: fallback, end: fallback };
	const targetCenter = Math.min(
		Math.max(...anchorRoadways.map((candidate) => candidate.end)),
		Math.max(Math.min(...anchorRoadways.map((candidate) => candidate.start)), fallback)
	);
	return { start: targetCenter, end: targetCenter };
}

function targetIntervalIndex(
	target: Interval | null,
	candidates: (Interval & { laneType: LaneLayerId })[]
) {
	if (!target) return -1;
	const exact = candidates.findIndex(
		(candidate) => candidate.start === target.start && candidate.end === target.end
	);
	if (exact >= 0) return exact;
	let best = -1;
	let bestOverlap = 0;
	for (let i = 0; i < candidates.length; i++) {
		const amount =
			Math.min(target.end, candidates[i].end) - Math.max(target.start, candidates[i].start);
		if (amount > bestOverlap) {
			bestOverlap = amount;
			best = i;
		}
	}
	return best;
}

function relationFor(
	self: MatcherArm,
	other: MatcherArm,
	intervalIndex: number,
	target: Interval,
	anchor: 'self' | 'target' | 'none',
	targetIndex: number
) {
	const relationId = `${self.segmentId}:${intervalIndex}->${other.segmentId}:${targetIndex}`;
	return {
		kind: 'continue',
		relationId,
		targetArmId: other.segmentId,
		targetIntervalIndex: targetIndex,
		targetSource: target,
		shared: {
			lowEdgeId: `${relationId}:low`,
			highEdgeId: `${relationId}:high`,
			offsetsByArm: {
				[self.segmentId]: target,
				[other.segmentId]: target
			}
		},
		anchor
	} satisfies StripDisposition;
}

function terminate(target: Interval | null) {
	return {
		kind: 'terminate',
		mode: 'taper',
		target,
		stopLine: null
	} satisfies StripDisposition;
}

function laneBoundariesFor(
	self: Section,
	anchor: Section,
	match: LaneMatch,
	keepOwnOffsets: boolean,
	targets: { start: number; end: number }[]
) {
	const selfBounds = laneBoundaryOffsets(self.lanes);
	const anchorBounds = laneBoundaryOffsets(anchor.lanes);
	const laneBoundaries: (number | null)[] = [];
	for (let index = 0; index + 1 < self.lanes.length; index++) {
		const left = match.selfToAnchor.get(index);
		const right = match.selfToAnchor.get(index + 1);
		if (left === undefined || right === undefined || Math.abs(left - right) !== 1) {
			laneBoundaries.push(null);
			continue;
		}
		laneBoundaries.push(
			keepOwnOffsets ? selfBounds[index + 1] : anchorBounds[Math.min(left, right) + 1]
		);
	}
	for (let i = 0; i < self.intervals.length; i++) {
		const interval = self.intervals[i];
		const surfaceClass = surfaceClassOf(interval.laneType);
		if (surfaceClass !== 'island' && surfaceClass !== 'verge') continue;
		const target = targets[i];
		if (Math.abs(target.end - target.start) > 0.001) continue;
		const laneIndexes = intervalLaneIndexes(self, interval);
		if (laneIndexes.length === 0) continue;
		const lo = Math.min(...laneIndexes);
		const hi = Math.max(...laneIndexes);
		const leftLane = self.cells[lo - 1];
		const rightLane = self.cells[hi + 1];
		if (leftLane?.role !== 'vehicle' || rightLane?.role !== 'vehicle') continue;
		const left = match.selfToAnchor.get(leftLane.laneIndex);
		const right = match.selfToAnchor.get(rightLane.laneIndex);
		if (left === undefined || right === undefined || Math.abs(left - right) !== 1) continue;
		const offset = anchorBounds[Math.max(left, right)];
		if (lo > 0) laneBoundaries[lo - 1] = offset;
		if (hi + 1 < self.lanes.length) laneBoundaries[hi] = offset;
	}
	if (keepOwnOffsets) {
		for (let index = 0; index + 1 < self.lanes.length; index++) {
			if (laneBoundaries[index] !== null) continue;
			const left = match.selfToAnchor.get(index);
			const right = match.selfToAnchor.get(index + 1);
			if (left === undefined || right === undefined || Math.abs(left - right) <= 1) continue;
			const start = Math.min(left, right) + 1;
			const end = Math.max(left, right);
			let canBridge = true;
			for (let laneIndex = start; laneIndex < end; laneIndex++) {
				const surfaceClass = anchor.cells[laneIndex]?.surfaceClass;
				if (
					(surfaceClass !== 'island' && surfaceClass !== 'verge') ||
					match.anchorToSelf.has(laneIndex)
				) {
					canBridge = false;
					break;
				}
			}
			if (canBridge) laneBoundaries[index] = selfBounds[index + 1];
		}
	}
	return { laneBoundaries };
}

function buildResult(
	self: MatcherArm,
	other: MatcherArm,
	selfSection: Section,
	anchorSection: Section,
	anchor: boolean
) {
	const match = anchor
		? matchLanes(anchorSection, selfSection)
		: matchLanes(selfSection, anchorSection);
	const effectiveMatch: LaneMatch = anchor
		? {
				selfToAnchor: match.anchorToSelf,
				anchorToSelf: match.selfToAnchor
			}
		: match;
	const anchorRoadways = anchorSection.intervals.filter((interval) => isRoadway(interval.laneType));
	const roadwayUnderfills: ({ laneType: RoadLayerId; node: Interval } | null)[] =
		selfSection.intervals.map(() => null);
	const targets = selfSection.intervals.map((interval, index) => {
		if (anchor && !isRoadway(interval.laneType)) return at(interval);
		if (anchor) return at(interval);

		const lanes = intervalLaneIndexes(selfSection, interval);
		const matchedTargets = lanes
			.map((laneIndex) => effectiveMatch.selfToAnchor.get(laneIndex))
			.filter((laneIndex) => laneIndex !== undefined)
			.map((laneIndex) => anchorSection.cells[laneIndex]);
		if (matchedTargets.length > 0) {
			const target = {
				start: Math.min(...matchedTargets.map((cell) => cell.start)),
				end: Math.max(...matchedTargets.map((cell) => cell.end))
			};
			if (isRoadway(interval.laneType)) {
				const vergeBeside = (i: number) => {
					const neighbor = selfSection.intervals[i];
					return neighbor ? surfaceClassOf(neighbor.laneType) === 'verge' : false;
				};
				roadwayUnderfills[index] = droppedRoadwayUnderfill(
					interval,
					target,
					self.lanes,
					vergeBeside(index - 1),
					vergeBeside(index + 1)
				);
			}
			return target;
		}

		if (surfaceClassOf(interval.laneType) === 'walkway') return at(interval);
		const target = isRoadway(interval.laneType)
			? noseTarget(interval, anchorRoadways)
			: noseTarget(interval, anchorRoadways);
		roadwayUnderfills[index] = {
			laneType: roadwayUnderfillLayer(selfSection.intervals, index),
			node:
				isRoadway(interval.laneType) && anchorRoadways.length > 0
					? roadwayTarget(interval, anchorRoadways)
					: target
		};
		return target;
	});

	for (let index = 0; index < selfSection.intervals.length; index++) {
		const interval = selfSection.intervals[index];
		if (!isRoadway(interval.laneType)) continue;
		const target = targets[index];
		const layer = roadwayLayer(armCarriageway(self.lanes));
		const previousTarget = targets[index - 1];
		if (
			previousTarget &&
			selfSection.intervals[index - 1]?.end >= interval.start - EPSILON &&
			previousTarget.end < target.start - EPSILON
		) {
			roadwayUnderfills[index] = mergeRoadwayUnderfill(roadwayUnderfills[index], {
				laneType: layer,
				node: { start: previousTarget.end, end: target.start }
			});
		}
		const nextTarget = targets[index + 1];
		if (
			nextTarget &&
			selfSection.intervals[index + 1]?.start <= interval.end + EPSILON &&
			nextTarget.start > target.end + EPSILON
		) {
			roadwayUnderfills[index] = mergeRoadwayUnderfill(roadwayUnderfills[index], {
				laneType: layer,
				node: { start: target.end, end: nextTarget.start }
			});
		}
	}

	const dispositions = targets.map((target, index) => {
		const interval = selfSection.intervals[index];
		const lanes = intervalLaneIndexes(selfSection, interval);
		const hasMatch = lanes.some((laneIndex) => effectiveMatch.selfToAnchor.has(laneIndex));
		const zeroTarget = Math.abs(target.end - target.start) <= EPSILON;
		// A strip continues only if it has a matched counterpart. An unmatched
		// strip — including a sidewalk that appears/vanishes across the node —
		// terminates square; an island squeezed to zero width noses off.
		if (!hasMatch || (isIslandLike(interval.laneType) && zeroTarget)) {
			return terminate(target);
		}
		return relationFor(
			self,
			other,
			index,
			target,
			anchor ? 'self' : 'target',
			anchor
				? targetIntervalIndex(target, anchorSection.intervals)
				: targetIntervalIndex(target, anchorSection.intervals)
		);
	});

	const paintBoundaries = laneBoundariesFor(
		selfSection,
		anchorSection,
		effectiveMatch,
		anchor,
		targets
	);

	return {
		targets,
		roadwayUnderfills,
		laneBoundaries: paintBoundaries.laneBoundaries,
		anchor,
		anchorHalfWidth: getTotalWidth(anchor ? self.lanes : other.lanes) / 2,
		anchorPlateSpan: {
			start: -getTotalWidth(anchor ? self.lanes : other.lanes) / 2,
			end: getTotalWidth(anchor ? self.lanes : other.lanes) / 2
		},
		dispositions
	} satisfies MatcherResult;
}

export function matchTransitionArm(self: MatcherArm, other: MatcherArm) {
	const halfSelf = getTotalWidth(self.lanes) / 2;
	const halfOther = getTotalWidth(other.lanes) / 2;
	const selfStructureKey = lanesStructureKey(self.lanes);
	const otherStructureKey = lanesStructureKey(other.lanes);
	const selfIsAnchor =
		halfSelf < halfOther - 0.01 ||
		(Math.abs(halfSelf - halfOther) <= 0.01 && selfStructureKey <= otherStructureKey);
	const flipped = self.startsHere === other.startsHere;
	const selfFrame = lanesInFrame(self, false);
	const otherFrame = lanesInFrame(other, flipped);
	const selfSection = buildSection(selfFrame.lanes, selfFrame.movements);
	const otherSection = buildSection(otherFrame.lanes, otherFrame.movements);
	return buildResult(self, other, selfSection, otherSection, selfIsAnchor);
}
