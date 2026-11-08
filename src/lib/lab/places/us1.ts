// US 1 (S Dixie Hwy) x SW 152nd St, measured off the photo at 6.3 px/m with
// the origin at photo pixel (1000, 420). US 1 runs 21.8 degrees east of
// north. Lane counts were read at 4-5x zoom:
// - US 1 south of 152nd (northbound approach): L, L, T, T, T/R; southbound
//   departure 3 lanes; raised median between.
// - US 1 north (southbound approach): R, T, T, T, hatched buffer, L;
//   northbound departure 3 lanes.
// - SW 152nd west (eastbound approach): L, L, T, R (the R runs south of the
//   triangle island); westbound departure 2 lanes; yellow hatched median.
// - SW 152nd east (westbound approach): T/R, T, L, L; eastbound departure 2.
// - The busway (one lane each way) and the trail cross 152nd just west of
//   US 1, inside the same junction. SW 82nd Ave joins from the north 15 m
//   west of it, as its own junction.

import type { Lane } from '../model';
import { along, buffer, bus, drive, junction, p, place, road, stretch, trail, walk } from './build';

const N = -68.2;
const S = 111.8;

const w152 = (): Lane[] => [
	walk('wn'),
	drive('wbo', 'back', 3.5),
	drive('wbi', 'back', 3.5),
	buffer('med', 4.4, 'hatch'),
	drive('ebL1', 'fwd', 3.6),
	drive('ebL2', 'fwd', 3.6),
	drive('ebT', 'fwd', 3.6),
	drive('ebR', 'fwd', 3.6),
	walk('ws')
];

const e152 = (): Lane[] => [
	walk('wn'),
	drive('wbR', 'back', 3.5),
	drive('wbT', 'back', 3.5),
	drive('wbL1', 'back', 3.5),
	drive('wbL2', 'back', 3.5),
	drive('eb1', 'fwd', 3.6),
	drive('eb2', 'fwd', 3.6),
	walk('ws')
];

const e152far = (): Lane[] => [
	walk('wn'),
	drive('wbR', 'back', 3.5),
	drive('wbT', 'back', 3.5),
	buffer('med', 7, 'hatch'),
	drive('eb1', 'fwd', 3.6),
	drive('eb2', 'fwd', 3.6),
	walk('ws')
];

const driveway = (): Lane[] => [drive('out', 'back', 3.5), drive('in', 'fwd', 3.5)];

const us1n = (): Lane[] => [
	walk('ww'),
	buffer('vw', 3),
	drive('sbR', 'back', 3.5),
	drive('sbT1', 'back', 3.5),
	drive('sbT2', 'back', 3.5),
	drive('sbT3', 'back', 3.5),
	buffer('sbH', 3.7, 'hatch'),
	drive('sbL', 'back', 3.5),
	buffer('med', 3, 'concrete'),
	drive('nb1', 'fwd', 3.5),
	drive('nb2', 'fwd', 3.5),
	drive('nb3', 'fwd', 3.5),
	walk('we')
];

const us1nFar = (): Lane[] => [
	walk('ww'),
	buffer('vw', 3),
	drive('sbR', 'back', 3.5),
	drive('sbT1', 'back', 3.5),
	drive('sbT2', 'back', 3.5),
	drive('sbT3', 'back', 3.5),
	buffer('med', 10.2, 'concrete'),
	drive('nb1', 'fwd', 3.5),
	drive('nb2', 'fwd', 3.5),
	drive('nb3', 'fwd', 3.5),
	walk('we')
];

const us1s = (): Lane[] => [
	walk('we'),
	drive('nbTR', 'back', 3.7),
	drive('nbT2', 'back', 3.7),
	drive('nbT1', 'back', 3.7),
	drive('nbL1', 'back', 3.7),
	drive('nbL2', 'back', 3.7),
	buffer('med', 3, 'concrete'),
	drive('sb1', 'fwd', 3.6),
	drive('sb2', 'fwd', 3.6),
	drive('sb3', 'fwd', 3.6),
	buffer('vw', 3),
	walk('ww')
];

const Y = -2.2;

// Concrete platforms 2.5 m wide along both sides of a busway, 4 to 24 m out
// from the junction (in the busway end's frame), clear of its corners.
const platforms = (anchor: string) =>
	[-1, 1].map((side) => ({
		anchor,
		surface: 'concrete' as const,
		shape: [
			{ x: 4, y: side * 3.7 },
			{ x: 24, y: side * 3.7 },
			{ x: 24, y: side * 6.2 },
			{ x: 4, y: side * 6.2 }
		]
	}));
const signal = 'signal' as const;

