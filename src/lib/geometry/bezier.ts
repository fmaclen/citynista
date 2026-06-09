export function getQuadraticBezierPoint(
	x0: number,
	y0: number,
	cx: number,
	cy: number,
	x1: number,
	y1: number,
	t: number
): { x: number; y: number } {
	const mt = 1 - t;
	return {
		x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
		y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1
	};
}

export function getQuadraticBezierTangent(
	x0: number,
	y0: number,
	cx: number,
	cy: number,
	x1: number,
	y1: number,
	t: number
): { x: number; y: number } {
	const mt = 1 - t;
	return {
		x: 2 * mt * (cx - x0) + 2 * t * (x1 - cx),
		y: 2 * mt * (cy - y0) + 2 * t * (y1 - cy)
	};
}

export function getDefaultControlPoint(
	x0: number,
	y0: number,
	x1: number,
	y1: number
): { x: number; y: number } {
	return {
		x: (x0 + x1) / 2,
		y: (y0 + y1) / 2
	};
}

export function closestPointOnQuadraticBezier(
	px: number,
	py: number,
	x0: number,
	y0: number,
	cx: number,
	cy: number,
	x1: number,
	y1: number,
	samples: number = 100
): { x: number; y: number; t: number; distance: number } {
	let best = { x: x0, y: y0, t: 0, distance: Infinity };

	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const point = getQuadraticBezierPoint(x0, y0, cx, cy, x1, y1, t);
		const distance = Math.hypot(px - point.x, py - point.y);
		if (distance < best.distance) {
			best = { x: point.x, y: point.y, t, distance };
		}
	}

	return best;
}

export function distanceToQuadraticBezier(
	px: number,
	py: number,
	x0: number,
	y0: number,
	cx: number,
	cy: number,
	x1: number,
	y1: number,
	samples: number = 50
): number {
	let minDist = Infinity;

	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const point = getQuadraticBezierPoint(x0, y0, cx, cy, x1, y1, t);
		const dx = px - point.x;
		const dy = py - point.y;
		const dist = Math.sqrt(dx * dx + dy * dy);
		if (dist < minDist) {
			minDist = dist;
		}
	}

	return minDist;
}
