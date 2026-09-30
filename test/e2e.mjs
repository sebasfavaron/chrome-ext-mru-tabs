	// Chrome 152 and up ignore --load-extension, so this drives the extension
	// under Playwright's bundled Chromium, which still honours it, and fires the
	// real command listener through onCommand.dispatch().
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

	// screenshots are diagnostics, not artefacts: docs/ holds the curated ones
const shots = process.env.SHOT_DIR || tmpdir();
const { chromium } = createRequire(import.meta.url)(
	process.env.PLAYWRIGHT_PATH || "playwright"
);

const Forward = 1;
const Backward = -1;

let server;
let origin;
let requested = [];
let context;
let worker;


function serve()
{
	return new Promise((resolve) => {
		server = createServer(async (request, response) => {
			const url = new URL(request.url, "http://localhost");

			requested.push(url.pathname);

				// a 1x1 gif, never cached, so every fetch of it reaches here
			if (url.pathname === "/icon.png") {
				response.writeHead(200, {
					"content-type": "image/gif",
					"cache-control": "no-store",
				});
				response.end(Buffer.from(
					"R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
					"base64"
				));

				return;
			}

			const headers = { "content-type": "text/html; charset=utf-8" };

				// Google Meet's own policy.  strict-dynamic means the http:/https:
				// sources are ignored and only a nonced script can pull in more,
				// which is the shape that blocks an extension loading code into
				// the page.
			if (url.searchParams.has("csp")) {
				headers["content-security-policy"] =
					"script-src 'nonce-x' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:;"
					+ "object-src 'none';base-uri 'self'";
			}

			try {
				response.writeHead(200, headers);
				response.end(await readFile(join(here, "fixtures", "page.html")));
			} catch {
				response.writeHead(404).end();
			}
		});

		server.listen(0, "127.0.0.1", () => {
			origin = `http://127.0.0.1:${server.address().port}`;
			resolve();
		});
	});
}


async function gesture(
	direction)
{
	await worker.evaluate(
		(name) => chrome.commands.onCommand.dispatch(name),
		direction === Backward ? "step-backward" : "step-forward"
	);
}


async function activeTitle()
{
	return worker.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

		return tab?.title ?? null;
	});
}


async function openPage(
	name,
	query = "")
{
	const page = await context.newPage();

	await page.goto(`${origin}/?name=${name}${query}`);
	await page.bringToFront();
	await page.waitForFunction(() => document.readyState === "complete");

	return page;
}


function overlayShowing(
	page)
{
	return page.evaluate(() => Boolean(document.querySelector("mru-tabs-overlay")));
}


	// the overlay lives in a closed shadow root, so nothing can query it and
	// "is it visible" has to be answered by looking at the pixels
async function centrePixel(
	page)
{
	const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
	const png = await page.screenshot({
		clip: { x: Math.floor(width / 2), y: Math.floor(height / 2), width: 1, height: 1 },
	});

	const chunks = [];

	for (let at = 8; at < png.length;) {
		const size = png.readUInt32BE(at);
		const kind = png.toString("ascii", at + 4, at + 8);

		if (kind === "IDAT") {
			chunks.push(png.subarray(at + 8, at + 8 + size));
		}

		at += size + 12;
	}

		// a 1x1 scanline: one filter byte, then the channels
	const raw = inflateSync(Buffer.concat(chunks));

	return [raw[1], raw[2], raw[3]];
}


	// how many screen pixels across the centre row are not the red dialog,
	// which is the card plus its shadow
async function cardWidth(
	page)
{
	const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
	const png = await page.screenshot({
		clip: { x: 0, y: Math.floor(height / 2), width, height: 1 },
	});

	const chunks = [];
	let channels = 3;

	for (let at = 8; at < png.length;) {
		const size = png.readUInt32BE(at);
		const kind = png.toString("ascii", at + 4, at + 8);

		if (kind === "IHDR") {
			channels = png[at + 8 + 9] === 6 ? 4 : 3;
		} else if (kind === "IDAT") {
			chunks.push(png.subarray(at + 8, at + 8 + size));
		}

		at += size + 12;
	}

	const raw = inflateSync(Buffer.concat(chunks));
	const filter = raw[0];
	const row = raw.subarray(1);

		// a single scanline has no row above it, so Up is None and Paeth
		// reduces to Sub
	for (let at = 0; at < row.length; at++) {
		const left = at >= channels ? row[at - channels] : 0;

		if (filter === 1 || filter === 4) {
			row[at] = (row[at] + left) & 0xff;
		} else if (filter === 3) {
			row[at] = (row[at] + (left >> 1)) & 0xff;
		}
	}

	let count = 0;

	for (let at = 0; at < row.length; at += channels) {
		if (!(row[at] === 255 && row[at + 1] === 0 && row[at + 2] === 0)) {
			count++;
		}
	}

	return count;
}


