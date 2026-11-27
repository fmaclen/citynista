// The city as networks laid one over another (AGENTS.md, "The drawing").
// The car roads come first: every segment with a car lane, built and drawn
// as if no other segment were drawn (`cars`). The footpaths, every other
// segment, are drawn as strips of their own (core/footpaths.ts) laid over the
// cars. The two never share a node (core/separate.ts): a footpath whose node
// lies on a car road's dead end joins that road's sidewalks, the car road
// fixed where it is, and whether a footpath node lies on a sidewalk decides
// whether it is filled; nowhere else does a footpath read the cars.
// Each footpath piece is then laid over the car ground (road-model/
// overlay.ts), and what it crosses there is the one thing the car pieces take
// from it: their crossings (core/runs.ts), each held by its control (give-way
// unless set otherwise) on every car approach it lies across, and the paint
// that keeps clear of them. A crossing is paint: no node or cut marks it, and
// only a control set on it by hand is stored, on its footpath
// (core/crossing-controls.ts). So nothing about how a car road is shaped or
// joined ever reads a footpath. Bike paths or rail would be further networks
// laid over these the same way.

import type { Description, NodeDescription, RoadDescription } from '../road-model/description';
import {
	area,
	close,
	fromPath,
	inside,
	intersect,
	offset,
	type Paths,
	piecesOf as partsOf,
	toPath,
	union,
	wholly
} from '../road-model/clip';
import { Drawing, type Over } from '../road-model/drawing';
import type { RoadGeo } from '../road-model/ends';
import {
	crossSection,
	endFrame,
	frameAt,
	offsetPoint,
	type PathSample,
	project
} from '../road-model/geometry';
import {
	type Control,
	type DrawnJunction,
	type End,
	type Place,
	type Pt,
	type Road,
	strongest
} from '../road-model/model';
import {
	type Box,
	BoxGrid,
	boxOf,
	type Crossed,
	crossedBy,
	layOver,
	nearestOf,
	overlap,
	shapeOf,
	type Under,
	underOf,
	walkAt
} from '../road-model/overlay';
import type { Graph, GraphView, NodeView } from './graph.svelte';
import { shownRoad, type ShownRoads } from './crossings';
import {
	LineBook,
	type LineFrom,
	lineThrough,
	nodePoint,
	roadAt,
	sameLine,
	shiftedAt
} from './road-line';
import {
	bandOf,
	chainOf,
	crossingsHeldBy,
	groundOf as carGround,
	pointOn,
	type Round,
	type Roadway,
	type Rounds,
	shownBox
} from './runs';
import { type Carriageway, controlOf, sameControls, settled } from './crossing-controls';
import type { CrossingControl } from './types';
import { type Fill, Footpaths, roundOf, type Shape, type Strip, WALK, walkOnto } from './footpaths';
import { carries } from './lane-types';
import { type Derived, type FixedEnd, type OnWalkway, PlaceBuilder } from './place';
import type { Segment } from './segment.svelte';

// What every network's drawing hands on, read as one: every piece drawn,
// each road's and node's description by id (checks.ts, the renderer, the
// connector).
export interface Scene {
	place: Place;
	geos: Map<string, RoadGeo>;
	road(id: string): RoadDescription | undefined;
	node(id: string): NodeDescription | undefined;
	// The two nodes a footpath strip ends at, by its segment id.
	footpathNodes(id: string): readonly [string, string] | undefined;
	// A footpath's own paving as its network draws it, before it is laid over
	// the cars, by its segment id: its strip and the fill at each of its nodes
	// (a bend's or a joint's), each with the box round it. None for a car road.
	footpathPaving(id: string): { description: Description; box: Box }[];
	// Whether a footpath node is a bend (core/footpaths.ts): its two strips
	// stopped short of it, the bend paving between them.
	footpathBend(id: string): boolean;
	// What the connection overlay (rendering/links.ts) reads of the build as
	// it stands, handed over only when asked for: the crossings a footpath
	// segment holds (WalkedCrossing); the car pieces drawn near a box and the
	// road or junction each is drawn of; and what of a car piece a footpath
	// laid over it is drawn on (Under, as layOver reads it).
	walking(): Walking;
}

// A crossing a footpath segment holds, as the overlay reads it: its runs'
// bands (bandOf in core/runs.ts); its ground (Crossed.rings, all it covers
// before a crossing drawn first takes any of it); the car pieces it is laid
// on; the car segments of the road it crosses; and its footpath segments.
export interface WalkedCrossing {
	bands: Pt[][];
	rings: Paths;
	on: readonly { piece: string }[];
	roads: readonly string[];
	segments: string[];
}

const NO_RUNS: readonly WalkedCrossing[] = [];

export interface Walking {
	runsOf(id: string): readonly WalkedCrossing[];
	near(box: Box): Description[];
	idOf(d: Description): string | undefined;
	under(d: Description): Under;
}

// A network's part of a graph: the segments it is made of, and the nodes
// they end at, each listing only those. A node holding none of them is left
// out, so no other network's node is read.
type View = { nodes: Map<string, NodeView>; segments: Map<string, Segment> };
function viewOf(graph: GraphView, own: (s: Segment) => boolean): View {
	const view: View = { nodes: new Map(), segments: new Map() };
	const at = new Set<string>();
	for (const [id, s] of graph.segments) {
		if (viewed.on) viewed.count++;
		if (!own(s)) continue;
		view.segments.set(id, s);
		at.add(s.startNodeId).add(s.endNodeId);
	}
	for (const id of graph.nodes.keys()) if (at.has(id)) viewNode(graph, view, id);
	return view;
}

// Puts a node in a view as it now stands in `graph` (viewOf), or takes it
// out: whether it was or is in it.
function viewNode(graph: GraphView, view: View, id: string) {
	if (viewed.on) viewed.count++;
	const node = graph.nodes.get(id);
	const here = node?.connectedSegments.filter((s) => view.segments.has(s)) ?? [];
	if (!node || !here.length) return view.nodes.delete(id);
	view.nodes.set(
		id,
		here.length === node.connectedSegments.length
			? node
			: { id, x: node.x, y: node.y, junction: node.junction, connectedSegments: here }
	);
	return true;
}

// How many nodes and segments a build reads of the graph whole: the car
// roads' view (Networks.carsOf), and the footpaths' lines and controls
// (Networks.build), counted only while a test turns counting on (`on`).
export const viewed = { on: false, count: 0 };
// How many car pieces a build files by their boxes (Networks.build), counted
// the same way.
export const filed = { on: false, count: 0 };

// The car pieces as a build filed them: each one's key and id, by its
// description, and its description and box by its id.
interface CarFiling {
	keys: Map<Description, string>;
	ids: Map<Description, string>;
	byId: Map<string, Description>;
	boxes: Map<string, Box>;
}

// A graph that logs what is written to it (Graph.changesSince).
type Logged = GraphView & Pick<Graph, 'stamp' | 'changesSince' | 'nodeRank' | 'segmentRank'>;
const logged = (graph: GraphView): graph is Logged => 'changesSince' in graph;

const isCar = (s: Segment) => carries(s.lanes);

// Some segments, and the car segments whose lines an edit of them may
// change besides their own. A car road's line reads other segments only at
// an end attached at an edge: placed beside the roads at its node
// (attachShift in core/attach.ts), and placed as the whole road it was cut
// from places it (wholeOf), read from the pieces of that road and the first
// past them (placedFrom). So those are the roads attached at an edge at the
// segments' nodes, in any of `graphs`, and the segments whose attached ends
// the last build placed from them (`placing`, PlaceBuilder's), each read so
// in turn. An edit leaving a segment it reaches unread changes none of
// those placings: walked from an attached end its road reads only segments
// the edit left as they were up to the first it changed, which the last
// build read too. Nothing else is walked, so what this reads is what the
// segments' lines touch, whatever the size of the map.
function moving(
	graphs: (GraphView | undefined)[],
	placing: ReadonlyMap<string, readonly string[]>,
	segments: Iterable<string>
) {
	const found = new Set(segments);
	const todo = [...found];
	const add = (id: string) => {
		if (found.has(id)) return;
		found.add(id);
		todo.push(id);
	};
	for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
		for (const placed of placing.get(id) ?? []) add(placed);
		for (const graph of graphs) {
			const s = graph?.segments.get(id);
			if (!graph || !s || !isCar(s)) continue;
			for (const n of [s.startNodeId, s.endNodeId])
				for (const side of Object.keys(graph.nodes.get(n)?.junction?.sides ?? {})) add(side);
		}
	}
	return [...found];
}

// The widest gap (m, twice SEAM) closed between car pieces, so two drawn
// edge to edge read as one ground across their seam (and so does any car
// ground that close, whichever pieces it belongs to), and the least of a
// junction's ground (m²) a crossing's paving must lie on to reach it: a
// hair, for clipper's millimetre grid (onJunction).
const SEAM = 0.01;
const ON_JUNCTION = 1e-4;

