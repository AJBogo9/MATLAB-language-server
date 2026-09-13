// Copyright 2026 Andreas Bogossian

/**
 * Parses MATLAB `arguments ... end` blocks out of document text.
 *
 * This exists because argument validators, sizes and defaults are invisible to
 * every MATLAB introspection API. Verified three ways on R2026a:
 *
 *   help('noDocArgs')                       -> "noDocArgs is a function.\n    y = noDocArgs(x, opts)"
 *   matlab.metadata.Function('noDocArgs')   -> throws MATLAB:mcos_convenience:ConstructorNotSupported
 *   matlab.internal.metafunction            -> does not exist
 *
 * The language server's own index does not carry it either: FunctionDefinition
 * exposes `inputArgs: string[]` and `outputArgs: string[]`, names only. So the
 * document text is the only source, and parsing it here means the richest part
 * of a user-function hover card also works with MATLAB completely offline.
 */

import { computeBlockCommentLines } from './CommentStringScanner'
import { DocCommentLine, indentColumns } from './DocCommentMarkdown'

export type ArgumentKind = 'input' | 'output' | 'repeating'

export interface ArgumentDeclaration {
    /** Declared name, including the struct field for name-value pairs, e.g. "opts.Method". */
    name: string
    /** Size constraint as written, e.g. "(:,1)". Undefined when not declared. */
    size?: string
    /** Class constraint as written, e.g. "double". Undefined when not declared. */
    className?: string
    /** Validator list as written, without the braces, e.g. "mustBeFinite, mustBeReal". */
    validators?: string
    /** Default value expression as written, e.g. "1e-6". Undefined when not declared. */
    defaultValue?: string
    /** Which `arguments` block this came from. */
    kind: ArgumentKind
    /** 0-based line in the document where the declaration starts. */
    line: number
    /**
     * What the argument is for, from its comments: the trailing comment on the declaration, the
     * comment lines directly above it, or both. Undefined when it has none.
     */
    description?: DocCommentLine[]
}

const ARGUMENTS_BLOCK_START = /^\s*arguments\b(?:\s*\(\s*([A-Za-z,\s]*?)\s*\))?\s*(?:\s*[;,])*\s*(?:%.*)?$/
// `end;` and `end,` are legal and close the block. Without the separator
// the scan ran past it and parsed function-body statements as argument
// declarations, producing a confidently false Arguments table.
const BLOCK_END = /^\s*end\b\s*(?:\s*[;,])*\s*(?:%.*)?$/
const IDENTIFIER = '[A-Za-z][A-Za-z0-9_]*'
const DECLARATION_NAME = new RegExp(`^(${IDENTIFIER}(?:\\.${IDENTIFIER})?)`)
const COMMENT_ONLY = /^\s*%(.*)$/
// A blank line or a %% title above a comment sets it apart as a heading
const GROUP_SEPARATOR = /^\s*(?:%%.*)?$/
const NUMERIC_SIZE = /^\(\s*[\d:]+(?:\s*,\s*[\d:]+)*\s*\)$/
const SINGLE_CLASS = /^[A-Za-z][\w.]*$/
// Classes no phrase of prose ends in, so "% tol double" reads as commented-out code
const TYPE_CLASSES = new Set([
    'double', 'single', 'logical', 'function_handle',
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64'
])
// Classes named like nouns: "% pulse duration" and "% options struct" are prose, so these read as code
// only with a default value
const NOUN_CLASSES = new Set([
    'char', 'string', 'cell', 'struct', 'table', 'timetable', 'datetime', 'duration', 'calendarDuration',
    'categorical', 'dictionary', 'sym', 'graph', 'digraph', 'polyshape', 'timeseries', 'gpuArray', 'missing'
])

/**
 * Strips a trailing line comment, respecting single-quoted char arrays and
 * double-quoted strings.
 *
 * A bare `indexOf('%')` is wrong on `x (1,1) string = "100%"`, which is exactly
 * the sort of default value that appears in real argument blocks.
 *
 * @param line The source line
 * @returns The line with any trailing comment removed
 */
