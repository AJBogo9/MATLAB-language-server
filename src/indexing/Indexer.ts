// Copyright 2022 - 2025 The MathWorks, Inc.

import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'
import MatlabLifecycleManager from '../lifecycle/MatlabLifecycleManager'
import FileInfoIndex, { CodeInfo, MatlabClassInfo } from './FileInfoIndex'
import * as fs from 'fs/promises'
import ConfigurationManager from '../lifecycle/ConfigurationManager'
import MVM from '../mvm/impl/MVM'
import Logger from '../logging/Logger'
import parse from '../mvm/MdaParser'
import * as FileNameUtils from '../utils/FileNameUtils'
import { MatlabConnection } from '../lifecycle/MatlabCommunicationManager'
import { findMatlabFiles } from './workspace/WorkspaceFileWalker'

interface IndexedFileResponse {
    isDone: boolean
    filePath: string
    codeData?: CodeInfo
    error?: string
}

// Published once a background pool worker has started the crawl, before its first file
interface CrawlStartedResponse {
    isStarted: true
}

// Published when the crawl ends early: by the worker for an error it caught, or by an afterAll
// callback on the MATLAB thread for a crawl that was cancelled or could not report itself
interface CrawlFailedResponse {
    isFailed: true
    error: string
}

type CrawlResponse = IndexedFileResponse | CrawlStartedResponse | CrawlFailedResponse

// How long a started workspace crawl may go without a file arriving before a warning names
// the file MATLAB is on. The crawl keeps waiting, since a large generated file can parse
// for minutes.
export const CRAWL_SILENCE_WARNING_MS = 60000

export type CrawlResult = 'done' | 'aborted' | 'unavailable'

export interface CrawlOptions {
    // Called once MATLAB is known to be there, just before the files are sent
    onStart?: () => Promise<void>
    // Called for every file MATLAB reports on, whether or not it could be parsed
    onFileDone?: (uri: string) => void
    // Whether a parsed file may replace what the index holds for it
    shouldStore?: (uri: string) => boolean
    // Called once, when the crawl first goes CRAWL_SILENCE_WARNING_MS without a file after a
    // worker started it. The crawl carries on. A crawl waiting for a free worker never stalls.
    onStalled?: () => void
}

interface DocumentParseResponse {
    requestId: number
    codeData?: CodeInfo
    error?: string
}

// How long a queued background parse may take before the document is parsed on the
// MATLAB thread instead. A large file parses in about 2 s.
export const BACKGROUND_PARSE_TIMEOUT_MS = 10000

// Status codes returned by parseInfoFromDocumentAsync
const PARSE_UNAVAILABLE = 0
const PARSE_QUEUED = 1

// The background parse gave no answer, so parse on the MATLAB thread instead
const FALLBACK = Symbol('fallback')

type BackgroundParseResult = CodeInfo | null | typeof FALLBACK

interface PendingParse {
    connection: MatlabConnection
    resolve: (result: BackgroundParseResult) => void
    timer?: NodeJS.Timeout
}

export default class Indexer {
    private readonly INDEX_FILES_RESPONSE_CHANNEL = '/matlabls/indexFiles/response'
    private readonly PARSE_DOCUMENT_RESPONSE_CHANNEL = '/matlabls/parseDocument/response'

    // Gives up each crawl still waiting for files
    private readonly abortCrawls = new Set<() => void>()

    // Parses can finish out of order, so each one carries the order in which its text
    // was read, and an older result never replaces a newer one.
    private lastParseRequestId = 0
    private readonly newestStoredRequestId = new Map<string, number>()

    private readonly pendingParses = new Map<number, PendingParse>()
    private parseSubscription: { connection: MatlabConnection, channel: string } | null = null
    private backgroundParseDeclinedFor: MatlabConnection | null = null

