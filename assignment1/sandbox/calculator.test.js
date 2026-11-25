const test = require("node:test");
const assert = require("node:assert/strict");

const { add, subtract } = require("./calculator");

test("add two numbers", () => {
assert.equal(add(2, 3), 5);
});

test("substract two numbers", () => {
assert.equal(subtract(5, 3), 2);
});