// How near a footpath's node must show to where a car road's node shows to
// carry on from the road's end there (m), and how far round it the car
// pieces drawn at such a node are looked for.
const AT_NODE = 0.01;
const NODE_REACH = 1;
// How near the ends of a footpath node show to be read as one spot (m).
const ONE_SPOT = 1e-9;

type OnSidewalk = Omit<OnWalkway, 'path'>;

// One footpath's end at a node as heldFirst weighs it: its footpath, how
// wide that is, where the end shows, and the walkway it lies on, if any.
type HeldEnd = { path: string; width: number; end: Pt; on?: OnSidewalk };

// Which of two footpath ends at a node the node is held by on a walkway
// (Derived.sidewalks: it slides along that walkway, keeps to it as it is
// drawn anew, and is on a corner where that end is) and rides a car road by
// (ridersOf and placedBy in core/drag.ts, which read them in this order off
// onGround).
// At a node with a shift (`shifted`: a footpath there shifted where it
// meets it), the end of the wider footpath, which paves more of the
// walkway; of two as wide, the one showing further west, then further
// south, then on the walkway of the road and lane first by id, then joining
// it further west, then further south. So the drawing decides it, never the
// footpaths' ids or the order they were drawn in: only two ends alike in
// all of that (one spot, one walkway, joined at one point) fall back to
// their footpaths' ids. At a node with no shift every end shows on the node
// and the ids decide. Negative where the first is held by.
function heldFirst(a: HeldEnd, b: HeldEnd, shifted: boolean) {
	const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
	const apart = (d: number) => (Math.abs(d) > ONE_SPOT ? d : 0);
	if (!shifted) return order(a.path, b.path);
	const [ja, jb] = [a.on?.line.at(-1), b.on?.line.at(-1)];
	return (
		b.width - a.width ||
		apart(a.end.x - b.end.x) ||
		apart(a.end.y - b.end.y) ||
		(a.on && b.on ? order(a.on.road, b.on.road) || order(a.on.lane, b.on.lane) : 0) ||
		(ja && jb ? apart(ja.x - jb.x) || apart(ja.y - jb.y) : 0) ||
		order(a.path, b.path)
	);
}

// A piece of the footpaths laid over the cars: its description there, and
// each piece of verge it crosses (layOver) with the box round it, kept as one
// object while that ground stays the same; `key` names what it was laid
// from, and `sidewalks` the car road sidewalk each free end lies on, by its
// node.
interface Laid {
	key: string;
	// The footpath piece it was laid from, its free ends and its own nodes.
	from: Description;
	free: FreeEnds | undefined;
	nodes: string[];
	description: Description;
	crossing: Ground[];
	sidewalks: [string, OnSidewalk][];
}

// What a footpath node read of the cars, each read when first asked for: the
// car dead ends its ends show on (`cars`), and whether its ends lie on a car
// road's walk (`walk`); with the shapes of the strips ending there it was
// read for.
interface AtCars {
	geos: RoadGeo[];
	cars?: FixedEnd[];
	walk?: boolean;
}

// Ground crossed, with the box round it, kept as one object while it stays
// the same.
interface Ground {
	id: string;
	crossed: Crossed;
	box: Box;
	json: string;
	version: number;
}

// The crossings a footpath segment holds (crossingsHeldBy in core/runs.ts),
// and the footpath nodes they were read from: those of every footpath piece
// joined to it inside a roadway. With each crossing drawn, what its control
// is read from (core/crossing-controls.ts): its ground's id, the carriageway
// it lies across (its car road's segments as it carries on, before any
// parting, and its car lanes), its footpath segments, its control, and the
// point its line is read from.
interface Runs {
	reads: string[];
	// The ids of its crossings whose bands are filed (Networks.bands): every
	// one crossingsHeldBy found, drawn or not.
	banded: string[];
	// The footpath segments of its crossings.
	segments: string[];
	crossing: Ground[];
	held: (Carriageway & {
		id: string;
		// Its car road's segments as drawn, parted where a loop is
		// (roadThrough in place.ts): which pieces it is laid on.
		road: string[];
		// The car segments it may lie on: its own road's as it carries on,
		// and those of each car piece it is laid on (`on`), where crossingsOn
		// looks for it.
		lying: string[];
		// The car pieces it is laid on, each with its car segments: which of
		// them draw it is the painter's to say (Networks.drawnOf).
		on: { piece: string; segments: string[] }[];
		// Its road's end nodes, whose roads it is laid on too.
		ends: [string, string];
		segments: string[];
		// Its footpath pieces: each segment's and from and to where along
		// it (`t`, core/runs.ts Stretch), which tell it from the footpath's
		// other crossings of the carriageway (Networks.sameCrossing).
		along: CrossingPiece[];
		control: Control;
		mid: Pt;
		// Its runs' bands (bandOf in core/runs.ts).
		bands: Pt[][];
		// Its ground (Crossed.rings).
		rings: Paths;
	})[];
}

type Held = Runs['held'][number];

// A footpath piece of a crossing: its segment and from and to where along
// it.
export type CrossingPiece = { segment: string; t0: number; t1: number };

// What a crossing drawn is, to find it again in a later build: the
// carriageway it lies across and its footpath pieces (Networks.crossingOf).
export interface CrossingIs {
	across: Carriageway;
	along: readonly CrossingPiece[];
}

export class Networks {
	private cars = new PlaceBuilder();
	private footpaths = new Footpaths();
	private carDrawing: Drawing | null = null;
	// Each footpath piece laid over the cars, by its id (a strip's segment
	// id, WALK and a fill's node id), and the description of it filed in
	// `over`.
	private laid = new Map<string, Laid>();
	private filed = new Map<string, Description>();
	// Each footpath piece's id, by the description of it filed (`stale`).
	private walkOf = new WeakMap<Description, string>();
	// Each footpath end lying on a car road's sidewalk, by its node, and the
	// pieces whose free ends lie there, read from (sidewalks).
	private sidewalks: Derived['sidewalks'] = new Map();
	private onWalk = new Map<string, Map<string, OnSidewalk>>();
	// The nodes whose footpath ends the last build found on a walkway
	// afresh, each with what the build before found there (none where it
	// found nothing): what Editor.followWalkways reads.
	rewalked = new Map<string, OnWalkway[] | undefined>();
	// The footpaths' roads, their shapes and their fills as the place lists
	// them, kept while no strip or fill changed.
	private listed: { roads: Road[]; geos: [string, RoadGeo][]; junctions: DrawnJunction[] } | null =
		null;
	private runs = new Map<string, Runs>();
	// The footpath segments of the crossings drawn, each with the segments
	// holding those crossings (`runs`) and its crossing controls as last
	// read: a new list is an edit (core/crossing-controls.ts).
	private crossers = new Map<
		string,
		{ holders: Set<string>; controls: readonly CrossingControl[] | undefined }
	>();
	// The car segments the crossings drawn lie on (their roads' as they carry
	// on, and those of each road their zebra reaches the ground of), each
	// with the footpath segments holding those crossings (`runs`).
	private crossedRoads = new Map<string, Set<string>>();
	// The box round the bands of each crossing a footpath segment holds,
	// drawn or not, by the crossing's id: the car pieces it is cut from are
	// those whose boxes meet it (build).
	private bands = new BoxGrid<string>();
	// The car pieces the crossings drawn are laid on (Held.on), each with the
	// footpath segments holding those crossings, and the car pieces the last
	// build drew, as it filed them.
	private laidOn = new Map<string, Set<string>>();
	private carFiling: CarFiling | null = null;
	// The footpath segments whose crossings the last build read again.
	reread = new Set<string>();
	// The footpath segments whose crossings read each node (Runs.reads).
	private readers = new Map<string, Set<string>>();
	private unders = new WeakMap<Description, Under>();
	// All a car piece covers, grown by ON_GROUND (onGround).
	private grounds = new WeakMap<Description, Paths>();
	// Each footpath piece's nodes, read once per description (onGround, and
	// the nodes an edit touched in build).
	private nodesOf = new WeakMap<Description, string[]>();
	// Each car piece's road or junction id, for `near`.
	private idOf = new WeakMap<Description, string>();
	// The car pieces and the ground laid over them, filed by their boxes.
	private under = new BoxGrid<Description>();
	private crossing = new BoxGrid<Ground>();
	// The footpath pieces, filed by their boxes.
	private over = new BoxGrid<Description>();
	// Each footpath's free ends (freeEnds), kept while its shape and which of
	// its ends join nothing stay the same.
	private free = new Map<string, FreeEnds>();
	// What each footpath node read of the cars, kept while its strips and
	// the car pieces round them stay the same.
	private atCars = new Map<string, AtCars>();
	private version = 0;
	// What each footpath's shown line is made of as the last build drew it,
	// one object while it stays the same (PlaceBuilder.lines for the cars).
	private walkLines = new LineBook();
	// The segments of either network whose shown line the last build drew
	// anew.
	relined = new Set<string>();
	// What the last build read and made, for onGround: the graph, the car
	// roads and the car drawing.
	private last: { graph: GraphView; cars: Derived; carDrawing: Drawing } | null = null;

