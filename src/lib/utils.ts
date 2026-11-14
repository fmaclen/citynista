import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

// Whether a key event came from the page itself rather than a field or
// control: keyboard shortcuts act only on those.
export function fromPage(event: Event) {
	const target = event.target;
	return !(target instanceof HTMLElement) || target.tagName === 'BODY';
}

// A click handler that hands focus back to the page after acting, so
// shortcuts keep working right after a button is clicked.
export function press(action: () => void) {
	return (event: MouseEvent) => {
		action();
		const target = event.currentTarget;
		if (target instanceof HTMLElement) target.blur();
	};
}
