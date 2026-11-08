// Saved lab states: the scenes Winston flagged, each a place framed on the
// spot that was broken. Open one at /lab?scene=<id>.

export const SCENES = [
	{ id: 'us1-west', place: 'us1', title: 'US 1 west', view: { x: -35, y: 0, zoom: 10 } },
	{
		id: 'us1-driveway',
		place: 'us1',
		title: 'Driveway on SW 152nd',
		view: { x: 111, y: -4, zoom: 12 }
	},
	{ id: 'sw136-taper', place: 'sw136', title: 'SW 136th taper', view: { x: 60, y: 0, zoom: 9 } },
	{
		id: 'split-node',
		place: 'split',
		title: 'Node mid-road with a median',
		view: { x: 2, y: 0, zoom: 14 }
	},
	{ id: 'close', place: 'close', title: 'Two close junctions', view: { x: 0, y: 0, zoom: 10 } },
	{
		id: 'sw136-fourway',
		place: 'sw136',
		title: 'Four-way with medians',
		view: { x: -8, y: 0, zoom: 10 }
	}
];
