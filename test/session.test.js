import { test } from "node:test";
import assert from "node:assert/strict";
import {
	start,
	step,
	selected,
	commitPolicy,
	rowWindow,
	settleDelay,
	SETTLE_MS,
	SETTLE_READING_MS,
} from "../src/session.js";

test("a forward gesture starts on the previous tab", () => {
	assert.equal(selected(start([1, 2, 3], 1)), 2);
});

test("a backward gesture starts on the oldest tab", () => {
	assert.equal(selected(start([1, 2, 3], -1)), 3);
});

test("there is no gesture with fewer than two tabs", () => {
	assert.equal(start([1], 1), null);
	assert.equal(start([], 1), null);
});

test("stepping forward wraps past the end", () => {
	let s = start([1, 2, 3], 1);
	s = step(s, 1);
	s = step(s, 1);
	assert.equal(selected(s), 1);
});

test("stepping backward wraps past the front", () => {
	const s = step(start([1, 2, 3], 1), -1);
	assert.equal(selected(s), 1);
});

test("the order is frozen for the life of a gesture", () => {
	const order = [1, 2, 3];
	const s = step(start(order, 1), 1);
	assert.deepEqual(s.order, [1, 2, 3]);
	assert.deepEqual(order, [1, 2, 3]);
});

test("no content script means blind stepping", () => {
	assert.equal(commitPolicy({ hasContentScript: false, ctrlDown: true }), "blind");
	assert.equal(commitPolicy({ hasContentScript: false, ctrlDown: false }), "blind");
});

test("an unreadable modifier commits on settle", () => {
	assert.equal(commitPolicy({ hasContentScript: true, ctrlDown: false }), "settle");
});

test("a held modifier commits on release", () => {
	assert.equal(commitPolicy({ hasContentScript: true, ctrlDown: true }), "release");
});

test("a short list is drawn whole", () => {
	assert.deepEqual(rowWindow(0, 4, 12), { from: 0, to: 4 });
});

test("a long list scrolls to keep the highlight inside", () => {
	assert.deepEqual(rowWindow(0, 40, 12), { from: 0, to: 12 });
	assert.deepEqual(rowWindow(39, 40, 12), { from: 28, to: 40 });
	assert.deepEqual(rowWindow(20, 40, 12), { from: 14, to: 26 });
});


test("one tap lands straight away, a walk gets time to read", () => {
	assert.equal(settleDelay(1), SETTLE_MS);
	assert.equal(settleDelay(2), SETTLE_READING_MS);
	assert.equal(settleDelay(7), SETTLE_READING_MS);
});
