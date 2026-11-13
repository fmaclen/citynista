import * as THREE from 'three';
import {
	HANDLE_HIT_SLACK_PX,
	HANDLE_OUTLINE_COLOR,
	HANDLE_OUTLINE_PX,
	HANDLE_STATE_COLOR,
	type HandleState
} from './editor-palette';

// The shapes of the editor's handles, and the hit test that matches them.
//
// Shape says what a handle does; colour says its state (editor-palette.ts).
// Every handle is built from a few shared parts: one arrowhead (a triangle
// with a HEAD_TIP_DEG tip), one solid stem STEM_PX thick, a bar and a dot.
// Every corner is rounded by CORNER_PX, and every handle rests in the same
// fill over the same dark outline.
//
// - An arrow (head on a stem) points along a road: the way a taper handle
//   pulls, the way traffic runs round a pending circle.
// - A double arrow (a head each end of a stem) slides across a road: offset.
// - A square is a point to put anywhere: the curvature control.
// - A bar across a road is a crossing: striped while on, a hollow frame off.
//
// A handle is modelled in screen pixels in its own frame: x runs along the
// handle's axis (`dir`, a unit vector on the ground), y across it. It is drawn
// as convex pieces in its fill over the same pieces grown by the outline
// width, so its edge reads on any ground. The scene manager scales every
// handle registered in its `screenSized` map to world units per pixel before
// each frame (never above the map's value), which keeps handles the same size
// on screen at any zoom.

export type ScreenSized = Map<THREE.Object3D, number>;

// A plain map: nothing reacts to it, the render loop reads it each frame.
export function screenSizedMap() {
	return new Map<THREE.Object3D, number>();
}

interface Pt {
	x: number;
	y: number;
}
type Piece = Pt[];

export interface HandleShape {
	// Half extents of its box, for the hit test.
	along: number;
	across: number;
	fill: Piece[];
	// Drawn over the fill in the outline colour (a crossing's stripes).
	detail?: Piece[];
}

export const CORNER_PX = 1.5;
export const HEAD_TIP_DEG = 60;
export const HEAD_LENGTH_PX = 10;
export const STEM_PX = 4;
const HEAD_HALF_WIDTH = HEAD_LENGTH_PX * Math.tan(((HEAD_TIP_DEG / 2) * Math.PI) / 180);
// How far a stem runs on into its head, so the two read as one piece.
const STEM_INTO_HEAD = HEAD_LENGTH_PX * 0.4;
const CORNER_STEPS = 4;

// A convex piece with every corner turned into an arc of `r` (less where an
// edge is too short for it).
// Pieces come out wound one way, so the panel's SVG fills their overlaps.
function rounded(corners: Piece, r = CORNER_PX): Piece {
	const n = corners.length;
	let area = 0;
	for (let i = 0; i < n; i++) {
		const a = corners[i];
		const b = corners[(i + 1) % n];
		area += a.x * b.y - b.x * a.y;
	}
	const piece = area < 0 ? [...corners].reverse() : corners;
	const out: Piece = [];
	for (let i = 0; i < n; i++) {
		const p = piece[i];
		const prev = piece[(i + n - 1) % n];
		const next = piece[(i + 1) % n];
		const l1 = Math.hypot(prev.x - p.x, prev.y - p.y);
		const l2 = Math.hypot(next.x - p.x, next.y - p.y);
		const u1 = { x: (prev.x - p.x) / l1, y: (prev.y - p.y) / l1 };
		const u2 = { x: (next.x - p.x) / l2, y: (next.y - p.y) / l2 };
		const half = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))) / 2;
		// Where the arc leaves each edge, at most a little under half of it.
		const d = Math.min(r / Math.tan(half), 0.45 * Math.min(l1, l2));
		const radius = d * Math.tan(half);
		const bx = u1.x + u2.x;
		const by = u1.y + u2.y;
		const bl = Math.hypot(bx, by) || 1;
		const toCentre = radius / Math.sin(half);
		const c = { x: p.x + (bx / bl) * toCentre, y: p.y + (by / bl) * toCentre };
		const a0 = Math.atan2(p.y + u1.y * d - c.y, p.x + u1.x * d - c.x);
		const a1 = Math.atan2(p.y + u2.y * d - c.y, p.x + u2.x * d - c.x);
		let sweep = a1 - a0;
		if (sweep > Math.PI) sweep -= 2 * Math.PI;
		if (sweep < -Math.PI) sweep += 2 * Math.PI;
		for (let k = 0; k <= CORNER_STEPS; k++) {
			const a = a0 + (sweep * k) / CORNER_STEPS;
			out.push({ x: c.x + Math.cos(a) * radius, y: c.y + Math.sin(a) * radius });
		}
	}
	return out;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Piece =>
	rounded([
		{ x: x0, y: y0 },
		{ x: x1, y: y0 },
		{ x: x1, y: y1 },
		{ x: x0, y: y1 }
	]);

