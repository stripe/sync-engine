export function createHash(algorithm: string) {
  let data = ''
  return {
    update(input: string) { data += input; return this },
    async digest(encoding: string) {
      const encoder = new TextEncoder()
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data))
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      if (encoding === 'hex') return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
      return hashArray
    },
  }
}

export function createHmac(algorithm: string, key: string) {
  let data = ''
  return {
    update(input: string) { data += input; return this },
    digest(encoding: string) {
      // Synchronous HMAC not available in browser — return placeholder
      // This is only used for webhook verification which isn't needed in browser
      console.warn('createHmac: browser shim — webhook verification disabled')
      return ''
    },
  }
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a[i]! ^ b[i]!
  return result === 0
}

export default { createHash, createHmac, timingSafeEqual }