	// The car roads' part of the graph last built (viewOf), with where that
	// graph's log of writes stood then.
	private carView: { graph: Logged; stamp: number; view: View } | null = null;

	// The car roads' part of `graph`, what was written to it since the last
	// build of the same graph, and the order of its nodes and segments: the
	// last view, with only the nodes and segments written since read again,
	// where the graph logs its writes and they are still known; read whole
	// otherwise.
	private carsOf(graph: GraphView) {
		if (!logged(graph)) return { view: viewOf(graph, isCar), written: null };
		const order = {
			node: (id: string) => graph.nodeRank(id),
			segment: (id: string) => graph.segmentRank(id)
		};
		const was = this.carView;
		const changes = was?.graph === graph ? graph.changesSince(was.stamp) : null;
		if (!was || !changes) {
			const view = viewOf(graph, isCar);
			this.carView = { graph, stamp: graph.stamp, view };
			return { view, order, written: null };
		}
		const { view } = was;
		const segments = new Set<string>();
		const nodes = new Set<string>();
		for (const id of new Set(changes.segments)) {
			if (viewed.on) viewed.count++;
			const s = graph.segments.get(id);
			if (s && isCar(s)) view.segments.set(id, s);
			else if (!view.segments.delete(id)) continue;
			segments.add(id);
			if (s) nodes.add(s.startNodeId).add(s.endNodeId);
		}
		const written = new Set<string>();
		for (const id of new Set([...changes.nodes, ...nodes]))
			if (viewNode(graph, view, id)) written.add(id);
		was.stamp = graph.stamp;
		return {
			view,
			order,
			// Footpaths put in another place in the order leave the car roads'
			// as it was among themselves.
			changed: {
				nodes: written,
				segments,
				reordered: changes.reordered.some((id) => view.segments.has(id))
			},
			written: changes
		};
	}

	// Keeps a node's tapers where they are until released (PlaceBuilder.hold).
	hold(nodeId: string | null) {
		this.cars.hold(nodeId);
	}

	// The shortest and longest each car road may be set to stop short of a
	// node, by segment id. A footpath stops at none.
	limits(nodeId: string) {
		return this.cars.limits.get(nodeId);
	}

	// Ground crossed, as it was (`was`) while it stays the same.
	private ground(id: string, crossed: Crossed, was: Ground | undefined): Ground {
		const json = JSON.stringify(crossed);
		if (was?.json === json) return was;
		return {
			id,
			crossed,
			box: boxOf(crossed.rings.flatMap(fromPath)),
			json,
			version: ++this.version
		};
	}

	// Each footpath's (of `segments`) shown line in `graph`: the last
	// build's, one object, where it is the same (walkLineOf). A footpath's
	// end is its node (core/attach.ts), so its line is made of its nodes, its
	// handle and its shifts.
	private walkLinesOf(graph: GraphView, segments: Iterable<Segment>) {
		const lines = new Map<string, LineFrom>();
		for (const s of segments) {
			const line = this.walkLineOf(graph, s);
			if (line) lines.set(s.id, line);
		}
		return lines;
	}
	private walkLineOf(graph: GraphView, s: Segment) {
		if (isCar(s)) return undefined;
		const a = graph.nodes.get(s.startNodeId);
		const b = graph.nodes.get(s.endNodeId);
		if (!a || !b) return undefined;
		const was = this.walkLines.get(s.id);
		return was && sameLine(was, s, a, b)
			? was
			: lineThrough(s, { x: a.x, y: a.y }, { x: b.x, y: b.y });
	}

