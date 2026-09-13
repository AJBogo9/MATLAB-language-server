// Copyright 2026 Andreas Bogossian

/**
 * Decides whether a document position sits inside a comment or a string.
 *
 * Nothing else in this stack can answer that question. `computeCodeData` returns
 * no comment, string or token ranges at all, and `ExpressionUtils` matches a
 * bare identifier regex against the raw line. Without this gate, hovering the
 * word `plot` inside `% remember to plot this` or inside `'plot'` produces a
 * full documentation card for the builtin, which is worse than no hover.
 *
 * MATLAB makes this harder than most languages because `'` is overloaded:
 *
 *     A(1)'        transpose
 *     [1 2 3]'     transpose
 *     s.field'     transpose
 *     x = 'plot'   char array
 *     disp('a''b') char array containing an escaped quote
 *
 * The disambiguation rule is positional: a quote directly following a value
 * (identifier character, closing bracket, dot, or another transpose) is a
 * transpose operator; anywhere else it opens a char array. This is the same rule
 * the TextMate grammar applies, which matters because the two must agree, and it
 * is why the auto-closing-pair guard in language-configuration.json cannot work:
 * the grammar scopes transpose as keyword.operator.transpose.matlab, not as a
 * string, so a `notIn: ["string"]` guard never fires on `A(1)'`.
 */

export enum TokenContext {
    Code = 'code',
    Comment = 'comment',
    String = 'string'
}

const BLOCK_COMMENT_OPEN = /^\s*%\{\s*$/
const BLOCK_COMMENT_CLOSE = /^\s*%\}\s*$/

/**
 * Determines whether a line index falls inside a `%{ ... %}` block comment.
 *
 * MATLAB requires the delimiters to be alone on their lines, which makes this a
 * sound line-level scan rather than a heuristic.
 *
 * @param lines The document split into lines
 * @param lineIndex The 0-based line to test
 * @returns True when the line is inside a block comment
 */
export function isInsideBlockComment (lines: string[], lineIndex: number): boolean {
    let depth = 0

    for (let i = 0; i < lineIndex && i < lines.length; i++) {
        if (BLOCK_COMMENT_OPEN.test(lines[i])) {
            depth++
        } else if (BLOCK_COMMENT_CLOSE.test(lines[i]) && depth > 0) {
            depth--
        }
    }

    if (depth > 0) {
        return true
    }

    // The delimiter lines themselves are part of the comment.
    const line = lines[lineIndex]
    return line !== undefined && (BLOCK_COMMENT_OPEN.test(line) || BLOCK_COMMENT_CLOSE.test(line))
}

/**
 * Returns true when the character at `index` can close a value, meaning a
 * following quote is a transpose rather than a string opener.
 */
function isValueTerminator (ch: string): boolean {
    return /[A-Za-z0-9_)\]}.']/.test(ch)
}

/**
 * Classifies every character of a single line as code, comment or string.
 *
 * @param lineText The line to scan
 * @returns An array of contexts, one per character
 */
export function classifyLine (lineText: string): TokenContext[] {
    const contexts: TokenContext[] = new Array(lineText.length).fill(TokenContext.Code)

    let inSingle = false
    let inDouble = false

    for (let i = 0; i < lineText.length; i++) {
        const ch = lineText[i]

        if (inSingle) {
            contexts[i] = TokenContext.String
            if (ch === "'") {
                if (lineText[i + 1] === "'") {
                    contexts[i + 1] = TokenContext.String
                    i++
                } else {
                    inSingle = false
                }
            }
            continue
        }

        if (inDouble) {
            contexts[i] = TokenContext.String
            if (ch === '"') {
                if (lineText[i + 1] === '"') {
                    contexts[i + 1] = TokenContext.String
                    i++
                } else {
                    inDouble = false
                }
            }
            continue
        }

        if (ch === '%') {
            // Everything from here to end of line is a comment. This is reached
            // only outside a string, so "100%" in a char array is safe.
            for (let j = i; j < lineText.length; j++) {
                contexts[j] = TokenContext.Comment
            }
            return contexts
        }

        if (ch === '.' && lineText.slice(i, i + 3) === '...') {
            // A line continuation comments out the rest of the line.
            for (let j = i; j < lineText.length; j++) {
                contexts[j] = TokenContext.Comment
            }
            return contexts
        }

        if (ch === "'") {
            // MATLAB binds transpose tight: `A '` is an unterminated char array,
            // not a transpose (verified on R2026a), so the character
            // IMMEDIATELY before decides. Skipping whitespace here classified
            // every `case 'plot'`, `disp 'text'`, `@(k) 'plot'` and
            // `[num2str(x) ' msg']` as code, which is exactly what this module
            // exists to prevent.
            const previous = i > 0 ? lineText[i - 1] : ''

            if (isValueTerminator(previous)) {
                // Transpose operator: stays code.
                contexts[i] = TokenContext.Code
            } else {
                inSingle = true
                contexts[i] = TokenContext.String
            }
            continue
        }

        if (ch === '"') {
            inDouble = true
            contexts[i] = TokenContext.String
            continue
        }
    }

    return contexts
}

/**
 * Classifies a position in a document.
 *
 * @param lines The document split into lines
 * @param line The 0-based line
 * @param character The 0-based character offset within that line
 * @returns The token context at that position
 */
export function getTokenContext (lines: string[], line: number, character: number): TokenContext {
    if (line < 0 || line >= lines.length) {
        return TokenContext.Code
    }

    if (isInsideBlockComment(lines, line)) {
        return TokenContext.Comment
    }

    const contexts = classifyLine(lines[line])

    if (character < 0) {
        return TokenContext.Code
    }
    if (character >= contexts.length) {
        // Past end of line: treat as code so an empty trailing position does not
        // suppress anything unexpectedly.
        return TokenContext.Code
    }

    return contexts[character]
}

/**
 * Convenience predicate: should hover be suppressed at this position?
 *
 * @param lines The document split into lines
 * @param line The 0-based line
 * @param character The 0-based character offset
 * @returns True when the position is inside a comment or string
 */
export function isInCommentOrString (lines: string[], line: number, character: number): boolean {
    const context = getTokenContext(lines, line, character)
    return context === TokenContext.Comment || context === TokenContext.String
}
