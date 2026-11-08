// SW 136th St: one block between a median opening (west) and a signalised
// crossing (east), measured off the photo at 9.4 px/m. The block is one road
// with four stretches: a westbound pocket opening off the median at the west
// end, the full median, the median narrowing as an eastbound turn lane opens,
// and the hatched buffer between that turn lane and the through lanes.

import { buffer, drive, junction, p, place, road, stretch, walk } from './build';

const WALK = 2;

export const sw136 = () =>
	place({
		id: 'sw136',
		title: 'SW 136th pocket block',
		photo: '/lab/sw136.png',
		note: 'Photo 1610 px wide = 171 m. The block road runs from the west median opening to the east stop bar.',
		view: { x: 60, y: 0, zoom: 4.6 },
		roads: [
			road(
				'136',
				[p(0, 0), p(111.7, 0)],
				[
					// West end: the westbound left pocket, 3.2 m, cut into the median.
					stretch(0, [
						walk('wn', WALK),
						drive('wb1', 'back'),
						drive('wb2', 'back'),
						drive('wbp', 'back', 3.2),
						buffer('med', 9.9),
						drive('eb1', 'fwd'),
						drive('eb2', 'fwd'),
						walk('ws', WALK)
					]),
					// The pocket closes into a 1.6 m shoulder beside the full median.
					stretch(
						42.6,
						[
							walk('wn', WALK),
							drive('wb1', 'back'),
							drive('wb2', 'back'),
							buffer('wbs', 1.6, 'asphalt'),
							buffer('med', 11.5),
							drive('eb1', 'fwd'),
							drive('eb2', 'fwd'),
							walk('ws', WALK)
						],
						{ taper: 6 }
					),
					// The median narrows to a 3.4 m strip; the eastbound turn lane opens.
					stretch(
						45.2,
						[
							walk('wn', WALK),
							drive('wb1', 'back'),
							drive('wb2', 'back'),
							buffer('med', 3.4),
							drive('ebt', 'fwd', 9.7),
							drive('eb1', 'fwd'),
							drive('eb2', 'fwd'),
							walk('ws', WALK)
						],
						{ taper: 28.7 }
					),
					// The hatched buffer opens between the turn lane and the through lanes.
					stretch(
						73.9,
						[
							walk('wn', WALK),
							drive('wb1', 'back'),
							drive('wb2', 'back'),
							buffer('med', 3.4),
							drive('ebt', 'fwd', 3.8),
							buffer('hat', 5.9, 'hatch'),
							drive('eb1', 'fwd'),
							drive('eb2', 'fwd'),
							walk('ws', WALK)
						],
						{ taper: 8 }
					)
				]
			),
			// West of the median opening, with the eastbound pocket into it.
			road(
				'136w',
				[p(-60, 0), p(-13.8, 0)],
				[
					stretch(0, [
						walk('wn', WALK),
						drive('wb1', 'back'),
						drive('wb2', 'back'),
						buffer('med', 13.1),
						drive('eb1', 'fwd'),
						drive('eb2', 'fwd'),
						walk('ws', WALK)
					]),
					stretch(
						22,
						[
							walk('wn', WALK),
							drive('wb1', 'back'),
							drive('wb2', 'back'),
							buffer('med', 9.9),
							drive('ebp', 'fwd', 3.2),
							drive('eb1', 'fwd'),
							drive('eb2', 'fwd'),
							walk('ws', WALK)
						],
						{ taper: 6 }
					)
				]
			),
			// East of the crossing: two through lanes and two left lanes westbound.
			road(
				'136e',
				[p(136.7, -1.9), p(180, -1.9)],
				[
					walk('wn', WALK),
					drive('wb1', 'back', 3.45),
					drive('wb2', 'back', 3.45),
					drive('wl1', 'back', 3.45),
					drive('wl2', 'back', 3.45),
					buffer('med', 5.6),
					drive('eb1', 'fwd'),
					drive('eb2', 'fwd'),
					walk('ws', WALK)
				]
			),
			// The cross street at the east end, north and south arms.
			road(
				'nx',
				[p(126.8, -17.4), p(126.8, -45)],
				[
					walk('ww', WALK),
					drive('sbl', 'back', 3.6),
					drive('sbt', 'back', 3.6),
					buffer('med', 3),
					drive('nb', 'fwd', 4.5),
					walk('we', WALK)
				]
			),
			road(
				'sx',
				[p(126.1, 15), p(126.1, 45)],
				[
					walk('we', WALK),
					drive('nbr', 'back', 3.3),
					drive('nbl', 'back', 3.3),
					buffer('med', 1.5, 'concrete'),
					drive('sb', 'fwd', 4.2),
					walk('ww', WALK)
				]
			),
			// Side streets at the west median opening.
			road(
				'nw',
				[p(-9.6, -15.5), p(-9.6, -40)],
				[walk('ww', WALK), drive('sb', 'back'), drive('nb', 'fwd'), walk('we', WALK)]
			),
			road(
				'sw',
				[p(-4.8, 15.5), p(-4.8, 40)],
				[walk('we', WALK), drive('nb', 'back'), drive('sb', 'fwd'), walk('ww', WALK)]
			)
		],
		junctions: [
			// The median opening has no marked crossings in the photo.
			junction('west', ['136w:end', '136:start', 'nw:start', 'sw:start'], {
				walk: {
					'x:136w:end': false,
					'x:136:start': false,
					'x:nw:start': false,
					'x:sw:start': false
				}
			}),
			junction('east', ['136:end', '136e:start', 'nx:start', 'sx:start'], {
				// Both westbound left lanes turn left, as the photo's arrows show.
				turns: { '136e:start/wl1': ['sx:start/sb'], '136e:start/wl2': ['sx:start/sb'] },
				control: {
					'136:end': 'signal',
					'136e:start': 'signal',
					'nx:start': 'signal',
					'sx:start': 'signal'
				}
			})
		]
	});
