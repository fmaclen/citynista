import * as THREE from 'three';
import type { Graph } from '../core/graph.svelte';
import {
	buildNodeLayers,
	buildNodePaint,
	computeIntersectionTrims,
	getLaneIntervals,
	isContinuationNode,
	sampleTrimmedCenterline,
	transitionMorph
} from '../core/road-geometry';
import type { NodePaintPath, SegmentTrims } from '../core/road-geometry';
import type {
	CenterlineSample,
	Point,
	PolygonWithHoles,
	RoadLayer,
	RoadLayerId,
	TransitionMorph
} from '../core/road-geometry';

// Per-end offset interpolation for a strip: from the node-side target
// offsets back to the strip's own offsets over `length`.
interface StripMorph {
	start?: { length: number; offsetA: number; offsetB: number };
	end?: { length: number; offsetA: number; offsetB: number };
}
import { getTotalWidth } from '../core/lane-template';
import {
	LANE_TYPE_LIST,
	laneColor,
	laneLayerY,
	lanePaintBetween,
	laneSurface
} from '../core/lane-types';
import type { Lane } from '../core/types';

const LAYER_Y: Record<RoadLayerId, number> = Object.fromEntries(
	LANE_TYPE_LIST.map((type) => [type, laneLayerY(type)])
) as Record<RoadLayerId, number>;

const LAYER_COLORS: Record<RoadLayerId, string> = Object.fromEntries(
	LANE_TYPE_LIST.map((type) => [type, laneColor(type)])
) as Record<RoadLayerId, string>;

// Segment ribbons reach slightly into their node pieces so no hairline
// cracks can open between them.
const JOIN_OVERLAP = 0.5;

// Lane paint: thin stripes drawn on the lane boundaries the strips already
// define. Dashed white between same-direction travel lanes, solid white
// against accessory lanes (bike, parking, transit), solid muted yellow
// between opposing flows. Paint renders above every roadway color but
// below medians, follows transition morphs, and stops short of junction
// mouths — junction interiors stay unpainted until crosswalks exist.
// Above every lane layer including medians, so crossings can carry
// pedestrian pavement over them; still below the interaction layers.
const PAINT_Y = 0.095;
const PAINT_WIDTH = 0.16;
const PAINT_DASH = 2.2;
const PAINT_GAP = 2.6;
const PAINT_SOLID_STEP = 2.5;
const PAINT_END_INSET = 0.2;
// A branching lane line stops once it converges this close to the line it
// merges into — the remaining sliver of lane is not usable, and real paint
// leaves the same gap.
const PAINT_BRANCH_GAP = 1.5;
// A turn pocket's same-direction flank line holds back from the pocket's
// open end — cars enter across the first stretch, so the paint starts
// after it. The opposing-side line stays unbroken.
const TURN_POCKET_ENTRANCE = 10;
// Islands pinched below this width by a transition end square at the
// threshold instead of riding to the seam as a sliver.
const ISLAND_MIN_WIDTH = 0.8;
const PAINT_COLORS = { lane: '#C9C9C0', center: '#C3B47C', walk: '#9A9A94' } as const;
type PaintColor = keyof typeof PAINT_COLORS;
// Tiny per-piece elevation so coplanar pieces never z-fight; stays well
// below the 0.01 gap between layers.
const PIECE_JITTER_STEP = 0.0002;
const PIECE_JITTER_SLOTS = 40;

interface RoadRendererOptions {
	opacity?: number;
	elevation?: number;
}

interface Piece {
	hash: string;
	group: THREE.Group;
}

export class RoadRenderer {
	private scene: THREE.Scene;
	private rootGroup: THREE.Group;
	private opacity: number;
	private elevation: number;
	private paintMaterials = new Map<PaintColor, THREE.MeshBasicMaterial>();
	private materials = new Map<RoadLayerId, THREE.MeshBasicMaterial>();
	private pieces = new Map<string, Piece>();
	private jitters = new Map<string, number>();
	private jitterCounter = 0;
	private ghostGroup: THREE.Group | null = null;

	constructor(scene: THREE.Scene, options: RoadRendererOptions = {}) {
		this.scene = scene;
		this.opacity = options.opacity ?? 1;
		this.elevation = options.elevation ?? 0;
		this.rootGroup = new THREE.Group();
		this.rootGroup.name = 'roads';
		this.scene.add(this.rootGroup);
	}

