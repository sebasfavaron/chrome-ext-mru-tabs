// Bind the switcher to a literal Ctrl+Tab, with no key remapper in the way.
//
// Chrome refuses Ctrl+Tab in a manifest and in the shortcuts UI: Tab was taken
// off the list of bindable keys in Chrome 33 for accessibility, and the browser
// handles it before any extension sees it.  chrome.developerPrivate is the
// internal API the shortcuts page itself uses, and it does not apply that rule.
//
// How to run it:
//   1. Open chrome://extensions/shortcuts
//   2. Cmd+Opt+J (macOS) or Ctrl+Shift+J to open the console for THAT page
//   3. Paste this whole file and press Enter
//
// It has to be that page's console: chrome.developerPrivate does not exist
// anywhere else.  The binding survives a browser restart and an extension
// reload.  Chrome's own Ctrl+Tab and Ctrl+Shift+Tab are given up in exchange —
// Cmd+Opt+Left/Right still move one tab along.
//
// Undo it from the same console with Ctrl+Q / Ctrl+Shift+Q as the keybinding,
// or from the shortcuts page by clearing and retyping them.

(async () => {
	const bindings = {
		"step-forward": "Ctrl+Tab",
		"step-backward": "Ctrl+Shift+Tab",
	};

	if (!globalThis.chrome?.developerPrivate?.updateExtensionCommand) {
		throw new Error("Run this in the console of chrome://extensions/shortcuts");
	}

		// found by name rather than by id, since an unpacked extension's id is
		// derived from its folder path and changes if the folder moves
	const all = await chrome.developerPrivate.getExtensionsInfo();
	const target = all.find((one) => one.name === "MRU Tabs");

	if (!target) {
		throw new Error("MRU Tabs is not installed in this profile");
	}

	for (const [commandName, keybinding] of Object.entries(bindings)) {
		await chrome.developerPrivate.updateExtensionCommand({
			extensionId: target.id,
			commandName,
			keybinding,
		});
	}

		// chrome.commands does not exist on this page, so the binding is read
		// back from the extension's own record instead
	const [after] = (await chrome.developerPrivate.getExtensionsInfo())
		.filter((one) => one.id === target.id);

	console.log("bound:", Object.fromEntries(
		(after?.commands ?? []).map((one) => [one.name, one.keybinding])
	));
	console.log("If a key remapper (Karabiner, AutoHotkey) is rewriting Ctrl+Tab,"
		+ " turn that rule off: it changes the key before Chrome ever sees it.");
})();
