import { chromium, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData, JunctionData, Lane, LaneDirection, NodeData } from '../src/lib/core/types';

// A fixed set of tricky road layouts, each shot wide and close up, gathered
// into one index.html to flip through after a change to the drawing.
//   PORT=5302 bun scripts/gallery.ts <out-dir>
// The dev server must be running on $PORT. Each scene's graph is also written
// to <out-dir>/scenes/<id>.json, so `scripts/snap.ts` can reshoot it.

const outDir = resolve(process.argv[2] ?? 'gallery');
const port = process.env.PORT ?? '5173';
const base = `http://localhost:${port}`;

// ---- Lanes ---------------------------------------------------------------

// Lanes number l0, l1, … in order, as a preset's do; a lane that already
// has an id (one added to a road cut from another, as the lane panel adds
// it) keeps it and doesn't take a number.
const withIds = (lanes: Lane[]) => {
	let n = 0;
	return lanes.map((l) => (l.id ? l : { ...l, id: `l${n++}` }));
};
const added = (lane: Lane): Lane => ({ ...lane, id: 'added' });
const preset = (id: string) => withIds(createLanesFrom(id));
const car = (direction: LaneDirection, width = 3.5): Lane => ({
	role: 'vehicle',
	material: 'asphalt',
	width,
	direction
});
const verge = (width: number, material: Lane['material'] = 'grass'): Lane => ({
	role: 'buffer',
	material,
	width,
	direction: 'bidirectional'
});
const walk = (width: number): Lane => ({
	role: 'pedestrian',
	material: 'pavement',
	width,
	direction: 'bidirectional'
});
// An avenue whose median is `median` (default the preset's 2 m concrete),
// with `back`/`fwd` car lanes each side; `turn` puts one extra car lane
// against the median for that direction.
function avenue(o: { median?: Lane; back?: number; fwd?: number; turn?: 'back' | 'fwd' } = {}) {
	const median = o.median ?? verge(2, 'concrete');
	const back = Array.from({ length: o.back ?? 2 }, () => car('backward'));
	const fwd = Array.from({ length: o.fwd ?? 2 }, () => car('forward'));
	if (o.turn === 'back') back.push(added(car('backward')));
	if (o.turn === 'fwd') fwd.unshift(added(car('forward')));
	return withIds([walk(3), verge(1), ...back, median, ...fwd, verge(1), walk(3)]);
}
const oneWay = (direction: LaneDirection, n = 1) =>
	withIds(Array.from({ length: n }, () => car(direction)));

// ---- Graphs --------------------------------------------------------------

type Pt = [number, number];
interface Seg {
	id: string;
	from: string;
	to: string;
	lanes: Lane[];
	offset?: number;
	control?: Pt;
}
function graph(
	nodes: Record<string, Pt | [number, number, Partial<JunctionData>]>,
	segs: Seg[]
): GraphData {
	return {
		nodes: Object.entries(nodes).map(([id, [x, y, j]]): NodeData => {
			const node: NodeData = { id, x, y };
			if (j) node.junction = { connections: [], ...j };
			return node;
		}),
		segments: segs.map((s) => ({
			id: s.id,
			startNodeId: s.from,
			endNodeId: s.to,
			lanes: s.lanes,
			...(s.offset ? { offset: s.offset } : {}),
			...(s.control ? { controlX: s.control[0], controlY: s.control[1] } : {})
		}))
	};
}
// Two roads through node c: west-east (w → c → e) and a crossing one leaving
// c at `deg` degrees from east (+y is south) both ways, or only one way when
// `tee` is set.
function cross(
	ew: () => Lane[],
	ns: () => Lane[],
	o: { deg?: number; tee?: boolean; len?: number; ewOffset?: number } = {}
) {
	const len = o.len ?? 110;
	const a = ((o.deg ?? 90) * Math.PI) / 180;
	const dx = Math.round(Math.cos(a) * len * 100) / 100;
	const dy = Math.round(Math.sin(a) * len * 100) / 100;
	const nodes: Record<string, Pt> = { c: [0, 0], w: [-len, 0], e: [len, 0], s: [dx, dy] };
	const segs: Seg[] = [
		{ id: 'west', from: 'w', to: 'c', lanes: ew(), offset: o.ewOffset },
		{ id: 'east', from: 'c', to: 'e', lanes: ew(), offset: o.ewOffset },
		{ id: 'south', from: 'c', to: 's', lanes: ns() }
	];
	if (!o.tee) {
		nodes.n = [-dx, -dy];
		segs.push({ id: 'north', from: 'n', to: 'c', lanes: ns() });
	}
	return graph(nodes, segs);
}

