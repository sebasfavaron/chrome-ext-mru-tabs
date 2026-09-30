import { test } from "node:test";
import assert from "node:assert/strict";
import { findRanges, search, results, rowsFor, move, RecentlyClosedShown } from "../src/search.js";

const titles = (hits) => hits.map((hit) => hit.record.title);

test("matching ignores case and accents", () => {
	assert.deepEqual(findRanges("CAFE", "Un café"), [{ start: 3, length: 4 }]);
	assert.deepEqual(findRanges("café", "CAFE"), [{ start: 0, length: 4 }]);
});

test("a decomposed accent maps back to the original span", () => {
	const text = "Café menu";

	assert.deepEqual(findRanges("menu", text), [{ start: 6, length: 4 }]);
	assert.deepEqual(findRanges("cafe", text), [{ start: 0, length: 5 }]);
});

test("curly quotes match straight ones", () => {
	assert.deepEqual(findRanges("it's", "It’s here"), [{ start: 0, length: 4 }]);
});

test("every non-overlapping occurrence is found", () => {
	assert.deepEqual(findRanges("aa", "aaaa"), [
		{ start: 0, length: 2 },
		{ start: 2, length: 2 },
	]);
});

test("it is an exact match, not a fuzzy one", () => {
	assert.deepEqual(search("gthb", [{ title: "GitHub", host: "github.com" }]), []);
});

test("a match at the start outranks a word start, which outranks the middle", () => {
	const records = [
		{ title: "Unplanned work", host: "" },
		{ title: "My plan", host: "" },
		{ title: "Planning", host: "" },
	];

	assert.deepEqual(titles(search("plan", records)), ["Planning", "My plan", "Unplanned work"]);
});

test("a host that starts with the query counts as a start", () => {
	const records = [
		{ title: "Inbox from gmail", host: "mail.google.com" },
		{ title: "Pull requests", host: "gmail.example" },
	];

	assert.deepEqual(titles(search("gmail", records)), ["Pull requests", "Inbox from gmail"]);
});

test("within a tier the earlier and weightier match wins", () => {
	const records = [
		{ title: "Notes about the deploy", host: "" },
		{ title: "The deploy", host: "" },
	];

	assert.deepEqual(titles(search("deploy", records)), ["The deploy", "Notes about the deploy"]);
});

test("equal matches keep the order they came in", () => {
	const records = [
		{ title: "Docs b", host: "" },
		{ title: "Docs a", host: "" },
	];

	assert.deepEqual(titles(search("docs", records)), ["Docs b", "Docs a"]);
});

test("an empty query keeps every record in order", () => {
	const records = [{ title: "b" }, { title: "a" }];

	assert.deepEqual(titles(search("  ", records)), ["b", "a"]);
});

test("the highlights name the field and range that matched", () => {
	const [hit] = search("hub", [{ title: "GitHub", host: "github.com" }]);

	assert.deepEqual(hit.highlights, {
		title: [{ start: 3, length: 3 }],
		host: [{ start: 3, length: 3 }],
	});
});

test("recently closed is capped only while nothing is typed", () => {
	const closed = Array.from({ length: 20 }, (_, i) => ({ title: `closed ${i}`, host: "" }));

	assert.equal(results("", [], closed).closed.length, RecentlyClosedShown);
	assert.equal(results("closed", [], closed).closed.length, 20);
});

test("open and closed are ranked separately", () => {
	const open = [{ title: "xx deploy", host: "" }];
	const closed = [{ title: "deploy", host: "" }];
	const { open: openHits, closed: closedHits } = results("deploy", open, closed);

	assert.deepEqual(titles(openHits), ["xx deploy"]);
	assert.deepEqual(titles(closedHits), ["deploy"]);
});


test("rows put the closed matches under a heading", () => {
	const { rows, index } = rowsFor("", [{ title: "a" }], [{ title: "b", sessionId: "1" }]);

	assert.deepEqual(rows.map((row) => row.heading ?? row.title), ["a", "Recently closed", "b"]);
	assert.equal(index, 0);
});

test("with only closed matches the first choosable row is below the heading", () => {
	const { rows, index } = rowsFor("b", [{ title: "a" }], [{ title: "b" }]);

	assert.equal(rows[index].title, "b");
});

test("nothing matching leaves nothing to choose", () => {
	assert.deepEqual(rowsFor("zzz", [{ title: "a" }], []), { rows: [], index: -1 });
});

test("moving steps over the heading and wraps both ways", () => {
	const rows = [{ title: "a" }, { heading: "Recently closed" }, { title: "b" }];

	assert.equal(move(rows, 0, 1), 2);
	assert.equal(move(rows, 2, 1), 0);
	assert.equal(move(rows, 0, -1), 2);
});
