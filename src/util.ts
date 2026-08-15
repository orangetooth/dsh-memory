/** Small shared helpers. */

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep head and tail of a long text, marking the elided middle. */
export function headTail(text: string, max: number, headRatio = 0.25): string {
  if (text.length <= max) return text
  const head = Math.floor(max * headRatio)
  const tail = max - head - 40
  return tail <= 0
    ? text.slice(-max)
    : `${text.slice(0, head)}\n…[中间 ${text.length - head - tail} 字符已省略]…\n${text.slice(-tail)}`
}
