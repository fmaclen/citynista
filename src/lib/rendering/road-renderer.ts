import * as THREE from 'three';
import type { Graph } from '../core/graph.svelte';
import {
	buildNodeLayers,
	buildNodePaint,
	computeIntersectionTrims,
	getLaneIntervals,
	isContinuationNode,
	isStopLineJunction,
	nodeThroughPair,
	sampleTrimmedCenterline,
	transitionMorph,
	transitionStraddle
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
	ROAD_LAYER_LIST,
	laneColor,
	laneLayerY,
	lanePaintBetween,
	surfaceClassOf
} from '../core/lane-types';
import type { Lane } from '../core/types';
import {
	activeConnectionsAt,
	centerCrossedAt,
	type LaneConnection
} from '../core/lane-connections';

const LAYER_Y: Record<RoadLayerId, number> = Object.fromEntries(
	ROAD_LAYER_LIST.map((layer) => [layer, laneLayerY(layer)])
) as Record<RoadLayerId, number>;

const LAYER_COLORS: Record<RoadLayerId, string> = Object.fromEntries(
	ROAD_LAYER_LIST.map((layer) => [layer, laneColor(layer)])
) as Record<RoadLayerId, string>;

const TOP_LAYER_Y = Math.max(...ROAD_LAYER_LIST.map((layer) => laneLayerY(layer)));
const ROADWAY_UNDERFILL_Y = LAYER_Y.plate + 0.025;

// Segment ribbons reach slightly into their node pieces so no hairline
// cracks can open between them.
const JOIN_OVERLAP = 0.5;

// Extend a centerline straight past one end, along its end tangent and keeping
// the end's normal — used so a transition's wide ribbon carries its taper past
// the node (collinear with the narrow side) for a single ramp straddling it.
function extendCenterline(
	samples: CenterlineSample[],
	atStart: boolean,
	distance: number
): CenterlineSample[] {
	if (samples.length < 2 || distance <= 0.01) return samples;
	const b = atStart ? samples[0] : samples[samples.length - 1];
	const a = atStart ? samples[1] : samples[samples.length - 2];
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 0.0001) return samples;
	const ux = dx / len;
	const uy = dy / len;
	const extra: CenterlineSample[] = [];
	const step = 1.5;
	for (let d = step; d < distance; d += step) {
		extra.push({ x: b.x + ux * d, y: b.y + uy * d, normalX: b.normalX, normalY: b.normalY });
	}
	extra.push({
		x: b.x + ux * distance,
		y: b.y + uy * distance,
		normalX: b.normalX,
		normalY: b.normalY
	});
	return atStart ? [...extra.reverse(), ...samples] : [...samples, ...extra];
}

// Lane paint: thin stripes drawn on the lane boundaries the strips already
// define. Dashed white between same-direction travel lanes, solid white
// against accessory lanes (bike, parking, transit), solid muted yellow
// between opposing flows. Paint renders above every roadway color but
// below medians, follows transition morphs, and stops short of junction
// mouths — junction interiors stay unpainted until crosswalks exist.
// Above every lane layer including raised buffers, so crossings can carry
// pedestrian pavement over them; still below the interaction layers.
const PAINT_Y = TOP_LAYER_Y + 0.02;
const PAINT_WIDTH = 0.16;
const CENTER_DOUBLE_OFFSET = 0.16;
const PAINT_DASH = 2.2;
const PAINT_GAP = 2.6;
const PAINT_SOLID_STEP = 2.5;
const PAINT_END_INSET = 0.2;
// How far short of a node the solid centre line stops when a movement crosses
// it there — a gap wide enough to read as a break, not a dashed continuation.
const CENTER_BREAK_INSET = 3.5;
const THROUGH_DOT = Math.cos(Math.PI / 6);
const ARROW_END_INSET = 4;
const ARROW_FIT = 3;
// An unmatched island winding down to a nose ends square once it narrows
// below this width, instead of riding to the seam as a sliver. A matched
// island continuing into a real (non-zero) counterpart is exempt.
const ISLAND_MIN_WIDTH = 0.8;
const NOSE_TARGET_EPS = 1e-3;
const PAINT_COLORS = { lane: '#C9C9C0', center: '#C3B47C', walk: '#9A9A94' } as const;
type PaintColor = keyof typeof PAINT_COLORS;
type ArrowMovement = 'left' | 'through' | 'right';
type CenterNoseFill = { ownCenter: number; nodeOffset: number; cut: number; end: 'start' | 'end' };
const ARROW_MOVEMENTS: ArrowMovement[] = ['left', 'through', 'right'];
const ARROW_CODES: Record<ArrowMovement, string> = { left: 'L', through: 'S', right: 'R' };