	build(graph: GraphView): { derived: Derived; scene: Scene } {
		const { view, changed, order, written } = this.carsOf(graph);
		const cars = this.cars.build(view, changed, order);
		this.relined = new Set(this.cars.relined);
		this.rewalked = new Map();
		// What was written since the last build of the same graph, where the
		// graph says (Graph.changesSince): the segments written and those at
		// a node written. Only those are read again below for their lines and
		// controls; everything is where it does not say.
		const rewritten =
			written && this.last?.graph === graph
				? new Set([
						...written.segments,
						...written.nodes.flatMap((n) => graph.nodes.get(n)?.connectedSegments ?? [])
					])
				: null;
		// Each footpath's shown line, kept one object while it stays the same.
		const walkLines = this.walkLines;
		for (const id of rewritten ?? graph.segments.keys()) {
			if (viewed.on) viewed.count++;
			const s = graph.segments.get(id);
			const line = s && this.walkLineOf(graph, s);
			if (line && line !== walkLines.get(id)) this.relined.add(id);
			walkLines.set(id, line);
		}
		if (!rewritten)
			for (const id of [...walkLines.keys()])
				if (!graph.segments.has(id)) walkLines.set(id, undefined);
		// The footpaths of a crossing whose controls changed: their crossings
		// are read again, so changing a control rebuilds its crossings. A
		// footpath of none draws nothing by its controls.
		const recontrolled: Segment[] = [];
		for (const id of rewritten ?? [...this.crossers.keys()]) {
			const seen = this.crossers.get(id);
			if (!seen) continue;
			if (viewed.on) viewed.count++;
			const s = graph.segments.get(id);
			if (s?.controls === seen.controls) continue;
			seen.controls = s?.controls;
			if (s) recontrolled.push(s);
		}
		const carDrawing = (this.carDrawing ??= new Drawing(cars.place, cars.geos));
		carDrawing.place = cars.place;
		carDrawing.geos = cars.geos;
		const drew = carDrawing.build();
		// The car pieces filed by their boxes, and those come or gone: filed
		// again only where the car drawing was drawn again, the last filing
		// otherwise, nothing come or gone.
		const under = this.under;
		const moved: Box[] = [];
		// The ids of the car pieces drawn afresh or gone.
		const redrawn = new Set<string>();
		if (drew || !this.carFiling) {
			const pieces = new Set<Description>();
			const filing: CarFiling = {
				keys: new Map(),
				ids: new Map(),
				byId: new Map(),
				boxes: new Map()
			};
			for (const piece of carDrawing.pieces()) {
				if (filed.on) filed.count++;
				pieces.add(piece.description);
				filing.keys.set(piece.description, piece.key);
				filing.ids.set(piece.description, piece.id);
				this.idOf.set(piece.description, piece.id);
				filing.byId.set(piece.id, piece.description);
				filing.boxes.set(piece.id, piece.box);
				if (under.add(piece.box, piece.description)) {
					moved.push(piece.box);
					redrawn.add(piece.id);
				}
			}
			moved.push(...under.keepOnly(pieces));
			for (const id of this.carFiling?.byId.keys() ?? []) if (!filing.byId.has(id)) redrawn.add(id);
			this.carFiling = filing;
		}
		const { keys, ids, byId, boxes } = this.carFiling;
		// What a footpath node reads of the cars: the car dead end at each
		// spot its ends show (deadEndAt), and whether every footpath end there lies on a
		// car road's walk (walkAt). Both are read of its footpaths' ends, each
		// where it shows (its shift and all: `shownEnds`), never of the node,
		// which lies off them where they are shifted, nor of the middle of
		// them, which lies between them where their shifts differ. Both are
		// kept while the strips ending there keep their shape (their geo, one
		// object while it stays the same) and no car piece came or went near
		// them (`shaken`: near a footpath piece in the last build's footpaths
		// grid, where each footpath end shows in the box of a piece drawn from
		// it: its strip paved up to it, or its node's fill). Only where that
		// fails are they read again, so a build reads nothing of a footpath
		// node far from a change.
		const shaken = new Set<string>();
		const stale = new Set<Description>();
		for (const b of moved)
			for (const d of this.over.near(b)) {
				stale.add(d);
				for (const n of this.nodesOf.get(d) ?? []) shaken.add(n);
			}
		const asked = new Map<string, AtCars>();
		const known = (node: { id: string }, shapes: Shape[]) => {
			let here = asked.get(node.id);
			if (here) return here;
			const geos = shapes.map((s) => s.geo);
			const was = this.atCars.get(node.id);
			here =
				was &&
				was.geos.length === geos.length &&
				was.geos.every((g, k) => g === geos[k]) &&
				!shaken.has(node.id)
					? was
					: { geos };
			asked.set(node.id, here);
			return here;
		};
		// The car nodes a car piece is drawn at: a road's segments' ends, a
		// junction's nodes.
		const nodesUnder = (d: Description, each: (node: string) => void) => {
			const id = ids.get(d)!;
			if ('outline' in d) {
				for (const n of junctionsOf(cars.place).byId.get(id)?.members ?? []) each(n);
				return;
			}
			for (const s of cars.units.get(id) ?? [id]) {
				const segment = graph.segments.get(s);
				if (!segment) continue;
				each(segment.startNodeId);
				each(segment.endNodeId);
			}
		};
		// Where each footpath's end at a node shows.
		const shownEnds = (node: { id: string }, shapes: Shape[]) =>
			shapes.flatMap((shape) => {
				const s = graph.segments.get(shape.geo.road.id);
				const end = s && roadAt(graph, s, shape.nodes[0] === node.id ? 0 : 1);
				return end ? [end.point] : [];
			});
		// The car road end a footpath end showing at `p` joins: the one car
		// road end at the car nodes showing within AT_NODE of it (each where it
		// shows: nodePoint, a street shifted at its end showing its end off its
		// node), if there is exactly one; none where there are none or more,
		// two dead ends at one spot or a car node more roads end at included.
		// Every car node shows on the ground of a car piece drawn at it, so
		// only those round the point are read.
		const deadEndAt = (p: Pt) => {
			const found: FixedEnd[] = [];
			const seen = new Set<string>();
			for (const d of under.near(boxOf([p], NODE_REACH)))
				nodesUnder(d, (id) => {
					if (seen.has(id)) return;
					seen.add(id);
					const node = graph.nodes.get(id);
					const at = node && nodePoint(graph, node);
					if (at && Math.hypot(at.x - p.x, at.y - p.y) <= AT_NODE)
						found.push(...(cars.ends.get(id) ?? []));
				});
			return found.length === 1 ? found[0] : null;
		};
		// The spots where a footpath node's ends show: where its node shows
		// (nodePoint) when they all show at one spot, as every end of a node
		// with no shift does; each end's own where they show apart.
		const spotsOf = (node: { id: string } & Pt, shapes: Shape[]) => {
			const ends = shownEnds(node, shapes);
			if (ends.every((e) => Math.hypot(e.x - ends[0].x, e.y - ends[0].y) <= ONE_SPOT)) {
				const at = graph.nodes.get(node.id);
				return [at ? nodePoint(graph, at) : node];
			}
			return ends;
		};
		const walks = this.footpaths.build(
			graph,
			{
				// A footpath node joins the car dead end at each spot its ends
				// show (core/footpaths.ts holds that road's sidewalks in the
				// node's fill), by deadEndAt at each: a node whose ends show
				// apart, each on a dead end, joins both.
				carEnds: (node, shapes) => {
					const here = known(node, shapes);
					if (here.cars === undefined)
						here.cars = [...new Set(spotsOf(node, shapes).flatMap((p) => deadEndAt(p) ?? []))];
					return here.cars;
				},
				onWalk: (node, shapes) => {
					const here = known(node, shapes);
					if (here.walk === undefined) {
						const ends = shownEnds(node, shapes);
						const near = ends.length ? under.near(boxOf(ends)) : [];
						here.walk = ends.length > 0 && ends.every((p) => near.some((d) => !!walkAt(d, p)));
					}
					return here.walk;
				}
			},
			shaken
		);
		for (const id of walks.revisited) {
			const here = asked.get(id);
			if (here) this.atCars.set(id, here);
			else this.atCars.delete(id);
		}

		// The footpaths laid over the car ground. A piece is laid again only
		// where something it was laid from changed: it was drawn afresh
		// (another description, given wherever its shape or its nodes
		// change: core/footpaths.ts), or its free ends changed, or a car
		// piece came or went near it (`stale`). Nothing else about the
		// footpaths is read again: the pieces looked at are those drawn
		// afresh or gone, those at a node whose fill came, went or changed
		// (their free ends), and the stale.

		// What a car piece covers, read once per description and only when a
		// footpath piece is laid over it afresh.
		const groundOf = (d: Description) => {
			let u = this.unders.get(d);
			if (!u) {
				u = underOf(d);
				this.unders.set(d, u);
			}
			return u;
		};
		const looked = new Set(walks.changed);
		for (const n of walks.refilled) {
			looked.add(WALK + n);
			for (const s of graph.nodes.get(n)?.connectedSegments ?? [])
				if (walks.strips.has(s)) looked.add(s);
		}
		for (const d of stale) looked.add(this.walkOf.get(d)!);
		// Each footpath's free ends, worked out again for the strips looked at.
		for (const id of looked) {
			const strip = walks.strips.get(id);
			const free = strip && freeEnds(strip, walks.fills, this.free.get(id));
			if (free) this.free.set(id, free);
			else this.free.delete(id);
		}
		// The car segments a car piece is drawn from: a road's, or those of
		// every road at the nodes a junction covers, merged away or not.
		const carSegments = (d: Description) => {
			const id = ids.get(d)!;
			if (!('outline' in d))
				return (cars.units.get(id) ?? [id]).flatMap((s) => graph.segments.get(s) ?? []);
			const at = new Set<string>();
			nodesUnder(d, (n) => {
				for (const s of graph.nodes.get(n)?.connectedSegments ?? []) at.add(s);
			});
			return [...at].flatMap((s) => {
				const segment = graph.segments.get(s);
				return segment && isCar(segment) ? [segment] : [];
			});
		};
		// The car pieces some car segments are drawn on: their roads, and the
		// junctions of their nodes (a road merged away is its junction's).
		const piecesOf = (segments: Set<string>) => {
			const junctionAt = junctionsOf(cars.place).at;
			const out = new Set<string>();
			for (const id of segments) {
				const road = (cars.units.get(id) ?? [id])[0];
				if (byId.has(road)) out.add(road);
				const s = graph.segments.get(id);
				for (const n of s ? [s.startNodeId, s.endNodeId] : []) {
					const j = junctionAt.get(n)?.id;
					if (j && byId.has(j)) out.add(j);
				}
			}
			return [...out].sort();
		};
		// The car pieces a crossing of a roadway is laid on: those of its road
		// and the roads meeting it at its ends, and the junctions of their
		// nodes, each with the car segments it is drawn from, the ground a
		// road draws as its riders read it (ridersOf in core/drag.ts).
		const laidOnOf = (r: Pick<Roadway, 'segments' | 'ends'>) =>
			piecesOf(carGround(graph, r)).map((piece) => ({
				piece,
				segments: carSegments(byId.get(piece)!).map((s) => s.id)
			}));
		// A footpath piece looked at, by its id, as it stands: with the nodes it
		// is drawn from (read only for a piece laid again or filed afresh).
		const pieceOf = (id: string) => {
			if (id.startsWith(WALK)) {
				const f = walks.fills.get(id.slice(WALK.length));
				return (
					f && {
						id,
						nodes: () => f.junction.members,
						description: f.description as Description,
						box: f.box,
						own: f.key,
						free: undefined
					}
				);
			}
			const s = walks.strips.get(id);
			return (
				s && {
					id,
					nodes: () => [...s.nodes],
					description: s.description as Description,
					box: s.box,
					own: s.road.key ?? '',
					free: this.free.get(id)
				}
			);
		};
		// Each piece looked at filed by its box afresh where its description
		// changed, and taken out where it is gone, with its nodes (`touched`:
		// those of every piece drawn afresh or gone, and of the stale).
		const touched = new Set<string>();
		const looking = new Map<string, ReturnType<typeof pieceOf>>();
		for (const id of looked) {
			const piece = pieceOf(id);
			looking.set(id, piece);
			const was = this.laid.get(id);
			const filed = this.filed.get(id);
			if (filed && filed !== piece?.description) {
				this.over.remove(filed);
				this.filed.delete(id);
			}
			if (piece) {
				const { description } = piece;
				if (filed !== description) {
					this.over.add(piece.box, description);
					this.filed.set(id, description);
					this.walkOf.set(description, id);
				}
				if (!this.nodesOf.has(description)) this.nodesOf.set(description, piece.nodes());
				if (was?.from === description) continue;
				for (const n of this.nodesOf.get(description)!) touched.add(n);
			}
			for (const n of was?.nodes ?? []) touched.add(n);
		}
		for (const d of stale) for (const n of this.nodesOf.get(d)!) touched.add(n);
		for (const s of recontrolled) touched.add(s.startNodeId).add(s.endNodeId);
		const near = (box: Box) =>
			under
				.near(box)
				.map((d) => ({ description: d, key: keys.get(d)! }))
				.sort((x, y) => (x.key < y.key ? -1 : 1));
		const laid = this.laid;
		const drawnAt = nodeAt(cars, graph);
		const lay = ({ id, description, box, own, free }: NonNullable<ReturnType<typeof pieceOf>>) => {
			const piece = laid.get(id);
			if (piece && piece.from === description && piece.free === free && !stale.has(description))
				return piece;
			const mine = this.nodesOf.get(description)!;
			const below = near(box);
			const key = `${own}|${free?.json ?? '[]'}|${below.map((u) => u.key).join('&')}`;
			if (piece?.key !== key) {
				const was = piece?.crossing ?? [];
				const out = wholly(() =>
					layOver(
						description,
						below.map((u) => groundOf(u.description))
					)
				);
				const crossing = out.crossing.map((crossed, i) =>
					this.ground(`${id}#${i}`, crossed, was[i])
				);
				// The car road sidewalk each free end lies on, and the line a
				// walker follows onto its middle there.
				const strip = walks.strips.get(id);
				const sidewalks = (free?.pts ?? []).flatMap((p, k): [string, OnSidewalk][] => {
					for (const u of below) {
						const on = walkwayOn(cars, u.description, p, this.idOf.get(u.description), drawnAt);
						if (!on || !strip) continue;
						const line = walkOnto(strip.shape.geo, free!.ends[k], on.middle);
						return [[free!.nodes[k], { ...on.lane, end: p, line }]];
					}
					return [];
				});
				return {
					key,
					from: description,
					free,
					nodes: mine,
					description: out.description,
					crossing,
					sidewalks
				};
			}
			return { ...piece!, from: description, free, nodes: mine };
		};
		// Each piece looked at laid again, or taken out where it is gone; the
		// ground it crosses filed by its box as it comes and goes (`crossed`,
		// the boxes of what came or went), and the sidewalk each of its free
		// ends lies on kept by its node.
		const crossing = this.crossing;
		const crossed: Box[] = [];
		const swap = (was: Ground[], now: Ground[]) => {
			if (was === now) return;
			for (const c of was) if (!now.includes(c) && crossing.remove(c)) crossed.push(c.box);
			for (const c of now) if (crossing.add(c.box, c)) crossed.push(c.box);
		};
		const walked = new Set<string>();
		for (const [id, piece] of looking) {
			const was = laid.get(id);
			const now = piece && lay(piece);
			if (now === was) continue;
			if (now) laid.set(id, now);
			else laid.delete(id);
			swap(was?.crossing ?? [], now?.crossing ?? []);
			if (was?.sidewalks === now?.sidewalks) continue;
			for (const [n] of was?.sidewalks ?? []) {
				this.onWalk.get(n)?.delete(id);
				walked.add(n);
			}
			for (const [n, on] of now?.sidewalks ?? []) {
				const here = this.onWalk.get(n) ?? new Map<string, OnSidewalk>();
				here.set(id, on);
				this.onWalk.set(n, here);
				walked.add(n);
			}
		}
		// The free ends at a node lying on a sidewalk, each footpath's, the
		// one the node is held by first (heldFirst).
		for (const n of walked) {
			this.rewalked.set(n, this.sidewalks.get(n));
			const shifted = shiftedAt(graph, n);
			const here = [...(this.onWalk.get(n) ?? [])].sort(([p, a], [q, b]) =>
				heldFirst(
					{ path: p, width: widthOf(graph, p), end: a.end, on: a },
					{ path: q, width: widthOf(graph, q), end: b.end, on: b },
					shifted
				)
			);
			if (here.length)
				this.sidewalks.set(
					n,
					here.map(([path, on]) => ({ path, ...on }))
				);
			else {
				this.sidewalks.delete(n);
				this.onWalk.delete(n);
			}
		}
		this.last = { graph, cars, carDrawing };

		// The crossings each footpath segment holds (crossingsHeldBy), read
		// again only for the segments at a node touched or whose crossings
		// read one; the ground crossed filed by its box as it comes and goes,
		// as above.
		const runs = this.runs;
		const readers = this.readers;
		// Each footpath read where its paving lies, round the bends at its
		// ends as drawn (roundOf).
		const rounds: Rounds = (walk) => {
			const strip = walks.strips.get(walk.id);
			const at = (k: 0 | 1, end: End): Round | null => {
				const line =
					strip && strip.cut[k] > 0
						? roundOf(walks.fills, strip.nodes[k], { road: walk.id, end })
						: null;
				return line && strip ? { cut: strip.cut[k], line } : null;
			};
			return [at(0, 'start'), at(1, 'end')];
		};
		// A crossing (one route of footpath segments from curb to curb,
		// crossingsHeldBy) lies on road ground alone, or is none: it paints
		// nothing, holds no traffic, shows no button and reads no stored
		// control, and the car roads under it are drawn as if it were not
		// there. It is none where its route's own paving (its segments' strips
		// and the joints at their nodes) runs on from the ground it crosses
		// onto a junction's (a node piece where car roads meet, merged with
		// others or not; a bend, a node of two sides, is road), in one piece
		// over car ground. Car ground within twice SEAM is one ground across
		// the gap, whichever pieces it belongs to, so two drawn edge to edge
		// are one (closing moves no curb); paving off car ground parts one
		// piece from the next.
		//
		// Another footpath joined to the route is no part of it: a branch
		// leaving the route's node and running into a junction leaves the
		// crossing as it is, and makes none of its own there. The joint at the
		// route's node is the route's own, though, so a branch that makes that
		// joint reach the junction takes the crossing; and a branch giving a
		// second way from curb to curb is one crossing with the route
		// (crossingsHeldBy), all of its paving read here. A junction paints
		// no crossing and clears nothing for one (drawJunction in
		// road-model/node.ts), so a crossing kept here whose band tips over a
		// road's mouth is painted up to the junction's edge and no further.
		// What this reads is the crossing's own ground and the car pieces whose
		// boxes meet its paving's, so whatever reads the crossing again reads
		// this again. This is the one place a crossing is told from a
		// junction's ground.
		const onJunction = (segments: readonly string[], ground: Crossed) => {
			const meeting = (d: Description) => 'outline' in d && carDrawing.meets(ids.get(d)!);
			const pieces = segments.flatMap((s) => {
				const strip = walks.strips.get(s);
				if (!strip) return [];
				return [strip, ...strip.nodes.flatMap((n) => walks.fills.get(n) ?? [])];
			});
			const near = [...new Set(pieces.flatMap((p) => under.near(p.box)))];
			const junctions = near.filter(meeting);
			if (!junctions.length) return false;
			const hard = (ds: Description[]) =>
				union(ds.flatMap((d) => [...groundOf(d).hard, ...groundOf(d).median]));
			const sum = (paths: Paths) => paths.reduce((t, q) => t + area(q), 0);
			return wholly(() => {
				const junction = hard(junctions);
				const paving = union(pieces.flatMap((p) => p.description.surfaces.flatMap(shapeOf)));
				return partsOf(intersect(paving, close(hard(near), SEAM))).some(
					(part) =>
						sum(intersect(part, ground.rings)) > 0 && sum(intersect(part, junction)) > ON_JUNCTION
				);
			});
		};
		const again = new Set<string>();
		for (const n of touched) {
			for (const id of readers.get(n) ?? []) again.add(id);
			for (const id of graph.nodes.get(n)?.connectedSegments ?? []) {
				const s = graph.segments.get(id);
				if (s && !isCar(s)) again.add(id);
			}
		}
		// What a crossing reads of the car pieces besides what its footpath's
		// nodes read (above), which may lie clear of its paving: the ground
		// and lines of those it is cut from, the ones whose boxes meet its
		// bands' (below), its stripes spaced across all it crosses there; and
		// which pieces it is laid on, its holds shared to them (Held.on), the
		// roads and junctions round its road's ends. So a car piece drawn
		// afresh or gone reads a crossing again where its box, as it is or as
		// it was, meets the crossing's band box, or where it is one the
		// crossing is laid on and the pieces it is laid on are now others (a
		// piece joins them only where one already among them changes: the
		// road's own end, a junction given a road, a road given a node).
		for (const b of moved)
			for (const c of this.bands.near(b)) again.add(c.slice(0, c.lastIndexOf('~')));
		for (const piece of redrawn)
			for (const id of this.laidOn.get(piece) ?? [])
				if (
					!again.has(id) &&
					runs
						.get(id)!
						.held.some(
							(h) =>
								h.on.some((p) => p.piece === piece) &&
								JSON.stringify(laidOnOf({ segments: [...h.road], ends: h.ends })) !==
									JSON.stringify(h.on)
						)
				)
					again.add(id);
		// And a crossing whose road as it carries on (Held.roads, what its
		// control names) is now another: one of the car pieces of that road
		// was drawn afresh or went, and the road through it is no longer the
		// one the crossing was read with. A loop is drawn as two pieces
		// (roadThrough in place.ts), so a crossing on the one half reads an
		// edit of the other here, as it would see it on one road.
		const chains = new Map<string, string[] | null>();
		const chain = (id: string) => {
			let read = chains.get(id);
			if (read === undefined) {
				const s = graph.segments.get(id);
				read = s ? chainOf(graph, s) : null;
				chains.set(id, read);
			}
			return read;
		};
		const other = (roads: readonly string[], now: string[] | null) =>
			now?.length !== roads.length || now.some((s, k) => s !== roads[k]);
		for (const piece of redrawn)
			for (const id of this.crossedRoads.get(piece) ?? [])
				if (
					!again.has(id) &&
					runs.get(id)!.held.some((h) => h.roads.includes(piece) && other(h.roads, chain(piece)))
				)
					again.add(id);
		this.reread = again;
		const unread = (id: string, reads: string[]) => {
			for (const n of reads) {
				const here = readers.get(n);
				here?.delete(id);
				if (here?.size === 0) readers.delete(n);
			}
		};
		for (const id of again) {
			const was = runs.get(id);
			if (was) unread(id, was.reads);
			for (const c of was?.banded ?? []) this.bands.remove(c);
			for (const x of was?.segments ?? []) {
				const seen = this.crossers.get(x)!;
				seen.holders.delete(id);
				if (seen.holders.size === 0) this.crossers.delete(x);
			}
			for (const r of new Set(was?.held.flatMap((h) => h.lying))) {
				const holders = this.crossedRoads.get(r)!;
				holders.delete(id);
				if (holders.size === 0) this.crossedRoads.delete(r);
			}
			for (const p of new Set(was?.held.flatMap((h) => h.on.map((o) => o.piece)))) {
				const holders = this.laidOn.get(p)!;
				holders.delete(id);
				if (holders.size === 0) this.laidOn.delete(p);
			}
			const segment = graph.segments.get(id);
			if (!segment || isCar(segment)) {
				swap(was?.crossing ?? [], []);
				runs.delete(id);
				continue;
			}
			const box = shownBox(graph, segment, rounds);
			const cars = [
				...new Set(under.near([box.x0, box.y0, box.x1, box.y1]).flatMap(carSegments))
			].sort((p, q) => (p.id < q.id ? -1 : 1));
			const seen = new Set([segment.startNodeId, segment.endNodeId]);
			const found = cars.length ? crossingsHeldBy(graph, segment, cars, seen, rounds) : [];
			const held: Runs['held'] = [];
			const banded: string[] = [];
			const now = found.flatMap((c, i) => {
				const r = c.road;
				const bands = c.runs.map((run) => bandOf(r, run));
				const box = boxOf(bands.flat());
				if (this.bands.add(box, `${segment.id}~${i}`)) banded.push(`${segment.id}~${i}`);
				// Drawn on the pieces it is laid on alone; cut from those of them
				// whose boxes meet its bands', since no other lays ground or a
				// line under them.
				const laidOn = laidOnOf(r);
				const on = laidOn.map((p) => p.piece);
				const ground = wholly(() =>
					crossedBy(
						bands,
						on.filter((id) => overlap(boxes.get(id)!, box)).map((id) => groundOf(byId.get(id)!))
					)
				);
				if (!ground || onJunction(c.segments, ground)) return [];
				// Every car approach it lies across is held by its control, the
				// line standing behind it from the roadway's middle halfway along
				// what its runs cross.
				const along = c.runs.flatMap((run) => run.ends.map((e) => e.s));
				const p = pointOn(r, (Math.min(...along) + Math.max(...along)) / 2, 0);
				const mid = { x: p.x, y: p.y };
				// Its control: the one its footpath segments store for its
				// carriageway, named by its road as it carries on (never as
				// drawn, which a loop's parting changes), the strongest of
				// theirs.
				const k = { roads: r.chain, lanes: r.lanes };
				const control = strongest(
					c.segments.map((x) => controlOf(graph.segments.get(x)?.controls, k))
				);
				const crossed = {
					...ground,
					id: `${segment.id}~${i}`,
					on,
					control: { kind: control, at: mid },
					across: { roads: [...r.segments], lanes: [...r.lanes] }
				};
				const id = `${segment.id}~${i}`;
				held.push({
					id,
					lying: [...new Set([...r.chain, ...laidOn.flatMap((p) => p.segments)])],
					on: laidOn,
					ends: [...r.ends],
					road: [...r.segments],
					roads: [...r.chain],
					lanes: [...r.lanes],
					segments: [...c.segments],
					along: c.stretches.map((st) => ({ segment: st.segment, t0: st.t0, t1: st.t1 })),
					control,
					mid,
					rings: crossed.rings,
					bands
				});
				return [this.ground(id, crossed, was?.crossing[i])];
			});
			swap(was?.crossing ?? [], now);
			const reads = [...seen];
			const segments = [...new Set(found.flatMap((c) => c.segments))];
			for (const x of segments) {
				const seen = this.crossers.get(x);
				if (seen) seen.holders.add(segment.id);
				else
					this.crossers.set(x, {
						holders: new Set([segment.id]),
						controls: graph.segments.get(x)?.controls
					});
			}
			for (const r of new Set(held.flatMap((h) => h.lying))) {
				const holders = this.crossedRoads.get(r);
				if (holders) holders.add(segment.id);
				else this.crossedRoads.set(r, new Set([segment.id]));
			}
			for (const p of new Set(held.flatMap((h) => h.on.map((o) => o.piece)))) {
				const holders = this.laidOn.get(p);
				if (holders) holders.add(segment.id);
				else this.laidOn.set(p, new Set([segment.id]));
			}
			runs.set(segment.id, { reads, banded, crossing: now, held, segments });
			for (const n of reads) {
				const here = readers.get(n);
				if (here) here.add(segment.id);
				else readers.set(n, new Set([segment.id]));
			}
		}

		// The car pieces painted with what is laid over them: only those near
		// ground crossed that came or went are painted again.
		const over: Over = (box, id) => {
			const near = crossing
				.near(box)
				.filter((c) => !c.crossed.on || c.crossed.on.includes(id))
				.sort((x, y) => (x.id < y.id ? -1 : 1));
			return {
				ground: near.map((c) => c.crossed),
				key: near.map((c) => `${c.id}:${c.version}`).join('&')
			};
		};
		carDrawing.paint(over, crossed);

		// The footpaths join the cars' place as plain roads and nodes: each
		// strip a road by its segment's id, each fill a junction by WALK and
		// its node's id, listed again only where a strip or fill changed. Of
		// what the car roads give the editor (junctions, crossings, spans,
		// units, through), a footpath has nothing.
		if (walks.changed.size || !this.listed) {
			const strips = [...walks.strips.values()];
			this.listed = {
				roads: strips.map((s): Road => s.road),
				geos: strips.map((s): [string, RoadGeo] => [s.road.id, s.geo]),
				junctions: this.listed?.junctions ?? []
			};
		}
		if (walks.refilled.size)
			this.listed.junctions = [...walks.fills.values()].map((f): DrawnJunction => f.junction);
		const place: Place = {
			roads: [...cars.place.roads, ...this.listed.roads],
			hidden: cars.place.hidden,
			junctions: [...cars.place.junctions, ...this.listed.junctions]
		};
		const geos = new Map([...this.listed.geos, ...cars.geos]);
		const scene: Scene = {
			place,
			geos,
			road: (id) => carDrawing.road(id) ?? (laid.get(id)?.description as RoadDescription),
			node: (id) =>
				carDrawing.node(id) ??
				(laid.get(id.startsWith(WALK) ? id : WALK + id)?.description as NodeDescription),
			footpathNodes: (id) => walks.strips.get(id)?.nodes,
			footpathPaving: (id) => {
				const strip = walks.strips.get(id);
				if (!strip) return [];
				const fills = strip.nodes.flatMap((n) => walks.fills.get(n) ?? []);
				return [strip, ...fills].map((x) => ({ description: x.description, box: x.box }));
			},
			footpathBend: (id) => !!walks.fills.get(id)?.middle,
			walking: () => ({
				runsOf: (id) => this.runs.get(id)?.held ?? NO_RUNS,
				near: (box) => this.under.near(box),
				idOf: (d) => this.idOf.get(d),
				under: (d) => {
					let u = this.unders.get(d);
					if (!u) this.unders.set(d, (u = underOf(d)));
					return u;
				}
			})
		};
		const derived: Derived = { ...cars, place, geos, sidewalks: this.sidewalks };
		return { derived, scene };
	}

