<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';

	const editor = getEditorContext();
</script>

<div
	class="pointer-events-none fixed top-3 left-3 z-50 rounded bg-black/40 px-2 py-1 font-mono text-xs text-white/80"
>
	{editor.fps} FPS
</div>
