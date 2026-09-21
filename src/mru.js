	// the recency order, most recent first.  every operation returns a new
	// array: the service worker mirrors the order to storage on each change and
	// a gesture walks a snapshot, so nothing may share a mutable list.

export function touch(order, tabId) {
	return [tabId, ...order.filter((id) => id !== tabId)];
}


export function remove(order, tabId) {
	return order.filter((id) => id !== tabId);
}


	// tabs can open and close while the worker is evicted, so the mirrored order
	// is trued up against what Chrome actually has: dead ids drop out, and ids
	// we have never seen go to the end, since they are older news than anything
	// this run has recorded.
export function reconcile(order, liveTabIds) {
	const live = new Set(liveTabIds);
	const kept = order.filter((id) => live.has(id));
	const known = new Set(kept);

	return [...kept, ...liveTabIds.filter((id) => !known.has(id))];
}


	// a tab that opens while you are looking at something else is the thing you
	// most likely want next, but it is not the thing you are on: it goes one
	// behind the current tab, so a single step reaches it.  a tab that opens in
	// the foreground passes through here first and is then moved to the front
	// by its own activation.
export function insertNext(order, tabId) {
	const rest = order.filter((id) => id !== tabId);

	return [...rest.slice(0, 1), tabId, ...rest.slice(1)];
}
