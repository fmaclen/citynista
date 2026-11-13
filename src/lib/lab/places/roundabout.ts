// The roundabout reference: a two-lane ring of one-way roads around a
// planted island with a truck apron, four arms with medians, and a two-way
// trail crossing the south arm. Each entry is a junction of three road ends:
// the ring coming in, the ring going on, and the arm.

import type { Lane } from '../model';
import { arc, along, buffer, drive, junction, place, road, stretch, trail, walk } from './build';

const C = { x: 0, y: 0 };
const ISLAND = 10;
// Arm headings (screen degrees) and their half-gap on the ring, in degrees.
const ARMS = [
	{ id: 'e', deg: -12, gap: 34, lanes: 2, median: 4 },
	{ id: 'n', deg: -95, gap: 26, lanes: 1, median: 3.5 },
	{ id: 'w', deg: 172, gap: 34, lanes: 2, median: 4 },
	{ id: 's', deg: 93, gap: 26, lanes: 1, median: 3.5 }
];

// Ring roads run anticlockwise on screen (decreasing angle). Their line is
// the apron's outer edge, so lanes sit outward of it: two lanes, verge,
// sidewalk. The island and its apron are placed shapes.
const APRON = 3;
const ringLanes: Lane[] = [
	drive('in', 'fwd', 3.8),
	drive('out', 'fwd', 3.8),
	buffer('verge', 2.5),
	walk('walk', 2)
];

function armLanes(n: number, median: number): Lane[] {
	const inbound = Array.from({ length: n }, (_, i) => drive(`in${i}`, 'back', 3.5));
	const outbound = Array.from({ length: n }, (_, i) => drive(`out${i}`, 'fwd', 3.5));
	return [
		walk('wl', 2),
		buffer('vl', 1.5),
		...inbound,
		buffer('med', median),
		...outbound,
		buffer('vr', 1.5),
		walk('wr', 2)
	];
}

const ARM_START = 25;

export const roundabout = () => {
	const roads = [];
	const junctions = [];
	for (let i = 0; i < ARMS.length; i++) {
		const a = ARMS[i];
		const b = ARMS[(i + 1) % ARMS.length];
		// From just past arm a to just before arm b, going anticlockwise.
		let to = b.deg + b.gap;
		const from = a.deg - a.gap;
		while (to > from) to -= 360;
		roads.push(
			road(`ring-${a.id}${b.id}`, arc(C, ISLAND + APRON, from, to), [
				stretch(0, ringLanes, { align: 'left' })
			])
		);
	}
	// Each arm's median runs right up to its ring junction (nose at 0), where
	// the splitter island carries it on.
	for (const a of ARMS) {
		const start = along(C, a.deg, ARM_START);
		const lanes = armLanes(a.lanes, a.median);
		if (a.id === 's') {
			// The south arm is cut by the trail crossing 22 m out.
			// The trail is 3.5 m wide; the arm stops clear either side of it.
			const mid = along(C, a.deg, ARM_START + 21.5);
			const mid2 = along(C, a.deg, ARM_START + 27.5);
			roads.push({ ...road('arm-s', [start, mid], lanes), noses: { start: 0 } });
			roads.push(road('arm-s2', [mid2, along(C, a.deg, 110)], lanes));
		} else
			roads.push({
				...road(`arm-${a.id}`, [start, along(C, a.deg, 110)], lanes),
				noses: { start: 0 }
			});
	}
	// The trail: in from the south-west, across the south arm, off east.
	roads.push(
		road(
			'trail-w',
			[
				{ x: -95, y: 52 },
				{ x: -11.4, y: 48.5, c1: { x: -60, y: 44 }, c2: { x: -30, y: 48.5 } }
			],
			[trail('t')]
		)
	);
	roads.push(
		road(
			'trail-e',
			[
				{ x: 6.4, y: 49.4 },
				{ x: 95, y: 42, c1: { x: 35, y: 50 }, c2: { x: 60, y: 42 } }
			],
			[trail('t')]
		)
	);
	const ring = (x: string, y: string) => `ring-${x}${y}`;
	for (let i = 0; i < ARMS.length; i++) {
		const prev = ARMS[(i + ARMS.length - 1) % ARMS.length];
		const a = ARMS[i];
		const next = ARMS[(i + 1) % ARMS.length];
		const into = `${ring(prev.id, a.id)}:end`;
		const on = `${ring(a.id, next.id)}:start`;
		junctions.push(
			junction(`entry-${a.id}`, [into, on, `arm-${a.id}:start`], {
				islands: [{ ...splitter(a.median), anchor: `arm-${a.id}:start` }],
				// Arrows in the ring before each exit.
				arrows: [into],
				// The ring goes on and every entry yields to it.
				control: { [into]: 'none', [`arm-${a.id}:start`]: 'yield' },
				// Where the arm has two lanes each way the defaults send the
				// ring's outer lane only out into it: it carries on round the
				// ring as well.
				add: a.lanes === 2 ? [`${into}/out>${on}/out`] : []
			})
		);
	}
	junctions.push(
		junction('trail-crossing', ['arm-s:end', 'arm-s2:start', 'trail-w:end', 'trail-e:start'], {
			// The trail's own zebra is the crossing here; none either side of it.
			walk: { 'x:arm-s:end': false, 'x:arm-s2:start': false }
		})
	);
	return place({
		id: 'roundabout',
		title: 'Roundabout',
		photo: '/lab/roundabout.png',
		note: 'Reference is an illustration, not a photo. Lane counts per arm are read off it: east and west two each way, north and south one.',
		view: { x: 0, y: 10, zoom: 5 },
		roads,
		junctions,
		islands: [
			// A hair inside the ring's edge, so the polygon never laps the lanes.
			{ shape: disc(ISLAND + APRON - 0.05), surface: 'concrete' },
			{ shape: disc(ISLAND), surface: 'grass' }
		]
	});
};

const disc = (r: number) =>
	Array.from({ length: 64 }, (_, i) => ({
		x: C.x + r * Math.cos((i / 64) * Math.PI * 2),
		y: C.y + r * Math.sin((i / 64) * Math.PI * 2)
	}));

// A splitter island in front of an arm's median, in the arm end's frame
// (x out along the arm, so negative is into the junction): it starts as the
// arm's median ends, as wide, and narrows to a point toward the ring.
function splitter(median: number) {
	const h = median / 2;
	const shape = [
		{ x: 0, y: -h },
		{ x: 0, y: h },
		{ x: -3, y: h * 0.8 },
		{ x: -6, y: 0.5 },
		{ x: -6.6, y: 0 },
		{ x: -6, y: -0.5 },
		{ x: -3, y: -h * 0.8 }
	];
	return { shape, surface: 'concrete' as const, anchor: '' };
}
