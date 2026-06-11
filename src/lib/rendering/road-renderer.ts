import * as THREE from 'three';
import type { Graph } from '../core/graph.svelte';
import {
	buildNodeLayers,
	computeIntersectionTrims,
	getLaneIntervals,
	isContinuationNode,
	medianEndsAtNode,
	sampleTrimmedCenterline,
	transitionMorph,
	trimCenterline
} from '../core/road-geometry';
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
import type { Lane } from '../core/types';

const LAYER_Y: Record<RoadLayerId, number> = {
	sidewalk: 0.02,
	grass: 0.03,
	road: 0.04,
	median: 0.05
};

const LAYER_COLORS: Record<RoadLayerId, string> = {
	sidewalk: '#9A9A94',
	grass: '#52A06B',
	road: '#3D3D3D',
	median: '#6E6E68'
};

// Segment ribbons reach slightly into their node pieces so no hairline
// cracks can open between them.
const JOIN_OVERLAP = 0.5;
// A terminating median pulls back from the stop line and ends in a rounded
// nose: half a disc of the strip's own width, set back by a small gap.
const MEDIAN_NOSE_GAP = 1.5;
const MEDIAN_NOSE_SEGMENTS = 16;
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
	update(graph: Graph) {
		const trims = computeIntersectionTrims(graph);
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
			const continuityJoinStart = isContinuationNode(graph, startNode);
			const continuityJoinEnd = isContinuationNode(graph, endNode);
			const noseStart = medianEndsAtNode(graph, startNode, segment.id);
			const noseEnd = medianEndsAtNode(graph, endNode, segment.id);
			const morphStart = transitionMorph(graph, startNode, segment.id);
			const morphEnd = transitionMorph(graph, endNode, segment.id);
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
				noseStart,
				noseEnd,
				morphStart?.key ?? '-',
				morphEnd?.key ?? '-'
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
				noseStart,
				noseEnd,
				morphStart,
				morphEnd,
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
			const group = this.buildLayerGroup(
				buildNodeLayers(graph, node, centerlines),
				this.jitterFor(key)
			);
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
		noseStart: boolean,
		noseEnd: boolean,
		morphStart: TransitionMorph | null,
		morphEnd: TransitionMorph | null,
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
			if (interval.laneType === 'sidewalk') continue;

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

			if (interval.laneType === 'road') {
				group.add(
					this.buildStrip(
						samples,
						interval.start,
						interval.end,
						'road',
						startExt,
						endExt,
						jitter,
						stripMorph
					)
				);
				continue;
			}

			// Terminating medians pull back and end in a rounded nose; the
			// vacated stretch of the median column is paved over so the nose
			// sits on roadway, not on bare plate. The fill still morphs with
			// the roadway so it meets the other side's center at the blended
			// width.
			if (interval.laneType === 'median' && (noseStart || noseEnd)) {
				const width = interval.end - interval.start;
				const setback = MEDIAN_NOSE_GAP + width / 2;
				const laneSamples = trimCenterline(samples, noseStart ? setback : 0, noseEnd ? setback : 0);
				if (laneSamples.length < 2) continue;

				// The nose only replaces the morph at its own end — a median
				// nosed at a junction must still shift laterally toward a
				// transition at the segment's other end.
				const noseMorph: StripMorph | undefined = stripMorph
					? {
							start: noseStart ? undefined : stripMorph.start,
							end: noseEnd ? undefined : stripMorph.end
						}
					: undefined;
				group.add(
					this.buildStrip(
						laneSamples,
						interval.start,
						interval.end,
						'median',
						0,
						0,
						jitter,
						noseMorph
					)
				);
				const offsetCenter = (interval.start + interval.end) / 2;
				if (noseStart) {
					group.add(this.buildCap(laneSamples, 'start', offsetCenter, width / 2, jitter));
					const fill = sliceCenterline(samples, 'start', setback + width / 2);
					if (fill.length >= 2) {
						group.add(
							this.buildStrip(
								fill,
								interval.start,
								interval.end,
								'road',
								startExt,
								0,
								jitter,
								stripMorph?.start ? { start: stripMorph.start } : undefined
							)
						);
					}
				}
				if (noseEnd) {
					group.add(this.buildCap(laneSamples, 'end', offsetCenter, width / 2, jitter));
					const fill = sliceCenterline(samples, 'end', setback + width / 2);
					if (fill.length >= 2) {
						group.add(
							this.buildStrip(
								fill,
								interval.start,
								interval.end,
								'road',
								0,
								endExt,
								jitter,
								stripMorph?.end ? { end: stripMorph.end } : undefined
							)
						);
					}
				}
				continue;
			}

			// A strip with no counterpart across the transition ends in a
			// square cut exactly where the morph zone begins — never a
			// sliver, and never poking straight into the active taper
			// (trimCenterline caps trims at 45% of the length, so it cannot
			// be used here).
			const cutStart = morphStart && !targetStart ? lengthStart : 0;
			const cutEnd = morphEnd && !targetEnd ? lengthEnd : 0;
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
					continuityJoinStart || (morphStart && targetStart) ? JOIN_OVERLAP : 0,
					continuityJoinEnd || (morphEnd && targetEnd) ? JOIN_OVERLAP : 0,
					jitter,
					stripMorph
				)
			);
		}

		return group;
	}

	// Half-disc closing a median strip's end, flush with the strip's edge.
	private buildCap(
		samples: CenterlineSample[],
		at: 'start' | 'end',
		offsetCenter: number,
		radius: number,
		jitter: number
	): THREE.Mesh {
		const tip = at === 'start' ? samples[0] : samples[samples.length - 1];
		const inner = at === 'start' ? samples[1] : samples[samples.length - 2];

		let tx = tip.x - inner.x;
		let ty = tip.y - inner.y;
		const length = Math.hypot(tx, ty);
		if (length > 0.0001) {
			tx /= length;
			ty /= length;
		}

		const cx = tip.x + tip.normalX * offsetCenter;
		const cy = tip.y + tip.normalY * offsetCenter;
		const y = LAYER_Y.median + this.elevation + jitter;

		// Fan from +normal through the outward tangent to -normal.
		const vertices = new Float32Array((MEDIAN_NOSE_SEGMENTS + 2) * 3);
		vertices[0] = cx;
		vertices[1] = y;
		vertices[2] = cy;
		for (let i = 0; i <= MEDIAN_NOSE_SEGMENTS; i++) {
			const angle = (i / MEDIAN_NOSE_SEGMENTS) * Math.PI;
			const dx = tip.normalX * Math.cos(angle) + tx * Math.sin(angle);
			const dy = tip.normalY * Math.cos(angle) + ty * Math.sin(angle);
			vertices[(i + 1) * 3] = cx + dx * radius;
			vertices[(i + 1) * 3 + 1] = y;
			vertices[(i + 1) * 3 + 2] = cy + dy * radius;
		}

		const indices: number[] = [];
		for (let i = 1; i <= MEDIAN_NOSE_SEGMENTS; i++) {
			indices.push(0, i, i + 1);
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
		geometry.setIndex(indices);

		return new THREE.Mesh(geometry, this.materialFor('median'));
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