	// Incrementally rebuild the network: every segment and node is a cached
	// piece keyed by a hash of its inputs, so a drag only regenerates the
	// pieces it actually moves.
	update(graph: Graph, trims: SegmentTrims = computeIntersectionTrims(graph)) {
		const centerlines = new Map<string, CenterlineSample[]>();

		for (const segment of graph.segments.values()) {
			const startNode = graph.nodes.get(segment.startNodeId);
			const endNode = graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const trim = trims.get(segment.id);
			const samples = sampleTrimmedCenterline(
				segment,
				startNode,
				endNode,
				trim?.start ?? 0,
				trim?.end ?? 0
			);
			if (samples.length >= 2) {
				centerlines.set(segment.id, samples);
			}
		}

		const seen = new Set<string>();

		for (const segment of graph.segments.values()) {
			const samples = centerlines.get(segment.id);
			if (!samples) continue;

			const startNode = graph.nodes.get(segment.startNodeId)!;
			const endNode = graph.nodes.get(segment.endNodeId)!;
			const joinStart = startNode.connectedSegments.length > 1;
			const joinEnd = endNode.connectedSegments.length > 1;
			// At two-segment same-type nodes the node piece carries medians and
			// grass through (bend wedges or corner bands), so those strips
			// overlap it like the other layers; at junctions and transitions
			// they must stop square at the stop line.
			const continuityJoinStart = isContinuationNode(graph, startNode, segment.id);
			const continuityJoinEnd = isContinuationNode(graph, endNode, segment.id);
			const morphStart = transitionMorph(graph, startNode, segment.id);
			const morphEnd = transitionMorph(graph, endNode, segment.id);
			const turnSignStart = turnBranchSign(graph, startNode, segment, samples, true);
			const turnSignEnd = turnBranchSign(graph, endNode, segment, samples, false);
			const trim = trims.get(segment.id);

			const key = `segment:${segment.id}`;
			const hash = [
				segment.lanesKey,
				startNode.x,
				startNode.y,
				endNode.x,
				endNode.y,
				segment.controlX ?? 'line',
				segment.controlY ?? 'line',
				trim?.start ?? 0,
				trim?.end ?? 0,
				joinStart,
				joinEnd,
				continuityJoinStart,
				continuityJoinEnd,
				morphStart?.key ?? '-',
				morphEnd?.key ?? '-',
				turnSignStart,
				turnSignEnd
			].join('|');

			seen.add(key);
			if (this.pieces.get(key)?.hash === hash) continue;

			this.removePiece(key);
			const group = this.buildSegmentGroup(
				segment.lanes,
				samples,
				joinStart,
				joinEnd,
				continuityJoinStart,
				continuityJoinEnd,
				morphStart,
				morphEnd,
				turnSignStart,
				turnSignEnd,
				this.jitterFor(key)
			);
			this.rootGroup.add(group);
			this.pieces.set(key, { hash, group });
		}

		for (const node of graph.nodes.values()) {
			if (node.connectedSegments.length < 2) continue;

			const key = `node:${node.id}`;
			const parts: string[] = [`${node.x},${node.y}`];
			for (const segmentId of [...node.connectedSegments].sort()) {
				const segment = graph.segments.get(segmentId);
				const samples = centerlines.get(segmentId);
				if (!segment || !samples) continue;

				const isStart = segment.startNodeId === node.id;
				const stop = isStart ? samples[0] : samples[samples.length - 1];
				const inner = isStart ? samples[1] : samples[samples.length - 2];
				parts.push(`${segmentId}:${segment.lanesKey}:${stop.x},${stop.y},${inner.x},${inner.y}`);
			}
			const hash = parts.join('|');

			seen.add(key);
			if (this.pieces.get(key)?.hash === hash) continue;

			this.removePiece(key);
			const jitterValue = this.jitterFor(key);
			const group = this.buildLayerGroup(buildNodeLayers(graph, node, centerlines), jitterValue);
			for (const mesh of this.buildNodePaintMeshes(
				buildNodePaint(graph, node, centerlines),
				jitterValue
			)) {
				group.add(mesh);
			}
			this.rootGroup.add(group);
			this.pieces.set(key, { hash, group });
		}

		for (const key of [...this.pieces.keys()]) {
			if (!seen.has(key)) {
				this.removePiece(key);
			}
		}
	}

	// One-shot rendering of prebuilt layers (used for the draw-mode ghost).
	render(layers: RoadLayer[]) {
		this.clearGhost();
		this.ghostGroup = this.buildLayerGroup(layers, 0);
		this.rootGroup.add(this.ghostGroup);
	}

