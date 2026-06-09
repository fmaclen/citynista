<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { LANE_COLORS, LANE_TEMPLATES, getTotalWidth } from '$lib/core/lane-template';
	import { Button } from '$lib/components/ui/button';
	import { Pencil, MousePointer2, Trash2 } from '@lucide/svelte';

	const editor = getEditorContext();

	const maxPresetWidth = Math.max(...LANE_TEMPLATES.map((t) => getTotalWidth(t.lanes)));

	function onKeyDown(event: KeyboardEvent) {
		const target = event.target;
		if (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			(target instanceof HTMLElement && target.isContentEditable)
		) {
			return;
		}

		const index = parseInt(event.key, 10) - 1;
		if (isNaN(index)) return;

		const template = LANE_TEMPLATES[index];
		if (template) {
			editor.currentLaneTemplateId = template.id;
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="fixed bottom-8 left-1/2 z-50 -translate-x-1/2">
	<nav class="flex flex-row items-center gap-2 rounded-lg border bg-background p-2 shadow-lg">
		<Button
			variant={editor.mode === 'draw' ? 'default' : 'ghost'}
			size="icon"
			onclick={() => (editor.mode = editor.mode === 'draw' ? undefined : 'draw')}
			title="Draw Mode"
		>
			<Pencil class="h-4 w-4" />
		</Button>

		<Button
			variant={editor.mode === 'select' ? 'default' : 'ghost'}
			size="icon"
			onclick={() => (editor.mode = editor.mode === 'select' ? undefined : 'select')}
			title="Select Mode"
		>
			<MousePointer2 class="h-4 w-4" />
		</Button>

		<div class="mx-1 h-6 w-px bg-border"></div>

		{#each LANE_TEMPLATES as template, i (template.id)}
			{@const totalWidth = getTotalWidth(template.lanes)}
			{@const active = editor.currentLaneTemplateId === template.id}
			<button
				class="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border-2 transition-colors {active
					? 'border-foreground'
					: 'border-border hover:border-muted-foreground'}"
				style="background-color: {LANE_COLORS.grass};"
				aria-label={template.name}
				aria-pressed={active}
				title="{template.name} — {totalWidth}m (key {i + 1})"
				onclick={() => (editor.currentLaneTemplateId = template.id)}
			>
				<div
					class="absolute inset-y-0 left-1/2 flex -translate-x-1/2"
					style="width: {(totalWidth / maxPresetWidth) * 100}%;"
				>
					{#each template.lanes as lane, j (j)}
						<div
							class="h-full"
							style="width: {(lane.width / totalWidth) * 100}%; background-color: {LANE_COLORS[
								lane.type
							]};"
						></div>
					{/each}
				</div>
				<span class="absolute right-0.5 bottom-0 text-[9px] leading-none font-medium text-white/70">
					{i + 1}
				</span>
			</button>
		{/each}

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Button variant="ghost" size="icon" onclick={() => editor.clearAll()} title="Clear All">
			<Trash2 class="h-4 w-4" />
		</Button>
	</nav>
</div>
