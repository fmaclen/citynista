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
