<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { getTotalWidth, laneSwatchColor } from '$lib/core/lane-template';
	import type { Lane, LaneMaterial, LaneRole } from '$lib/core/types';
	import { HOVER_COLOR } from '$lib/rendering/editor-palette';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { ArrowLeft, ArrowRight, Copy, GripVertical, Plus, Trash2, X } from '@lucide/svelte';
	import { slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';

	const editor = getEditorContext();

	// Selected roads or the armed preset slot; the panel edits either the same
	// way through editor.editLanes. Roads with different cross-sections are 'mixed'.
	const source = $derived(editor.laneSource);
	const lanes = $derived(source && source !== 'mixed' ? source.lanes : []);

	const ROLE_OPTIONS: { value: LaneRole; label: string }[] = [
		{ value: 'vehicle', label: 'Vehicle' },
		{ value: 'pedestrian', label: 'Pedestrian' },
		{ value: 'buffer', label: 'Buffer' }
	];

	const MATERIAL_OPTIONS: { value: LaneMaterial; label: string }[] = [
		{ value: 'asphalt', label: 'Asphalt' },
		{ value: 'concrete', label: 'Concrete' },
		{ value: 'grass', label: 'Grass' },
		{ value: 'dirt', label: 'Dirt' }
	];

	const MIN_LANE_WIDTH = 0.5;
	const MAX_LANE_WIDTH = 30;

	function setRole(index: number, value: string) {
		const option = ROLE_OPTIONS.find((o) => o.value === value);
		if (!option) return;
		if (lanes[index]?.role === option.value) return;

		editor.editLanes((lanes) => {
			lanes[index].role = option.value;
			lanes[index].direction = option.value === 'vehicle' ? 'forward' : 'bidirectional';
		});
	}

	function setMaterial(index: number, value: string) {
		const lane = lanes[index];
		if (!lane) return;
		const option = MATERIAL_OPTIONS.find((o) => o.value === value);
		if (!option) return;
		if (lane.material === option.value) return;

		editor.editLanes((lanes) => (lanes[index].material = option.value));
	}

	function setWidth(index: number, value: string) {
		const width = parseFloat(value);
		if (isNaN(width)) return;

		editor.editLanes(
			(lanes) => (lanes[index].width = Math.min(MAX_LANE_WIDTH, Math.max(MIN_LANE_WIDTH, width)))
		);
	}

	function flipDirection(index: number) {
		const direction = lanes[index]?.direction === 'forward' ? 'backward' : 'forward';
		editor.editLanes((lanes) => (lanes[index].direction = direction));
	}

	// Reordering by the grip: pointer events, not HTML drag-and-drop, so the
	// dragged row can turn into the drop slot without cancelling the drag. A
	// copy of the row follows the pointer; the row itself becomes an empty
	// dashed slot that the other rows flip around, at the row the pointer is
	// over. Nothing changes until the drop: released outside the list, or on
	// Escape, the lane goes back where it was.
	const DRAG_START_PX = 4;
	let drag = $state<{ from: number; to: number } | null>(null);
	const shown = $derived(drag ? moved(lanes, drag.from, drag.to) : lanes);

	let grabbed: {
		from: number;
		startY: number;
		grip: HTMLElement;
		row: HTMLElement;
		list: HTMLElement;
		pointerId: number;
	} | null = null;
	// Each row's place in the list (its gap included), taken at the grab:
	// rows are one height, so the slot at index k is where row k was.
	let places: { top: number; bottom: number }[] = [];
	let floating: HTMLElement | null = null;

	function moved<T>(list: T[], from: number, to: number) {
		const out = [...list];
		out.splice(to, 0, ...out.splice(from, 1));
		return out;
	}

	function grab(event: PointerEvent, index: number) {
		const grip = event.currentTarget;
		if (event.button !== 0 || !(grip instanceof HTMLElement)) return;
		const row = grip.closest<HTMLElement>('[role="listitem"]');
		const list = row?.parentElement?.parentElement;
		if (!row || !list) return;
		event.preventDefault();
		grabbed = { from: index, startY: event.clientY, grip, row, list, pointerId: event.pointerId };
		places = [...list.querySelectorAll<HTMLElement>(':scope > [data-lane]')].map((item) => {
			const rect = item.getBoundingClientRect();
			return { top: rect.top, bottom: rect.bottom };
		});
		// On the window, not captured by the grip: reordering the rows moves
		// the grip's node, which drops a pointer capture.
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', drop);
		window.addEventListener('pointercancel', release);
		window.addEventListener('keydown', escape, true);
	}

	function move(event: PointerEvent) {
		if (!grabbed || event.pointerId !== grabbed.pointerId) return;
		const dy = event.clientY - grabbed.startY;
		if (!drag) {
			if (Math.abs(dy) < DRAG_START_PX) return;
			drag = { from: grabbed.from, to: grabbed.from };
			editor.highlightLane(null);
			floating = lift(grabbed.row, grabbed.list);
		}
		if (floating) floating.style.transform = `translateY(${dy}px)`;
		drag.to = dropIndex(event) ?? grabbed.from;
	}

	// The row under the pointer, or null with the pointer off the list.
	function dropIndex(event: PointerEvent) {
		if (!grabbed || places.length === 0) return null;
		const box = grabbed.list.getBoundingClientRect();
		const { clientX: x, clientY: y } = event;
		if (x < box.left || x > box.right) return null;
		if (y < places[0].top || y > places[places.length - 1].bottom) return null;
		const index = places.findIndex((place) => y <= place.bottom);
		return index === -1 ? places.length - 1 : index;
	}

	function drop(event: PointerEvent) {
		if (!grabbed || event.pointerId !== grabbed.pointerId) return;
		if (drag) {
			const { from } = drag;
			const to = dropIndex(event);
			if (to !== null && to !== from)
				editor.editLanes((lanes) => lanes.splice(to, 0, ...lanes.splice(from, 1)));
		}
		release();
	}

	function escape(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		// Before the editor's own Escape, which would close the panel.
		event.preventDefault();
		event.stopImmediatePropagation();
		release();
	}

	function release() {
		if (!grabbed) return;
		const { grip } = grabbed;
		grabbed = null;
		drag = null;
		floating?.remove();
		floating = null;
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', drop);
		window.removeEventListener('pointercancel', release);
		window.removeEventListener('keydown', escape, true);
		grip.blur();
	}

	$effect(() => release);

	// A static copy of the row, floated over the page where the row is. Rows
	// line up on their list's columns, so the copy takes the list's track sizes.
	function lift(row: HTMLElement, list: HTMLElement) {
		const copy = row.cloneNode(true);
		if (!(copy instanceof HTMLElement)) return null;
		const box = row.getBoundingClientRect();
		const grid = getComputedStyle(list);
		copy.removeAttribute('role');
		copy.setAttribute('aria-hidden', 'true');
		copy.inert = true;
		copy.classList.add('bg-background', 'shadow-lg', 'ring-1', 'ring-border');
		Object.assign(copy.style, {
			position: 'fixed',
			left: `${box.left}px`,
			top: `${box.top}px`,
			width: `${box.width}px`,
			gridTemplateColumns: grid.gridTemplateColumns,
			columnGap: grid.columnGap,
			backgroundColor: '',
			pointerEvents: 'none',
			zIndex: '50'
		});
		document.body.append(copy);
		return copy;
	}

	// The row of a lane just removed slides closed; rows that go any other
	// way (undo, a different selection) just go.
	let removed = $state<Lane | null>(null);

	function removeLane(index: number) {
		if (lanes.length <= 1) return;
		removed = lanes[index];
		editor.editLanes((lanes) => lanes.splice(index, 1));
	}

	// The row a lane was just added at slides open; rows that appear any other
	// way (undo, a different selection) just show.
	let addedAt = $state<number | null>(null);

	// A new lane is a 3.5 m asphalt travel lane at the given row; the user
	// sets the rest from there.
	function insertLane(index: number) {
		addedAt = index;
		editor.editLanes((lanes) =>
			lanes.splice(index, 0, {
				role: 'vehicle',
				material: 'asphalt',
				width: 3.5,
				direction: 'forward'
			})
		);
	}

	// The copy lands directly below the original, the same in every field.
	function copyLane(index: number) {
		addedAt = index + 1;
		editor.editLanes((lanes) => lanes.splice(index + 1, 0, { ...lanes[index] }));
	}

	// Panel buttons hand focus back to the page after acting: shortcuts only
	// fire on events targeted at <body>. Width fields keep focus while typed in.
	function press(action: () => void) {
		return (event: MouseEvent) => {
			action();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) target.blur();
		};
	}

	// The same for a dropdown once its menu has closed.
	function menuClosed(open: boolean) {
		const focused = document.activeElement;
		if (!open && focused instanceof HTMLElement) focused.blur();
	}

	function hover(index: number | null) {
		if (!drag) editor.highlightLane(index);
	}

	const totalWidth = $derived(getTotalWidth(lanes));

	// A strip piece grows from nothing as its lane is added; the others give
	// way through their width transition.
	function grow(node: HTMLElement, { duration }: { duration: number }) {
		const width = parseFloat(node.style.width);
		return { duration, easing: cubicOut, css: (t: number) => `width: ${t * width}%` };
	}

	// The hovered lane is tinted as the map tints it (selection-renderer.ts):
	// the hover cyan, faint behind a row's controls, stronger over its swatch.
	const hoverTint = (alpha: number) =>
		`rgb(${(HOVER_COLOR >> 16) & 255} ${(HOVER_COLOR >> 8) & 255} ${HOVER_COLOR & 255} / ${alpha})`;
	const ROW_TINT = hoverTint(0.25);
	const STRIP_TINT = hoverTint(0.55);
	const MOVE_MS = 150;

	// Icon buttons rest muted and darken under the pointer.
	const ICON_BUTTON =
		'size-7 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground';
