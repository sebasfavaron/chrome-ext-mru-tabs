	// one gesture: a frozen snapshot of the recency order plus the index the
	// highlight sits on.  nothing here knows about Chrome, so the whole of the
	// switcher's behaviour is testable without a browser.

	// below a deliberate hold and above a fast tap, so letting go quickly never
	// paints an overlay
export const OVERLAY_DELAY_MS = 180;

	// how long after the last tap to commit when the modifier is unreadable
export const SETTLE_MS = 250;

	// the same, once the gesture is clearly a walk rather than a flick
export const SETTLE_READING_MS = 1200;

	// absolute ceiling on one gesture, so nothing can stay stuck
export const MAX_HOLD_MS = 10000;

	// a search is typed rather than held, so it gets its own ceiling, counted
	// from the last key rather than from the start
export const SEARCH_IDLE_MS = 30000;

export const MAX_ROWS = 12;


	// index 0 is the tab you are on, so forward starts one back.  fewer than two
	// tabs means there is nothing to switch to.
export function start(order, direction) {
	if (order.length < 2) {
		return null;
	}

	return {
		order: order.slice(),
		index: direction === 1 ? 1 : order.length - 1,
	};
}


export function step(session, direction) {
	const { length } = session.order;

	return {
		order: session.order,
		index: (session.index + direction + length) % length,
	};
}


export function selected(session) {
	return session.order[session.index];
}


	// what decides that the gesture is over.  a page with no content script has
	// no keyboard to read, and a modifier we never saw go down is one whose
	// release will never arrive -- either way, waiting for a release is waiting
	// forever, which is the failure this extension exists to remove.
export function commitPolicy({ hasContentScript, ctrlDown }) {
	if (!hasContentScript) {
		return "blind";
	}

	return ctrlDown ? "release" : "settle";
}


	// the slice of the list to draw, kept centred on the highlight and clamped
	// so the last page of a long list is full rather than half empty
export function rowWindow(index, length, maxRows) {
	if (length <= maxRows) {
		return { from: 0, to: length };
	}

	const from = Math.min(
		Math.max(0, index - Math.floor(maxRows / 2)),
		length - maxRows
	);

	return { from, to: from + maxRows };
}


	// with the modifier unreadable -- focus in DevTools, which no extension can
	// reach -- a timer is the only thing that can end the gesture, and one
	// number cannot serve both speeds.  a single tap is a flick and lands
	// straight away; from the second tap on, the list is up and being read, so
	// it stays up long enough to walk.
export function settleDelay(
	taps)
{
	return taps > 1 ? SETTLE_READING_MS : SETTLE_MS;
}
