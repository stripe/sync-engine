/**
 * Compute sync order via topological sort (Kahn's algorithm).
 */
export function computeResourceOrder(
  resources: Record<string, { dependencies?: string[] }>
): Map<string, number> {
  const names = Object.keys(resources)
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const name of names) {
    inDegree.set(name, 0)
    dependents.set(name, [])
  }

  for (const name of names) {
    for (const dep of resources[name].dependencies ?? []) {
      if (dependents.has(dep)) {
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1)
        dependents.get(dep)!.push(name)
      }
    }
  }

  const queue: string[] = names.filter((n) => inDegree.get(n) === 0)
  const orderMap = new Map<string, number>()
  let order = 1

  let front = 0
  while (front < queue.length) {
    const current = queue[front++]
    orderMap.set(current, order++)

    for (const dependent of dependents.get(current) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1
      inDegree.set(dependent, newDeg)
      if (newDeg === 0) {
        queue.push(dependent)
      }
    }
  }

  if (orderMap.size !== names.length) {
    const missing = names.filter((n) => !orderMap.has(n))
    throw new Error(`Circular dependency detected among: ${missing.join(', ')}`)
  }

  return orderMap
}
