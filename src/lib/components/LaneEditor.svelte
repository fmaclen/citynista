<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import {
		LANE_COLORS,
		LANE_TEMPLATES,
		createLanesFrom,
		getTotalWidth
	} from '$lib/core/lane-template';
	import { LANE_TYPE_LIST, LANE_TYPE_SPECS, isRoadway } from '$lib/core/lane-types';
	import type { LaneType } from '$lib/core/types';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		ArrowLeft,
		ArrowRight,
		CornerUpLeft,
		CornerUpRight,
		Equal,
		GripVertical,
		Plus,
		Trash2,
		X
	} from '@lucide/svelte';

	const editor = getEditorContext();

	const segments = $derived(
		[...editor.selectedSegments]
			.map((id) => editor.graph.segments.get(id))
			.filter((s) => s !== undefined)
	);
	// Segments with identical cross-sections are edited together; mixed
	// selections can only be overwritten with a preset.
	const uniform = $derived(
		segments.length > 0 && segments.every((s) => s.lanesKey === segments[0].lanesKey)
	);
	const lanes = $derived(uniform ? segments[0].lanes : []);

	const LANE_TYPES: { value: LaneType; label: string }[] = LANE_TYPE_LIST.map((value) => ({
		value,
		label: LANE_TYPE_SPECS[value].label
	}));

	const MIN_LANE_WIDTH = 0.5;
	const MAX_LANE_WIDTH = 30;

	function commit() {
		editor.rebuildRoads();
		editor.refreshSelectionVisuals();
		editor.graph.save();
	}

	function setType(index: number, value: string) {
		const option = LANE_TYPES.find((o) => o.value === value);
		if (!option) return;
		if (lanes[index]?.type === option.value) return;

		for (const segment of segments) {
			const lane = segment.lanes[index];
			lane.type = option.value;
			lane.direction = LANE_TYPE_SPECS[option.value].directional ? 'forward' : 'bidirectional';
			if (option.value === 'turn') {
				lane.turn ??= 'left';
			} else {
				delete lane.turn;
			}
		}
		commit();
	}

	function flipTurn(index: number) {
		const turn = lanes[index]?.turn === 'right' ? 'left' : 'right';
		for (const segment of segments) {
			segment.lanes[index].turn = turn;
		}
		commit();
	}

	function setWidth(index: number, value: string) {
		const width = parseFloat(value);
		if (isNaN(width)) return;

		for (const segment of segments) {
			segment.lanes[index].width = Math.min(MAX_LANE_WIDTH, Math.max(MIN_LANE_WIDTH, width));
		}
		commit();
	}

	function flipDirection(index: number) {
		const direction = lanes[index]?.direction === 'forward' ? 'backward' : 'forward';
		for (const segment of segments) {
			segment.lanes[index].direction = direction;
		}
		commit();
	}

	let dragIndex = $state<number | null>(null);

	function startDrag(event: DragEvent, index: number) {
		dragIndex = index;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', String(index));
		}
	}

	function dragOverRow(event: DragEvent, index: number) {
		event.preventDefault();
		if (dragIndex === null || dragIndex === index) return;

		for (const segment of segments) {
			const [moved] = segment.lanes.splice(dragIndex, 1);
			segment.lanes.splice(index, 0, moved);
		}
		dragIndex = index;
		editor.rebuildRoads();
	}

	function endDrag() {
		if (dragIndex === null) return;
		dragIndex = null;
		commit();
	}

	function removeLane(index: number) {
		if (lanes.length <= 1) return;
		for (const segment of segments) {
			segment.lanes.splice(index, 1);
		}
		commit();
	}

	function addLane() {
		for (const segment of segments) {
			segment.lanes.push({ type: 'road', width: 3, direction: 'forward' });
		}
		commit();
	}

	function applyPreset(templateId: string) {
		if (!templateId) return;
		for (const segment of segments) {
			segment.lanes = createLanesFrom(templateId);
		}
		commit();
	}

	const totalWidth = $derived(uniform ? getTotalWidth(lanes) : 0);

	function toggleLaneMarkings(index: number) {
		const next = lanes[index]?.markings === false ? undefined : false;
		for (const segment of segments) {
			if (next === undefined) delete segment.lanes[index].markings;
			else segment.lanes[index].markings = next;
		}
		commit();
	}
</script>

