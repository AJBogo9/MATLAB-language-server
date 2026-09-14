// Copyright 2026 Andreas Bogossian

import { parseArgumentsBlocks, renderArgumentsTable, ArgumentDeclaration } from './ArgumentsBlockParser'
import { computeBlockCommentLines } from './CommentStringScanner'
import { DocCommentLine, firstLineIsSummary, indentColumns, renderDocComment } from './DocCommentMarkdown'

/**
 * Builds hover content for symbols declared in the document being viewed, using
 * nothing but the document text.
 *
 * This is not a fallback for the MATLAB-backed card, it is a complementary
 * source, for two reasons:
 *
 *   1. It covers the cases `help()` cannot reach at all. `help('localHelper')`
 *      returns empty for a local function; the file must be saved and its folder
 *      on the path or cwd before MATLAB can say anything about it. An unsaved
 *      buffer is invisible to MATLAB entirely.
 *   2. It needs no MATLAB, so it is the only part of hover that works during the
 *      measured ~5.2 s cold start, and the only part that survives MATLAB being
 *      down. Note the index does not help here: Indexer returns early when the
 *      MVM is not ready, so a cold start has no index either.
 */

export interface OfflineSymbolInfo {
    /** The symbol name as declared. */
    name: string
    /** 'function' or 'classdef'. */
    kind: 'function' | 'classdef'
    /** 0-based line of the declaration. */
    declarationLine: number
    /** The declaration line text, whitespace-normalized. */
    signature: string
    /** Whether the declaration has a doc comment. */
    hasDocComment: boolean
    /**
     * The H1 line: MATLAB's one-line summary, with leading % and name stripped. Only a first
     * comment line that is a paragraph of its own counts.
     */
    summary?: string
    /** The rest of the doc comment, % markers stripped. */
    body?: string
    /** The rest of the doc comment as markdown, with its paragraphs joined. */
    bodyMarkdown?: string
    /** Parsed `arguments` block declarations, if any. */
    argumentDeclarations: ArgumentDeclaration[]
}

const FUNCTION_DECLARATION = /^\s*function\s+(?:\[[^\]]*\]\s*=\s*|[A-Za-z][A-Za-z0-9_]*\s*=\s*)?([A-Za-z][A-Za-z0-9_]*)\s*(?:\(|$|%)/
// Captures the outputs, the name and the inputs. Unlike FUNCTION_DECLARATION it accepts a
// dotted name (`set.Prop`) and an input list still being typed, which has no `)` yet.
const FUNCTION_DECLARATION_PARTS = /^\s*function\s+(?:(\[[^\]]*\]|[A-Za-z][A-Za-z0-9_]*)\s*=\s*)?([A-Za-z][A-Za-z0-9_.]*)\s*(?:\(([^)]*))?/
const CLASSDEF_DECLARATION = /^\s*classdef\s*(?:\([^)]*\)\s*)?([A-Za-z][A-Za-z0-9_]*)\b/
const COMMENT_LINE = /^\s*%/
// Deliberately looser than FUNCTION_DECLARATION: a scope ends at the next
// function or classdef whether or not its declaration parses on one line.
// `function [a, ...` continued onto the next line does not match the strict
// form, so a strict scan walked straight past it and attributed the following
// function's arguments block to this one.
const ANY_SCOPE_START = /^\s*(?:function|classdef)\b/
const BLOCK_COMMENT_OPEN = /^\s*%\{\s*$/
const BLOCK_COMMENT_CLOSE = /^\s*%\}\s*$/

/**
 * Finds the declaration of a named function or class in the document.
 *
 * Local functions are included, which is the point: they are exactly what
 * `help()` cannot resolve for an unsaved or off-path file.
 *
 * @param lines The document split into lines
 * @param name The symbol name to find
 * @returns The 0-based declaration line and its kind, or null if not declared here
 */
export function findDeclarationLine (
    lines: string[], name: string, inBlockComment?: boolean[]
): { line: number, kind: 'function' | 'classdef' } | null {
    // Computed once per call. Testing each line independently rescans the
    // document from the top every time, which is quadratic: measured at 3.4 s of
    // synchronous blocking per hover on a real 9371-line file.
    const commented = inBlockComment ?? computeBlockCommentLines(lines)

    for (let i = 0; i < lines.length; i++) {
        // A declaration written inside a %{ %} block is commented out. Treating
        // it as real hijacks the card and hides the live function's own
        // arguments block.
        if (commented[i]) {
            continue
        }

        if (!ANY_SCOPE_START.test(lines[i])) {
            continue
        }

        // Join continuations before matching. `function [a, ...` does not match
        // the single-line form, and without this such a function got no hover
        // card at all.
        const declaration = joinContinuations(lines, i).text

        const functionMatch = FUNCTION_DECLARATION.exec(declaration)
        if (functionMatch != null && functionMatch[1] === name) {
            return { line: i, kind: 'function' }
        }

        const classMatch = CLASSDEF_DECLARATION.exec(declaration)
        if (classMatch != null && classMatch[1] === name) {
            return { line: i, kind: 'classdef' }
        }
    }
    return null
}

