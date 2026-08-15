import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryFiles } from '../src/files.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function makeFiles(): Promise<MemoryFiles> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-files-'))
  return new MemoryFiles(root)
}

describe('MemoryFiles', () => {
  it('creates the standard layout', async () => {
    const files = await makeFiles()
    await files.ensureLayout()
    expect(await files.readIfExists('memory_summary.md')).toBeUndefined()
    const tree = await files.listTree()
    expect(tree.some(entry => entry.path === 'rollout_summaries' && entry.kind === 'dir')).toBe(true)
    expect(tree.some(entry => entry.path === 'extensions/ad_hoc/notes' && entry.kind === 'dir')).toBe(true)
  })

  it('writes and reads atomically', async () => {
    const files = await makeFiles()
    await files.ensureLayout()
    await files.writeAtomic('MEMORY.md', '# memory\n')
    expect(await files.readIfExists('MEMORY.md')).toBe('# memory\n')
  })

  it('rejects paths escaping the root', async () => {
    const files = await makeFiles()
    expect(() => files.rel('../outside.md')).toThrow('escapes')
    expect(() => files.rel('C:/outside.md')).toThrow('relative')
    expect(() => files.rel('/etc/passwd')).toThrow('relative')
    expect(() => files.rel('a/../../outside.md')).toThrow('escapes')
    expect(files.rel('rollout_summaries/x.md')).toBe(join(root!, 'rollout_summaries', 'x.md'))
  })

  it('appends raw blocks and rotates them into the archive', async () => {
    const files = await makeFiles()
    await files.ensureLayout()
    await files.appendText('raw_memories.md', 'block one\n')
    await files.appendText('raw_memories.md', 'block two\n')
    await files.rotateRaw()
    const raw = await files.readIfExists('raw_memories.md')
    const archive = await files.readIfExists('raw_memories.archive.md')
    expect(raw).toContain('archived at')
    expect(raw).not.toContain('block one')
    expect(archive).toContain('block one')
    expect(archive).toContain('block two')
  })

  it('makes rollout slugs unique per session', async () => {
    const files = await makeFiles()
    await files.ensureLayout()
    await files.writeAtomic('rollout_summaries/demo.md', 'x')
    const first = await files.uniqueRolloutSlug('demo', 'session-aaaaaaaa')
    expect(first).not.toBe('demo')
    expect(first).toContain('demo')
    expect(first).toContain('aaaaaaaa')
  })

  it('collects file stats', async () => {
    const files = await makeFiles()
    await files.ensureLayout()
    await files.writeAtomic('MEMORY.md', 'memory')
    await files.writeAtomic('memory_summary.md', 'v1\nsummary')
    await files.writeAtomic('rollout_summaries/a.md', 'a')
    await files.writeAtomic('rollout_summaries/b.md', 'b')
    const stats = await files.stats()
    expect(stats.memoryChars).toBe(6)
    expect(stats.summaryChars).toBeGreaterThan(0)
    expect(stats.rollouts).toBe(2)
  })
})