export const us1 = () =>
	place({
		id: 'us1',
		title: 'US 1 x SW 152nd St',
		photo: '/lab/us1.png',
		note: 'Photo 2000 px wide = 317 m. Origin at photo pixel (1000, 420).',
		view: { x: 5, y: -2, zoom: 3.4 },
		roads: [
			road('152wa', [p(-159, Y), p(-113.2, Y)], w152()),
			road('d3', [p(-108.7, 10.6), p(-108.7, 40)], driveway()),
			// The eastbound side runs on to its stop bar at the trail crossing; the
			// westbound side (and the median) stops at SW 82nd Ave, 23.8 m back.
			{
				...road('152wb', [p(-104.2, Y), p(-40.5, Y)], w152()),
				cuts: { end: { wn: 23.8, wbo: 23.8, wbi: 23.8, med: 23.8 } }
			},
			// SW 82nd Ave meets the north side of 152nd inside the US 1 junction:
			// its mouth sits back at the photo's crosswalk, with the pointed
			// island in front of it.
			road(
				'82',
				[p(-50, -27), p(-50, -75)],
				[walk('ww'), drive('sb', 'back', 3.6), drive('nb', 'fwd', 3.6), walk('we')]
			),
			road(
				'us1n',
				[p(38.9, -28.6), along({ x: 38.9, y: -28.6 }, N, 95)],
				[stretch(0, us1n()), stretch(55, us1nFar(), { taper: 18 })]
			),
			// US 1 south: the northbound stop bar is the end; the southbound side
			// starts 14 m further on, where the eastbound slip lane joins it.
			{
				...road('us1s', [p(16.0, 17.8), along({ x: 16.0, y: 17.8 }, S, 85)], us1s()),
				cuts: { start: { sb1: 14, sb2: 14, sb3: 14, vw: 14, ww: 14 } }
			},
			road(
				'busn',
				[p(-8.3, -19.0), along({ x: -8.3, y: -19.0 }, N, 70)],
				[bus('bs', 'back'), bus('bn', 'fwd')]
			),
			road(
				'buss',
				[p(-24.6, 19.5), along({ x: -24.6, y: 19.5 }, S, 63)],
				[bus('bn', 'back'), bus('bs', 'fwd')]
			),
			road('trailn', [p(-25.5, -17.4), along({ x: -25.5, y: -17.4 }, N, 70)], [trail('t')]),
			road('trails', [p(-37.3, 21.5), along({ x: -37.3, y: 21.5 }, S, 63)], [trail('t')]),
			road('152e', [p(57.1, Y), p(81.2, Y)], e152()),
			road('d1', [p(86, 8.4), p(86, 40)], driveway()),
			road(
				'152e2',
				[p(90, Y), p(107, Y)],
				[stretch(0, e152()), stretch(10, e152far(), { taper: 7 })]
			),
			road('d2', [p(111, -12.8), p(111, -40)], driveway()),
			road('152e3', [p(115, Y), p(158, Y)], e152far())
		],
		junctions: [
			junction('d3', ['152wa:end', '152wb:start', 'd3:start']),
			junction(
				'us1',
				[
					'152wb:end',
					'82:start',
					'152e:start',
					'us1n:start',
					'us1s:start',
					'busn:start',
					'buss:start',
					'trailn:start',
					'trails:start'
				],
				{
					turns: {
						'152wb:end/ebL1': ['us1n:start/nb1'],
						'152wb:end/ebL2': ['us1n:start/nb2'],
						'152wb:end/ebT': ['152e:start/eb1', '152e:start/eb2'],
						'152wb:end/ebR': ['us1s:start/sb3'],
						'152e:start/wbR': ['us1n:start/nb3', '152wb:end/wbo'],
						'152e:start/wbT': ['152wb:end/wbi'],
						'152e:start/wbL1': ['us1s:start/sb2'],
						'152e:start/wbL2': ['us1s:start/sb1'],
						'us1n:start/sbR': ['152wb:end/wbo'],
						'us1n:start/sbT1': ['us1s:start/sb3'],
						'us1n:start/sbT2': ['us1s:start/sb2'],
						'us1n:start/sbT3': ['us1s:start/sb1'],
						'us1n:start/sbL': ['152e:start/eb1'],
						'us1s:start/nbL2': ['152wb:end/wbi'],
						'us1s:start/nbL1': ['152wb:end/wbo'],
						'us1s:start/nbT1': ['us1n:start/nb1'],
						'us1s:start/nbT2': ['us1n:start/nb2'],
						'us1s:start/nbTR': ['us1n:start/nb3', '152e:start/eb2']
					},
					// Across the busway mouths: ladder crossings, not sidewalk paving.
					paved: { '82:start~us1n:start': false, 'us1s:start~152wb:end': false },
					// The bus station: grass up to the curb round the busways, no
					// sidewalk framing it, only the ladders across the mouths.
					bare: ['82:start~us1n:start', 'us1s:start~152wb:end'],
					// The north curb runs on along 152nd's line from SW 82nd Ave to the
					// busway; south of the triangle the slip lane's outer curb swings
					// out between the busway and US 1.
					corners: {
						'82:start>busn:start': [
							{ x: -46.4, y: -15.1 },
							{ x: -11.6, y: -15.1 }
						],
						'busn:start>us1n:start': [],
						'us1s:start>buss:start': [
							{ x: -6.5, y: 23.6 },
							{ x: -16, y: 18.0 }
						]
					},
					islands: [
						// Bus platforms either side of the busway at both stops.
						...platforms('busn:start'),
						...platforms('buss:start'),
						// The triangle between the eastbound slip lane and the through
						// lanes, where the photo has it: (937, 464), (1017, 464),
						// (975, 520).
						{
							shape: [
								{ x: -10.0, y: 6.9 },
								{ x: 2.7, y: 6.9 },
								{ x: -4.0, y: 15.9 }
							],
							surface: 'concrete'
						},
						// SW 82nd Ave's pointed island, in the mouth of the avenue.
						{
							anchor: '82:start',
							shape: [
								{ x: -0.6, y: 0 },
								{ x: -8.5, y: -1.4 },
								{ x: -8.5, y: 1.4 }
							],
							surface: 'concrete'
						}
					],
					control: {
						'152wb:end': signal,
						'152e:start': signal,
						'us1n:start': signal,
						'us1s:start': signal,
						'busn:start': signal,
						'buss:start': signal
					}
				}
			),
			junction('d1', ['152e:end', '152e2:start', 'd1:start']),
			junction('d2', ['152e2:end', '152e3:start', 'd2:start'])
		]
	});