before(async () => {
	await serve();

	context = await chromium.launchPersistentContext(
		join(process.env.TMPDIR ?? "/tmp", `mru-e2e-${process.pid}`),
		{
			channel: "chromium",
				// headless by default so a run does not take over the screen;
				// MRU_HEADED=1 to watch one
			headless: !process.env.MRU_HEADED,
			args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
		}
	);

	worker = context.serviceWorkers()[0]
		|| await context.waitForEvent("serviceworker", { timeout: 10000 });
});


after(async () => {
	await context?.close();
	server?.close();
});


test("a fast tap and release lands on the previous tab without painting", async () => {
	const first = await openPage("alpha");
	const second = await openPage("beta");
	const third = await openPage("gamma");

	await third.keyboard.down("Control");
	await gesture(Forward);
	await third.keyboard.up("Control");

	await third.waitForTimeout(300);

	assert.equal(await activeTitle(), "beta");
	assert.equal(await overlayShowing(third), false, "no overlay for a fast tap");

	await Promise.all([first.close(), second.close(), third.close()]);
});


test("holding paints the list and stepping lands further down it", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");
	const gamma = await openPage("gamma");
	const delta = await openPage("delta");

	await delta.keyboard.down("Control");
	await gesture(Forward);
	await gesture(Forward);
	await delta.waitForTimeout(400);

	assert.equal(await overlayShowing(delta), true, "overlay paints while held");
	await delta.screenshot({ path: join(shots, "overlay-light.png") });
	await delta.emulateMedia({ colorScheme: "dark" });
	await delta.waitForTimeout(100);
	await delta.screenshot({ path: join(shots, "overlay-dark.png") });
	await delta.emulateMedia({ colorScheme: "light" });

	await delta.keyboard.up("Control");
	await delta.waitForTimeout(400);

	assert.equal(await activeTitle(), "beta");

	await Promise.all([alpha.close(), beta.close(), gamma.close(), delta.close()]);
});


test("the backward step walks the list the other way", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");
	const gamma = await openPage("gamma");

	await gamma.keyboard.down("Control");
	await gesture(Forward);
	await gesture(Forward);
	await gesture(Backward);
	await gamma.keyboard.up("Control");
	await gamma.waitForTimeout(400);

	assert.equal(await activeTitle(), "beta");

	await Promise.all([alpha.close(), beta.close(), gamma.close()]);
});


test("a page that fights for the keyboard cannot swallow the release", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta", "&hostile");

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.keyboard.up("Control");
	await beta.waitForTimeout(400);

	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close()]);
});


test("a modifier that was never seen commits on settle", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");

		// no Control keydown at all, the way it arrives when focus sits in
		// DevTools: the release we would wait for is never going to come
	await gesture(Forward);
	await beta.waitForTimeout(600);

	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close()]);
});


test("escape closes the list and stays put", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.waitForTimeout(400);

	assert.equal(await overlayShowing(beta), true);

	await beta.keyboard.press("Escape");
	await beta.waitForTimeout(300);

	assert.equal(await overlayShowing(beta), false, "escape unmounts the list");
	assert.equal(await activeTitle(), "beta", "escape leaves you where you were");

	await beta.keyboard.up("Control");
	await Promise.all([alpha.close(), beta.close()]);
});


test("a page the extension cannot touch switches blind and immediately", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");
	const restricted = await context.newPage();

	await restricted.goto("chrome://version");
	await restricted.bringToFront();
	await restricted.waitForTimeout(200);

	await gesture(Forward);

		// settle is 250ms and the release never comes, so landing this fast is
		// only possible if the step activated on the spot
	await restricted.waitForTimeout(120);

	assert.equal(await activeTitle(), "beta");

		// the gesture is still open on its settle timer; closing the tabs under
		// it leaks a commit into the next test
	await restricted.waitForTimeout(400);

	await Promise.all([alpha.close(), beta.close(), restricted.close()]);
});


