<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';

	const editor = getEditorContext();

	let labels = $state<{ id: string; text: string; x: number; y: number }[]>([]);

	$effect(() => {
		let raf = 0;
		const update = () => {
			raf = requestAnimationFrame(update);
			const scene = editor.sceneManager;
			if (!scene) {
				if (labels.length > 0) labels = [];
				return;
			}
			const next: { id: string; text: string; x: number; y: number }[] = [];
			for (const node of editor.graph.nodes.values()) {
				if (!node.label) continue;
				const screen = scene.worldToScreen(node.x, node.y);
				next.push({ id: node.id, text: node.label, x: screen.x, y: screen.y });
			}
			labels = next;
		};
		update();
		return () => cancelAnimationFrame(raf);
	});
</script>

{#each labels as l (l.id)}
	<div
		class="pointer-events-none fixed z-40 -translate-x-1/2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-white shadow"
		style="left:{l.x}px;top:{l.y - 28}px"
	>
		{l.text}
	</div>
{/each}
