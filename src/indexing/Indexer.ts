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

interface WorkspaceFileIndexedResponse {
    isDone: boolean
    filePath: string
    codeData: CodeInfo
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
    private readonly INDEX_FOLDERS_RESPONSE_CHANNEL = '/matlabls/indexFolders/response'
    private readonly PARSE_DOCUMENT_RESPONSE_CHANNEL = '/matlabls/parseDocument/response'

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
        const matlabConnection = await this.matlabLifecycleManager.getMatlabConnection()

        if (matlabConnection == null || !this.mvm.isReady()) {
            return
        }

        const channelId = matlabConnection.getChannelId()
        const responseChannel = `${this.INDEX_FOLDERS_RESPONSE_CHANNEL}/${channelId}`

        const analysisLimit = (await ConfigurationManager.getConfiguration()).maxFileSizeForAnalysis

        const responseSub = matlabConnection.subscribe(responseChannel, message => {
            const fileResults = message as WorkspaceFileIndexedResponse

            if (fileResults.isDone) {
                // No more files being indexed - safe to unsubscribe
                matlabConnection.unsubscribe(responseSub)
            }

            if (fileResults.codeData.errorInfo === undefined) {
                // Convert file path to URI, which is used as an index when storing the code data
                const fileUri = URI.file(fileResults.filePath).toString()
                this.fileInfoIndex.parseAndStoreCodeInfo(fileUri, fileResults.codeData)
            }
        })

        try {
            const mdaFolders = {
                mwtype: 'string',
                mwsize: [1, folders.length],
                mwdata: folders
            }

            const response = await this.mvm.feval(
                'matlabls.handlers.indexing.parseInfoFromFolder',
                0,
                [mdaFolders, analysisLimit, responseChannel]
            )

            if ('error' in response) {
                Logger.error('Error received while indexing folders:')
                Logger.error(response.error.msg)
                Logger.warn('Not all files may have been indexed successfully.')
                matlabConnection.unsubscribe(responseSub)
            }
        } catch (err) {
            Logger.error('Error caught while indexing folders:')
            Logger.error(err as string)
            Logger.warn('Not all files may have been indexed successfully.')
        }
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