</script>

<!-- The strip above each row: hovered a moment, a faint
     line with a + fades in, and a click inserts a lane there. -->
{#snippet gap(index: number)}
	<button
		class="group relative col-span-full h-2"
		onclick={press(() => insertLane(index))}
		title="Insert a lane here"
		aria-label="Insert a lane here"
	>
		<span
			class="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:delay-150"
		>
			<span class="h-px flex-1 bg-muted-foreground/30"></span>
			<span
				class="flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground"
			>
				<Plus class="size-3" />
			</span>
			<span class="h-px flex-1 bg-muted-foreground/30"></span>
		</span>
	</button>
{/snippet}

{#if source}
	<aside
		class="fixed top-4 right-4 z-40 flex max-h-[calc(100vh-2rem)] w-[31rem] max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-x-hidden overflow-y-auto rounded-lg border bg-background p-4 shadow-lg"
	>
		<div class="flex h-7 items-center justify-between">
			<h2 class="text-sm font-semibold">Lane editor</h2>
			<Button
				variant="ghost"
				size="icon"
				class="-mr-1.5 {ICON_BUTTON}"
				onclick={() => editor.closeLanes()}
				title="Close"
			>
				<X class="size-4" />
			</Button>
		</div>

		{#if source === 'mixed'}
			<p class="text-xs text-muted-foreground">The selected roads have different lanes.</p>
		{:else}
			{#if lanes.length > 0}
				<div
					class="flex h-6 w-full shrink-0 overflow-hidden rounded-md border border-border"
					title="Cross-section preview"
				>
					{#each shown as lane, i (lane)}
						<div
							class="relative flex h-full shrink-0 items-center justify-center overflow-hidden text-[10px] text-white/70 transition-[width] duration-150 ease-out"
							style="width: {(lane.width / totalWidth) * 100}%; background-color: {laneSwatchColor(
								lane
							)};"
							role="presentation"
							in:grow={{ duration: i === addedAt ? MOVE_MS : 0 }}
							onmouseenter={() => hover(i)}
							onmouseleave={() => hover(null)}
						>
							<span
								class="pointer-events-none absolute inset-0 transition-opacity duration-100 {editor.highlightedLane ===
								i
									? 'opacity-100'
									: 'opacity-0'}"
								style="background-color: {STRIP_TINT};"
							></span>
							<span class="relative">{lane.width}</span>
						</div>
					{/each}
				</div>

				<div
					class="-mt-2 grid grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto_auto] gap-x-1.5"
				>
					{#each shown as lane, i (lane)}
						{@const slot = drag !== null && drag.to === i}
						<div
							class="col-span-full grid grid-cols-subgrid"
							data-lane
							animate:flip={{ duration: MOVE_MS, easing: cubicOut }}
							in:slide={{ duration: i === addedAt ? MOVE_MS : 0 }}
							out:slide={{ duration: lane === removed ? MOVE_MS : 0 }}
							onintroend={() => (addedAt = null)}
						>
							{@render gap(i)}
							<div
								class="col-span-full grid grid-cols-subgrid items-center rounded-md transition-colors duration-100 {slot
									? 'outline-2 -outline-offset-2 outline-muted-foreground/40 outline-dashed *:invisible'
									: ''}"
								style:background-color={!slot && editor.highlightedLane === i ? ROW_TINT : null}
								role="listitem"
								data-drop-slot={slot ? '' : undefined}
								onmouseenter={() => hover(i)}
								onmouseleave={() => hover(null)}
							>
								<button
									class="flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
									onpointerdown={(e) => grab(e, i)}
									title="Drag to reorder"
									aria-label="Drag to reorder"
								>
									<GripVertical class="size-4" />
								</button>

								<div
									class="h-6 w-3 shrink-0 rounded-sm"
									style="background-color: {laneSwatchColor(lane)};"
								></div>

								<Select.Root
									type="single"
									value={lane.role}
									onValueChange={(v) => setRole(i, v)}
									onOpenChangeComplete={menuClosed}
								>
									<Select.Trigger class="w-full" size="sm">
										<span class="truncate"
											>{ROLE_OPTIONS.find((o) => o.value === lane.role)?.label}</span
										>
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
									onOpenChangeComplete={menuClosed}
								>
									<Select.Trigger class="w-full" size="sm">
										<span class="truncate"
											>{MATERIAL_OPTIONS.find((o) => o.value === lane.material)?.label}</span
										>
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
										class={ICON_BUTTON}
										onclick={press(() => flipDirection(i))}
										title="Direction of travel (relative to drawing direction)"
									>
										{#if lane.direction === 'forward'}
											<ArrowRight class="size-4" />
										{:else}
											<ArrowLeft class="size-4" />
										{/if}
									</Button>
								{:else}
									<div class="size-7 shrink-0"></div>
								{/if}

								<Button
									variant="ghost"
									size="icon"
									class={ICON_BUTTON}
									onclick={press(() => copyLane(i))}
									title="Copy lane"
								>
									<Copy class="size-4" />
								</Button>

								<Button
									variant="ghost"
									size="icon"
									class={ICON_BUTTON}
									disabled={lanes.length <= 1}
									onclick={press(() => removeLane(i))}
									title="Remove lane"
								>
									<Trash2 class="size-4" />
								</Button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<div class="flex items-center justify-between">
				<Button variant="outline" size="sm" onclick={press(() => insertLane(lanes.length))}>
					<Plus class="size-4" />
					Add lane
				</Button>
				<span class="text-xs text-muted-foreground">{totalWidth}m total</span>
			</div>
		{/if}
	</aside>
{/if}
