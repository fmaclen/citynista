<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import {
		LANE_COLORS,
		LANE_TEMPLATES,
		createLanesFrom,
		getTotalWidth
	} from '$lib/core/lane-template';
	import type { LaneType } from '$lib/core/types';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Trash2 } from '@lucide/svelte';

	const editor = getEditorContext();

	const segment = $derived(
		editor.laneEditorSegmentId ? editor.graph.segments.get(editor.laneEditorSegmentId) : undefined
	);

	const LANE_TYPES: { value: LaneType; label: string }[] = [
		{ value: 'road', label: 'Road' },
		{ value: 'sidewalk', label: 'Sidewalk' },
		{ value: 'grass', label: 'Grass' },
		{ value: 'median', label: 'Median' }
	];

	const MIN_LANE_WIDTH = 0.5;
	const MAX_LANE_WIDTH = 30;

	function commit() {
		editor.rebuildRoads();
		editor.refreshSelectionVisuals();
		editor.graph.save();
	}

	function setType(index: number, value: string) {
		if (!segment) return;
		const option = LANE_TYPES.find((o) => o.value === value);
		if (!option) return;

		const lane = segment.lanes[index];
		if (lane.type === option.value) return;

		lane.type = option.value;
		lane.direction = option.value === 'road' ? 'forward' : 'bidirectional';
		commit();
	}

	function setWidth(index: number, value: string) {
		if (!segment) return;
		const width = parseFloat(value);
		if (isNaN(width)) return;

		segment.lanes[index].width = Math.min(MAX_LANE_WIDTH, Math.max(MIN_LANE_WIDTH, width));
		commit();
	}

	function flipDirection(index: number) {
		if (!segment) return;
		const lane = segment.lanes[index];
		lane.direction = lane.direction === 'forward' ? 'backward' : 'forward';
		commit();
	}

	function moveLane(index: number, delta: number) {
		if (!segment) return;
		const target = index + delta;
		if (target < 0 || target >= segment.lanes.length) return;

		const lanes = segment.lanes;
		[lanes[index], lanes[target]] = [lanes[target], lanes[index]];
		commit();
	}

	function removeLane(index: number) {
		if (!segment || segment.lanes.length <= 1) return;
		segment.lanes.splice(index, 1);
		commit();
	}

	function addLane() {
		if (!segment) return;
		segment.lanes.push({ type: 'road', width: 3, direction: 'forward' });
		commit();
	}

	function applyPreset(templateId: string) {
		if (!segment || !templateId) return;
		segment.lanes = createLanesFrom(templateId);
		commit();
	}

	const totalWidth = $derived(segment ? getTotalWidth(segment.lanes) : 0);
</script>

<Dialog.Root
	open={segment !== undefined}
	onOpenChange={(open) => {
		if (!open) editor.closeLaneEditor();
	}}
>
	{#if segment}
		<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-xl">
			<Dialog.Header>
				<Dialog.Title>Lanes</Dialog.Title>
				<Dialog.Description>
					Cross-section of the selected segment, left to right along its drawing direction.
				</Dialog.Description>
			</Dialog.Header>

			<div
				class="flex h-7 w-full overflow-hidden rounded border border-border"
				title="Cross-section preview"
			>
				{#each segment.lanes as lane, i (i)}
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
				{#each segment.lanes as lane, i (i)}
					<div class="flex items-center gap-1.5">
						<div
							class="h-6 w-6 shrink-0 rounded"
							style="background-color: {LANE_COLORS[lane.type]};"
						></div>

						<Select.Root type="single" value={lane.type} onValueChange={(v) => setType(i, v)}>
							<Select.Trigger class="w-32" size="sm">
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
							class="h-8 w-20"
							value={lane.width}
							onchange={(e) => setWidth(i, e.currentTarget.value)}
						/>

						{#if lane.type === 'road'}
							<Button
								variant="ghost"
								size="icon"
								class="h-8 w-8"
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
							<div class="h-8 w-8 shrink-0"></div>
						{/if}

						<div class="ml-auto flex items-center">
							<Button
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								disabled={i === 0}
								onclick={() => moveLane(i, -1)}
								title="Move left"
							>
								<ArrowUp class="h-4 w-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								disabled={i === segment.lanes.length - 1}
								onclick={() => moveLane(i, 1)}
								title="Move right"
							>
								<ArrowDown class="h-4 w-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								disabled={segment.lanes.length <= 1}
								onclick={() => removeLane(i)}
								title="Remove lane"
							>
								<Trash2 class="h-4 w-4" />
							</Button>
						</div>
					</div>
				{/each}
			</div>

			<div class="flex items-center justify-between gap-2">
				<Button variant="outline" size="sm" onclick={addLane}>
					<Plus class="h-4 w-4" />
					Add lane
				</Button>

				<div class="flex items-center gap-2">
					<span class="text-sm text-muted-foreground">{totalWidth}m total</span>

					<Select.Root type="single" value="" onValueChange={applyPreset}>
						<Select.Trigger class="w-36" size="sm">Apply preset…</Select.Trigger>
						<Select.Content>
							{#each LANE_TEMPLATES as template (template.id)}
								<Select.Item value={template.id} label={template.name} />
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			</div>
		</Dialog.Content>
	{/if}
</Dialog.Root>
