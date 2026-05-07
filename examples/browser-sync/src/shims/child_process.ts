export function spawn() {
  throw new Error('child_process.spawn is not available in browser')
}
export function exec() {
  throw new Error('child_process.exec is not available in browser')
}
export function execSync() {
  throw new Error('child_process.execSync is not available in browser')
}
export default { spawn, exec, execSync }
