// Copyright 2026 Andreas Bogossian

import { CancellationToken, Hover, HoverParams, MarkupKind, Range, TextDocuments } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'
import MatlabLifecycleManager from '../../lifecycle/MatlabLifecycleManager'
import MVM from '../../mvm/impl/MVM'
import Logger from '../../logging/Logger'
import parse from '../../mvm/MdaParser'
import FileInfoIndex from '../../indexing/FileInfoIndex'
import {
    classifySymbolAtPosition, RequestType, SymbolClassification, reportTelemetry
} from '../../indexing/SymbolSearchService'
import { getExpressionAtPosition } from '../../utils/ExpressionUtils'
import { isInCommentOrString } from './CommentStringScanner'
import { escapeMarkdown } from './DocCommentMarkdown'
import { getOperatorHelp, findOperatorAtPosition, isReservedKeyword } from './OperatorHelp'
import { buildOfflineSymbolInfo, renderArgumentsTable, OfflineSymbolInfo } from './OfflineHoverBuilder'
import HoverCache from './HoverCache'

/**
 * Raw hover payload returned by matlabls.handlers.hover.getHoverData.
 *
 * Every flag is a double, not a logical: MdaParser handles int8..uint64, single,
 * double, string, char, cell and struct, and falls through to a "Unexpected
 * mwtype encountered" log for anything else.
 */
interface MHoverData {
    topic?: string
    helpText?: string
    signatures?: string | string[]
    isResolved?: number
    isBuiltin?: number
    whichPath?: string
    docUrl?: string
    shadowedBy?: string
    truncated?: number
}

/**
 * Matches a function declaration and captures its name, covering the no-output,
 * single-output and bracketed-output-list forms.
 */
const FUNCTION_DECLARATION_NAME = /^\s*function\s+(?:\[[^\]]*\]\s*=\s*|[A-Za-z][A-Za-z0-9_]*\s*=\s*)?([A-Za-z][A-Za-z0-9_]*)/

/**
 * Provides textDocument/hover.
 *
 * The ordering here is the whole design. Classification comes before any call to
 * help(), because MATLAB resolves an unknown name to an unrelated topic rather
 * than failing, and common variable names (`i`, `x`, `idx`, `data`, `results`)
 * all resolve to something confidently wrong.
 */
class HoverSupportProvider {
    // Caches the MATLAB-sourced payload only. Caching the composed card
    // instead leaked document content across files (the key is topic plus
    // release, but the card embeds the hovered document's own summary and
    // arguments table) and kept showing pre-edit content after a save.
    private readonly cache = new HoverCache<MHoverData>(256)

    // Deliberately does not take a DocumentIndexer. NavigationSupportProvider
    // awaits ensureDocumentIndexIsUpdated before resolving a definition, which is
    // right for a rare user-initiated jump but wrong here: re-indexing costs a
    // measured 1006-1974 ms on MATLAB's single thread, and hover fires on every
    // mouse settle. Classification therefore reads whatever the index last had,
    // and the document-sourced half of the card is always current.
    constructor (
        private readonly matlabLifecycleManager: MatlabLifecycleManager,
        private readonly mvm: MVM,
        private readonly fileInfoIndex: FileInfoIndex
    ) {}

    /**
     * Drops the whole cache. Called when the MATLAB connection changes state,
     * since a new session may have a different path, different shadowing and a
     * different release.
     */
    clearCache (): void {
        this.cache.clear()
    }

