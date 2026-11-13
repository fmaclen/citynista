import * as THREE from 'three';
import type { Pt as Point } from '../lab/model';
import { createEditorLineMaterial } from './editor-line';
import { HANDLE_FILL, HANDLE_OUTLINE_COLOR, HANDLE_OUTLINE_PX } from './editor-palette';

// Dashed guides for a selected node's handles: straight lines in the handle
// fill over the handles' dark outline, each dash and gap a fixed size on
// screen. A line keeps its length on the ground, so how many dashes it holds
// changes with the zoom: the dashes are laid out again before any frame
// drawn at a new zoom, not scaled.
const DASH_PX = 7;
const GAP_PX = 5;
const WIDTH_PX = 2;
const Y = 0.29;
// Beneath the handles (handle-renderer.ts), above everything else.
const RENDER_ORDER = 6;

// Hooks called with world units per pixel before each frame draws (the
// scene manager's `beforeFrame`). A plain set: nothing reacts to it, the
// render loop reads it each frame.
export type FrameHooks = Set<(worldPerPixel: number) => void>;
export function frameHooks(): FrameHooks {
	return new Set();
}

// Quads for the dashes along each line, `grow` pixels bigger all round.
function dashes(lines: [Point, Point][], wpp: number, grow: number) {
	const positions: number[] = [];
	const half = (WIDTH_PX / 2 + grow) * wpp;
	for (const [a, b] of lines) {
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length < 1e-6) continue;
		const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
		const n = { x: -u.y * half, y: u.x * half };
		const at = (d: number) => ({ x: a.x + u.x * d, y: a.y + u.y * d });
		for (let s = 0; s < length; s += (DASH_PX + GAP_PX) * wpp) {
			const p = at(Math.max(0, s - grow * wpp));
			const q = at(Math.min(length, s + (DASH_PX + grow) * wpp));
			const c = [
				[p.x - n.x, p.y - n.y],
				[q.x - n.x, q.y - n.y],
				[q.x + n.x, q.y + n.y],
				[p.x + n.x, p.y + n.y]
			];
			for (const i of [0, 1, 2, 0, 2, 3]) positions.push(c[i][0], Y, c[i][1]);
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	return geometry;
}

export class GuideRenderer {
	private scene: THREE.Scene;
	private beforeFrame: FrameHooks;
	private lines: [Point, Point][] = [];
	private wpp = 0;
	private outline: THREE.Mesh;
	private fill: THREE.Mesh;
	private frame = (wpp: number) => {
		if (this.lines.length && wpp !== this.wpp) this.layout(wpp);
	};

	constructor(scene: THREE.Scene, beforeFrame: FrameHooks) {
		this.scene = scene;
		this.beforeFrame = beforeFrame;
		this.outline = this.mesh(HANDLE_OUTLINE_COLOR, RENDER_ORDER);
		this.fill = this.mesh(HANDLE_FILL, RENDER_ORDER + 1);
		beforeFrame.add(this.frame);
	}

	private mesh(color: number, order: number) {
		const mesh = new THREE.Mesh(new THREE.BufferGeometry(), createEditorLineMaterial(color, 1));
		mesh.renderOrder = order;
		mesh.visible = false;
		this.scene.add(mesh);
		return mesh;
	}

	private layout(wpp: number) {
		this.wpp = wpp;
		for (const [mesh, grow] of [
			[this.outline, HANDLE_OUTLINE_PX],
			[this.fill, 0]
		] as const) {
			mesh.geometry.dispose();
			mesh.geometry = dashes(this.lines, wpp, grow);
		}
	}

	// Laid out at the next frame's zoom.
	show(lines: [Point, Point][]) {
		this.lines = lines;
		this.wpp = 0;
		this.outline.visible = this.fill.visible = lines.length > 0;
	}

	clear() {
		this.show([]);
	}

	dispose() {
		this.beforeFrame.delete(this.frame);
		for (const mesh of [this.outline, this.fill]) {
			this.scene.remove(mesh);
			mesh.geometry.dispose();
			(mesh.material as THREE.Material).dispose();
		}
	}
}