    constructor (
        private readonly matlabLifecycleManager: MatlabLifecycleManager,
        private readonly mvm: MVM,
        private readonly fileInfoIndex: FileInfoIndex
    ) {
        // No result can arrive once MATLAB is gone, so nothing should keep waiting for one
        this.matlabLifecycleManager.eventEmitter.on('disconnected', () => {
            for (const requestId of [...this.pendingParses.keys()]) {
                this.settlePendingParse(requestId, null)
            }
            for (const abortCrawl of [...this.abortCrawls]) {
                abortCrawl()
            }
        })
    }

    /**
     * Indexes the given TextDocument and caches the data.
     *
     * @param textDocument The document being indexed
     */
    async indexDocument (textDocument: TextDocument): Promise<void> {
        if (!this.mvm.isReady()) {
            // MVM not yet ready
            return
        }

        const requestId = ++this.lastParseRequestId
        const codeInfo = await this.getCodeInfo(textDocument.getText(), textDocument.uri, requestId)

        if (codeInfo === null || !this.claimNewestParse(textDocument.uri, requestId)) {
            return
        }

        const existingAssociatedClassInfo: MatlabClassInfo | undefined =
            this.fileInfoIndex.codeInfoCache.get(textDocument.uri)?.associatedClassInfo

        // if this file has previously contributed its info
        // to parsed class info
        if (existingAssociatedClassInfo) {
            existingAssociatedClassInfo.clear()

            const parsedCodeInfo = this.fileInfoIndex.parseAndStoreCodeInfo(textDocument.uri, codeInfo)

            // Queue indexing for other files in @ class directory
            const classDefFolder = parsedCodeInfo.classDefFolder
            if (classDefFolder) {
                this.indexFolders([classDefFolder])
            }
        } else {
            this.fileInfoIndex.parseAndStoreCodeInfo(textDocument.uri, codeInfo)
        }
    }

    /**
     * Indexes all M files within the given list of folders.
     *
     * @param folders A list of folder URIs to be indexed
     */
    async indexFolders (folders: string[]): Promise<void> {
        const filePaths: string[] = []
        for (const folder of folders) {
            filePaths.push(...await findMatlabFiles(URI.parse(folder).fsPath, () => false))
        }

        await this.indexFiles(filePaths)
    }

