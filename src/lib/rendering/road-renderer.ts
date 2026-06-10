import * as THREE from 'three';
import type { Graph } from '../core/graph.svelte';
import {
	buildNodeLayers,
	computeIntersectionTrims,
	getLaneIntervals,
	getMedianBreakTrim,
	sampleTrimmedCenterline,
	trimCenterline
} from '../core/road-geometry';
import type {
	CenterlineSample,
	Point,
	PolygonWithHoles,
	RoadLayer,
	RoadLayerId
} from '../core/road-geometry';
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
			const medianTrimStart = getMedianBreakTrim(graph, startNode);
			const medianTrimEnd = getMedianBreakTrim(graph, endNode);
			// At two-segment same-type nodes the node piece carries medians and
			// grass through (bend wedges or corner bands), so those strips
			// overlap it like the other layers; at junctions they must stop
			// square at the stop line.
			const continuityJoinStart = startNode.connectedSegments.length === 2 && medianTrimStart === 0;
			const continuityJoinEnd = endNode.connectedSegments.length === 2 && medianTrimEnd === 0;
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
				medianTrimStart,
				medianTrimEnd,
				continuityJoinStart,
				continuityJoinEnd
			].join('|');

			seen.add(key);
			if (this.pieces.get(key)?.hash === hash) continue;

			this.removePiece(key);
			const group = this.buildSegmentGroup(
				segment.lanes,
				samples,
				joinStart,
				joinEnd,
				medianTrimStart,
				medianTrimEnd,
				continuityJoinStart,
				continuityJoinEnd,
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
		medianTrimStart: number,
		medianTrimEnd: number,
		continuityJoinStart: boolean,
		continuityJoinEnd: boolean,
		jitter: number
	): THREE.Group {
		const group = new THREE.Group();
		if (lanes.length === 0) return group;

		const halfWidth = getTotalWidth(lanes) / 2;
		const startExt = joinStart ? JOIN_OVERLAP : 0;
		const endExt = joinEnd ? JOIN_OVERLAP : 0;

		// Full-width pavement plate rendered as the sidewalk layer; the lane
		// strips above carve out the visible sidewalk edges.
		group.add(
			this.buildStrip(samples, -halfWidth, halfWidth, 'sidewalk', startExt, endExt, jitter)
		);

		for (const interval of getLaneIntervals(lanes)) {
			if (interval.laneType === 'sidewalk') continue;

			if (interval.laneType === 'road') {
				group.add(
					this.buildStrip(samples, interval.start, interval.end, 'road', startExt, endExt, jitter)
				);
				continue;
			}

			if (interval.laneType === 'grass') {
				group.add(
					this.buildStrip(
						samples,
						interval.start,
						interval.end,
						'grass',
						continuityJoinStart ? JOIN_OVERLAP : 0,
						continuityJoinEnd ? JOIN_OVERLAP : 0,
						jitter
					)
				);
				continue;
			}

			let laneSamples = samples;
			if (interval.laneType === 'median' && (medianTrimStart > 0 || medianTrimEnd > 0)) {
				laneSamples = trimCenterline(samples, medianTrimStart, medianTrimEnd);
				if (laneSamples.length < 2) continue;
			}
			group.add(
				this.buildStrip(
					laneSamples,
					interval.start,
					interval.end,
					interval.laneType,
					continuityJoinStart ? JOIN_OVERLAP : 0,
					continuityJoinEnd ? JOIN_OVERLAP : 0,
					jitter
				)
			);
		}

		return group;
	}

	private buildStrip(
		samples: CenterlineSample[],
		offsetA: number,
		offsetB: number,
		layerId: RoadLayerId,
		extendStart: number,
		extendEnd: number,
		jitter: number
	): THREE.Mesh {
		const points = extendSamples(samples, extendStart, extendEnd);
		const y = LAYER_Y[layerId] + this.elevation + jitter;

		const vertices = new Float32Array(points.length * 6);
		for (let i = 0; i < points.length; i++) {
			const p = points[i];
			vertices[i * 6] = p.x + p.normalX * offsetA;
			vertices[i * 6 + 1] = y;
			vertices[i * 6 + 2] = p.y + p.normalY * offsetA;
			vertices[i * 6 + 3] = p.x + p.normalX * offsetB;
			vertices[i * 6 + 4] = y;
			vertices[i * 6 + 5] = p.y + p.normalY * offsetB;
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
