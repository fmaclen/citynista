import * as THREE from 'three';
import type { Graph } from '../core/graph.svelte';
import { buildBlocks } from '../core/blocks';
import type { Point, PolygonWithHoles, SegmentTrims } from '../core/road-geometry';

// City blocks: the enclosed faces of the road graph, filled a touch lighter
// than the open ground so built-up land reads against the countryside.
// Pieces are cached per face and only re-carve (the Clipper work) when a
// boundary segment actually changed.
const BLOCK_COLOR = '#75A982';
const BLOCK_Y = 0.012;

interface Piece {
	hash: string;
	mesh: THREE.Mesh;
}

export class BlockRenderer {
	private scene: THREE.Scene;
	private group: THREE.Group;
	private material: THREE.MeshBasicMaterial;
	private pieces = new Map<string, Piece>();

	constructor(scene: THREE.Scene) {
		this.scene = scene;
		this.group = new THREE.Group();
		this.group.name = 'blocks';
		this.scene.add(this.group);
		this.material = new THREE.MeshBasicMaterial({
			color: new THREE.Color(BLOCK_COLOR),
			side: THREE.DoubleSide
		});
	}

	update(graph: Graph, trims?: SegmentTrims) {
		const blocks = buildBlocks(graph, trims);
		const seen = new Set<string>();

		for (const block of blocks) {
			seen.add(block.key);
			if (this.pieces.get(block.key)?.hash === block.signature) continue;

			this.removePiece(block.key);
			const polygons = block.polygons();
			if (polygons.length === 0) continue;

			const shapes = polygons.map((polygon) => toShape(polygon));
			const geometry = new THREE.ShapeGeometry(shapes);
			geometry.rotateX(Math.PI / 2);

			const mesh = new THREE.Mesh(geometry, this.material);
			mesh.position.y = BLOCK_Y;
			this.group.add(mesh);
			this.pieces.set(block.key, { hash: block.signature, mesh });
		}

		for (const key of [...this.pieces.keys()]) {
			if (!seen.has(key)) {
				this.removePiece(key);
			}
		}
	}

	private removePiece(key: string) {
		const piece = this.pieces.get(key);
		if (!piece) return;
		piece.mesh.geometry.dispose();
		this.group.remove(piece.mesh);
		this.pieces.delete(key);
	}

	clear() {
		for (const key of [...this.pieces.keys()]) {
			this.removePiece(key);
		}
	}

	dispose() {
		this.clear();
		this.material.dispose();
		this.scene.remove(this.group);
	}
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
