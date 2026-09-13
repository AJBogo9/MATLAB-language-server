// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import sinon from 'sinon'

import { ClientCapabilities, DocumentSymbol, Range, SymbolInformation, SymbolKind, TextDocuments } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'

import ClientConnection from '../../../src/ClientConnection'
import DocumentIndexer from '../../../src/indexing/DocumentIndexer'
import FileInfoIndex, { CodeInfo } from '../../../src/indexing/FileInfoIndex'
import Indexer from '../../../src/indexing/Indexer'
import { RequestType } from '../../../src/indexing/SymbolSearchService'
import ClientCapabilitiesManager from '../../../src/lifecycle/ClientCapabilitiesManager'
import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import NavigationSupportProvider from '../../../src/providers/navigation/NavigationSupportProvider'
import PathResolver from '../../../src/providers/navigation/PathResolver'
import getMockConnection from '../../mocks/Connection.mock'
import getMockMvm from '../../mocks/Mvm.mock'

const RESOURCES = path.join(__dirname, '..', '..', 'indexing', 'rawCodeDataResourceFiles')
const MY_CLASS_URI = 'file:///%40MyClass/MyClass.m'

interface Node { name: string, kind: SymbolKind, range: number[], selectionRange: number[], children: Node[] }

const numbers = (range: Range): number[] => [range.start.line, range.start.character, range.end.line, range.end.character]

const project = (symbols: DocumentSymbol[] | undefined): Node[] => (symbols ?? []).map(symbol => ({
    name: symbol.name,
    kind: symbol.kind,
    range: numbers(symbol.range),
    selectionRange: numbers(symbol.selectionRange),
    children: project(symbol.children)
}))

const node = (name: string, kind: SymbolKind, range: number[], selectionRange = range, children: Node[] = []): Node =>
    ({ name, kind, range, selectionRange, children })

const readFixture = (relativePath: string): CodeInfo =>
    JSON.parse(fs.readFileSync(path.join(RESOURCES, relativePath), 'utf8'))

