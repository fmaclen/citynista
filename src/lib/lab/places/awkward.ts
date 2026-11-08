// Deliberately awkward layouts, written with the same pieces as the real
// places.

import type { Lane } from '../model';
import { along, buffer, drive, junction, p, place, road, walk } from './build';

const street = (): Lane[] => [walk('wl'), drive('b', 'back'), drive('f', 'fwd'), walk('wr')];
const avenue = (): Lane[] => [
	walk('wl'),
	drive('b2', 'back'),
	drive('b1', 'back'),
	buffer('med', 3),
	drive('f1', 'fwd'),
	drive('f2', 'fwd'),
	walk('wr')
];
const driveway = (): Lane[] => [drive('out', 'back', 3.2), drive('in', 'fwd', 3.2)];
const signals = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 'signal' as const]));

export const offcentre = () =>
	place({
		id: 'offcentre',
		title: 'Off-centre road joining a four-way',
		photo: '/lab/offcentre.png',
		note: 'The south road joins under the right half of the junction, as in the screenshot.',
		view: { x: 0, y: 8, zoom: 7 },
		roads: [
			road('w', [p(-70, 0), p(-13, 0)], avenue()),
			road('e', [p(13, 0), p(70, 0)], avenue()),
			road('n', [p(0, -13), p(0, -70)], avenue()),
			road('s', [p(6, 13), p(6, 70)], street())
		],
		junctions: [junction('x', ['w:end', 'e:start', 'n:start', 's:start'])]
	});

// The avenue's half-widths: walk 2, two lanes 6.6, half the 3 m median.
const CARRIAGEWAY = 2 + 6.6;
const HALF_MEDIAN = 1.5;

export const split = () =>
	place({
		id: 'split',
		title: 'Avenue splitting into two one-way roads',
		note: 'Each one-way road continues its own carriageway in a straight line; the median carries on as the gap.',
		view: { x: 10, y: 0, zoom: 7 },
		roads: [
			road('ave', [p(-70, 0), p(0, 0)], avenue()),
			road(
				'wb',
				[p(3, -(HALF_MEDIAN + CARRIAGEWAY) / 2), p(80, -(HALF_MEDIAN + CARRIAGEWAY) / 2)],
				[walk('wl'), drive('b2', 'back'), drive('b1', 'back'), buffer('mid', HALF_MEDIAN)]
			),
			road(
				'eb',
				[p(3, (HALF_MEDIAN + CARRIAGEWAY) / 2), p(80, (HALF_MEDIAN + CARRIAGEWAY) / 2)],
				[buffer('mid', HALF_MEDIAN), drive('f1', 'fwd'), drive('f2', 'fwd'), walk('wr')]
			)
		],
		junctions: [junction('split', ['ave:end', 'wb:start', 'eb:start'])]
	});

export const skewed = () =>
	place({
		id: 'skewed',
		title: 'Skewed four-way',
		note: 'A street crossing another at 55 degrees.',
		view: { x: 0, y: 0, zoom: 7 },
		roads: [
			road('w', [p(-70, 0), p(-12, 0)], street()),
			road('e', [p(12, 0), p(70, 0)], street()),
			road('ne', [along({ x: 0, y: 0 }, -55, 14), along({ x: 0, y: 0 }, -55, 75)], street()),
			road('sw', [along({ x: 0, y: 0 }, 125, 14), along({ x: 0, y: 0 }, 125, 75)], street())
		],
		junctions: [junction('x', ['w:end', 'e:start', 'ne:start', 'sw:start'])]
	});

export const close = () =>
	place({
		id: 'close',
		title: 'Two junctions 10 m apart',
		note: 'Side streets 10 m apart, centre to centre, on opposite sides of an avenue. The avenue between the two junctions is 2 m long.',
		view: { x: 0, y: 0, zoom: 7 },
		roads: [
			road('a', [p(-70, 0), p(-12, 0)], avenue()),
			road('b', [p(-1, 0), p(1, 0)], avenue()),
			road('c', [p(12, 0), p(70, 0)], avenue()),
			road('n', [p(-5, -10.3), p(-5, -60)], street()),
			road('s', [p(5, 10.3), p(5, 60)], street())
		],
		junctions: [
			junction('j1', ['a:end', 'b:start', 'n:start'], {
				control: signals(['a:end', 'b:start', 'n:start'])
			}),
			junction('j2', ['b:end', 'c:start', 's:start'], {
				control: signals(['b:end', 'c:start', 's:start'])
			})
		]
	});

export const driveway15 = () =>
	place({
		id: 'driveway',
		title: 'Driveway 15 m from a junction',
		note: 'The driveway is centred 15 m past the junction edge; it starts at the street curb.',
		view: { x: 10, y: 0, zoom: 7 },
		roads: [
			road('w', [p(-70, 0), p(-9, 0)], street()),
			road('e', [p(9, 0), p(20.5, 0)], street()),
			road('e2', [p(27.5, 0), p(80, 0)], street()),
			road('n', [p(0, -9), p(0, -70)], street()),
			road('s', [p(0, 9), p(0, 70)], street()),
			road('d', [p(24, 3.3), p(24, 40)], driveway())
		],
		junctions: [
			junction('x', ['w:end', 'e:start', 'n:start', 's:start']),
			junction('dw', ['e:end', 'e2:start', 'd:start'])
		]
	});

export const sixway = () => {
	const roads = [0, 60, 120, 180, 240, 300].map((deg) =>
		road(`r${deg}`, [along({ x: 0, y: 0 }, deg, 16), along({ x: 0, y: 0 }, deg, 75)], street())
	);
	return place({
		id: 'sixway',
		title: 'Six-way',
		note: 'Three streets crossing at one point, 60 degrees apart.',
		view: { x: 0, y: 0, zoom: 6 },
		roads,
		junctions: [
			junction(
				'x',
				roads.map((r) => `${r.id}:start`)
			)
		]
	});
};
