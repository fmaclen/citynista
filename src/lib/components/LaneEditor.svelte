<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import {
		LANE_TEMPLATES,
		createLanesFrom,
		getTotalWidth,
		laneSwatchColor
	} from '$lib/core/lane-template';
	import type { LaneMaterial, LaneRole } from '$lib/core/types';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		ArrowLeft,
		ArrowRight,
		Equal,
		GripVertical,
		Layers,
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

	const ROLE_OPTIONS: { value: LaneRole; label: string }[] = [
		{ value: 'vehicle', label: 'Vehicle' },
		{ value: 'pedestrian', label: 'Pedestrian' },
		{ value: 'buffer', label: 'Buffer' }
	];

	const MATERIAL_OPTIONS: { value: LaneMaterial; label: string }[] = [
		{ value: 'asphalt', label: 'Asphalt' },
		{ value: 'concrete', label: 'Concrete' },
		{ value: 'pavement', label: 'Pavement' },
		{ value: 'grass', label: 'Grass' },
		{ value: 'dirt', label: 'Dirt' }
	];

	const MIN_LANE_WIDTH = 0.5;
	const MAX_LANE_WIDTH = 30;

	function commit() {
		editor.rebuildRoads();
		editor.refreshSelectionVisuals();
		editor.graph.save();
	}

	function setRole(index: number, value: string) {
		const option = ROLE_OPTIONS.find((o) => o.value === value);
		if (!option) return;
		if (lanes[index]?.role === option.value) return;

		for (const segment of segments) {
			const lane = segment.lanes[index];
			lane.role = option.value;
			lane.direction = option.value === 'vehicle' ? 'forward' : 'bidirectional';
			if (option.value !== 'buffer') delete lane.raised;
		}
		commit();
	}

	function setMaterial(index: number, value: string) {
		const lane = lanes[index];
		if (!lane) return;
		const option = MATERIAL_OPTIONS.find((o) => o.value === value);
		if (!option) return;
		if (lane.material === option.value) return;

		for (const segment of segments) {
			segment.lanes[index].material = option.value;
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
			segment.lanes.push({ role: 'vehicle', material: 'asphalt', width: 3, direction: 'forward' });
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

	function toggleRaised(index: number) {
		const next = !lanes[index]?.raised;
		for (const segment of segments) {
			const lane = segment.lanes[index];
			if (lane.role !== 'buffer') continue;
			if (next) lane.raised = true;
			else delete lane.raised;
		}
		commit();
	}
</script>

{#if segments.length > 0}
	<aside
		class="fixed top-4 right-4 z-40 flex max-h-[calc(100vh-2rem)] w-fit max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto rounded-lg border bg-background p-4 shadow-lg"
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
						style="width: {(lane.width / totalWidth) * 100}%; background-color: {laneSwatchColor(
							lane
						)};"
					>
						{lane.width}
					</div>
				{/each}
			</div>

			<div class="grid grid-cols-[auto_auto_auto_auto_auto_auto_auto_auto] gap-x-1 gap-y-1.5">
				{#each lanes as lane, i (i)}
					<div
						class="col-span-full grid grid-cols-subgrid items-center rounded {dragIndex === i
							? 'bg-muted opacity-60'
							: ''}"
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
							style="background-color: {laneSwatchColor(lane)};"
						></div>

						<Select.Root type="single" value={lane.role} onValueChange={(v) => setRole(i, v)}>
							<Select.Trigger class="w-full" size="sm">
								{ROLE_OPTIONS.find((o) => o.value === lane.role)?.label}
							</Select.Trigger>
							<Select.Content>
								{#each ROLE_OPTIONS as option (option.value)}
									<Select.Item value={option.value} label={option.label} />
								{/each}
							</Select.Content>
						</Select.Root>

						<Select.Root
							type="single"
							value={lane.material}
							onValueChange={(v) => setMaterial(i, v)}
						>
							<Select.Trigger class="w-full" size="sm">
								{MATERIAL_OPTIONS.find((o) => o.value === lane.material)?.label}
							</Select.Trigger>
							<Select.Content>
								{#each MATERIAL_OPTIONS as option (option.value)}
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

						{#if lane.role === 'vehicle'}
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

						{#if lane.role === 'vehicle'}
							<Button
								variant="ghost"
								size="icon"
								class="h-7 w-7 shrink-0 {lane.markings === false ? 'text-muted-foreground/40' : ''}"
								onclick={() => toggleLaneMarkings(i)}
								title="Lane markings"
							>
								<Equal class="h-4 w-4" />
							</Button>
						{:else if lane.role === 'buffer'}
							<Button
								variant="ghost"
								size="icon"
								class="h-7 w-7 shrink-0 {lane.raised ? '' : 'text-muted-foreground/40'}"
								onclick={() => toggleRaised(i)}
								title="Raised buffer"
							>
								<Layers class="h-4 w-4" />
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
