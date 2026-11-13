<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Check, ChevronDown, Copy, Pencil, Plus, Save, Trash2 } from '@lucide/svelte';
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

	function openCity(id: string) {
		if (id === editor.currentCityId) return;
		if (!editor.confirmDiscard()) return;
		editor.loadCityById(id);
	}

	function openExample(id: string) {
		if (!editor.confirmDiscard()) return;
		void editor.openExample(id);
	}

	// Rename (in the menu) edits the name in place. It starts once the menu has
	// closed without handing focus back to its trigger, so the input keeps
	// focus. Escape ends editing before the input goes away, so the blur that
	// follows commits nothing.
	let editing = $state(false);
	let renameNext = false;
	let draft = $state('');

	function startRename() {
		draft = editor.currentCityName;
		editing = true;
	}

	function commitRename() {
		if (!editing) return;
		editing = false;
		editor.renameCity(draft);
	}

	function focusAndSelect(input: HTMLInputElement) {
		input.focus();
		input.select();
	}

	// Save-as (saving an example) and Duplicate share one dialog, prefilled with
	// the current name.
	let saveName = $state('');
	$effect(() => {
		if (editor.saveAsOpen) saveName = editor.currentCityName;
	});

	function saveAs() {
		const name = saveName.trim();
		if (name) editor.saveAs(name);
	}
</script>

<div class="fixed top-4 left-1/2 z-50 -translate-x-1/2">
	<div
		class="flex flex-row items-center gap-1 rounded-lg border bg-background p-1.5 shadow-lg"
		role="toolbar"
		aria-label="Cities"
	>
		{#if editing}
			<input
				class="h-8 w-52 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				aria-label="City name"
				bind:value={draft}
				use:focusAndSelect
				onblur={commitRename}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commitRename();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						editing = false;
					}
				}}
			/>
		{:else}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							class="flex h-8 w-52 items-center gap-1 rounded-md px-2 text-left text-sm hover:bg-accent"
							aria-label="City menu"
						>
							<span class="flex-1 truncate" data-testid="city-name">
								{editor.currentCityName || 'city…'}
							</span>
							<ChevronDown class="size-4 shrink-0 text-muted-foreground" />
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content
					align="start"
					class="w-56"
					onCloseAutoFocus={(e) => {
						if (!renameNext) return;
						e.preventDefault();
						renameNext = false;
						startRename();
					}}
				>
					<DropdownMenu.Item onSelect={openNew}>
						<Plus />New city…
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => editor.save()}>
						<Save />Save
						<DropdownMenu.Shortcut>⌘S</DropdownMenu.Shortcut>
					</DropdownMenu.Item>
					<DropdownMenu.Item
						disabled={!!editor.currentExampleId}
						onSelect={() => (renameNext = true)}
					>
						<Pencil />Rename…
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => (editor.saveAsOpen = true)}>
						<Copy />Duplicate…
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Group>
						<DropdownMenu.GroupHeading class="text-xs text-muted-foreground">
							Your cities
						</DropdownMenu.GroupHeading>
						{#each editor.cities as city (city.id)}
							<DropdownMenu.Item onSelect={() => openCity(city.id)}>
								<span class="flex-1 truncate">{city.name}</span>
								{#if city.id === editor.currentCityId}<Check />{/if}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Group>
					<DropdownMenu.Separator />
					<DropdownMenu.Group>
						<DropdownMenu.GroupHeading class="text-xs text-muted-foreground">
							Examples
						</DropdownMenu.GroupHeading>
						{#each EXAMPLES as example (example.id)}
							<DropdownMenu.Item onSelect={() => openExample(example.id)}>
								<span class="flex-1 truncate">{example.name}</span>
								{#if example.id === editor.currentExampleId}<Check />{/if}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Group>
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						variant="destructive"
						disabled={!editor.currentCityId}
						onSelect={() => editor.deleteCurrentCity()}
					>
						<Trash2 />Delete this city
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}

		{#if editor.dirty}
			<span
				class="mr-1 size-2 shrink-0 rounded-full bg-amber-500"
				title="Unsaved changes"
				aria-label="Unsaved changes"
			></span>
		{/if}
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
			<Dialog.Description>
				{editor.currentExampleId
					? 'Examples stay as they are; your changes become a city of your own'
					: 'This map, unsaved changes included, becomes a city of its own'}
			</Dialog.Description>
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