/**
 * Joins a logical line that continues across physical lines with `...`.
 *
 * Each joint becomes a single space, so the text reads as if written on one line.
 *
 * @param lines The document split into lines
 * @param start The 0-based first physical line
 * @returns The joined text and the last physical line consumed
 */
export function joinContinuations (lines: string[], start: number): { text: string, endLine: number } {
    let text = lines[start] ?? ''
    let i = start

    while (/\.\.\.\s*$/.test(text.trimEnd()) && i + 1 < lines.length) {
        text = text.trimEnd().replace(/\s*\.\.\.$/, ' ')
        i++
        text += lines[i].trimStart()
    }

    return { text, endLine: i }
}

/**
 * Reads the name and the argument names of the function declared on a line.
 *
 * @param lines The document split into lines
 * @param line The 0-based line, the first one when the declaration is continued
 * @returns The function name with its input and output argument names, or null when the
 *     line declares no function. A declaration too incomplete to read has no name and
 *     no arguments.
 */
export function parseFunctionDeclaration (
    lines: string[], line: number
): { name: string, inputs: string[], outputs: string[] } | null {
    const declaration = joinContinuations(lines, line).text.replace(/%.*$/, '')
    if (!/^\s*function\b/.test(declaration)) {
        return null
    }

    const match = FUNCTION_DECLARATION_PARTS.exec(declaration)
    const names = (list: string | undefined): string[] => (list ?? '').split(/[\s,[\]]+/).filter(name => name !== '')

    return { name: match?.[2] ?? '', inputs: names(match?.[3]), outputs: names(match?.[1]) }
}

/**
 * Extracts the documentation comment for a declaration.
 *
 * MATLAB's convention puts the help block immediately *after* the declaration
 * line, so that is preferred. A block immediately *before* the declaration is
 * accepted as a fallback, because both forms appear in real code and `help`
 * itself will read a leading block when the file starts with one.
 *
 * @param lines The document split into lines
 * @param declarationLine The 0-based declaration line
 * @returns The comment lines with their leading % stripped, in source order
 */
export function extractDocComment (lines: string[], declarationLine: number): string[] {
    return extractDocCommentLines(lines, declarationLine).map(line => line.text)
}

function extractDocCommentLines (lines: string[], declarationLine: number): DocCommentLine[] {
    // A declaration continued with `...` spans several physical lines, and the
    // help block follows the last of them. Starting at declarationLine + 1 found
    // the continuation itself, which is not a comment, so such a function got no
    // documentation at all.
    const declarationEnd = joinContinuations(lines, declarationLine).endLine

    const after = collectCommentBlockForward(lines, declarationEnd + 1)
    if (after.length > 0) {
        return after
    }
    return collectCommentBlockBackward(lines, declarationLine - 1)
}

function collectCommentBlockForward (lines: string[], start: number): DocCommentLine[] {
    const collected: DocCommentLine[] = []
    let i = start

    // A blank line between the declaration and its comment ends the help block
    // in MATLAB, so do not skip over one.
    while (i < lines.length) {
        const line = lines[i]

        if (BLOCK_COMMENT_OPEN.test(line)) {
            i++
            while (i < lines.length && !BLOCK_COMMENT_CLOSE.test(lines[i])) {
                collected.push({ text: lines[i], preformatted: true })
                i++
            }
            i++
            continue
        }

        if (!COMMENT_LINE.test(line)) {
            break
        }

        collected.push(commentLine(line))
        i++
    }

    return trimBlankEdges(collected)
}

function collectCommentBlockBackward (lines: string[], start: number): DocCommentLine[] {
    const collected: DocCommentLine[] = []
    let i = start

    while (i >= 0 && COMMENT_LINE.test(lines[i])) {
        collected.unshift(commentLine(lines[i]))
        i--
    }

    return trimBlankEdges(collected)
}

