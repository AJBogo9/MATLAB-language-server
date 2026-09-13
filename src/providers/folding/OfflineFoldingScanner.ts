// Copyright 2026 Andreas Bogossian

import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver'
import {
    TokenContext, classifyLine, computeBlockCommentLines, computeBlockCommentRanges
} from '../hover/CommentStringScanner'

interface Frame {
    kind: string
    start: number
    sawBody: boolean
    caseStart: number
}

interface OpenSection {
    start: number
    depth: number
}

const SECTION_HEADER = /^\s*%%(?:\s|$)/
const COMMENT_LINE = /^\s*%/
const BLANK_OR_COMMENT = /^\s*(%.*)?$/
const SHELL_ESCAPE = /^\s*!/
const BLOCK_OPENERS = new Set(['if', 'for', 'parfor', 'while', 'switch', 'try', 'spmd', 'function', 'classdef'])
const CLASSDEF_BLOCKS = new Set(['properties', 'methods', 'events', 'enumeration'])

/**
 * Computes folding ranges for MATLAB code without MATLAB: blocks, switch cases, block
 * comments, runs of comment lines, and sections.
 *
 * The rules follow MATLAB's own folding (R2026a). Sections nest inside blocks and end at the
 * enclosing block's `end` and at else, elseif, catch, case and otherwise. A `%%` inside a
 * string, a block comment or a multi-line matrix does not start a section. For a file with a
 * syntax error MATLAB returns no ranges at all; this keeps folding what it can.
 *
 * @param text The document text
 * @returns The ranges, ordered by start line and then by end line, longest first
 */
export function computeFoldingRanges (text: string): FoldingRange[] {
    const firstPass = scan(text, false)
    // A file whose functions have no `end` needs a second pass that closes a function at the next one
    return firstPass.needsEndlessPass ? scan(text, true).ranges : firstPass.ranges
}

