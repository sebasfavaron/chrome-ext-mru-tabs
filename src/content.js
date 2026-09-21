	// runs in every frame at document_start.  this is the surface that already
	// holds keyboard focus when the shortcut fires, which is the whole reason
	// the switcher needs no popup window: the release lands here, immediately,
	// with nothing to open first.
(() => {

	// the worker injects into tabs that were already open when the extension
	// loaded, and those tabs may already have the declared script
if (globalThis.mruTabsLoaded) {
	return;
}

globalThis.mruTabsLoaded = true;

	// a page cannot hide the release.  preventDefault does not stop a handler
	// from running, and stopPropagation only reaches listeners later in the
	// path -- a capture listener on window installed at document_start is
	// first, ahead of anything the page registers on document or its own
	// elements.
const Capture = true;

const isTop = window.top === window;

let sessionOn = false;

	// the worker can be evicted mid-gesture, taking the hide message with it.
	// the overlay removes itself rather than being left painted over the page.
let orphanTimer = null;


function send(
	message)
{
		// after the extension is reloaded -- which for an unpacked build you do
		// by hand, often -- sendMessage throws synchronously in every tab that
		// was already open, so the .catch() alone would not hold and each
		// Control press would log two errors into the page's console forever
	if (!chrome.runtime?.id) {
		return;
	}

	try {
		chrome.runtime.sendMessage(message).catch(() => {});
	} catch {
			// the context went away between the check and the call
	}
}


window.addEventListener("keydown", (event) => {
		// a page can dispatch a KeyboardEvent that is indistinguishable from a
		// real one.  without this, any site could hold the modifier down on our
		// behalf -- making every later gesture wait out the ten second ceiling
		// -- or release it mid-walk and choose which tab you land on.
	if (!event.isTrusted) {
		return;
	}

		// a held modifier does not auto-repeat on macOS but does elsewhere
	if (event.key === "Control" && !event.repeat) {
		send({ type: "ctrl", down: true });
	} else if (sessionOn && event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		send({ type: "cancel" });
	}
}, Capture);


window.addEventListener("keyup", (event) => {
	if (event.isTrusted && event.key === "Control") {
		send({ type: "ctrl", down: false });
	}
}, Capture);


	// the top window also blurs when focus moves into one of its own iframes,
	// which pages like Meet and Docs do constantly -- ending the gesture there
	// would yank the user away mid-walk.  document.hasFocus() is still true in
	// that case and false only when focus has really left the tab, and it reads
	// correctly one tick after the event.
window.addEventListener("blur", () => {
	if (!sessionOn || !isTop) {
		return;
	}

	setTimeout(() => {
		if (sessionOn && !document.hasFocus()) {
			send({ type: "blur" });
		}
	}, 0);
});


chrome.runtime.onMessage.addListener((message, sender, respond) => {
	if (message?.type !== "session") {
		return false;
	}

	sessionOn = message.on;

	clearTimeout(orphanTimer);
	orphanTimer = message.on
		? setTimeout(() => {
			sessionOn = false;
			globalThis.mruOverlay?.unmount();

				// the worker may still be holding a gesture this frame has just
				// stopped listening for.  telling it leaves no gesture the user
				// can neither see nor cancel; if the worker is gone, the message
				// is dropped and nothing is worse.
			send({ type: "cancel" });
		}, message.maxHold)
		: null;

	if (isTop) {
		if (message.on) {
			globalThis.mruOverlay?.render(message);
		} else {
			globalThis.mruOverlay?.unmount();
		}
	}

	respond({ ok: true });

	return false;
});

})();
