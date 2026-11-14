import { expect, test } from 'bun:test';
import { Box3, Scene } from 'three';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { Lane } from '../src/lib/core/types';
import { ghostCursor } from '../src/lib/modes/ghost';

// The cursor in the drawing modes carries a disc as wide as the armed preset
// is across (modes/ghost.ts), so the road's width shows before the first
// click.

test('the cursor carries a circle as wide as the armed preset', () => {
	const scene = new Scene();
	const editor = {
		sceneManager: { scene, screenSized: new Map() },
		activeBrush: null as { lanes: Lane[] } | null
	};
	const cursor = ghostCursor(editor as never);
	const disc = scene.getObjectByName('cursor-width')!;
	// The disc's centre and radius on the ground, from where it lies.
	const placed = (lanes: Lane[] | null) => {
		editor.activeBrush = lanes && { lanes };
		cursor.place({ x: 3, y: 4 }, false);
		disc.updateMatrixWorld();
		const { min, max } = new Box3().setFromObject(disc);
		return {
			visible: disc.visible,
			centre: { x: (min.x + max.x) / 2, y: (min.z + max.z) / 2 },
			radius: [(max.x - min.x) / 2, (max.z - min.z) / 2]
		};
	};

	// One-way lane: 3.5 m across.
	const narrow = placed(createLanesFrom('lane'));
	expect(narrow.visible).toBe(true);
	expect(narrow.centre.x).toBeCloseTo(3, 6);
	expect(narrow.centre.y).toBeCloseTo(4, 6);
	for (const r of narrow.radius) expect(r).toBeCloseTo(3.5 / 2, 6);

	// Highway: six 3.5 m lanes and a 3 m median, 24 m across.
	for (const r of placed(createLanesFrom('highway')).radius) expect(r).toBeCloseTo(24 / 2, 6);

	// Nothing armed: no circle.
	expect(placed(null).visible).toBe(false);
});
