	// how long a gesture takes from the command to the list leaving the worker,
	// with ~200 tabs open, idle and while a 40-tab window is closing.  the
	// worker's sendMessage is wrapped, so the number is what begin() spends
	// before the page has anything to draw.
	//
	//   node tools/bench-begin.mjs [runs]
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(import.meta.url)(
	process.env.PLAYWRIGHT_PATH || join(root, "node_modules", "playwright")
);

const Runs = Number(process.argv[2] ?? 20);
const Tabs = 200;
const Closing = 40;

const context = await chromium.launchPersistentContext(
	join(process.env.TMPDIR ?? "/tmp", `mru-bench-${process.pid}`),
	{
		channel: "chromium",
		headless: true,
		args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
	}
);
const worker = context.serviceWorkers()[0]
	|| await context.waitForEvent("serviceworker", { timeout: 10000 });

	// the host needs the content script, or the gesture goes blind and moves
	// the active tab under the next run
const server = createServer((request, response) => {
	response.writeHead(200, { "content-type": "text/html" }).end("<title>host</title>");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const host = await context.newPage();

await host.goto(`http://127.0.0.1:${server.address().port}/`);

await worker.evaluate(async (count) => {
	for (let at = 0; at < count; at += 1) {
		await chrome.tabs.create({ url: "about:blank", active: false });
	}
}, Tabs - 2);
await host.bringToFront();
await host.waitForTimeout(1500);

await worker.evaluate(() => {
	const send = chrome.tabs.sendMessage.bind(chrome.tabs);

	chrome.tabs.sendMessage = (tabId, message, ...rest) => {
		if (message?.type === "session" && message.on && globalThis.benchStart != null) {
			globalThis.benchTimes.push(performance.now() - globalThis.benchStart);
			globalThis.benchStart = null;
		}

		return send(tabId, message, ...rest);
	};
	globalThis.benchTimes = [];
});


async function once(
	closing)
{
	if (closing) {
		await worker.evaluate(async (count) => {
			const created = await chrome.windows.create({
				url: Array.from({ length: count }, () => "about:blank"),
				focused: false,
			});

			globalThis.benchWindow = created.id;
		}, Closing);
		await host.bringToFront();
		await host.waitForTimeout(600);
	}

	await worker.evaluate(async (closing) => {
		if (closing) {
				// the removal resolves before every onRemoved has been handled,
				// which is the window a Ctrl+Tab lands in
			await chrome.windows.remove(globalThis.benchWindow);
		}

		globalThis.benchStart = performance.now();
		chrome.commands.onCommand.dispatch("step-forward");
	}, closing);

	await worker.evaluate(async () => {
		while (globalThis.benchStart != null) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		chrome.runtime.onMessage.dispatch({ type: "cancel" }, {}, () => {});
	});
	await host.waitForTimeout(150);
}


function summary(
	label,
	times)
{
	const sorted = [...times].sort((a, b) => a - b);
	const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

	console.log(
		`${label.padEnd(16)} n=${sorted.length}  median ${pick(0.5).toFixed(1)} ms`
		+ `  p90 ${pick(0.9).toFixed(1)} ms  max ${sorted.at(-1).toFixed(1)} ms`
	);
}


const tabCount = await worker.evaluate(async () => (await chrome.tabs.query({})).length);

console.log(`${tabCount} tabs open`);

for (const closing of [false, true]) {
	await worker.evaluate(() => { globalThis.benchTimes = []; });

	await once(closing);	// warm-up, not counted
	await worker.evaluate(() => { globalThis.benchTimes = []; });

	for (let run = 0; run < Runs; run += 1) {
		await once(closing);
	}

	summary(closing ? `closing ${Closing}` : "idle", await worker.evaluate(() => globalThis.benchTimes));
}

await context.close();
server.close();
