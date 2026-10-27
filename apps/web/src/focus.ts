export function focusStops(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],summary,[tabindex]')].filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0);
}

export function trapFocus(event: {key: string; shiftKey: boolean; preventDefault: () => void}, container: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const stops = focusStops(container), first = stops[0], last = stops.at(-1), active = document.activeElement;
  if (!first || !last) {event.preventDefault(); container.focus(); return;}
  if (event.shiftKey && (active === first || !container.contains(active))) {event.preventDefault(); last.focus();}
  else if (!event.shiftKey && (active === last || !container.contains(active))) {event.preventDefault(); first.focus();}
}

export function restoreFocus(element: Element | null): void {
  if (element instanceof HTMLElement && element.isConnected && !element.matches(':disabled') && element.getClientRects().length) element.focus({preventScroll: true});
}
