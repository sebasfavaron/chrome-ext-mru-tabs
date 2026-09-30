import { touch, remove, reconcile, insertNext } from "./mru.js";
import {
	start,
	step,
	selected,
	commitPolicy,
	rowWindow,
	settleDelay,
	MAX_HOLD_MS,
	SEARCH_IDLE_MS,
	OVERLAY_DELAY_MS,
	MAX_ROWS,
} from "./session.js";
import { rowsFor, move } from "./search.js";

	// the overlay only ever draws in the top frame, so loading it into every
	// subframe costs six kilobytes a frame for nothing
const TopFrameScripts = ["src/rows.js", "src/overlay.js"];
const EveryFrameScripts = ["src/content.js"];

const OrderKey = "order";

	// an MV3 worker is evicted when idle, so the order is mirrored to session
	// storage -- in memory, survives a restart of the worker, cleared when
	// Chrome quits.
let order = null;

	// the live gesture, or null.  while one is running the recency tracker is
	// deaf, so stepping cannot rewrite the list it is walking.
let gesture = null;

let ctrlDown = false;

	// every gesture carries an id.  a timer that has already fired cannot be
	// un-fired, so a watchdog armed for one gesture must not be allowed to end
	// the one that replaced it.
let epoch = 0;

	// commands arrive faster than they can be handled, and two overlapping
	// handlers would step the same index twice
let queue = Promise.resolve();


function hostOf(
	url)
{
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}


async function liveOrder()
{
	const tabs = await chrome.tabs.query({});
	const ids = tabs.map((tab) => tab.id);

	if (!order) {
		const stored = (await chrome.storage.session.get(OrderKey))[OrderKey];

			// lastAccessed gives real recency for tabs this worker never saw,
			// which is what a cold start is made of
		order = stored
			|| [...tabs]
				.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
				.map((tab) => tab.id);
	}

	order = reconcile(order, ids);
	save();

	return { order, tabs };
}


function save()
{
	chrome.storage.session.set({ [OrderKey]: order }).catch(() => {});
}


	// what a row shows for one tab, open or closed
function describe(
	tab)
{
	return {
		title: tab?.title || tab?.url || "",
		host: hostOf(tab?.url ?? ""),
			// the extension's own favicon endpoint, never the site's URL: an
			// <img> in the page's document is a fetch by that page, and the
			// site's URL there would hand the page a list of where the user
			// has tabs open
		favIconUrl: tab?.url
			? chrome.runtime.getURL(
				`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`
			)
			: "",
	};
}


function itemsFor(
	ids,
	tabs)
{
	const byId = new Map(tabs.map((tab) => [tab.id, tab]));

	return ids.map((id) => ({ id, ...describe(byId.get(id)) }));
}


async function show(
	tabId,
	items,
	index,
	length)
{
	if (tabId == null) {
		return false;
	}

	try {
			// the card is drawn at the screen's scale, not the page's: without
			// this a tab at 175% shows a list that runs off both edges and one
			// at 50% shows one too small to read
		const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);

		await chrome.tabs.sendMessage(tabId, {
			type: "session",
			on: true,
				// the list is sent once per tab that draws it, not on every
				// step: re-serialising every open tab's title into the page on
				// each keystroke is the bulk of the gesture's cost
			items: gesture?.itemsSentTo === tabId ? null : items,
			index,
				// the overlay is a dumb renderer: every number it needs travels
				// with the message, so it can be a plain script with no imports
				// for a page's CSP to refuse
			bounds: rowWindow(index, length, MAX_ROWS),
			delay: OVERLAY_DELAY_MS,
			zoom,
			maxHold: gesture?.search ? SEARCH_IDLE_MS : MAX_HOLD_MS,
			query: gesture?.search?.query,
		});

		if (gesture) {
			gesture.itemsSentTo = tabId;
		}

		return true;
	} catch {
			// no content script here: a chrome:// page, the Web Store, the PDF
			// viewer or the new tab page
		return false;
	}
}


function hide(
	tabId)
{
	if (tabId == null) {
		return;
	}

	chrome.tabs.sendMessage(tabId, { type: "session", on: false }).catch(() => {});
}


async function activate(
	tabId)
{
	try {
		const tab = await chrome.tabs.get(tabId);

		await chrome.tabs.update(tabId, { active: true });
		await chrome.windows.update(tab.windowId, { focused: true });

		return true;
	} catch {
		return false;
	}
}


async function activeTabId()
{
	const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

	return tab?.id ?? null;
}


function clearTimers()
{
	clearTimeout(gesture?.settleTimer);
	clearTimeout(gesture?.maxTimer);
}


	// settle covers a modifier we cannot read and restarts with each tap.  max
	// is armed once, at the start: re-arming it on every tap would turn the
	// ceiling on a gesture into a ceiling on the pause between taps, and a
	// gesture that can outlive the worker's own idle timeout can be evicted
	// with the list still painted.