// The arrowhead: its base across x = `base`, its tip `HEAD_LENGTH_PX` on
// along `sign` (+1 or -1).
function head(base: number, sign = 1): Piece {
	const tip = base + sign * HEAD_LENGTH_PX;
	return rounded([
		{ x: tip, y: 0 },
		{ x: base, y: -sign * HEAD_HALF_WIDTH },
		{ x: base, y: sign * HEAD_HALF_WIDTH }
	]);
}

// The stem from x0 to x1, centred on the axis.
const stem = (x0: number, x1: number) => rect(x0, -STEM_PX / 2, x1, STEM_PX / 2);

// An arrow of total length 2 × `half`, centred on its point, pointing +x.
function arrow(half: number): HandleShape {
	const base = half - HEAD_LENGTH_PX;
	return {
		along: half,
		across: HEAD_HALF_WIDTH,
		fill: [stem(-half, base + STEM_INTO_HEAD), head(base)]
	};
}

// A head at each end of a stem, `half` from the centre to either tip.
function doubleArrow(half: number): HandleShape {
	const base = half - HEAD_LENGTH_PX;
	return {
		along: half,
		across: HEAD_HALF_WIDTH,
		fill: [stem(-base - STEM_INTO_HEAD, base + STEM_INTO_HEAD), head(base), head(-base, -1)]
	};
}

function square(half: number): HandleShape {
	return { along: half, across: half, fill: [rect(-half, -half, half, half)] };
}

const ZEBRA_STRIPES = 4;
const FRAME_PX = 2.5;
const STRIPE_INSET_PX = 1.5;

// A bar along the handle's axis: striped across while its crossing is on,
// only its frame while it is off.
function crossingBar(along: number, across: number, on: boolean): HandleShape {
	const bar = rect(-along, -across, along, across);
	if (!on) {
		const t = FRAME_PX;
		return {
			along,
			across,
			fill: [bar],
			detail: [rect(-along + t, -across + t, along - t, across - t)]
		};
	}
	const pitch = (2 * along) / ZEBRA_STRIPES;
	const detail = Array.from({ length: ZEBRA_STRIPES }, (_, k) => {
		const mid = -along + (k + 0.5) * pitch;
		return rect(
			mid - pitch / 4,
			-across + STRIPE_INSET_PX,
			mid + pitch / 4,
			across - STRIPE_INSET_PX
		);
	});
	return { along, across, fill: [bar], detail };
}

// A road's curvature control.
export const CURVE_HANDLE = square(7);
// A road's sideways offset, across the road.
export const OFFSET_HANDLE = doubleArrow(15);
// Where a two-road node's taper ends, pointing along the road away from it.
export const TAPER_HANDLE = arrow(10);
// The way traffic runs round a pending circle.
export const DIRECTION_HANDLE = arrow(10);
// A crossing in the lane connector, across its road.
export const CROSSING_HANDLE = crossingBar(14, 6, true);
export const CROSSING_OFF_HANDLE = crossingBar(14, 6, false);

const DOT_SEGMENTS = 20;

// A lane connector dot: a disc, or a ring (`inner` > 0).
export function dotShape(radius: number, inner = 0): HandleShape {
	const at = (r: number, k: number) => {
		const angle = (k / DOT_SEGMENTS) * Math.PI * 2;
		return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
	};
	const fill =
		inner <= 0
			? [Array.from({ length: DOT_SEGMENTS }, (_, k) => at(radius, k))]
			: Array.from({ length: DOT_SEGMENTS }, (_, k) => [
					at(inner, k),
					at(radius, k),
					at(radius, k + 1),
					at(inner, k + 1)
				]);
	return { along: radius, across: radius, fill };
}

// Handle materials draw over everything, in render order rather than depth.
function handleMaterial(color: number) {
	return new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		side: THREE.DoubleSide,
		depthTest: false,
		depthWrite: false
	});
}