function stripTrailingComment (line: string): string {
    const start = findCommentStart(line)
    return start === -1 ? line : line.slice(0, start)
}

/**
 * Finds where a line comment starts, with the same quote and transpose rules as stripTrailingComment.
 *
 * @param line The source line
 * @returns The index of the %, or -1 when the line has no comment
 */
function findCommentStart (line: string): number {
    let inSingle = false
    let inDouble = false

    for (let i = 0; i < line.length; i++) {
        const ch = line[i]

        if (inSingle) {
            if (ch === "'") {
                // '' inside a char array is an escaped quote.
                if (line[i + 1] === "'") {
                    i++
                } else {
                    inSingle = false
                }
            }
            continue
        }

        if (inDouble) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    i++
                } else {
                    inDouble = false
                }
            }
            continue
        }

        if (ch === "'") {
            // A default value can contain a transpose, e.g. `x double = [1 2]'`.
            // Treating every quote as a string opener swallowed the trailing
            // comment and, with an odd number of quotes on the line, ran on into
            // the next declaration. Same rule as the document scanner: MATLAB
            // binds transpose tight, so the character immediately before decides.
            const previous = i > 0 ? line[i - 1] : ''
            if (/[A-Za-z0-9_)\]}.']/.test(previous)) {
                continue
            }
            inSingle = true
        } else if (ch === '"') {
            inDouble = true
        } else if (ch === '%') {
            return i
        }
    }

    return -1
}

/**
 * Removes a line's comment and collects it as a description line.
 *
 * @param line The source line
 * @param trailing Receives the comment, when it describes something
 * @returns The line without its comment
 */
function splitTrailingComment (line: string, trailing: DocCommentLine[]): string {
    const start = findCommentStart(line)
    if (start === -1) {
        return line
    }
    // A Code Analyzer pragma such as %#ok<INUSA> shares the comment syntax but describes nothing
    const comment = line.slice(start + 1)
    const text = comment.startsWith('#') ? '' : comment.split('%#')[0]
    if (text.trim() !== '') {
        // Spaces after the marker line the comment up with its neighbours and say nothing about depth
        trailing.push({ text: text.trim(), preformatted: false })
    }
    return line.slice(0, start)
}

/**
 * Makes a description line from the text after a comment marker, the way a doc comment line is made:
 * one space after the marker is dropped and the depth counts from the marker.
 */
function commentLine (afterMarker: string): DocCommentLine {
    const text = afterMarker.trimEnd()
    return { text: text.replace(/^ /, ''), preformatted: false, indent: indentColumns(text) }
}

/**
 * Collects the comment lines directly above a declaration.
 *
 * The run ends at a blank line or code, and at what is not prose: a %{ %} block comment, a %%
 * section title, a %# pragma and a commented-out declaration.
 *
 * @param lines The document split into lines
 * @param declarationLine The 0-based first line of the declaration
 * @param commented Which lines sit inside a block comment
 * @returns The comment lines in source order, without blank lines at either end, and the line above them
 */