// ---- Scenes --------------------------------------------------------------

interface Shot {
	label: string;
	at: [number, number, number]; // world x, world y, zoom (1 = 500 m tall)
}
interface SceneDef {
	id: string;
	title: string;
	note: string;
	graph: GraphData;
	shots: Shot[];
}
const wide = (x = 0, y = 0, zoom = 3): Shot => ({ label: 'wide', at: [x, y, zoom] });
const close = (label: string, x: number, y: number, zoom = 10): Shot => ({
	label,
	at: [x, y, zoom]
});

// The freeway is drawn southward, so its forward (southbound) lanes are on
// its right, the west side; ramps join and leave on that side.
const freeway = () => preset('highway');
const freewayPlus = () => withIds([...freeway(), added(car('forward'))]);

const scenes: SceneDef[] = [
	{
		id: 'onramp',
		title: 'On-ramp into an acceleration lane',
		note: 'Freeway southward; the piece south of the merge gains a kerb lane and slides 1.75 m west so the median runs straight. A one-lane ramp joins from the north-west.',
		graph: graph(
			{ n: [0, -120], m: [0, 0, { sides: { ramp: 'left' } }], s: [0, 120], r: [-45, -110] },
			[
				{ id: 'north', from: 'n', to: 'm', lanes: freeway() },
				{ id: 'south', from: 'm', to: 's', lanes: freewayPlus(), offset: 1.75 },
				{ id: 'ramp', from: 'r', to: 'm', lanes: oneWay('forward') }
			]
		),
		shots: [wide(), close('merge', -10, 0), close('ramp nose', -14, -20)]
	},
	{
		id: 'offramp',
		title: 'Off-ramp from a deceleration lane',
		note: 'Freeway southward; the piece north of the diverge carries an extra kerb lane, slid 1.75 m west. A one-lane ramp leaves to the south-west.',
		graph: graph(
			{ n: [0, -120], m: [0, 0, { sides: { ramp: 'right' } }], s: [0, 120], r: [-45, 110] },
			[
				{ id: 'north', from: 'n', to: 'm', lanes: freewayPlus(), offset: 1.75 },
				{ id: 'south', from: 'm', to: 's', lanes: freeway() },
				{ id: 'ramp', from: 'm', to: 'r', lanes: oneWay('forward') }
			]
		),
		shots: [wide(), close('diverge', -10, 0), close('ramp nose', -14, 20)]
	},
	{
		id: 'slip',
		title: 'Slip lane off a kerb lane, no added lane',
		note: 'Freeway eastward, same cross-section either side; a one-lane slip road peels off the south (kerb) side to the south-east.',
		graph: graph(
			{ w: [-120, 0], m: [0, 0, { sides: { slip: 'right' } }], e: [120, 0], r: [110, 45] },
			[
				{ id: 'west', from: 'w', to: 'm', lanes: freeway() },
				{ id: 'east', from: 'm', to: 'e', lanes: freeway() },
				{ id: 'slip', from: 'm', to: 'r', lanes: oneWay('forward') }
			]
		),
		shots: [wide(), close('peel', 0, 10), close('gore', 20, 14)]
	},
	{
		id: 'split',
		title: 'Avenue splitting into two one-way roads',
		note: 'Avenue eastward ends at m; its westbound half continues to the north-east, its eastbound half to the south-east.',
		graph: graph(
			{
				w: [-120, 0],
				m: [0, 0, { sides: { westbound: 'left', eastbound: 'right' } }],
				a: [120, -14],
				b: [120, 14]
			},
			[
				{ id: 'avenue', from: 'w', to: 'm', lanes: preset('avenue') },
				{ id: 'westbound', from: 'm', to: 'a', lanes: oneWay('backward', 2) },
				{ id: 'eastbound', from: 'm', to: 'b', lanes: oneWay('forward', 2) }
			]
		),
		shots: [wide(), close('split', 5, 0), close('fork', 30, 0)]
	},
	{
		id: 'left-pocket',
		title: 'Left-turn pocket in a grass median',
		note: 'Avenue eastward with a 5 m grass median; on the piece a → c the median narrows to 1.5 m beside a 3.5 m eastbound turn lane, into a crossing street at c.',
		graph: graph({ w: [-130, 0], a: [-60, 0], c: [0, 0], e: [110, 0], n: [0, -100], s: [0, 100] }, [
			{ id: 'west', from: 'w', to: 'a', lanes: avenue({ median: verge(5) }) },
			{ id: 'pocket', from: 'a', to: 'c', lanes: avenue({ median: verge(1.5), turn: 'fwd' }) },
			{ id: 'east', from: 'c', to: 'e', lanes: avenue({ median: verge(5) }) },
			{ id: 'north', from: 'n', to: 'c', lanes: preset('street') },
			{ id: 'south', from: 'c', to: 's', lanes: preset('street') }
		]),
		shots: [wide(-20), close('taper', -60, 0), close('junction', -8, 0)]
	},
	{
		id: 'street-pocket',
		title: 'Street pocket from an added lane and offset',
		note: 'Street eastward; the piece a → c gains a turn lane beside the centre line and slides 1.75 m south so its north kerb stays straight, into a crossing street at c.',
		graph: graph({ w: [-120, 0], a: [-50, 0], c: [0, 0], e: [110, 0], n: [0, -100], s: [0, 100] }, [
			{ id: 'west', from: 'w', to: 'a', lanes: preset('street') },
			{
				id: 'pocket',
				from: 'a',
				to: 'c',
				lanes: withIds([walk(2), car('backward'), added(car('forward')), car('forward'), walk(2)]),
				offset: 1.75
			},
			{ id: 'east', from: 'c', to: 'e', lanes: preset('street') },
			{ id: 'north', from: 'n', to: 'c', lanes: preset('street') },
			{ id: 'south', from: 'c', to: 's', lanes: preset('street') }
		]),
		shots: [wide(-20), close('taper', -50, 0), close('junction', -5, 0)]
	},
	{
		id: 'back-to-back',
		title: 'Two pockets back to back',
		note: 'A 100 m avenue piece with a 5 m grass median between two crossing streets, split at m: westbound pocket on c1 → m, eastbound pocket on m → c2, so the median jogs at m.',
		graph: graph(
			{
				w: [-150, 0],
				c1: [-50, 0],
				m: [0, 0],
				c2: [50, 0],
				e: [150, 0],
				n1: [-50, -90],
				s1: [-50, 90],
				n2: [50, -90],
				s2: [50, 90]
			},
			[
				{ id: 'west', from: 'w', to: 'c1', lanes: avenue({ median: verge(5) }) },
				{ id: 'pw', from: 'c1', to: 'm', lanes: avenue({ median: verge(1.5), turn: 'back' }) },
				{ id: 'pe', from: 'm', to: 'c2', lanes: avenue({ median: verge(1.5), turn: 'fwd' }) },
				{ id: 'east', from: 'c2', to: 'e', lanes: avenue({ median: verge(5) }) },
				{ id: 'n1', from: 'n1', to: 'c1', lanes: preset('street') },
				{ id: 's1', from: 'c1', to: 's1', lanes: preset('street') },
				{ id: 'n2', from: 'n2', to: 'c2', lanes: preset('street') },
				{ id: 's2', from: 'c2', to: 's2', lanes: preset('street') }
			]
		),
		shots: [wide(0, 0, 3.5), close('median swap', 0, 0), close('east junction', 40, 0, 8)]
	},
	{
		id: 'lane-drop',
		title: 'Lane drop',
		note: 'Avenue eastward; east of m the eastbound side loses its kerb lane and the piece slides 1.75 m north so the median runs straight.',
		graph: graph({ w: [-120, 0], m: [0, 0], e: [120, 0] }, [
			{ id: 'west', from: 'w', to: 'm', lanes: avenue() },
			{ id: 'east', from: 'm', to: 'e', lanes: avenue({ fwd: 1 }), offset: -1.75 }
		]),
		shots: [wide(), close('taper', 0, 4), close('taper end', 25, 4)]
	},
	{
		id: 'lane-add',
		title: 'Lane added on the kerb side',
		note: 'Avenue eastward; east of m the eastbound side gains a kerb lane, slid 1.75 m south, with a 40 m taper set on m.',
		graph: graph({ w: [-120, 0], m: [0, 0, { taper: 40 }], e: [120, 0] }, [
			{ id: 'west', from: 'w', to: 'm', lanes: avenue() },
			{ id: 'east', from: 'm', to: 'e', lanes: avenue({ fwd: 3 }), offset: 1.75 }
		]),
		shots: [wide(), close('taper start', -10, 4), close('taper end', 20, 4)]
	},
	{
		id: 't-avenue-street',
		title: 'T junction, avenue and street',
		note: 'Avenue west-east through c; a street leaves south.',
		graph: cross(
			() => preset('avenue'),
			() => preset('street'),
			{ tee: true }
		),
		shots: [wide(0, 0, 4), close('junction', 0, 6), close('corner', -10, 16, 10)]
	},
	{
		id: 'x-avenues',
		title: '4-way, two avenues',
		note: 'Two avenues crossing at right angles.',
		graph: cross(
			() => preset('avenue'),
			() => preset('avenue')
		),
		shots: [wide(0, 0, 4), close('junction', 0, 0, 8), close('corner', 14, 14)]
	},
	{
		id: 'x-avenue-street',
		title: '4-way, avenue and street',
		note: 'Avenue west-east crossed by a street.',
		graph: cross(
			() => preset('avenue'),
			() => preset('street')
		),
		shots: [wide(0, 0, 4), close('junction', 0, 0), close('corner', 10, 14)]
	},
	{
		id: 'skew-60',
		title: 'Skewed junction, about 60°',
		note: 'Avenue west-east crossed by a street at 60°.',
		graph: cross(
			() => preset('avenue'),
			() => preset('street'),
			{ deg: 60 }
		),
		shots: [wide(0, 0, 4), close('junction', 0, 0), close('acute corner', 12, 12)]
	},
	{
		id: 'skew-35',
		title: 'Skewed junction, about 35°',
		note: 'Avenue west-east crossed by a street at 35°.',
		graph: cross(
			() => preset('avenue'),
			() => preset('street'),
			{ deg: 35 }
		),
		shots: [wide(0, 0, 4), close('junction', 0, 0, 7), close('acute corner', 22, 12)]
	},
	{
		id: 'curved-t',
		title: 'Curved road into a T',
		note: 'Avenue west-east through c; a street leaves c heading south-east and curves back south.',
		graph: graph({ w: [-110, 0], c: [0, 0], e: [110, 0], s: [0, 110] }, [
			{ id: 'west', from: 'w', to: 'c', lanes: preset('avenue') },
			{ id: 'east', from: 'c', to: 'e', lanes: preset('avenue') },
			{ id: 'south', from: 'c', to: 's', lanes: preset('street'), control: [50, 45] }
		]),
		shots: [wide(0, 20, 4), close('junction', 4, 8), close('curve', 18, 30, 8)]
	},
	{
		id: 'offset-cross',
		title: 'Road slid with offset, crossed by a street',
		note: 'Avenue drawn west-east along y = 0 but slid 6 m south with offset; a street crosses at c.',
		graph: cross(
			() => preset('avenue'),
			() => preset('street'),
			{ ewOffset: 6 }
		),
		shots: [wide(0, 0, 4), close('junction', 0, 6), close('corner', 10, 20)]
	},
	{
		id: 'median-footpath',
		title: 'Footpath across a 5 m grass median',
		note: 'Avenue west-east with a 5 m grass median; a 2 m footpath crosses it mid-block at c.',
		graph: cross(
			() => avenue({ median: verge(5) }),
			() => preset('path'),
			{ len: 100 }
		),
		shots: [wide(0, 0, 4), close('crossing', 0, 0, 7), close('refuge', 4, -2)]
	},
	{
		id: 'five-way',
		title: '5-way',
		note: 'Avenue west-east; streets leave north, south-east (60°) and south-west (120°).',
		graph: graph(
			{
				c: [0, 0],
				w: [-110, 0],
				e: [110, 0],
				n: [0, -110],
				se: [55, 95.26],
				sw: [-55, 95.26]
			},
			[
				{ id: 'west', from: 'w', to: 'c', lanes: preset('avenue') },
				{ id: 'east', from: 'c', to: 'e', lanes: preset('avenue') },
				{ id: 'north', from: 'n', to: 'c', lanes: preset('street') },
				{ id: 'se', from: 'c', to: 'se', lanes: preset('street') },
				{ id: 'sw', from: 'c', to: 'sw', lanes: preset('street') }
			]
		),
		shots: [wide(0, 10, 4), close('junction', 0, 6, 7), close('south corner', 0, 18)]
	}
];