// One set of materials shared by every handle: the outline (also a
// crossing's stripes) and the fill in each state. They live as long as the
// page does.
let materials: { outline: THREE.Material; fill: Record<HandleState, THREE.Material> } | null = null;
function shared() {
	materials ??= {
		outline: handleMaterial(HANDLE_OUTLINE_COLOR),
		fill: {
			rest: handleMaterial(HANDLE_STATE_COLOR.rest),
			hover: handleMaterial(HANDLE_STATE_COLOR.hover),
			active: handleMaterial(HANDLE_STATE_COLOR.active),
			valid: handleMaterial(HANDLE_STATE_COLOR.valid),
			danger: handleMaterial(HANDLE_STATE_COLOR.danger)
		}
	};
	return materials;
}

// A convex piece grown by `by` on every side (each vertex moved out along
// its corner's mitre).
function grow(piece: Piece, by: number): Piece {
	const n = piece.length;
	let area = 0;
	for (let i = 0; i < n; i++) {
		const a = piece[i];
		const b = piece[(i + 1) % n];
		area += a.x * b.y - b.x * a.y;
	}
	const side = area > 0 ? 1 : -1;
	const normal = (a: Pt, b: Pt) => {
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		return { x: (side * (b.y - a.y)) / l, y: (side * -(b.x - a.x)) / l };
	};
	return piece.map((p, i) => {
		const n1 = normal(piece[(i + n - 1) % n], p);
		const n2 = normal(p, piece[(i + 1) % n]);
		const k = by / (1 + n1.x * n2.x + n1.y * n2.y);
		return { x: p.x + (n1.x + n2.x) * k, y: p.y + (n1.y + n2.y) * k };
	});
}

// Convex pieces as triangle fans on the ground plane (local x, 0, y).
function piecesGeometry(pieces: Piece[]) {
	const positions: number[] = [];
	for (const piece of pieces) {
		for (let i = 1; i < piece.length - 1; i++) {
			for (const p of [piece[0], piece[i], piece[i + 1]]) positions.push(p.x, 0, p.y);
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	return geometry;
}

// A handle placed at `at` (ground x, y), its axis turned to `dir`, drawn at
// height y from render order `order` up (outline, fill, detail).
export function handleObject(
	shape: HandleShape,
	at: Pt,
	dir: Pt,
	y: number,
	order: number,
	state: HandleState = 'rest'
) {
	const { outline, fill } = shared();
	const group = new THREE.Group();
	const edge = new THREE.Mesh(
		piecesGeometry(shape.fill.map((p) => grow(p, HANDLE_OUTLINE_PX))),
		outline
	);
	edge.renderOrder = order;
	const body = new THREE.Mesh(piecesGeometry(shape.fill), fill[state]);
	body.renderOrder = order + 1;
	group.add(edge, body);
	if (shape.detail) {
		const detail = new THREE.Mesh(piecesGeometry(shape.detail), outline);
		detail.renderOrder = order + 2;
		group.add(detail);
	}
	group.position.set(at.x, y, at.y);
	// Local +x onto dir (rotation about +Y takes x to (cos, -sin)).
	group.rotation.y = Math.atan2(-dir.y, dir.x);
	return group;
}

// Tints a handle made by handleObject for its state.
export function setHandleState(object: THREE.Object3D, state: HandleState) {
	const body = object.children[1];
	if (body instanceof THREE.Mesh) body.material = shared().fill[state];
}

export function disposeHandleObject(object: THREE.Object3D) {
	object.traverse((o) => {
		if (o instanceof THREE.Mesh) o.geometry.dispose();
	});
}

// Whether a ground point picks a handle of this shape at `at`, turned to
// `dir`, at `scale` world units per pixel: inside its box plus the slack.
export function hitsHandle(
	shape: HandleShape,
	at: Pt,
	dir: Pt,
	x: number,
	y: number,
	scale: number
) {
	const dx = x - at.x;
	const dy = y - at.y;
	const u = (dx * dir.x + dy * dir.y) / scale;
	const v = (-dx * dir.y + dy * dir.x) / scale;
	return (
		Math.abs(u) <= shape.along + HANDLE_HIT_SLACK_PX &&
		Math.abs(v) <= shape.across + HANDLE_HIT_SLACK_PX
	);
}