{#if segments.length > 0}
	<aside
		class="fixed top-4 right-4 z-40 flex max-h-[calc(100vh-2rem)] w-96 flex-col gap-3 overflow-y-auto rounded-lg border bg-background p-4 shadow-lg"
	>
		<div class="flex items-center justify-between">
			<div>
				<h2 class="text-sm font-semibold">Lanes</h2>
				<p class="text-xs text-muted-foreground">
					{#if segments.length > 1}
						Editing {segments.length} segments
					{:else}
						Left to right along the drawing direction
					{/if}
				</p>
			</div>
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				onclick={() => editor.clearSelection()}
				title="Close"
			>
				<X class="h-4 w-4" />
			</Button>
		</div>

		{#if uniform}
			<div
				class="flex h-6 w-full overflow-hidden rounded border border-border"
				title="Cross-section preview"
			>
				{#each lanes as lane, i (i)}
					<div
						class="flex h-full items-center justify-center overflow-hidden text-[10px] text-white/60"
						style="width: {(lane.width / totalWidth) * 100}%; background-color: {LANE_COLORS[
							lane.type
						]};"
					>
						{lane.width}
					</div>
				{/each}
			</div>

			<div class="flex flex-col gap-1.5">
				{#each lanes as lane, i (i)}
					<div
						class="flex items-center gap-1 rounded {dragIndex === i ? 'bg-muted opacity-60' : ''}"
						role="listitem"
						ondragover={(e) => dragOverRow(e, i)}
					>
						<button
							class="flex h-7 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
							draggable="true"
							ondragstart={(e) => startDrag(e, i)}
							ondragend={endDrag}
							title="Drag to reorder"
							aria-label="Drag to reorder"
						>
							<GripVertical class="h-4 w-4" />
						</button>

						<div
							class="h-6 w-3 shrink-0 rounded-sm"
							style="background-color: {LANE_COLORS[lane.type]};"
						></div>

						<Select.Root type="single" value={lane.type} onValueChange={(v) => setType(i, v)}>
							<Select.Trigger class="w-26" size="sm">
								{LANE_TYPES.find((o) => o.value === lane.type)?.label}
							</Select.Trigger>
							<Select.Content>
								{#each LANE_TYPES as option (option.value)}
									<Select.Item value={option.value} label={option.label} />
								{/each}
							</Select.Content>
						</Select.Root>

						<Input
							type="number"
							step="0.5"
							min={MIN_LANE_WIDTH}
							max={MAX_LANE_WIDTH}
							class="h-8 w-16 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
							value={lane.width}
							onchange={(e) => setWidth(i, e.currentTarget.value)}
						/>

						{#if LANE_TYPE_SPECS[lane.type].directional}
							<Button
								variant="ghost"
								size="icon"
								class="h-7 w-7 shrink-0"
								onclick={() => flipDirection(i)}
								title="Direction of travel (relative to drawing direction)"
							>
								{#if lane.direction === 'forward'}
									<ArrowRight class="h-4 w-4" />
								{:else}
									<ArrowLeft class="h-4 w-4" />
								{/if}
							</Button>
						{:else}
							<div class="h-7 w-7 shrink-0"></div>
						{/if}

						{#if isRoadway(lane.type)}
							<Button
								variant="ghost"
								size="icon"
								class="h-7 w-7 shrink-0 {lane.markings === false ? 'text-muted-foreground/40' : ''}"
								onclick={() => toggleLaneMarkings(i)}
								title="Lane markings"
							>
								<Equal class="h-4 w-4" />
							</Button>
						{:else}
							<div class="h-7 w-7 shrink-0"></div>
						{/if}

						{#if lane.type === 'turn'}
							<Button
								variant="ghost"
								size="icon"
								class="h-7 w-7 shrink-0"
								onclick={() => flipTurn(i)}
								title="Turn direction"
							>
								{#if lane.turn === 'right'}
									<CornerUpRight class="h-4 w-4" />
								{:else}
									<CornerUpLeft class="h-4 w-4" />
								{/if}
							</Button>
						{:else}
							<div class="h-7 w-7 shrink-0"></div>
						{/if}

						<Button
							variant="ghost"
							size="icon"
							class="h-7 w-7 shrink-0"
							disabled={lanes.length <= 1}
							onclick={() => removeLane(i)}
							title="Remove lane"
						>
							<Trash2 class="h-4 w-4" />
						</Button>
					</div>
				{/each}
			</div>

			<div class="flex items-center justify-between gap-2">
				<Button variant="outline" size="sm" onclick={addLane}>
					<Plus class="h-4 w-4" />
					Add lane
				</Button>

				<span class="text-xs text-muted-foreground">{totalWidth}m total</span>
			</div>
		{:else}
			<p class="text-xs text-muted-foreground">
				The selected segments have different lane configurations. Apply a preset to replace all of
				them.
			</p>
		{/if}

		<Select.Root type="single" value="" onValueChange={applyPreset}>
			<Select.Trigger class="w-full" size="sm">Apply preset…</Select.Trigger>
			<Select.Content>
				{#each LANE_TEMPLATES as template (template.id)}
					<Select.Item value={template.id} label={template.name} />
				{/each}
			</Select.Content>
		</Select.Root>
	</aside>
{/if}