test("a strict-dynamic CSP does not stop the list from drawing", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta", "&csp");

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.waitForTimeout(400);

	assert.equal(await overlayShowing(beta), true, "the overlay draws under Meet's CSP");

	await beta.keyboard.up("Control");
	await beta.waitForTimeout(300);

	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close()]);
});

test("injecting into a tab that already has the script changes nothing", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");

		// what the worker does to every tab that was already open when the
		// extension loaded.  here the declared script is already in place, so
		// this is the double-injection case.
	await worker.evaluate(async () => {
		const tabs = await chrome.tabs.query({});

		await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({
			target: { tabId: tab.id, allFrames: true },
			files: ["src/rows.js", "src/overlay.js", "src/content.js"],
		}).catch(() => {})));
	});

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.waitForTimeout(400);

		// again, now that a card is actually painted: this is the case that
		// strands one, since a fresh namespace has no handle on the old node
	await worker.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

		await chrome.scripting.executeScript({
			target: { tabId: tab.id, allFrames: true },
			files: ["src/rows.js", "src/overlay.js", "src/content.js"],
		}).catch(() => {});
	});

	assert.equal(
		await beta.evaluate(() => document.querySelectorAll("mru-tabs-overlay").length),
		1,
		"one overlay, not one per injection"
	);

	await beta.keyboard.up("Control");
	await beta.waitForTimeout(300);

	assert.equal(
		await beta.evaluate(() => document.querySelectorAll("mru-tabs-overlay").length),
		0,
		"and the card is gone afterwards, not stranded"
	);
	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close()]);
});


test("the list paints above a modal dialog in the top layer", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta", "&dialog");

	assert.deepEqual(
		await centrePixel(beta),
		[255, 0, 0],
		"the dialog owns the screen before the gesture"
	);

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.waitForTimeout(400);

	assert.notDeepEqual(
		await centrePixel(beta),
		[255, 0, 0],
		"the list is on top of the dialog, not behind it"
	);

	await beta.screenshot({ path: join(shots, "overlay-top-layer.png") });

	await beta.keyboard.up("Control");
	await beta.waitForTimeout(300);

	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close()]);
});

test("the list is the same size on screen whatever the tab's zoom", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta", "&dialog");

	const measure = async (factor) => {
		await worker.evaluate(async (factor) => {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

			await chrome.tabs.setZoom(tab.id, factor);
		}, factor);
		await beta.waitForTimeout(200);

		await beta.keyboard.down("Control");
		await gesture(Forward);
		await beta.waitForTimeout(400);

		const width = await cardWidth(beta);

		await beta.screenshot({ path: join(shots, `overlay-zoom-${factor}.png`) });
		await beta.keyboard.press("Escape");
		await beta.keyboard.up("Control");
		await beta.waitForTimeout(300);

		return width;
	};

	const plain = await measure(1);
	const big = await measure(2);
	const small = await measure(0.5);

	await worker.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

		await chrome.tabs.setZoom(tab.id, 0);
	});

	assert.ok(plain > 400, `the card is on screen (${plain}px)`);
	assert.ok(Math.abs(big - plain) <= 2, `200% draws it at ${big}px, not ${plain}px`);
	assert.ok(Math.abs(small - plain) <= 2, `50% draws it at ${small}px, not ${plain}px`);

	await Promise.all([alpha.close(), beta.close()]);
});


test("with the modifier unreadable, a walk keeps the list up long enough to read", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");
	const gamma = await openPage("gamma");

		// no Control keydown: focus is somewhere no extension reaches, such as
		// DevTools, so only a timer can end this
	await gesture(Forward);
	await gesture(Forward);
	await gamma.waitForTimeout(600);

	assert.equal(
		await overlayShowing(gamma),
		true,
		"the list is still up well past the single-tap settle"
	);

	await gamma.waitForTimeout(1000);

	assert.equal(await overlayShowing(gamma), false, "and it does end on its own");
	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close(), gamma.close()]);
});

