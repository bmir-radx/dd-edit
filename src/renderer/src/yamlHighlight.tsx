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

function highlightLine(line: string): ReactNode {
  // Whole-line comment.
  const commentOnly = /^\s*#/.test(line)
  if (commentOnly) return <span className="y-comment">{line}</span>

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

/** Render highlighted YAML as an array of line nodes (newlines preserved). */
export function highlightYaml(text: string): ReactNode {
  const lines = text.split('\n')
  return lines.map((line, i) => (
    <Fragment key={i}>
      {highlightLine(line)}
      {i < lines.length - 1 ? '\n' : null}
    </Fragment>
  ))
}