    /**
     * Has MATLAB parse the given files on its background pool, and stores the results
     * as they arrive. All files go in a single request, so the MATLAB thread is needed
     * only once, however long the crawl takes. The crawl waits for a free worker, and for
     * each file to parse, for as long as that takes. It ends once every file was reported
     * on, when the request or its future fails, or when MATLAB disconnects. A file that
     * brings no result for CRAWL_SILENCE_WARNING_MS is named in a warning, and the first
     * such warning reports the crawl as stalled.
     *
     * A crawl given up because its request failed while MATLAB is still ready is
     * cancelled in MATLAB. A crawl given up for a disconnect is not: a local MATLAB is
     * shut down, which ends its futures, and a remote one (matlabUrl) cannot be reached,
     * so its crawl runs to its end with nobody listening.
     *
     * @param filePaths The absolute paths of the files
     * @param options Hooks for reporting progress and a stall, and for declining results
     * @returns 'done' once every file was reported on, 'aborted' if the request or its
     * future failed or MATLAB disconnected, or 'unavailable' if MATLAB is not there to crawl
     */
    async indexFiles (filePaths: string[], options: CrawlOptions = {}): Promise<CrawlResult> {
        if (filePaths.length === 0) {
            return 'done'
        }

        const connection = await this.matlabLifecycleManager.getMatlabConnection()
        if (connection == null || !this.mvm.isReady()) {
            return 'unavailable'
        }

        await options.onStart?.()

        const analysisLimit = (await ConfigurationManager.getConfiguration()).maxFileSizeForAnalysis
        // Each crawl gets its own channel, so concurrent crawls cannot finish each other
        const channel = `${this.INDEX_FILES_RESPONSE_CHANNEL}/${connection.getChannelId()}`

        return await new Promise<CrawlResult>(resolve => {
            let isSettled = false
            let hasStalled = false
            let silenceTimer: NodeJS.Timeout | undefined

            const settle = (result: CrawlResult): void => {
                if (isSettled) {
                    return
                }
                isSettled = true
                clearTimeout(silenceTimer)
                this.abortCrawls.delete(abort)
                connection.unsubscribe(subscription)
                resolve(result)
            }
            const abort = (): void => settle('aborted')

            // Gives the crawl up after its request failed. MATLAB may have queued the crawl
            // before the failure, so while MATLAB is still ready the crawl is cancelled there.
            // The cancel is sent after the crawl request, so a crawl MATLAB queued is recorded
            // by then. A crawl already over is left alone: it finished, MATLAB reported it
            // failed, or it was given up for a disconnect, after which a ready MATLAB may be
            // another session.
            const giveUpRequest = (): void => {
                if (isSettled) {
                    return
                }
                settle('aborted')
                if (this.mvm.isReady()) {
                    this.cancelCrawlInMatlab(channel)
                }
            }

            // MATLAB publishes the files in list order, so this also indexes the file it is on
            let filesReceived = 0

            // Armed once a worker has started the crawl, so neither time spent waiting for
            // the MATLAB thread nor time spent waiting for a free worker counts. It warns once
            // per silent stretch and never gives the crawl up: a large generated file can
            // parse for minutes, and giving up would lose every file after it. The first
            // warning reports the crawl as stalled, so that other crawls need not wait for it.
            const restartSilenceTimer = (): void => {
                clearTimeout(silenceTimer)
                silenceTimer = setTimeout(() => {
                    Logger.warn(`No workspace indexing result for ${CRAWL_SILENCE_WARNING_MS} ms while MATLAB parses ${filePaths[filesReceived]}. Indexing continues.`)
                    if (!hasStalled) {
                        hasStalled = true
                        options.onStalled?.()
                    }
                }, CRAWL_SILENCE_WARNING_MS)
            }

            this.abortCrawls.add(abort)

            // Published data arrives as plain JSON, so it must not go through MdaParser
            const subscription = connection.subscribe(channel, message => {
                const response = message as CrawlResponse

                if ('isStarted' in response) {
                    restartSilenceTimer()
                    return
                }
                if ('isFailed' in response) {
                    Logger.error(`Workspace indexing failed in MATLAB: ${response.error}`)
                    settle('aborted')
                    return
                }

                const uri = URI.file(response.filePath).toString()

                if (response.codeData === undefined) {
                    Logger.warn(`Unable to index ${response.filePath}: ${response.error ?? 'no data'}`)
                } else if (response.codeData.errorInfo === undefined && (options.shouldStore?.(uri) ?? true)) {
                    this.fileInfoIndex.parseAndStoreCodeInfo(uri, response.codeData)
                }
                options.onFileDone?.(uri)
                filesReceived++

                if (response.isDone) {
                    settle('done')
                } else {
                    restartSilenceTimer()
                }
            })

            const mdaFilePaths = {
                mwtype: 'string',
                mwsize: [1, filePaths.length],
                mwdata: filePaths
            }

            this.mvm.feval(
                'matlabls.handlers.indexing.parseInfoFromFiles',
                0,
                [mdaFilePaths, analysisLimit, channel]
            ).then(response => {
                if ('error' in response) {
                    Logger.error(`Error received while indexing the workspace: ${response.error.msg as string}`)
                    giveUpRequest()
                }
            }, err => {
                Logger.error(`Error caught while indexing the workspace: ${String(err)}`)
                giveUpRequest()
            })
        })
    }

