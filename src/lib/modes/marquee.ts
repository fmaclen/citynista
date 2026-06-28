import * as THREE from 'three';
import type { Editor } from '../editor.svelte';
import { quadContents } from './picking';

const MARQUEE_Y = 0.5;
const FRAME_OPACITY = 0.9;

// One inset corner of the frame: move `cur` inward along the angle bisector of
// its two edges by enough that the border keeps a constant perpendicular width
// `t` on both edges (a miter join). Works for the parallelogram the marquee
// becomes once the camera is rotated, not just an axis-aligned rectangle.
function insetCorner(
	prev: { x: number; y: number },
	cur: { x: number; y: number },
	next: { x: number; y: number },
	t: number
) {
	const l1 = Math.hypot(prev.x - cur.x, prev.y - cur.y) || 1;
	const l2 = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
	const u1x = (prev.x - cur.x) / l1;
	const u1y = (prev.y - cur.y) / l1;
	const u2x = (next.x - cur.x) / l2;
	const u2y = (next.y - cur.y) / l2;
	let bx = u1x + u2x;
	let by = u1y + u2y;
	const bl = Math.hypot(bx, by);
	if (bl < 1e-6) {
		// Degenerate (collinear edges) — offset perpendicular to one edge.
		return { x: cur.x - u2y * t, y: cur.y + u2x * t };
	}
	bx /= bl;
	by /= bl;
	const cosHalf = u1x * bx + u1y * by;
	const sinHalf = Math.sqrt(Math.max(1e-6, 1 - cosHalf * cosHalf));
	const dist = t / sinHalf;
	return { x: cur.x + bx * dist, y: cur.y + by * dist };
}

// A screen-space selection marquee. The drag is tracked in screen pixels, so the
// rectangle is always what the user draws; its world footprint is the four
// unprojected screen corners — a parallelogram once the camera is rotated or
// tilted — which the fill, the frame and the containment test all use. The frame
// is a solid mesh band (not a 1px line, which WebGL can't thicken) `thickness`
// world units wide, so it matches the editor's node/connector rings.
export function createMarquee(
	editor: Editor,
	color: number,
	fillOpacity: number,
	thickness: number
) {
	const fillPositions = new Float32Array(12);
	const fillGeometry = new THREE.BufferGeometry();
	fillGeometry.setAttribute('position', new THREE.BufferAttribute(fillPositions, 3));
	fillGeometry.setIndex([0, 1, 2, 0, 2, 3]);
	const fillMaterial = new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity: fillOpacity,
		// DoubleSide: the unprojected quad can wind away from the top-down camera,
		// which would back-face cull a single-sided fill (it never showed before).
		side: THREE.DoubleSide,
		depthWrite: false
	});
	const fill = new THREE.Mesh(fillGeometry, fillMaterial);
	fill.frustumCulled = false;
	fill.visible = false;
	editor.sceneManager.scene.add(fill);

	// Frame: 4 outer corners + 4 inset corners, two triangles per edge.
	const framePositions = new Float32Array(24);
	const frameGeometry = new THREE.BufferGeometry();
	frameGeometry.setAttribute('position', new THREE.BufferAttribute(framePositions, 3));
	const frameIndex: number[] = [];
	for (let i = 0; i < 4; i++) {
		const o0 = i;
		const o1 = (i + 1) % 4;
		const i0 = 4 + i;
		const i1 = 4 + ((i + 1) % 4);
		frameIndex.push(o0, o1, i1, o0, i1, i0);
	}
	frameGeometry.setIndex(frameIndex);
	const frameMaterial = new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity: FRAME_OPACITY,
		side: THREE.DoubleSide,
		depthWrite: false
	});
	const frame = new THREE.Mesh(frameGeometry, frameMaterial);
	frame.frustumCulled = false;
	frame.visible = false;
	editor.sceneManager.scene.add(frame);

	let start: { x: number; y: number } | null = null;
	let corners: { x: number; y: number }[] = [];

	const setVisible = (visible: boolean) => {
		fill.visible = visible;
		frame.visible = visible;
	};

	return {
		get active() {
			return start !== null;
		},
		begin(screenX: number, screenY: number) {
			start = { x: screenX, y: screenY };
			corners = [];
		},
		update(screenX: number, screenY: number) {
			if (!start) return;
			const screenCorners = [
				{ x: start.x, y: start.y },
				{ x: screenX, y: start.y },
				{ x: screenX, y: screenY },
				{ x: start.x, y: screenY }
			];
			corners = screenCorners.map((corner) => {
				const world = editor.sceneManager.screenToWorld(corner.x, corner.y);
				return { x: world.x, y: world.z };
			});
			for (let i = 0; i < 4; i++) {
				fillPositions[i * 3] = corners[i].x;
				fillPositions[i * 3 + 1] = MARQUEE_Y;
				fillPositions[i * 3 + 2] = corners[i].y;
				framePositions[i * 3] = corners[i].x;
				framePositions[i * 3 + 1] = MARQUEE_Y;
				framePositions[i * 3 + 2] = corners[i].y;
			}
			for (let i = 0; i < 4; i++) {
				const inner = insetCorner(corners[(i + 3) % 4], corners[i], corners[(i + 1) % 4], thickness);
				framePositions[(4 + i) * 3] = inner.x;
				framePositions[(4 + i) * 3 + 1] = MARQUEE_Y;
				framePositions[(4 + i) * 3 + 2] = inner.y;
			}
			fillGeometry.attributes.position.needsUpdate = true;
			frameGeometry.attributes.position.needsUpdate = true;
			setVisible(true);
		},
		contents() {
			return quadContents(editor, corners);
		},
		end() {
			start = null;
			corners = [];
			setVisible(false);
		},
		dispose() {
			editor.sceneManager.scene.remove(fill);
			editor.sceneManager.scene.remove(frame);
			fillGeometry.dispose();
			fillMaterial.dispose();
			frameGeometry.dispose();
			frameMaterial.dispose();
		}
	};
}