test("a tab opened in the background is one step away", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");

		// opened while you keep looking at beta, the way a middle-clicked link
		// or a background target=_blank arrives
	await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `${origin}/?name=fresh`);
	await beta.waitForTimeout(500);

	assert.equal(await activeTitle(), "beta", "the new tab did not steal focus");

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.keyboard.up("Control");
	await beta.waitForTimeout(400);

	assert.equal(await activeTitle(), "fresh", "one step reaches the tab that just opened");

		// and the tab you were on before it opened is still the step after
	const fresh = context.pages().find((page) => page.url().includes("fresh"));

	await fresh.keyboard.down("Control");
	await gesture(Forward);
	await gesture(Forward);
	await fresh.keyboard.up("Control");
	await fresh.waitForTimeout(400);

	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close(), fresh.close()]);
});


test("a tab that closes mid-gesture does not swallow the landing", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");
	const gamma = await openPage("gamma");

	await gamma.keyboard.down("Control");
	await gesture(Forward);
	await gamma.waitForTimeout(300);

		// the highlight is on beta and the gesture's order is frozen, so the
		// entry it is about to activate stops existing under it
	await beta.close();
	await gamma.waitForTimeout(100);

	await gamma.keyboard.up("Control");
	await gamma.waitForTimeout(400);

	assert.equal(await activeTitle(), "alpha", "it steps past the dead entry");

	await Promise.all([alpha.close(), gamma.close()]);
});


test("focus moving into the page's own iframe does not end the gesture", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta", "&iframe");

		// focus starts in the top document, so moving it into the frame is a
		// real transition and the top window really does blur
	await beta.locator("#name").click();

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.waitForTimeout(300);

	assert.equal(await overlayShowing(beta), true);

		// the top window blurs here, exactly as it does on Meet
	await beta.frames()[1].locator("#inner").focus();
	await beta.waitForTimeout(400);

	assert.equal(await overlayShowing(beta), true, "the list is still up");
	assert.equal(await activeTitle(), "beta", "and nothing switched");

	await beta.keyboard.up("Control");
	await beta.waitForTimeout(300);

	assert.equal(await activeTitle(), "alpha");

	await Promise.all([alpha.close(), beta.close()]);
});


test("drawing the list does not tell the page where your other tabs are", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");
	const victim = await openPage("victim");

		// every page has fetched its own icon by now; from here on, a request
		// for one can only have come from the list being drawn
	await victim.waitForTimeout(500);
	requested = [];

	await victim.keyboard.down("Control");
	await gesture(Forward);
	await victim.waitForTimeout(500);

	assert.equal(await overlayShowing(victim), true, "the list is up, so it drew icons");
	assert.deepEqual(
		requested.filter((path) => path === "/icon.png"),
		[],
		"no icon was fetched from the site, which is what would leak the hostnames"
	);

	await victim.keyboard.up("Control");
	await victim.waitForTimeout(300);

	await Promise.all([alpha.close(), beta.close(), victim.close()]);
});


test("a key event the page made up cannot steer the gesture", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await beta.waitForTimeout(300);

	assert.equal(await overlayShowing(beta), true);

		// the page tries to let go of the modifier on the user's behalf
	await beta.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", bubbles: true }));
	});
	await beta.waitForTimeout(400);

	assert.equal(await overlayShowing(beta), true, "the list is still up");
	assert.equal(await activeTitle(), "beta", "and the page did not choose where we land");

	await beta.keyboard.up("Control");
	await beta.waitForTimeout(300);

	assert.equal(await activeTitle(), "alpha", "a real release still works");

	await Promise.all([alpha.close(), beta.close()]);
});


	// the popup is an ordinary extension page, so a tab can load it directly.
	// opened that way it is the current tab, and search leaves it out as it
	// leaves out whichever tab you are on.
async function openSearch()
{
	const id = new URL(worker.url()).host;
	const page = await context.newPage();

	await page.goto(`chrome-extension://${id}/src/popup.html`);
	await page.bringToFront();
	await page.waitForSelector(".row, .empty");

	return page;
}


function searchRows(
	page)
{
	return page.$$eval(".heading, .row", (nodes) => nodes.map((node) => (
		node.classList.contains("heading")
			? `# ${node.textContent}`
			: node.querySelector(".title").textContent
	)));
}


