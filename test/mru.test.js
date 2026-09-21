import { test } from "node:test";
import assert from "node:assert/strict";
import { touch, remove, reconcile, insertNext } from "../src/mru.js";

test("touch moves an existing tab to the front", () => {
	assert.deepEqual(touch([1, 2, 3], 3), [3, 1, 2]);
});

test("touch adds an unknown tab at the front", () => {
	assert.deepEqual(touch([1, 2], 9), [9, 1, 2]);
});

test("touch does not mutate its input", () => {
	const order = [1, 2, 3];
	touch(order, 3);
	assert.deepEqual(order, [1, 2, 3]);
});

test("remove drops a tab and leaves the rest in order", () => {
	assert.deepEqual(remove([1, 2, 3], 2), [1, 3]);
});

test("reconcile drops dead tabs and appends unseen live ones", () => {
	assert.deepEqual(reconcile([1, 2, 3], [3, 1, 7]), [1, 3, 7]);
});

test("reconcile of an empty order keeps the live ids", () => {
	assert.deepEqual(reconcile([], [4, 5]), [4, 5]);
});

test("a new tab goes one behind the current one, within reach of a single step", () => {
	assert.deepEqual(insertNext([1, 2, 3], 9), [1, 9, 2, 3]);
});

test("a new tab in an empty order is the only tab", () => {
	assert.deepEqual(insertNext([], 9), [9]);
});

test("a new tab alongside one other lands second", () => {
	assert.deepEqual(insertNext([1], 9), [1, 9]);
});

test("insertNext never duplicates a tab already in the order", () => {
	assert.deepEqual(insertNext([1, 2, 3], 3), [1, 3, 2]);
});

test("insertNext does not mutate its input", () => {
	const order = [1, 2, 3];
	insertNext(order, 9);
	assert.deepEqual(order, [1, 2, 3]);
});
