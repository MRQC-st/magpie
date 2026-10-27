// 版本号动态解析补测：T20。
// env 优先 → asar 真版本 → 回退常量（只 warn 一次）。
import { test, expect } from "./harness.mjs"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { clientVersion, FALLBACK_CLIENT_VERSION } from "../lib/version.mjs"

const VERSION_MOD = fileURLToPath(new URL("../lib/version.mjs", import.meta.url))

// 合成一个最小 asar：布局 [u32 picklelen][u32][u32][u32 headerJsonLen][header JSON][data]
function makeAsar(dir, version) {
  const pkg = JSON.stringify({ name: "lobster", version })
  const header = JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "0" } } })
  const hb = Buffer.from(header, "utf8")
  const head = Buffer.alloc(16)
  head.writeUInt32LE(hb.length + 8, 0)
  head.writeUInt32LE(hb.length, 12)
  const file = join(dir, "app.asar")
  writeFileSync(file, Buffer.concat([head, hb, Buffer.from(pkg, "utf8")]))
  return file
}

test("T20 env 里的版本号优先于一切", () => {
  const warns = []
  const v = clientVersion({
    reset: true,
    env: { LOBSTER_CLIENT_VERSION: "2030.1.2" },
    log: (level, message) => warns.push(String(message)),
  })
  expect(v).toBe("2030.1.2")
})

test("T20 版本号跟着客户端 asar 走，不是写死的常量", () => {
  const dir = mkdtempSync(join(tmpdir(), "lobster-asar-"))
  try {
    const asar = makeAsar(dir, "2031.4.5")
    const v = clientVersion({
      reset: true,
      env: { LOBSTER_ASAR_PATH: asar },
      log: () => {},
    })
    expect(v).toBe("2031.4.5")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 「读不到 asar」这条分支必须**隔离地**测：真机上装了客户端，asar 是能读的，
// 直接调会走真版本而不是回退分支。所以在子进程里把 node:fs 的 openSync 打补丁，
// 让所有 app.asar 都读不到 —— 子进程还顺带隔离了 version.mjs 的模块级缓存。
const CHILD = [
  'const fs = process.getBuiltinModule ? process.getBuiltinModule("node:fs") : require("node:fs")',
  'const real = fs.openSync',
  'fs.openSync = (p, ...rest) => {',
  '  if (String(p).endsWith("app.asar")) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e }',
  '  return real(p, ...rest)',
  '}',
  'const mod = await import(process.argv[2])',
  'const warns = []',
  'const log = (level, message) => warns.push(String(message))',
  'const v1 = mod.clientVersion({ env: {}, log })',
  'const v2 = mod.clientVersion({ env: {}, log })',
  'process.stdout.write(JSON.stringify({ v1, v2, warns }))',
].join("\n")

test("T20 读不到 asar 时回退常量，且只 warn 一次", () => {
  const dir = mkdtempSync(join(tmpdir(), "lobster-ver-"))
  try {
    const script = join(dir, "child.mjs")
    writeFileSync(script, CHILD)
    const r = spawnSync(process.execPath, [script, pathToFileURL(VERSION_MOD).href], {
      encoding: "utf8",
    })
    const out = JSON.parse(r.stdout || "{}")
    // 第一次回退并 warn，第二次命中缓存，不再 warn
    expect(out.v1).toBe(FALLBACK_CLIENT_VERSION)
    expect(out.v2).toBe(FALLBACK_CLIENT_VERSION)
    expect(out.warns.length).toBe(1)
    expect(out.warns[0]).toContain("回退常量")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