function commentLine (line: string): DocCommentLine {
    // Strip one leading %, then one following space, so indentation inside the comment
    // block is preserved. The depth counts from the % itself, so %NAME followed by % text
    // reads as a summary and a body, and a tab after % keeps its depth.
    const afterMarker = line.replace(/^\s*%/, '')
    return { text: afterMarker.replace(/^ /, ''), preformatted: false, indent: indentColumns(afterMarker) }
}

function trimBlankEdges (lines: DocCommentLine[]): DocCommentLine[] {
    const result = [...lines]
    while (result.length > 0 && result[0].text.trim() === '') {
        result.shift()
    }
    while (result.length > 0 && result[result.length - 1].text.trim() === '') {
        result.pop()
    }
    return result
}

/**
 * Finds the line at which a function scope ends, so an `arguments` block scan
 * does not run into the next function.
 *
 * This is a bounded heuristic, not a parser: it stops at the next `function` or
 * `classdef` declaration. That is sufficient because `arguments` blocks may only
 * appear before the first executable statement of the function they belong to.
 *
 * @param lines The document split into lines
 * @param declarationLine The 0-based declaration line
 * @returns The 0-based exclusive end line
 */
function findScopeEnd (lines: string[], declarationLine: number, commented: boolean[]): number {
    for (let i = declarationLine + 1; i < lines.length; i++) {
        if (commented[i]) {
            continue
        }
        if (ANY_SCOPE_START.test(lines[i])) {
            return i
        }
    }
    return lines.length
}

/**
 * Normalizes a declaration line into a signature string.
 *
 * Joins line continuations, drops the `function` keyword and any trailing
 * comment, so `function [a, b] = f(x, ...\n   y)` becomes `[a, b] = f(x, y)`.
 *
 * @param lines The document split into lines
 * @param declarationLine The 0-based declaration line
 * @returns The normalized signature
 */
export function extractSignature (lines: string[], declarationLine: number): string {
    let joined = lines[declarationLine] ?? ''
    let i = declarationLine

    while (/\.\.\.\s*$/.test(joined.trimEnd()) && i + 1 < lines.length) {
        joined = joined.trimEnd().replace(/\.\.\.$/, ' ')
        i++
        joined += lines[i]
    }

    return joined
        .replace(/%.*$/, '')
        .replace(/^\s*function\s+/, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * Builds everything that can be known about a symbol from the document alone.
 *
 * @param documentText The full text of the document
 * @param name The symbol to describe
 * @returns The collected information, or null if the symbol is not declared here
 */
export function buildOfflineSymbolInfo (documentText: string, name: string): OfflineSymbolInfo | null {
    const lines = documentText.split(/\r?\n/)
    const commented = computeBlockCommentLines(lines)
    const declaration = findDeclarationLine(lines, name, commented)

    if (declaration == null) {
        return null
    }

    const comment = extractDocCommentLines(lines, declaration.line)
    const signature = extractSignature(lines, declaration.line)

    // MATLAB's H1 convention is that the first comment line is the one-line
    // summary and conventionally repeats the function name in caps. Strip a
    // leading name so the card does not read "myAdder - MYADDER Add two numbers".
    let summary: string | undefined
    let body: string | undefined
    let bodyMarkdown: string | undefined

    const hasSummaryLine = firstLineIsSummary(comment)
    if (hasSummaryLine) {
        summary = comment[0].text.trim()
        const leadingName = new RegExp(`^${escapeRegExp(name)}\\b[\\s:-]*`, 'i')
        summary = summary.replace(leadingName, '').trim()
        if (summary === '') {
            summary = undefined
        }
    }

    const rest = trimBlankEdges(hasSummaryLine ? comment.slice(1) : comment)
    if (!hasSummaryLine && rest.length > 0 && !rest[0].preformatted) {
        // A first line that is not a summary can still open with the name in capitals
        const capitalisedName = new RegExp(`^(\\s*)${escapeRegExp(name.toUpperCase())}\\b[\\s:-]*`)
        rest[0] = { ...rest[0], text: rest[0].text.replace(capitalisedName, '$1') }
    }
    if (rest.length > 0) {
        body = rest.map(line => line.text).join('\n')
        bodyMarkdown = renderDocComment(rest)
    }

    const argumentDeclarations = declaration.kind === 'function'
        ? parseArgumentsBlocks(lines, declaration.line, findScopeEnd(lines, declaration.line, commented), commented)
        : []

    return {
        name,
        kind: declaration.kind,
        declarationLine: declaration.line,
        signature,
        hasDocComment: comment.length > 0,
        summary,
        body,
        bodyMarkdown,
        argumentDeclarations
    }
}

function escapeRegExp (text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { renderArgumentsTable }
