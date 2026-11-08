import * as THREE from 'three';
import {
	HANDLE_HIT_SLACK_PX,
	HANDLE_OUTLINE_COLOR,
	HANDLE_OUTLINE_PX,
	type HandleLook
} from './editor-palette';

// The shapes of the editor's handles, and the hit test that matches them.
//
// A handle is modelled in screen pixels in its own frame: x runs along the
// handle's axis (`dir`, a unit vector on the ground), y across it. It is drawn
// as convex pieces in its colour over the same pieces grown by the outline
// width in a dark tone, so its edge reads on any ground. The scene manager
// scales every handle registered in its `screenSized` map to world units per
// pixel before each frame (never above the map's value), which keeps handles
// the same size on screen at any zoom.

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

export interface HandleParts {
	fill: Piece[];
	// Drawn over the fill in the detail material (a crossing's stripes).
	detail?: Piece[];
}

export interface HandleMaterials {
	outline: THREE.Material;
	fill: THREE.Material;
	detail?: THREE.Material;
}

// Handle materials draw over everything, in render order rather than depth.
export function handleMaterial(color: number) {
	return new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		side: THREE.DoubleSide,
		depthTest: false,
		depthWrite: false
	});
}

export function outlineMaterial() {
	return handleMaterial(HANDLE_OUTLINE_COLOR);
}

const rect = (x0: number, y0: number, x1: number, y1: number): Piece => [
	{ x: x0, y: y0 },
	{ x: x1, y: y0 },
	{ x: x1, y: y1 },
	{ x: x0, y: y1 }
];

// A square on the curvature handle.
export function squareShape(look: HandleLook): HandleParts {
	return { fill: [rect(-look.along, -look.across, look.along, look.across)] };
}

// A two-headed arrow along the handle's axis: the offset slides that way.
export function arrowShape(look: HandleLook): HandleParts {
	const head = look.along * 0.45;
	const shaft = look.across * 0.35;
	const neck = look.along - head;
	return {
		fill: [
			rect(-neck, -shaft, neck, shaft),
			[
				{ x: look.along, y: 0 },
				{ x: neck, y: look.across },
				{ x: neck, y: -look.across }
			],
			[
				{ x: -look.along, y: 0 },
				{ x: -neck, y: -look.across },
				{ x: -neck, y: look.across }
			]
		]
	};
}

// A triangle pointing along the handle's axis.
export function triangleShape(look: HandleLook): HandleParts {
	return {
		fill: [
			[
				{ x: look.along, y: 0 },
				{ x: -look.along, y: look.across },
				{ x: -look.along, y: -look.across }
			]
		]
	};
}

const ZEBRA_STRIPES = 4;
const FRAME_PX = 2.5;

// A bar along the handle's axis with zebra stripes across it; `hollow`
// leaves only its frame (a crossing that is switched off).
export function zebraShape(look: HandleLook, hollow: boolean): HandleParts {
	const { along: a, across: c } = look;
	if (hollow) {
		const t = FRAME_PX;
		return {
			fill: [
				rect(-a, -c, a, -c + t),
				rect(-a, c - t, a, c),
				rect(-a, -c, -a + t, c),
				rect(a - t, -c, a, c)
			]
		};
	}
	const pitch = (2 * a) / ZEBRA_STRIPES;
	const inset = 1.5;
	const detail = Array.from({ length: ZEBRA_STRIPES }, (_, k) => {
		const mid = -a + (k + 0.5) * pitch;
		return rect(mid - pitch / 4, -c + inset, mid + pitch / 4, c - inset);
	});
	return { fill: [rect(-a, -c, a, c)], detail };
}

const DOT_SEGMENTS = 20;

// A lane connector dot: a disc, or a ring (`inner` > 0).
export function dotShape(radius: number, inner = 0): HandleParts {
	const at = (r: number, k: number) => {
		const angle = (k / DOT_SEGMENTS) * Math.PI * 2;
		return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
	};
	if (inner <= 0) {
		return { fill: [Array.from({ length: DOT_SEGMENTS }, (_, k) => at(radius, k))] };
	}
	return {
		fill: Array.from({ length: DOT_SEGMENTS }, (_, k) => [
			at(inner, k),
			at(radius, k),
			at(radius, k + 1),
			at(inner, k + 1)
		])
	};
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
	parts: HandleParts,
	materials: HandleMaterials,
	at: Pt,
	dir: Pt,
	y: number,
	order: number
) {
	const group = new THREE.Group();
	const outline = new THREE.Mesh(
		piecesGeometry(parts.fill.map((p) => grow(p, HANDLE_OUTLINE_PX))),
		materials.outline
	);
	outline.renderOrder = order;
	const fill = new THREE.Mesh(piecesGeometry(parts.fill), materials.fill);
	fill.renderOrder = order + 1;
	group.add(outline, fill);
	if (parts.detail && materials.detail) {
		const detail = new THREE.Mesh(piecesGeometry(parts.detail), materials.detail);
		detail.renderOrder = order + 2;
		group.add(detail);
	}
	group.position.set(at.x, y, at.y);
	// Local +x onto dir (rotation about +Y takes x to (cos, -sin)).
	group.rotation.y = Math.atan2(-dir.y, dir.x);
	return group;
}

export function disposeHandleObject(object: THREE.Object3D) {
	object.traverse((o) => {
		if (o instanceof THREE.Mesh) o.geometry.dispose();
	});
}

// Whether a ground point picks a handle of this look at `at`, turned to
// `dir`, at `scale` world units per pixel: inside its box plus the slack.
export function hitsHandle(look: HandleLook, at: Pt, dir: Pt, x: number, y: number, scale: number) {
	const dx = x - at.x;
	const dy = y - at.y;
	const u = (dx * dir.x + dy * dir.y) / scale;
	const v = (-dx * dir.y + dy * dir.x) / scale;
	return (
		Math.abs(u) <= look.along + HANDLE_HIT_SLACK_PX &&
		Math.abs(v) <= look.across + HANDLE_HIT_SLACK_PX
	);
}