	private buildSegmentGroup(
		lanes: Lane[],
		samples: CenterlineSample[],
		joinStart: boolean,
		joinEnd: boolean,
		continuityJoinStart: boolean,
		continuityJoinEnd: boolean,
		morphStart: TransitionMorph | null,
		morphEnd: TransitionMorph | null,
		turnSignStart: number,
		turnSignEnd: number,
		jitter: number
	): THREE.Group {
		const group = new THREE.Group();
		if (lanes.length === 0) return group;

		const halfWidth = getTotalWidth(lanes) / 2;
		const startExt = joinStart ? JOIN_OVERLAP : 0;
		const endExt = joinEnd ? JOIN_OVERLAP : 0;

		// Morph zones at the two ends may not overlap each other; on short
		// segments they shrink proportionally.
		let total = 0;
		for (let i = 1; i < samples.length; i++) {
			total += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
		}
		let lengthStart = morphStart?.length ?? 0;
		let lengthEnd = morphEnd?.length ?? 0;
		if (lengthStart + lengthEnd > total) {
			const scale = total / (lengthStart + lengthEnd);
			lengthStart *= scale;
			lengthEnd *= scale;
		}

		// Full-width pavement plate rendered as the sidewalk layer; the lane
		// strips above carve out the visible sidewalk edges.
		group.add(
			this.buildStrip(samples, -halfWidth, halfWidth, 'sidewalk', startExt, endExt, jitter, {
				start: morphStart
					? { length: lengthStart, offsetA: -morphStart.halfWidth, offsetB: morphStart.halfWidth }
					: undefined,
				end: morphEnd
					? { length: lengthEnd, offsetA: -morphEnd.halfWidth, offsetB: morphEnd.halfWidth }
					: undefined
			})
		);

		const intervals = getLaneIntervals(lanes);
		for (let k = 0; k < intervals.length; k++) {
			const interval = intervals[k];
			const surface = laneSurface(interval.laneType);
			if (surface === 'walkway') continue;

			const targetStart = morphStart ? morphStart.intervals[k] : undefined;
			const targetEnd = morphEnd ? morphEnd.intervals[k] : undefined;
			const stripMorph: StripMorph | undefined =
				targetStart || targetEnd
					? {
							start: targetStart
								? { length: lengthStart, offsetA: targetStart.start, offsetB: targetStart.end }
								: undefined,
							end: targetEnd
								? { length: lengthEnd, offsetA: targetEnd.start, offsetB: targetEnd.end }
								: undefined
						}
					: undefined;

			if (surface === 'roadway') {
				// Overlap stubs past a node are only invisible for plain road
				// (they hide under the asphalt patch or the neighbor's road);
				// every other lane draws above road and would show them.
				// At transition seams both ribbons arrive at the anchor's
				// offsets vertex-for-vertex, so a road stub hides inside the
				// counterpart's roadway exactly like at continuations.
				const stubSafeStart = continuityJoinStart || interval.laneType === 'road';
				const stubSafeEnd = continuityJoinEnd || interval.laneType === 'road';
				group.add(
					this.buildStrip(
						samples,
						interval.start,
						interval.end,
						interval.laneType,
						stubSafeStart ? startExt : 0,
						stubSafeEnd ? endExt : 0,
						jitter,
						stripMorph
					)
				);
				continue;
			}

			// A strip with no counterpart across the transition ends in a
			// square cut exactly where the morph zone begins — never a
			// sliver, and never poking straight into the active taper
			// (trimCenterline caps trims at 45% of the length, so it cannot
			// be used here).
			// A strip whose target pinches it below a usable width ends in a
			// square cut where the pinch crosses the threshold — a median
			// funneling into a narrow road must never ride to the seam as a
			// sliver wall. The morph restarts from the eased cross-section
			// at the cut, so the visible taper stays smooth.
			const ownWidth = interval.end - interval.start;
			const pinch = (target: { start: number; end: number } | null | undefined, length: number) => {
				if (!target) return null;
				const targetWidth = target.end - target.start;
				if (targetWidth >= ISLAND_MIN_WIDTH || ownWidth <= targetWidth) return null;
				let d = 0;
				while (d < length) {
					const width = targetWidth + (ownWidth - targetWidth) * morphEase(d, length);
					if (width >= ISLAND_MIN_WIDTH) break;
					d += 0.5;
				}
				const f = morphEase(d, length);
				return {
					at: d,
					length: length - d,
					offsetA: target.start + (interval.start - target.start) * f,
					offsetB: target.end + (interval.end - target.end) * f
				};
			};
			const pinchStart = morphStart ? pinch(targetStart, lengthStart) : null;
			const pinchEnd = morphEnd ? pinch(targetEnd, lengthEnd) : null;

			const cutStart = morphStart && !targetStart ? lengthStart : (pinchStart?.at ?? 0);
			const cutEnd = morphEnd && !targetEnd ? lengthEnd : (pinchEnd?.at ?? 0);
			let stripSamples = samples;
			if (cutStart > 0 || cutEnd > 0) {
				const remaining = total - cutStart - cutEnd;
				if (remaining < 0.1) continue;
				if (cutStart > 0) {
					stripSamples = sliceCenterline(stripSamples, 'end', total - cutStart);
				}
				if (cutEnd > 0) {
					stripSamples = sliceCenterline(stripSamples, 'start', remaining);
				}
				if (stripSamples.length < 2) continue;
			}

			const islandMorph: StripMorph | undefined =
				pinchStart || pinchEnd
					? {
							start: pinchStart ?? stripMorph?.start,
							end: pinchEnd ?? stripMorph?.end
						}
					: stripMorph;

			// Grass and median strips overlap into nodes that continue the
			// cross-section or morph it (matched strips meet their
			// counterpart at the same offsets); at junctions and square cuts
			// they stop dead.
			group.add(
				this.buildStrip(
					stripSamples,
					interval.start,
					interval.end,
					interval.laneType,
					continuityJoinStart ? JOIN_OVERLAP : 0,
					continuityJoinEnd ? JOIN_OVERLAP : 0,
					jitter,
					islandMorph
				)
			);
		}

		for (const mesh of this.buildPaint(
			lanes,
			intervals,
			samples,
			total,
			morphStart,
			morphEnd,
			lengthStart,
			lengthEnd,
			continuityJoinStart,
			continuityJoinEnd,
			turnSignStart,
			turnSignEnd,
			jitter
		)) {
			group.add(mesh);
		}

		return group;
	}