	// The carriageways a footpath segment's crossings lie on, as the last
	// build drew them.
	private carriagewaysOf(id: string) {
		return [...(this.crossers.get(id)?.holders ?? [])].flatMap((h) =>
			(this.runs.get(h)?.held ?? []).filter((c) => c.segments.includes(id))
		);
	}

	// What each footpath segment storing crossing controls should store
	// where it stores otherwise, as the last build drew its crossings
	// (`settled`: written, no crossing's control changes). Read only on a
	// saved edit, which serialises the whole graph anyway.
	settle() {
		const out: [string, CrossingControl[] | undefined][] = [];
		for (const s of this.last?.graph.segments.values() ?? []) {
			if (!s.controls || isCar(s)) continue;
			const kept = settled(s.controls, this.carriagewaysOf(s.id));
			if (!sameControls(kept, s.controls)) out.push([s.id, kept]);
		}
		return out;
	}

	// Where a footpath segment shows, as the last build drew it
	// (Scene.footpathPaving is its own paving): on a crossing it is part of
	// as painted (its zebra or refuge, which reach past its paving:
	// `onOwnCrossing`, read off `drawnOf` as every crossing lookup is), and on
	// its paving anywhere but on a car piece's lanes or median (`onCarLanes`),
	// where layOver draws nothing of it.
	onOwnCrossing(id: string, p: Pt) {
		for (const h of this.crossers.get(id)?.holders ?? [])
			for (const c of this.runs.get(h)?.held ?? [])
				if (c.segments.includes(id) && this.drawnOf(c).some((d) => inside(d.body, p))) return true;
		return false;
	}
	onCarLanes(p: Pt) {
		return this.under.near(boxOf([p])).some((d) => {
			let u = this.unders.get(d);
			if (!u) this.unders.set(d, (u = underOf(d)));
			return inside(u.hard, p) || inside(u.median, p);
		});
	}

