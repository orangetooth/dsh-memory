/** Read path: system-prompt injection of the memory guide plus the summary cache. */

import type { Config } from './config.js'
import type { MemoryFiles } from './files.js'

export interface SystemPromptRuntime {
  section(section: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void
}

/** Tool guidance sections live in the 100–199 order band. */
export const GUIDE_ORDER = 160

/** Build the injected section text: compact usage guide plus the bounded summary. */
export function buildSectionText(root: string, summary: string | undefined, cap: number): string {
  const lines = [
    '【长期记忆（dsh-memory 插件）】',
    `本会话可访问长期记忆库 ${root}（跨会话沉淀的用户偏好、项目事实与经验）。`,
    '- 开始新任务或遇到拿不准的约定时，先用 memory_search 搜关键词，再用 memory_read 读相关文件。',
    '- memory_summary.md 是导航索引（若已生成，注入在下方）；MEMORY.md 是检索手册；rollout_summaries/ 是历史会话回顾；skills/ 是已固化的流程。',
    '- memory_add 只应在用户明确要求更新记忆时使用。',
    '- 基于记忆作答时，若未在本次会话验证，请说明该结论来自历史记忆、可能过时。',
  ]
  if (summary !== undefined && summary.trim() !== '') {
    const trimmed = summary.trim()
    const bounded = trimmed.length > cap
      ? `${trimmed.slice(0, cap)}\n…（摘要过长已截断，可用 memory_read 查看完整文件）`
      : trimmed
    lines.push('', '当前记忆摘要（memory_summary.md）：', bounded)
  } else {
    lines.push('', '记忆库目前为空：尚未完成首次整合，memory_* 工具仍可用。')
  }
  return lines.join('\n')
}

/**
 * Owns the injected section. The section text is a provider evaluated at each
 * assembly, so re-registration is never needed; a summary cache avoids file I/O
 * on the assembly hot path.
 */
export class MemoryInjection {
  private summary: string | undefined
  private disposer: (() => void) | undefined

  constructor(
    private readonly files: MemoryFiles,
    private readonly config: () => Config,
  ) {}

  async reload(): Promise<void> {
    this.summary = (await this.files.readIfExists('memory_summary.md', 200_000)) ?? undefined
  }

  install(systemPrompt: SystemPromptRuntime): void {
    if (this.disposer !== undefined) return
    this.disposer = systemPrompt.section({
      name: 'dsh-memory:guide',
      order: GUIDE_ORDER,
      text: () => buildSectionText(this.files.root, this.summary, this.config().maxSummaryChars),
    })
  }

  dispose(): void {
    this.disposer?.()
    this.disposer = undefined
  }
}
