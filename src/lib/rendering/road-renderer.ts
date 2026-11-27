// Draws the road model (src/lib/road-model) into the editor's Three.js scene.
// Its Networks (core/networks.ts) builds and caches one description per
// road and per node, car roads and footpaths alike; this turns each into one
// group of flat meshes (road-meshes.ts), rebuilt only when that description
// was rebuilt.

import * as THREE from 'three';
import type { Nearby } from '../core/crossings';
import type { Graph } from '../core/graph.svelte';
import { type CrossingIs, Networks, type Scene } from '../core/networks';
import type { Ground } from '../core/drag';
import type { Derived } from '../core/place';
import type { Description } from '../road-model/description';
import type { Pt } from '../road-model/model';
import { JOIN, LinksReader } from './links';
import { LAYERS, trianglesOf } from './road-meshes';

// The overlay's colours: a way to drive, and a way to walk.
const DRIVE = 0x7fd3ff;
const WALK = 0xffa94d;
// What the overlay draws, each kept by what it is drawn from: lines to drive
// and to walk, the rings and dots on lane ends, and the dots on joins.
const OVERLAY_KINDS = ['drive', 'walk', 'end', 'in', 'join'];
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

// Everything this draws stays where it is put: its matrix is worked out
// once, where it is placed, and never again each frame.
function fixed<T extends THREE.Object3D>(object: T) {
	object.updateMatrix();
	object.matrixAutoUpdate = false;
	return object;
}

export class RoadRenderer {
	private builder = new Networks();
	scene: Scene | null = null;
	derived: Derived | null = null;
	private root = new THREE.Group();
	private overlay = new THREE.Group();
	private pieces = new Map<string, { description: Description; group: THREE.Group }>();
	private materials = new Map<string, THREE.MeshBasicMaterial>();
	private overlayKey = '';
	// What the overlay shows, read again where the build changed; nothing
	// while it is hidden, and nothing of a city cleared away.
	private links = new LinksReader();
	// Each line and dot the overlay draws, by what it is drawn from, for each
	// of OVERLAY_KINDS.
	private drawn: Map<object, THREE.Object3D>[] = OVERLAY_KINDS.map(() => new Map());
	private tinted: number | null = null;
	showConnections = false;
	// The footpath nodes on the car ground of some roads and junctions, as
	// last drawn: what rides a car road a drag moves (core/drag.ts).
	onGround: Ground = (segments, nodes) => this.builder.onGround(segments, nodes);
	near: Nearby = (box) => this.builder.near(box);
	// The roads as last drawn (kept, as that build drew them; `showing`, as
	// the latest build draws them, for a reader done before the next), and
	// those whose shown line that build drew anew (core/crossings.ts: what a
	// move may not lay across), and the roads as a graph a few edits from it
	// would show them built.
	shown = () => this.builder.shown();
	showing = () => this.builder.showing();
	shownIn: Networks['shownIn'] = (graph, changed) => this.builder.shownIn(graph, changed);
	relined = () => this.builder.relined;
	// The segments any build drew on another line since this was last asked
	// (the editor places node rings by them), noted only once first asked: a
	// renderer never asked (a ghost's) keeps none.
	private relinedSince: Set<string> | null = null;
	takeRelined() {
		const taken = this.relinedSince ?? new Set<string>();
		this.relinedSince = new Set();
		return taken;
	}
	// The walkways the last build drew: the car junction at a car node, the
	// walkway under a point, and the footpath nodes found on a walkway
	// afresh with what the build before found there and where a footpath's
	// free end shows (Editor.followWalkways).
	junctionAt = (nodeId: string) => this.builder.junctionAt(nodeId);
	walkwayAt = (p: { x: number; y: number }) => this.builder.walkwayAt(p);
	rewalked = () => this.builder.rewalked;
	freeEnd = (path: string, node: string) => this.builder.freeEnd(path, node);
	// The crossings footpaths make over car roads as last drawn: the one
	// under a point, those some segments are part of, one by its id, and the
	// crossing controls the footpaths should store after an edit
	// (core/crossing-controls.ts).
	crossingAt = (p: { x: number; y: number }) => this.builder.crossingAt(p);
	// Where a footpath shows as last drawn: on a crossing of its own, and on
	// its paving off car lanes and medians.
	onOwnCrossing = (id: string, p: { x: number; y: number }) => this.builder.onOwnCrossing(id, p);
	onCarLanes = (p: { x: number; y: number }) => this.builder.onCarLanes(p);
	crossingsOn = (ids: Iterable<string>) => this.builder.crossingsOn(ids);
	crossingOf = (id: string) => this.builder.crossingOf(id);
	sameCrossing = (was: CrossingIs) => this.builder.sameCrossing(was);
	settle = () => this.builder.settle();