	// One mesh per paint color holding every stripe of the segment as quads
	// walked along the centerline; boundary offsets follow the same morph
	// ease as the strips, so paint tapers with its lane. A boundary whose
	// neighbor strip has no counterpart across a transition cuts where the
	// morph begins, like the strip itself.
	private buildPaint(
		lanes: Lane[],
		intervals: ReturnType<typeof getLaneIntervals>,
		samples: CenterlineSample[],
		total: number,
		morphStart: TransitionMorph | null,
		morphEnd: TransitionMorph | null,
		lengthStart: number,
		lengthEnd: number,
		continuityJoinStart: boolean,
		continuityJoinEnd: boolean,
		turnSignStart: number,
		turnSignEnd: number,
		jitter: number
	): THREE.Mesh[] {
		const cumulative: number[] = [0];
		for (let i = 1; i < samples.length; i++) {
			cumulative.push(
				cumulative[i - 1] +
					Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)
			);
		}

		const positions: Record<PaintColor, number[]> = { lane: [], center: [], walk: [] };
		const halfWidth = getTotalWidth(lanes) / 2;

		// Boundary targets at each end come from the morph itself: lane
		// lines stay straight wherever a lane exists on both sides and
		// converge into their neighbor where one branches; a boundary that
		// stops existing at the node cuts where the morph begins.
		let boundary = -halfWidth;
		for (let k = 0; k + 1 < lanes.length; k++) {
			boundary += lanes[k].width;
			const paint = lanePaintBetween(lanes[k], lanes[k + 1]);
			if (!paint) continue;
			const offset = boundary;

			const startTarget = morphStart ? morphStart.laneBoundaries[k] : undefined;
			const endTarget = morphEnd ? morphEnd.laneBoundaries[k] : undefined;

			let from = continuityJoinStart || morphStart ? 0 : PAINT_END_INSET;
			let to = total - (continuityJoinEnd || morphEnd ? 0 : PAINT_END_INSET);
			if (startTarget === null) from = Math.max(from, lengthStart);
			if (endTarget === null) to = Math.min(to, total - lengthEnd);

			// A branching line ends early with a gap: once it has converged
			// to within a sliver of the line it merges into, the lane is no
			// longer usable and real paint just stops.
			const branchCut = (target: number | null | undefined, length: number) => {
				if (target == null || Math.abs(offset - target) <= PAINT_BRANCH_GAP + 0.5) return 0;
				let d = 0;
				while (d < length) {
					const eased = target + (offset - target) * morphEase(d, length);
					if (Math.abs(eased - target) >= PAINT_BRANCH_GAP) return d;
					d += 0.5;
				}
				return length;
			};
			from = Math.max(from, branchCut(startTarget, lengthStart));
			const endCut = branchCut(endTarget, lengthEnd);
			if (endCut > 0) to = Math.min(to, total - endCut);

			// The pocket's entrance is the transition end where it emerges
			// from the median; the flank line starts after the entire taper
			// plus the entrance stretch, so it is dead straight — never
			// curved. Same-key continuations are untouched so chained
			// pockets stay sealed.
			const turnFlank =
				paint.color === 'lane' && (lanes[k].type === 'turn' || lanes[k + 1].type === 'turn');
			if (turnFlank) {
				if (morphStart) from = Math.max(from, lengthStart + TURN_POCKET_ENTRANCE);
				if (morphEnd) to = Math.min(to, total - lengthEnd - TURN_POCKET_ENTRANCE);
			}
			if (to - from < 0.5) continue;

			const offsetAt = (d: number) => {
				let value = offset;
				if (startTarget != null && lengthStart > 0.0001) {
					const f = morphEase(d, lengthStart);
					value = startTarget + (value - startTarget) * f;
				}
				if (endTarget != null && lengthEnd > 0.0001) {
					const f = morphEase(total - d, lengthEnd);
					value = endTarget + (value - endTarget) * f;
				}
				return value;
			};
			const pointAt = (d: number) => {
				let i = 1;
				while (i < cumulative.length - 1 && cumulative[i] < d) i++;
				const span = cumulative[i] - cumulative[i - 1];
				const t = span > 0.0001 ? (d - cumulative[i - 1]) / span : 0;
				const a = samples[i - 1];
				const b = samples[i];
				let nx = a.normalX + (b.normalX - a.normalX) * t;
				let ny = a.normalY + (b.normalY - a.normalY) * t;
				const length = Math.hypot(nx, ny);
				if (length > 0.0001) {
					nx /= length;
					ny /= length;
				}
				const value = offsetAt(d);
				return {
					x: a.x + (b.x - a.x) * t + nx * value,
					z: a.y + (b.y - a.y) * t + ny * value,
					nx,
					ny
				};
			};

			const target = positions[paint.color];
			const stepLength = paint.dashed ? PAINT_DASH : PAINT_SOLID_STEP;
			const gap = paint.dashed ? PAINT_GAP : 0;
			const half = PAINT_WIDTH / 2;
			let d = from;
			let previous = pointAt(d);
			while (d < to - 0.05) {
				const end = Math.min(d + stepLength, to);
				if (end - d < 0.3) break;
				const p1 = gap === 0 ? previous : pointAt(d);
				const p2 = pointAt(end);
				target.push(
					p1.x - p1.nx * half,
					0,
					p1.z - p1.ny * half,
					p1.x + p1.nx * half,
					0,
					p1.z + p1.ny * half,
					p2.x - p2.nx * half,
					0,
					p2.z - p2.ny * half,
					p1.x + p1.nx * half,
					0,
					p1.z + p1.ny * half,
					p2.x + p2.nx * half,
					0,
					p2.z + p2.ny * half,
					p2.x - p2.nx * half,
					0,
					p2.z - p2.ny * half
				);
				previous = p2;
				d = end + gap;
			}
		}

