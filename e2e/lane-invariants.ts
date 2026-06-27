export interface Violation {
	nodeId: string;
	cls: string;
	invariant: string;
	detail: string;
}

interface Point {
	x: number;
	y: number;
}

interface Interval {
	start: number;
	end: number;
}

export interface ManifestCase {
	index: number;
	cls: string;
	midNodeId: string;
}

export interface LaneManifest {
	cases: ManifestCase[];
}

interface DumpStrip {
	intervalIndex: number;
	laneType: string;
	surfaceClass: string;
	source: Interval;
	node: Interval | null;
	disposition:
		| {
				kind: 'continue';
				targetArmId: string;
				targetIntervalIndex: number;
		  }
		| {
				kind: 'terminate';
				mode: string;
				target: Interval | null;
		  };
}

interface DumpPaintBoundary {
	boundaryIndex: number;
	sourceOffset: number;
	targetOffset: number | null;
	disposition: string;
}

interface DumpArm {
	segmentId: string;
	frame: {
		stop: Point;
		into: Point;
		crossDir: Point;
		side: Point;
	};
	source: {
		plateSpan: Interval;
	};
	node: {
		plateSpan: Interval;
	};
	strips: DumpStrip[];
	paintBoundaries: DumpPaintBoundary[];
	centerNose: { intervalIndex: number; offset: number } | null;
}

interface DumpLayer {
	id: string;
	polygons: { outer: Point[]; holes: Point[][] }[];
}

interface DumpNode {
	nodeId: string;
	kind: string;
	arms: DumpArm[];
	morphs: Record<
		string,
		{
			laneBoundaries: (number | null)[];
			anchor: boolean;
			intervals: (Interval | null)[];
		}
	>;
	layers: DumpLayer[];
}

export interface LaneDump {
	nodes: DumpNode[];
}

function caseLabel(entry: ManifestCase | undefined) {
	return entry ? `${entry.cls} (#${entry.index})` : 'unknown';
}

function violation(
	nodeId: string,
	entry: ManifestCase | undefined,
	invariant: string,
	detail: string
) {
	return {
		nodeId,
		cls: entry?.cls ?? 'unknown',
		invariant,
		detail: `${caseLabel(entry)}: ${detail}`
	};
}

