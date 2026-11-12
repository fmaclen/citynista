import type * as THREE from 'three';
import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { Graph } from '../core/graph.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Lane } from '../core/types';
import { cloneLanes, getTotalWidth, reverseLanes } from '../core/lane-template';
import { nodePoint } from '../core/road-line';
import { ENDPOINT_EXCLUSION, splitSegment } from '../core/crossings';
import { getQuadraticBezierPoint } from '../geometry/bezier';
import { DIRECTION_HANDLE, disposeHandleObject, handleObject } from '../rendering/handle-shapes';
import { nodeHitAt } from './picking';
import { ghostCursor, roadGhost } from './ghost';

// The circle tool: click a centre, move out to set the radius, click to lay
// the armed preset as a closed ring.
//
// A ring is quadratic segments of at most 45° each, with a node wherever it
// crosses a road. A quadratic over 45° strays from the true circle by about
// 0.3% of the radius (3 cm at 10 m), which no zoom shows; fewer pieces start
// to look polygonal, more only add links. With nothing crossed it is eight.
const SEGMENTS = 8;
const TAU = Math.PI * 2;
const STEP = TAU / SEGMENTS;
const CROSSING_SAMPLES = 32;
const ARROW_Y = 0.32;
const ARROW_ORDER = 8;

interface Pt {
	x: number;
	y: number;
}

// A road the ring crosses: where (on the circle, at `t` along the road's
// drawn line), and the road's own end node when that is close enough to
// take the crossing instead.
interface Crossing {
	angle: number;
	point: Pt;
	segment: Segment;
	t: number;
	endNodeId: string | null;
}

interface RingPoint {
	angle: number;
	crossing: Crossing | null;
}