		// Turn arrows: repeated glyphs along each turn pocket, bending toward
		// the carriageway center, placed from the junction end inward.
		const sampleAt = (d: number) => {
			let i = 1;
			while (i < cumulative.length - 1 && cumulative[i] < d) i++;
			const span = cumulative[i] - cumulative[i - 1];
			const t = span > 0.0001 ? (d - cumulative[i - 1]) / span : 0;
			const a = samples[i - 1];
			const b = samples[i];
			let nx = a.normalX + (b.normalX - a.normalX) * t;
			let ny = a.normalY + (b.normalY - a.normalY) * t;
			const nl = Math.hypot(nx, ny);
			if (nl > 0.0001) {
				nx /= nl;
				ny /= nl;
			}
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dl = Math.hypot(dx, dy);
			return {
				x: a.x + dx * t,
				z: a.y + dy * t,
				tx: dl > 0.0001 ? dx / dl : 1,
				ty: dl > 0.0001 ? dy / dl : 0,
				nx,
				ny
			};
		};

		const drawArrow = (d: number, offset: number, travelSign: number, bendSign: number) => {
			const p = sampleAt(d);
			const tx = p.tx * travelSign;
			const ty = p.ty * travelSign;
			// The glyph bends toward the branch at the pocket's junction
			// (the sign comes from the actual topology); without one it
			// falls back to the driver's left.
			const bx = bendSign !== 0 ? p.nx * bendSign : ty;
			const by = bendSign !== 0 ? p.ny * bendSign : -tx;
			// The bend carries the glyph's mass sideways; shifting the stem
			// the other way centers the whole glyph in the lane.
			const baseX = p.x + p.nx * offset - bx * 0.9;
			const baseZ = p.z + p.ny * offset - by * 0.9;
			const target = positions.lane;
			const w = 0.18;

			const quad = (
				ax: number,
				az: number,
				bx2: number,
				bz2: number,
				sideX: number,
				sideY: number
			) => {
				target.push(
					ax - sideX * w,
					0,
					az - sideY * w,
					ax + sideX * w,
					0,
					az + sideY * w,
					bx2 - sideX * w,
					0,
					bz2 - sideY * w,
					ax + sideX * w,
					0,
					az + sideY * w,
					bx2 + sideX * w,
					0,
					bz2 + sideY * w,
					bx2 - sideX * w,
					0,
					bz2 - sideY * w
				);
			};

			// Stem along travel, elbow toward the turn, arrowhead at the tip.
			const stemTailX = baseX - tx * 1.7;
			const stemTailZ = baseZ - ty * 1.7;
			const elbowX = baseX + tx * 0.7;
			const elbowZ = baseZ + ty * 0.7;
			quad(stemTailX, stemTailZ, elbowX, elbowZ, p.nx, p.ny);
			const tipX = elbowX + bx * 1.0;
			const tipZ = elbowZ + by * 1.0;
			quad(elbowX, elbowZ, tipX, tipZ, tx, ty);
			// Fill the outer corner of the elbow, where the two stroke
			// rectangles would otherwise leave a notch.
			quad(elbowX - bx * w, elbowZ - by * w, elbowX + bx * w, elbowZ + by * w, tx, ty);
			target.push(
				tipX + bx * 0.85,
				0,
				tipZ + by * 0.85,
				tipX + tx * 0.55,
				0,
				tipZ + ty * 0.55,
				tipX - tx * 0.55,
				0,
				tipZ - ty * 0.55
			);
		};

		let laneStart = -halfWidth;
		for (const lane of lanes) {
			const laneEnd = laneStart + lane.width;
			if (lane.type === 'turn') {
				const center = (laneStart + laneEnd) / 2;
				const travelSign = lane.direction === 'backward' ? -1 : 1;
				const usableFrom = (morphStart ? lengthStart : 0) + 4;
				const usableTo = total - (morphEnd ? lengthEnd : 0) - 4;
				if (usableTo - usableFrom > 3) {
					const spots: { d: number; bend: number }[] = [];
					if (morphStart && !morphEnd) {
						spots.push(
							{ d: usableTo - 1, bend: turnSignEnd },
							{ d: usableTo - 9, bend: turnSignEnd }
						);
					} else if (morphEnd && !morphStart) {
						spots.push(
							{ d: usableFrom + 1, bend: turnSignStart },
							{ d: usableFrom + 9, bend: turnSignStart }
						);
					} else {
						spots.push({ d: (usableFrom + usableTo) / 2, bend: turnSignEnd || turnSignStart });
					}
					for (const { d, bend } of spots) {
						if (d >= usableFrom && d <= usableTo) {
							drawArrow(d, center, travelSign, bend);
						}
					}
				}
			}
			laneStart = laneEnd;
		}