	constructor(
		private three: THREE.Scene,
		private look: { opacity: number; lift: number } = { opacity: 1, lift: 0 }
	) {
		this.root.position.y = look.lift;
		fixed(this.root);
		this.three.add(this.root);
		this.overlay.renderOrder = 10;
		fixed(this.overlay);
		this.three.add(this.overlay);
	}

	// With `only`, draws just those roads and the junctions at those nodes. A
	// segment joined with others into one road (Derived.units) is drawn as
	// that road, whole.
	update(graph: Graph, only?: { roads: Set<string>; nodes: Set<string> }) {
		const { derived, scene } = this.builder.build(graph);
		this.derived = derived;
		this.scene = scene;
		if (this.relinedSince) for (const id of this.builder.relined) this.relinedSince.add(id);

		const live = new Set<string>();
		for (const road of derived.place.roads) {
			const description = scene.road(road.id);
			const segments = derived.units.get(road.id) ?? [road.id];
			if (!description || (only && !segments.some((s) => only.roads.has(s)))) continue;
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
		return this.builder.limits(nodeId);
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
			group.add(fixed(mesh));
		}
		this.root.add(fixed(group));
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

	// The connection overlay (LinksReader in links.ts): each way to drive
	// through a node as a blue dashed line along the path it drives, with a
	// dot on each lane end (filled where traffic comes in); each way to walk
	// (along a sidewalk through a junction, over a crosswalk, along a
	// footpath, through its nodes, over its crossings and onto a walkway) as
	// an orange one; and an orange dot where a footpath joins a walkway. A
	// line or dot drawn from the same points as last time (a piece the build
	// kept, a footpath the reader kept) is kept as drawn; the rest are drawn
	// afresh and those gone disposed of.
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
		// Hidden, it keeps nothing it read.
		if (!this.showConnections) this.links = new LinksReader();
		const was = this.drawn;
		this.drawn = OVERLAY_KINDS.map(() => new Map());
		if (this.showConnections && scene && this.derived) {
			const links = this.links.read(scene, this.derived);
			const looks = this.looks();
			const y = ROAD_Y + 0.2;
			// The object drawn of `from` as `kind`: last time's, or one made.
			const draw = (kind: number, from: object, make: () => THREE.Object3D) => {
				const object = was[kind].get(from) ?? this.drawn[kind].get(from) ?? make();
				was[kind].delete(from);
				this.drawn[kind].set(from, object);
				if (object.parent !== this.overlay) this.overlay.add(object);
			};
			const line = (kind: number, pts: Pt[]) =>
				draw(kind, pts, () => {
					const l = new THREE.Line(
						new THREE.BufferGeometry().setFromPoints(
							pts.map((p) => new THREE.Vector3(p.x, y, p.y))
						),
						kind ? looks.walkMaterial : looks.driveMaterial
					);
					l.computeLineDistances();
					l.renderOrder = 20;
					return fixed(l);
				});
			const dot = (kind: number, p: Pt, radius: number, material: THREE.Material, order: number) =>
				draw(kind, p, () => {
					const d = new THREE.Mesh(this.circle(radius), material);
					d.rotateX(-Math.PI / 2);
					d.position.set(p.x, y + (order - 21) * 0.01, p.y);
					d.renderOrder = order;
					return fixed(d);
				});
			for (const pts of links.drive) line(0, pts);
			for (const pts of [
				...links.street,
				...links.strips,
				...links.walk,
				...links.cross,
				...links.onto
			])
				line(1, pts);
			for (const { point, flow } of links.ends) {
				dot(2, point, 0.45, looks.outMaterial, 21);
				if (flow === 'in') dot(3, point, 0.32, looks.inMaterial, 22);
			}
			for (const p of links.joins) dot(4, p, JOIN, looks.joinMaterial, 21);
		}
		for (const gone of was) for (const object of gone.values()) this.dispose(object);
	}

