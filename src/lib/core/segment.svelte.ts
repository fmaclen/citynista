import type { CrossingControl, Lane, SegmentData } from './types';
import { getTotalWidth, serializeLanes } from './lane-template';
import { carries } from './lane-types';
import { copyControl } from './crossing-controls';

// The writes a segment's ends and lanes take. A node holds car roads or
// footpaths, never both (core/separate.ts), and that rests on which nodes
// each segment ends at and whether its lanes carry cars: so only whoever
// made a segment holds its writes (the `claim` the constructor calls), a
// Graph keeping them to itself and writing through its own mutators. Read
// from outside, a segment's ends are fixed and its lanes frozen.
// With them, who made the segment hears of every write to it (`watch`): its
// ends, lanes, handle, shifts and controls (Graph.changesSince).
export interface SegmentWrites {
	ends(startNodeId: string, endNodeId: string): void;
	lanes(lanes: readonly Lane[]): void;
	watch(written: () => void): void;
}

export class Segment {
	readonly id: string;
	#start: string;
	#end: string;
	#controlX = $state<number | undefined>(undefined);
	#controlY = $state<number | undefined>(undefined);
	#lanes = $state.raw<readonly Lane[]>([]);
	// Metres the cross-section sits to the right of the drawn line at each
	// end, looking from the start node to the end node (0 = centred on the
	// line); it blends from one to the other along the road (road-line.ts).
	#offsetStart = $state(0);
	#offsetEnd = $state(0);
	// A footpath's crossing controls set by hand (core/crossing-controls.ts),
	// replaced whole on every change: the drawing reads a new list as an edit.
	#controls = $state.raw<readonly CrossingControl[] | undefined>(undefined);
	#written: (() => void) | undefined;

	lanesKey = $derived(serializeLanes(this.lanes));
	totalWidth = $derived(getTotalWidth(this.lanes));

	constructor(
		id: string,
		startNodeId: string,
		endNodeId: string,
		lanes: readonly Lane[],
		claim?: (writes: SegmentWrites) => void
	) {
		this.id = id;
		this.#start = startNodeId;
		this.#end = endNodeId;
		this.#lanes = sealed(lanes);
		claim?.({
			ends: (start, end) => {
				this.#start = start;
				this.#end = end;
				this.#written?.();
			},
			lanes: (next) => {
				this.#lanes = sealed(next);
				this.#written?.();
			},
			watch: (written) => (this.#written = written)
		});
	}

	get controlX() {
		return this.#controlX;
	}
	set controlX(x: number | undefined) {
		this.#controlX = x;
		this.#written?.();
	}
	get controlY() {
		return this.#controlY;
	}
	set controlY(y: number | undefined) {
		this.#controlY = y;
		this.#written?.();
	}
	get offsetStart() {
		return this.#offsetStart;
	}
	set offsetStart(offset: number) {
		this.#offsetStart = offset;
		this.#written?.();
	}
	get offsetEnd() {
		return this.#offsetEnd;
	}
	set offsetEnd(offset: number) {
		this.#offsetEnd = offset;
		this.#written?.();
	}
	get controls() {
		return this.#controls;
	}
	set controls(controls: readonly CrossingControl[] | undefined) {
		this.#controls = controls;
		this.#written?.();
	}

	get startNodeId() {
		return this.#start;
	}

	get endNodeId() {
		return this.#end;
	}

	get lanes() {
		return this.#lanes;
	}

	get hasControlPoint() {
		return this.controlX !== undefined && this.controlY !== undefined;
	}

	setControlPoint(x: number, y: number) {
		this.controlX = x;
		this.controlY = y;
	}

	clearControlPoint() {
		this.controlX = undefined;
		this.controlY = undefined;
	}

	cloneLanes(): Lane[] {
		return this.lanes.map((lane) => ({ ...lane }));
	}

	toJSON(): SegmentData {
		const data: SegmentData = {
			id: this.id,
			startNodeId: this.startNodeId,
			endNodeId: this.endNodeId,
			controlX: this.controlX,
			controlY: this.controlY,
			lanes: this.cloneLanes()
		};
		if (this.offsetStart) data.offsetStart = this.offsetStart;
		if (this.offsetEnd) data.offsetEnd = this.offsetEnd;
		if (this.controls?.length) data.controls = this.controls.map(copyControl);
		return data;
	}

	static fromJSON(data: SegmentData, claim?: (writes: SegmentWrites) => void) {
		const segment = new Segment(data.id, data.startNodeId, data.endNodeId, data.lanes, claim);
		if (data.controlX !== undefined && data.controlY !== undefined) {
			segment.setControlPoint(data.controlX, data.controlY);
		}
		segment.offsetStart = data.offsetStart ?? 0;
		segment.offsetEnd = data.offsetEnd ?? 0;
		// A car road keeps no crossing control: only a footpath's are read.
		if (data.controls?.length && !carries(data.lanes))
			segment.controls = data.controls.map(copyControl);
		return segment;
	}
}

// A cross-section as a segment keeps it: its own copy, every lane given an
// id unused anywhere on it, and frozen, so nothing read off it (its kind:
// `carries` in core/lane-types.ts) goes stale. One already so kept is
// frozen as it is and kept as the same object (a lane edit refused puts
// back the cross-section each road held: Graph.setLanes), so what is kept
// by it is not read again.
const kept = new WeakSet<readonly Lane[]>();
function sealed(lanes: readonly Lane[]): readonly Lane[] {
	if (kept.has(lanes)) return lanes;
	const copy = lanes.map((lane) => ({ ...lane }));
	const used = copy.flatMap((l) => (l.id ? [l.id] : []));
	let n = 0;
	for (const lane of copy) {
		if (lane.id && copy.filter((l) => l.id === lane.id).length === 1) continue;
		while (used.includes(`l${n}`)) n++;
		lane.id = `l${n}`;
		used.push(lane.id);
	}
	const out = Object.freeze(copy.map((lane) => Object.freeze(lane)));
	kept.add(out);
	return out;
}
