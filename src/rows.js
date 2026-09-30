	// how one row of a tab list looks, shared by the in-page list and the search
	// popup.  a classic script for the same reason as the overlay: it runs as a
	// content script, and the page's CSP must have nothing to refuse.
(() => {

if (globalThis.mruRows) {
	return;
}

const Styles = `
.row {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 7px 10px;
	min-height: 32px;
	box-sizing: border-box;
	border-radius: 9px;
	overflow: hidden;
}
.row.on { background: #1a73e8; color: #ffffff; }
.icon {
	flex: 0 0 auto;
	width: 16px;
	height: 16px;
	border-radius: 4px;
	object-fit: contain;
}
.tile {
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 10px;
	font-weight: 600;
	color: #ffffff;
	text-transform: uppercase;
}
.text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.host:empty { display: none; }
.host { font-size: 11px; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.on .host, .row.on .when { opacity: 0.8; }
.when { flex: 0 0 auto; font-size: 11px; opacity: 0.55; }
.heading { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; opacity: 0.55; }
.empty { padding: 12px 10px; opacity: 0.55; }
mark { background: rgba(26, 115, 232, 0.18); color: inherit; border-radius: 2px; }
.row.on mark { background: rgba(255, 255, 255, 0.28); }
@media (prefers-color-scheme: dark) {
	.row.on { background: #8ab4f8; color: #1a1a1a; }
	mark { background: rgba(138, 180, 248, 0.25); }
	.row.on mark { background: rgba(0, 0, 0, 0.14); }
}
`;


	// a stable colour per site, so the fallback tile still tells tabs apart
function tint(
	text)
{
	let hash = 0;

	for (const character of text) {
		hash = (hash * 31 + character.codePointAt(0)) % 360;
	}

	return `hsl(${hash}, 52%, 45%)`;
}


function ago(
	at)
{
	const minutes = Math.round((Date.now() - at) / 60000);

	if (minutes < 1) {
		return "just now";
	}

	if (minutes < 60) {
		return `${minutes} min ago`;
	}

	const hours = Math.round(minutes / 60);

	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}


	// text with its matched ranges wrapped in <mark>, built as nodes so a
	// title can never be parsed as markup
function highlighted(
	text,
	ranges = [])
{
	const out = document.createDocumentFragment();
	let at = 0;

	for (const { start, length } of ranges) {
		out.append(text.slice(at, start));

		const mark = document.createElement("mark");

		mark.textContent = text.slice(start, start + length);
		out.append(mark);
		at = start + length;
	}

	out.append(text.slice(at));

	return out;
}


function drawRow(
	item,
	isSelected)
{
	const row = document.createElement("div");
	const highlights = item.highlights ?? {};

	row.className = isSelected ? "row on" : "row";

	const tile = document.createElement("div");

	tile.className = "icon tile";
	tile.style.background = tint(item.host || item.title || "?");
	tile.textContent = (item.host || item.title || "?").charAt(0);

		// the icon is served from the extension's own _favicon/ endpoint, never
		// from the site.  an <img> in the page's document is a fetch by that
		// page: a site's URL as the src would put the hostname of every tab in
		// the list into that page's service worker, and put a credentialed hit
		// on each of those sites saying where you were when you switched.  a
		// chrome-extension: request cannot be intercepted that way.  the tile
		// needs no resource at all and stands in when even that does not load.
	if (item.favIconUrl) {
		const icon = document.createElement("img");

		icon.className = "icon";
		icon.src = item.favIconUrl;
		icon.addEventListener("error", () => icon.replaceWith(tile), { once: true });
		row.append(icon);
	} else {
		row.append(tile);
	}

	const text = document.createElement("div");
	const title = document.createElement("div");
	const site = document.createElement("div");

	text.className = "text";
	title.className = "title";
	title.append(item.title
		? highlighted(item.title, highlights.title)
		: item.host || "(untitled)");
	site.className = "host";
	site.append(highlighted(item.host ?? "", highlights.host));
	text.append(title, site);
	row.append(text);

	if (item.closedAt) {
		const when = document.createElement("div");

		when.className = "when";
		when.textContent = ago(item.closedAt);
		row.append(when);
	}

	return row;
}


function drawHeading(
	text,
	className = "heading")
{
	const element = document.createElement("div");

	element.className = className;
	element.textContent = text;

	return element;
}


globalThis.mruRows = { Styles, drawRow, drawHeading };

})();
