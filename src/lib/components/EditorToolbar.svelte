<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { getTotalWidth, laneSwatchColor } from '$lib/core/lane-template';
	import type { Lane } from '$lib/core/types';
	import { labLane } from '$lib/core/place';
	import { rowMarks } from '$lib/lab/road';
	import { COLOURS } from '$lib/lab/scene';
	import { Button } from '$lib/components/ui/button';
	import {
		Circle,
		Combine,
		Grid3x3,
		Plus,
		Redo2,
		Route,
		Scissors,
		Slash,
		Spline,
		Undo2,
		Tractor
	} from '@lucide/svelte';
	import type { DrawStyle } from '$lib/modes/types';

	const editor = getEditorContext();

	const maxBrushWidth = $derived(
		Math.max(1, ...editor.hotbar.flatMap((b) => (b ? [getTotalWidth(b.lanes)] : [])))
	);

	// The paint a preset's thumbnail shows: the road's own rule (rowMarks) run
	// over the preset's lanes laid side by side, each line placed as a
	// fraction of the preset's width. A line at the preset's outer edge is
	// held 2 px in, or a white edge line would vanish into the toolbar.
	function paint(lanes: Lane[]) {
		const total = getTotalWidth(lanes);
		let left = 0;
		const spans = lanes.map((lane, i) => {
			const span = { lane: labLane(lane, `l${i}`), left, right: left + lane.width };
			left = span.right;
			return span;
		});
		return rowMarks(spans).map((mark) => ({ ...mark, at: (mark.o / total) * 100 }));
	}
	const DASHES = (colour: string) =>
		`repeating-linear-gradient(${colour} 0 4px, transparent 4px 8px)`;

	const STYLES: { style: DrawStyle; label: string; title: string; icon: typeof Circle }[] = [
		{
			style: 'straight',
			label: 'Straight',
			title: 'Straight roads, end to end (Tab)',
			icon: Slash
		},
		{
			style: 'curve',
			label: 'Curve',
			title: 'Curve on from the road you continue; F flips the curve (Tab)',
			icon: Spline
		},
		{
			style: 'circle',
			label: 'Circle',
			title: 'Circle: click the centre, then the radius; F flips the direction (Tab)',
			icon: Circle
		}
	];
	// The style strip shows only while a preset is armed.
	const armed = $derived(
		(editor.mode === 'draw' || editor.mode === 'circle') && !!editor.activeBrush
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

		// While drawing, Delete empties the armed slot.
		if (
			(event.key === 'Delete' || event.key === 'Backspace') &&
			editor.mode === 'draw' &&
			!editor.continuationBrush
		) {
			event.preventDefault();
			editor.clearSlot(editor.activeSlot);
			return;
		}

		// Tab cycles the draw style while a preset is armed. Modified Tabs
		// keep the browser's meaning, and so does a Tab from a focused control.
		if (
			event.key === 'Tab' &&
			armed &&
			target instanceof HTMLElement &&
			target.tagName === 'BODY' &&
			!event.shiftKey &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			editor.cycleDrawStyle();
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
	{#if armed}
		<nav
			class="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 flex-row items-center gap-1 rounded-lg border bg-background p-1 shadow-lg"
			aria-label="Draw style"
		>
			{#each STYLES as { style, label, title, icon: Icon } (style)}
				<Button
					variant={editor.drawStyle === style ? 'default' : 'ghost'}
					size="sm"
					onclick={press(() => editor.setDrawStyle(style))}
					{title}
					aria-pressed={editor.drawStyle === style}
				>
					<Icon class="h-4 w-4" />
					{label}
				</Button>
			{/each}
		</nav>
	{/if}
	<nav
		class="flex flex-row items-center gap-2 rounded-lg border bg-background p-2 shadow-lg"
		onwheel={onWheel}
	>
		{#each editor.hotbar as brush, i (i)}
			{@const active =
				(editor.mode === 'draw' || editor.mode === 'circle') && editor.activeSlot === i}
			{@const holding = editor.pickableLanes !== null}
			<button
				class="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border-2 transition-colors {active
					? 'border-foreground'
					: 'border-border hover:border-muted-foreground'}"
				aria-label={brush ? brush.name : `Empty slot ${i + 1}`}
				aria-pressed={active}
				title={brush
					? holding
						? `Replace slot ${i + 1} with the selected road`
						: `Draw ${brush.name} — ${getTotalWidth(brush.lanes)}m (key ${i + 1}) · right-click to remove`
					: holding
						? `Put the selected road in slot ${i + 1}`
						: `Empty slot ${i + 1} · click to design a preset`}
				onclick={press(() => (holding ? editor.pickIntoSlot(i) : editor.activateSlot(i)))}
				oncontextmenu={(event) => removeSlot(event, i)}
			>
				{#if brush}
					<div
						class="absolute inset-y-0 left-1/2 flex -translate-x-1/2"
						style="width: {Math.max(40, (getTotalWidth(brush.lanes) / maxBrushWidth) * 100)}%;"
					>
						{#each brush.lanes as lane, j (j)}
							<div
								class="h-full"
								style="width: {(lane.width / getTotalWidth(brush.lanes)) *
									100}%; background-color: {laneSwatchColor(lane)};"
							></div>
						{/each}
						{#each paint(brush.lanes) as mark, j (j)}
							<div
								class="absolute inset-y-0 w-px -translate-x-1/2"
								style="left: clamp(2px, {mark.at}%, calc(100% - 2px)); background: {mark.dashed
									? DASHES(COLOURS[mark.colour])
									: COLOURS[mark.colour]};"
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
			variant={editor.gridEnabled ? 'default' : 'ghost'}
			size="icon"
			onclick={press(() => editor.toggleGrid())}
			title="Toggle snapping grid"
			aria-pressed={editor.gridEnabled}
		>
			<Grid3x3 class="h-4 w-4" />
		</Button>

		<Button
			variant={editor.showConnections ? 'default' : 'ghost'}
			size="icon"
			onclick={press(() => editor.toggleConnections())}
			title="Show lane connections"
			aria-pressed={editor.showConnections}
		>
			<Route class="h-4 w-4" />
		</Button>

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