test("search lists open tabs by recency and recently closed below", async () => {
	const alpha = await openPage("alpha");
	const beta = await openPage("beta");
	const gone = await openPage("search-closed-one");

	await gone.close();
	await beta.bringToFront();
	await alpha.bringToFront();
	await alpha.waitForTimeout(200);

	const search = await openSearch();
	const rows = await searchRows(search);

	assert.deepEqual(rows.slice(0, 2), ["alpha", "beta"]);
	assert.ok(rows.indexOf("# Recently closed") > rows.indexOf("beta"));
	assert.ok(rows.includes("search-closed-one"));

	await Promise.all([alpha.close(), beta.close(), search.close()]);
});


test("typing filters both sections and Enter switches to the best open match", async () => {
	const alpha = await openPage("search-alpha");
	const beta = await openPage("search-beta");

	await alpha.bringToFront();

	const search = await openSearch();

	await search.keyboard.type("BETA");
	await search.waitForTimeout(50);

	const rows = await searchRows(search);

	const closedAt = rows.indexOf("# Recently closed");

		// earlier tests closed tabs called beta, and those match too
	assert.deepEqual(rows.slice(0, closedAt === -1 ? undefined : closedAt), ["search-beta"]);
	assert.equal(await search.$eval(".row.on mark", (mark) => mark.textContent), "beta");

	await search.keyboard.press("Enter");
	await alpha.waitForTimeout(300);

	assert.equal(await activeTitle(), "search-beta");

	await Promise.all([alpha.close(), beta.close(), search.close().catch(() => {})]);
});


test("choosing a recently closed tab restores it", async () => {
	const keep = await openPage("search-keep");
	const gone = await openPage("search-restore-me");

	await gone.close();
	await keep.bringToFront();

	const search = await openSearch();

	await search.keyboard.type("restore-me");
	await search.waitForTimeout(50);

	assert.deepEqual(await searchRows(search), ["# Recently closed", "search-restore-me"]);

	const restored = context.waitForEvent("page");

	await search.keyboard.press("Enter");

	const page = await restored;

	await page.waitForFunction(() => document.title === "search-restore-me");
	await page.waitForTimeout(200);

	assert.equal(await activeTitle(), "search-restore-me");

	await Promise.all([keep.close(), page.close(), search.close().catch(() => {})]);
});


test("a tab in a closed window can be restored on its own", async () => {
	const keep = await openPage("search-stay");
	const windowId = await worker.evaluate(async (url) => {
		const created = await chrome.windows.create({
			url: [`${url}/?name=search-win-a`, `${url}/?name=search-win-b`],
		});

		return created.id;
	}, origin);

	await keep.waitForTimeout(800);
	await worker.evaluate((id) => chrome.windows.remove(id), windowId);
	await keep.bringToFront();

	const search = await openSearch();

	await search.keyboard.type("search-win-b");
	await search.waitForTimeout(50);

	assert.deepEqual(await searchRows(search), ["# Recently closed", "search-win-b"]);

	const restored = context.waitForEvent("page");

	await search.keyboard.press("Enter");

	const page = await restored;

	await page.waitForFunction(() => document.title === "search-win-b");

	const titles = await worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.title));

	assert.ok(!titles.includes("search-win-a"), "only the chosen tab comes back");

	await Promise.all([keep.close(), page.close(), search.close().catch(() => {})]);
});


test("what you type in search never reaches the page underneath", async () => {
	const page = await openPage("search-watched");

	await page.evaluate(() => {
		window.seen = [];
		window.addEventListener("keydown", (event) => window.seen.push(event.key), true);
	});

	const search = await openSearch();

	await search.keyboard.type("secret");

	assert.deepEqual(await page.evaluate(() => window.seen), []);

	await Promise.all([page.close(), search.close()]);
});



	// the list is in a closed shadow root, so what it shows is read from the
	// worker's own record of the search
function searchState()
{
	return worker.evaluate(() => globalThis.mruSearchState?.());
}


async function typeInList(
	page,
	text)
{
		// the page learns a list is up one message after the command, and a
		// key pressed before then is still the page's
	await page.waitForTimeout(100);

	for (const key of text) {
		await page.keyboard.press(key);
	}

	await page.waitForTimeout(150);
}