    /**
     * Handles a textDocument/hover request.
     *
     * @param params Parameters from the onHover request
     * @param documentManager The text document manager
     * @param token Cancellation token supplied by the LSP connection
     * @returns The hover card, or null when there is nothing useful to show
     */
    async handleHoverRequest (
        params: HoverParams, documentManager: TextDocuments<TextDocument>, token?: CancellationToken
    ): Promise<Hover | null> {
        const uri = params.textDocument.uri
        const doc = documentManager.get(uri)

        if (doc == null) {
            return null
        }

        const text = doc.getText()
        const lines = text.split(/\r?\n/)
        const { line, character } = params.position

        // Gate on comments and strings first. Nothing downstream knows the
        // difference, so without this a documentation card appears for the word
        // `plot` inside `% remember to plot this`.
        if (isInCommentOrString(lines, line, character)) {
            return null
        }

        // Operators and punctuation resolve from a bundled table, so this path
        // needs no index and no MATLAB. It is the only part of hover that works
        // during the cold start.
        const operatorHover = this.tryOperatorHover(lines, line, character)
        if (operatorHover != null) {
            return operatorHover
        }

        const expression = getExpressionAtPosition(doc, params.position)
        if (expression == null) {
            return null
        }

        // A keyword is a word, so the identifier scan finds it before the
        // operator scan can. Only RESERVED words take the fast path: the six
        // context-sensitive block keywords (arguments, properties, methods,
        // events, enumeration, import) are all legal identifiers, and answering
        // them from the table unconditionally gave the builtin's card to any
        // variable, parameter, struct field or local function with one of those
        // names.
        const keywordEntry = getOperatorHelp(expression.unqualifiedTarget)
        if (keywordEntry != null && isReservedKeyword(expression.unqualifiedTarget)) {
            return this.toHover(this.renderKeywordCard(keywordEntry.topic, keywordEntry.text), null)
        }

        if (isCancelled(token)) {
            return null
        }

        // Classify against the index where possible. When the file is not
        // indexed (MATLAB down, cold start, or indexing disabled) this returns
        // null and the dotted expression from the text is used instead, which is
        // strictly less accurate but still useful.
        const classified = this.classify(uri, params, documentManager)
        const topic = classified?.targetExpression ?? expression.targetExpression
        const hoverRange = classified != null ? classified.range.range : undefined

        // A context-sensitive block keyword falls through to here. Answer it
        // from the table only when the index has no opinion AND the token is
        // actually opening a block. Offline the index has no opinion about
        // anything, so without the shape check a variable or struct field named
        // `properties` would get the builtin's card.
        if (classified == null && keywordEntry?.isKeyword === true &&
            isBlockKeywordUsage(lines[line], expression.unqualifiedTarget)) {
            return this.toHover(this.renderKeywordCard(keywordEntry.topic, keywordEntry.text), null)
        }

        const offline = buildOfflineSymbolInfo(text, expression.unqualifiedTarget)

        // Never run help() on something the index says is a variable.
        if (classified?.classification === SymbolClassification.Variable) {
            return this.toHover(
                this.renderVariableCard(expression.unqualifiedTarget, text, expression.unqualifiedTarget, line),
                hoverRange
            )
        }

        const cacheKey = HoverCache.keyFor(topic, this.mvm.getMatlabRelease() ?? 'unknown')
        let hoverData = this.cache.get(cacheKey) ?? null

        if (hoverData === null) {
            hoverData = await this.retrieveHoverData(topic, token)

            if (isCancelled(token)) {
                return null
            }

            // Only cache what a ready MATLAB answered. Caching a null would pin
            // an offline session's emptiness for the rest of its life and never
            // upgrade once MATLAB connects.
            if (hoverData != null) {
                this.cache.set(cacheKey, hoverData)
            }

            reportTelemetry(RequestType.Hover)
        }

        // Always recompose: the document half of the card must reflect the
        // document being hovered, right now. A qualified name such as mypkg.parse only
        // shares its last part with a function declared here, unless the qualifier is the
        // class this document declares.
        const declared = offline != null && declaresTopic(text, topic, offline.name) ? offline : null
        const helpIsForThisFile = hoverData?.whichPath != null && hoverData.whichPath !== '' &&
            URI.parse(uri).fsPath === hoverData.whichPath
        const markdown = this.renderSymbolCard(topic, hoverData, declared, helpIsForThisFile)

        if (markdown === '') {
            return null
        }

        return this.toHover(markdown, hoverRange)
    }

    private classify (
        uri: string, params: HoverParams, documentManager: TextDocuments<TextDocument>
    ): ReturnType<typeof classifySymbolAtPosition> {
        try {
            return classifySymbolAtPosition(
                uri, params.position, this.fileInfoIndex, documentManager, RequestType.Hover
            )
        } catch (err) {
            Logger.error('Error caught while classifying hover target:')
            Logger.error(err as string)
            return null
        }
    }

    private tryOperatorHover (lines: string[], line: number, character: number): Hover | null {
        const lineText = lines[line]
        if (lineText === undefined) {
            return null
        }

        const match = findOperatorAtPosition(lineText, character)
        if (match == null) {
            return null
        }

        const entry = getOperatorHelp(match.topic)
        if (entry == null) {
            return null
        }

        return this.toHover(
            this.renderKeywordCard(entry.topic, entry.text),
            Range.create(line, match.start, line, match.end)
        )
    }