function armTimers()
{
	const { id } = gesture;

	clearTimeout(gesture.settleTimer);
	gesture.settleTimer = null;

	if (gesture.mode !== "release") {
		gesture.settleTimer = setTimeout(
			() => run(() => commit(id)),
			settleDelay(gesture.taps)
		);
	}

	gesture.maxTimer ??= setTimeout(() => run(() => commit(id)), MAX_HOLD_MS);
}


async function begin(
	direction)
{
	const { order: live, tabs } = await liveOrder();
	const session = start(live, direction);

	if (!session) {
		return;
	}

	gesture = {
		id: (epoch += 1),
		session,
		items: itemsFor(session.order, tabs),
		hostTabId: await activeTabId(),
		mode: "blind",
		taps: 1,
		settleTimer: null,
		maxTimer: null,
	};

	const shown = await show(
		gesture.hostTabId,
		gesture.items,
		session.index,
		session.order.length
	);

	gesture.mode = commitPolicy({ hasContentScript: shown, ctrlDown });

	if (gesture.mode === "blind") {
		await activate(selected(session));
	}

	armTimers();
}


async function advance(
	direction)
{
	if (gesture.search) {
		return moveSearch(direction);
	}

	gesture.session = step(gesture.session, direction);
	gesture.taps += 1;

	if (gesture.mode === "blind") {
			// no list to read, so the only feedback is landing there.  the host
			// is the tab we just activated, not whatever a focus query reports:
			// window focus is OS-mediated and can still name the tab we left,
			// which would paint the list somewhere invisible.
		const tabId = selected(gesture.session);

		if (await activate(tabId)) {
			gesture.hostTabId = tabId;
		}
	}

	const shown = await show(
		gesture.hostTabId,
		gesture.items,
		gesture.session.index,
		gesture.session.order.length
	);

	if (gesture.mode === "blind" && shown) {
			// blind stepping landed somewhere injectable, so the rest of the
			// gesture gets a list and a proper commit
		gesture.mode = commitPolicy({ hasContentScript: true, ctrlDown });
	}

	armTimers();
}


	// the rows a search draws: the walk's own list minus the tab you are on,
	// then the recently closed
function refresh()
{
	const { search } = gesture;
	const { rows, index } = rowsFor(search.query, search.open, search.closed);

	search.rows = rows;
	search.index = index;
}


function showSearch()
{
	const { rows, index } = gesture.search;

		// the list changes with every key, so it travels every time
	gesture.itemsSentTo = null;

	return show(gesture.hostTabId, rows, index, rows.length);
}


	// the idle ceiling replaces the hold one: a search ends on Enter, Escape
	// or leaving Chrome, and this only catches one that was walked away from
function armSearchTimer()
{
	const { id } = gesture;

	clearTimeout(gesture.settleTimer);
	clearTimeout(gesture.maxTimer);
	gesture.settleTimer = null;
	gesture.maxTimer = setTimeout(() => run(() => gesture?.id === id && cancel()), SEARCH_IDLE_MS);
}


async function type(
	key)
{
		// with no list on screen there is nothing to type into
	if (!gesture || gesture.mode === "blind") {
		return;
	}

	if (!gesture.search) {
		gesture.search = {
			query: "",
			open: gesture.items.slice(1),
			closed: await closedItems(),
			rows: [],
			index: -1,
		};
	}

	const { search } = gesture;

	search.query = key === "Backspace" ? search.query.slice(0, -1) : search.query + key;
	refresh();
	armSearchTimer();
	await showSearch();
}


async function moveSearch(
	direction)
{
	const { search } = gesture;

	if (search.index !== -1) {
		search.index = move(search.rows, search.index, direction);
	}

	armSearchTimer();
	await showSearch();
}


async function finishSearch()
{
	const { search } = gesture;
	const row = search.rows[search.index];

	clearTimers();
	hide(gesture.hostTabId);
	gesture = null;

	if (!row) {
		return;
	}

	if (row.sessionId) {
			// the restored tab reaches the recency order through its own
			// creation and activation
		await openResult({ sessionId: row.sessionId });
	} else if (await activate(row.id)) {
		order = touch(order, row.id);
		save();
	}
}


	// the order a gesture walks is frozen, so it can name a tab that has since
	// closed -- an auth popup finishing, a download tab.  activating a dead tab
	// fails silently and the whole gesture reads as nothing happening, so step
	// past the dead entries to the next live one.
async function land(
	session)
{
	const ids = session.order;

	for (let offset = 0; offset < ids.length; offset += 1) {
		const tabId = ids[(session.index + offset) % ids.length];

		if (await activate(tabId)) {
			return tabId;
		}
	}

	return null;
}


async function finish(
	session)
{
	const host = gesture.hostTabId;

	clearTimers();
	gesture = null;
	hide(host);

	const landed = session ? await land(session) : await activeTabId();

	if (landed != null && order) {
		order = touch(order, landed);
		save();
	}
}


	// a watchdog passes the gesture it was armed for; a release passes nothing
	// and means whichever gesture is live now
function commit(
	id)
{
	if (!gesture || (id !== undefined && gesture.id !== id)) {
		return undefined;
	}

	return gesture.search ? finishSearch() : finish(gesture.session);
}


