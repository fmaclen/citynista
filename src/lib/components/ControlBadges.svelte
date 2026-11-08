<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';

	// In the lane connector: a badge beside each approach saying how its
	// traffic is controlled. Clicking it steps through none, stop, yield and
	// signal.
	const editor = getEditorContext();

	const LOOK = {
		none: { text: 'Go', title: 'No control: traffic goes on', cls: 'bg-white text-neutral-800' },
		stop: { text: 'Stop', title: 'Stop sign', cls: 'bg-red-600 text-white' },
		yield: { text: 'Yield', title: 'Yield', cls: 'bg-amber-400 text-neutral-900' },
		signal: { text: 'Signal', title: 'Traffic signals', cls: 'bg-emerald-600 text-white' }
	};

	let placed = $state<{ key: string; x: number; y: number }[]>([]);

	$effect(() => {
		let raf = 0;
		const update = () => {
			raf = requestAnimationFrame(update);
			const scene = editor.sceneManager;
			if (!scene || editor.controlBadges.length === 0) {
				if (placed.length) placed = [];
				return;
			}
			placed = editor.controlBadges.map((b) => ({ key: b.key, ...scene.worldToScreen(b.x, b.y) }));
		};
		update();
		return () => cancelAnimationFrame(raf);
	});
</script>

{#each editor.controlBadges as badge (badge.key)}
	{@const at = placed.find((p) => p.key === badge.key)}
	{#if at}
		<button
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
				editor.cycleControl(badge.key);
			}}
		>
			{LOOK[badge.control].text}
		</button>
	{/if}
{/each}