function precedingComment (lines: string[], declarationLine: number, commented: boolean[]): { run: DocCommentLine[], above: number } {
    const run: DocCommentLine[] = []
    let j = declarationLine - 1
    for (; j >= 0 && !commented[j]; j--) {
        const match = COMMENT_ONLY.exec(lines[j])
        if (match == null || /^[%#]/.test(match[1]) || isCommentedOutDeclaration(match[1])) {
            break
        }
        run.unshift(commentLine(match[1]))
    }

    while (run.length > 0 && run[0].text.trim() === '') {
        run.shift()
    }
    while (run.length > 0 && run[run.length - 1].text.trim() === '') {
        run.pop()
    }
    return { run, above: j }
}

/**
 * Whether a comment is a commented-out declaration rather than prose.
 *
 * A declaration name alone proves nothing, since most descriptions open with a word. It needs a
 * size such as (1,1), validators, a dotted class, a type such as double, or a class named like a
 * noun with a default value, and at most one class token. So "% tol double", "% y (1,1)" and
 * "% label string = "a"" are code, while "% gain factor", "% pulse duration", "% samples (N x 1)"
 * and "% origin (0,0) of the axes" are descriptions.
 *
 * @param comment The text after the comment marker
 * @returns True when the comment reads as code
 */
function isCommentedOutDeclaration (comment: string): boolean {
    // Commenting out a documented declaration keeps its own comment
    const text = stripTrailingComment(comment).trim()
    const nameMatch = DECLARATION_NAME.exec(text)
    if (nameMatch == null) {
        return false
    }

    const body = parseDeclarationBody(text.slice(nameMatch[1].length))
    if (body.className != null && !SINGLE_CLASS.test(body.className)) {
        return false
    }
    return (body.size != null && NUMERIC_SIZE.test(body.size)) || body.validators != null ||
        (body.className != null && (body.className.includes('.') || TYPE_CLASSES.has(body.className) ||
            (body.defaultValue != null && NOUN_CLASSES.has(body.className))))
}

/**
 * Chooses a declaration's description from its trailing comment and the comment lines above it.
 *
 * Both are kept, the lines above first, because an explanation above and a unit on the line
 * (`v0 (1,1) double  % m/s`) are both about the argument. The exception is a heading above a
 * group: when a blank line, a %% title or the arguments line sets the lines above apart, and the
 * next declaration follows on the very next line with a comment of its own, those lines head the
 * group and describe neither field. Lines directly under another declaration describe the one
 * below them.
 *
 * @param preceding The comment lines directly above
 * @param trailing The comments on the declaration's own lines
 * @param headsGroup Whether the declaration opens a group of commented declarations
 * @returns The description lines, empty when there are none
 */
function chooseDescription (preceding: DocCommentLine[], trailing: DocCommentLine[], headsGroup: boolean): DocCommentLine[] {
    if (trailing.length === 0) {
        return preceding
    }
    if (preceding.length === 0 || headsGroup) {
        return trailing
    }
    return [...preceding, { text: '', preformatted: false }, ...trailing]
}

/**
 * Splits one declaration body (everything after the argument name) into its
 * size, class, validator and default parts.
 *
 * Grammar, per MATLAB's argument validation docs:
 *   argName (dimensions) ClassName {validators} = defaultValue
 * with every part after the name optional.
 *
 * @param rest The text after the declared name
 * @returns The parsed parts
 */
function parseDeclarationBody (rest: string): Pick<ArgumentDeclaration, 'size' | 'className' | 'validators' | 'defaultValue'> {
    const result: Pick<ArgumentDeclaration, 'size' | 'className' | 'validators' | 'defaultValue'> = {}
    let remaining = rest.trim()

    // Default value first: everything after the first top-level '=' that is not
    // part of ==, ~=, <= or >=.
    const defaultSplit = findDefaultAssignment(remaining)
    if (defaultSplit !== -1) {
        const value = remaining.slice(defaultSplit + 1).trim()
        if (value !== '') {
            result.defaultValue = value
        }
        remaining = remaining.slice(0, defaultSplit).trim()
    }

    // Size constraint: a parenthesised group at the start.
    if (remaining.startsWith('(')) {
        const close = matchDelimiter(remaining, 0, '(', ')')
        if (close !== -1) {
            result.size = remaining.slice(0, close + 1)
            remaining = remaining.slice(close + 1).trim()
        }
    }

    // Validator list: a braced group, which may appear before or after the class.
    const braceStart = remaining.indexOf('{')
    if (braceStart !== -1) {
        const close = matchDelimiter(remaining, braceStart, '{', '}')
        if (close !== -1) {
            const validators = remaining.slice(braceStart + 1, close).trim()
            if (validators !== '') {
                result.validators = validators
            }
            remaining = (remaining.slice(0, braceStart) + ' ' + remaining.slice(close + 1)).trim()
        }
    }

    // Whatever is left is the class constraint.
    if (remaining !== '') {
        result.className = remaining.replace(/\s+/g, ' ')
    }

    return result
}

/**
 * Finds the index of the top-level `=` that introduces a default value.
 *
 * @param text The declaration body
 * @returns The index, or -1 if there is no default assignment
 */
function findDefaultAssignment (text: string): number {
    let depth = 0
    let inSingle = false
    let inDouble = false

    for (let i = 0; i < text.length; i++) {
        const ch = text[i]

        if (inSingle) {
            if (ch === "'") {
                if (text[i + 1] === "'") i++
                else inSingle = false
            }
            continue
        }
        if (inDouble) {
            if (ch === '"') {
                if (text[i + 1] === '"') i++
                else inDouble = false
            }
            continue
        }

        if (ch === "'") { inSingle = true; continue }
        if (ch === '"') { inDouble = true; continue }
        if (ch === '(' || ch === '{' || ch === '[') { depth++; continue }
        if (ch === ')' || ch === '}' || ch === ']') { depth--; continue }

        if (ch === '=' && depth === 0) {
            // Skip ==, and the second character of ~=, <= and >=.
            if (text[i + 1] === '=') { i++; continue }
            const prev = text[i - 1]
            if (prev === '~' || prev === '<' || prev === '>' || prev === '=') continue
            return i
        }
    }

    return -1
}

/**
 * Finds the index of the delimiter closing the one at `openIndex`, accounting
 * for nesting and quoting.
 *
 * @param text The text to scan
 * @param openIndex Index of the opening delimiter
 * @param open The opening character
 * @param close The closing character
 * @returns The index of the matching close, or -1 if unbalanced
 */
function matchDelimiter (text: string, openIndex: number, open: string, close: string): number {
    let depth = 0
    let inSingle = false
    let inDouble = false

    for (let i = openIndex; i < text.length; i++) {
        const ch = text[i]

        if (inSingle) {
            if (ch === "'") {
                if (text[i + 1] === "'") i++
                else inSingle = false
            }
            continue
        }
        if (inDouble) {
            if (ch === '"') {
                if (text[i + 1] === '"') i++
                else inDouble = false
            }
            continue
        }

        if (ch === "'") { inSingle = true; continue }
        if (ch === '"') { inDouble = true; continue }

        if (ch === open) depth++
        else if (ch === close) {
            depth--
            if (depth === 0) return i
        }
    }

    return -1
}

/**
 * Parses every `arguments` block between two lines of a document.
 *
 * @param lines The document split into lines
 * @param startLine 0-based line to start scanning from, normally the `function` line
 * @param endLineExclusive 0-based line to stop before, normally the end of the function scope
 * @returns Every argument declaration found, in source order
 */
export function parseArgumentsBlocks (
    lines: string[], startLine: number, endLineExclusive: number, inBlockComment?: boolean[]
): ArgumentDeclaration[] {
    const declarations: ArgumentDeclaration[] = []
    const limit = Math.min(endLineExclusive, lines.length)
    // Computed once by the caller where possible; testing per line is quadratic.
    const commented = inBlockComment ?? computeBlockCommentLines(lines)

    let i = Math.max(0, startLine)
    while (i < limit) {
        // An arguments block inside a %{ %} comment is commented out, so its
        // declarations must not reach the Arguments table.
        if (commented[i]) {
            i++
            continue
        }

        const blockMatch = ARGUMENTS_BLOCK_START.exec(lines[i])
        if (blockMatch == null) {
            // An `arguments` block may only appear before any executable
            // statement, but nested functions and following code can also
            // contain one, so keep scanning rather than stopping at the first
            // non-matching line.
            i++
            continue
        }

        const kind = attributeToKind(blockMatch[1])
        i++

        const block: Array<{ declaration: ArgumentDeclaration, endLine: number, trailing: DocCommentLine[] }> = []

        // A %{ %} block inside an arguments block is commented-out code, and an `end` inside it
        // does not close the block.
        while (i < limit && (commented[i] || !BLOCK_END.test(lines[i]))) {
            if (commented[i]) {
                i++
                continue
            }

            const declarationStartLine = i
            const trailing: DocCommentLine[] = []

            // Join line continuations so a declaration split across lines parses
            // as one.
            let joined = splitTrailingComment(lines[i], trailing)
            while (/\.\.\.\s*$/.test(joined.trimEnd()) && i + 1 < limit) {
                joined = joined.trimEnd().replace(/\.\.\.$/, ' ')
                i++
                joined += splitTrailingComment(lines[i], trailing)
            }

            const trimmed = joined.trim()
            if (trimmed !== '') {
                const nameMatch = DECLARATION_NAME.exec(trimmed)
                if (nameMatch != null) {
                    block.push({
                        declaration: {
                            name: nameMatch[1],
                            kind,
                            line: declarationStartLine,
                            ...parseDeclarationBody(trimmed.slice(nameMatch[1].length))
                        },
                        endLine: i,
                        trailing
                    })
                }
            }

            i++
        }

        block.forEach(({ declaration, endLine, trailing }, index) => {
            const next = block[index + 1]
            const { run, above } = precedingComment(lines, declaration.line, commented)
            const headsGroup = next !== undefined && next.declaration.line === endLine + 1 && next.trailing.length > 0 &&
                (GROUP_SEPARATOR.test(lines[above]) || ARGUMENTS_BLOCK_START.test(lines[above]))
            const description = chooseDescription(run, trailing, headsGroup)
            if (description.length > 0) {
                declaration.description = description
            }
            declarations.push(declaration)
        })

        i++ // step past the block's `end`
    }

    return declarations
}

/**
 * Maps an `arguments (Attribute)` attribute list onto an argument kind.
 *
 * `arguments (Repeating)` and `arguments (Output)` are both real; an attribute
 * list may also combine them, e.g. `arguments (Output, Repeating)`.
 *
 * @param attributes The captured attribute text, or undefined for a bare `arguments`
 * @returns The corresponding kind
 */
function attributeToKind (attributes: string | undefined): ArgumentKind {
    if (attributes == null || attributes.trim() === '') {
        return 'input'
    }
    const lowered = attributes.toLowerCase()
    if (lowered.includes('output')) {
        return 'output'
    }
    if (lowered.includes('repeating')) {
        return 'repeating'
    }
    return 'input'
}

/**
 * Renders declarations as an aligned plain-text table for a hover card.
 *
 * @param declarations The declarations to render
 * @returns The table, or an empty string when there is nothing to show
 */
export function renderArgumentsTable (declarations: ArgumentDeclaration[]): string {
    if (declarations.length === 0) {
        return ''
    }

    // Group by kind so an `arguments (Output)` or `(Repeating)` block is not
    // presented as an ordinary input under a heading that just says "Arguments".
    const kinds: ArgumentKind[] = ['input', 'output', 'repeating']
    const present = kinds.filter(kind => declarations.some(d => d.kind === kind))

    if (present.length > 1) {
        const labels: Record<ArgumentKind, string> = {
            input: 'Input',
            output: 'Output',
            repeating: 'Repeating'
        }
        return present
            .map(kind => labels[kind] + '\n' +
                renderRows(declarations.filter(d => d.kind === kind)).split('\n').map(r => '  ' + r).join('\n'))
            .join('\n')
    }

    return renderRows(declarations)
}

function renderRows (declarations: ArgumentDeclaration[]): string {
    const nameWidth = Math.max(...declarations.map(d => d.name.length))
    const rows = declarations.map(d => {
        const constraints = [d.size, d.className].filter(part => part != null && part !== '').join(' ')
        let row = d.name.padEnd(nameWidth)
        if (constraints !== '') {
            row += '  ' + constraints
        }
        if (d.validators != null) {
            row += '  {' + d.validators + '}'
        }
        if (d.defaultValue != null) {
            row += ' = ' + d.defaultValue
        }
        return row.trimEnd()
    })

    return rows.join('\n')
}