test("typing while the list is up searches it, and letting go keeps it open", async () => {
	const alpha = await openPage("list-alpha");
	const beta = await openPage("list-beta");
	const gamma = await openPage("list-gamma");

	await gamma.keyboard.down("Control");
	await gesture(Forward);
	await gamma.waitForTimeout(300);
	await typeInList(gamma, "alp");
	await gamma.keyboard.up("Control");
	await gamma.waitForTimeout(300);

	assert.equal(await overlayShowing(gamma), true, "the release did not end it");
	assert.equal(await activeTitle(), "list-gamma");

	const state = await searchState();

	assert.equal(state.query, "alp");
	assert.equal(state.selected, "list-alpha");

	await gamma.keyboard.press("Enter");
	await gamma.waitForTimeout(300);

	assert.equal(await activeTitle(), "list-alpha");
	assert.equal(await overlayShowing(gamma), false);

	await Promise.all([alpha.close(), beta.close(), gamma.close()]);
});


test("backspace edits the query and the arrows move through the matches", async () => {
	const one = await openPage("list-note-one");
	const two = await openPage("list-note-two");
	const here = await openPage("list-here");

	await here.keyboard.down("Control");
	await gesture(Forward);
	await typeInList(here, "list-notx");
	await here.keyboard.up("Control");

	assert.equal((await searchState()).selected, null, "nothing matches yet");

	await here.keyboard.press("Backspace");
	await here.waitForTimeout(150);

	let state = await searchState();

	assert.equal(state.query, "list-not");
	assert.equal(state.selected, "list-note-two", "the more recent match first");

	await here.keyboard.press("ArrowDown");
	await here.waitForTimeout(150);
	state = await searchState();
	assert.equal(state.selected, "list-note-one");

	await here.keyboard.press("Enter");
	await here.waitForTimeout(300);

	assert.equal(await activeTitle(), "list-note-one");

	await Promise.all([one.close(), two.close(), here.close()]);
});


test("the list's search reaches recently closed tabs and reopens them", async () => {
	const keep = await openPage("list-keep");
	const other = await openPage("list-other");
	const gone = await openPage("list-reopen-me");

	await gone.close();
	await keep.bringToFront();
	await keep.waitForTimeout(200);

	await keep.keyboard.down("Control");
	await gesture(Forward);
	await typeInList(keep, "reopen");
	await keep.keyboard.up("Control");

	assert.equal((await searchState()).selected, "list-reopen-me");

	const restored = context.waitForEvent("page");

	await keep.keyboard.press("Enter");

	const page = await restored;

	await page.waitForFunction(() => document.title === "list-reopen-me");
	await page.waitForTimeout(200);

	assert.equal(await activeTitle(), "list-reopen-me");

	await Promise.all([keep.close(), other.close(), page.close()]);
});


test("escape ends a search where you were", async () => {
	const alpha = await openPage("list-stay-a");
	const beta = await openPage("list-stay-b");

	await beta.keyboard.down("Control");
	await gesture(Forward);
	await typeInList(beta, "stay");
	await beta.keyboard.up("Control");
	await beta.keyboard.press("Escape");
	await beta.waitForTimeout(300);

	assert.equal(await overlayShowing(beta), false);
	assert.equal(await activeTitle(), "list-stay-b");

	await Promise.all([alpha.close(), beta.close()]);
});


test("what you type into the list never reaches the page", async () => {
	const alpha = await openPage("list-private-a");
	const page = await openPage("list-private-b");

		// a page listening every way it can, with a field focused to type into
	await page.evaluate(() => {
		window.seen = [];

		const field = document.createElement("input");

		document.body.append(field);
		field.focus();

		const log = (where) => (event) => window.seen.push(`${where}:${event.type}:${event.key ?? event.data}`);

		for (const type of ["keydown", "keypress", "keyup", "beforeinput", "input"]) {
			window.addEventListener(type, log("window-capture"), true);
			window.addEventListener(type, log("window"));
			document.addEventListener(type, log("document"), true);
			field.addEventListener(type, log("field"));
		}
	});

	await page.keyboard.down("Control");
	await gesture(Forward);
	await page.waitForTimeout(250);
	await typeInList(page, "secret");
	await page.keyboard.up("Control");
	await typeInList(page, "more");
	await page.keyboard.press("Backspace");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);

	const { seen, value } = await page.evaluate(() => ({
		seen: window.seen,
		value: document.querySelector("input").value,
	}));

		// the Control press that started the walk is the page's own business:
		// it happened before there was a list to type into
	assert.deepEqual(seen.filter((entry) => !entry.endsWith(":Control")), []);
	assert.equal(value, "");

	await Promise.all([alpha.close(), page.close()]);
});
