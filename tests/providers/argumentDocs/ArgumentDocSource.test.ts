// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import ArgumentDocSource, { FileAccess } from '../../../src/providers/argumentDocs/ArgumentDocSource'

import { TextDocument } from 'vscode-languageserver-textdocument'
import { TextDocuments } from 'vscode-languageserver'

describe('ArgumentDocSource', () => {
    const DOCDEMO = [
        'function y = docdemo(x, factor, opts)',
        '    arguments',
        '        x (:,1) double           % the input signal',
        '        opts.Method (1,1) string = "lin"   % interpolation method',
        '    end',
        'end'
    ].join('\n')
    const GADGET2 = [
        'classdef Gadget2',
        '    methods',
        '        function obj = Gadget2(n, opts)',
        '            arguments',
        '                n double              % count',
        '                opts.Mode string = "a" % mode',
        '            end',
        '        end',
        '    end',
        'end'
    ].join('\n')

    let disk: Map<string, { text: string, mtimeMs: number }>
    let files: { stat: sinon.SinonStub, readFile: sinon.SinonStub }
    let open: TextDocument[]
    let documents: TextDocuments<TextDocument>

    beforeEach(() => {
        disk = new Map([['/work/docdemo.m', { text: DOCDEMO, mtimeMs: 1 }], ['/work/Gadget2.m', { text: GADGET2, mtimeMs: 1 }]])
        const lookup = (filePath: string): { text: string, mtimeMs: number } => {
            const file = disk.get(filePath)
            if (file === undefined) {
                throw Object.assign(new Error('ENOENT: ' + filePath), { code: 'ENOENT' })
            }
            return file
        }
        files = {
            stat: sinon.stub().callsFake(async (filePath: string) => ({ mtimeMs: lookup(filePath).mtimeMs, size: lookup(filePath).text.length })),
            readFile: sinon.stub().callsFake(async (filePath: string) => lookup(filePath).text)
        }
        open = []
        documents = new TextDocuments(TextDocument)
        sinon.stub(documents, 'all').callsFake(() => open)
    })
    afterEach(() => sinon.restore())

    const newSource = (): ArgumentDocSource => new ArgumentDocSource(files as FileAccess)
    const methodDescription = async (source: ArgumentDocSource): Promise<string | undefined> => {
        const info = await source.symbolInFile('/work/docdemo.m', 'docdemo', documents)
        return info?.argumentDeclarations.find(d => d.name === 'opts.Method')?.description?.[0].text
    }

    it('should read the declarations of a file on disk', async () => {
        assert.strictEqual(await methodDescription(newSource()), 'interpolation method')
    })

    it('should read an open buffer for the path rather than the saved file', async () => {
        open = [TextDocument.create('file:///work/docdemo.m', 'matlab', 3, DOCDEMO.replace('interpolation method', 'EDITED'))]

        assert.strictEqual(await methodDescription(newSource()), 'EDITED')
        assert.strictEqual(files.readFile.called, false)
    })

    it('should read a file again only when its time or size changes', async () => {
        const source = newSource()
        await methodDescription(source)
        await methodDescription(source)
        assert.strictEqual(files.readFile.callCount, 1)

        disk.set('/work/docdemo.m', { text: DOCDEMO, mtimeMs: 2 })
        await methodDescription(source)
        assert.strictEqual(files.readFile.callCount, 2, 'a new modification time')

        disk.set('/work/docdemo.m', { text: DOCDEMO.replace('interpolation method', 'method, longer'), mtimeMs: 2 })
        assert.strictEqual(await methodDescription(source), 'method, longer')
        assert.strictEqual(files.readFile.callCount, 3, 'a new size')
    })

    it('should parse a buffer once per version', async () => {
        const source = newSource()
        const document = TextDocument.create('file:///work/docdemo.m', 'matlab', 1, DOCDEMO)
        open = [document]

        const first = await source.symbolInFile('/work/docdemo.m', 'docdemo', documents)
        assert.strictEqual(await source.symbolInFile('/work/docdemo.m', 'docdemo', documents), first)

        TextDocument.update(document, [{ text: DOCDEMO.replace('interpolation method', 'EDITED') }], 2)
        assert.strictEqual(await methodDescription(source), 'EDITED')
    })

    it('should not serve a closed buffer to the same file reopened at the same version', async () => {
        const source = newSource()
        open = [TextDocument.create('file:///work/docdemo.m', 'matlab', 1, DOCDEMO)]
        await methodDescription(source)

        // Changed on disk while closed, then reopened: VS Code starts again at version 1
        open = [TextDocument.create('file:///work/docdemo.m', 'matlab', 1, DOCDEMO.replace('interpolation method', 'REOPENED'))]
        assert.strictEqual(await methodDescription(source), 'REOPENED')
    })

    it('should not read what is not a MATLAB file by absolute path', async () => {
        for (const reported of [
            'resources/functionSignatures.json',
            '/usr/local/MATLAB/R2026a/toolbox/matlab/graphics/graphics/resources/functionSignatures.json',
            "matlab.lang.internal.introspective.getUsage('dupnv')",
            'docdemo.m'
        ]) {
            assert.strictEqual(await newSource().symbolInFile(reported, 'docdemo', documents), null, reported)
        }
        assert.strictEqual(files.stat.called, false)
        assert.strictEqual(files.readFile.called, false)
    })

    it('should return null for a file that cannot be read', async () => {
        assert.strictEqual(await newSource().symbolInFile('/work/missing.m', 'missing', documents), null)
    })

    it('should return null for a name the file does not declare', async () => {
        assert.strictEqual(await newSource().symbolInFile('/work/docdemo.m', 'other', documents), null)
    })

    it('should find a constructor for a call that names its class', async () => {
        const source = newSource()
        const declarations = await source.declarationsForSignature({ functionName: 'Gadget2', signatureSource: '/work/Gadget2.m' }, documents)

        assert.deepStrictEqual(declarations.map(d => [d.name, d.description?.[0].text]), [['n', 'count'], ['opts.Mode', 'mode']])
        assert.strictEqual((await source.symbolInFile('/work/Gadget2.m', 'Gadget2', documents))?.kind, 'classdef',
            'a lookup by name still finds the class')
    })
})
