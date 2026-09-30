	// the matcher behind the search popup, ported from Chrome's own tab search
	// (chrome/browser/resources/tab_group_shared/search.ts): an exact match
	// that ignores case and accents, ranked by where it lands.  nothing here
	// names a browser API, so it runs under node --test.

	// the title counts double the host, as it does in Chrome
export const SearchKeys = [
	{ name: "title", weight: 2 },
	{ name: "host", weight: 1 },
];

	// how far into a field a match still earns score; past it a match only
	// filters the row in
const Distance = 200;

	// with nothing typed, the recently closed section shows this many rows and
	// every match once there is a query.  Chrome's own number.
export const RecentlyClosedShown = 8;

const Quotes = { "‘": "'", "’": "'", "“": "\"", "”": "\"" };


	// folded text plus, for each folded character, the span of the original it
	// came from.  folding can change the length -- a title that spells "é" as
	// "e" plus a combining accent loses the accent -- so a match has to be
	// mapped back before it can be highlighted.
export function fold(
	text)
{
	let folded = "";
	const from = [];
	const to = [];
	let at = 0;

	for (const character of text) {
		const plain = (Quotes[character] ?? character)
			.normalize("NFD")
			.replace(/\p{M}/gu, "")
			.toLowerCase();

		for (let i = 0; i < plain.length; i += 1) {
			from.push(at);
			to.push(at + character.length);
		}

		folded += plain;
		at += character.length;
	}

	return { folded, from, to };
}


	// every non-overlapping occurrence of the query, as ranges of the
	// original text
export function findRanges(
	query,
	text)
{
	const needle = fold(query).folded;

	if (!needle || !text) {
		return [];
	}

	const { folded, from, to } = fold(text);
	const ranges = [];

	for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
		const start = from[at];
		let end = to[at + needle.length - 1];

			// a combining accent folds to nothing, so it would fall outside
			// the range and the highlight would cut the glyph in two
		while (end < text.length && /\p{M}/u.test(text.charAt(end))) {
			end += 1;
		}

		ranges.push({ start, length: end - start });
	}

	return ranges;
}


function isWordStart(
	text,
	index)
{
	return /[^\p{L}\p{N}_]/u.test(text.charAt(index - 1));
}


	// earlier matches score more, and more matches score more
function score(
	highlights)
{
	let total = 0;

	for (const { name, weight } of SearchKeys) {
		for (const { start } of highlights[name] ?? []) {
			total += Math.max((Distance - start) / Distance, 0) * weight;
		}
	}

	return total;
}


	// 0 when a field starts with the query, 1 when a word inside one does, 2
	// for anywhere else.  the tier outranks the score.
function tier(
	record,
	highlights)
{
	let best = 2;

	for (const { name } of SearchKeys) {
		for (const { start } of highlights[name] ?? []) {
			if (start === 0) {
				return 0;
			}

			if (isWordStart(record[name], start)) {
				best = 1;
			}
		}
	}

	return best;
}


	// the matching records, best first, each with the ranges to highlight.
	// an empty query keeps every record in the order given, which for open
	// tabs is the recency order.
export function search(
	query,
	records)
{
	const trimmed = query.trim();

	if (!trimmed) {
		return records.map((record) => ({ record, highlights: {} }));
	}

	const matches = [];

	for (const record of records) {
		const highlights = {};

		for (const { name } of SearchKeys) {
			const ranges = findRanges(trimmed, record[name] ?? "");

			if (ranges.length) {
				highlights[name] = ranges;
			}
		}

		if (Object.keys(highlights).length) {
			matches.push({
				record,
				highlights,
				score: score(highlights),
				tier: tier(record, highlights),
			});
		}
	}

		// sort is stable, so equal scores keep the recency order
	return matches
		.sort((a, b) => a.tier - b.tier || b.score - a.score)
		.map(({ record, highlights }) => ({ record, highlights }));
}


	// what the popup draws: open tabs, then recently closed, each filtered
	// and ranked on its own as Chrome does it
export function results(
	query,
	open,
	closed)
{
	const typed = Boolean(query.trim());
	const closedHits = search(query, closed);

	return {
		open: search(query, open),
		closed: typed ? closedHits : closedHits.slice(0, RecentlyClosedShown),
	};
}


	// one flat list for a renderer that only knows rows: the open matches, then
	// a heading and the closed ones.  each hit carries its highlights; index is
	// the first row that can be chosen, or -1 when nothing matched.
export function rowsFor(
	query,
	open,
	closed)
{
	const hits = results(query, open, closed);
	const withHighlights = ({ record, highlights }) => ({ ...record, highlights });
	const rows = hits.open.map(withHighlights);

	if (hits.closed.length) {
		rows.push({ heading: "Recently closed" }, ...hits.closed.map(withHighlights));
	}

	return { rows, index: rows.findIndex((row) => !row.heading) };
}


	// the next choosable row in a direction, wrapping and stepping over headings
export function move(
	rows,
	index,
	direction)
{
	const { length } = rows;

	for (let offset = 1; offset <= length; offset += 1) {
		const at = (((index + direction * offset) % length) + length) % length;

		if (!rows[at].heading) {
			return at;
		}
	}

	return index;
}
