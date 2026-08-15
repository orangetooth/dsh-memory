/** Memory folder layout and file operations (Codex artifact parity, DSH-root adapted). */

import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { isWithin } from './paths.js'
import type { FileEntry } from './types.js'

const DIRS = ['rollout_summaries', 'skills', 'extensions/ad_hoc/notes'] as const

/**
 * Owns the memory directory:
 *
 * - memory_summary.md    dense, always-injected navigation layer
 * - MEMORY.md            grep-friendly handbook of consolidated memory
 * - raw_memories.md      Phase 1 output awaiting Phase 2 consolidation
 * - raw_memories.archive.md  rotated history of consolidated raw blocks
 * - rollout_summaries/   per-session recaps (evidence layer)
 * - skills/              reusable procedures promoted by consolidation
 * - extensions/ad_hoc/notes/  user-requested ad hoc notes
 */
export class MemoryFiles {
  constructor(readonly root: string) {}

  async ensureLayout(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const dir of DIRS) await mkdir(join(this.root, dir), { recursive: true })
  }

  /** Resolve a memory-relative path; rejects anything escaping the root. */
  rel(relPath: string): string {
    if (relPath === '' || relPath.startsWith('/') || relPath.startsWith('\\') || /^[A-Za-z]:/.test(relPath)) {
      throw new Error(`memory path must be relative: ${relPath}`)
    }
    const resolved = resolve(this.root, relPath)
    if (!isWithin(this.root, resolved)) {
      throw new Error(`memory path escapes the memory root: ${relPath}`)
    }
    return resolved
  }

  async readIfExists(relPath: string, cap = 2_000_000): Promise<string | undefined> {
    try {
      const text = await readFile(this.rel(relPath), 'utf8')
      return text.length > cap ? text.slice(0, cap) : text
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async writeAtomic(relPath: string, content: string): Promise<void> {
    const target = this.rel(relPath)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, content, 'utf8')
    try {
      await rename(temp, target)
    } catch (error: unknown) {
      await writeFile(temp, '', 'utf8').catch(() => {})
      throw error
    }
  }

  async appendText(relPath: string, content: string): Promise<void> {
    const target = this.rel(relPath)
    await mkdir(dirname(target), { recursive: true })
    await appendFile(target, content, 'utf8')
  }

  /** Move raw_memories.md into the archive and reset it for the next batch. */
  async rotateRaw(): Promise<void> {
    const raw = await this.readIfExists('raw_memories.md')
    if (raw === undefined || raw.trim() === '') return
    const stamp = new Date().toISOString()
    await this.appendText('raw_memories.archive.md', `\n<!-- archived at ${stamp} -->\n${raw.trimEnd()}\n`)
    await this.writeAtomic('raw_memories.md', `<!-- archived at ${stamp}; full history in raw_memories.archive.md -->\n`)
  }

  /** Pick a unique rollout summary filename inside rollout_summaries/. */
  async uniqueRolloutSlug(slug: string, sessionId: string): Promise<string> {
    const base = slug.slice(0, 80)
    const existing = await this.readIfExists(`rollout_summaries/${base}.md`, 1)
    if (existing === undefined) return base
    return `${base.slice(0, 72)}-${sessionId.slice(-8)}`
  }

  async listTree(subPath = ''): Promise<FileEntry[]> {
    const entries: FileEntry[] = []
    const base = subPath === '' ? this.root : this.rel(subPath)
    const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
      if (depth > 4 || entries.length >= 600) return
      let names: Dirent[]
      try {
        names = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of names) {
        if (item.name.endsWith('.tmp')) continue
        const abs = join(dir, item.name)
        const rel = relDir === '' ? item.name : `${relDir}/${item.name}`
        if (item.isDirectory()) {
          entries.push({ path: rel, kind: 'dir', size: 0, modifiedAt: 0 })
          await walk(abs, rel, depth + 1)
        } else {
          const info = await stat(abs).catch(() => undefined)
          entries.push({
            path: rel,
            kind: 'file',
            size: info?.size ?? 0,
            modifiedAt: info?.mtimeMs ?? 0,
          })
        }
      }
    }
    await walk(base, '', 0)
    return entries.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1))
  }

  async rolloutIndex(limit = 120): Promise<string[]> {
    const entries = await this.listTree('rollout_summaries')
    const lines: string[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.path.endsWith('.md')) continue
      const content = await this.readIfExists(`rollout_summaries/${entry.path.split('/').pop() ?? ''}`, 4_000)
      const firstLine = content?.split(/\r?\n/).map(line => line.trim()).find(line => line !== '' && !line.startsWith('<!--'))
      lines.push(`- ${entry.path}${firstLine === undefined ? '' : ` — ${firstLine.slice(0, 120)}`}`)
      if (lines.length >= limit) break
    }
    return lines
  }

  async stats(): Promise<{
    summaryChars: number
    memoryChars: number
    rawChars: number
    archiveChars: number
    rollouts: number
    skills: number
    notes: number
  }> {
    const [summary, memory, raw, archive] = await Promise.all([
      this.readIfExists('memory_summary.md', 10_000_000),
      this.readIfExists('MEMORY.md', 10_000_000),
      this.readIfExists('raw_memories.md', 10_000_000),
      this.readIfExists('raw_memories.archive.md', 10_000_000),
    ])
    const rollouts = await this.listTree('rollout_summaries')
    const skills = await this.listTree('skills')
    const notes = await this.listTree('extensions/ad_hoc/notes')
    const fileCount = (entries: FileEntry[]): number => entries.filter(entry => entry.kind === 'file').length
    return {
      summaryChars: summary?.length ?? 0,
      memoryChars: memory?.length ?? 0,
      rawChars: raw?.length ?? 0,
      archiveChars: archive?.length ?? 0,
      rollouts: fileCount(rollouts),
      skills: fileCount(skills),
      notes: fileCount(notes),
    }
  }

  /** Join a sub-path with a platform-agnostic separator for display. */
  static joinDisplay(...parts: string[]): string {
    return parts.filter(part => part !== '').join('/')
  }
}

/** Whether a filename belongs to the memory summary artifacts. */
export function isMemoryFilename(name: string): boolean {
  return name === 'memory_summary.md' || name === 'MEMORY.md'
}

/** Validate that a candidate summary begins with the exact `v1` first line. */
export function ensureSummaryV1(content: string): string {
  const firstLine = content.trimStart().split(/\r?\n/, 1)[0] ?? ''
  if (firstLine === 'v1') return content
  return `v1\n${content.trimStart()}`
}

/** Convenience re-export so tests can reach the separator without a platform guess. */
export { sep as memoryPathSep }
