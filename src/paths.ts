/** Memory-root path handling. */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Default memory root: `$DSH_HOME/memories`, falling back to `~/.dsh/memories`. */
export function defaultMemoryRoot(): string {
  const env = process.env.DSH_HOME?.trim()
  const home = env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
  return join(home, 'memories')
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/** Resolve the configured memory root; an empty value falls back to the default. */
export function resolveMemoryRoot(configured?: string): string {
  if (configured === undefined || configured.trim() === '') return defaultMemoryRoot()
  return resolve(expandHome(configured.trim()))
}

/** Containment check used by the memory-path guard. */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Normalize a model-supplied slug into a filesystem-safe token. */
export function sanitizeSlug(input: string, fallback: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (cleaned !== '') return cleaned
  const fallbackCleaned = fallback
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return fallbackCleaned === '' ? 'session' : fallbackCleaned
}
