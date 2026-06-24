<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import type { DrawStyle } from '$lib/modes/types';
	import { LANE_COLORS, LANE_TEMPLATES, getTotalWidth } from '$lib/core/lane-template';
	import { Button } from '$lib/components/ui/button';
	import {
		Combine,
		MousePointer2,
		Redo2,
		Scissors,
		Slash,
		Spline,
		Undo2,
		Tractor,
		Waves
	} from '@lucide/svelte';

	const editor = getEditorContext();

	const maxPresetWidth = Math.max(...LANE_TEMPLATES.map((t) => getTotalWidth(t.lanes)));

	const DRAW_STYLES: { id: DrawStyle; label: string; icon: typeof Slash }[] = [
		{ id: 'straight', label: 'Straight', icon: Slash },
		{ id: 'curved', label: 'Curved (start, apex, end)', icon: Spline },
		{ id: 'smooth', label: 'Smooth (tangent-continuous)', icon: Waves }
	];

	// Toolbar buttons return focus to the page after acting, so mode keys
	// (Escape, Tab, Delete) and shortcuts keep working right after a click —
	// the keydown guards only pass events targeted at <body>.
	function press(action: () => void) {
		return (event: MouseEvent) => {
			action();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) target.blur();
		};
	}

	function activatePreset(templateId: string) {
		editor.currentLaneTemplateId = templateId;
		editor.mode = 'draw';
	}

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
			activatePreset(template.id);
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="fixed bottom-8 left-1/2 z-50 -translate-x-1/2">
	<nav class="flex flex-row items-center gap-2 rounded-lg border bg-background p-2 shadow-lg">
		<Button
			variant={editor.mode === 'select' ? 'default' : 'ghost'}
			size="icon"
			onclick={press(() => (editor.mode = 'select'))}
			title="Select"
			aria-pressed={editor.mode === 'select'}
		>
			<MousePointer2 class="h-4 w-4" />
		</Button>

		<div class="mx-1 h-6 w-px bg-border"></div>

		{#each LANE_TEMPLATES as template, i (template.id)}
			{@const totalWidth = getTotalWidth(template.lanes)}
			{@const active = editor.mode === 'draw' && editor.currentLaneTemplateId === template.id}
			<button
				class="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border-2 transition-colors {active
					? 'border-foreground'
					: 'border-border hover:border-muted-foreground'}"
				style="background-color: {LANE_COLORS.grass};"
				aria-label={template.name}
				aria-pressed={active}
				title="Draw {template.name} — {totalWidth}m (key {i + 1})"
				onclick={press(() => activatePreset(template.id))}
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

		{#if editor.mode === 'draw'}
			<div class="mx-1 h-6 w-px bg-border"></div>

			{#each DRAW_STYLES as style (style.id)}
				<Button
					variant={editor.drawStyle === style.id ? 'default' : 'ghost'}
					size="icon"
					onclick={press(() => (editor.drawStyle = style.id))}
					title="{style.label} (Tab cycles)"
					aria-pressed={editor.drawStyle === style.id}
				>
					<style.icon class="h-4 w-4" />
				</Button>
			{/each}
		{/if}

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Button
			variant="ghost"
			size="icon"
			disabled={!editor.canUndo}
			onclick={press(() => editor.undo())}
			title="Undo (⌘Z)"
		>
			<Undo2 class="h-4 w-4" />
		</Button>
		<Button
			variant="ghost"
			size="icon"
			disabled={!editor.canRedo}
			onclick={press(() => editor.redo())}
			title="Redo (⇧⌘Z)"
		>
			<Redo2 class="h-4 w-4" />
		</Button>

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Button
			variant={editor.mode === 'split' ? 'default' : 'ghost'}
			size="icon"
			onclick={press(() => (editor.mode = 'split'))}
			title="Split (click a road to cut it at that point)"
			aria-pressed={editor.mode === 'split'}
		>
			<Scissors class="h-4 w-4" />
		</Button>

		{#if editor.joinableNodeId}
			<Button
				variant="ghost"
				size="icon"
				onclick={press(() => editor.joinNode(editor.joinableNodeId!))}
				title="Join — dissolve this node back into one road"
			>
				<Combine class="h-4 w-4" />
			</Button>
		{/if}

		<Button
			variant={editor.mode === 'bulldoze' ? 'default' : 'ghost'}
			size="icon"
			onclick={press(() => (editor.mode = 'bulldoze'))}
			title="Bulldoze (click or drag to demolish)"
			aria-pressed={editor.mode === 'bulldoze'}
		>
			<Tractor class="h-4 w-4" />
		</Button>
	</nav>
</div>
