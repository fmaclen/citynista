// Draws the road model (src/lib/road-model) into the editor's Three.js scene.
// Its Drawing (road-model/drawing.ts) builds and caches one description per
// road and per node; this turns each into one group of flat meshes
// (road-meshes.ts), rebuilt only when that description was rebuilt.

import * as THREE from 'three';
import type { Graph } from '../core/graph.svelte';
import { PlaceBuilder, type Derived } from '../core/place';
import type { Description } from '../road-model/description';
import { Drawing } from '../road-model/drawing';
import { LAYERS, trianglesOf } from './road-meshes';

// How far a tint (a blocked preview) pulls each colour toward it.
const TINT = 0.7;
// The road model is one flat picture on the ground. Every piece lies in one
// plane, just above the grid, and its layers (LAYERS in road-meshes.ts) are an
// order of painting, not heights: each batch is painted over what is already
// there, bottom layer first (renderOrder), its depth test always passing. So
// there is no step between two surfaces to see under at a tilt, and paint lies
// on what it is painted on. Each still leaves its depth, so the grid below
// stays hidden and whatever stands above the road is drawn over it; and the
// road is painted before anything else in its pass (a negative renderOrder),
// so it never covers something nearer the camera.
const ROAD_Y = 0.07;

export class RoadRenderer {
	private builder = new PlaceBuilder();
	scene: Drawing | null = null;
	derived: Derived | null = null;
	private root = new THREE.Group();
	private overlay = new THREE.Group();
	private pieces = new Map<string, { description: Description; group: THREE.Group }>();
	private materials = new Map<string, THREE.MeshBasicMaterial>();
	private overlayKey = '';
	private tinted: number | null = null;
	showConnections = false;

	constructor(
		private three: THREE.Scene,
		private look: { opacity: number; lift: number } = { opacity: 1, lift: 0 }
	) {
		this.root.position.y = look.lift;
		this.three.add(this.root);
		this.overlay.renderOrder = 10;
		this.three.add(this.overlay);
	}

	// With `only`, draws just those roads and the junctions at those nodes.
	update(graph: Graph, only?: { roads: Set<string>; nodes: Set<string> }) {
		const derived = this.builder.build(graph);
		this.derived = derived;
		const scene = (this.scene ??= new Drawing(derived.place, derived.geos));
		scene.place = derived.place;
		scene.geos = derived.geos;
		scene.build();

		const live = new Set<string>();
		for (const road of derived.place.roads) {
			const description = scene.road(road.id);
			if (!description || (only && !only.roads.has(road.id))) continue;
			live.add(`road:${road.id}`);
			this.place(`road:${road.id}`, description);
		}
		for (const j of derived.place.junctions) {
			const description = scene.node(j.id);
			if (!description || (only && !j.members.some((id) => only.nodes.has(id)))) continue;
			live.add(`junction:${j.id}`);
			this.place(`junction:${j.id}`, description);
		}
		for (const [id, piece] of this.pieces) {
			if (live.has(id)) continue;
			this.dispose(piece.group);
			this.pieces.delete(id);
		}
		this.refreshOverlay();
	}

	// Washes every surface and paint toward one colour (null: their own).
	tint(colour: number | null) {
		if (colour === this.tinted) return;
		this.tinted = colour;
		for (const [colour, m] of this.materials) m.color.copy(this.colourOf(colour));
	}

	private colourOf(colour: string) {
		const own = new THREE.Color(colour);
		return this.tinted === null ? own : own.lerp(new THREE.Color(this.tinted), TINT);
	}

	// Holds a node's taper where it is (while its connections are edited);
	// null lets it follow its connections again.
	holdTaper(nodeId: string | null) {
		this.builder.hold(nodeId);
	}

	// The shortest and longest each road may be set to stop short of a node,
	// by segment id: its side of a taper, or its setback at a junction.
	taperLimits(nodeId: string) {
		return this.builder.limits.get(nodeId);
	}

	setShowConnections(show: boolean) {
		this.showConnections = show;
		this.refreshOverlay();
	}

	private place(id: string, description: Description) {
		const existing = this.pieces.get(id);
		if (existing?.description === description) return;
		if (existing) this.dispose(existing.group);
		const group = new THREE.Group();
		for (const batch of trianglesOf(description)) {
			const positions = new Float32Array((batch.tris.length / 2) * 3);
			for (let i = 0; i < batch.tris.length / 2; i++) {
				positions[i * 3] = batch.tris[i * 2];
				positions[i * 3 + 2] = batch.tris[i * 2 + 1];
			}
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
			const mesh = new THREE.Mesh(geometry, this.material(batch.colour));
			mesh.position.y = ROAD_Y;
			mesh.renderOrder = batch.level - LAYERS.length;
			group.add(mesh);
		}
		this.root.add(group);
		this.pieces.set(id, { description, group });
	}