// ---- Shooting ------------------------------------------------------------

async function seed(page: Page, g: GraphData) {
	await page.goto(`${base}/robots.txt`);
	await page.evaluate((graph) => {
		localStorage.clear();
		const id = 'gallery';
		localStorage.setItem(
			`citynista:city:${id}`,
			JSON.stringify({ id, name: id, graph, camera: null })
		);
		localStorage.setItem('citynista:cities', JSON.stringify([{ id, name: id }]));
		localStorage.setItem('citynista:current-city', id);
	}, g);
}

// True when the map area is one flat colour: the scene never drew (a reload
// mid-shot, or the app failed to load).
async function looksBlank(page: Page, png: Buffer) {
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const ctx = c.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const { data } = ctx.getImageData(120, 120, img.width - 240, img.height - 240);
		const counts = new Map<number, number>();
		let total = 0;
		for (let i = 0; i < data.length; i += 4 * 7) {
			const key = (data[i] >> 3) * 1024 + (data[i + 1] >> 3) * 32 + (data[i + 2] >> 3);
			counts.set(key, (counts.get(key) ?? 0) + 1);
			total++;
		}
		const top = Math.max(...counts.values());
		return top / total > 0.995;
	}, png.toString('base64'));
}

async function shoot(page: Page, shot: Shot, path: string) {
	const cam = shot.at.join(',');
	for (let attempt = 1; attempt <= 5; attempt++) {
		let navigations = 0;
		const count = () => navigations++;
		try {
			await page.goto(`${base}/?cam=${cam}`);
			await page.waitForSelector('canvas');
			await page.waitForLoadState('networkidle');
			page.on('framenavigated', count);
			await page.evaluate(
				() =>
					new Promise<void>((r) => {
						let n = 0;
						const t = () => (n++ < 14 ? requestAnimationFrame(t) : r());
						requestAnimationFrame(t);
					})
			);
			await page.mouse.move(640, 59);
			const png = await page.screenshot({ path });
			page.off('framenavigated', count);
			if (navigations === 0 && !(await looksBlank(page, png))) return attempt;
			console.warn(`  retry ${shot.label}: ${navigations ? 'page reloaded' : 'blank'}`);
		} catch (err) {
			page.off('framenavigated', count);
			console.warn(`  retry ${shot.label}: ${(err as Error).message.split('\n')[0]}`);
		}
	}
	throw new Error(`could not get a drawn shot of ${path}`);
}

