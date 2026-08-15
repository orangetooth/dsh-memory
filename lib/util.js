/** Small shared helpers. */
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Keep head and tail of a long text, marking the elided middle. */
export function headTail(text, max, headRatio = 0.25) {
    if (text.length <= max)
        return text;
    const head = Math.floor(max * headRatio);
    const tail = max - head - 40;
    return tail <= 0
        ? text.slice(-max)
        : `${text.slice(0, head)}\n…[中间 ${text.length - head - tail} 字符已省略]…\n${text.slice(-tail)}`;
}
//# sourceMappingURL=util.js.map