	private material(colour: string) {
		let m = this.materials.get(colour);
		if (!m) {
			m = new THREE.MeshBasicMaterial({
				color: this.colourOf(colour),
				side: THREE.DoubleSide,
				transparent: this.look.opacity < 1,
				opacity: this.look.opacity,
				depthFunc: THREE.AlwaysDepth
			});
			this.materials.set(colour, m);
		}
		return m;
	}

	// The connection overlay: every stored connection as a dashed line along
	// the curve it drives, with a dot on each lane end (filled where traffic
	// comes in), and every crossing as a line straight across its road
	// between the sidewalks it joins.
	private refreshOverlay() {
		const scene = this.scene;
		const key = this.showConnections
			? [...this.pieces.entries()]
					.map(([id, p]) =>
						`${id}`.concat(String(this.ids.get(p.description) ?? this.tag(p.description)))
					)
					.join('|')
			: '';
		if (key === this.overlayKey) return;
		this.overlayKey = key;
		for (const child of [...this.overlay.children]) this.dispose(child);
		if (!this.showConnections || !scene) return;
		const lineMaterial = new THREE.LineDashedMaterial({
			color: 0x7fd3ff,
			dashSize: 0.8,
			gapSize: 0.6,
			depthTest: false,
			transparent: true
		});
		const inMaterial = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			depthTest: false,
			transparent: true
		});
		const outMaterial = new THREE.MeshBasicMaterial({
			color: 0x111111,
			depthTest: false,
			transparent: true
		});
		const crossingMaterial = new THREE.LineDashedMaterial({
			color: 0xffa94d,
			dashSize: 0.8,
			gapSize: 0.6,
			depthTest: false,
			transparent: true
		});
		const y = ROAD_Y + 0.2;
		for (const road of scene.place.roads) {
			for (const c of scene.road(road.id)?.crossings ?? []) {
				const line = new THREE.Line(
					new THREE.BufferGeometry().setFromPoints(
						c.line.map((p) => new THREE.Vector3(p.x, y, p.y))
					),
					crossingMaterial
				);
				line.computeLineDistances();
				line.renderOrder = 20;
				this.overlay.add(line);
			}
		}
		for (const j of scene.place.junctions) {
			const node = scene.node(j.id);
			if (!node) continue;
			for (const c of node.paths) {
				const geometry = new THREE.BufferGeometry().setFromPoints(
					c.line.map((p) => new THREE.Vector3(p.x, y, p.y))
				);
				const line = new THREE.Line(geometry, lineMaterial);
				line.computeLineDistances();
				line.renderOrder = 20;
				this.overlay.add(line);
			}
			for (const l of node.ends.flatMap((e) => e.lanes)) {
				if (l.flow === 'none') continue;
				const ring = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), outMaterial);
				ring.rotateX(-Math.PI / 2);
				ring.position.set(l.point.x, y, l.point.y);
				ring.renderOrder = 21;
				this.overlay.add(ring);
				if (l.flow === 'in') {
					const dot = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), inMaterial);
					dot.rotateX(-Math.PI / 2);
					dot.position.set(l.point.x, y + 0.01, l.point.y);
					dot.renderOrder = 22;
					this.overlay.add(dot);
				}
			}
		}
	}

	private ids = new WeakMap<object, number>();
	private counter = 0;
	private tag(description: object) {
		const id = this.counter++;
		this.ids.set(description, id);
		return id;
	}

	private dispose(object: THREE.Object3D) {
		object.traverse((o) => {
			if (o instanceof THREE.Mesh || o instanceof THREE.Line) o.geometry.dispose();
		});
		object.removeFromParent();
	}

	clear() {
		for (const piece of this.pieces.values()) this.dispose(piece.group);
		this.pieces.clear();
		for (const child of [...this.overlay.children]) this.dispose(child);
		this.overlayKey = '';
		this.scene = null;
		this.builder = new PlaceBuilder();
	}

	destroy() {
		this.clear();
		for (const m of this.materials.values()) m.dispose();
		this.root.removeFromParent();
		this.overlay.removeFromParent();
	}
}