function scan (text: string, endlessFunctions: boolean): { ranges: FoldingRange[], needsEndlessPass: boolean } {
    const lines = text.split(/\r?\n/)
    // A trailing newline does not add a line to fold into
    let lastLine = lines.length - 1
    if (lines.length > 1 && lines[lastLine] === '') {
        lastLine--
    }
    const inBlockComment = computeBlockCommentLines(lines)

    const ranges: FoldingRange[] = []
    const emit = (start: number, end: number, kind?: FoldingRangeKind): void => {
        if (end > start) {
            ranges.push(FoldingRange.create(start, end, undefined, undefined, kind))
        }
    }

    for (const block of computeBlockCommentRanges(lines)) {
        emit(block.start, block.end, FoldingRangeKind.Comment)
    }

    const stack: Frame[] = []
    const sections: OpenSection[] = []
    let bracketDepth = 0
    let parenDepth = 0
    let previousLineContinues = false
    let commentRunStart = -1
    let commentRunEnd = -1
    let functionClosedByEnd = false
    // Counted: scanning the stack for a function at every pop is quadratic in a broken file
    let functionFrames = 0
    // A call, so the lint rule on loop conditions sees that popFrame changes the count
    const hasFunctionFrame = (): boolean => functionFrames > 0

    const flushCommentRun = (): void => {
        if (commentRunStart >= 0) {
            emit(commentRunStart, commentRunEnd, FoldingRangeKind.Comment)
        }
        commentRunStart = -1
    }

    const closeSectionsDeeperThan = (depth: number, endLine: number): void => {
        while (sections.length > 0 && sections[sections.length - 1].depth > depth) {
            const section = sections.pop() as OpenSection
            emit(section.start, endLine, FoldingRangeKind.Region)
        }
    }

    const popFrame = (endLine: number, lastFrameLine: number): Frame => {
        const frame = stack.pop() as Frame
        if (frame.kind === 'function') {
            functionFrames--
        }
        if (frame.kind === 'switch' && frame.caseStart >= 0) {
            emit(frame.caseStart, endLine - 1)
        }

        // A function without `end` ends at its last code line
        const endlessFunction = endlessFunctions && frame.kind === 'function'
        let frameEnd = lastFrameLine
        if (endlessFunction) {
            while (frameEnd > frame.start && (inBlockComment[frameEnd] || BLANK_OR_COMMENT.test(lines[frameEnd]))) {
                frameEnd--
            }
        }

        // Sections inside the frame end with it. After an end-less function, a section that
        // starts past its last code line belongs to the enclosing scope instead.
        const depth = stack.length
        const reparented: OpenSection[] = []
        while (sections.length > 0 && sections[sections.length - 1].depth > depth) {
            const section = sections.pop() as OpenSection
            if (endlessFunction && section.start > frameEnd) {
                section.depth = depth
                reparented.unshift(section)
            } else {
                emit(section.start, endlessFunction ? frameEnd : endLine - 1, FoldingRangeKind.Region)
            }
        }
        for (const section of reparented) {
            const below = sections[sections.length - 1]
            if (below !== undefined && below.depth === depth) {
                sections.pop()
                emit(below.start, section.start - 1, FoldingRangeKind.Region)
            }
            sections.push(section)
        }

        emit(frame.start, frameEnd)
        return frame
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        if (inBlockComment[i]) {
            flushCommentRun()
            previousLineContinues = false
            continue
        }

        if (SECTION_HEADER.test(line) && bracketDepth === 0) {
            flushCommentRun()
            const top = sections[sections.length - 1]
            if (top !== undefined && top.depth === stack.length) {
                sections.pop()
                emit(top.start, i - 1, FoldingRangeKind.Region)
            }
            sections.push({ start: i, depth: stack.length })
            previousLineContinues = false
            continue
        }

        if (COMMENT_LINE.test(line)) {
            if (commentRunStart < 0) {
                commentRunStart = i
            }
            commentRunEnd = i
            previousLineContinues = false
            continue
        }

        flushCommentRun()

        // A shell escape passes the rest of the line to the operating system
        const isShellEscape = bracketDepth === 0 && !previousLineContinues && SHELL_ESCAPE.test(line)

        let continues = false
        let hadCode = isShellEscape
        let closedArguments = false
        let pushedArguments = false

        if (!isShellEscape) {
            const context = classifyLine(line)
            let firstToken = true

            for (let c = 0; c < line.length; c++) {
                if (context[c] === TokenContext.Comment) {
                    if (line.startsWith('...', c)) {
                        continues = true
                    }
                    break
                }
                if (context[c] !== TokenContext.Code) {
                    hadCode = true
                    firstToken = false
                    continue
                }

                const ch = line[c]
                if (/\s/.test(ch)) {
                    continue
                }
                hadCode = true

                if (ch === '[' || ch === '{') {
                    bracketDepth++
                    firstToken = false
                    continue
                }
                if (ch === ']' || ch === '}') {
                    bracketDepth = Math.max(0, bracketDepth - 1)
                    firstToken = false
                    continue
                }
                if (ch === '(') {
                    parenDepth++
                    firstToken = false
                    continue
                }
                if (ch === ')') {
                    parenDepth = Math.max(0, parenDepth - 1)
                    firstToken = false
                    continue
                }

                if (!/[A-Za-z]/.test(ch) || (c > 0 && /[A-Za-z0-9_.]/.test(line[c - 1]))) {
                    firstToken = false
                    continue
                }

                let wordEnd = c
                while (wordEnd < line.length && /[A-Za-z0-9_]/.test(line[wordEnd])) {
                    wordEnd++
                }
                const word = line.slice(c, wordEnd)
                const wasFirstToken = firstToken
                firstToken = false
                c = wordEnd - 1

                // Keywords inside brackets are indexing, as in x(end) and c{end}
                if (parenDepth !== 0 || bracketDepth !== 0) {
                    continue
                }

                const top = stack[stack.length - 1]
                if (BLOCK_OPENERS.has(word)) {
                    if (word === 'function' && endlessFunctions) {
                        while (hasFunctionFrame()) {
                            popFrame(i, i - 1)
                        }
                    }
                    if (word === 'function') {
                        functionFrames++
                    }
                    stack.push({ kind: word, start: i, sawBody: false, caseStart: -1 })
                } else if (word === 'end') {
                    // end(...) declares or calls a method named end
                    if (/^\s*\(/.test(line.slice(wordEnd))) {
                        continue
                    }
                    if (stack.length > 0) {
                        const frame = popFrame(i, i)
                        if (frame.kind === 'function') {
                            functionClosedByEnd = true
                        }
                        if (frame.kind === 'arguments') {
                            closedArguments = true
                        }
                    }
                } else if ((word === 'else' || word === 'elseif') && top?.kind === 'if') {
                    closeSectionsDeeperThan(stack.length - 1, i - 1)
                } else if (word === 'catch' && top?.kind === 'try') {
                    closeSectionsDeeperThan(stack.length - 1, i - 1)
                } else if ((word === 'case' || word === 'otherwise') && top?.kind === 'switch') {
                    closeSectionsDeeperThan(stack.length - 1, i - 1)
                    if (top.caseStart >= 0) {
                        emit(top.caseStart, i - 1)
                    }
                    top.caseStart = i
                } else if (wasFirstToken && CLASSDEF_BLOCKS.has(word) && top?.kind === 'classdef') {
                    stack.push({ kind: word, start: i, sawBody: false, caseStart: -1 })
                } else if (wasFirstToken && word === 'arguments' && top?.kind === 'function' && !top.sawBody) {
                    stack.push({ kind: word, start: i, sawBody: false, caseStart: -1 })
                    pushedArguments = true
                }
            }
        }

        if (!continues) {
            parenDepth = 0
        }

        // An arguments block is only valid before the first statement of a function body
        const top = stack[stack.length - 1]
        if (hadCode && top?.kind === 'function' && top.start !== i && !previousLineContinues && !closedArguments && !pushedArguments) {
            top.sawBody = true
        }
        previousLineContinues = continues
    }

    flushCommentRun()

    const needsEndlessPass = !endlessFunctions && !functionClosedByEnd && functionFrames > 0
    if (endlessFunctions) {
        while (hasFunctionFrame()) {
            popFrame(lastLine + 1, lastLine)
        }
    }
    closeSectionsDeeperThan(-1, lastLine)

    ranges.sort((a, b) => a.startLine !== b.startLine ? a.startLine - b.startLine : b.endLine - a.endLine)
    return { ranges, needsEndlessPass }
}
