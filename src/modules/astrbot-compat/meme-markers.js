// Small source-preserving subset of meme_manager's &&category&& protocol.
// Marker-looking text inside fenced or inline Markdown code stays untouched.
export function mapMemeMarkers(input, resolve) {
  const text = String(input || '')
  let out = ''
  let i = 0
  let lineStart = true
  let fence = null

  while (i < text.length) {
    if (lineStart && !fence) {
      const m = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(text.slice(i))
      if (m) {
        fence = { char: m[2][0], size: m[2].length }
        out += m[0]
        i += m[0].length
        lineStart = true
        continue
      }
    } else if (lineStart && fence) {
      const m = /^( {0,3})(`{3,}|~{3,})[ \t]*\r?\n/.exec(text.slice(i))
      if (m && m[2][0] === fence.char && m[2].length >= fence.size) {
        out += m[0]
        i += m[0].length
        lineStart = true
        fence = null
        continue
      }
    }

    if (!fence && text[i] === '`') {
      let n = 1
      while (text[i + n] === '`') n++
      const delimiter = '`'.repeat(n)
      const end = text.indexOf(delimiter, i + n)
      if (end >= 0) {
        const raw = text.slice(i, end + n)
        out += raw
        i += raw.length
        lineStart = raw.endsWith('\n')
        continue
      }
    }

    if (!fence && text.startsWith('&&', i)) {
      let slashes = 0
      for (let p = i - 1; p >= 0 && text[p] === '\\'; p--) slashes++
      const end = text.indexOf('&&', i + 2)
      if (!(slashes % 2) && end > i + 2 && end - i <= 258 && !/[\r\n&]/.test(text.slice(i + 2, end))) {
        const raw = text.slice(i, end + 2)
        const replacement = resolve(text.slice(i + 2, end).trim())
        out += replacement == null ? raw : replacement
        i = end + 2
        lineStart = false
        continue
      }
    }

    const c = text[i++]
    out += c
    lineStart = c === '\n'
  }
  return out
}
