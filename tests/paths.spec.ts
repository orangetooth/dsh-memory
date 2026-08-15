import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultMemoryRoot, isWithin, resolveMemoryRoot, sanitizeSlug } from '../src/paths.js'

const originalDshHome = process.env.DSH_HOME

afterEach(() => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

describe('paths', () => {
  it('defaults the memory root under DSH_HOME', () => {
    process.env.DSH_HOME = 'C:/dsh-home'
    expect(defaultMemoryRoot()).toBe(join('C:/dsh-home', 'memories'))
  })

  it('falls back to ~/.dsh/memories without DSH_HOME', () => {
    delete process.env.DSH_HOME
    expect(defaultMemoryRoot()).toBe(join(homedir(), '.dsh', 'memories'))
  })

  it('resolves an explicit root and expands ~', () => {
    const explicit = resolveMemoryRoot('~/memory-store')
    expect(explicit).toBe(join(homedir(), 'memory-store'))
  })

  it('falls back to the default for an empty configured root', () => {
    process.env.DSH_HOME = 'C:/dsh-home'
    expect(resolveMemoryRoot('')).toBe(join('C:/dsh-home', 'memories'))
    expect(resolveMemoryRoot(undefined)).toBe(join('C:/dsh-home', 'memories'))
  })

  it('normalizes slugs into filesystem-safe tokens', () => {
    expect(sanitizeSlug('My Session 1!', 'fallback')).toBe('my-session-1')
    expect(sanitizeSlug('', 'Sess-123')).toBe('sess-123')
    expect(sanitizeSlug('!!!', 'x')).toBe('x')
    expect(sanitizeSlug('!!!', '!!!')).toBe('session')
  })

  it('checks path containment', () => {
    expect(isWithin('C:/root', 'C:/root/a/b')).toBe(true)
    expect(isWithin('C:/root', 'C:/root')).toBe(true)
    expect(isWithin('C:/root', 'C:/rooter/x')).toBe(false)
    expect(isWithin('C:/root', 'C:/other')).toBe(false)
  })
})