	// The overlay's materials, and a dot of each size it draws, made once
	// and shared by every line and dot (never disposed with them).
	private overlayLooks: ReturnType<typeof overlayLooks> | null = null;
	private circles = new Map<number, THREE.CircleGeometry>();
	private looks() {
		return (this.overlayLooks ??= overlayLooks());
	}
	private circle(radius: number) {
		let c = this.circles.get(radius);
		if (!c) this.circles.set(radius, (c = new THREE.CircleGeometry(radius, 16)));
		return c;
	}

	// The segments of the roads it draws (tests read it).
	drawnSegments() {
		const units = this.derived?.units;
		return [...this.pieces.keys()]
			.filter((id) => id.startsWith('road:'))
			.flatMap((id) => units?.get(id.slice(5)) ?? [id.slice(5)]);
	}

	// How much of the builds the overlay keeps read (LinksReader.kept; tests
	// read it).
	overlayKept() {
		return this.links.kept;
	}

	// What the connection overlay shows, read off its meshes, by colour: each
	// dashed line's points, and where each dot sits (tests read it).
	overlayShown() {
		const shown = { drive: [] as Pt[][], walk: [] as Pt[][], ends: [] as Pt[], joins: [] as Pt[] };
		for (const child of this.overlay.children) {
			const { material } = child as THREE.Mesh | THREE.Line;
			const walk = (material as THREE.MeshBasicMaterial).color.getHex() === WALK;
			if (child instanceof THREE.Line) {
				const at = child.geometry.getAttribute('position');
				const pts = Array.from({ length: at.count }, (_, i) => ({ x: at.getX(i), y: at.getZ(i) }));
				(walk ? shown.walk : shown.drive).push(pts);
			} else (walk ? shown.joins : shown.ends).push({ x: child.position.x, y: child.position.z });
		}
		return shown;
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
			if (
				(o instanceof THREE.Mesh || o instanceof THREE.Line) &&
				!(o.geometry instanceof THREE.CircleGeometry)
			)
				o.geometry.dispose();
		});
		object.removeFromParent();
	}

	clear() {
		for (const piece of this.pieces.values()) this.dispose(piece.group);
		this.pieces.clear();
		for (const child of [...this.overlay.children]) this.dispose(child);
		this.drawn = OVERLAY_KINDS.map(() => new Map());
		this.links = new LinksReader();
		this.overlayKey = '';
		this.scene = null;
		this.builder = new Networks();
		this.relinedSince?.clear();
	}

	destroy() {
		this.clear();
		for (const m of this.materials.values()) m.dispose();
		for (const c of this.circles.values()) c.dispose();
		for (const m of Object.values(this.overlayLooks ?? {})) m.dispose();
		this.root.removeFromParent();
		this.overlay.removeFromParent();
	}
}

// The overlay's materials: dashed lines for a way to drive and a way to walk,
// and the dots on lane ends (filled where traffic comes in) and on joins.
function overlayLooks() {
	const dashed = (color: number) =>
		new THREE.LineDashedMaterial({
			color,
			dashSize: 0.8,
			gapSize: 0.6,
			depthTest: false,
			transparent: true
		});
	const flat = (color: number) =>
		new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
	return {
		driveMaterial: dashed(DRIVE),
		walkMaterial: dashed(WALK),
		inMaterial: flat(0xffffff),
		outMaterial: flat(0x111111),
		joinMaterial: flat(WALK)
	};
}