mkdirSync(join(outDir, 'scenes'), { recursive: true });
const browser = await chromium.launch({
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const results: { scene: SceneDef; files: { shot: Shot; file: string }[] }[] = [];
for (const scene of scenes) {
	writeFileSync(join(outDir, 'scenes', `${scene.id}.json`), JSON.stringify(scene.graph, null, 1));
	await seed(page, scene.graph);
	const files = [];
	for (const [i, shot] of scene.shots.entries()) {
		const file = `${scene.id}-${i + 1}-${shot.label.replace(/\W+/g, '-')}.png`;
		await shoot(page, shot, join(outDir, file));
		files.push({ shot, file });
	}
	console.log(`${scene.id}: ${files.length} shots`);
	results.push({ scene, files });
}
await browser.close();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Citynista gallery</title>
<style>
body { background: #161616; color: #ddd; font: 14px system-ui, sans-serif; margin: 24px; }
nav a { color: #8cf; margin-right: 12px; }
section { margin: 40px 0; }
h2 { margin: 0 0 4px; font-size: 18px; }
p { margin: 0 0 12px; color: #aaa; max-width: 900px; }
.shots { display: flex; flex-wrap: wrap; gap: 12px; }
figure { margin: 0; }
figure img { width: 640px; display: block; border: 1px solid #333; }
figcaption { padding: 4px 0; color: #ccc; }
code { color: #888; }
</style></head><body>
<h1>Citynista gallery</h1>
<p>${new Date().toISOString()} · ${esc(base)} · click an image for full size</p>
<nav>${results.map(({ scene }) => `<a href="#${scene.id}">${esc(scene.title)}</a>`).join('')}</nav>
${results
	.map(
		({ scene, files }) => `<section id="${scene.id}">
<h2>${esc(scene.title)} <code>${scene.id}</code></h2>
<p>${esc(scene.note)}</p>
<div class="shots">${files
			.map(
				({ shot, file }) =>
					`<figure><a href="${file}"><img src="${file}" loading="lazy"></a><figcaption>${esc(scene.title)} · ${esc(shot.label)} <code>cam=${shot.at.join(',')}</code></figcaption></figure>`
			)
			.join('')}</div>
</section>`
	)
	.join('\n')}
</body></html>
`;
writeFileSync(join(outDir, 'index.html'), html);
console.log(`wrote ${join(outDir, 'index.html')}`);
