// Draws the road model (src/lib/lab) into the editor's Three.js scene. The
// lab's Scene builds and caches one drawing per road and per junction; this
// turns each drawing into one group of flat meshes, rebuilt only when that
// drawing was rebuilt. Layers stack in the same order as the lab's canvas
// renderer, each a small step above the last.

import * as THREE from 'three';
import type { Paths } from 'clipper-lib';
import type { Graph } from '../core/graph.svelte';
import { PlaceBuilder, type Derived } from '../core/place';
import type { JunctionDraw } from '../lab/junction';
import type { RoadDraw } from '../lab/road';
import { COLOURS, Scene } from '../lab/scene';
import type { Pt, Surface } from '../lab/model';
import { toPolygons } from '../lab/clip';
import { crossSection, frameAt, offsetPoint } from '../lab/geometry';

type Layer =
	| 'pavement'
	| 'trail'
	| 'asphalt'
	| 'dirt'
	| 'grass'
	| 'concrete'
	| 'bars'
	| 'island'
	| 'refuge'
	| 'zebra'
	| 'white'
	| 'yellow';

const ORDER: Layer[] = [
	'pavement',
	'trail',
	'asphalt',
	'dirt',
	'grass',
	'concrete',
	'bars',
	'island',
	'refuge',
	'zebra',
	'white',
	'yellow'
];
// Area fills (paint and crossings keep their exact size).
const SURFACES = new Set<Layer>([
	'pavement',
	'trail',
	'asphalt',
	'dirt',
	'grass',
	'concrete',
	'island',
	'refuge'
]);
const BASE_Y = 0.05;
const STEP = 0.02;
const yOf = (layer: Layer) => BASE_Y + ORDER.indexOf(layer) * STEP;

interface Part {
	layer: Layer;
	colour: string;
	paths?: Paths;
	polys?: Pt[][];
}

function roadParts(draw: RoadDraw): Part[] {
	const fill = (key: 'pavement' | 'trail' | 'dirt' | 'asphalt' | 'grass' | 'concrete'): Part => ({
		layer: key,
		colour: COLOURS[key],
		paths: draw.fills.get(key) ?? []
	});
	return [
		fill('pavement'),
		fill('trail'),
		fill('asphalt'),
		fill('dirt'),
		fill('grass'),
		fill('concrete'),
		...draw.crossings.flatMap((c): Part[] => [
			{ layer: 'refuge', colour: COLOURS.pavement, paths: [...c.refuge, ...c.paving] },
			{ layer: 'zebra', colour: COLOURS.white, paths: c.zebra }
		]),
		{ layer: 'white', colour: COLOURS.white, polys: draw.white },
		{ layer: 'yellow', colour: COLOURS.yellow, polys: draw.yellow }
	];
}

// The paved area keeps the asphalt layer whatever it is made of, so sidewalks
// and verges stack around it the same way.
function junctionParts(draw: JunctionDraw, paving: Surface): Part[] {
	const carried = (surface: 'grass' | 'concrete' | 'dirt' | 'hatch') =>
		draw.carried.filter((c) => c.surface === surface).flatMap((c) => c.paths);
	const parts: Part[] = [
		// Each car lane in the layer its road draws it in.
		...(draw.lanes ?? []).map(
			(l): Part => ({
				layer: l.surface === 'hatch' ? 'asphalt' : l.surface,
				colour: COLOURS[l.surface],
				paths: l.paths
			})
		),
		{ layer: 'pavement', colour: COLOURS.pavement, paths: draw.pavement },
		{ layer: 'trail', colour: COLOURS.trail, paths: draw.trail },
		{ layer: 'asphalt', colour: COLOURS[paving], paths: draw.asphalt },
		{ layer: 'asphalt', colour: COLOURS.asphalt, paths: carried('hatch') },
		{ layer: 'dirt', colour: COLOURS.dirt, paths: carried('dirt') },
		{ layer: 'grass', colour: COLOURS.grass, paths: [...carried('grass'), ...draw.verges] },
		{ layer: 'concrete', colour: COLOURS.concrete, paths: carried('concrete') }
	];
	for (const c of draw.carried)
		if (c.surface === 'hatch')
			parts.push({ layer: 'bars', colour: COLOURS[c.line], paths: c.bars });
	for (const island of draw.islands) {
		parts.push({ layer: 'island', colour: COLOURS[island.surface], paths: [island.path] });
	}
	for (const c of draw.crossings) {
		if (!c.on) continue;
		parts.push({ layer: 'refuge', colour: COLOURS.pavement, paths: [...c.refuge, ...c.paving] });
		parts.push({ layer: 'refuge', colour: COLOURS.trail, paths: c.trail });
		parts.push({ layer: 'zebra', colour: COLOURS.white, paths: c.zebra });
	}
	parts.push({ layer: 'white', colour: COLOURS.white, polys: draw.white });
	parts.push({ layer: 'yellow', colour: COLOURS.yellow, polys: draw.yellow });
	return parts;
}

export class LabRenderer {
	private builder = new PlaceBuilder();
	scene: Scene | null = null;
	derived: Derived | null = null;
	private root = new THREE.Group();
	private overlay = new THREE.Group();
	private pieces = new Map<string, { draw: RoadDraw | JunctionDraw; group: THREE.Group }>();
	private materials = new Map<string, THREE.MeshBasicMaterial>();
	private lastKeys = new Map<string, string>();
	private overlayKey = '';
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
		const scene = this.scene ?? new Scene(derived.place);
		this.scene = scene;
		scene.place = derived.place;
		const keys = new Map<string, string>();
		for (const [id, key] of derived.roadKeys) keys.set(`road:${id}`, key);
		for (const [id, key] of derived.junctionKeys) keys.set(`junction:${id}`, key);
		for (const [id, key] of keys) if (this.lastKeys.get(id) !== key) scene.touch(id);
		this.lastKeys = keys;
		scene.build();