export function setupCircleMode(editor: Editor): ModeHandlers {
	let centre: Pt | null = null;
	// Counter-clockwise on screen by default: right-hand traffic. F flips it.
	let clockwise = false;
	let lastWorld: Pt | null = null;
	// Cmd (Ctrl elsewhere) held: no node or grid snapping.
	let freeHeld = false;

	const ghost = roadGhost(editor);
	const cursor = ghostCursor(editor);
	let arrow: THREE.Object3D | null = null;

	const hideArrow = () => {
		if (!arrow) return;
		editor.sceneManager.screenSized.delete(arrow);
		editor.sceneManager.scene.remove(arrow);
		disposeHandleObject(arrow);
		arrow = null;
	};

	const showArrow = (at: Pt, dir: Pt) => {
		hideArrow();
		arrow = handleObject(DIRECTION_HANDLE, at, dir, ARROW_Y, ARROW_ORDER);
		editor.sceneManager.screenSized.set(arrow, Infinity);
		editor.sceneManager.scene.add(arrow);
	};

	// The armed preset laid along the ring. A one-way road whose traffic runs
	// backward is turned round, so traffic always runs the ring's way.
	const ringLanes = () => {
		const lanes = editor.activeBrush?.lanes ?? [];
		const vehicles = lanes.filter((lane) => lane.role === 'vehicle');
		const all = (direction: Lane['direction']) =>
			vehicles.length > 0 && vehicles.every((lane) => lane.direction === direction);
		const backward = all('backward');
		return {
			lanes: backward ? reverseLanes(lanes) : cloneLanes(lanes),
			oneWay: backward || all('forward')
		};
	};

	// Screen y runs with world z, so on screen counter-clockwise is a falling
	// world angle.
	const turn = () => (clockwise ? 1 : -1);
	const onRing = (c: Pt, r: number, angle: number) => ({
		x: c.x + Math.cos(angle) * r,
		y: c.y + Math.sin(angle) * r
	});
	// How far round from one angle to another, going the ring's way: (0, 2π].
	const ahead = (from: number, to: number) => {
		const d = (((turn() * (to - from)) % TAU) + TAU) % TAU;
		return d || TAU;
	};

	// Where the roads already there meet the circle. Nodes live on drawn
	// lines, so a road is cut where its drawn line meets the circle (an offset
	// road's paint crosses a little to one side), and that point is on the
	// circle. A road whose own end is within ENDPOINT_EXCLUSION of the
	// crossing is not cut into a sliver: that end node moves onto the circle
	// there and becomes the ring's node.
	const crossingsOf = (c: Pt, r: number) => {
		const found: Crossing[] = [];
		for (const segment of editor.graph.segments.values()) {
			const a = editor.graph.nodes.get(segment.startNodeId);
			const b = editor.graph.nodes.get(segment.endNodeId);
			if (!a || !b) continue;
			const cx = segment.controlX ?? (a.x + b.x) / 2;
			const cy = segment.controlY ?? (a.y + b.y) / 2;
			// The curve stays inside its points' box: skip roads nowhere near.
			if (
				Math.max(a.x, b.x, cx) < c.x - r ||
				Math.min(a.x, b.x, cx) > c.x + r ||
				Math.max(a.y, b.y, cy) < c.y - r ||
				Math.min(a.y, b.y, cy) > c.y + r
			) {
				continue;
			}
			const at = (t: number) => getQuadraticBezierPoint(a.x, a.y, cx, cy, b.x, b.y, t);
			const outside = (t: number) => {
				const p = at(t);
				return Math.hypot(p.x - c.x, p.y - c.y) > r;
			};
			for (let i = 0; i < CROSSING_SAMPLES; i++) {
				let lo = i / CROSSING_SAMPLES;
				let hi = (i + 1) / CROSSING_SAMPLES;
				const out = outside(lo);
				if (out === outside(hi)) continue;
				for (let k = 0; k < 30; k++) {
					const mid = (lo + hi) / 2;
					if (outside(mid) === out) lo = mid;
					else hi = mid;
				}
				const t = (lo + hi) / 2;
				const point = at(t);
				const near = [a, b]
					.map((node) => ({ node, d: Math.hypot(node.x - point.x, node.y - point.y) }))
					.filter((e) => e.d < ENDPOINT_EXCLUSION)
					.sort((p, q) => p.d - q.d)[0];
				found.push({
					angle: Math.atan2(point.y - c.y, point.x - c.x),
					point,
					segment,
					t,
					endNodeId: near?.node.id ?? null
				});
			}
		}
		// Roads meeting at one node on the circle are one crossing.
		return found.filter(
			(x, i) =>
				!found
					.slice(0, i)
					.some(
						(o) =>
							(x.endNodeId !== null && o.endNodeId === x.endNodeId) ||
							Math.hypot(o.point.x - x.point.x, o.point.y - x.point.y) < 0.1
					)
		);
	};

	// The ring's nodes in its direction: one at each crossing, and between
	// consecutive crossings as many equal pieces as keep each within 45°. No
	// crossings: eight pieces from the cursor.
	const ringPoints = (crossings: Crossing[], fallback: number): RingPoint[] => {
		if (crossings.length === 0) {
			return Array.from({ length: SEGMENTS }, (_, k) => ({
				angle: fallback + turn() * k * STEP,
				crossing: null
			}));
		}
		const first = crossings[0].angle;
		const sorted = [...crossings].sort(
			(p, q) => (ahead(first, p.angle) % TAU) - (ahead(first, q.angle) % TAU)
		);
		return sorted.flatMap((crossing, i) => {
			const gap = ahead(crossing.angle, sorted[(i + 1) % sorted.length].angle);
			const pieces = Math.ceil(gap / STEP - 1e-9);
			return Array.from({ length: pieces }, (_, j) => ({
				angle: crossing.angle + (turn() * gap * j) / pieces,
				crossing: j === 0 ? crossing : null
			}));
		});
	};

	// Segments chained start to end in the ring's direction, each bulged to
	// the circle by a control point on its middle radius, pushed out so the
	// quadratic touches the circle there.
	const lay = (
		graph: Graph,
		c: Pt,
		r: number,
		points: RingPoint[],
		lanes: Lane[],
		nodeFor: (point: RingPoint) => string
	) => {
		const ids = points.map(nodeFor);
		points.forEach((point, k) => {
			const next = (k + 1) % points.length;
			const sweep = ahead(point.angle, points[next].angle);
			const segment = graph.createSegment(ids[k], ids[next], cloneLanes(lanes));
			const control = onRing(c, r / Math.cos(sweep / 2), point.angle + (turn() * sweep) / 2);
			segment.setControlPoint(control.x, control.y);
		});
	};

	// Cut each crossed road through a new ring node, or move its near end onto
	// the circle. A road's later crossings are cut first, so its earlier ones
	// still lie on the piece that keeps its start.
	const cut = (crossings: Crossing[]) => {
		const ids = new Map<Crossing, string>();
		const kept = new Map<Segment, { piece: Segment; span: number }>();
		for (const x of [...crossings].sort((p, q) => q.t - p.t)) {
			const end = x.endNodeId ? editor.graph.nodes.get(x.endNodeId) : undefined;
			if (end) {
				end.x = x.point.x;
				end.y = x.point.y;
				ids.set(x, end.id);
				continue;
			}
			const { piece, span } = kept.get(x.segment) ?? { piece: x.segment, span: 1 };
			const node = editor.graph.createNode(x.point.x, x.point.y);
			editor.nodeRenderer.createNode(node);
			const halves = splitSegment(editor.graph, piece, x.t / span, node.id);
			if (halves) kept.set(x.segment, { piece: halves.left, span: x.t });
			ids.set(x, node.id);
		}
		return ids;
	};

	// The centre snaps onto a node it lands in (borrowing only its position),
	// else onto the grid. Cmd (Ctrl elsewhere) held: no snapping.
	const centreAt = (x: number, y: number) => {
		if (freeHeld) return { at: { x, y }, snapped: false };
		const node = nodeHitAt(editor, x, y).node;
		if (node) return { at: nodePoint(editor.graph, node), snapped: true };
		if (editor.gridEnabled) {
			const g = editor.gridSize;
			return { at: { x: Math.round(x / g) * g, y: Math.round(y / g) * g }, snapped: false };
		}
		return { at: { x, y }, snapped: false };
	};

	// The ring through the cursor, or null while it is too small to lay: its
	// inner edge must stay clear of the centre, and a road ending at the
	// centre (a crossroads under it) must be cut, never have its end pulled
	// onto the ring.
	const pendingRing = (x: number, y: number) => {
		if (!centre) return null;
		const { lanes, oneWay } = ringLanes();
		// With the grid on, the radius is a whole number of grid squares, so
		// a ring round a grid point meets the grid lines it crosses.
		const reach = Math.hypot(x - centre.x, y - centre.y);
		const g = editor.gridSize;
		const r = editor.gridEnabled && !freeHeld ? Math.round(reach / g) * g : reach;
		if (r < Math.max(getTotalWidth(lanes), ENDPOINT_EXCLUSION * 1.5)) return null;
		const angle = Math.atan2(y - centre.y, x - centre.x);
		const crossings = crossingsOf(centre, r);
		const points = ringPoints(crossings, angle);
		return { c: centre, r, angle, lanes, oneWay, crossings, points };
	};

	const updatePreview = (x: number, y: number) => {
		if (!centre) {
			const { at, snapped } = centreAt(x, y);
			cursor.place(at, snapped);
			return;
		}
		const ring = pendingRing(x, y);
		if (!ring) {
			ghost.clear();
			hideArrow();
			return;
		}
		ghost.show((graph) =>
			lay(graph, ring.c, ring.r, ring.points, ring.lanes, (point) => {
				const p = onRing(ring.c, ring.r, point.angle);
				return graph.createNode(p.x, p.y).id;
			})
		);
		if (!ring.oneWay) {
			hideArrow();
			return;
		}
		const s = turn();
		showArrow(onRing(ring.c, ring.r, ring.angle), {
			x: -Math.sin(ring.angle) * s,
			y: Math.cos(ring.angle) * s
		});
	};

	const cancel = () => {
		centre = null;
		ghost.clear();
		hideArrow();
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0 || event.altKey) return;
		freeHeld = event.metaKey || event.ctrlKey;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		lastWorld = { x: world.x, y: world.z };

		if (!centre) {
			centre = centreAt(world.x, world.z).at;
			updatePreview(world.x, world.z);
			return;
		}

		const ring = pendingRing(world.x, world.z);
		if (!ring) return;
		const ids = cut(ring.crossings);
		lay(editor.graph, ring.c, ring.r, ring.points, ring.lanes, (point) => {
			const id = point.crossing && ids.get(point.crossing);
			if (id) return id;
			const p = onRing(ring.c, ring.r, point.angle);
			const node = editor.graph.createNode(p.x, p.y);
			editor.nodeRenderer.createNode(node);
			return node.id;
		});
		editor.clearSelection();
		editor.rebuildRoads();
		editor.graph.save();
		cancel();
		updatePreview(world.x, world.z);
	};

	const onMouseMove = (event: MouseEvent) => {
		freeHeld = event.metaKey || event.ctrlKey;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		lastWorld = { x: world.x, y: world.z };
		updatePreview(world.x, world.z);
	};

	// F flips the ring's direction; Escape drops the pending ring, then
	// leaves the tool.
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey) {
			clockwise = !clockwise;
			if (lastWorld) updatePreview(lastWorld.x, lastWorld.y);
			return;
		}
		if (event.key !== 'Escape') return;
		if (centre) {
			cancel();
			if (lastWorld) updatePreview(lastWorld.x, lastWorld.y);
		} else {
			editor.mode = 'select';
		}
	};

	const cleanup = () => {
		cancel();
		ghost.destroy();
		cursor.destroy();
	};

	return { onMouseDown, onMouseMove, onKeyDown, cleanup };
}
