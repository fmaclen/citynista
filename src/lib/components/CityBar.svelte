<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Plus, Trash2 } from '@lucide/svelte';

	const editor = getEditorContext();

	let newOpen = $state(false);
	let newName = $state('');

	function openNew() {
		newName = '';
		newOpen = true;
	}

	function create() {
		const name = newName.trim();
		if (!name) return;
		newOpen = false;
		editor.newCity(name);
	}
</script>

<div class="fixed top-8 left-1/2 z-50 -translate-x-1/2">
	<div
		class="flex flex-row items-center gap-2 rounded-lg border bg-background p-2 shadow-lg"
		role="toolbar"
		aria-label="Cities"
	>
		<Button variant="ghost" size="icon" onclick={openNew} title="New city">
			<Plus class="h-4 w-4" />
		</Button>

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Select.Root
			type="single"
			value={editor.currentCityId}
			onValueChange={(value) => editor.loadCityById(value)}
		>
			<Select.Trigger class="w-52">
				<span class="min-w-0 flex-1 truncate text-left">
					{editor.currentCityName || 'city…'}
				</span>
			</Select.Trigger>
			<Select.Content>
				{#each editor.cities as city (city.id)}
					<Select.Item value={city.id} label={city.name} />
				{/each}
			</Select.Content>
		</Select.Root>

		<Button
			variant="ghost"
			size="icon"
			onclick={() => editor.deleteCurrentCity()}
			title="Delete this city"
		>
			<Trash2 class="h-4 w-4" />
		</Button>
	</div>
</div>

<Dialog.Root bind:open={newOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>New city</Dialog.Title>
			<Dialog.Description>Give your new city a name</Dialog.Description>
		</Dialog.Header>
		<Input
			placeholder="e.g. downtown"
			bind:value={newName}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					create();
				}
			}}
		/>
		<Dialog.Footer>
			<Button onclick={create} disabled={!newName.trim()}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