		const live = new Set<string>();
		for (const road of derived.place.roads) {
			const draw = scene.roadDraw(road.id);
			if (!draw || scene.hidden.has(road.id) || (only && !only.roads.has(road.id))) continue;
			live.add(`road:${road.id}`);
			this.place(`road:${road.id}`, draw, () => roadParts(draw));
		}
		for (const j of scene.effective) {
			const draw = scene.junctionDraw(j.id);
			if (!draw || (only && !j.id.split('+').some((id) => only.nodes.has(id)))) continue;
			live.add(`junction:${j.id}`);
			const paving = scene.junctionPaving(j.id);
			this.place(`junction:${j.id}`, draw, () => junctionParts(draw, paving));
		}
		for (const [id, piece] of this.pieces) {
			if (live.has(id)) continue;
			this.dispose(piece.group);
			this.pieces.delete(id);
		}
		this.refreshOverlay();
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

	private place(id: string, draw: RoadDraw | JunctionDraw, parts: () => Part[]) {
		const existing = this.pieces.get(id);
		if (existing?.draw === draw) return;
		if (existing) this.dispose(existing.group);
		const group = new THREE.Group();
		for (const part of parts()) {
			const shapes: THREE.Shape[] = [];
			if (part.paths?.length) {
				// Surfaces grow a centimetre, so a road meeting its junction never
				// shows a seam; paint shrinks a little, clear of the triangulation's
				// slivers.
				for (const polygon of toPolygons(part.paths, SURFACES.has(part.layer) ? 0.01 : -0.05)) {
					const shape = new THREE.Shape(polygon.outer.map((p) => new THREE.Vector2(p.x, p.y)));
					for (const hole of polygon.holes)
						shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))));
					shapes.push(shape);
				}
			}
			for (const poly of part.polys ?? []) {
				if (poly.length >= 3)
					shapes.push(new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y))));
			}
			if (shapes.length === 0) continue;
			const geometry = new THREE.ShapeGeometry(shapes);
			geometry.rotateX(Math.PI / 2);
			const mesh = new THREE.Mesh(geometry, this.material(part.layer, part.colour));
			mesh.position.y = yOf(part.layer);
			group.add(mesh);
		}
		this.root.add(group);
		this.pieces.set(id, { draw, group });
	}

	private material(layer: Layer, colour: string) {
		const key = `${layer}|${colour}`;
		let m = this.materials.get(key);
		if (!m) {
			const bias = -ORDER.indexOf(layer);
			m = new THREE.MeshBasicMaterial({
				color: new THREE.Color(colour),
				side: THREE.DoubleSide,
				transparent: this.look.opacity < 1,
				opacity: this.look.opacity,
				polygonOffset: true,
				polygonOffsetFactor: bias,
				polygonOffsetUnits: bias
			});
			this.materials.set(key, m);
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
					.map(([id, p]) => `${id}`.concat(String(this.drawIds.get(p.draw) ?? this.tag(p.draw))))
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
		const y = yOf('yellow') + 0.2;
		for (const road of scene.place.roads) {
			const geo = scene.geos.get(road.id);
			if (!geo || scene.hidden.has(road.id)) continue;
			for (const c of road.crossings ?? []) {
				const f = frameAt(geo.path, c.at);
				const spans = crossSection(road, c.at);
				const sides = c.lanes.map((id) => spans.find((sp) => sp.lane.id === id));
				if (!sides[0] || !sides[1]) continue;
				const pts = sides.map((sp) => {
					const p = offsetPoint(f.p, f.n, (sp!.left + sp!.right) / 2);
					return new THREE.Vector3(p.x, y, p.y);
				});
				const line = new THREE.Line(
					new THREE.BufferGeometry().setFromPoints(pts),
					crossingMaterial
				);
				line.computeLineDistances();
				line.renderOrder = 20;
				this.overlay.add(line);
			}
		}
		for (const j of scene.effective) {
			const draw = scene.junctionDraw(j.id);
			if (!draw) continue;
			for (const c of draw.curves) {
				const geometry = new THREE.BufferGeometry().setFromPoints(
					c.points.map((p) => new THREE.Vector3(p.x, y, p.y))
				);
				const line = new THREE.Line(geometry, lineMaterial);
				line.computeLineDistances();
				line.renderOrder = 20;
				this.overlay.add(line);
			}
			for (const d of draw.laneDots) {
				const ring = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), outMaterial);
				ring.rotateX(-Math.PI / 2);
				ring.position.set(d.p.x, y, d.p.y);
				ring.renderOrder = 21;
				this.overlay.add(ring);
				if (d.flow === 'in') {
					const dot = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), inMaterial);
					dot.rotateX(-Math.PI / 2);
					dot.position.set(d.p.x, y + 0.01, d.p.y);
					dot.renderOrder = 22;
					this.overlay.add(dot);
				}
			}
		}
	}

	private drawIds = new WeakMap<object, number>();
	private drawCounter = 0;
	private tag(draw: object) {
		const id = this.drawCounter++;
		this.drawIds.set(draw, id);
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
		this.lastKeys.clear();
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
