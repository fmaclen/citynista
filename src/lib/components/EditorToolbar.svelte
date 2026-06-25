<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { getTotalWidth, laneSwatchColor } from '$lib/core/lane-template';
	import { MATERIAL_COLOR } from '$lib/core/lane-types';
	import { Button } from '$lib/components/ui/button';
	import {
		Combine,
		Plus,
		Redo2,
		Scissors,
		Undo2,
		Tractor,
	} from '@lucide/svelte';

	const editor = getEditorContext();

	const maxBrushWidth = $derived(
		Math.max(1, ...editor.hotbar.flatMap((b) => (b ? [getTotalWidth(b.lanes)] : [])))
	);

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

		editor.activateSlot(index);
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		editor.cycleBrush(event.deltaY > 0 ? 1 : -1);
	}

	function removeSlot(event: MouseEvent, index: number) {
		event.preventDefault();
		editor.clearSlot(index);
		const target = event.currentTarget;
		if (target instanceof HTMLElement) target.blur();
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="fixed bottom-8 left-1/2 z-50 -translate-x-1/2">
	<nav
		class="flex flex-row items-center gap-2 rounded-lg border bg-background p-2 shadow-lg"
		onwheel={onWheel}
	>
		{#each editor.hotbar as brush, i (i)}
			{@const active = editor.mode === 'draw' && editor.activeSlot === i}
			{@const holding = editor.pickableLanes !== null}
			<button
				class="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border-2 transition-colors {active
					? 'border-foreground'
					: 'border-border hover:border-muted-foreground'}"
				style={brush ? `background-color: ${MATERIAL_COLOR.grass};` : ''}
				aria-label={brush ? brush.name : `Empty slot ${i + 1}`}
				aria-pressed={active}
				title={brush
					? holding
						? `Replace slot ${i + 1} with the selected road`
						: `Draw ${brush.name} — ${getTotalWidth(brush.lanes)}m (key ${i + 1}) · right-click to remove`
					: holding
						? `Put the selected road in slot ${i + 1}`
						: `Empty slot ${i + 1}`}
				onclick={press(() => (holding ? editor.pickIntoSlot(i) : editor.activateSlot(i)))}
				oncontextmenu={(event) => removeSlot(event, i)}
			>
				{#if brush}
					<div
						class="absolute inset-y-0 left-1/2 flex -translate-x-1/2"
						style="width: {(getTotalWidth(brush.lanes) / maxBrushWidth) * 100}%;"
					>
						{#each brush.lanes as lane, j (j)}
							<div
								class="h-full"
								style="width: {(lane.width / getTotalWidth(brush.lanes)) *
									100}%; background-color: {laneSwatchColor(lane)};"
							></div>
						{/each}
					</div>
				{/if}
				{#if holding}
					<div class="absolute inset-0 flex items-center justify-center bg-background/50">
						<Plus class="h-4 w-4 text-foreground" />
					</div>
				{/if}
			</button>
		{/each}

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
