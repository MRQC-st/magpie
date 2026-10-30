// 测试垫片：node --test 与 bun test 两边都能跑同一批测试。
//
// node:test 没有 expect，这里用 node:assert 补一个 jest 风格的 expect，
// 语义按 jest 对齐（toEqual 忽略值为 undefined 的键）。
// test 函数按运行时选：bun 下用 bun:test，node 下用 node:test。

import assert from "node:assert/strict"

const runtime = typeof Bun !== "undefined"
  ? await import("bun:test")
  : await import("node:test")

export const test = runtime.test
export const describe = runtime.describe
export const it = runtime.it

const isObject = (v) => v !== null && typeof v === "object"

// jest 的 toEqual：递归比较，忽略值为 undefined 的键（jest 语义，不是 deepStrictEqual）
function looseEqual(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (!isObject(a) || !isObject(b)) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => looseEqual(v, b[i]))
  }
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && looseEqual(a[k], b[k]))
}

const fmt = (v) => {
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

class Expectation {
  constructor(actual, negated = false) {
    this.actual = actual
    this.negated = negated
  }
  get not() { return new Expectation(this.actual, !this.negated) }
  #check(ok, message) {
    if (this.negated ? ok : !ok) {
      throw new assert.AssertionError({ message: this.negated ? `not: ${message}` : message })
    }
  }
  toBe(v) { this.#check(Object.is(this.actual, v), `expected ${fmt(this.actual)} to be ${fmt(v)}`); return this }
  toEqual(v) { this.#check(looseEqual(this.actual, v), `expected ${fmt(this.actual)} to equal ${fmt(v)}`); return this }
  toContain(v) {
    const ok = typeof this.actual === "string"
      ? this.actual.includes(v)
      : Array.isArray(this.actual) && this.actual.some((x) => Object.is(x, v))
    this.#check(ok, `expected ${fmt(this.actual)} to contain ${fmt(v)}`); return this
  }
  toBeUndefined() { this.#check(this.actual === undefined, `expected ${fmt(this.actual)} to be undefined`); return this }
  toBeNull() { this.#check(this.actual === null, `expected ${fmt(this.actual)} to be null`); return this }
  toBeTruthy() { this.#check(!!this.actual, `expected ${fmt(this.actual)} to be truthy`); return this }
  toBeFalsy() { this.#check(!this.actual, `expected ${fmt(this.actual)} to be falsy`); return this }
  toBeGreaterThan(v) { this.#check(this.actual > v, `expected ${fmt(this.actual)} > ${fmt(v)}`); return this }
  toBeGreaterThanOrEqual(v) { this.#check(this.actual >= v, `expected ${fmt(this.actual)} >= ${fmt(v)}`); return this }
  toBeLessThan(v) { this.#check(this.actual < v, `expected ${fmt(this.actual)} < ${fmt(v)}`); return this }
  toBeLessThanOrEqual(v) { this.#check(this.actual <= v, `expected ${fmt(this.actual)} <= ${fmt(v)}`); return this }
  toHaveLength(n) { this.#check(this.actual?.length === n, `expected length ${this.actual?.length} to be ${n}`); return this }
  toMatch(re) {
    const ok = re instanceof RegExp ? re.test(String(this.actual)) : String(this.actual).includes(String(re))
    this.#check(ok, `expected ${fmt(this.actual)} to match ${re}`); return this
  }
  toBeCloseTo(v, digits = 2) {
    const ok = Math.abs(this.actual - v) < Math.pow(10, -digits) / 2
    this.#check(ok, `expected ${fmt(this.actual)} to be close to ${fmt(v)}`); return this
  }
  // toThrow 认同步抛，也认 **async 函数返回的 rejected promise**
  // （capSolve 这类：参数不对是拒绝，不是同步 throw）。
  async toThrow(matcher) {
    let threw = false
    let err = null
    try {
      const r = this.actual()
      if (r && typeof r.then === "function") await r
    } catch (e) {
      threw = true
      err = e
    }
    let ok = threw
    if (threw && matcher !== undefined) {
      const msg = String(err?.message ?? err)
      ok = matcher instanceof RegExp ? matcher.test(msg)
        : typeof matcher === "string" ? msg.includes(matcher)
        : true
    }
    this.#check(ok, `expected the function to throw ${matcher ?? ""}`)
    return this
  }
}

export function expect(actual) { return new Expectation(actual) }