    /**
     * Indexes the file for the given URI and caches the data.
     *
     * @param uri The URI for the file being indexed
     */
    async indexFile (uri: string): Promise<void> {
        if (!this.mvm.isReady()) {
            // MVM not yet ready
            return
        }

        const requestId = ++this.lastParseRequestId
        const filePath = FileNameUtils.getFilePathFromUri(uri)
        const fileContentBuffer = await fs.readFile(filePath)
        const code = fileContentBuffer.toString()
        const codeInfo = await this.getCodeInfo(code, uri, requestId)

        if (codeInfo === null || !this.claimNewestParse(uri, requestId)) {
            return
        }

        this.fileInfoIndex.parseAndStoreCodeInfo(uri, codeInfo)
    }

    /**
     * Asks MATLAB to cancel the crawl that publishes on the channel, without waiting for
     * the answer, so that the crawl does not keep a pool worker busy for nobody.
     *
     * @param channel The crawl's response channel
     */
    private cancelCrawlInMatlab (channel: string): void {
        this.mvm.feval('matlabls.handlers.indexing.cancelCrawl', 0, [channel]).then(response => {
            if ('error' in response) {
                Logger.warn(`Unable to cancel a workspace crawl in MATLAB: ${response.error.msg as string}`)
            }
        }, err => {
            Logger.warn(`Unable to cancel a workspace crawl in MATLAB: ${String(err)}`)
        })
    }

    /**
     * Retrieves data about classes, functions, and variables from the given document.
     *
     * The parse runs on MATLAB's background pool when it can: a large file takes up to
     * about 2 s, and on the MATLAB thread that holds up every other request. It runs on
     * the MATLAB thread when the pool is unavailable, busy, or fails.
     *
     * @param code The code being parsed
     * @param uri The URI associated with the code
     * @param requestId The order in which this parse read its text
     *
     * @returns The raw data extracted from the document
     */
    private async getCodeInfo (code: string, uri: string, requestId: number): Promise<CodeInfo | null> {
        const connection = await this.matlabLifecycleManager.getMatlabConnection()

        if (connection != null && connection !== this.backgroundParseDeclinedFor) {
            const result = await this.getCodeInfoInBackground(connection, code, uri, requestId)
            if (result !== FALLBACK) {
                return result
            }
        }

        return await this.getCodeInfoSynchronously(code, uri)
    }

    /**
     * Records that a parse is about to be stored, unless a newer parse of the same
     * document has already been stored.
     *
     * @returns Whether this parse should be stored
     */
    private claimNewestParse (uri: string, requestId: number): boolean {
        if (requestId < (this.newestStoredRequestId.get(uri) ?? 0)) {
            return false
        }
        this.newestStoredRequestId.set(uri, requestId)
        return true
    }

    /**
     * Parses the document on MATLAB's background pool. The result is published on a
     * channel instead of returned, so the MATLAB thread is free while the parse runs.
     *
     * @returns The parsed data, null if the document could not be parsed, or FALLBACK
     * if it should be parsed on the MATLAB thread instead
     */
    private async getCodeInfoInBackground (connection: MatlabConnection, code: string, uri: string, requestId: number): Promise<BackgroundParseResult> {
        let channel: string
        try {
            channel = this.subscribeToParseResponses(connection)
        } catch (err) {
            Logger.error(`Unable to subscribe to background parse results: ${String(err)}`)
            this.backgroundParseDeclinedFor = connection
            return FALLBACK
        }

        const filePath = FileNameUtils.getFilePathFromUri(uri)
        const analysisLimit = (await ConfigurationManager.getConfiguration()).maxFileSizeForAnalysis

        // Wait for the result before asking, since it can be published before the request returns
        const reply = new Promise<BackgroundParseResult>(resolve => {
            this.pendingParses.set(requestId, { connection, resolve })
        })

        let status = PARSE_UNAVAILABLE
        try {
            const response = await this.mvm.feval(
                'matlabls.handlers.indexing.parseInfoFromDocumentAsync',
                1,
                [code, filePath, analysisLimit, channel, requestId]
            )

            if ('error' in response) {
                Logger.error('Error received while starting a background parse:')
                Logger.error(response.error.msg)
            } else {
                status = parse(response.result[0]) as number
            }
        } catch (err) {
            Logger.error('Error caught while starting a background parse:')
            Logger.error(err as string)
        }

        if (status !== PARSE_QUEUED) {
            if (status === PARSE_UNAVAILABLE) {
                this.backgroundParseDeclinedFor = connection
            }
            this.settlePendingParse(requestId, FALLBACK)
            return await reply
        }

        // Timed from when the pool accepted the parse, so time spent waiting behind the
        // user's own code on the MATLAB thread does not count against it
        const pending = this.pendingParses.get(requestId)
        if (pending !== undefined) {
            pending.timer = setTimeout(() => {
                Logger.warn(`No background parse result after ${BACKGROUND_PARSE_TIMEOUT_MS} ms. Parsing on the MATLAB thread from now on.`)
                this.backgroundParseDeclinedFor = connection
                this.settlePendingParse(requestId, FALLBACK)
            }, BACKGROUND_PARSE_TIMEOUT_MS)
        }

        return await reply
    }