		return this.paintMeshes(positions, jitter);
	}

	// Paint across node pieces: dashes walked along the corner-curve paths
	// the geometry exports, so lines flow through bends.
	private buildNodePaintMeshes(paths: NodePaintPath[], jitter: number): THREE.Mesh[] {
		const positions: Record<PaintColor, number[]> = { lane: [], center: [], walk: [] };

		for (const path of paths) {
			const points = path.points;
			if (points.length < 2) continue;
			const cumulative: number[] = [0];
			for (let i = 1; i < points.length; i++) {
				cumulative.push(
					cumulative[i - 1] +
						Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
				);
			}
			const total = cumulative[cumulative.length - 1];
			if (total < 0.1) continue;

			const pointAt = (d: number) => {
				let i = 1;
				while (i < cumulative.length - 1 && cumulative[i] < d) i++;
				const span = cumulative[i] - cumulative[i - 1];
				const t = span > 0.0001 ? (d - cumulative[i - 1]) / span : 0;
				const a = points[i - 1];
				const b = points[i];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const length = Math.hypot(dx, dy);
				const nx = length > 0.0001 ? -dy / length : 0;
				const ny = length > 0.0001 ? dx / length : 1;
				return { x: a.x + dx * t, z: a.y + dy * t, nx, ny };
			};

			const target = positions[path.color];
			const half = (path.width ?? PAINT_WIDTH) / 2;
			const stepLength = path.dashed ? PAINT_DASH : PAINT_SOLID_STEP;
			const gap = path.dashed ? PAINT_GAP : 0;
			let d = 0;
			let previous = pointAt(d);
			while (d < total - 0.05) {
				const end = Math.min(d + stepLength, total);
				const p1 = gap === 0 ? previous : pointAt(d);
				const p2 = pointAt(end);
				target.push(
					p1.x - p1.nx * half,
					0,
					p1.z - p1.ny * half,
					p1.x + p1.nx * half,
					0,
					p1.z + p1.ny * half,
					p2.x - p2.nx * half,
					0,
					p2.z - p2.ny * half,
					p1.x + p1.nx * half,
					0,
					p1.z + p1.ny * half,
					p2.x + p2.nx * half,
					0,
					p2.z + p2.ny * half,
					p2.x - p2.nx * half,
					0,
					p2.z - p2.ny * half
				);
				previous = p2;
				d = end + gap;
			}
		}

		return this.paintMeshes(positions, jitter);
	}

	private paintMeshes(positions: Record<PaintColor, number[]>, jitter: number): THREE.Mesh[] {
		const meshes: THREE.Mesh[] = [];
		for (const color of ['lane', 'center', 'walk'] as PaintColor[]) {
			if (positions[color].length === 0) continue;
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(new Float32Array(positions[color]), 3)
			);
			const mesh = new THREE.Mesh(geometry, this.paintMaterialFor(color));
			mesh.position.y = PAINT_Y + this.elevation + jitter;
			meshes.push(mesh);
		}
		return meshes;
	}

	private paintMaterialFor(color: PaintColor): THREE.MeshBasicMaterial {
		let material = this.paintMaterials.get(color);
		if (!material) {
			material = new THREE.MeshBasicMaterial({
				color: new THREE.Color(PAINT_COLORS[color]),
				side: THREE.DoubleSide,
				transparent: this.opacity < 1,
				opacity: this.opacity
			});
			this.paintMaterials.set(color, material);
		}
		return material;
	}

	private buildStrip(
		samples: CenterlineSample[],
		offsetA: number,
		offsetB: number,
		layerId: RoadLayerId,
		extendStart: number,
		extendEnd: number,
		jitter: number,
		morph?: StripMorph
	): THREE.Mesh {
		const points = extendSamples(samples, extendStart, extendEnd);
		const y = LAYER_Y[layerId] + this.elevation + jitter;

		// Distances along the strip, measured from the original (unextended)
		// ends so extension points sit at clamped morph factor 0.
		const cumulative: number[] = [0];
		for (let i = 1; i < points.length; i++) {
			cumulative.push(
				cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
			);
		}
		const startShift = extendStart > 0 ? extendStart : 0;
		const innerTotal =
			cumulative[cumulative.length - 1] - startShift - (extendEnd > 0 ? extendEnd : 0);

		// The eased taper needs vertices through the morph zone — straight
		// segments only have their two end samples.
		if (morph) {
			const boundaries: number[] = [];
			const ZONE_STEPS = 10;
			if (morph.start && morph.start.length > 0.0001) {
				for (let k = 1; k <= ZONE_STEPS; k++) {
					boundaries.push(startShift + (morph.start.length * k) / ZONE_STEPS);
				}
			}
			if (morph.end && morph.end.length > 0.0001) {
				for (let k = 1; k <= ZONE_STEPS; k++) {
					boundaries.push(startShift + innerTotal - (morph.end.length * k) / ZONE_STEPS);
				}
			}
			for (const at of boundaries) {
				const last = cumulative[cumulative.length - 1];
				if (at <= 0.001 || at >= last - 0.001) continue;
				// A vertex landing on an existing one would create a
				// degenerate sliver triangle that flickers.
				if (cumulative.some((d) => Math.abs(d - at) < 0.01)) continue;

				for (let i = 1; i < points.length; i++) {
					if (cumulative[i] <= at + 0.001) continue;

					const span = cumulative[i] - cumulative[i - 1];
					const t = span > 0.0001 ? (at - cumulative[i - 1]) / span : 0;
					const a = points[i - 1];
					const b = points[i];
					let nx = a.normalX + (b.normalX - a.normalX) * t;
					let ny = a.normalY + (b.normalY - a.normalY) * t;
					const nl = Math.hypot(nx, ny);
					if (nl > 0.0001) {
						nx /= nl;
						ny /= nl;
					}
					points.splice(i, 0, {
						x: a.x + (b.x - a.x) * t,
						y: a.y + (b.y - a.y) * t,
						normalX: nx,
						normalY: ny
					});
					cumulative.splice(i, 0, at);
					break;
				}
			}
		}

		const vertices = new Float32Array(points.length * 6);
		for (let i = 0; i < points.length; i++) {
			const p = points[i];

			let oA = offsetA;
			let oB = offsetB;
			if (morph) {
				const fromStart = cumulative[i] - startShift;
				const fromEnd = innerTotal - fromStart;
				if (morph.start && morph.start.length > 0.0001) {
					const f = morphEase(fromStart, morph.start.length);
					oA = morph.start.offsetA + (oA - morph.start.offsetA) * f;
					oB = morph.start.offsetB + (oB - morph.start.offsetB) * f;
				}
				if (morph.end && morph.end.length > 0.0001) {
					const f = morphEase(fromEnd, morph.end.length);
					oA = morph.end.offsetA + (oA - morph.end.offsetA) * f;
					oB = morph.end.offsetB + (oB - morph.end.offsetB) * f;
				}
			}

			vertices[i * 6] = p.x + p.normalX * oA;
			vertices[i * 6 + 1] = y;
			vertices[i * 6 + 2] = p.y + p.normalY * oA;
			vertices[i * 6 + 3] = p.x + p.normalX * oB;
			vertices[i * 6 + 4] = y;
			vertices[i * 6 + 5] = p.y + p.normalY * oB;
		}

		const indices: number[] = [];
		for (let i = 0; i < points.length - 1; i++) {
			const base = i * 2;
			indices.push(base, base + 1, base + 2);
			indices.push(base + 1, base + 3, base + 2);
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
		geometry.setIndex(indices);

		return new THREE.Mesh(geometry, this.materialFor(layerId));
	}

	private buildLayerGroup(layers: RoadLayer[], jitter: number): THREE.Group {
		const group = new THREE.Group();

		for (const layer of layers) {
			const shapes = layer.polygons.map((polygon) => toShape(polygon));
			if (shapes.length === 0) continue;

			const geometry = new THREE.ShapeGeometry(shapes);
			geometry.rotateX(Math.PI / 2);

			const mesh = new THREE.Mesh(geometry, this.materialFor(layer.id));
			mesh.position.y = LAYER_Y[layer.id] + this.elevation + jitter;
			group.add(mesh);
		}

		return group;
	}

	private materialFor(layerId: RoadLayerId): THREE.MeshBasicMaterial {
		let material = this.materials.get(layerId);
		if (!material) {
			material = new THREE.MeshBasicMaterial({
				color: new THREE.Color(LAYER_COLORS[layerId]),
				side: THREE.DoubleSide,
				transparent: this.opacity < 1,
				opacity: this.opacity
			});
			this.materials.set(layerId, material);
		}
		return material;
	}

	private jitterFor(key: string): number {
		let jitter = this.jitters.get(key);
		if (jitter === undefined) {
			jitter = (this.jitterCounter++ % PIECE_JITTER_SLOTS) * PIECE_JITTER_STEP;
			this.jitters.set(key, jitter);
		}
		return jitter;
	}

	private removePiece(key: string) {
		const piece = this.pieces.get(key);
		if (!piece) return;

		disposeGroup(piece.group);
		this.rootGroup.remove(piece.group);
		this.pieces.delete(key);
	}

	private clearGhost() {
		if (!this.ghostGroup) return;
		disposeGroup(this.ghostGroup);
		this.rootGroup.remove(this.ghostGroup);
		this.ghostGroup = null;
	}

	clear() {
		this.clearGhost();
		for (const key of [...this.pieces.keys()]) {
			this.removePiece(key);
		}
	}

	dispose() {
		this.clear();
		for (const material of this.materials.values()) {
			material.dispose();
		}
		this.materials.clear();
		for (const material of this.paintMaterials.values()) {
			material.dispose();
		}
		this.paintMaterials.clear();
		this.scene.remove(this.rootGroup);
	}
}