function finitePoint(point: Point) {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function finiteInterval(interval: Interval | null) {
	return interval === null || (Number.isFinite(interval.start) && Number.isFinite(interval.end));
}

function addFiniteViolations(node: DumpNode, entry: ManifestCase | undefined, hard: Violation[]) {
	for (const layer of node.layers) {
		for (const polygon of layer.polygons) {
			for (const point of polygon.outer) {
				if (!finitePoint(point)) {
					hard.push(
						violation(node.nodeId, entry, 'finite', `${layer.id} outer has non-finite point`)
					);
					return;
				}
			}
			for (const hole of polygon.holes) {
				for (const point of hole) {
					if (!finitePoint(point)) {
						hard.push(
							violation(node.nodeId, entry, 'finite', `${layer.id} hole has non-finite point`)
						);
						return;
					}
				}
			}
		}
	}

	for (const [segmentId, morph] of Object.entries(node.morphs)) {
		if (
			morph.laneBoundaries.some((offset) => offset !== null && !Number.isFinite(offset)) ||
			morph.intervals.some((interval) => !finiteInterval(interval))
		) {
			hard.push(
				violation(node.nodeId, entry, 'finite', `${segmentId} morph has non-finite offset`)
			);
		}
	}
}

function addRingViolations(node: DumpNode, entry: ManifestCase | undefined, hard: Violation[]) {
	for (const layer of node.layers) {
		for (const polygon of layer.polygons) {
			if (polygon.outer.length < 3) {
				hard.push(
					violation(node.nodeId, entry, 'polygon-rings', `${layer.id} outer has < 3 points`)
				);
			}
			for (const hole of polygon.holes) {
				if (hole.length < 3) {
					hard.push(
						violation(node.nodeId, entry, 'polygon-rings', `${layer.id} hole has < 3 points`)
					);
				}
			}
		}
	}
}

function addMonotoneViolations(
	node: DumpNode,
	entry: ManifestCase | undefined,
	gated: Violation[]
) {
	for (const arm of node.arms) {
		let previous = -Infinity;
		for (const strip of arm.strips) {
			if (strip.disposition.kind !== 'continue') continue;
			const target = strip.disposition.targetIntervalIndex;
			if (target < previous) {
				gated.push(
					violation(
						node.nodeId,
						entry,
						'monotone-axes',
						`${arm.segmentId} target interval decreased ${previous} -> ${target}`
					)
				);
			}
			previous = target;
		}
	}
}

// A continuing lane line must meet its counterpart at the node (no jog). The
// kernel guarantees this by construction: a matched boundary on the morphing arm
// targets the anchor's own boundary offset. So the check is directional — every
// continuing boundary on the WIDER (morph) arm must coincide with some anchor
// boundary, once both are expressed in a common lateral frame via crossDir sign.
// Born-lane / synthetic bay boundaries are excluded (they have no counterpart).
function addNoJogViolations(node: DumpNode, entry: ManifestCase | undefined, gated: Violation[]) {
	if (node.arms.length !== 2) return;
	const [x, y] = node.arms;
	const morph = x.paintBoundaries.length >= y.paintBoundaries.length ? x : y;
	const anchor = morph === x ? y : x;
	const sign =
		morph.frame.crossDir.x * anchor.frame.crossDir.x +
			morph.frame.crossDir.y * anchor.frame.crossDir.y >=
		0
			? 1
			: -1;
	const anchorOffsets = anchor.paintBoundaries
		.filter((boundary) => boundary.disposition === 'continue' && boundary.targetOffset !== null)
		.map((boundary) => boundary.targetOffset as number);
	for (const boundary of morph.paintBoundaries) {
		if (boundary.disposition !== 'continue' || boundary.targetOffset === null) {
			continue;
		}
		const target = sign * boundary.targetOffset;
		if (!anchorOffsets.some((offset) => Math.abs(offset - target) < 0.05)) {
			gated.push(
				violation(
					node.nodeId,
					entry,
					'no-jog',
					`${morph.segmentId} boundary ${boundary.boundaryIndex} target ${target.toFixed(2)} has no anchor counterpart`
				)
			);
		}
	}
}

function addSquareEndViolations(
	node: DumpNode,
	entry: ManifestCase | undefined,
	gated: Violation[]
) {
	const epsilon = 0.05;
	for (const arm of node.arms) {
		for (const strip of arm.strips) {
			if (
				strip.disposition.kind !== 'terminate' ||
				strip.disposition.mode !== 'taper' ||
				strip.node === null
			) {
				continue;
			}
			const sourceWidth = Math.abs(strip.source.end - strip.source.start);
			const nodeWidth = Math.abs(strip.node.end - strip.node.start);
			const isNose = arm.centerNose?.intervalIndex === strip.intervalIndex;
			if (nodeWidth > epsilon && nodeWidth < sourceWidth - epsilon && !isNose) {
				gated.push(
					violation(
						node.nodeId,
						entry,
						'square-ends',
						`${arm.segmentId} strip ${strip.intervalIndex} pinches ${sourceWidth} -> ${nodeWidth}`
					)
				);
			}
		}
	}
}

function armPoint(arm: DumpArm, offset: number, atInto: boolean) {
	const base = atInto ? arm.frame.into : arm.frame.stop;
	return {
		x: base.x + arm.frame.side.x * offset,
		y: base.y + arm.frame.side.y * offset
	};
}

function addRoadwayBoundsViolations(
	node: DumpNode,
	entry: ManifestCase | undefined,
	gated: Violation[]
) {
	const points: Point[] = [];
	for (const arm of node.arms) {
		for (const span of [arm.source.plateSpan, arm.node.plateSpan]) {
			points.push(armPoint(arm, span.start, false));
			points.push(armPoint(arm, span.end, false));
			points.push(armPoint(arm, span.start, true));
			points.push(armPoint(arm, span.end, true));
		}
	}
	if (points.length === 0) return;

	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const margin = 20;
	const bounds = {
		minX: Math.min(...xs) - margin,
		maxX: Math.max(...xs) + margin,
		minY: Math.min(...ys) - margin,
		maxY: Math.max(...ys) + margin
	};

	// Proxy for stray asphalt stubs: roadway layers should remain inside the
	// rectangle spanned by the node's arm frames, with a margin for corner curves.
	for (const layer of node.layers) {
		if (!layer.id.startsWith('roadway:')) continue;
		for (const polygon of layer.polygons) {
			for (const point of polygon.outer) {
				if (
					point.x < bounds.minX ||
					point.x > bounds.maxX ||
					point.y < bounds.minY ||
					point.y > bounds.maxY
				) {
					gated.push(
						violation(
							node.nodeId,
							entry,
							'roadway-in-bounds',
							`${layer.id} point ${point.x},${point.y} outside arm-frame bbox`
						)
					);
					return;
				}
			}
		}
	}
}

export function checkInvariants(dump: LaneDump, manifest: LaneManifest) {
	const hard: Violation[] = [];
	const gated: Violation[] = [];
	const byNode = new Map(dump.nodes.map((node) => [node.nodeId, node]));
	const manifestByNode = new Map(manifest.cases.map((entry) => [entry.midNodeId, entry]));

	for (const entry of manifest.cases) {
		const node = byNode.get(entry.midNodeId);
		if (!node || node.arms.length < 2) {
			hard.push(
				violation(
					entry.midNodeId,
					entry,
					'resolver-present',
					'manifest midNode missing or has < 2 arms'
				)
			);
		}
	}

	for (const node of dump.nodes) {
		const entry = manifestByNode.get(node.nodeId);
		addFiniteViolations(node, entry, hard);
		addRingViolations(node, entry, hard);
		// HARD gates: the kernel guarantees non-crossing lane axes (no twist) and
		// that continuing boundaries meet at the node (no jog), so either is a real
		// regression. square-ends/roadway-bounds stay gated proxies until the
		// junction slice makes them precise.
		addMonotoneViolations(node, entry, hard);
		addNoJogViolations(node, entry, hard);
		addSquareEndViolations(node, entry, gated);
		addRoadwayBoundsViolations(node, entry, gated);
	}

	return { hard, gated };
}
