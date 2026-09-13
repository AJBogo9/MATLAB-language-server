// Copyright 2026 Andreas Bogossian

import * as fs from 'fs/promises'
import * as path from 'path'
import { TextDocuments } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'
import { ArgumentDeclaration } from '../hover/ArgumentsBlockParser'
import HoverCache from '../hover/HoverCache'
import { buildOfflineSymbolInfo, OfflineSymbolInfo } from '../hover/OfflineHoverBuilder'
import { isSameFilePath } from '../../utils/FileNameUtils'

/**
 * Reads the arguments blocks of other files, for signature help, completion and hover on a call.
 *
 * The defining file comes from MATLAB where MATLAB knows it. The completion engine names it as
 * signatureSource, verified on R2026a: the .m path for user functions, package functions, methods
 * and constructors, a functionSignatures.json for MathWorks functions, and a getUsage(...)
 * expression for a declaration MATLAB cannot parse. Hover has which(). An open buffer for that path
 * is read rather than the saved file, so a comment being edited shows.
 */

export interface FileAccess {
    stat: (filePath: string) => Promise<{ mtimeMs: number, size: number }>
    readFile: (filePath: string) => Promise<string>
}

/** What which() told hover about a topic. */
export interface WhichAnswer {
    whichPath?: string
    docUrl?: string
    shadowedBy?: string
}

/** A function declared in another file. */
export interface ExternalDefinition {
    path: string
    info: OfflineSymbolInfo
}

interface CachedFile {
    stamp: string
    // The buffer the text came from. A file closed and reopened is a new document at version 1 again.
    document?: TextDocument
    text: string
    symbols: Map<string, OfflineSymbolInfo | null>
}

const NODE_FILES: FileAccess = {
    stat: async filePath => await fs.stat(filePath),
    readFile: async filePath => await fs.readFile(filePath, 'utf8')
}

class ArgumentDocSource {
    private readonly cache = new HoverCache<CachedFile>(64)

    constructor (private readonly files: FileAccess = NODE_FILES) {}

    /**
     * Describes a function or class declared in a file.
     *
     * @param filePath The absolute path of a .m file; anything else is not read
     * @param name The declared name
     * @param documents The open documents
     * @returns What the file declares under that name, or null
     */
    async symbolInFile (filePath: string, name: string, documents: TextDocuments<TextDocument>): Promise<OfflineSymbolInfo | null> {
        const file = await this.read(filePath, documents)
        return file != null ? symbolIn(file, name) : null
    }

    /**
     * Finds the argument declarations behind a signature from MATLAB's completion engine.
     *
     * @param signature The signature, with the file MATLAB read it from
     * @param documents The open documents
     * @returns The declarations, empty when there are none or the source is not a user file
     */
    async declarationsForSignature (
        signature: { functionName: string, signatureSource?: string }, documents: TextDocuments<TextDocument>
    ): Promise<ArgumentDeclaration[]> {
        const file = await this.read(signature.signatureSource ?? '', documents)
        if (file == null) {
            return []
        }
        // A method call reports g.spin and a package function pk.pkfn; the file declares the last part
        const name = signature.functionName.split('.').pop() ?? ''
        const info = symbolIn(file, name)
        // A constructor call names the class, and the class is declared before its constructor
        const described = info?.kind === 'classdef' ? symbolIn(file, name, info.declarationLine) : info
        return described?.argumentDeclarations ?? []
    }

    /**
     * Finds the function a hovered call reaches in another file.
     *
     * which() decides when it answers: two open files can share a name, and only MATLAB knows which
     * one a call reaches. A documented name is a MathWorks function unless a user file shadows it,
     * and then which() names that file first. which() also names a private function of a folder on
     * the path first when the call comes from another folder, which never reaches it, so a private
     * answer counts as none. Without an answer (MATLAB down, or the file neither on the path nor in
     * MATLAB's current folder) the caller's private folder and its own folder are tried, as MATLAB
     * resolves a call from a file in its current folder; that also finds a private function the
     * caller does reach. An open file elsewhere is not used: nothing offline says the call reaches
     * it. A class-qualified topic resolves only through which().
     *
     * @param topic The hovered topic, e.g. docdemo or pk.pkfn
     * @param which What which() said, or null without MATLAB
     * @param hoveredUri The document the call is in
     * @param documents The open documents
     * @returns The defining file and its declaration, or null
     */
    async findDefinition (
        topic: string, which: WhichAnswer | null, hoveredUri: string, documents: TextDocuments<TextDocument>
    ): Promise<ExternalDefinition | null> {
        const parts = topic.split('.')
        const name = parts[parts.length - 1]
        const folder = path.dirname(URI.parse(hoveredUri).fsPath)

        const whichPath = which?.whichPath ?? ''
        if (whichPath !== '' && path.basename(path.dirname(whichPath)) !== 'private') {
            const userFile = (which?.docUrl ?? '') === '' || which?.shadowedBy === whichPath
            return userFile ? await this.functionIn(whichPath, name, documents) : null
        }

        // A package function lives under its + folders
        const relative = path.join(...parts.slice(0, -1).map(part => '+' + part), name + '.m')
        for (const candidate of [path.join(folder, 'private', relative), path.join(folder, relative)]) {
            const found = await this.functionIn(candidate, name, documents)
            if (found != null) {
                return found
            }
        }
        return null
    }

    private async functionIn (filePath: string, name: string, documents: TextDocuments<TextDocument>): Promise<ExternalDefinition | null> {
        const info = await this.symbolInFile(filePath, name, documents)
        return info?.kind === 'function' ? { path: filePath, info } : null
    }

    private async read (filePath: string, documents: TextDocuments<TextDocument>): Promise<CachedFile | null> {
        if (!path.isAbsolute(filePath) || !filePath.endsWith('.m')) {
            return null
        }
        try {
            const document = documents.all().find(open => isSameFilePath(URI.parse(open.uri).fsPath, filePath))
            let stamp: string
            if (document !== undefined) {
                stamp = 'v' + String(document.version)
            } else {
                const stat = await this.files.stat(filePath)
                stamp = String(stat.mtimeMs) + ':' + String(stat.size)
            }

            const cached = this.cache.get(filePath)
            if (cached !== undefined && cached.stamp === stamp && cached.document === document) {
                return cached
            }

            const text = document !== undefined ? document.getText() : await this.files.readFile(filePath)
            const file: CachedFile = { stamp, document, text, symbols: new Map() }
            this.cache.set(filePath, file)
            return file
        } catch {
            return null
        }
    }
}

/**
 * Looks a name up in a file, once per version of the file.
 *
 * @param file The file
 * @param name The declared name
 * @param classLine For a constructor, the line of its class declaration
 * @returns The symbol, or null
 */
function symbolIn (file: CachedFile, name: string, classLine?: number): OfflineSymbolInfo | null {
    const key = classLine === undefined ? name : name + ' ' + String(classLine)
    if (!file.symbols.has(key)) {
        file.symbols.set(key, classLine === undefined ? buildOfflineSymbolInfo(file.text, name) : constructorOf(file.text, name, classLine))
    }
    return file.symbols.get(key) ?? null
}

/**
 * Finds a class's constructor. The declaration search stops at the class of the same name, so the
 * class line is blanked out first; line numbers stay as they are.
 */
function constructorOf (text: string, name: string, classLine: number): OfflineSymbolInfo | null {
    const lines = text.split(/\r?\n/)
    lines[classLine] = ''
    return buildOfflineSymbolInfo(lines.join('\n'), name)
}

export default ArgumentDocSource
