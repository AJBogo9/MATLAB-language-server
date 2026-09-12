// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import FileInfoIndex, { CodeInfo } from '../../../src/indexing/FileInfoIndex'
import WorkspaceSymbolProvider, {
    classNameFromClassFolder, matchesQuery
} from '../../../src/providers/navigation/WorkspaceSymbolProvider'
import { SymbolKind, WorkspaceSymbolParams } from 'vscode-languageserver'

/**
 * Driven by the same recorded computeCodeData fixtures the index tests use, so
 * this needs no MATLAB: the provider reads only what is already in
 * FileInfoIndex.codeInfoCache.
 */
describe('WorkspaceSymbolProvider', () => {
    const resourcePrefix = '../../indexing/rawCodeDataResourceFiles'
    const specPrefix = `${resourcePrefix}/improvedCodeAnalysisSpecCases`

    let G_1: CodeInfo
    let F_1: CodeInfo
    let F_2: CodeInfo
    let C_1: CodeInfo
    let MyClass: CodeInfo

    let fileInfoIndex: FileInfoIndex
    let provider: WorkspaceSymbolProvider

    before(() => {
        G_1 = require(`${specPrefix}/generalCases/G_1.json`)
        F_1 = require(`${specPrefix}/functionCases/F_1.json`)
        F_2 = require(`${specPrefix}/functionCases/F_2.json`)
        C_1 = require(`${specPrefix}/classCases/C_1.json`)
        MyClass = require(`${resourcePrefix}/@MyClass/MyClass.json`)
    })

    beforeEach(() => {
        fileInfoIndex = new FileInfoIndex()
        provider = new WorkspaceSymbolProvider(fileInfoIndex)
    })

    const query = (q: string): any[] =>
        provider.handleWorkspaceSymbolRequest({ query: q } as WorkspaceSymbolParams)

    describe('#handleWorkspaceSymbolRequest', () => {
        it('should return nothing when the index is empty', () => {
            // A cold window where MATLAB never started has no index, so Ctrl+T is
            // legitimately empty rather than broken.
            assert.deepEqual(query('anything'), [])
        })

        it('should find functions across every indexed file', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///F_1.m', F_1)
            fileInfoIndex.parseAndStoreCodeInfo('file:///F_2.m', F_2)

            const all = query('')
            const uris = new Set(all.map(s => s.location.uri))

            assert.ok(all.length > 0, 'expected symbols from the fixtures')
            assert.ok(uris.size >= 2, 'symbols should come from more than one file')
        })

        it('should report a location with a real range', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///F_1.m', F_1)

            const [first] = query('')
            assert.equal(first.location.uri, 'file:///F_1.m')
            assert.equal(typeof first.location.range.start.line, 'number')
            assert.equal(typeof first.location.range.end.line, 'number')
        })

        it('should classify a classdef as a Class', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///C_1.m', C_1)

            const classes = query('').filter(s => s.kind === SymbolKind.Class)
            assert.ok(classes.length >= 1, 'the classdef should appear as a Class symbol')
        })

        it('should attach a container name to class members', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///C_1.m', C_1)

            const members = query('').filter(s => s.kind === SymbolKind.Method || s.kind === SymbolKind.Property)
            if (members.length > 0) {
                assert.ok(members.some(m => typeof m.containerName === 'string' && m.containerName.length > 0),
                    'class members should say which class they belong to')
            }
        })

        it('should omit sections, which would flood the picker', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///G_1.m', G_1)

            const modules = query('').filter(s => s.kind === SymbolKind.Module)
            assert.equal(modules.length, 0,
                '%% headers repeat across hundreds of files and documentSymbol already covers them')
        })

        it('should cap what an empty query returns', () => {
            // VS Code sends query:"" the moment the picker opens.
            for (let i = 0; i < 400; i++) {
                fileInfoIndex.parseAndStoreCodeInfo(`file:///copy_${i}.m`, F_1)
            }
            assert.ok(query('').length <= 256, 'an empty query must not return the whole index')
        })

        it('should find a symbol by its exact name', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///F_1.m', F_1)
            const names = query('').map(s => s.name)
            assert.ok(names.length > 0)

            const target = names[0]
            const found = query(target).map(s => s.name)
            assert.ok(found.includes(target), `querying "${target}" should find it`)
        })

        it('should not match a query that is not a subsequence', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///F_1.m', F_1)
            assert.deepEqual(query('zzzzqqqqxxxx'), [])
        })

        it('should handle a class-folder file without a classdef of its own', () => {
            fileInfoIndex.parseAndStoreCodeInfo('file:///%40MyClass/MyClass.m', MyClass)
            assert.ok(query('').length > 0, 'a file in an @class folder should still contribute symbols')
        })
    })

    describe('#matchesQuery', () => {
        it('should match everything on an empty query', () => {
            assert.equal(matchesQuery('anything', ''), true)
        })

        it('should be case insensitive', () => {
            assert.equal(matchesQuery('MyClass', 'myclass'), true)
            assert.equal(matchesQuery('myclass', 'MYCLASS'), true)
        })

        it('should match a subsequence, not just a prefix', () => {
            // The editor applies its own scoring, so the server should be
            // permissive rather than strict.
            assert.equal(matchesQuery('computeCodeData', 'ccd'), true)
            assert.equal(matchesQuery('computeCodeData', 'data'), true)
        })

        it('should respect character order', () => {
            assert.equal(matchesQuery('abc', 'cba'), false)
        })

        it('should reject a character that is not present', () => {
            assert.equal(matchesQuery('plot', 'plotz'), false)
        })
    })

    describe('#classNameFromClassFolder', () => {
        it('should read the class name from a percent-encoded @ folder', () => {
            assert.equal(classNameFromClassFolder('file:///proj/%40MyClass/someMethod.m'), 'MyClass')
        })

        it('should read the class name from an unencoded @ folder', () => {
            assert.equal(classNameFromClassFolder('file:///proj/@Widget/render.m'), 'Widget')
        })

        it('should return undefined outside a class folder', () => {
            assert.equal(classNameFromClassFolder('file:///proj/plain.m'), undefined)
        })
    })
})