	// The crossing drawn over car lanes or a median at a point, by its id,
	// if one is.
	crossingAt(p: Pt) {
		for (const g of this.crossing.near(boxOf([p]))) {
			if (!g.crossed.control || !inside(g.crossed.rings, p)) continue;
			const c = this.heldAs(g.id);
			if (c && this.drawnOf(c).some((d) => inside(d.body, p))) return g.id;
		}
		return null;
	}

	// A crossing the last build held, by its id.
	private heldAs(id: string) {
		return this.runs.get(id.slice(0, id.lastIndexOf('~')))?.held.find((h) => h.id === id);
	}

	// Where a crossing held is drawn, as the last build painted it: each car
	// piece it is laid on that draws some of it over car lanes or a median
	// (crossingsOver in road-model/overlay.ts, the one place that decides,
	// where crossed ground another crossing or the piece's own already has is
	// not drawn again), with that piece's car segments and what it draws of
	// the crossing there. Every lookup of a crossing drawn reads this, so a
	// crossing another covers is drawn nowhere and found nowhere.
	private drawnOf(c: Held) {
		const drawing = this.last?.carDrawing;
		if (!drawing) return [];
		return c.on.flatMap(({ piece, segments }) => {
			const d = drawing.road(piece) ?? drawing.node(piece);
			const body = (d?.crossings ?? []).filter((x) => x.of === c.id).flatMap((x) => x.body);
			return body.length ? [{ segments, body: body.map(toPath) }] : [];
		});
	}

