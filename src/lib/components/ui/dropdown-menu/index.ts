import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
import Content from './dropdown-menu-content.svelte';
import Group from './dropdown-menu-group.svelte';
import Item from './dropdown-menu-item.svelte';
import Separator from './dropdown-menu-separator.svelte';
import Shortcut from './dropdown-menu-shortcut.svelte';
import Trigger from './dropdown-menu-trigger.svelte';
import GroupHeading from './dropdown-menu-group-heading.svelte';
const Sub = DropdownMenuPrimitive.Sub;
const Root = DropdownMenuPrimitive.Root;

export {
	Content,
	Root as DropdownMenu,
	Content as DropdownMenuContent,
	Group as DropdownMenuGroup,
	Item as DropdownMenuItem,
	Separator as DropdownMenuSeparator,
	Shortcut as DropdownMenuShortcut,
	Sub as DropdownMenuSub,
	Trigger as DropdownMenuTrigger,
	GroupHeading as DropdownMenuGroupHeading,
	Group,
	GroupHeading,
	Item,
	Root,
	Separator,
	Shortcut,
	Sub,
	Trigger
};
