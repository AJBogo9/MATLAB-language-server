// Copyright 2026 Andreas Bogossian

import { Range, SymbolInformation, SymbolKind, WorkspaceSymbolParams } from 'vscode-languageserver'
import FileInfoIndex, {
    FunctionContainer, MatlabClassdefInfo, MatlabClassInfo, MatlabCodeInfo,
    MatlabFunctionScopeInfo, MatlabGlobalScopeInfo
} from '../../indexing/FileInfoIndex'
import { URI } from 'vscode-uri'

/**
 * Provides workspace/symbol, which is Ctrl+T.
 *
 * MATLAB's one-function-per-file convention makes "where is that helper" the
 * most common navigation question in the language, and without this the only
 * answer is Ctrl+P against a filename you have to remember already.
 *
 * Nothing here talks to MATLAB. FileInfoIndex.codeInfoCache already maps every
 * indexed URI to a fully parsed MatlabCodeInfo, WorkspaceIndexer keeps it warm,
 * and every range is already in memory. The caveat is that the cache is only
 * populated after the MVM connects, so a cold window with MATLAB never started
 * returns nothing.
 */

/**
 * Caps what an empty query returns.
 *
 * VS Code issues `query: ""` as soon as the picker opens. Returning the entire
 * index there is both slow and useless, so the list is truncated; typing one
 * character immediately narrows it properly.
 */
const EMPTY_QUERY_LIMIT = 256

/** Overall cap, to keep a single request bounded on a large toolbox. */
const MAX_RESULTS = 2048

class WorkspaceSymbolProvider {
    constructor (private readonly fileInfoIndex: FileInfoIndex) {}

    /**
     * Handles a workspace/symbol request.
     *
     * @param params Parameters from the onWorkspaceSymbol request
     * @returns Matching symbols across every indexed file
     */
    handleWorkspaceSymbolRequest (params: WorkspaceSymbolParams): SymbolInformation[] {
        const query = params.query ?? ''
        const limit = query === '' ? EMPTY_QUERY_LIMIT : MAX_RESULTS
        const results: SymbolInformation[] = []

        for (const codeInfo of this.fileInfoIndex.codeInfoCache.values()) {
            if (results.length >= limit) {
                break
            }
            this.collectFromFile(codeInfo, query, results, limit)
        }

        return results
    }

    private collectFromFile (
        codeInfo: MatlabCodeInfo, query: string, results: SymbolInformation[], limit: number
    ): void {
        const uri = codeInfo.uri

        const push = (name: string, kind: SymbolKind, range: Range, containerName?: string): void => {
            if (results.length >= limit) {
                return
            }
            if (!matchesQuery(name, query)) {
                return
            }
            const symbol = SymbolInformation.create(name, kind, range, uri)
            if (containerName != null && containerName !== '') {
                symbol.containerName = containerName
            }
            results.push(symbol)
        }

        const classdef: MatlabClassdefInfo | undefined = codeInfo.globalScopeInfo.classScope?.classdefInfo
        const className = classdef?.declarationNameId.name ?? classNameFromClassFolder(uri)

        if (classdef != null) {
            push(classdef.declarationNameId.name, SymbolKind.Class, classdef.range, codeInfo.package)

            const classInfo = classdef.classInfo
            classInfo.properties.forEach(prop => push(prop.name, SymbolKind.Property, prop.range, className))
            classInfo.enumerations.forEach(member => push(member.name, SymbolKind.EnumMember, member.range, className))
        }

        for (const functionScope of getAllFunctionScopes(codeInfo)) {
            push(
                functionScope.declarationNameId.name,
                functionScope.functionInfo.isMethod ? SymbolKind.Method : SymbolKind.Function,
                functionScope.range,
                functionScope.functionInfo.isMethod ? className : codeInfo.package
            )
        }

        // Sections are deliberately omitted. Emitting every %% header
        // workspace-wide floods Ctrl+T with "Setup", "Plot" and "Cleanup"
        // repeated across hundreds of files, and documentSymbol already covers
        // them within a file.
    }
}

/**
 * Case-insensitive subsequence match.
 *
 * vscode.d.ts is explicit that the query "should be interpreted in a relaxed
 * way as the editor will apply its own highlighting and scoring on the results"
 * and that servers should not apply prefix, substring or similar strict
 * matching. So this is deliberately permissive, and the client does the ranking.
 *
 * @param name The symbol name
 * @param query The user's query
 * @returns True when every query character appears in order in the name
 */
export function matchesQuery (name: string, query: string): boolean {
    if (query === '') {
        return true
    }

    const haystack = name.toLowerCase()
    const needle = query.toLowerCase()

    let position = 0
    for (const char of needle) {
        position = haystack.indexOf(char, position)
        if (position === -1) {
            return false
        }
        position++
    }

    return true
}

/**
 * Recovers a class name for a method file living in an @class folder.
 *
 * Such a file has no classdef of its own, so globalScopeInfo.classScope
 * .classdefInfo is undefined and MatlabClassInfo carries no name field. The
 * folder name is the only source. %40 is the percent-encoded @.
 *
 * @param uri The file URI
 * @returns The class name, or undefined when the file is not in a class folder
 */
export function classNameFromClassFolder (uri: string): string | undefined {
    const match = /%40([a-zA-Z]\w*)/.exec(uri)
    if (match != null) {
        return match[1]
    }

    // A URI may also arrive unencoded depending on how it was constructed.
    const decoded = URI.parse(uri).fsPath
    const rawMatch = /@([a-zA-Z]\w*)/.exec(decoded)
    return rawMatch != null ? rawMatch[1] : undefined
}

function getAllFunctionScopes (codeInfo: MatlabCodeInfo): MatlabFunctionScopeInfo[] {
    const scopes: MatlabFunctionScopeInfo[] = []
    accumulate(codeInfo.globalScopeInfo, scopes)
    return scopes
}

function accumulate (scope: FunctionContainer, scopes: MatlabFunctionScopeInfo[]): void {
    if (scope instanceof MatlabGlobalScopeInfo && scope.classScope != null) {
        accumulate(scope.classScope, scopes)
    }

    for (const functionInfo of scope.functionScopes.values()) {
        const functionScopeInfo = functionInfo.functionScopeInfo
        if (functionScopeInfo != null && (!(scope instanceof MatlabClassInfo) ||
            functionScopeInfo.parentScope instanceof MatlabClassdefInfo)) {
            scopes.push(functionScopeInfo)
            accumulate(functionScopeInfo, scopes)
        }
    }
}

export default WorkspaceSymbolProvider