	// The ids of the crossings the last build drew over car lanes (drawnOf,
	// those `crossingAt` finds) that some segments are part of: a footpath
	// segment's own, and those lying across a car segment's road or drawn on
	// its ground. Each once, read off the crossings filed by the segments
	// holding them.
	crossingsOn(ids: Iterable<string>) {
		const out = new Set<string>();
		for (const id of ids) {
			const holders = this.crossers.get(id)?.holders ?? this.crossedRoads.get(id) ?? [];
			for (const h of holders) {
				const runs = this.runs.get(h);
				for (const c of runs?.held ?? []) {
					if (!c.segments.includes(id) && !c.lying.includes(id)) continue;
					const ground = runs?.crossing.find((g) => g.id === c.id);
					if (!ground?.crossed.control) continue;
					const drawn = this.drawnOf(c);
					const on =
						c.segments.includes(id) ||
						c.roads.includes(id) ||
						drawn.some((d) => d.segments.includes(id));
					if (drawn.length && on) out.add(c.id);
				}
			}
		}
		return [...out];
	}

	// A crossing drawn, by its id: its control, where its line is read from,
	// the carriageway it lies across (its road's segments as it carries on
	// and its car lanes),
	// and what each of its footpath segments should store given `control`
	// for its carriageway (every other one's as it reads now).
	crossingOf(id: string) {
		const holder = id.slice(0, id.lastIndexOf('~'));
		const here = this.runs.get(holder)?.held.find((h) => h.id === id);
		const graph = this.last?.graph;
		if (!here || !graph) return null;
		return {
			control: here.control,
			mid: here.mid,
			across: { roads: here.roads, lanes: here.lanes },
			is: { across: { roads: here.roads, lanes: here.lanes }, along: here.along },
			storing: (control: Control) =>
				here.segments.map(
					(x) =>
						[
							x,
							settled(graph.segments.get(x)?.controls, this.carriagewaysOf(x), {
								at: here,
								control
							})
						] as const
				)
		};
	}

	// The crossing the last build drew that is the one an earlier build drew
	// as `was` (crossingOf(id).is), by its id, or null where none is: one
	// lying across that carriageway (one of its roads and car lanes) whose
	// footpath pieces lap one of the earlier one's along its segment, of
	// several, the one lapping it furthest (then the least id). Ids are
	// numbered along the footpath, so another crossing may take its id as
	// crossings come and go; this, and never the id, tells a crossing kept
	// through an edit from one gone. Read on every build, a crossing slid
	// along its footpath frame by frame stays itself.
	sameCrossing(was: CrossingIs) {
		const shares = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));
		const lap = (along: readonly CrossingPiece[]) =>
			Math.max(
				-1,
				...along.flatMap((p) =>
					was.along
						.filter((q) => q.segment === p.segment)
						.map((q) => Math.min(p.t1, q.t1) - Math.max(p.t0, q.t0))
				)
			);
		let best: { id: string; lap: number } | null = null;
		const holders = new Set(
			was.along.flatMap((p) => [...(this.crossers.get(p.segment)?.holders ?? [])])
		);
		for (const h of holders)
			for (const c of this.runs.get(h)?.held ?? []) {
				if (!shares(c.roads, was.across.roads) || !shares(c.lanes, was.across.lanes)) continue;
				if (!this.drawnOf(c).length) continue;
				const l = lap(c.along);
				if (l <= 0) continue;
				if (!best || l > best.lap || (l === best.lap && c.id < best.id))
					best = { id: c.id, lap: l };
			}
		return best?.id ?? null;
	}

	// The segments and nodes of every piece the last build drew near a box,
	// car roads and footpaths, found through the grids it files them in:
	// a road's segments and their ends, a junction's nodes and their roads.
	near(box: { x0: number; y0: number; x1: number; y1: number }) {
		const segments = new Set<string>();
		const nodes = new Set<string>();
		const last = this.last;
		if (!last) return { segments, nodes };
		const { graph, cars } = last;
		const at = (id: string) => {
			nodes.add(id);
			for (const s of graph.nodes.get(id)?.connectedSegments ?? []) segments.add(s);
		};
		const b: Box = [box.x0, box.y0, box.x1, box.y1];
		for (const d of this.under.near(b)) {
			const id = this.idOf.get(d);
			if (!id) continue;
			if ('outline' in d) {
				for (const m of junctionsOf(cars.place).byId.get(id)?.members ?? []) at(m);
				continue;
			}
			for (const s of cars.units.get(id) ?? [id]) {
				const segment = graph.segments.get(s);
				if (!segment) continue;
				segments.add(s);
				nodes.add(segment.startNodeId).add(segment.endNodeId);
			}
		}
		for (const d of this.over.near(b)) for (const n of this.nodesOf.get(d) ?? []) at(n);
		return { segments, nodes };
	}

	// The roads as the last build drew them (core/crossings.ts), each line
	// read off that build: kept, it still reads them as that build drew them
	// whatever is drawn since, but for `near`, which reads the latest build.
	// Released (`release`, LineBook.view) once its reader is done with it.
	shown(): ShownRoads & { release(): void } {
		const views = [this.cars.lines.view(), this.walkLines.view()];
		return {
			...this.roadsOn(views),
			release: () => views.forEach((v) => v.release())
		};
	}

	// The roads as the latest build draws them, read on its lines as they are
	// whenever a road is asked for, taking no view of them: for a reader
	// done with them before the next build (the move check on each frame).
	showing(): ShownRoads {
		return this.roadsOn([this.cars.lines, this.walkLines]);
	}

	private roadsOn(lines: { get(id: string): LineFrom | undefined }[]): ShownRoads {
		const graph = this.last?.graph;
		return {
			road: (id) => {
				const s = graph?.segments.get(id);
				const line = lines[0].get(id) ?? lines[1].get(id);
				return s && line ? shownRoad(s, line) : undefined;
			},
			at: (id) => graph?.nodes.get(id)?.connectedSegments ?? [],
			near: (box) => this.near(box).segments
		};
	}

	// The roads as a build of `graph` would show them, `graph` being a few
	// edits from the one last built (a drop held over its marker,
	// modes/select.ts), and those it shows anew (`relined`). `changed` holds
	// every segment the edits wrote and every road at a node they wrote. A
	// road's line is made of its own nodes and, at an end attached at an
	// edge, the roads at that node and the road it is a piece of (wholeOf in
	// core/attach.ts), so only the roads changed and those whose attached
	// ends read them, before the edits or after, are read again (`moving`),
	// as a build reads them, through its
	// caches, keeping nothing: a road whose line is the same is that build's
	// object. Every other road is as that build showed it, so what this costs
	// is what the edits change, whatever the size of the map. Near a box: what
	// that build filed there, and every road shown anew.
	shownIn(graph: GraphView, changed: Iterable<string>): ShownRoads & { relined: Set<string> } {
		const read = moving([graph, this.last?.graph], this.cars.placing, changed).flatMap(
			(id) => graph.segments.get(id) ?? []
		);
		const lines = new Map([
			...this.cars.linesIn(graph, read.filter(isCar)),
			...this.walkLinesOf(graph, read)
		]);
		const relined = new Set<string>();
		for (const [id, line] of lines)
			if (line !== (this.cars.lines.get(id) ?? this.walkLines.get(id))) relined.add(id);
		return {
			road: (id) => {
				const s = graph.segments.get(id);
				const line = s && (lines.get(id) ?? this.cars.lines.get(id) ?? this.walkLines.get(id));
				return s && line ? shownRoad(s, line) : undefined;
			},
			at: (id) => graph.nodes.get(id)?.connectedSegments ?? [],
			near: (box) => new Set([...this.near(box).segments, ...relined]),
			relined
		};
	}

	// Where a footpath's end at a node shows as the last build drew it, where
	// it joins nothing there (freeEnds).
	freeEnd(path: string, node: string) {
		const free = this.free.get(path);
		const k = free?.nodes.indexOf(node) ?? -1;
		return free && k >= 0 ? free.pts[k] : undefined;
	}

	// The car junction the last build drew at a car node (merged, the one
	// holding it).
	junctionAt(nodeId: string) {
		return this.last ? junctionsOf(this.last.cars.place).at.get(nodeId) : undefined;
	}

	// The walkway a car road or its junction draws under a point as the
	// last build drew it (walkwayOn), the car pieces round it read in the
	// order of their ids.
	walkwayAt(p: Pt) {
		const last = this.last;
		if (!last) return null;
		const near = this.under
			.near(boxOf([p]))
			.map((d) => ({ d, id: this.idOf.get(d) ?? '' }))
			.sort((x, y) => (x.id < y.id ? -1 : 1));
		const at = nodeAt(last.cars, last.graph);
		for (const { d, id } of near) {
			const on = walkwayOn(last.cars, d, p, id, at);
			if (on) return on;
		}
		return null;
	}

	// The footpath nodes with a footpath's end showing on the car ground (its
	// shift and all: roadAt) of the roads some car segments are part of and
	// of the junctions at some car nodes, as the last build drew them: by
	// node, each footpath whose end there shows on that ground, the one the
	// node is held by first (heldFirst), with the car segments of the ground
	// it shows on (core/drag.ts: the node rides with those roads, by that
	// end). A node with no shift shows each end on its ring (nodePoint), so
	// it is read there, and every footpath at it is on the ground it shows
	// on. Only the footpath pieces filed near that ground are read; each
	// shows its node's ends in its box.
	onGround(segments: Iterable<string>, nodes: Iterable<string>) {
		const found = new Map<string, Map<string, Set<string>>>();
		// Where each footpath's end at a node shows, read once a node, or its
		// ring for all of them at a node with no shift.
		const ends = new Map<string, { shifted: boolean; shown: [string, Pt][] }>();
		const last = this.last;
		if (!last) return found;
		const { graph, cars, carDrawing } = last;
		const carsAt = (id: string) =>
			(graph.nodes.get(id)?.connectedSegments ?? []).filter((s) => {
				const segment = graph.segments.get(s);
				return !!segment && isCar(segment);
			});
		const pieces: { own: ReturnType<Drawing['own']>; roads: string[] }[] = [];
		const seen = new Set<string>();
		for (const id of segments) {
			const unit = cars.units.get(id) ?? [id];
			if (seen.has(unit[0])) continue;
			seen.add(unit[0]);
			pieces.push({ own: carDrawing.own(unit[0]), roads: unit });
		}
		const junctions = new Set<DrawnJunction>();
		for (const id of nodes) {
			const j = this.junctionAt(id);
			if (!j || junctions.has(j)) continue;
			junctions.add(j);
			pieces.push({ own: carDrawing.own(j.id, true), roads: j.members.flatMap(carsAt) });
		}
		const endsOf = (id: string) => {
			const node = graph.nodes.get(id);
			if (!node) return { shifted: false, shown: [] };
			const shifted = shiftedAt(graph, id);
			const ring = shifted ? null : nodePoint(graph, node);
			const shown = node.connectedSegments.flatMap((s): [string, Pt][] => {
				const path = graph.segments.get(s);
				const end = ring ?? (path && roadAt(graph, path, path.startNodeId === id ? 0 : 1)?.point);
				return end ? [[s, end]] : [];
			});
			return { shifted, shown };
		};
		for (const { own, roads } of pieces) {
			if (!own) continue;
			let ground = this.grounds.get(own.description);
			if (!ground) {
				const u = underOf(own.description);
				ground = offset(union([...u.hard, ...u.median, ...u.verge, ...u.walk]), ON_GROUND);
				this.grounds.set(own.description, ground);
			}
			for (const walk of this.over.near(own.box))
				for (const id of this.nodesOf.get(walk) ?? []) {
					let here = ends.get(id);
					if (!here) ends.set(id, (here = endsOf(id)));
					for (const [path, end] of here.shown) {
						if (!inside(ground, end)) continue;
						const at = found.get(id) ?? new Map<string, Set<string>>();
						const on = at.get(path) ?? new Set<string>();
						for (const r of roads) on.add(r);
						found.set(id, at.set(path, on));
					}
				}
		}
		for (const [id, at] of found) {
			const here = ends.get(id)!;
			if (!here.shifted || at.size < 2) continue;
			const shown = new Map(here.shown);
			const weigh = (path: string): HeldEnd => ({
				path,
				width: widthOf(graph, path),
				end: shown.get(path)!,
				on: this.onWalk.get(id)?.get(path)
			});
			const sorted = [...at].sort(([p], [q]) => heldFirst(weigh(p), weigh(q), true));
			found.set(id, new Map(sorted));
		}
		return found;
	}
}

