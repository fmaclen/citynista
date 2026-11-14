import { Dialog as DialogPrimitive } from 'bits-ui';

import Title from './dialog-title.svelte';
import Footer from './dialog-footer.svelte';
import Header from './dialog-header.svelte';
import Overlay from './dialog-overlay.svelte';
import Content from './dialog-content.svelte';
import Description from './dialog-description.svelte';

const Root = DialogPrimitive.Root;
const Portal = DialogPrimitive.Portal;

export {
	Root,
	Title,
	Portal,
	Footer,
	Header,
	Overlay,
	Content,
	Description,
	//
	Root as Dialog,
	Title as DialogTitle,
	Portal as DialogPortal,
	Footer as DialogFooter,
	Header as DialogHeader,
	Overlay as DialogOverlay,
	Content as DialogContent,
	Description as DialogDescription
};