    /**
     * Retrieves raw hover data from MATLAB.
     *
     * Returns null rather than queueing when MATLAB is not ready. The MVM
     * serializes fevals and offers neither timeout nor cancel, so a hover issued
     * during a long-running user command would otherwise sit in that queue and
     * arrive long after the pointer moved away.
     *
     * @param topic The resolved help topic
     * @param token Cancellation token
     * @returns The raw payload, or null if MATLAB is unavailable or errored
     */
    private async retrieveHoverData (topic: string, token?: CancellationToken): Promise<MHoverData | null> {
        if (!this.mvm.isReady()) {
            return null
        }

        if (isCancelled(token)) {
            return null
        }

        try {
            const response = await this.mvm.feval(
                'matlabls.handlers.hover.getHoverData',
                1,
                [topic]
            )

            if ('error' in response) {
                Logger.error('Error received while retrieving hover data:')
                Logger.error(response.error.msg)
                return null
            }

            return parse(response.result[0]) as MHoverData
        } catch (err) {
            Logger.error('Error caught while retrieving hover data:')
            Logger.error(err as string)
            return null
        }
    }

    private renderKeywordCard (topic: string, text: string): string {
        return ['**' + topic + '**', '', '```matlab', text, '```'].join('\n')
    }

    /**
     * Renders the card for a variable.
     *
     * There is deliberately no help() content here. What the code itself says
     * about the variable is the only sound static answer; a live value would
     * reflect the last run rather than the buffer, so it belongs behind an
     * explicit opt-in and an explicit staleness label, not here.
     */
    private renderVariableCard (name: string, documentText: string, symbolName: string, line: number): string {
        const parts: string[] = ['**' + name + '**  ·  variable']

        // An arguments block declaration is the richest static statement about a
        // variable that MATLAB itself cannot give you.
        const lines = documentText.split(/\r?\n/)
        const enclosing = this.findEnclosingFunctionName(lines, line)
        if (enclosing != null) {
            const info = buildOfflineSymbolInfo(documentText, enclosing)
            // Every matching declaration, not just the first. An options struct
            // declares one row per name-value field, and showing only one made
            // a three-field struct's card byte-identical to a one-field struct's.
            const declarations = info?.argumentDeclarations.filter(
                d => d.name === symbolName || d.name.startsWith(symbolName + '.')
            ) ?? []

            if (declarations.length > 0) {
                parts.push('', '```matlab', renderArgumentsTable(declarations), '```')

                const first = declarations[0].line + 1
                const last = declarations[declarations.length - 1].line + 1
                parts.push('', declarations.length === 1
                    ? '_declared in an arguments block, line ' + String(first) + '_'
                    : '_name-value arguments, declared in an arguments block, lines ' +
                      String(first) + '-' + String(last) + '_')
                return parts.join('\n')
            }
        }

        // Say only what is known. The index classified this as a variable
        // reference, which also covers struct field access and method calls, so
        // asserting "local variable" would be wrong for `opts.Method` and for
        // `obj.doThing`.
        parts.push('', '_no declaration found in this file_')
        return parts.join('\n')
    }

    private findEnclosingFunctionName (lines: string[], hoverLine: number): string | null {
        // Scan upward from the hover position for the nearest preceding function
        // declaration. Taking the first declaration in the file instead would
        // attribute a variable in the third local function to the first one's
        // arguments block, and show its type and validators for a completely
        // different parameter that happens to share a name.
        for (let i = Math.min(hoverLine, lines.length - 1); i >= 0; i--) {
            const match = FUNCTION_DECLARATION_NAME.exec(lines[i])
            if (match != null) {
                return match[1]
            }
        }
        return null
    }