// How wide a footpath is, all its lanes (m).
const widthOf = (graph: GraphView, path: string) =>
	graph.segments.get(path)?.lanes.reduce((w, lane) => w + lane.width, 0) ?? 0;

// The walkway of a car piece (`id`) that a point lies on (walkAt in
// road-model/overlay.ts), by its road, lane and how far along the road, a
// junction's corner sidewalk named with that junction and the car node it
// is drawn at (`nodeOf`: its first, where it lies); and the point of the
// walkway's middle nearest the point (`middle`): the corner's middle line,
// or the lane's middle across its road.
function walkwayOn(
	cars: Derived,
	d: Description,
	p: Pt,
	id: string | undefined,
	nodeOf: (junction: string) => { id: string; x: number; y: number } | undefined
) {
	const on = walkAt(d, p);
	const geo = on && cars.geos.get(on.road);
	if (!on || !geo) return null;
	const at = project(geo.path, p).s;
	const { corner, ...lane } = on;
	if (corner) {
		const middle = nearestOf([corner.line], (l) => l, p)?.at;
		const node = id && nodeOf(id);
		return middle && id && node
			? { lane: { ...lane, at, corner: { junction: id, node, ...corner } }, middle }
			: null;
	}
	const span = crossSection(geo.road, at).find((s) => s.lane.id === on.lane);
	if (!span) return null;
	const f = frameAt(geo.path, at);
	return { lane: { ...lane, at }, middle: offsetPoint(f.p, f.n, (span.left + span.right) / 2) };
}

// The car node each car junction is drawn at, as it lies: its first.
function nodeAt(cars: Derived, graph: GraphView) {
	return (junction: string) => {
		const first = junctionsOf(cars.place).byId.get(junction)?.members[0];
		const node = graph.nodes.get(first ?? '');
		return node && { id: node.id, x: node.x, y: node.y };
	};
}

// A build's car junctions by id (`byId`) and by each car node they hold
// (`at`: merged, the one holding it), filed once per place when first asked
// for.
const junctionMaps = new WeakMap<
	Place,
	{ byId: Map<string, DrawnJunction>; at: Map<string, DrawnJunction> }
>();
function junctionsOf(place: Place) {
	let maps = junctionMaps.get(place);
	if (!maps) {
		maps = {
			byId: new Map(place.junctions.map((j) => [j.id, j])),
			at: new Map(place.junctions.flatMap((j) => j.members.map((m) => [m, j] as const)))
		};
		junctionMaps.set(place, maps);
	}
	return maps;
}

// How far round a car piece's ground a footpath node may lie and still be
// on it (m): a footpath's end put at a curb or on a dead end's node lies on
// its edge.
const ON_GROUND = 0.1;

// A footpath's free ends (`pts`, and as `json`), worked out from its shape
// (its `path`, one object from build to build while the strip keeps its
// shape) and which of its ends join nothing (`sig`).
interface FreeEnds {
	path: PathSample;
	sig: string;
	pts: Pt[];
	ends: End[];
	nodes: string[];
	json: string;
}

// A footpath's ends that join nothing (no fill at their node): the middle
// of its cross-section there, or none where both join. Worked out again only
// where its shape, or which of its ends join nothing, changed since `was`.
function freeEnds(
	{ shape: { geo, nodes } }: Strip,
	fills: ReadonlyMap<string, Fill>,
	was: FreeEnds | undefined
) {
	const free = (
		[
			['start', nodes[0]],
			['end', nodes[1]]
		] as const
	).filter(([, node]) => !fills.has(node));
	if (!free.length) return undefined;
	const sig = free.map(([end]) => end).join();
	if (was?.sig === sig && was.path === geo.path) return was;
	const pts = free.map(([end]) => {
		const f = endFrame(geo.road, geo.path, end);
		const spans = crossSection(geo.road, f.distance);
		return offsetPoint(f.p, f.n, (spans[0].left + spans[spans.length - 1].right) / 2);
	});
	return {
		path: geo.path,
		sig,
		pts,
		ends: free.map(([end]) => end),
		nodes: free.map(([, node]) => node),
		json: JSON.stringify(pts)
	};
}
