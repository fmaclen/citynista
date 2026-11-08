import { readFileSync } from 'node:fs';
import { segmentEnds } from '../src/lib/core/attach';

// Sanity check for the Neighbourhood example's drawing, run at the end of
// scripts/build-neighbourhood.ts (or `bun scripts/neighbourhood-audit.ts
// <graph.json>`). It catches builder mistakes, not renderer ones:
// - loop: a curve bulging more than about a quarter of its chord off the
//   chord (a quarter arc is exactly 25%, so the bar sits just above it);
// - kink: two roads of one kind meeting at more than 5° off straight, at a
//   pass-through node or as the through pair of a junction;
// - stray: a road or path end left in open ground;
// - overlap: two roads whose ribbons overlap without sharing a node.
// Intended exceptions are listed below by location.

type Point = { x: number; y: number };
interface AuditLane {
	role: string;
	width: number;
}
interface AuditGraph {
	nodes: { id: string; x: number; y: number; junction?: { sides?: Record<string, string> } }[];
	segments: {
		id: string;
		startNodeId: string;
		endNodeId: string;
		controlX?: number;
		controlY?: number;
		offset?: number;
		lanes?: AuditLane[];
	}[];
}

const LOOP_RATIO = 0.27;
const KINK_DEGREES = 5;
// Pairs further than this off straight are a turn, not a through road.
const THROUGH_DEGREES = 30;
const OVERLAP_TOLERANCE = 0.5;
const NEAR = 15;

// Curves meant to bulge: the roundabout's ring and its footpath ring.
const INTENDED_LOOPS: Point[] = [{ x: 0, y: 230 }];
const LOOP_RADIUS = 50;

// Kinks meant to be there: the avenue's end, where its carriageways part.
const INTENDED_KINKS: Point[] = [{ x: -380, y: 0 }];

// Ends meant to dangle. 'edge': roads running on off the map, which may sit
// beside each other. 'dead': cul-de-sacs and spurs, which must stop well clear
// of other roads.
const INTENDED_ENDS: (Point & { kind: 'edge' | 'dead' })[] = [
	...[
		[500, -700],
		[500, 600],
		[-560, -420],
		[760, -420],
		[380, -680],
		[380, 640],
		[-680, -6],
		[-680, 6],
		[-200, -700],
		[100, -680],
		[-660, 30],
		[-660, 380],
		[-660, 240],
		[-660, 330]
	].map(([x, y]) => ({ x, y, kind: 'edge' as const })),
	...[
		[-100, -710],
		[0, -720],
		[-500, -500],
		[740, -100],
		[760, 200],
		[470, -560],
		[470, 200],
		[470, 460],
		[640, 300]
	].map(([x, y]) => ({ x, y, kind: 'dead' as const }))
];
const END_RADIUS = 12;

export interface AuditIssue {
	kind: 'loop' | 'kink' | 'stray' | 'overlap';
	at: Point;
	detail: string;
}

function near(p: Point, list: Point[], radius: number) {
	return list.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= radius);
}

function bezier(a: Point, c: Point, b: Point, t: number) {
	const u = 1 - t;
	return {
		x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
		y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
	};
}

function angleBetween(u: Point, v: Point) {
	const dot = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
	return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

const round = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) });

