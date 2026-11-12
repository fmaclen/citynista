import * as THREE from 'three';
import type { Editor } from '../editor.svelte';
import { Graph } from '../core/graph.svelte';
import type { GraphData } from '../core/types';
import { LabRenderer } from '../rendering/lab-renderer';
import { HOVER_COLOR, SELECT_COLOR } from '../rendering/editor-palette';
import { nodeRingGeometry } from '../rendering/node-renderer';
import { disposeHandleObject, dotShape, handleObject } from '../rendering/handle-shapes';
import { getTotalWidth } from '../core/lane-template';

// What the drawing modes show before a click: the roads it would lay, drawn
// faint from a scratch graph, and a ring under the cursor.

const GHOST_OPACITY = 0.45;
const GHOST_ELEVATION = 0.06;
const CURSOR_Y = 0.3;

// The pending roads: `show` lays them into a scratch graph and draws it. Given
// a copy of the roads they touch (`around`), it lays them in among those and
// draws only what `lay` names: the pending roads and the joints at the nodes
// they touch, built as the click will build them. The copied roads are already
// on the map and aren't drawn again.
export function roadGhost(editor: Editor) {
	const renderer = new LabRenderer(editor.sceneManager.scene, {
		opacity: GHOST_OPACITY,
		lift: GHOST_ELEVATION
	});
	const graph = new Graph();
	editor.ghost = { graph, renderer };
	return {
		show(lay: (graph: Graph) => Shown | void, around?: GraphData) {
			graph.clear();
			if (around) graph.fromJSON(around);
			const shown = lay(graph);
			renderer.update(
				graph,
				shown ? { roads: new Set(shown.roads), nodes: new Set(shown.nodes) } : undefined
			);
		},
		clear() {
			graph.clear();
			renderer.clear();
		},
		destroy() {
			renderer.destroy();
			if (editor.ghost?.graph === graph) editor.ghost = null;
		}
	};
}

interface Shown {
	roads: string[];
	nodes: string[];
}

// A node ring under the cursor, the size and style of the node the click
// makes: cyan while free (hover), yellow once snapped (committed). Around it
// a faint disc in the same colour, world-sized, as wide as the armed preset
// is across, so the road's width shows before the first click at any zoom.
const WIDTH_OPACITY = 0.18;
const WIDTH_Y = CURSOR_Y - 0.01;
const WIDTH_SEGMENTS = 64;

export function ghostCursor(editor: Editor) {
	const material = new THREE.MeshBasicMaterial({
		color: HOVER_COLOR,
		transparent: true,
		opacity: 0.8
	});
	const mesh = new THREE.Mesh(nodeRingGeometry(), material);
	mesh.rotation.x = -Math.PI / 2;
	mesh.visible = false;
	editor.sceneManager.scene.add(mesh);
	editor.sceneManager.screenSized.set(mesh, Infinity);

	// A unit-diameter disc, scaled to the preset's width.
	const widthMaterial = new THREE.MeshBasicMaterial({
		color: HOVER_COLOR,
		transparent: true,
		opacity: WIDTH_OPACITY,
		depthWrite: false
	});
	const width = new THREE.Mesh(new THREE.CircleGeometry(0.5, WIDTH_SEGMENTS), widthMaterial);
	width.name = 'cursor-width';
	width.rotation.x = -Math.PI / 2;
	width.visible = false;
	editor.sceneManager.scene.add(width);

	return {
		place(at: { x: number; y: number }, snapped: boolean) {
			const colour = snapped ? SELECT_COLOR : HOVER_COLOR;
			mesh.visible = true;
			mesh.position.set(at.x, CURSOR_Y, at.y);
			material.color.setHex(colour);

			const across = getTotalWidth(editor.activeBrush?.lanes ?? []);
			width.visible = across > 0;
			width.position.set(at.x, WIDTH_Y, at.y);
			width.scale.set(across, across, 1);
			widthMaterial.color.setHex(colour);
		},
		hide() {
			mesh.visible = false;
			width.visible = false;
		},
		destroy() {
			editor.sceneManager.scene.remove(mesh, width);
			editor.sceneManager.screenSized.delete(mesh);
			mesh.geometry.dispose();
			material.dispose();
			width.geometry.dispose();
			widthMaterial.dispose();
		}
	};
}

// The attach points across a road, in screen pixels: the live one a filled
// dot, the others rings, all in the committed tint.
const DOT_PX = 4.5;
const DOT_HOLE_PX = 2.5;
const DOT_Y = 0.33;
const DOT_ORDER = 8;

export function attachDots(editor: Editor) {
	let shown: THREE.Object3D[] = [];

	const hide = () => {
		for (const dot of shown) {
			editor.sceneManager.screenSized.delete(dot);
			editor.sceneManager.scene.remove(dot);
			disposeHandleObject(dot);
		}
		shown = [];
	};

	return {
		show(points: { x: number; y: number }[], live: number) {
			hide();
			shown = points.map((at, i) => {
				const shape = i === live ? dotShape(DOT_PX) : dotShape(DOT_PX, DOT_HOLE_PX);
				const dot = handleObject(shape, at, { x: 1, y: 0 }, DOT_Y, DOT_ORDER, 'active');
				editor.sceneManager.screenSized.set(dot, Infinity);
				editor.sceneManager.scene.add(dot);
				return dot;
			});
		},
		hide,
		destroy: hide
	};
}
