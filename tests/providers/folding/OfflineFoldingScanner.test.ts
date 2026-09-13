// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver'

import { computeFoldingRanges } from '../../../src/providers/folding/OfflineFoldingScanner'
import { computeBlockCommentRanges } from '../../../src/providers/hover/CommentStringScanner'

interface FoldingCase {
    label: string
    code: string
    expected: Array<[number, number, FoldingRangeKind?]>
    matlab?: string
}

/**
 * Expected ranges are the ones MATLAB R2026a's getFoldingRanges returns for each case, 0-based
 * and without its one-line ranges, which VS Code ignores. A case with a `matlab` note records
 * where the two deliberately differ. The kinds are this module's own.
 */
const CASES: FoldingCase[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'foldingCases.json'), 'utf8'))

const toRanges = (expected: FoldingCase['expected']): FoldingRange[] =>
    expected.map(([start, end, kind]) => FoldingRange.create(start, end, undefined, undefined, kind))

describe('OfflineFoldingScanner', () => {
    for (const foldingCase of CASES) {
        it(foldingCase.label, () => {
            assert.deepStrictEqual(computeFoldingRanges(foldingCase.code), toRanges(foldingCase.expected))
        })
    }
})

describe('computeBlockCommentRanges', () => {
    const linesOf = (text: string): string[] => text.split('\n')

    it('counts a nested block comment as part of the outer one', () => {
        assert.deepStrictEqual(
            computeBlockCommentRanges(linesOf('%{\nouter\n%{\ninner\n%}\nstill outer\n%}\nx = 1;')),
            [{ start: 0, end: 6 }])
    })

    it('gives nothing for an unclosed block comment', () => {
        assert.deepStrictEqual(computeBlockCommentRanges(linesOf('x = 1;\n%{\nnot closed\nstill\ny = 2;')), [])
    })

    it('gives nothing for a stray closing delimiter', () => {
        assert.deepStrictEqual(computeBlockCommentRanges(linesOf('x\n%}\ny')), [])
    })
})

describe('OfflineFoldingScanner on broken files', () => {
    // Blocks left open below a function without end. The endless pass pops every frame above that
    // function at the next function and at the end of the file, so a stack scan per pop is quadratic.
    const ifs = (n: number): string[] => Array(n).fill('if x')
    const fastestMs = (lines: string[]): number => {
        const text = lines.join('\n')
        let best = Number.POSITIVE_INFINITY
        for (let i = 0; i < 3; i++) {
            const started = process.hrtime.bigint()
            computeFoldingRanges(text)
            best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6)
        }
        return best
    }
    // The control has the same lines with nothing below the function. Measured with 16000 lines:
    // about 1x the control when linear, 13x to 15x when quadratic.
    const assertLinear = (broken: string[], control: string[]): void => {
        const brokenMs = fastestMs(broken)
        const controlMs = fastestMs(control)
        assert.ok(brokenMs < Math.max(controlMs, 1) * 4,
            `scaling looks quadratic: ${brokenMs.toFixed(1)} ms against ${controlMs.toFixed(1)} ms for the control`)
    }

    before(() => fastestMs([...ifs(500), 'function f', ...ifs(500)]))

    it('stays linear when unclosed blocks come before a function without end', () => {
        assertLinear([...ifs(8000), 'function f', ...ifs(8000)], ['function f', ...ifs(16000)])
    })

    it('stays linear when another function without end follows them', () => {
        assertLinear([...ifs(8000), 'function f', ...ifs(8000), 'function g'], ['function f', ...ifs(16000), 'function g'])
    })
})
