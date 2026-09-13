// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import { DocumentSymbol, Range, SymbolKind } from 'vscode-languageserver'

import { SymbolEntry, createSymbolEntry, nestSymbolEntries } from '../../../src/providers/navigation/DocumentSymbolTree'

interface Shape { name: string, children: Shape[] }

const shape = (symbols: DocumentSymbol[] | undefined): Shape[] =>
    (symbols ?? []).map(symbol => ({ name: symbol.name, children: shape(symbol.children) }))

const range = (startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range =>
    Range.create(startLine, startCharacter, endLine, endCharacter)

const leaf = (name: string): Shape => ({ name, children: [] })

/**
 * Ranges are the ones R2026a's parser reports for the sources quoted above each set, in
 * the order NavigationSupportProvider collects them: functions first, then sections.
 */
describe('DocumentSymbolTree', () => {
    // 0  %% Setup
    // 1  a = 1;
    // 2  %% Section 1
    // 3  b = 2;
    // 4  %% Plot results
    // 5  plot(a, b);
    // 6  %% Helpers
    // 7  function f
    // 8      %% inside f
    // 9      disp(1)
    // 10 end
    // 11 function g
    // 12     disp(2)
    // 13 end
    const scriptSections = (): SymbolEntry[] => [
        createSymbolEntry('f', SymbolKind.Function, range(7, 0, 10, 3), range(7, 9, 7, 10)),
        createSymbolEntry('g', SymbolKind.Function, range(11, 0, 13, 3), range(11, 9, 11, 10)),
        createSymbolEntry('Setup', SymbolKind.Module, range(0, 0, 1, 6)),
        createSymbolEntry('Section 1', SymbolKind.Module, range(2, 0, 3, 6)),
        createSymbolEntry('Plot results', SymbolKind.Module, range(4, 0, 5, 11)),
        createSymbolEntry('Helpers', SymbolKind.Module, range(6, 0, 14, 3)),
        createSymbolEntry('inside f', SymbolKind.Module, range(8, 0, 9, 11))
    ]

    // 0  classdef CSec
    // 1      methods
    // 2          %% inside methods
    // 3          function obj = CSec
    // 4          end
    // 5      end
    // 6  end
    const sectionInMethods = (): SymbolEntry[] => [
        createSymbolEntry('CSec', SymbolKind.Class, range(0, 0, 6, 3), range(0, 9, 0, 13)),
        createSymbolEntry('methods', SymbolKind.Method, range(1, 4, 5, 7)),
        createSymbolEntry('CSec', SymbolKind.Method, range(3, 8, 4, 11), range(3, 23, 3, 27)),
        createSymbolEntry('inside methods', SymbolKind.Module, range(2, 0, 4, 11))
    ]

    const expectedScriptTree = [
        leaf('Setup'),
        leaf('Section 1'),
        leaf('Plot results'),
        { name: 'Helpers', children: [{ name: 'f', children: [leaf('inside f')] }, leaf('g')] }
    ]

    it('nests sections and functions by the ranges that contain them', () => {
        assert.deepStrictEqual(shape(nestSymbolEntries(scriptSections())), expectedScriptTree)
    })

    it('nests by position in the document, not by the order symbols were collected', () => {
        assert.deepStrictEqual(shape(nestSymbolEntries(scriptSections().reverse())), expectedScriptTree)
    })

    it('keeps symbols with equal ranges as siblings', () => {
        const entries = [
            createSymbolEntry('first', SymbolKind.Module, range(3, 0, 6, 3)),
            createSymbolEntry('second', SymbolKind.Function, range(3, 0, 6, 3))
        ]
        assert.deepStrictEqual(shape(nestSymbolEntries(entries)), [leaf('first'), leaf('second')])
    })

    it('puts a method under a section that ends where the method ends, as the outline does today', () => {
        assert.deepStrictEqual(shape(nestSymbolEntries(sectionInMethods())), [
            { name: 'CSec', children: [{ name: 'methods', children: [{ name: 'inside methods', children: [leaf('CSec')] }] }] }
        ])
    })

    it('selects the name only when it is on the first line of the symbol and inside it', () => {
        // Name on the declaration line
        assert.deepStrictEqual(
            createSymbolEntry('f', SymbolKind.Function, range(7, 0, 10, 3), range(7, 9, 7, 10)).selectionRange,
            range(7, 9, 7, 10))

        // 0 function [a, ...
        // 1     b] = multiDecl(x)
        // 6 function ...
        // 7    helper2()
        assert.deepStrictEqual(
            createSymbolEntry('multiDecl', SymbolKind.Function, range(0, 0, 4, 3), range(1, 9, 1, 18)).selectionRange,
            range(0, 0, 4, 3))
        assert.deepStrictEqual(
            createSymbolEntry('helper2', SymbolKind.Function, range(6, 0, 8, 3), range(7, 3, 7, 10)).selectionRange,
            range(6, 0, 8, 3))

        // A name range that starts before the symbol would make VS Code drop the outline
        assert.deepStrictEqual(
            createSymbolEntry('x', SymbolKind.Function, range(5, 4, 9, 3), range(5, 0, 5, 3)).selectionRange,
            range(5, 4, 9, 3))
    })

    it('keeps every selection range inside its range at every depth', () => {
        const violations: string[] = []
        const walk = (symbols: DocumentSymbol[] | undefined): void => {
            for (const symbol of symbols ?? []) {
                const { range: outer, selectionRange: inner } = symbol
                const startsInside = inner.start.line > outer.start.line ||
                    (inner.start.line === outer.start.line && inner.start.character >= outer.start.character)
                const endsInside = inner.end.line < outer.end.line ||
                    (inner.end.line === outer.end.line && inner.end.character <= outer.end.character)
                if (!startsInside || !endsInside) {
                    violations.push(symbol.name)
                }
                walk(symbol.children)
            }
        }

        walk(nestSymbolEntries(scriptSections()))
        walk(nestSymbolEntries(sectionInMethods()))
        assert.deepStrictEqual(violations, [])
    })
})
