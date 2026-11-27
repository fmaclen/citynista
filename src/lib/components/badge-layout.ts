type Pt = { x: number; y: number };

// A button to place on screen: the point it belongs on (`at`: its crossing's
// middle) and its size, all in screen pixels.
export interface BadgeToPlace {
	at: Pt;
	width: number;
	height: number;
}

// A button already standing, which those placed keep clear of: its middle
// and size.
export interface StandingBadge {
	x: number;
	y: number;
	width: number;
	height: number;
}

// The part of the screen the buttons are shown in (px): its left, top,
// right and bottom edges.
export interface View {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

// The clear space kept between two buttons (px), the step a button is moved
// by while looking for a clear place, and how far it is looked for.
const GAP = 4;
const STEP = 2;
const SEARCH = 600;

// Where crossing buttons stand on screen so that no two overlap, at any
// zoom. The buttons keep one size on screen while the crossings they belong
// to grow and shrink with the zoom, so whether two overlap is a matter of
// pixels and is decided here, each frame, never in metres. Each button, in
// the order given, stands on its crossing's middle where it lies GAP clear
// of every button standing (`standing`, the junction approaches' badges)
// and every one placed before it. Otherwise it moves to the nearest clear
// point in eight directions round its middle, upwards first, looked for
// STEP further out at a time up to SEARCH. A button that would show in the
// view (`view`) at its crossing's middle, wholly or in part, stands wholly
// within it: on the point of the view nearest its middle, or moved from
// there to the nearest clear point within the view, or, with none, on that
// point. One that would not show stays off it. A button moved off its middle
// is drawn tied to it (ControlBadges.svelte).
export function placeBadges(badges: BadgeToPlace[], standing: StandingBadge[] = [], view?: View) {
	const placed: StandingBadge[] = [...standing];
	const clear = (p: Pt, b: BadgeToPlace) =>
		placed.every(
			(q) =>
				Math.abs(p.x - q.x) * 2 >= b.width + q.width + 2 * GAP ||
				Math.abs(p.y - q.y) * 2 >= b.height + q.height + 2 * GAP
		);
	const kept = (b: BadgeToPlace) =>
		!!view &&
		b.at.x + b.width / 2 >= view.x0 &&
		b.at.x - b.width / 2 <= view.x1 &&
		b.at.y + b.height / 2 >= view.y0 &&
		b.at.y - b.height / 2 <= view.y1;
	const within = (p: Pt, b: BadgeToPlace) =>
		!view ||
		(p.x - b.width / 2 >= view.x0 &&
			p.x + b.width / 2 <= view.x1 &&
			p.y - b.height / 2 >= view.y0 &&
			p.y + b.height / 2 <= view.y1);
	return badges.map((given) => {
		const b = kept(given) ? { ...given, at: into(view!, given) } : given;
		const free = (q: Pt) => clear(q, b) && (!kept(given) || within(q, b));
		const p = free(b.at) ? b.at : (clearOf(b, free) ?? b.at);
		placed.push({ ...p, width: b.width, height: b.height });
		return p;
	});
}

// The point of a view nearest a button's middle where the button lies wholly
// within it (the view's middle, across a view narrower than the button).
function into(view: View, b: BadgeToPlace) {
	const fit = (v: number, lo: number, hi: number, size: number) =>
		hi - lo < size ? (lo + hi) / 2 : Math.min(Math.max(v, lo + size / 2), hi - size / 2);
	return {
		x: fit(b.at.x, view.x0, view.x1, b.width),
		y: fit(b.at.y, view.y0, view.y1, b.height)
	};
}

const ROUND = [
	[0, -1],
	[1, -1],
	[-1, -1],
	[1, 0],
	[-1, 0],
	[1, 1],
	[-1, 1],
	[0, 1]
].map(([x, y]) => ({ x: x / Math.hypot(x, y), y: y / Math.hypot(x, y) }));

// The nearest clear point to a button's middle, as placeBadges looks for it.
function clearOf(b: BadgeToPlace, clear: (p: Pt) => boolean) {
	for (let d = STEP; d <= SEARCH; d += STEP) {
		const found = ROUND.map((u) => ({ x: b.at.x + u.x * d, y: b.at.y + u.y * d })).find(clear);
		if (found) return found;
	}
	return null;
}
