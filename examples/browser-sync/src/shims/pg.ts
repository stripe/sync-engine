// Stub for 'pg' — the PGlite path never actually uses pg.Pool
const Pool = class {
  constructor() { throw new Error('pg.Pool is not available in browser — use PGlite') }
}
export default { Pool }
export { Pool }
