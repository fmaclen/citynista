import * as THREE from 'three';
import type { Editor } from '../editor.svelte';
import { quadContents } from './picking';

const MARQUEE_Y = 0.5;

// A screen-space selection marquee. The drag is tracked in screen pixels, so the
// rectangle is always what the user draws; its world footprint is the four
// unprojected screen corners — a parallelogram once the camera is rotated or
// tilted — which both the fill and the containment test use.
export function createMarquee(editor: Editor, color: number, fillOpacity: number) {
	const fillPositions = new Float32Array(12);
	const fillGeometry = new THREE.BufferGeometry();
	fillGeometry.setAttribute('position', new THREE.BufferAttribute(fillPositions, 3));
	fillGeometry.setIndex([0, 1, 2, 0, 2, 3]);
	const fillMaterial = new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity: fillOpacity,
		depthWrite: false
	});
	const fill = new THREE.Mesh(fillGeometry, fillMaterial);
	fill.frustumCulled = false;
	fill.visible = false;
	editor.sceneManager.scene.add(fill);

	const outlinePositions = new Float32Array(12);
	const outlineGeometry = new THREE.BufferGeometry();
	outlineGeometry.setAttribute('position', new THREE.BufferAttribute(outlinePositions, 3));
	const outlineMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
	const outline = new THREE.LineLoop(outlineGeometry, outlineMaterial);
	outline.frustumCulled = false;
	outline.visible = false;
	editor.sceneManager.scene.add(outline);

	let start: { x: number; y: number } | null = null;
	let corners: { x: number; y: number }[] = [];

	const setVisible = (visible: boolean) => {
		fill.visible = visible;
		outline.visible = visible;
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
				outlinePositions[i * 3] = corners[i].x;
				outlinePositions[i * 3 + 1] = MARQUEE_Y;
				outlinePositions[i * 3 + 2] = corners[i].y;
			}
			fillGeometry.attributes.position.needsUpdate = true;
			outlineGeometry.attributes.position.needsUpdate = true;
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
			editor.sceneManager.scene.remove(outline);
			fillGeometry.dispose();
			fillMaterial.dispose();
			outlineGeometry.dispose();
			outlineMaterial.dispose();
		}
	};
}
