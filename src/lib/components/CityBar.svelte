<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Plus, Save, Trash2 } from '@lucide/svelte';
	import { EXAMPLES } from '$lib/core/city-store';

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

	// Examples share the picker with your cities, kept apart by a value prefix.
	const EXAMPLE_PREFIX = 'example:';
	const pickerValue = $derived(
		editor.currentExampleId ? EXAMPLE_PREFIX + editor.currentExampleId : editor.currentCityId
	);

	function pick(value: string) {
		if (value !== pickerValue && !editor.confirmDiscard()) return;
		if (value.startsWith(EXAMPLE_PREFIX))
			void editor.openExample(value.slice(EXAMPLE_PREFIX.length));
		else editor.loadCityById(value);
	}

	// Saving an example asks for a name, prefilled with the example's.
	let saveName = $state('');
	$effect(() => {
		if (editor.saveAsOpen) saveName = editor.currentCityName;
	});

	function saveAs() {
		const name = saveName.trim();
		if (name) editor.saveAs(name);
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

		<Select.Root type="single" value={pickerValue} onValueChange={pick}>
			<Select.Trigger class="w-52">
				<span class="min-w-0 flex-1 truncate text-left">
					{editor.currentCityName || 'city…'}
				</span>
				{#if editor.dirty}
					<span
						class="size-2 shrink-0 rounded-full bg-amber-500"
						title="Unsaved changes"
						aria-label="Unsaved changes"
					></span>
				{/if}
			</Select.Trigger>
			<Select.Content>
				{#each editor.cities as city (city.id)}
					<Select.Item value={city.id} label={city.name} />
				{/each}
				<Select.Separator />
				<Select.Group>
					<Select.GroupHeading>Examples</Select.GroupHeading>
					{#each EXAMPLES as example (example.id)}
						<Select.Item value={EXAMPLE_PREFIX + example.id} label={example.name} />
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>

		<Button
			variant="ghost"
			size="icon"
			onclick={(event) => {
				editor.save();
				event.currentTarget.blur();
			}}
			title="Save (⌘S)"
		>
			<Save class="h-4 w-4" />
		</Button>

		<Button
			variant="ghost"
			size="icon"
			onclick={() => editor.deleteCurrentCity()}
			disabled={!editor.currentCityId}
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

<Dialog.Root bind:open={editor.saveAsOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Save as a new city</Dialog.Title>
			<Dialog.Description
				>Examples stay as they are; your changes become a city of your own</Dialog.Description
			>
		</Dialog.Header>
		<Input
			bind:value={saveName}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					saveAs();
				}
			}}
		/>
		<Dialog.Footer>
			<Button onclick={saveAs} disabled={!saveName.trim()}>Save</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
