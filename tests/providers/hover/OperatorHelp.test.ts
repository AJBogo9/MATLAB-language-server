// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import { findOperatorAtPosition, getAllTopics, getOperatorHelp } from '../../../src/providers/hover/OperatorHelp'

/**
 * The bundled table is what makes hover work with no index and no MATLAB, which
 * matters because the measured cold start is ~5.2 s during which every
 * MATLAB-backed feature returns nothing.
 */
describe('OperatorHelp', () => {
    describe('#getOperatorHelp', () => {
        it('should have help for the common keywords', () => {
            for (const keyword of ['for', 'while', 'if', 'function', 'classdef', 'parfor', 'end']) {
                const entry = getOperatorHelp(keyword)
                assert.ok(entry != null, `expected bundled help for keyword "${keyword}"`)
                assert.ok(entry.text.length > 0, `expected non-empty help for "${keyword}"`)
            }
        })

        it('should have help for the common operators', () => {
            for (const op of ['.*', './', '\\', '==', '~=', '&&', '||', ':', '@']) {
                const entry = getOperatorHelp(op)
                assert.ok(entry != null, `expected bundled help for operator "${op}"`)
                assert.ok(entry.text.length > 0, `expected non-empty help for "${op}"`)
            }
        })

        it('should include the context-sensitive block keywords', () => {
            // iskeyword() omits these, yet they are among the most common things
            // a MATLAB author hovers. The end-to-end LSP smoke test caught their
            // absence: hovering `arguments` returned null.
            for (const keyword of ['arguments', 'properties', 'methods', 'events', 'enumeration']) {
                const entry = getOperatorHelp(keyword)
                assert.ok(entry != null, `expected bundled help for block keyword "${keyword}"`)
                assert.equal(entry.isKeyword, true, `"${keyword}" should be treated as a keyword`)
            }
        })

        it('should mark keywords and operators differently', () => {
            assert.equal(getOperatorHelp('parfor')?.isKeyword, true)
            assert.equal(getOperatorHelp('.*')?.isKeyword, false)
        })

        it('should strip MATLAB\'s own help banner', () => {
            const entry = getOperatorHelp('end')
            assert.ok(entry != null)
            assert.ok(!entry.text.includes('--- help for'),
                'the "--- help for MATLAB keyword X ---" banner is noise in a tooltip')
        })

        it('should not contain openExample calls, which are dead links in a tooltip', () => {
            for (const topic of getAllTopics()) {
                const entry = getOperatorHelp(topic)
                assert.ok(entry != null)
                assert.ok(!entry.text.includes('openExample('), `openExample leaked into "${topic}"`)
            }
        })

        it('should return null for an unknown topic', () => {
            assert.equal(getOperatorHelp('definitelyNotAnOperator'), null)
        })

        it('should bundle a useful number of topics', () => {
            assert.ok(getAllTopics().length >= 40, 'expected at least 40 bundled keyword/operator topics')
        })
    })

    describe('#findOperatorAtPosition', () => {
        it('should prefer the longest operator at the position', () => {
            const line = 'y = a .* b'
            //            0123456789
            const match = findOperatorAtPosition(line, 7)
            assert.equal(match?.topic, '.*', 'the cursor on * inside .* must resolve to .*, not *')
        })

        it('should find a single-character operator', () => {
            const line = 'y = a * b'
            const match = findOperatorAtPosition(line, 6)
            assert.equal(match?.topic, '*')
        })

        it('should report the operator range', () => {
            const line = 'y = a .^ b'
            const match = findOperatorAtPosition(line, 6)
            assert.equal(match?.topic, '.^')
            assert.equal(match?.start, 6)
            assert.equal(match?.end, 8)
        })

        it('should match when the cursor is on the first character of a two-character operator', () => {
            const line = 'if a ~= b'
            const match = findOperatorAtPosition(line, 5)
            assert.equal(match?.topic, '~=')
        })

        it('should return null on a plain identifier character', () => {
            const line = 'result = 1'
            assert.equal(findOperatorAtPosition(line, 2), null)
        })
    })
})
