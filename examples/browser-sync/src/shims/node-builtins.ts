// Shims for node:fs, node:fs/promises, node:path, node:os, node:net, node:stream, node:http
// These are imported by engine code but not exercised in the browser PGlite path

export function readFileSync() { throw new Error('fs not available in browser') }
export function writeFileSync() { throw new Error('fs not available in browser') }
export function mkdirSync() { throw new Error('fs not available in browser') }
export function existsSync() { return false }
export function openSync() { return -1 }
export function closeSync() {}
export async function readFile() { throw new Error('fs not available in browser') }
export async function writeFile() { throw new Error('fs not available in browser') }
export async function access() { throw new Error('fs not available in browser') }
export default { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, readFile, writeFile, access, promises: { readFile, writeFile, access } }
