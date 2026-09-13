// Copyright 2022 - 2026 The MathWorks, Inc.

import * as path from 'path'
import { URI } from 'vscode-uri'
import { WorkDoneProgressServerReporter, WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode-languageserver'
import ClientCapabilitiesManager from '../lifecycle/ClientCapabilitiesManager'
import ConfigurationManager from '../lifecycle/ConfigurationManager'
import Indexer from './Indexer'
import FileInfoIndex from './FileInfoIndex'
import ClientConnection from '../ClientConnection'
import Logger from '../logging/Logger'
import { BUILT_IN_INDEX_EXCLUDES, compileExcludes, ExcludeMatcher, mergeExcludeSettings } from './workspace/ExcludeGlobs'
import { findMatlabFiles } from './workspace/WorkspaceFileWalker'

const PROGRESS_TITLE = 'Indexing MATLAB files'

interface IndexingRun {
    // A folder removed from the workspace is taken out, whether or not the run has started
    folders: Array<{ uri: string, path: string }>
}

/**
 * The folder's path, ending in exactly one separator. The path of a folder URI that
 * ends in a slash, or of a drive root, already ends in one, and appending another
 * would match no file.
 */
function toFolderPath (folderUri: string): string {
    return path.join(URI.parse(folderUri).fsPath, path.sep)
}

function isInsideFolder (filePath: string, folderPath: string): boolean {
    return filePath.startsWith(folderPath)
}

/**
 * Handles indexing files in the user's workspace to gather data about classes,
 * functions, and variables.
 */
export default class WorkspaceIndexer {
    private isWorkspaceIndexingSupported = false

    // Runs under way or waiting their turn. Runs go one at a time.
    private readonly runs = new Set<IndexingRun>()
    private lastRun: Promise<void> = Promise.resolve()

    constructor (
        private readonly indexer: Indexer,
        private readonly fileInfoIndex: FileInfoIndex,
        private readonly isOpenDocument: (uri: string) => boolean
    ) {}

    /**
     * Sets up workspace change listeners, if supported.
     */
    setupCallbacks (): void {
        this.isWorkspaceIndexingSupported = ClientCapabilitiesManager.hasWorkspaceFolders()

        if (!this.isWorkspaceIndexingSupported) {
            // Workspace indexing not supported
            return
        }

        ClientConnection.getConnection().workspace.onDidChangeWorkspaceFolders((params: WorkspaceFoldersChangeEvent) => {
            this.handleWorkspaceFoldersRemoved(params.removed)
            void this.handleWorkspaceFoldersAdded(params.added)
        })
    }

    /**
     * Attempts to index the files in the user's workspace.
     */
    async indexWorkspace (): Promise<void> {
        if (!(await this.shouldIndexWorkspace())) {
            return
        }

        const folders = await ClientConnection.getConnection().workspace.getWorkspaceFolders()

        if (folders == null) {
            return
        }

        await this.queueRun(folders)
    }

    /**
     * Handles when new folders are added to the user's workspace by indexing them.
     *
     * @param folders The list of folders added to the workspace
     */
    private async handleWorkspaceFoldersAdded (folders: WorkspaceFolder[]): Promise<void> {
        if (!(await this.shouldIndexWorkspace())) {
            return
        }

        await this.queueRun(folders)
    }

    /**
     * Stops crawls from storing files of the removed folders, and drops those files
     * from the index.
     *
     * @param folders The list of folders removed from the workspace
     */
    private handleWorkspaceFoldersRemoved (folders: WorkspaceFolder[]): void {
        if (folders.length === 0) {
            return
        }

        const removedPaths = folders.map(folder => toFolderPath(folder.uri))
        for (const run of this.runs) {
            run.folders = run.folders.filter(folder => !removedPaths.includes(folder.path))
        }

        void this.dropFromIndex(removedPaths)
    }

    private async dropFromIndex (removedPaths: string[]): Promise<void> {
        try {
            // A removed folder can contain a folder that is still in the workspace
            const remainingFolders = await ClientConnection.getConnection().workspace.getWorkspaceFolders() ?? []
            const remainingPaths = remainingFolders.map(folder => toFolderPath(folder.uri))

            for (const uri of this.fileInfoIndex.codeInfoCache.keys()) {
                const filePath = URI.parse(uri).fsPath
                const isRemoved = removedPaths.some(folderPath => isInsideFolder(filePath, folderPath)) &&
                    !remainingPaths.some(folderPath => isInsideFolder(filePath, folderPath))

                // An open document keeps its entry, which parses of its buffer keep current
                if (isRemoved && !this.isOpenDocument(uri)) {
                    this.fileInfoIndex.codeInfoCache.delete(uri)
                }
            }
        } catch (err) {
            Logger.error(`Unable to drop removed workspace folders from the index: ${String(err)}`)
        }
    }

    private async queueRun (folders: WorkspaceFolder[]): Promise<void> {
        const run: IndexingRun = {
            folders: folders
                .filter(folder => URI.parse(folder.uri).scheme === 'file')
                .map(folder => ({ uri: folder.uri, path: toFolderPath(folder.uri) }))
        }
        this.runs.add(run)

        const previousRun = this.lastRun
        const thisRun = (async () => {
            await previousRun
            await this.run(run)
        })()
        this.lastRun = thisRun
        await thisRun
    }

    /**
     * Walks the run's folders and has MATLAB parse the files found, showing progress
     * while it does. Never rejects.
     */
    private async run (run: IndexingRun): Promise<void> {
        let progress: WorkDoneProgressServerReporter | undefined

        try {
            const filePaths = await this.findFiles(run)
            if (filePaths.length === 0) {
                return
            }

            const total = filePaths.length
            let filesDone = 0
            let reportedPercentage = 0

            const result = await this.indexer.indexFiles(filePaths, {
                onStart: async () => {
                    progress = await this.beginProgress(total)
                },
                onFileDone: () => {
                    filesDone++
                    const percentage = Math.floor(100 * filesDone / total)
                    // 100 waits until the crawl is known to have finished
                    if (percentage > reportedPercentage && filesDone < total) {
                        reportedPercentage = percentage
                        progress?.report(percentage, `${filesDone}/${total} files`)
                    }
                },
                shouldStore: uri => this.shouldStore(run, uri)
            })

            if (result === 'done') {
                progress?.report(100, `${total}/${total} files`)
            }
        } catch (err) {
            Logger.error(`Error while indexing the workspace: ${String(err)}`)
        } finally {
            progress?.done()
            this.runs.delete(run)
        }
    }

    private async findFiles (run: IndexingRun): Promise<string[]> {
        // Nested workspace folders share files, which are listed once
        const filePaths = new Set<string>()
        for (const folder of run.folders) {
            const isExcluded = await this.getExcludeMatcher(folder.uri)
            for (const filePath of await findMatlabFiles(folder.path, isExcluded)) {
                filePaths.add(filePath)
            }
        }
        return [...filePaths]
    }

    /**
     * Excludes the built-in folders plus whatever the folder's files.exclude and
     * search.exclude settings exclude, so the index leaves out what those settings
     * leave out of Quick Open. The two settings are merged first, as VS Code merges
     * them, so a false in search.exclude keeps what the same key in files.exclude
     * would leave out. The built-in folders stay apart from that merge, so no setting
     * brings them back.
     */
    private async getExcludeMatcher (folderUri: string): Promise<ExcludeMatcher> {
        let settingsExcludes: Record<string, unknown> = {}

        if (ClientCapabilitiesManager.hasWorkspaceConfiguration()) {
            try {
                const [filesExclude, searchExclude] = await ClientConnection.getConnection().workspace.getConfiguration([
                    { scopeUri: folderUri, section: 'files.exclude' },
                    { scopeUri: folderUri, section: 'search.exclude' }
                ])
                settingsExcludes = mergeExcludeSettings(filesExclude, searchExclude)
            } catch (err) {
                Logger.warn(`Unable to read files.exclude and search.exclude for ${folderUri}: ${String(err)}`)
            }
        }

        return compileExcludes([BUILT_IN_INDEX_EXCLUDES, settingsExcludes])
    }

    private shouldStore (run: IndexingRun, uri: string): boolean {
        // An open document is indexed from its buffer, which can differ from the file
        if (this.isOpenDocument(uri)) {
            return false
        }
        const filePath = URI.parse(uri).fsPath
        return run.folders.some(folder => isInsideFolder(filePath, folder.path))
    }

    private async beginProgress (total: number): Promise<WorkDoneProgressServerReporter | undefined> {
        try {
            // A client without window.workDoneProgress gets a reporter that sends nothing
            const progress = await ClientConnection.getConnection().window.createWorkDoneProgress()
            // Not cancellable: VS Code draws a server's progress in the status bar, with no cancel button
            progress.begin(PROGRESS_TITLE, 0, `0/${total} files`, false)
            return progress
        } catch (err) {
            Logger.warn(`Unable to show workspace indexing progress: ${String(err)}`)
            return undefined
        }
    }

    /**
     * Determines whether or not the workspace should be indexed.
     * The workspace should be indexed if the client supports workspaces, and if the
     * workspace indexing setting is true.
     *
     * @returns True if workspace indexing should occurr, false otherwise.
     */
    private async shouldIndexWorkspace (): Promise<boolean> {
        const shouldIndexWorkspace = (await ConfigurationManager.getConfiguration()).indexWorkspace
        return this.isWorkspaceIndexingSupported && shouldIndexWorkspace
    }
}
