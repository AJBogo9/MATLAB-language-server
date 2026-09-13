// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import {
    classifyLine, getTokenContext, isInCommentOrString, isInsideBlockComment, TokenContext
} from '../../../src/providers/hover/CommentStringScanner'

/**
 * The cases that matter here are the ones where MATLAB differs from every other
 * language the editor knows about: `'` is both transpose and a string delimiter,
 * and `%` is a comment rather than a modulo operator.
 */
describe('CommentStringScanner', () => {
    const contextAt = (line: string, character: number): TokenContext =>
        classifyLine(line)[character]

    describe('#classifyLine transpose vs char array', () => {
        it('should treat a quote after a closing paren as transpose, not a string', () => {
            const line = "y = A(1)' * plot"
            //            0123456789
            assert.equal(contextAt(line, 8), TokenContext.Code, "A(1)' is a transpose")
            // `plot` after a transpose must still be code, or hover would be
            // suppressed on every line that transposes something.
            assert.equal(contextAt(line, line.indexOf('plot')), TokenContext.Code)
        })

        it('should treat a quote after a closing bracket as transpose', () => {
            const line = "v = [1 2 3]' + fft(x)"
            assert.equal(contextAt(line, 11), TokenContext.Code)
            assert.equal(contextAt(line, line.indexOf('fft')), TokenContext.Code)
        })

        it('should treat a quote after a struct field as transpose', () => {
            const line = "z = s.field' - zeros(2)"
            assert.equal(contextAt(line, 11), TokenContext.Code)
            assert.equal(contextAt(line, line.indexOf('zeros')), TokenContext.Code)
        })

        it('should treat a quote after an identifier as transpose', () => {
            const line = "b = a' + 1"
            assert.equal(contextAt(line, 5), TokenContext.Code)
        })

        it('should treat a quote separated by whitespace as a char array, not transpose', () => {
            // MATLAB binds transpose tight: `A '` is an unterminated char array
            // error, not a transpose, so whitespace before a quote always opens
            // a string. Skipping whitespace here defeated the whole module on
            // switch/case over char options and on message building.
            const cases: Array<[string, string]> = [
                ["case 'plot'", 'plot'],
                ["otherwise 'plot'", 'plot'],
                ["disp 'plot this'", 'plot'],
                ["xlabel 'plot'", 'plot'],
                ["f = @(k) 'plot'", 'plot'],
                ["msg = [num2str(x) ' plot']", 'plot'],
                ["c = {'Name' 'plot'}", "' 'plot"],
                ["s = ['x' 'plot']", "' 'plot"]
            ]

            for (const [line, needle] of cases) {
                const index = line.indexOf(needle) + (needle.startsWith("'") ? 3 : 0)
                assert.equal(contextAt(line, index), TokenContext.String,
                    `"${line}" should classify the quoted text as a string`)
            }
        })

        it('should restore code classification after a whitespace-preceded string closes', () => {
            const line = "case 'plot', doStuff(x)"
            assert.equal(contextAt(line, line.indexOf('doStuff')), TokenContext.Code,
                'code after the string must not be swallowed')
        })

        it('should treat a quote after = as opening a char array', () => {
            const line = "name = 'plot'"
            assert.equal(contextAt(line, line.indexOf('plot')), TokenContext.String,
                'the word plot inside a char array must not produce a hover')
        })

        it('should treat a quote after an open paren as opening a char array', () => {
            const line = "disp('zeros')"
            assert.equal(contextAt(line, line.indexOf('zeros')), TokenContext.String)
        })

        it('should handle a doubled quote escape inside a char array', () => {
            const line = "s = 'a''b' + fft(1)"
            assert.equal(contextAt(line, 5), TokenContext.String)
            // After the char array closes, code resumes.
            assert.equal(contextAt(line, line.indexOf('fft')), TokenContext.Code)
        })

        it('should handle double-quoted strings', () => {
            const line = 'm = "plot" + 1'
            assert.equal(contextAt(line, line.indexOf('plot')), TokenContext.String)
        })

        it('should treat a chained transpose as code', () => {
            const line = "q = A''"
            assert.equal(contextAt(line, 5), TokenContext.Code)
            assert.equal(contextAt(line, 6), TokenContext.Code)
        })
    })

    describe('#classifyLine comments', () => {
        it('should classify everything after % as a comment', () => {
            const line = 'x = 1; % remember to plot this'
            assert.equal(contextAt(line, line.indexOf('plot')), TokenContext.Comment,
                'the word plot inside a comment must not produce a hover')
        })

        it('should not treat a percent inside a char array as a comment', () => {
            const line = "label = '100% done'; y = fft(x)"
            assert.equal(contextAt(line, line.indexOf('done')), TokenContext.String)
            assert.equal(contextAt(line, line.indexOf('fft')), TokenContext.Code,
                'a percent inside a string must not comment out the rest of the line')
        })

        it('should treat a line continuation as ending the code', () => {
            const line = 'y = foo(1, ... trailing plot note'
            assert.equal(contextAt(line, line.indexOf('plot')), TokenContext.Comment)
            assert.equal(contextAt(line, line.indexOf('foo')), TokenContext.Code)
        })
    })

    describe('#isInsideBlockComment', () => {
        const lines = [
            'x = 1;',
            '%{',
            'this is commented plot text',
            '%}',
            'y = plot(x);'
        ]

        it('should report the open delimiter line as comment', () => {
            assert.equal(isInsideBlockComment(lines, 1), true)
        })

        it('should report a line inside the block as comment', () => {
            assert.equal(isInsideBlockComment(lines, 2), true)
        })

        it('should report the close delimiter line as comment', () => {
            assert.equal(isInsideBlockComment(lines, 3), true)
        })

        it('should report a line after the block as code', () => {
            assert.equal(isInsideBlockComment(lines, 4), false)
        })

        it('should report a line before the block as code', () => {
            assert.equal(isInsideBlockComment(lines, 0), false)
        })
    })

    describe('#getTokenContext and #isInCommentOrString', () => {
        it('should suppress hover inside a block comment', () => {
            const lines = ['%{', 'plot', '%}']
            assert.equal(isInCommentOrString(lines, 1, 0), true)
        })

        it('should allow hover on ordinary code', () => {
            const lines = ['y = plot(x);']
            assert.equal(isInCommentOrString(lines, 0, 4), false)
        })

        it('should return Code for an out-of-range line rather than throwing', () => {
            assert.equal(getTokenContext(['x = 1;'], 99, 0), TokenContext.Code)
        })

        it('should return Code past the end of a line rather than throwing', () => {
            assert.equal(getTokenContext(['x = 1;'], 0, 999), TokenContext.Code)
        })

        it('should return Code for a negative character offset', () => {
            assert.equal(getTokenContext(['x = 1;'], 0, -1), TokenContext.Code)
        })
    })
})