    /**
     * Subscribes, once per MATLAB connection, to the channel background parses publish on.
     *
     * @returns The channel name
     */
    private subscribeToParseResponses (connection: MatlabConnection): string {
        let subscription = this.parseSubscription
        if (subscription === null || subscription.connection !== connection) {
            const channel = `${this.PARSE_DOCUMENT_RESPONSE_CHANNEL}/${connection.getChannelId()}`
            connection.subscribe(channel, message => this.handleParseResponse(message as DocumentParseResponse))
            subscription = { connection, channel }
            this.parseSubscription = subscription
        }
        return subscription.channel
    }

    /**
     * Handles a published background parse result. Published data arrives as plain JSON,
     * so unlike a feval result it must not go through MdaParser.
     *
     * @param message The published result
     */
    private handleParseResponse (message: DocumentParseResponse): void {
        const pending = this.pendingParses.get(message.requestId)
        if (pending === undefined) {
            // Already settled, by a timeout or a disconnect
            return
        }

        if (message.error !== undefined || message.codeData === undefined) {
            Logger.error(`Background parse failed: ${message.error ?? 'no data'}. Parsing on the MATLAB thread from now on.`)
            this.backgroundParseDeclinedFor = pending.connection
            this.settlePendingParse(message.requestId, FALLBACK)
            return
        }

        this.settlePendingParse(message.requestId, message.codeData.errorInfo === undefined ? message.codeData : null)
    }

    private settlePendingParse (requestId: number, result: BackgroundParseResult): void {
        const pending = this.pendingParses.get(requestId)
        if (pending === undefined) {
            return
        }
        clearTimeout(pending.timer)
        this.pendingParses.delete(requestId)
        pending.resolve(result)
    }

    /**
     * Parses the document on the MATLAB thread.
     *
     * @param code The code being parsed
     * @param uri The URI associated with the code
     *
     * @returns The raw data extracted from the document
     */
    private async getCodeInfoSynchronously (code: string, uri: string): Promise<CodeInfo | null> {
        const filePath = FileNameUtils.getFilePathFromUri(uri)
        const analysisLimit = (await ConfigurationManager.getConfiguration()).maxFileSizeForAnalysis

        try {
            const response = await this.mvm.feval(
                'matlabls.handlers.indexing.parseInfoFromDocument',
                1,
                [code, filePath, analysisLimit]
            )

            if ('error' in response) {
                Logger.error('Error received while parsing file:')
                Logger.error(response.error.msg)
                return null
            }

            const codeInfo = parse(response.result[0]) as CodeInfo

            if (codeInfo.errorInfo === undefined) {
                return codeInfo
            } else {
                return null
            }
        } catch (err) {
            Logger.error('Error caught while parsing file:')
            Logger.error(err as string)
            return null
        }
    }
}
