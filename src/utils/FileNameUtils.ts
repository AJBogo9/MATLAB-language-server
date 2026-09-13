// Copyright 2025 The MathWorks, Inc.

import path from 'path';
import { URI } from 'vscode-uri';

/**
 * Checks if the given URI corresponds to a MATLAB M-file.
 *
 * @param uri The URI of the file to check
 * @returns True if the file is a MATLAB M-file (.m), false otherwise.
 */
export function isMFile (uri: string): boolean {
    const ext = path.extname(URI.parse(uri).fsPath)
    return ext === '.m'
}

/**
 * Gets the file path from the given URI, optionally coercing the extension to '.m'.
 *
 * @param uri The URI of the file
 * @param shouldCoerceToMExt If true, the function will ensure the returned file path has a
 * '.m' extension. If the file is a Jupyter Notebook ('.ipynb'), it will return 'untitled.m'
 * to ensure a valid MATLAB file name (to avoid invalid characters).
 * @returns The file path, optionally with the file extension replaced with '.m'.
 */
export function getFilePathFromUri (uri: string, shouldCoerceToMExt: boolean = false): string {
    const filePath = URI.parse(uri).fsPath

    const parsedPath = path.parse(filePath)

    if (!shouldCoerceToMExt || parsedPath.ext === '.m') {
        return filePath
    }

    if (parsedPath.ext === '') {
        // The file path has no extension
        return `${filePath}.m`
    }

    if (parsedPath.ext === '.ipynb') {
        // Use a default name for Jupyter Notebook files, to avoid code analysis
        // errors due to potential invalid characters in the file name.
        return 'untitled.m'
    }

    // For all other file types, replace the existing extension with '.m'
    return path.join(parsedPath.dir, `${parsedPath.name}.m`)
}

/**
 * Checks whether two file system paths name the same file, compared as the platform compares them.
 * On Windows the comparison ignores case and separators: VS Code spells the drive letter in lower
 * case where MATLAB spells it in upper case, and NTFS ignores the case of folder names too.
 *
 * @param first One path
 * @param second The other path
 * @param platform The platform whose rules apply, by default the one the server runs on
 * @returns True if both paths name the same file
 */
export function isSameFilePath (first: string, second: string, platform: NodeJS.Platform = process.platform): boolean {
    if (platform === 'win32') {
        return path.win32.normalize(first).toLowerCase() === path.win32.normalize(second).toLowerCase()
    }
    return path.posix.normalize(first) === path.posix.normalize(second)
}