describe('NavigationSupportProvider document symbols', () => {
    let connection: ReturnType<typeof getMockConnection>
    let fileInfoIndex: FileInfoIndex
    let provider: NavigationSupportProvider
    let documents: TextDocuments<TextDocument>

    const useClient = (hierarchical: boolean | undefined): void => {
        ClientCapabilitiesManager.initialize(hierarchical === undefined
            ? {}
            : { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: hierarchical } } })
    }

    const symbols = async (uri: string): Promise<SymbolInformation[] | DocumentSymbol[]> =>
        await provider.handleDocumentSymbol(uri, documents, RequestType.DocumentSymbol)

    beforeEach(() => {
        connection = getMockConnection()
        ClientConnection._setConnection(connection)

        const lifecycle = new MatlabLifecycleManager()
        sinon.stub(lifecycle, 'isMatlabConnected').returns(true)
        sinon.stub(lifecycle, 'getMatlabConnection').resolves({} as any)

        const mvm = getMockMvm()
        fileInfoIndex = new FileInfoIndex()
        const indexer = new Indexer(lifecycle, mvm, fileInfoIndex)
        const documentIndexer = new DocumentIndexer(indexer, fileInfoIndex)
        sinon.stub(documentIndexer, 'ensureDocumentIndexIsUpdated').resolves()

        documents = new TextDocuments(TextDocument)
        sinon.stub(documents, 'get').callsFake((uri: string) => TextDocument.create(uri, 'matlab', 1, ''))

        provider = new NavigationSupportProvider(lifecycle, fileInfoIndex, indexer, documentIndexer, new PathResolver(mvm))
    })

    afterEach(() => {
        sinon.restore()
        ClientConnection._clearConnection()
        ClientCapabilitiesManager.initialize(null as unknown as ClientCapabilities)
    })

    it('gives a client that accepts a tree the class tree, selecting each declared name', async () => {
        useClient(true)
        fileInfoIndex.parseAndStoreCodeInfo(MY_CLASS_URI, readFixture('@MyClass/MyClass.json'))

        const result = await symbols(MY_CLASS_URI)

        assert.ok(DocumentSymbol.is(result[0]), 'expected DocumentSymbol items')
        assert.deepStrictEqual(project(result as DocumentSymbol[]), [
            node('MyClass', SymbolKind.Class, [0, 0, 26, 3], [0, 9, 0, 16], [
                node('properties', SymbolKind.Property, [1, 4, 3, 7], undefined, [
                    node('Prop', SymbolKind.Property, [2, 8, 2, 12])
                ]),
                node('properties (Constant)', SymbolKind.Property, [5, 4, 7, 7], undefined, [
                    node('ConstantProperty', SymbolKind.Property, [6, 8, 6, 24])
                ]),
                node('enumeration', SymbolKind.EnumMember, [9, 4, 11, 7], undefined, [
                    node('A', SymbolKind.EnumMember, [10, 8, 10, 9]),
                    node('B', SymbolKind.EnumMember, [10, 11, 10, 12])
                ]),
                node('enumeration', SymbolKind.EnumMember, [13, 4, 15, 7], undefined, [
                    node('C', SymbolKind.EnumMember, [14, 8, 14, 9]),
                    node('D', SymbolKind.EnumMember, [14, 11, 14, 12])
                ]),
                node('methods', SymbolKind.Method, [17, 4, 21, 7], undefined, [
                    node('myMethod', SymbolKind.Method, [18, 8, 20, 11], [18, 17, 18, 25])
                ]),
                node('methods (Static)', SymbolKind.Method, [23, 4, 25, 7])
            ])
        ])
    })

    it('nests nested functions under their parent and keeps local functions at the top', async () => {
        useClient(true)
        fileInfoIndex.parseAndStoreCodeInfo('file:///F_3.m', readFixture('improvedCodeAnalysisSpecCases/functionCases/F_3.json'))
        fileInfoIndex.parseAndStoreCodeInfo('file:///C_3.m', readFixture('improvedCodeAnalysisSpecCases/classCases/C_3.json'))

        const names = (items: DocumentSymbol[] | undefined): string[] => (items ?? []).map(item => item.name)
        const f3 = await symbols('file:///F_3.m') as DocumentSymbol[]
        const c3 = await symbols('file:///C_3.m') as DocumentSymbol[]

        assert.deepStrictEqual(names(f3), ['f1', 'f2'])
        assert.deepStrictEqual(names(f3[1].children), ['f3'])
        assert.deepStrictEqual(names(f3[0].children), [])
        assert.deepStrictEqual(names(c3), ['C_3', 'local'])
    })

    // Guard: this passed before the tree existed. It pins today's flat output for other clients.
    for (const [label, hierarchical] of [['does not declare tree support', undefined], ['declines tree support', false]] as const) {
        it(`keeps the flat list unchanged for a client that ${label}`, async () => {
            useClient(hierarchical)
            fileInfoIndex.parseAndStoreCodeInfo(MY_CLASS_URI, readFixture('@MyClass/MyClass.json'))

            const flat = (name: string, kind: SymbolKind, r: number[]): SymbolInformation =>
                SymbolInformation.create(name, kind, Range.create(r[0], r[1], r[2], r[3]), MY_CLASS_URI)

            assert.deepStrictEqual(await symbols(MY_CLASS_URI), [
                flat('MyClass', SymbolKind.Class, [0, 0, 26, 3]),
                flat('A', SymbolKind.EnumMember, [10, 8, 10, 9]),
                flat('B', SymbolKind.EnumMember, [10, 11, 10, 12]),
                flat('C', SymbolKind.EnumMember, [14, 8, 14, 9]),
                flat('D', SymbolKind.EnumMember, [14, 11, 14, 12]),
                flat('Prop', SymbolKind.Property, [2, 8, 2, 12]),
                flat('ConstantProperty', SymbolKind.Property, [6, 8, 6, 24]),
                flat('methods', SymbolKind.Method, [17, 4, 21, 7]),
                flat('methods (Static)', SymbolKind.Method, [23, 4, 25, 7]),
                flat('enumeration', SymbolKind.EnumMember, [9, 4, 11, 7]),
                flat('enumeration', SymbolKind.EnumMember, [13, 4, 15, 7]),
                flat('properties', SymbolKind.Property, [1, 4, 3, 7]),
                flat('properties (Constant)', SymbolKind.Property, [5, 4, 7, 7]),
                flat('myMethod', SymbolKind.Method, [18, 8, 20, 11])
            ])
        })
    }

    // Guard: Run Section after an edit relies on this notification (SectionModel).
    it('still pushes section ranges when it returns a tree', async () => {
        useClient(true)
        fileInfoIndex.parseAndStoreCodeInfo(MY_CLASS_URI, readFixture('@MyClass/MyClass.json'))

        await symbols(MY_CLASS_URI)

        sinon.assert.calledWith(connection.sendNotification as sinon.SinonStub, 'matlab/sections', sinon.match({ uri: MY_CLASS_URI }))
    })

    it('gives the same symbols as a tree and as a list, with selections inside ranges, for every recorded file', async () => {
        const fixtures: string[] = []
        const collect = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    collect(full)
                } else if (entry.name.endsWith('.json')) {
                    fixtures.push(path.relative(RESOURCES, full))
                }
            }
        }
        collect(RESOURCES)
        assert.ok(fixtures.length > 30, `expected the recorded fixtures, found ${fixtures.length}`)

        const key = (name: string, kind: SymbolKind, range: Range): string => `${name}|${kind}|${numbers(range).join(',')}`
        const problems: string[] = []
        for (const fixture of fixtures) {
            fileInfoIndex = new FileInfoIndex()
            ;(provider as any).fileInfoIndex = fileInfoIndex
            const uri = URI.file('/' + fixture.replace(/\.json$/, '.m')).toString()
            fileInfoIndex.parseAndStoreCodeInfo(uri, readFixture(fixture))

            useClient(false)
            const listed = (await symbols(uri) as SymbolInformation[]).map(s => key(s.name, s.kind, s.location.range)).sort()

            useClient(true)
            const treeKeys: string[] = []
            const walk = (items: DocumentSymbol[] | undefined): void => {
                for (const item of items ?? []) {
                    treeKeys.push(key(item.name, item.kind, item.range))
                    const [sl, sc, el, ec] = numbers(item.range)
                    const [ssl, ssc, sel, sec] = numbers(item.selectionRange)
                    const inside = (ssl > sl || (ssl === sl && ssc >= sc)) && (sel < el || (sel === el && sec <= ec))
                    if (!inside) {
                        problems.push(`${fixture}: selection of ${item.name} is outside its range`)
                    }
                    walk(item.children)
                }
            }
            walk(await symbols(uri) as DocumentSymbol[])

            if (JSON.stringify(treeKeys.sort()) !== JSON.stringify(listed)) {
                problems.push(`${fixture}: tree has ${treeKeys.length} symbols, list has ${listed.length}`)
            }
        }
        assert.deepStrictEqual(problems, [])
    })
})
