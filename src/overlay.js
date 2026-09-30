	// a classic content script, not a module.  loading the overlay as an ES
	// module meant the page's CSP governed the import, and a policy with
	// strict-dynamic -- Google Meet's, among others -- refuses it: the keyboard
	// still worked and the list silently never drew.  nothing is fetched now.
	//
	// the list is drawn into a closed shadow root on documentElement, so page
	// CSS cannot reach in and page script cannot read back which tabs are open.
(() => {

	// the worker injects into tabs that were already open, and a tab may have
	// the declared copy already.  reassigning the namespace would strand a
	// painted card in the page: the new closure's host is null, so its unmount
	// removes nothing and the next render adds a second one.
if (globalThis.mruOverlay) {
	return;
}

const Styles = `
:host {
	all: initial;
	/* the all shorthand excludes direction and unicode-bidi by spec, so an
	   RTL page mirrors the whole card without this */
	direction: ltr;
}
.card {
	position: fixed;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
	z-index: 2147483647;
	/* the tab's zoom, set per render.  zoom by its inverse cancels it, so
	   every px below is a screen px whatever the page is at.  zoom scales
	   vw and vh as well, which is why the caps multiply them back */
	--page-zoom: 1;
	zoom: calc(1 / var(--page-zoom));
	width: 480px;
	max-width: calc(100vw * var(--page-zoom) - 48px);
	/* a short window would otherwise push the highlighted row off the top
	   of the screen, which is the one row that matters */
	max-height: calc(100vh * var(--page-zoom) - 48px);
	overflow-y: auto;
	scrollbar-width: none;
	box-sizing: border-box;
	padding: 6px;
	border-radius: 14px;
	font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
	background: #ffffff;
	color: #1a1a1a;
	border: 1px solid rgba(0, 0, 0, 0.1);
	box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}
.query {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px 10px;
	margin-bottom: 4px;
	border-bottom: 1px solid rgba(0, 0, 0, 0.1);
	font-size: 14px;
	white-space: pre;
	overflow: hidden;
}
.query .typed:empty::before { content: "Type to search"; opacity: 0.45; }
.query .caret {
	width: 1px;
	height: 16px;
	margin-left: -8px;
	background: currentColor;
	animation: blink 1s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-color-scheme: dark) {
	.card {
		background: #26282b;
		color: #e8eaed;
		border-color: rgba(255, 255, 255, 0.12);
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6);
	}
	.query { border-color: rgba(255, 255, 255, 0.12); }
}
` + globalThis.mruRows.Styles;

let host = null;
let list = null;
let paintTimer = null;
let items = [];
let index = 0;
let zoom = 1;
	// null while walking; the typed text once the list is being searched
let query = null;
let bounds = { from: 0, to: 0 };


function build()
{
	host = document.createElement("mru-tabs-overlay");

		// the host is a popover so it sits in the top layer.  a modal <dialog>
		// or a fullscreen element is painted above every z-index there is --
		// Google Meet's device-permission dialog is one -- and an overlay in
		// normal flow ends up behind it, mounted and invisible.  a manual
		// popover joins the same layer without taking focus, and the element
		// shown last is the one on top.
		//
		// the UA sheet gives popovers a border, padding and a background, so
		// they are cleared here along with everything else; the card must never
		// intercept a click either.
	host.popover = "manual";
		// !important throughout: the host is an ordinary element in the page's
		// document, so a blanket `* { display: none !important }` would delete
		// the box the shadow root lives in while the extension believed it drew
	host.style.cssText = "all: initial !important; display: block !important;"
		+ " position: fixed !important; inset: 0 !important; margin: 0 !important;"
		+ " width: auto !important; height: auto !important;"
		+ " max-width: none !important; max-height: none !important;"
		+ " border: none !important; padding: 0 !important;"
		+ " background: transparent !important; overflow: visible !important;"
		+ " visibility: visible !important; opacity: 1 !important;"
		+ " pointer-events: none !important;";

	const root = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");

	style.textContent = Styles;

	list = document.createElement("div");
	list.className = "card";

	root.append(style, list);
	document.documentElement.append(host);

	try {
		host.showPopover();
	} catch {
			// no popover support, or the element was detached under us: the
			// overlay still renders, just not above the top layer
	}
}


function paint()
{
	if (!host) {
		build();
	}

	list.style.setProperty("--page-zoom", String(zoom));

	let selectedRow = null;
	const { drawRow, drawHeading } = globalThis.mruRows;
	const rows = items
		.slice(bounds.from, bounds.to)
		.map((item, offset) => {
			if (item.heading) {
				return drawHeading(item.heading);
			}

			const isSelected = bounds.from + offset === index;
			const row = drawRow(item, isSelected);

			selectedRow = isSelected ? row : selectedRow;

			return row;
		});

	if (query !== null) {
		const bar = document.createElement("div");
		const typed = document.createElement("span");
		const caret = document.createElement("span");

		bar.className = "query";
		typed.className = "typed";
		typed.textContent = query;
		caret.className = "caret";
		bar.append(typed, caret);
		rows.unshift(bar);

		if (!items.length) {
			rows.push(drawHeading("No matching tabs", "empty"));
		}
	}

	list.replaceChildren(...rows);

		// with the card capped to the viewport the highlight can fall outside
		// it; nothing else scrolls this list
	selectedRow?.scrollIntoView({ block: "nearest" });
}


globalThis.mruOverlay = {
		// a fast tap never paints: the first draw waits out the delay, and by
		// then the gesture has usually already committed and unmounted
	render(message)
	{
		if (message.items) {
			items = message.items;
		}

		index = message.index;
		bounds = message.bounds;
		zoom = message.zoom || 1;
		query = message.query ?? null;

			// typing is a decision to read the list, so it draws at once
		if (host || query !== null) {
			clearTimeout(paintTimer);
			paintTimer = null;
			paint();
		} else if (!paintTimer) {
			paintTimer = setTimeout(() => {
				paintTimer = null;
				paint();
			}, message.delay);
		}
	},

	unmount()
	{
		clearTimeout(paintTimer);
		paintTimer = null;
		host?.remove();
		host = null;
		list = null;
		query = null;
	},
};

})();
