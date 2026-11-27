<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { cycleControl } from '$lib/modes/connector';
	import { placeBadges } from './badge-layout';

	// In the lane connector: a badge beside each approach saying how its
	// traffic is controlled. Clicking it steps through none, stop, yield and
	// signal. The same badge on a footpath's crossing over a car road, opened
	// by double-clicking its zebra, or on each crossing a selected road is
	// part of or lies across (Editor.crossingBadges), laid out on screen so no
	// two overlap at any zoom (badge-layout.ts).
	const editor = getEditorContext();

	const LOOK = {
		none: { text: 'Go', title: 'No control: traffic goes on', cls: 'bg-white text-neutral-800' },
		stop: { text: 'Stop', title: 'Stop sign', cls: 'bg-red-600 text-white' },
		yield: { text: 'Yield', title: 'Yield', cls: 'bg-amber-400 text-neutral-900' },
		signal: { text: 'Signal', title: 'Traffic signals', cls: 'bg-emerald-600 text-white' }
	};

	let placed = $state<{ key: string; x: number; y: number }[]>([]);
	// Each crossing's button where it stands on screen, and the middle of its
	// crossing it belongs to (`from`), which it is tied to where it stands
	// apart from it.
	let crossingsAt = $state<{ id: string; x: number; y: number; from: { x: number; y: number } }[]>(
		[]
	);
	// The buttons as shown, measured for their size on screen.
	const shownApproach: Record<string, HTMLElement> = {};
	const shownCrossing: Record<string, HTMLElement> = {};
	// A button not yet shown is taken to be this size.
	const SIZE = { width: 48, height: 20 };
	const sizeOf = (el: HTMLElement | undefined) =>
		el?.offsetWidth ? { width: el.offsetWidth, height: el.offsetHeight } : SIZE;
	// A button standing further than this from its crossing's middle (px) is
	// tied to it by a line.
	const TIED = 3;
	// The crossing whose button the click in hand has stepped, until a press
	// anywhere begins another (its `detail` 1).
	let stepped: string | null = null;

	// A crossing's button steps its control on each click, quick ones
	// included. One click steps nothing: the second of a double-click on a
	// zebra, landing on the button its first put under the pointer by
	// selecting the road. That opens the badge alone, as a double-click
	// anywhere else on the zebra does.
	function pressCrossing(id: string, detail: number) {
		if (detail > 1 && stepped !== id && editor.opened !== id) {
			editor.openCrossing(id);
			return;
		}
		editor.cycleCrossing(id);
		stepped = id;
	}

	$effect(() => {
		let raf = 0;
		const update = () => {
			raf = requestAnimationFrame(update);
			const scene = editor.sceneManager;
			const crossings = editor.crossingBadges;
			const approaches = editor.controlBadges;
			if (scene && approaches.length)
				placed = approaches.map((b) => ({ key: b.key, ...scene.worldToScreen(b.x, b.y) }));
			else if (placed.length) placed = [];
			// The crossings' buttons are laid out on screen, clear of one
			// another and of the approaches', and within the map's view
			// (badge-layout.ts).
			if (scene && crossings.length) {
				const rect = scene.getCanvas().getBoundingClientRect();
				const at = placeBadges(
					crossings.map((b) => ({
						at: scene.worldToScreen(b.x, b.y),
						...sizeOf(shownCrossing[b.id])
					})),
					placed.map((p) => ({ x: p.x, y: p.y, ...sizeOf(shownApproach[p.key]) })),
					{ x0: rect.left, y0: rect.top, x1: rect.right, y1: rect.bottom }
				);
				crossingsAt = crossings.map((b, k) => ({
					id: b.id,
					...at[k],
					from: scene.worldToScreen(b.x, b.y)
				}));
			} else if (crossingsAt.length) crossingsAt = [];
		};
		update();
		return () => cancelAnimationFrame(raf);
	});
</script>

<svelte:window
	onmousedowncapture={(event) => {
		if (event.detail === 1) stepped = null;
	}}
/>

{#each editor.controlBadges as badge (badge.key)}
	{@const at = placed.find((p) => p.key === badge.key)}
	{#if at}
		<button
			bind:this={shownApproach[badge.key]}
			type="button"
			class="fixed z-40 -translate-x-1/2 -translate-y-1/2 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow ring-1 ring-black/30 {LOOK[
				badge.control
			].cls}"
			style="left:{at.x}px;top:{at.y}px"
			title="{LOOK[badge.control].title} (click to change)"
			aria-label="Approach control: {LOOK[badge.control].title}"
			onclick={(event) => {
				// Keys go back to the map (Escape leaves the connector).
				event.currentTarget.blur();
				cycleControl(editor, badge.key);
			}}
		>
			{LOOK[badge.control].text}
		</button>
	{/if}
{/each}

{#each editor.crossingBadges as badge (badge.id)}
	{@const at = crossingsAt.find((p) => p.id === badge.id)}
	{@const look = LOOK[badge.control]}
	{#if at}
		{#if Math.hypot(at.x - at.from.x, at.y - at.from.y) > TIED}
			<svg class="pointer-events-none fixed inset-0 z-30 h-full w-full" aria-hidden="true">
				<line
					data-tie={badge.id}
					x1={at.from.x}
					y1={at.from.y}
					x2={at.x}
					y2={at.y}
					class="stroke-neutral-900/70"
					stroke-width="1.5"
				/>
				<circle cx={at.from.x} cy={at.from.y} r="2.5" class="fill-neutral-900/70" />
			</svg>
		{/if}
		<button
			bind:this={shownCrossing[badge.id]}
			type="button"
			class="fixed z-40 -translate-x-1/2 -translate-y-1/2 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow ring-1 ring-black/30 {look.cls}"
			style="left:{at.x}px;top:{at.y}px"
			title="{look.title} (click to change)"
			aria-label="Crossing control: {look.title}"
			data-crossing={badge.id}
			onclick={(event) => {
				// Keys go back to the map (Escape closes the badge).
				event.currentTarget.blur();
				pressCrossing(badge.id, event.detail);
			}}
		>
			{look.text}
		</button>
	{/if}
{/each}