interface LaneArrowSet {
	laneIndex: number;
	movements: ArrowMovement[];
	signature: string;
}

interface SegmentEndArrows {
	signature: string;
	lanes: LaneArrowSet[];
}

const EMPTY_END_ARROWS: SegmentEndArrows = { signature: '-', lanes: [] };
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

function segmentEndKey(nodeId: string, segmentId: string) {
	return `${nodeId}:${segmentId}`;
}

function movementSignature(movements: Set<ArrowMovement>) {
	return ARROW_MOVEMENTS.filter((movement) => movements.has(movement))
		.map((movement) => ARROW_CODES[movement])
		.join('');
}

function classifyMovement(connection: LaneConnection) {
	if (connection.from.segmentId === connection.to.segmentId) return null;
	const fromLength = Math.hypot(connection.fromDir.x, connection.fromDir.y);
	const toLength = Math.hypot(connection.toDir.x, connection.toDir.y);
	if (fromLength < 0.0001 || toLength < 0.0001) return null;

	const fromX = connection.fromDir.x / fromLength;
	const fromY = connection.fromDir.y / fromLength;
	const toX = connection.toDir.x / toLength;
	const toY = connection.toDir.y / toLength;
	const dot = fromX * toX + fromY * toY;
	if (dot >= THROUGH_DOT) return 'through';

	const cross = fromX * toY - fromY * toX;
	if (cross > 0.0001) return 'left';
	if (cross < -0.0001) return 'right';
	return null;
}

