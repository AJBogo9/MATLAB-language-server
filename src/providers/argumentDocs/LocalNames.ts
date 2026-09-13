// Copyright 2026 Andreas Bogossian

import { classifyLine, TokenContext } from '../hover/CommentStringScanner'

// The parameter list of an anonymous function
const ANONYMOUS_PARAMETERS = /@\(([^)]*)\)/g
// A statement that declares names without assigning them
const DECLARING_STATEMENT = /(?:^|[;,])\s*(?:global|persistent|catch)\b[^;,]*/g

/**
 * Whether a document uses a name as a variable: a parameter or output of a function it declares,
 * a parameter of an anonymous function, a global or persistent variable, the identifier of a catch,
 * or the target of an assignment anywhere in it.
 *
 * Hover asks this only when the index cannot classify a name, to decide whether a function file of
 * that name may describe it. It is deliberately generous: a wrong yes keeps the card hover gave
 * before, and a wrong no gives a local variable the card of an unrelated file.
 *
 * @param lines The document split into lines
 * @param name The name, without qualifiers
 * @returns True when the document declares or assigns the name
 */
export function isLocalName (lines: string[], name: string): boolean {
    // A topic component is an identifier, so it needs no escaping
    const word = new RegExp('(?:^|[^\\w.])' + name + '(?!\\w)')
    return lines.some(line => {
        const code = codeOf(line)
        if (/^\s*function\b/.test(code)) {
            return word.test(code)
        }
        const declared = [...(code.match(ANONYMOUS_PARAMETERS) ?? []), ...(code.match(DECLARING_STATEMENT) ?? [])]
        return [...assignmentTargets(code), ...declared].some(target => word.test(target))
    })
}

/** The line with comments and strings blanked out. */
function codeOf (line: string): string {
    const contexts = classifyLine(line)
    return line.split('').map((ch, i) => contexts[i] === TokenContext.Code ? ch : ' ').join('')
}

/** The left-hand sides of the assignments on a line, one per statement. */
function assignmentTargets (code: string): string[] {
    const targets: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < code.length; i++) {
        const ch = code[i]
        if ('([{'.includes(ch)) {
            depth++
        } else if (')]}'.includes(ch)) {
            depth--
        } else if (depth === 0 && (ch === ';' || ch === ',')) {
            start = i + 1
        } else if (depth === 0 && ch === '=' && code[i + 1] !== '=' && !'=~<>'.includes(code[i - 1])) {
            targets.push(code.slice(start, i))
        }
    }
    return targets
}
