export interface PaginateOptions {
  maxLineChars?: number
  maxLines?: number
}

// Word-wrap a single line to `width`, hard-splitting any word longer than it.
function wrapLine(line: string, width: number): string[] {
  if (line === '') return ['']
  const out: string[] = []
  let cur = ''
  for (const word of line.split(' ')) {
    const candidate = cur === '' ? word : `${cur} ${word}`
    if (candidate.length <= width) {
      cur = candidate
      continue
    }
    if (cur !== '') { out.push(cur); cur = '' }
    let w = word
    while (w.length > width) { out.push(w.slice(0, width)); w = w.slice(width) }
    cur = w
  }
  if (cur !== '') out.push(cur)
  return out.length ? out : ['']
}

// Split text into lens-sized pages: word-wrap each line to maxLineChars, then
// group the wrapped lines into pages of at most maxLines lines each.
export function paginate(text: string, opts: PaginateOptions = {}): string[] {
  const maxLineChars = opts.maxLineChars ?? 38
  const maxLines = opts.maxLines ?? 5
  const lines: string[] = []
  for (const raw of String(text).split('\n')) {
    for (const wrapped of wrapLine(raw, maxLineChars)) lines.push(wrapped)
  }
  const pages: string[] = []
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines).join('\n'))
  }
  return pages.length ? pages : ['']
}