function cancel()
{
		// blind stepping already moved us and there is nothing to undo, so
		// cancel just stops the gesture where it stands
	return gesture ? finish(null) : undefined;
}


function run(
	work)
{
	queue = queue.then(work).catch((error) => console.error("mru-tabs:", error));

	return queue;
}


	// what Chrome remembers closing, newest first as Chrome returns it.  a
	// closed window or group is flattened into its tabs, each restorable on
	// its own.
async function closedItems()
{
	const sessions = await chrome.sessions.getRecentlyClosed().catch(() => []);

	return sessions.flatMap((session) => {
		const inner = session.tab
			? [session.tab]
			: (session.window ?? session.group)?.tabs ?? [];

		return inner
			.filter((tab) => tab.sessionId && tab.url)
			.map((tab) => ({
				sessionId: tab.sessionId,
				...describe(tab),
				closedAt: session.lastModified * 1000,
			}));
	});
}


	// what the search popup lists: every open tab but the one you are on, in
	// the recency order, and the recently closed ones
async function searchable()
{
	const { order: live, tabs } = await liveOrder();
	const current = await activeTabId();

	return {
		open: itemsFor(live.filter((id) => id !== current), tabs),
		closed: await closedItems(),
	};
}


async function openResult(
	{ tabId, sessionId })
{
	if (tabId != null) {
		return activate(tabId);
	}

	try {
		await chrome.sessions.restore(sessionId);

		return true;
	} catch {
			// gone from Chrome's list since the popup read it
		return false;
	}
}


chrome.commands.onCommand.addListener((name) => {
	const direction = name === "step-backward" ? -1 : 1;

	run(() => (gesture ? advance(direction) : begin(direction)));
});


chrome.runtime.onMessage.addListener((message, sender, respond) => {
	switch (message?.type) {
		case "ctrl":
			ctrlDown = message.down;

				// once typing has started, letting go of Control is how you
				// type the rest; Enter is what chooses
			if (!message.down) {
				run(() => (gesture?.search ? undefined : commit()));
			}

			break;

			// focus left Chrome entirely, so the release is going to another
			// application.  clearing the modifier matters as much as the
			// commit: a Control held out of the window and released elsewhere
			// would otherwise read as held for the rest of the worker's life,
			// and every later gesture would wait for a release that already
			// happened somewhere we cannot see.
		case "blur":
			ctrlDown = false;
				// a search you walked away from was not a choice
			run(() => (gesture?.search ? cancel() : commit()));
			break;

		case "type":
			run(() => type(message.key));
			break;

		case "move":
			run(() => gesture?.search && moveSearch(message.direction));
			break;

		case "commit":
			run(() => commit());
			break;

		case "cancel":
			run(() => cancel());
			break;

			// the popup waits on both: it closes once the switch is done, and
			// closing first would take the request with it
		case "search":
			searchable().then(respond, () => respond({ open: [], closed: [] }));

			return true;

		case "open":
			openResult(message).then((ok) => respond({ ok }), () => respond({ ok: false }));

			return true;
	}

	respond({ ok: true });

	return false;
});


chrome.tabs.onActivated.addListener(({ tabId }) => {
	if (gesture) {
		return;
	}

	run(async () => {
		await liveOrder();
		order = touch(order, tabId);
		save();
	});
});


chrome.tabs.onCreated.addListener((tab) => {
	run(async () => {
		await liveOrder();
		order = insertNext(order, tab.id);
		save();
	});
});


chrome.tabs.onRemoved.addListener((tabId) => {
	run(async () => {
		await liveOrder();
		order = remove(order, tabId);
		save();
	});
});


chrome.windows.onFocusChanged.addListener((windowId) => {
	if (windowId === chrome.windows.WINDOW_ID_NONE) {
		ctrlDown = false;

		return;
	}

	if (gesture) {
		return;
	}

	run(async () => {
		const [tab] = await chrome.tabs.query({ active: true, windowId });

		if (tab) {
			await liveOrder();
			order = touch(order, tab.id);
			save();
		}
	});
});


	// a declared content script only reaches tabs loaded after the extension
	// was.  without this, every tab that was already open -- the dev server and
	// the meeting you never reload -- falls back to blind stepping and never
	// shows a list, which looks exactly like a bug in the switcher.
async function injectEverywhere()
{
	const tabs = await chrome.tabs.query({});

	await Promise.all(tabs.map(async (tab) => {
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id, frameIds: [0] },
				files: TopFrameScripts,
			});
			await chrome.scripting.executeScript({
				target: { tabId: tab.id, allFrames: true },
				files: EveryFrameScripts,
			});
		} catch {
				// a page Chrome will not let an extension touch
		}
	}));
}


chrome.runtime.onInstalled.addListener(() => injectEverywhere());
chrome.runtime.onStartup.addListener(() => injectEverywhere());


	// the list is drawn in a closed shadow root that nothing can read back, so
	// the end-to-end suite asks the worker what a search is showing
globalThis.mruSearchState = () => {
	const search = gesture?.search;

	return search
		? { query: search.query, selected: search.rows[search.index]?.title ?? null }
		: null;
};
