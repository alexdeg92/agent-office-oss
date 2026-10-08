'use strict';
// A value that must never be serialised, logged or inspected (engine.md §3.6). Only .reveal() returns it.
const util = require('util');

class Secret {
  #value;
  constructor(value) { this.#value = value; }
  reveal() { return this.#value; }
  get present() { return this.#value != null && this.#value !== ''; }
  toJSON() { return '[secret]'; }
  toString() { return '[secret]'; }
  [util.inspect.custom]() { return '[secret]'; }
}

module.exports = { Secret };
