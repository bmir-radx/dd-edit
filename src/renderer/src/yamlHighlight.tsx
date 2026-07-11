/**
 * Minimal YAML syntax highlighter for the read-only preview. Line-oriented and
 * deliberately simple — it colors the common shapes (comments, keys, list
 * markers, quoted strings, numbers, booleans/null) well enough to read a
 * generated LinkML schema; it is not a full YAML parser.
 */
import { Fragment, type ReactNode } from 'react'

const KEY_RE = /^(\s*)(-\s+)?([A-Za-z0-9_.$-]+)(:)(\s|$)/
const SCALAR_KEYWORD = /^(true|false|null|yes|no|~)$/i
const NUMBER_RE = /^-?\d+(\.\d+)?$/

function highlightScalar(value: string, keyPrefix = ' '): ReactNode {
  const trimmed = value.trim()
  if (trimmed === '') return value
  let cls = 'y-str'
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    cls = 'y-str'
  } else if (SCALAR_KEYWORD.test(trimmed)) {
    cls = 'y-kw'
  } else if (NUMBER_RE.test(trimmed)) {
    cls = 'y-num'
  } else {
    cls = 'y-plain'
  }
  // Preserve leading whitespace between the colon and the value.
  const lead = value.slice(0, value.length - value.trimStart().length)
  return (
    <>
      {keyPrefix}
      {lead}
      <span className={cls}>{trimmed}</span>
    </>
  )
}

// A block scalar indicator: `|`, `>`, with optional chomping/indent (|-, >2),
// possibly followed only by a comment. When a value is one of these, the
// indented lines that follow are literal string content.
const BLOCK_SCALAR = /^[|>][+-]?\d?(\s+#.*)?$/

const indentOf = (line: string): number => line.length - line.trimStart().length

function highlightLine(line: string): ReactNode {
  // Whole-line comment.
  if (/^\s*#/.test(line)) return <span className="y-comment">{line}</span>

  const m = KEY_RE.exec(line)
  if (m) {
    const [, indent, dash, key, colon] = m
    const after = line.slice(m[0].length - (m[5] === '' ? 0 : m[5].length))
    // Split a trailing inline comment out of the value so it colors too.
    const hashAt = after.indexOf(' #')
    const valuePart = hashAt >= 0 ? after.slice(0, hashAt) : after
    const comment = hashAt >= 0 ? after.slice(hashAt) : ''
    return (
      <>
        {indent}
        {dash ? <span className="y-dash">{dash}</span> : null}
        <span className="y-key">{key}</span>
        <span className="y-punct">{colon}</span>
        {valuePart ? highlightScalar(valuePart, '') : null}
        {comment ? <span className="y-comment">{comment}</span> : null}
      </>
    )
  }

  // A bare list item: "- value"
  const listM = /^(\s*)(-\s+)(.*)$/.exec(line)
  if (listM) {
    const [, indent, dash, rest] = listM
    return (
      <>
        {indent}
        <span className="y-dash">{dash}</span>
        {highlightScalar(rest, '')}
      </>
    )
  }

  return line
}

/** The value part of a "key: value" or "- value" line, for block detection. */
function valueOfLine(line: string): string | null {
  const m = KEY_RE.exec(line)
  if (m) {
    const after = line.slice(m[0].length - (m[5] === '' ? 0 : m[5].length))
    return after.trim()
  }
  const listM = /^(\s*)(-\s+)(.*)$/.exec(line)
  if (listM) return listM[3].trim()
  return null
}

/**
 * Render highlighted YAML, newline-preserving. Stateful across lines so block
 * scalars (`key: |-` / `>`), whose following indented lines are literal
 * string content, get the string color rather than falling through as plain.
 */
export function highlightYaml(text: string): ReactNode {
  const lines = text.split('\n')
  // Indent of the key that opened the current block scalar, or null.
  let blockIndent: number | null = null

  return lines.map((line, i) => {
    let node: ReactNode

    if (blockIndent !== null) {
      // Inside a block scalar: blank lines and lines indented deeper than the
      // opener stay content; anything at/left of the opener ends the block.
      if (line.trim() === '' || indentOf(line) > blockIndent) {
        node = line === '' ? line : <span className="y-str">{line}</span>
      } else {
        blockIndent = null
      }
    }

    if (node === undefined) {
      node = highlightLine(line)
      const value = valueOfLine(line)
      if (value !== null && BLOCK_SCALAR.test(value)) blockIndent = indentOf(line)
    }

    return (
      <Fragment key={i}>
        {node}
        {i < lines.length - 1 ? '\n' : null}
      </Fragment>
    )
  })
}