// Which side of the segment the branching roads sit on at this node, as a
// sign on the centerline normal: turn arrows bend toward the branch. The
// continuation arm is nearly collinear and contributes ~nothing; zero
// means no branch (or perfectly balanced ones).
function turnBranchSign(
	graph: Graph,
	node: { id: string; x: number; y: number; connectedSegments: string[] },
	segment: { id: string },
	samples: CenterlineSample[],
	atStart: boolean
): number {
	const stop = atStart ? samples[0] : samples[samples.length - 1];
	const inner = atStart ? samples[1] : samples[samples.length - 2];
	let tx = atStart ? inner.x - stop.x : stop.x - inner.x;
	let ty = atStart ? inner.y - stop.y : stop.y - inner.y;
	const tl = Math.hypot(tx, ty);
	if (tl < 0.0001) return 0;
	tx /= tl;
	ty /= tl;

	let sum = 0;
	for (const otherId of node.connectedSegments) {
		if (otherId === segment.id) continue;
		const other = graph.segments.get(otherId);
		if (!other || !other.lanes.some((lane) => laneSurface(lane.type) === 'roadway')) continue;
		const farId = other.startNodeId === node.id ? other.endNodeId : other.startNodeId;
		const far = graph.nodes.get(farId);
		if (!far) continue;
		const vx = far.x - node.x;
		const vy = far.y - node.y;
		const vl = Math.hypot(vx, vy);
		if (vl < 0.0001) continue;
		sum += (tx * vy - ty * vx) / vl;
	}
	if (Math.abs(sum) < 0.2) return 0;
	return Math.sign(sum);
}

