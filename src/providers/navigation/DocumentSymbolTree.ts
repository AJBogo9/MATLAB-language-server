// Copyright 2026 Andreas Bogossian

import { DocumentSymbol, Position, Range, SymbolKind } from 'vscode-languageserver'
import { areRangesEqual, rangeContains } from '../../utils/RangeUtils'

/** A document symbol before it is placed in the tree */
export interface SymbolEntry {
    name: string
    kind: SymbolKind
    range: Range
    selectionRange: Range
}

/**
 * Creates a symbol entry. Its selection range is the declared name when the name is on the
 * first line of the symbol, and the whole symbol otherwise.
 *
 * Picking a symbol in the outline, the breadcrumbs or Go to Symbol puts the cursor at the
 * start of its selection range, so the name is a better target than the `function` or
 * `classdef` keyword. Sticky scroll shows the line the selection range starts on, so a name
 * on a continuation line, as in "function [a, ...\n    b] = f(x)", would replace the first
 * line of the declaration there. VS Code rejects a selection range outside the range, and
 * then shows no outline at all.
 *
 * @param name The symbol name
 * @param kind The symbol kind
 * @param range The range of the whole symbol
 * @param nameRange The range of the declared name, if the symbol has one
 * @returns The symbol entry
 */
export function createSymbolEntry (name: string, kind: SymbolKind, range: Range, nameRange?: Range): SymbolEntry {
    if (nameRange !== undefined && nameRange.start.line === range.start.line && rangeContains(range, nameRange)) {
        return { name, kind, range, selectionRange: nameRange }
    }
    return { name, kind, range, selectionRange: range }
}

/**
 * Nests symbol entries by range: each symbol becomes a child of the smallest symbol whose
 * range contains its own. VS Code builds this same tree from a flat symbol list, so the
 * outline keeps the shape it has today. Symbols with equal ranges stay siblings.
 *
 * @param entries The symbols, in any order
 * @returns The top-level symbols, in document order
 */
export function nestSymbolEntries (entries: SymbolEntry[]): DocumentSymbol[] {
    // Earlier start first; for the same start, the larger symbol first, so it becomes the parent
    const sorted = [...entries].sort((a, b) => {
        const byStart = comparePositions(a.range.start, b.range.start)
        return byStart !== 0 ? byStart : comparePositions(b.range.end, a.range.end)
    })

    const roots: DocumentSymbol[] = []
    const open: DocumentSymbol[] = []
    for (const entry of sorted) {
        const node: DocumentSymbol = {
            name: entry.name,
            kind: entry.kind,
            range: entry.range,
            selectionRange: entry.selectionRange
        }

        while (open.length > 0 && !isStrictlyInside(node.range, open[open.length - 1].range)) {
            open.pop()
        }

        const parent = open[open.length - 1]
        if (parent === undefined) {
            roots.push(node)
        } else {
            parent.children = [...(parent.children ?? []), node]
        }
        open.push(node)
    }

    return roots
}

function isStrictlyInside (inner: Range, outer: Range): boolean {
    return rangeContains(outer, inner) && !areRangesEqual(outer, inner)
}

function comparePositions (a: Position, b: Position): number {
    return a.line !== b.line ? a.line - b.line : a.character - b.character
}