    /**
     * Composes the documentation card for a function, class or method.
     *
     * MATLAB-sourced content and document-sourced content are merged rather than
     * treated as alternatives: help() cannot see an `arguments` block or an
     * unsaved buffer, and the document cannot see a builtin.
     */
    private renderSymbolCard (
        topic: string, data: MHoverData | null, offline: OfflineSymbolInfo | null, helpIsForThisFile: boolean
    ): string {
        const parts: string[] = []

        // A symbol declared in this document is described by its comment here. help() reads
        // the saved file, so its text can be stale, and for a file on the path it is the same
        // comment again, which repeated the summary line under the title.
        const documentComment = offline?.hasDocComment === true ? offline : null

        // help() opens with " fft - Fast Fourier transform", which belongs on the
        // title line rather than buried at the top of the body.
        const helpSummary = extractHelpSummary(topic, data?.helpText)
        const summary = documentComment != null ? documentComment.summary : helpSummary
        parts.push(summary != null && summary !== '' ? '**' + topic + '**  ·  ' + escapeMarkdown(summary) : '**' + topic + '**')

        const signatures = this.normalizeSignatures(data, offline)
        if (signatures.length > 0) {
            parts.push('', '```matlab', signatures.join('\n'), '```')
        }

        if (documentComment != null) {
            // Prose, so the hover reflows lines the author wrapped by hand
            if (documentComment.bodyMarkdown != null) {
                parts.push('', documentComment.bodyMarkdown)
            }
        } else {
            const body = this.composeHelpBody(data, signatures.length > 0)
            // Drop the summary line from the body when it was promoted above.
            const trimmedBody = helpSummary != null ? stripLeadingSummaryLine(body, topic) : body
            if (trimmedBody !== '') {
                parts.push('', '```matlab', trimmedBody, '```')
            }
        }

        const argumentsTable = offline != null ? renderArgumentsTable(offline.argumentDeclarations) : ''
        if (argumentsTable !== '') {
            parts.push('', '**Arguments**', '', '```matlab', argumentsTable, '```')
        }

        // What help() says about another file does not describe a symbol declared here
        const describesThisSymbol = offline == null || helpIsForThisFile

        if (describesThisSymbol && data?.shadowedBy != null && data.shadowedBy !== '') {
            parts.push('', '⚠ Shadowed by `' + data.shadowedBy + '`')
        }

        // Only a real mathworks.com URL is worth rendering. getHelpPopupUrl also
        // returns per-session https://127.0.0.1:<rotating port>/ URLs for user
        // files and for licensed-but-not-installed toolboxes, and the .m handler
        // filters those out before they reach here.
        if (describesThisSymbol && data?.docUrl != null && data.docUrl !== '') {
            parts.push('', '[Documentation](' + data.docUrl + ')')
        }

        // Nothing but a bold name is not worth a tooltip. A name plus a summary
        // is, which is why this tests for real content rather than for the
        // number of parts: promoting the summary to the title line can leave the
        // body empty while the card is still worth showing.
        const hasSummary = summary != null && summary !== ''
        if (!hasSummary && parts.length === 1) {
            return ''
        }

        return parts.join('\n')
    }

    private normalizeSignatures (data: MHoverData | null, offline: OfflineSymbolInfo | null): string[] {
        // A declaration in this document is its own signature; help() may describe another file
        if (offline?.signature != null && offline.signature !== '') {
            return [offline.signature]
        }

        let signatures: string[] = []

        if (data?.signatures != null) {
            signatures = Array.isArray(data.signatures) ? data.signatures : [data.signatures]
            signatures = signatures.filter(s => typeof s === 'string' && s.trim() !== '')
            // MATLAB returns one entry per overload, and for keywords such as
            // `end` those can be identical.
            signatures = Array.from(new Set(signatures))
        }

        return signatures
    }

    /**
     * Builds the body from MATLAB's help text.
     *
     * The Syntax block is stripped when signatures were rendered above it,
     * because help() repeats them verbatim there.
     */
    private composeHelpBody (data: MHoverData | null, signaturesRendered: boolean): string {
        const helpText = data?.helpText
        if (helpText != null && helpText.trim() !== '') {
            return signaturesRendered ? stripSyntaxSection(helpText) : helpText
        }
        return ''
    }

    private toHover (markdown: string, range: Range | null | undefined): Hover {
        const hover: Hover = {
            contents: {
                kind: MarkupKind.Markdown,
                value: markdown
            }
        }
        if (range != null) {
            hover.range = range
        }
        return hover
    }
}

/**
 * True when the token opens a block or an import statement: it is the first
 * non-whitespace token on its line and is not being used as an operand.
 *
 * @param lineText The line the token sits on
 * @param name The token
 * @returns Whether this looks like a block header rather than an identifier
 */
