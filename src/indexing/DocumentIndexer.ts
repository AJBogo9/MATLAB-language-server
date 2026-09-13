// Copyright 2022 - 2025 The MathWorks, Inc.

import { TextDocument } from 'vscode-languageserver-textdocument'
import Indexer from './Indexer'
import FileInfoIndex from './FileInfoIndex'

const INDEXING_DELAY = 500 // Delay (in ms) after keystroke before attempting to re-index the document

/**
 * Handles indexing a currently open document to gather data about classes,
 * functions, and variables.
 */
export default class DocumentIndexer {
    private readonly pendingFilesToIndex = new Map<string, NodeJS.Timeout>()
    // Parses that have started but not finished, with the document version they
    // captured. Clearing the debounce entry when a parse begins is necessary to
    // avoid double-parsing, but on its own it opens a window in which the
    // document looks indexed while the index still holds pre-edit data.
    private readonly inFlightParses = new Map<string, { version: number, promise: Promise<void> }>()
    private onIndexed?: (uri: string) => void

    constructor (
        private readonly indexer: Indexer,
        private readonly fileInfoIndex: FileInfoIndex
    ) {}

    /**
     * Queues a document to be indexed. This handles debouncing so that
     * indexing is not performed on every keystroke.
     *
     * @param textDocument The document to be indexed
     */
    queueIndexingForDocument (textDocument: TextDocument): void {
        const uri = textDocument.uri
        this.clearTimerForDocumentUri(uri)
        this.pendingFilesToIndex.set(
            uri,
            setTimeout(() => {
                void this.indexDocument(textDocument)
            }, INDEXING_DELAY) // Specify timeout for debouncing, to avoid re-indexing every keystroke while a user types
        )
    }

    /**
     * Indexes the document and caches the data.
     *
     * @param textDocument The document being indexed
     */
    async indexDocument (textDocument: TextDocument): Promise<void> {
        // Drop the debounce entry now that indexing is actually happening.
        // Without this the map keeps the URI forever, so the next
        // ensureDocumentIndexIsUpdated sees the document as still pending and
        // re-parses the whole file through MATLAB: a measured 1006-1974 ms on
        // the single MATLAB thread, once per edit-then-navigate cycle.
        // LintingSupportProvider already clears its own timer this way.
        const uri = textDocument.uri
        this.clearTimerForDocumentUri(uri)

        // Await before announcing. The previous `void` meant onIndexed fired
        // while the parse was still in flight, so semantic highlighting rendered
        // from a cache one edit behind. Both external callers already discard
        // the result with `void`, so widening the return type is source
        // compatible.
        const promise = this.indexer.indexDocument(textDocument)
        this.inFlightParses.set(uri, { version: textDocument.version, promise })

        try {
            await promise
        } finally {
            if (this.inFlightParses.get(uri)?.promise === promise) {
                this.inFlightParses.delete(uri)
            }
        }

        this.onIndexed?.(uri)
    }

    /**
     * Clears any active indexing timers for the provided document URI.
     *
     * @param uri The document URI
     */
    private clearTimerForDocumentUri (uri: string): void {
        const timerId = this.pendingFilesToIndex.get(uri)
        if (timerId != null) {
            clearTimeout(timerId)
            this.pendingFilesToIndex.delete(uri)
        }
    }

    /**
     * Ensure that @param textDocument is fully indexed and up to date by flushing any pending indexing tasks
     * and then forcing an index. This is intended to service requests like documentSymbols where returning
     * stale info could be confusing.
     *
     * @param textDocument The document to index
     */
    async ensureDocumentIndexIsUpdated (textDocument: TextDocument): Promise<void> {
        const uri = textDocument.uri

        // Drain parses that are already running, re-reading the map after each
        // await. The debounce timer can fire while we wait, and the parse it
        // starts already covers the current text: holding a snapshot taken
        // before the await made this issue a second full MATLAB parse of the
        // same version, roughly doubling the latency of an edit-then-navigate
        // cycle at the measured 1006-1974 ms parse cost.
        let awaitedVersion = -1
        let entry = this.inFlightParses.get(uri)
        while (entry !== undefined) {
            await entry.promise
            awaitedVersion = Math.max(awaitedVersion, entry.version)
            const next = this.inFlightParses.get(uri)
            entry = next === entry ? undefined : next
        }

        // One parse at most, chosen from three reasons to need one: the drained
        // parse predates this document version, an edit is still queued, or the
        // file has never been indexed.
        const needsIndex =
            (awaitedVersion >= 0 && awaitedVersion < textDocument.version) ||
            this.pendingFilesToIndex.has(uri) ||
            !this.fileInfoIndex.codeInfoCache.has(uri)

        if (!needsIndex) {
            return
        }

        this.clearTimerForDocumentUri(uri)
        await this.indexer.indexDocument(textDocument)

        // Only announce a real re-index. This method is reached from
        // HighlightSymbolProvider, which runs on every caret move, and
        // onIndexed schedules a workspace-wide semanticTokens/refresh 150 ms
        // later. Firing it unconditionally turned simply moving the cursor into
        // a full workspace token refresh.
        this.onIndexed?.(uri)
    }

    setOnIndexed (callback: (uri: string) => void): void {
        this.onIndexed = callback
    }
}
