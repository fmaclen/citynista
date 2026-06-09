<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { LANE_TEMPLATES, getLaneTemplate } from '$lib/core/lane-template';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import { Pencil, MousePointer2, Trash2, Columns3 } from '@lucide/svelte';

	const editor = getEditorContext();

	const currentTemplate = $derived(getLaneTemplate(editor.currentLaneTemplateId));
	const editableSegmentId = $derived(
		editor.selectedSegments.size === 1 ? [...editor.selectedSegments][0] : undefined
	);
</script>

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

		<Select.Root
			type="single"
			value={editor.currentLaneTemplateId}
			onValueChange={(value) => {
				if (value) editor.currentLaneTemplateId = value;
			}}
		>
			<Select.Trigger class="w-28" size="sm">
				{currentTemplate?.name ?? 'Road Type'}
			</Select.Trigger>
			<Select.Content>
				{#each LANE_TEMPLATES as template (template.id)}
					<Select.Item value={template.id} label={template.name} />
				{/each}
			</Select.Content>
		</Select.Root>

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Button
			variant="ghost"
			size="icon"
			disabled={!editableSegmentId}
			onclick={() => editableSegmentId && editor.openLaneEditor(editableSegmentId)}
			title="Edit Lanes"
		>
			<Columns3 class="h-4 w-4" />
		</Button>

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Button variant="ghost" size="icon" onclick={() => editor.clearAll()} title="Clear All">
			<Trash2 class="h-4 w-4" />
		</Button>
	</nav>
</div>
