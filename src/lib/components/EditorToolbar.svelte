<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Pencil, MousePointer2, Trash2 } from '@lucide/svelte';

	const editor = getEditorContext();
</script>

<div class="fixed bottom-8 left-1/2 z-50 -translate-x-1/2">
	<nav class="flex flex-row items-center gap-2 rounded-lg border bg-background p-2 shadow-lg">
		<Button
			variant={editor.mode === 'draw' ? 'default' : 'ghost'}
			size="icon"
			onclick={() => (editor.mode = 'draw')}
			title="Draw Mode"
		>
			<Pencil class="h-4 w-4" />
		</Button>

		<Button
			variant={editor.mode === 'select' ? 'default' : 'ghost'}
			size="icon"
			onclick={() => (editor.mode = 'select')}
			title="Select Mode"
		>
			<MousePointer2 class="h-4 w-4" />
		</Button>

		<Button variant="ghost" size="icon" onclick={() => editor.clearAll()} title="Clear All">
			<Trash2 class="h-4 w-4" />
		</Button>
	</nav>
</div>
