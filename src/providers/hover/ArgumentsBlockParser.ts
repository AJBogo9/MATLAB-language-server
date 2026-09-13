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
}

const ARGUMENTS_BLOCK_START = /^\s*arguments\b(?:\s*\(\s*([A-Za-z,\s]*?)\s*\))?\s*(?:\s*[;,])*\s*(?:%.*)?$/
// `end;` and `end,` are legal and close the block. Without the separator
// the scan ran past it and parsed function-body statements as argument
// declarations, producing a confidently false Arguments table.
const BLOCK_END = /^\s*end\b\s*(?:\s*[;,])*\s*(?:%.*)?$/
const IDENTIFIER = '[A-Za-z][A-Za-z0-9_]*'
const DECLARATION_NAME = new RegExp(`^(${IDENTIFIER}(?:\\.${IDENTIFIER})?)`)

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
            // Inside an arguments block a quote can only open a char array: a
            // transpose would need a preceding value, and declarations start
            // with an identifier followed by size/class/validators.
            inSingle = true
        } else if (ch === '"') {
            inDouble = true
        } else if (ch === '%') {
            return line.slice(0, i)
        }
    }

    return line
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
    lines: string[], startLine: number, endLineExclusive: number
): ArgumentDeclaration[] {
    const declarations: ArgumentDeclaration[] = []
    const limit = Math.min(endLineExclusive, lines.length)

    let i = Math.max(0, startLine)
    while (i < limit) {
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

        while (i < limit && !BLOCK_END.test(lines[i])) {
            const declarationStartLine = i

            // Join line continuations so a declaration split across lines parses
            // as one.
            let joined = stripTrailingComment(lines[i])
            while (/\.\.\.\s*$/.test(joined.trimEnd()) && i + 1 < limit) {
                joined = joined.trimEnd().replace(/\.\.\.$/, ' ')
                i++
                joined += stripTrailingComment(lines[i])
            }

            const trimmed = joined.trim()
            if (trimmed !== '') {
                const nameMatch = DECLARATION_NAME.exec(trimmed)
                if (nameMatch != null) {
                    declarations.push({
                        name: nameMatch[1],
                        kind,
                        line: declarationStartLine,
                        ...parseDeclarationBody(trimmed.slice(nameMatch[1].length))
                    })
                }
            }

            i++
        }

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
