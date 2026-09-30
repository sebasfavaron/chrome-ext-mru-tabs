	// the search popup, for where the in-page list cannot draw: the new tab
	// page, chrome:// pages, the Web Store.  it is the extension's own
	// document, so what you type here never reaches the tab underneath.
import { rowsFor, move } from "./search.js";

const { Styles, drawRow, drawHeading } = globalThis.mruRows;
const input = document.getElementById("query");
const list = document.getElementById("list");

let data = { open: [], closed: [] };
let rows = [];
let index = -1;


function paint()
{
	list.replaceChildren(...rows.map((row, position) => {
		if (row.heading) {
			return drawHeading(row.heading);
		}

		const element = drawRow(row, position === index);

		element.addEventListener("mousemove", () => select(position));
		element.addEventListener("click", () => choose(position));

		return element;
	}));

	if (!rows.length) {
		list.append(drawHeading(input.value.trim() ? "No matching tabs" : "No other tabs", "empty"));
	}

	list.querySelector(".row.on")?.scrollIntoView({ block: "nearest" });
}


	// a new query starts from its best match
function filter()
{
	({ rows, index } = rowsFor(input.value, data.open, data.closed));
	paint();
}


function select(
	position)
{
	if (position !== index) {
		index = position;
		paint();
	}
}


async function choose(
	position)
{
	const row = rows[position];

	if (!row || row.heading) {
		return;
	}

	await chrome.runtime.sendMessage(
		row.sessionId
			? { type: "open", sessionId: row.sessionId }
			: { type: "open", tabId: row.id }
	);
	window.close();
}


input.addEventListener("input", filter);


input.addEventListener("keydown", (event) => {
	const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
	const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");

	if (down || up) {
		event.preventDefault();

		if (index !== -1) {
			select(move(rows, index, down ? 1 : -1));
		}
	} else if (event.key === "Enter") {
		event.preventDefault();
		choose(index);
	}
});


const style = document.createElement("style");

style.textContent = Styles;
document.head.append(style);

data = await chrome.runtime.sendMessage({ type: "search" });
filter();
