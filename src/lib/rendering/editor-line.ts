import * as THREE from 'three';

// The shared look of every "editor line" — connector movement arcs, setback
// stems, bezier curvature guides: a row of small rounded beads, drawn above
// everything so it reads as editor UI and never as road paint. This is the ONE
// place to change how those lines look (bead size, spacing, colour, opacity);
// every editor line is built from `editorLineGeometry` + `createEditorLineMaterial`.
export const EDITOR_LINE_COLOR = 0xfacc15;
export const EDITOR_LINE_OPACITY = 0.95;

const BEAD_DIAMETER = 0.5;
const BEAD_SPACING = 0.95;
const BEAD_SEGMENTS = 10;

// Unit-circle offsets reused to stamp every bead.
const UNIT_CIRCLE = Array.from({ length: BEAD_SEGMENTS + 1 }, (_, k) => {
	const a = (k / BEAD_SEGMENTS) * Math.PI * 2;
	return { c: Math.cos(a), s: Math.sin(a) };
});

// A row of beads spaced evenly by arc length along the polyline (XZ plane at
// height y). The polyline can be straight (a stem) or a sampled curve (an arc).
export function editorLineGeometry(
	points: { x: number; y: number }[],
	y: number
): THREE.BufferGeometry {
	const positions: number[] = [];
	const r = BEAD_DIAMETER / 2;
	let acc = 0;
	let next = BEAD_SPACING / 2;
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (len < 1e-6) continue;
		while (next <= acc + len) {
			const t = (next - acc) / len;
			const cx = a.x + dx * t;
			const cz = a.y + dy * t;
			for (let k = 0; k < BEAD_SEGMENTS; k++) {
				const u0 = UNIT_CIRCLE[k];
				const u1 = UNIT_CIRCLE[k + 1];
				positions.push(cx, y, cz, cx + u0.c * r, y, cz + u0.s * r, cx + u1.c * r, y, cz + u1.s * r);
			}
			next += BEAD_SPACING;
		}
		acc += len;
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	return geometry;
}

export function createEditorLineMaterial(
	color: number = EDITOR_LINE_COLOR,
	opacity: number = EDITOR_LINE_OPACITY
): THREE.MeshBasicMaterial {
	return new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity,
		side: THREE.DoubleSide,
		depthTest: false,
		depthWrite: false
	});
}
