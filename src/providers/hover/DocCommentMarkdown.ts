// Copyright 2026 Andreas Bogossian

/**
 * Renders a doc comment from a document as markdown for a hover card.
 *
 * A comment is prose its author wrapped by hand. In a code fence, where MATLAB's help text
 * goes, it keeps those line breaks, does not reflow to the hover's width, and gets MATLAB
 * syntax colouring. Here the lines of a paragraph are joined so the hover wraps them, and
 * only what is laid out on purpose stays preformatted: examples indented deeper than the
 * paragraph they follow, lines that read as a list or a table, and block comments.
 */

export interface DocCommentLine {
    /** The line with its comment marker removed */
    text: string
    /** True inside a block comment, which is kept as written */
    preformatted: boolean
    /**
     * Columns from the comment marker to the text, a tab counting to the next multiple of 4.
     * Without it the depth is measured on the text.
     */
    indent?: number
}

const INLINE_MARKDOWN = /[\\`*_[\]<>|~&]/g
// What would open a heading, a list or a rule at the start of a paragraph
const BLOCK_START = /^(?:[#+=-]|\d{1,9}[.)](?=\s|$))/
// Web and email addresses, which markdown links as written, so a backslash in one would show
const ADDRESS = /(?:(?:https?|ftp):\/\/|www\.)[^\s<]*|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const SENTENCE_END = /[.!?]["')\]]*$/
const CLAUSE_END = /[.!?:;]["')\]]*$/
const CODE_CHARACTERS = /[=;(){}[\]]|^>>/

const LIST_LIKE = [
    /^[-*+•]\s+\S/, // a bullet
    /^\(?\d{1,3}[.)]\s+\S/, // a numbered item
    /^>>/, // a command at the prompt
    /^['"]?[A-Za-z][\w.]*['"]?(?:\s*,\s*['"]?[A-Za-z][\w.]*['"]?)*\s+--?\s+\S/, // name - description
    /[^\s.!?:;,] {2,}\S/, // columns aligned with spaces
    /\|.*\|/, // table cells
    /^[-=_*~+|]{3,}$/ // a rule
]

const isBlank = (text: string): boolean => text.trim() === ''
const isListLike = (text: string): boolean => LIST_LIKE.some(pattern => pattern.test(text.trim()))
const depthOf = (line: DocCommentLine): number => line.indent ?? indentColumns(line.text)

/**
 * Measures leading whitespace in columns.
 *
 * @param text The text
 * @returns The columns, a tab counting to the next multiple of 4
 */
export function indentColumns (text: string): number {
    let columns = 0
    for (const ch of text) {
        if (ch === ' ') {
            columns++
        } else if (ch === '\t') {
            columns += 4 - columns % 4
        } else {
            break
        }
    }
    return columns
}

/**
 * Escapes text so markdown shows it literally. Web and email addresses are left as written.
 *
 * @param text One line of text
 * @returns The escaped text
 */
export function escapeMarkdown (text: string): string {
    const address = new RegExp(ADDRESS.source, 'g')
    let escaped = ''
    let last = 0
    let match: RegExpExecArray | null
    while ((match = address.exec(text)) !== null) {
        escaped += text.slice(last, match.index).replace(INLINE_MARKDOWN, '\\$&') + match[0]
        last = match.index + match[0].length
    }
    escaped += text.slice(last).replace(INLINE_MARKDOWN, '\\$&')
    return escaped.replace(BLOCK_START, start => start.slice(0, -1) + '\\' + start.slice(-1))
}

/**
 * Whether the first line of a comment is a paragraph of its own: nothing follows it, or a
 * blank line, a block comment or a line indented deeper does.
 *
 * @param lines The comment lines
 * @returns True when the first line stands alone
 */
export function firstLineIsOwnParagraph (lines: DocCommentLine[]): boolean {
    const [first, next] = lines
    if (first === undefined || first.preformatted || isBlank(first.text)) {
        return false
    }
    return next === undefined || next.preformatted || isBlank(next.text) || depthOf(next) > depthOf(first)
}

/**
 * Whether the first line of a comment is its summary, MATLAB's H1 line: a paragraph of its
 * own, or a complete sentence. A first line that the next one continues is half a sentence.
 *
 * @param lines The comment lines
 * @returns True when the first line is a summary
 */
export function firstLineIsSummary (lines: DocCommentLine[]): boolean {
    const first = lines[0]
    if (first === undefined || first.preformatted || isBlank(first.text)) {
        return false
    }
    return firstLineIsOwnParagraph(lines) || SENTENCE_END.test(first.text.trim())
}

/**
 * Whether a deeper line only continues the sentence before it, as a hanging indent does.
 */
function continuesSentence (previous: string, next: string): boolean {
    const text = next.trim()
    return !CLAUSE_END.test(previous.trim()) && /^[a-z]/.test(text) && !CODE_CHARACTERS.test(text)
}

/**
 * Renders comment lines as markdown paragraphs and preformatted blocks.
 *
 * @param lines The comment lines
 * @returns The markdown
 */
export function renderDocComment (lines: DocCommentLine[]): string {
    const blocks: string[] = []

    let paragraph: string[] = []
    let paragraphIndent = 0
    // Kept across blank lines: a line deeper than the paragraph before a blank line is an example
    let previousParagraphIndent: number | undefined
    let afterBlank = false

    // A preformatted run is a block comment, a list, or lines deeper than the paragraph before
    // them. A list or indented run lasts while its lines stay deeper than runIndent, so a blank
    // line between two example lines does not split it, and a list also takes further items.
    let run: string[] = []
    let runKind: 'block' | 'list' | 'indent' | undefined
    let runIndent = 0

    const flushParagraph = (): void => {
        if (paragraph.length > 0) {
            blocks.push(escapeMarkdown(paragraph.join(' ')))
            previousParagraphIndent = paragraphIndent
            paragraph = []
        }
    }
    const flushRun = (): void => {
        while (run.length > 0 && isBlank(run[run.length - 1])) {
            run.pop()
        }
        if (run.length > 0) {
            blocks.push(fence(run))
        }
        run = []
        runKind = undefined
    }
    const startRun = (kind: 'list' | 'indent', indent: number, text: string): void => {
        flushParagraph()
        flushRun()
        runKind = kind
        runIndent = indent
        run.push(text)
    }

    for (const line of lines) {
        if (line.preformatted) {
            flushParagraph()
            if (runKind !== 'block') {
                flushRun()
            }
            runKind = 'block'
            run.push(line.text)
            afterBlank = false
            continue
        }
        if (runKind === 'block') {
            flushRun()
        }

        if (isBlank(line.text)) {
            flushParagraph()
            if (run.length > 0) {
                run.push('')
            }
            afterBlank = true
            continue
        }

        const depth = depthOf(line)
        const listLike = isListLike(line.text)
        const wasAfterBlank = afterBlank
        afterBlank = false

        if (runKind !== undefined) {
            if (depth > runIndent || (runKind === 'list' && listLike && depth >= runIndent)) {
                run.push(line.text)
                continue
            }
            flushRun()
        }

        if (paragraph.length > 0) {
            if (listLike && depth >= paragraphIndent) {
                startRun('list', depth, line.text)
            } else if (depth > paragraphIndent && !continuesSentence(paragraph[paragraph.length - 1], line.text)) {
                startRun('indent', paragraphIndent, line.text)
            } else {
                paragraph.push(line.text.trim())
            }
            continue
        }

        if (listLike) {
            startRun('list', depth, line.text)
        } else if (wasAfterBlank && previousParagraphIndent !== undefined && depth > previousParagraphIndent) {
            startRun('indent', previousParagraphIndent, line.text)
        } else {
            paragraphIndent = depth
            paragraph.push(line.text.trim())
        }
    }
    flushParagraph()
    flushRun()

    return blocks.join('\n\n')
}

/**
 * Fences lines as plain text, without their common indentation. An unlabeled fence would
 * take the editor's language and colour the text as MATLAB. Loops rather than spreads, since
 * a block comment can have more lines than a call takes arguments.
 */
function fence (lines: string[]): string {
    let common = Number.POSITIVE_INFINITY
    let longestTicks = 0
    for (const line of lines) {
        if (!isBlank(line)) {
            common = Math.min(common, line.length - line.trimStart().length)
        }
        for (const ticks of line.match(/`+/g) ?? []) {
            longestTicks = Math.max(longestTicks, ticks.length)
        }
    }
    const body = lines.map(line => isBlank(line) ? '' : line.slice(common))
    const marker = '`'.repeat(Math.max(3, longestTicks + 1))
    return [marker + 'text', ...body, marker].join('\n')
}