function buildArrowsByEnd(
	graph: Graph,
	centerlines: Map<string, CenterlineSample[]>,
	activeConnectionsByNode: Map<string, LaneConnection[]>
) {
	const grouped = new Map<string, Map<number, Set<ArrowMovement>>>();

	for (const node of graph.nodes.values()) {
		if (!isStopLineJunction(graph, node)) continue;
		for (const connection of activeConnectionsByNode.get(node.id) ?? []) {
			const movement = classifyMovement(connection);
			if (!movement) continue;

			const segment = graph.segments.get(connection.from.segmentId);
			const samples = centerlines.get(connection.from.segmentId);
			const lane = segment?.lanes[connection.from.laneIndex];
			if (!segment || !samples || !lane || lane.markings === false) continue;

			const endKey = segmentEndKey(node.id, connection.from.segmentId);
			const lanes = grouped.get(endKey) ?? new Map<number, Set<ArrowMovement>>();
			grouped.set(endKey, lanes);
			const movements = lanes.get(connection.from.laneIndex) ?? new Set<ArrowMovement>();
			lanes.set(connection.from.laneIndex, movements);
			movements.add(movement);
		}
	}

	const arrowsByEnd = new Map<string, SegmentEndArrows>();
	for (const [endKey, lanes] of grouped) {
		const laneSets: LaneArrowSet[] = [];
		for (const [laneIndex, movements] of [...lanes].sort((a, b) => a[0] - b[0])) {
			const signature = movementSignature(movements);
			if (!signature) continue;
			laneSets.push({
				laneIndex,
				movements: ARROW_MOVEMENTS.filter((movement) => movements.has(movement)),
				signature
			});
		}
		arrowsByEnd.set(endKey, {
			signature:
				laneSets.length === 0
					? '-'
					: laneSets.map((lane) => `${lane.laneIndex}:${lane.signature}`).join(','),
			lanes: laneSets
		});
	}
	return arrowsByEnd;
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

		// A straight width-transition straddles its node: the wide side extends
		// half its taper past the node and the narrow side trims back the same
		// amount, so the taper reads as one ramp centred on the node.
		const straddleTrim = new Map<string, { start: number; end: number }>();
		const straddleExtend = new Map<string, { start: number; end: number }>();
		for (const node of graph.nodes.values()) {
			const s = transitionStraddle(graph, node);
			if (!s) continue;
			const t = straddleTrim.get(s.narrowId) ?? { start: 0, end: 0 };
			if (s.narrowAtStart) t.start += s.half;
			else t.end += s.half;
			straddleTrim.set(s.narrowId, t);
			const e = straddleExtend.get(s.wideId) ?? { start: 0, end: 0 };
			if (s.wideAtStart) e.start += s.half;
			else e.end += s.half;
			straddleExtend.set(s.wideId, e);
		}

		for (const segment of graph.segments.values()) {
			const startNode = graph.nodes.get(segment.startNodeId);
			const endNode = graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const trim = trims.get(segment.id);
			const extra = straddleTrim.get(segment.id);
			let samples = sampleTrimmedCenterline(
				segment,
				startNode,
				endNode,
				(trim?.start ?? 0) + (extra?.start ?? 0),
				(trim?.end ?? 0) + (extra?.end ?? 0)
			);
			const ext = straddleExtend.get(segment.id);
			if (ext && samples.length >= 2) {
				if (ext.start > 0) samples = extendCenterline(samples, true, ext.start);
				if (ext.end > 0) samples = extendCenterline(samples, false, ext.end);
			}
			if (samples.length >= 2) {
				centerlines.set(segment.id, samples);
			}
		}

		const activeConnectionsByNode = new Map<string, LaneConnection[]>();
		for (const node of graph.nodes.values()) {
			activeConnectionsByNode.set(node.id, activeConnectionsAt(graph, node, centerlines));
		}
		const arrowsByEnd = buildArrowsByEnd(graph, centerlines, activeConnectionsByNode);

		// A node where an active movement carries traffic across the through
		// road's centreline breaks the solid centre line there; everywhere else
		// it runs through. Computed once so both the segments meeting the node
		// and the node piece agree.
		const centerBreak = new Map<string, Set<string>>();
		for (const node of graph.nodes.values()) {
			if (!centerCrossedAt(graph, node, centerlines, activeConnectionsByNode.get(node.id)))
				continue;
			const pair = nodeThroughPair(graph, node);
			if (pair) centerBreak.set(node.id, new Set(pair.map((segment) => segment.id)));
		}

		const seen = new Set<string>();

		for (const segment of graph.segments.values()) {
			const samples = centerlines.get(segment.id);
			if (!samples) continue;

			const startNode = graph.nodes.get(segment.startNodeId)!;
			const endNode = graph.nodes.get(segment.endNodeId)!;
			const centerBreakStart = centerBreak.get(startNode.id)?.has(segment.id) ?? false;
			const centerBreakEnd = centerBreak.get(endNode.id)?.has(segment.id) ?? false;
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
			const arrowStart =
				arrowsByEnd.get(segmentEndKey(startNode.id, segment.id)) ?? EMPTY_END_ARROWS;
			const arrowEnd = arrowsByEnd.get(segmentEndKey(endNode.id, segment.id)) ?? EMPTY_END_ARROWS;
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
				straddleTrim.get(segment.id)?.start ?? 0,
				straddleTrim.get(segment.id)?.end ?? 0,
				straddleExtend.get(segment.id)?.start ?? 0,
				straddleExtend.get(segment.id)?.end ?? 0,
				joinStart,
				joinEnd,
				continuityJoinStart,
				continuityJoinEnd,
				morphStart?.key ?? '-',
				morphEnd?.key ?? '-',
				arrowStart.signature,
				arrowEnd.signature,
				centerBreakStart,
				centerBreakEnd
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
				arrowStart,
				arrowEnd,
				centerBreakStart,
				centerBreakEnd,
				this.jitterFor(key)
			);
			this.rootGroup.add(group);
			this.pieces.set(key, { hash, group });
		}

		for (const node of graph.nodes.values()) {
			if (node.connectedSegments.length < 2) continue;

			const key = `node:${node.id}`;
			const parts: string[] = [`${node.x},${node.y}`];
			const centerBroken = centerBreak.has(node.id);
			parts.push(`cb:${centerBroken}`);
			// Connector overrides carve the junction pavement and can decide
			// whether the centre line breaks, so they belong in the piece hash.
			if (node.disabledConnections?.length) {
				parts.push(
					'dc:' +
						node.disabledConnections
							.map(
								(c) => `${c.from.segmentId}.${c.from.laneIndex}>${c.to.segmentId}.${c.to.laneIndex}`
							)
							.sort()
							.join(',')
				);
			}
			if (node.enabledConnections?.length) {
				parts.push(
					'ec:' +
						node.enabledConnections
							.map(
								(c) => `${c.from.segmentId}.${c.from.laneIndex}>${c.to.segmentId}.${c.to.laneIndex}`
							)
							.sort()
							.join(',')
				);
			}
			for (const segmentId of [...node.connectedSegments].sort()) {
				const segment = graph.segments.get(segmentId);
				const samples = centerlines.get(segmentId);
				if (!segment || !samples) continue;

				const isStart = segment.startNodeId === node.id;
				const stop = isStart ? samples[0] : samples[samples.length - 1];
				const inner = isStart ? samples[1] : samples[samples.length - 2];
				parts.push(
					`${segmentId}:${segment.lanesKey}:${stop.x},${stop.y},${inner.x},${inner.y},${stop.normalX},${stop.normalY}`
				);
			}
			const hash = parts.join('|');

			seen.add(key);
			if (this.pieces.get(key)?.hash === hash) continue;

			this.removePiece(key);
			const jitterValue = this.jitterFor(key);
			const crossingConnectors = (activeConnectionsByNode.get(node.id) ?? []).map((connection) => ({
				a: connection.fromPoint,
				b: connection.toPoint
			}));
			const group = this.buildLayerGroup(
				buildNodeLayers(graph, node, centerlines, crossingConnectors),
				jitterValue
			);
			for (const mesh of this.buildNodePaintMeshes(
				buildNodePaint(graph, node, centerlines, centerBroken),
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
		arrowStart: SegmentEndArrows,
		arrowEnd: SegmentEndArrows,
		centerBreakStart: boolean,
		centerBreakEnd: boolean,
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

		// Full-width neutral plate; pavement walkways simply let it show
		// through, while other material lanes draw above it.
		group.add(
			this.buildStrip(samples, -halfWidth, halfWidth, 'plate', startExt, endExt, jitter, {
				start: morphStart
					? { length: lengthStart, offsetA: -morphStart.halfWidth, offsetB: morphStart.halfWidth }
					: undefined,
				end: morphEnd
					? { length: lengthEnd, offsetA: -morphEnd.halfWidth, offsetB: morphEnd.halfWidth }
					: undefined
			})
		);

		const intervals = getLaneIntervals(lanes);
		const centerFills: CenterNoseFill[] = [];
		for (let k = 0; k < intervals.length; k++) {
			const interval = intervals[k];
			const surface = surfaceClassOf(interval.laneType);
			if (interval.laneType === 'walkway:pavement') continue;

			const targetStart = morphStart ? morphStart.intervals[k] : undefined;
			const targetEnd = morphEnd ? morphEnd.intervals[k] : undefined;
			const underfillStart = morphStart ? morphStart.roadwayUnderfills[k] : undefined;
			const underfillEnd = morphEnd ? morphEnd.roadwayUnderfills[k] : undefined;
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

			if (underfillStart || underfillEnd) {
				const layerId = (underfillStart ?? underfillEnd)!.laneType;
				const stubSafeStart = continuityJoinStart || layerId === 'roadway:asphalt';
				const stubSafeEnd = continuityJoinEnd || layerId === 'roadway:asphalt';
				group.add(
					this.buildStrip(
						samples,
						interval.start,
						interval.end,
						layerId,
						stubSafeStart ? startExt : 0,
						stubSafeEnd ? endExt : 0,
						jitter,
						{
							start: underfillStart
								? {
										length: lengthStart,
										offsetA: underfillStart.start,
										offsetB: underfillStart.end
									}
								: undefined,
							end: underfillEnd
								? { length: lengthEnd, offsetA: underfillEnd.start, offsetB: underfillEnd.end }
								: undefined
						},
						ROADWAY_UNDERFILL_Y
					)
				);
			}

			if (surface === 'roadway') {
				// Overlap stubs past a node are only invisible for plain road
				// (they hide under the asphalt patch or the neighbor's road);
				// every other lane draws above road and would show them.
				// At transition seams both ribbons arrive at the anchor's
				// offsets vertex-for-vertex, so a road stub hides inside the
				// counterpart's roadway exactly like at continuations.
				const stubSafeStart = continuityJoinStart || interval.laneType === 'roadway:asphalt';
				const stubSafeEnd = continuityJoinEnd || interval.laneType === 'roadway:asphalt';
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
			// An unmatched island whose target winds it down to a nose ends in a
			// square cut where it crosses the usable-width threshold — never a
			// sliver wall. A matched island continuing into a real counterpart
			// (non-zero target) rides to the seam however narrow, meeting it
			// instead of exposing the plate. The morph restarts from the eased
			// cross-section at the cut, so the visible taper stays smooth.
			const ownWidth = interval.end - interval.start;
			const pinch = (target: { start: number; end: number } | null | undefined, length: number) => {
				if (!target) return null;
				const targetWidth = target.end - target.start;
				if (targetWidth > NOSE_TARGET_EPS || ownWidth <= targetWidth) return null;
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
			if (morphStart?.centerNose?.index === k && cutStart > 0.3) {
				centerFills.push({
					ownCenter: (interval.start + interval.end) / 2,
					nodeOffset: morphStart.centerNose.offset,
					cut: cutStart,
					end: 'start'
				});
			}
			if (morphEnd?.centerNose?.index === k && cutEnd > 0.3) {
				centerFills.push({
					ownCenter: (interval.start + interval.end) / 2,
					nodeOffset: morphEnd.centerNose.offset,
					cut: cutEnd,
					end: 'end'
				});
			}
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
			arrowStart,
			arrowEnd,
			continuityJoinStart,
			continuityJoinEnd,
			centerBreakStart,
			centerBreakEnd,
			centerFills,
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
		arrowStart: SegmentEndArrows,
		arrowEnd: SegmentEndArrows,
		continuityJoinStart: boolean,
		continuityJoinEnd: boolean,
		centerBreakStart: boolean,
		centerBreakEnd: boolean,
		centerFills: CenterNoseFill[],
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
		const pointAt = (d: number, offset: number) => {
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
			return {
				x: a.x + (b.x - a.x) * t + nx * offset,
				z: a.y + (b.y - a.y) * t + ny * offset,
				nx,
				ny
			};
		};
		const strokeSolid = (from: number, to: number, offsetAt: (d: number) => number) => {
			if (to - from < 0.5) return;
			const target = positions.center;
			const half = PAINT_WIDTH / 2;
			for (const lateral of [CENTER_DOUBLE_OFFSET, -CENTER_DOUBLE_OFFSET]) {
				let d = from;
				let previous = pointAt(d, offsetAt(d) + lateral);
				while (d < to - 0.05) {
					const end = Math.min(d + PAINT_SOLID_STEP, to);
					if (end - d < 0.3) break;
					const p2 = pointAt(end, offsetAt(end) + lateral);
					target.push(
						previous.x - previous.nx * half,
						0,
						previous.z - previous.ny * half,
						previous.x + previous.nx * half,
						0,
						previous.z + previous.ny * half,
						p2.x - p2.nx * half,
						0,
						p2.z - p2.ny * half,
						previous.x + previous.nx * half,
						0,
						previous.z + previous.ny * half,
						p2.x + p2.nx * half,
						0,
						p2.z + p2.ny * half,
						p2.x - p2.nx * half,
						0,
						p2.z - p2.ny * half
					);
					previous = p2;
					d = end;
				}
			}
		};

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

			// Boundary disposition comes from the transition morph. A matched
			// boundary draws through the taper and follows its target offset;
			// an unmatched boundary cuts where the morph zone begins.
			let from = continuityJoinStart || morphStart ? 0 : PAINT_END_INSET;
			let to = total - (continuityJoinEnd || morphEnd ? 0 : PAINT_END_INSET);
			if (morphStart && startTarget == null) from = Math.max(from, lengthStart);
			if (morphEnd && endTarget == null) to = Math.min(to, total - lengthEnd);

			// The solid centre line stops short of a node where a movement crosses
			// it (a slip/turn/U-turn opening the carriageway) so it breaks there
			// instead of running straight through the diverging traffic.
			if (paint.color === 'center') {
				if (centerBreakStart) from = Math.max(from, CENTER_BREAK_INSET);
				if (centerBreakEnd) to = Math.min(to, total - CENTER_BREAK_INSET);
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
			const target = positions[paint.color];
			const stepLength = paint.dashed ? PAINT_DASH : PAINT_SOLID_STEP;
			const gap = paint.dashed ? PAINT_GAP : 0;
			const half = PAINT_WIDTH / 2;
			const walkStroke = (lateral: number) => {
				let d = from;
				let previous = pointAt(d, offsetAt(d) + lateral);
				while (d < to - 0.05) {
					const end = Math.min(d + stepLength, to);
					if (end - d < 0.3) break;
					const p1 = gap === 0 ? previous : pointAt(d, offsetAt(d) + lateral);
					const p2 = pointAt(end, offsetAt(end) + lateral);
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
			};
			if (paint.color === 'center') {
				walkStroke(CENTER_DOUBLE_OFFSET);
				walkStroke(-CENTER_DOUBLE_OFFSET);
			} else {
				walkStroke(0);
			}
		}

		for (const fill of centerFills) {
			const from = fill.end === 'start' ? 0 : total - fill.cut;
			const to = fill.end === 'start' ? fill.cut : total;
			const morphLength = fill.end === 'start' ? lengthStart : lengthEnd;
			strokeSolid(from, to, (d) => {
				const along = fill.end === 'start' ? d : total - d;
				const f = morphLength > 0.0001 ? morphEase(along, morphLength) : 1;
				return fill.nodeOffset + (fill.ownCenter - fill.nodeOffset) * f;
			});
		}

		const laneCenters: number[] = [];
		let laneStart = -halfWidth;
		for (const lane of lanes) {
			const laneEnd = laneStart + lane.width;
			laneCenters.push((laneStart + laneEnd) / 2);
			laneStart = laneEnd;
		}

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

		const quad = (
			ax: number,
			az: number,
			bx: number,
			bz: number,
			sideX: number,
			sideY: number,
			w: number
		) => {
			const target = positions.lane;
			target.push(
				ax - sideX * w,
				0,
				az - sideY * w,
				ax + sideX * w,
				0,
				az + sideY * w,
				bx - sideX * w,
				0,
				bz - sideY * w,
				ax + sideX * w,
				0,
				az + sideY * w,
				bx + sideX * w,
				0,
				bz + sideY * w,
				bx - sideX * w,
				0,
				bz - sideY * w
			);
		};

		const drawArrow = (
			d: number,
			offset: number,
			travelSign: number,
			movements: ArrowMovement[],
			laneWidth: number
		) => {
			const p = sampleAt(d);
			const tx = p.tx * travelSign;
			const ty = p.ty * travelSign;
			const leftX = -ty;
			const leftY = tx;
			const target = positions.lane;
			const hasLeft = movements.includes('left');
			const hasThrough = movements.includes('through');
			const hasRight = movements.includes('right');

			// Scale the glyph to the lane so it always fits with margin, and bias
			// the base sideways so a one-sided combo (straight + a single branch)
			// stays visually centred in the lane instead of leaning toward the branch.
			const s = Math.max(0.4, Math.min(0.62, laneWidth * 0.16));
			const w = 0.16 * s;
			const branchLateral = 1.2 * s;
			const lean = (hasLeft ? 1 : 0) - (hasRight ? 1 : 0);
			const recenter = hasThrough && lean !== 0 ? -lean * branchLateral * 0.5 : 0;
			const baseX = p.x + p.nx * offset + leftX * recenter;
			const baseZ = p.z + p.ny * offset + leftY * recenter;

			const head = (tipX: number, tipZ: number, dirX: number, dirY: number) => {
				const sideX = -dirY;
				const sideY = dirX;
				target.push(
					tipX + dirX * 0.85 * s,
					0,
					tipZ + dirY * 0.85 * s,
					tipX + sideX * 0.55 * s,
					0,
					tipZ + sideY * 0.55 * s,
					tipX - sideX * 0.55 * s,
					0,
					tipZ - sideY * 0.55 * s
				);
			};

			if (hasThrough && !hasLeft && !hasRight) {
				const tailX = baseX - tx * 1.6 * s;
				const tailZ = baseZ - ty * 1.6 * s;
				const tipX = baseX + tx * 1.6 * s;
				const tipZ = baseZ + ty * 1.6 * s;
				quad(tailX, tailZ, tipX, tipZ, leftX, leftY, w);
				head(tipX, tipZ, tx, ty);
				return;
			}

			if (!hasThrough && hasLeft !== hasRight) {
				const bendSign = hasLeft ? 1 : -1;
				const bx = leftX * bendSign;
				const by = leftY * bendSign;
				const shiftedBaseX = baseX - bx * 0.9 * s;
				const shiftedBaseZ = baseZ - by * 0.9 * s;
				const stemTailX = shiftedBaseX - tx * 1.7 * s;
				const stemTailZ = shiftedBaseZ - ty * 1.7 * s;
				const elbowX = shiftedBaseX + tx * 0.7 * s;
				const elbowZ = shiftedBaseZ + ty * 0.7 * s;
				quad(stemTailX, stemTailZ, elbowX, elbowZ, leftX, leftY, w);
				const tipX = elbowX + bx * 1.0 * s;
				const tipZ = elbowZ + by * 1.0 * s;
				quad(elbowX, elbowZ, tipX, tipZ, tx, ty, w);
				quad(
					elbowX - bx * 0.18 * s,
					elbowZ - by * 0.18 * s,
					elbowX + bx * 0.18 * s,
					elbowZ + by * 0.18 * s,
					tx,
					ty,
					w
				);
				head(tipX, tipZ, bx, by);
				return;
			}

			const tailX = baseX - tx * 1.8 * s;
			const tailZ = baseZ - ty * 1.8 * s;
			const forkX = baseX + tx * 0.45 * s;
			const forkZ = baseZ + ty * 0.45 * s;
			const straightTipX = baseX + tx * 1.55 * s;
			const straightTipZ = baseZ + ty * 1.55 * s;
			quad(
				tailX,
				tailZ,
				hasThrough ? straightTipX : forkX,
				hasThrough ? straightTipZ : forkZ,
				leftX,
				leftY,
				w
			);
			if (hasThrough) head(straightTipX, straightTipZ, tx, ty);

			const branch = (bendSign: number) => {
				const bx = tx * 0.45 + leftX * bendSign * 0.9;
				const by = ty * 0.45 + leftY * bendSign * 0.9;
				const bl = Math.hypot(bx, by);
				if (bl < 0.0001) return;
				const dirX = bx / bl;
				const dirY = by / bl;
				const sideX = -dirY;
				const sideY = dirX;
				const tipX = forkX + dirX * 1.35 * s;
				const tipZ = forkZ + dirY * 1.35 * s;
				quad(forkX - tx * 0.12 * s, forkZ - ty * 0.12 * s, tipX, tipZ, sideX, sideY, w);
				head(tipX, tipZ, dirX, dirY);
			};

			if (hasLeft) branch(1);
			if (hasRight) branch(-1);
		};

		const usableFrom = (morphStart ? lengthStart : 0) + ARROW_END_INSET + ARROW_FIT;
		const usableTo = total - (morphEnd ? lengthEnd : 0) - ARROW_END_INSET - ARROW_FIT;
		const drawEndArrows = (arrows: SegmentEndArrows, atStart: boolean) => {
			if (arrows.lanes.length === 0 || usableTo < usableFrom) return;
			const base = atStart ? usableFrom : usableTo;
			const travelSign = atStart ? -1 : 1;
			for (const lane of arrows.lanes) {
				const offset = laneCenters[lane.laneIndex];
				if (offset === undefined) continue;
				drawArrow(base, offset, travelSign, lane.movements, lanes[lane.laneIndex]?.width ?? 3);
			}
		};
		drawEndArrows(arrowStart, true);
		drawEndArrows(arrowEnd, false);

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
		morph?: StripMorph,
		yOverride?: number
	): THREE.Mesh {
		const points = extendSamples(samples, extendStart, extendEnd);
		const y = (yOverride ?? LAYER_Y[layerId]) + this.elevation + jitter;

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