function isBlockKeywordUsage (lineText: string | undefined, name: string): boolean {
    if (lineText === undefined) {
        return false
    }

    const trimmed = lineText.trimStart()
    if (!trimmed.startsWith(name)) {
        return false
    }

    const rest = trimmed.slice(name.length).trimStart()

    // A block header is bare, carries an attribute list, or ends in a comment.
    // Anything that continues with an operator, a dot, an assignment or an
    // index is the token being used as a value.
    return rest === '' || rest.startsWith('(') || rest.startsWith('%')
}

/**
 * Whether a hover topic is the symbol declared under that name in this document: the same
 * name, or Class.name for the class the document declares.
 *
 * @param documentText The document text
 * @param topic The resolved help topic
 * @param name The name declared in the document
 * @returns True when the declaration describes the topic
 */
function declaresTopic (documentText: string, topic: string, name: string): boolean {
    if (topic === name) {
        return true
    }
    const parts = topic.split('.')
    return parts.length === 2 && parts[1] === name && buildOfflineSymbolInfo(documentText, parts[0])?.kind === 'classdef'
}

/**
 * Reads a cancellation token.
 *
 * Kept as a free function so the compiler cannot narrow the property to `false`
 * after the first check and then reject every later one as unreachable. The
 * whole point of a token is that the value changes underneath us.
 *
 * @param token The token, which the connection may or may not supply
 * @returns True when cancellation has been requested
 */
function isCancelled (token?: CancellationToken): boolean {
    return token?.isCancellationRequested === true
}

/**
 * Extracts MATLAB's one-line summary from help output.
 *
 * On R2026a the sectioned reference format opens with " fft - Fast Fourier
 * transform". User files return their raw comment block instead and have no such
 * line, so this must return null rather than guessing.
 *
 * The topic is matched against the leading name because a dotted topic
 * ("MyClass.increment") reports only its last component there.
 *
 * @param topic The resolved help topic
 * @param helpText The raw help text
 * @returns The summary, or null when the help text does not open with one
 */
export function extractHelpSummary (topic: string, helpText: string | undefined): string | null {
    if (helpText == null || helpText.trim() === '') {
        return null
    }

    const firstLine = helpText.split('\n')[0].trim()
    const lastComponent = topic.split('.').pop() ?? topic
    const match = /^(\S+)\s+-\s+(.+)$/.exec(firstLine)

    if (match == null) {
        return null
    }

    if (match[1] !== topic && match[1] !== lastComponent) {
        return null
    }

    return match[2].trim()
}

/**
 * Removes the leading summary line from a help body once it has been promoted to
 * the title line.
 *
 * @param body The help body
 * @param topic The resolved help topic
 * @returns The body without its summary line
 */
export function stripLeadingSummaryLine (body: string, topic: string): string {
    if (body === '') {
        return body
    }

    const lines = body.split('\n')
    const lastComponent = topic.split('.').pop() ?? topic
    const match = /^(\S+)\s+-\s+(.+)$/.exec(lines[0].trim())

    if (match == null || (match[1] !== topic && match[1] !== lastComponent)) {
        return body
    }

    const remaining = lines.slice(1)
    while (remaining.length > 0 && remaining[0].trim() === '') {
        remaining.shift()
    }

    return remaining.join('\n')
}

/**
 * Removes the "Syntax" section from help output.
 *
 * R2026a returns a sectioned reference format for builtins but the raw leading
 * comment block for user files, so this must tolerate the section being absent
 * entirely rather than assuming either shape.
 *
 * @param helpText The raw help text
 * @returns The text with its Syntax section removed
 */
export function stripSyntaxSection (helpText: string): string {
    const lines = helpText.split('\n')
    const start = lines.findIndex(line => line.trim() === 'Syntax')

    if (start === -1) {
        return helpText
    }

    const syntaxIndent = lines[start].length - lines[start].trimStart().length

    let end = start + 1
    while (end < lines.length) {
        const line = lines[end]
        if (line.trim() === '') {
            end++
            continue
        }
        const indent = line.length - line.trimStart().length
        if (indent <= syntaxIndent) {
            break
        }
        end++
    }

    const remaining = [...lines.slice(0, start), ...lines.slice(end)]

    while (remaining.length > 0 && remaining[remaining.length - 1].trim() === '') {
        remaining.pop()
    }

    return remaining.join('\n')
}

export default HoverSupportProvider