// Materials are shared per layer, so only geometries are disposed here.
function disposeGroup(group: THREE.Group) {
	group.traverse((object) => {
		if (object instanceof THREE.Mesh) {
			object.geometry.dispose();
		}
	});
}

// Eased morph factor: 0 at the node (target cross-section), 1 inside the
// segment. The width change holds at the target for a short margin before
// the node — the bend zone then has a constant cross-section and renders
// like a same-road bend — and follows a smoothstep so tapers curve like
// real road geometry instead of straight chamfers.
function morphEase(distance: number, length: number) {
	const margin = Math.min(2.5, length * 0.2);
	const f = Math.min(1, Math.max(0, (distance - margin) / Math.max(0.0001, length - margin)));
	return f * f * (3 - 2 * f);
}

// First (or last) `length` units of a centerline, with an interpolated
// final sample so the cut lands exactly at the requested distance.
function sliceCenterline(
	samples: CenterlineSample[],
	at: 'start' | 'end',
	length: number
): CenterlineSample[] {
	const points = at === 'start' ? samples : [...samples].reverse();
	const out: CenterlineSample[] = [points[0]];
	let accumulated = 0;

	for (let i = 1; i < points.length; i++) {
		const previous = points[i - 1];
		const current = points[i];
		const span = Math.hypot(current.x - previous.x, current.y - previous.y);
		if (span < 0.0001) continue;

		if (accumulated + span >= length) {
			const t = (length - accumulated) / span;
			out.push({
				x: previous.x + (current.x - previous.x) * t,
				y: previous.y + (current.y - previous.y) * t,
				normalX: current.normalX,
				normalY: current.normalY
			});
			break;
		}

		out.push(current);
		accumulated += span;
	}

	if (at === 'end') out.reverse();
	return out;
}

function extendSamples(
	samples: CenterlineSample[],
	extendStart: number,
	extendEnd: number
): CenterlineSample[] {
	if (extendStart <= 0 && extendEnd <= 0) return samples;

	const result = [...samples];

	if (extendStart > 0) {
		const a = samples[0];
		const b = samples[1];
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length > 0.0001) {
			result.unshift({
				x: a.x - ((b.x - a.x) / length) * extendStart,
				y: a.y - ((b.y - a.y) / length) * extendStart,
				normalX: a.normalX,
				normalY: a.normalY
			});
		}
	}

	if (extendEnd > 0) {
		const a = samples[samples.length - 1];
		const b = samples[samples.length - 2];
		const length = Math.hypot(a.x - b.x, a.y - b.y);
		if (length > 0.0001) {
			result.push({
				x: a.x + ((a.x - b.x) / length) * extendEnd,
				y: a.y + ((a.y - b.y) / length) * extendEnd,
				normalX: a.normalX,
				normalY: a.normalY
			});
		}
	}

	return result;
}

function toShape(polygon: PolygonWithHoles): THREE.Shape {
	const shape = new THREE.Shape(toVector2Loop(polygon.outer));
	for (const hole of polygon.holes) {
		shape.holes.push(new THREE.Path(toVector2Loop(hole)));
	}
	return shape;
}

function toVector2Loop(points: Point[]): THREE.Vector2[] {
	return points.map((point) => new THREE.Vector2(point.x, point.y));
}