export function auditNeighbourhood(graph: AuditGraph) {
	const issues: AuditIssue[] = [];
	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
	// Roads attached at another's edge are read where they are drawn: their
	// ends moved to that edge (as the editor does).
	const drawn = {
		nodes: new Map(
			graph.nodes.map((n) => [
				n.id,
				{
					...n,
					connectedSegments: graph.segments
						.filter((s) => s.startNodeId === n.id || s.endNodeId === n.id)
						.map((s) => s.id)
				}
			])
		),
		segments: new Map(
			graph.segments.map((s) => [s.id, { ...s, offset: s.offset ?? 0, lanes: s.lanes ?? [] }])
		)
	};
	const segments = graph.segments.map((s) => {
		const ends = segmentEnds(drawn as never, drawn.segments.get(s.id)! as never);
		const a = { ...nodes.get(s.startNodeId)!, ...ends!.a };
		const b = { ...nodes.get(s.endNodeId)!, ...ends!.b };
		const c = { x: s.controlX ?? (a.x + b.x) / 2, y: s.controlY ?? (a.y + b.y) / 2 };
		const lanes = s.lanes ?? [];
		const isPath = lanes.length > 0 && lanes.every((l) => l.role === 'pedestrian');
		const width = lanes.reduce((sum, l) => sum + l.width, 0);
		return { id: s.id, a, b, c, isPath, width, startId: s.startNodeId, endId: s.endNodeId };
	});

	// Loops: the curve's peak sits halfway between the chord and the control.
	for (const s of segments) {
		const chord = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
		if (chord < 1) continue;
		const cross = ((s.b.x - s.a.x) * (s.c.y - s.a.y) - (s.b.y - s.a.y) * (s.c.x - s.a.x)) / chord;
		const bulge = Math.abs(cross) / 2;
		const mid = bezier(s.a, s.c, s.b, 0.5);
		if (bulge / chord > LOOP_RATIO && !near(mid, INTENDED_LOOPS, LOOP_RADIUS)) {
			issues.push({
				kind: 'loop',
				at: round(mid),
				detail: `${s.id} bulges ${Math.round((100 * bulge) / chord)}% of its chord`
			});
		}
	}

	// Arms at each node, as outward tangents.
	const arms = new Map<string, { seg: (typeof segments)[number]; dir: Point }[]>();
	for (const s of segments) {
		const out = (from: Point, toward: Point, other: Point) => {
			const d = { x: toward.x - from.x, y: toward.y - from.y };
			return Math.hypot(d.x, d.y) > 1e-6 ? d : { x: other.x - from.x, y: other.y - from.y };
		};
		const list = (id: string) => arms.get(id) ?? (arms.set(id, []), arms.get(id)!);
		list(s.startId).push({ seg: s, dir: out(s.a, s.c, s.b) });
		list(s.endId).push({ seg: s, dir: out(s.b, s.c, s.a) });
	}

	for (const [nodeId, list] of arms) {
		const node = nodes.get(nodeId)!;
		// Kinks: each arm's best through partner of the same kind; mutual pairs
		// within a turn's angle of straight must be straight.
		for (const kind of [false, true]) {
			const same = list.filter((arm) => arm.seg.isPath === kind);
			const offStraight = (i: number, j: number) => 180 - angleBetween(same[i].dir, same[j].dir);
			const best = same.map((_, i) => {
				let pick = -1;
				for (let j = 0; j < same.length; j++) {
					if (j !== i && (pick < 0 || offStraight(i, j) < offStraight(i, pick))) pick = j;
				}
				return pick;
			});
			for (let i = 0; i < same.length; i++) {
				const j = best[i];
				if (j <= i || best[j] !== i) continue;
				const off = offStraight(i, j);
				const passThrough = same.length === 2;
				if (
					off > KINK_DEGREES &&
					(passThrough || off <= THROUGH_DEGREES) &&
					!near(node, INTENDED_KINKS, END_RADIUS)
				) {
					issues.push({
						kind: 'kink',
						at: round(node),
						detail: `${same[i].seg.id} and ${same[j].seg.id} meet ${Math.round(off)}° off straight`
					});
				}
			}
		}
		// Strays: an end with one arm, not on the intended list.
		if (list.length === 1 && !near(node, INTENDED_ENDS, END_RADIUS)) {
			issues.push({
				kind: 'stray',
				at: round(node),
				detail: `${list[0].seg.isPath ? 'path' : 'road'} ${list[0].seg.id} ends in open ground`
			});
		}
	}

	// Overlaps: sampled centrelines closer than the two half-widths, for roads
	// that share no node.
	const samples = segments.map((s) => {
		const length =
			Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) + Math.hypot(s.c.x - s.a.x, s.c.y - s.a.y);
		const n = Math.max(4, Math.ceil(length / 2));
		return Array.from({ length: n + 1 }, (_, i) => bezier(s.a, s.c, s.b, i / n));
	});
	const cell = 20;
	const grid = new Map<string, { si: number; p: Point }[]>();
	samples.forEach((points, si) => {
		for (const p of points) {
			const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
			(grid.get(key) ?? (grid.set(key, []), grid.get(key)!)).push({ si, p });
		}
	});
	// Roads one short piece apart (through a node each) are neighbours too.
	const touching = new Map<string, Set<number>>();
	segments.forEach((s, i) => {
		for (const id of [s.startId, s.endId]) {
			(touching.get(id) ?? (touching.set(id, new Set()), touching.get(id)!)).add(i);
		}
	});
	const neighbours = (i: number) => {
		const out = new Set<number>();
		for (const id of [segments[i].startId, segments[i].endId]) {
			for (const j of touching.get(id) ?? []) out.add(j);
		}
		return out;
	};
	// The nodes linking two roads that touch or sit one piece apart, or null.
	const linkNodes = (i: number, j: number) => {
		const ends = (k: number) => [segments[k].startId, segments[k].endId];
		const hop1 = neighbours(i);
		if (hop1.has(j))
			return ends(i)
				.filter((id) => ends(j).includes(id))
				.map((id) => nodes.get(id)!);
		const via = [...hop1].filter((k) => neighbours(k).has(j));
		if (via.length === 0) return null;
		return [...new Set(via.flatMap((k) => [...ends(k), ...ends(i), ...ends(j)]))].map(
			(id) => nodes.get(id)!
		);
	};
	// The angle between two roads' tangents where they share a node (90° when
	// they don't, so only the plain reach applies).
	const joinAngle = (i: number, j: number) => {
		const shared = [segments[i].startId, segments[i].endId].find(
			(id) => id === segments[j].startId || id === segments[j].endId
		);
		if (!shared) return 90;
		const dirOf = (k: number) => arms.get(shared)!.find((arm) => arm.seg === segments[k])!.dir;
		const between = angleBetween(dirOf(i), dirOf(j));
		return Math.min(between, 180 - between);
	};
	const reported = new Set<string>();
	samples.forEach((points, si) => {
		const s = segments[si];
		for (const p of points) {
			const gx = Math.floor(p.x / cell);
			const gy = Math.floor(p.y / cell);
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					for (const q of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
						if (q.si <= si) continue;
						const t = segments[q.si];
						const key = `${si},${q.si}`;
						if (reported.has(key)) continue;
						const reach = (s.width + t.width) / 2;
						const gap = Math.hypot(p.x - q.p.x, p.y - q.p.y);
						if (gap >= reach - OVERLAP_TOLERANCE) continue;
						// Roads joined at a node, directly or through one short piece,
						// naturally overlap around that node; only overlap away from
						// those nodes counts.
						// A shallow join overlaps further out: reach / sin(angle).
						const joins = linkNodes(si, q.si);
						if (joins) {
							const angle = Math.max(joinAngle(si, q.si), 15);
							const radius = reach / Math.sin((angle * Math.PI) / 180) + 5;
							if (joins.some((n) => Math.hypot(p.x - n.x, p.y - n.y) < radius)) continue;
						}
						{
							reported.add(key);
							issues.push({
								kind: 'overlap',
								at: round(p),
								detail: `${s.id} overlaps ${t.id}`
							});
						}
					}
				}
			}
		}
	});

	// Near-misses read as strays too: a dangling end close to another road.
	for (const [nodeId, list] of arms) {
		if (list.length !== 1) continue;
		const node = nodes.get(nodeId)!;
		const dead = INTENDED_ENDS.filter((end) => end.kind === 'dead');
		if (!near(node, dead, END_RADIUS)) continue;
		const own = list[0].seg;
		for (const t of segments) {
			if ([own.startId, own.endId].some((id) => id === t.startId || id === t.endId)) continue;
			const close = samples[segments.indexOf(t)].some(
				(p) => Math.hypot(p.x - node.x, p.y - node.y) < t.width / 2 + NEAR
			);
			if (close) {
				issues.push({
					kind: 'stray',
					at: round(node),
					detail: `dead end ${list[0].seg.id} stops just short of ${t.id}`
				});
				break;
			}
		}
	}

	return issues;
}

export function summarise(issues: AuditIssue[]) {
	const counts = { loop: 0, kink: 0, stray: 0, overlap: 0 };
	for (const issue of issues) counts[issue.kind]++;
	return counts;
}

if (import.meta.main) {
	const file = process.argv[2] ?? 'static/examples/neighbourhood.json';
	const data = JSON.parse(readFileSync(file, 'utf8'));
	const issues = auditNeighbourhood(data.graph ?? data);
	for (const issue of issues)
		console.log(`${issue.kind}\t(${issue.at.x}, ${issue.at.y})\t${issue.detail}`);
	console.log(summarise(issues));
	if (issues.length > 0) process.exit(1);
}
