// Copyright 2026 Andreas Bogossian

import { promises as fs } from 'fs'
import * as path from 'path'
import Logger from '../../logging/Logger'
import { ExcludeMatcher } from './ExcludeGlobs'

interface EntryType {
    isFile: () => boolean
    isDirectory: () => boolean
}

interface DirectoryEntry extends EntryType {
    name: string
    isSymbolicLink: () => boolean
}

/** The two file system calls the walk makes, replaceable in tests */
export interface WalkerFileSystem {
    readdir: (directoryPath: string) => Promise<DirectoryEntry[]>
    lstat: (entryPath: string) => Promise<EntryType>
}

const NODE_FILE_SYSTEM: WalkerFileSystem = {
    readdir: async directoryPath => await fs.readdir(directoryPath, { withFileTypes: true }),
    lstat: async entryPath => await fs.lstat(entryPath)
}

/**
 * Lists the .m files under a folder without following any symbolic link, to a folder
 * or to a file, so the walk cannot loop, list a file twice, or leave the folder.
 *
 * MATLAB's dir('**') follows every link: one link back to its parent listed each file
 * 40 times over, and two such links kept the MATLAB thread busy for over 90 s.
 *
 * @param folderPath The folder to walk
 * @param isExcluded Decides which folders to skip and which files to leave out
 * @param fileSystem The file system to read
 * @returns The absolute paths of the files, in no particular order
 */
export async function findMatlabFiles (folderPath: string, isExcluded: ExcludeMatcher, fileSystem: WalkerFileSystem = NODE_FILE_SYSTEM): Promise<string[]> {
    const filePaths: string[] = []
    await walk(folderPath, '', isExcluded, fileSystem, filePaths)
    return filePaths
}

async function walk (directoryPath: string, relativeDirectory: string, isExcluded: ExcludeMatcher, fileSystem: WalkerFileSystem, filePaths: string[]): Promise<void> {
    let entries: DirectoryEntry[]
    try {
        entries = await fileSystem.readdir(directoryPath)
    } catch (err) {
        Logger.warn(`Not indexing ${directoryPath}, which could not be read: ${String(err)}`)
        return
    }

    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name)
        const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`

        // lstat reports a symbolic link as neither a file nor a folder, so it is skipped.
        // Windows types every reparse point as a link, including cloud file placeholders,
        // which lstat reports as the files and folders they are.
        const type = entry.isSymbolicLink() ? await lstatOrNull(fileSystem, entryPath) : entry
        if (type === null) {
            continue
        }

        if (type.isDirectory()) {
            if (!isExcluded(relativePath, true)) {
                await walk(entryPath, relativePath, isExcluded, fileSystem, filePaths)
            }
        } else if (type.isFile() && entry.name.endsWith('.m') && !isExcluded(relativePath, false)) {
            filePaths.push(entryPath)
        }
    }
}

async function lstatOrNull (fileSystem: WalkerFileSystem, entryPath: string): Promise<EntryType | null> {
    try {
        return await fileSystem.lstat(entryPath)
    } catch {
        // Gone since the folder was read
        return null
    }
}
