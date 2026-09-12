// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import {
    buildOfflineSymbolInfo, extractDocComment, extractSignature, findDeclarationLine
} from '../../../src/providers/hover/OfflineHoverBuilder'

/**
 * Verified against MATLAB R2026a before this was written:
 *
 *   help('afterStyle')            94 chars   comment block AFTER the declaration
 *   help('beforeStyle')           91 chars   comment block BEFORE the declaration
 *   help('localHelper')            0 chars   local functions are invisible
 *   help('argsRich>localHelper')  77 chars   unless addressed through the file
 *   help('argsRich')              47 chars   H1 only, no argument detail at all
 *
 * So both comment placements are real, local functions genuinely need this
 * builder, and the arguments table can only come from here.
 */
describe('OfflineHoverBuilder', () => {
    const AFTER_STYLE = [
        'function y = afterStyle(x)',
        '%AFTERSTYLE Summary written after the declaration.',
        '%   Detailed explanation on a second line.',
        'y = x;',
        'end'
    ].join('\n')

    const BEFORE_STYLE = [
        '%BEFORESTYLE Summary written before the declaration.',
        '%   Second line of the leading block.',
        'function y = beforeStyle(x)',
        'y = x;',
        'end'
    ].join('\n')

    describe('#findDeclarationLine', () => {
        it('should find a function declaration with a single output', () => {
            assert.deepEqual(findDeclarationLine(AFTER_STYLE.split('\n'), 'afterStyle'), { line: 0, kind: 'function' })
        })

        it('should find a function with a bracketed output list', () => {
            const lines = ['function [a, b] = multi(x)', 'end'].join('\n').split('\n')
            assert.deepEqual(findDeclarationLine(lines, 'multi'), { line: 0, kind: 'function' })
        })

        it('should find a function with no outputs', () => {
            const lines = ['function noOut(x)', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'noOut'), { line: 0, kind: 'function' })
        })

        it('should find a classdef', () => {
            const lines = ['classdef MyClass < handle', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'MyClass'), { line: 0, kind: 'classdef' })
        })

        it('should find a classdef with attributes', () => {
            const lines = ['classdef (Abstract) Shape', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'Shape'), { line: 0, kind: 'classdef' })
        })

        it('should find a local function further down the file', () => {
            const lines = ['function main(x)', 'end', '', 'function z = localHelper(a)', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'localHelper'), { line: 3, kind: 'function' })
        })

        it('should return null for a symbol not declared here', () => {
            assert.equal(findDeclarationLine(AFTER_STYLE.split('\n'), 'notPresent'), null)
        })

        it('should not match a name that is merely a prefix', () => {
            const lines = ['function afterStyleExtra(x)', 'end']
            assert.equal(findDeclarationLine(lines, 'afterStyle'), null)
        })
    })

    describe('#extractDocComment', () => {
        it('should read the block after the declaration, which is MATLAB\'s convention', () => {
            const comment = extractDocComment(AFTER_STYLE.split('\n'), 0)
            assert.equal(comment.length, 2)
            assert.equal(comment[0], 'AFTERSTYLE Summary written after the declaration.')
        })

        it('should fall back to a block before the declaration', () => {
            const comment = extractDocComment(BEFORE_STYLE.split('\n'), 2)
            assert.equal(comment.length, 2)
            assert.equal(comment[0], 'BEFORESTYLE Summary written before the declaration.')
        })

        it('should stop at a blank line, as MATLAB does', () => {
            const lines = [
                'function f(x)',
                '%First line.',
                '',
                '% Not part of the help block.',
                'end'
            ]
            const comment = extractDocComment(lines, 0)
            assert.equal(comment.length, 1)
        })

        it('should return an empty array when there is no comment', () => {
            assert.deepEqual(extractDocComment(['function f(x)', 'y = 1;', 'end'], 0), [])
        })
    })

    describe('#extractSignature', () => {
        it('should drop the function keyword', () => {
            assert.equal(extractSignature(['function y = afterStyle(x)'], 0), 'y = afterStyle(x)')
        })

        it('should join line continuations', () => {
            const lines = ['function [a, b] = f(x, ...', '        y)']
            assert.equal(extractSignature(lines, 0), '[a, b] = f(x, y)')
        })

        it('should drop a trailing comment', () => {
            assert.equal(extractSignature(['function f(x) % does a thing'], 0), 'f(x)')
        })
    })

    describe('#buildOfflineSymbolInfo', () => {
        it('should strip the repeated name from the H1 summary', () => {
            const info = buildOfflineSymbolInfo(AFTER_STYLE, 'afterStyle')
            assert.ok(info != null)
            assert.equal(info.summary, 'Summary written after the declaration.',
                'the conventional ALL-CAPS name repeat should not appear twice in the card')
        })

        it('should separate the summary from the body', () => {
            const info = buildOfflineSymbolInfo(AFTER_STYLE, 'afterStyle')
            assert.equal(info?.body, '  Detailed explanation on a second line.')
        })

        it('should parse the arguments block, which no MATLAB API exposes', () => {
            const src = [
                'function [y, info] = argsRich(x, factor, opts)',
                '%ARGSRICH Demonstrates a full arguments block.',
                'arguments',
                '    x (:,1) double {mustBeFinite, mustBeReal}',
                '    factor (1,1) double = 2',
                '    opts.Method (1,1) string = "lin"',
                'end',
                'y = x * factor;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'argsRich')
            assert.equal(info?.argumentDeclarations.length, 3)
            assert.equal(info?.argumentDeclarations[0].name, 'x')
            assert.equal(info?.argumentDeclarations[2].name, 'opts.Method')
        })

        it('should describe a local function, which help() returns nothing for', () => {
            const src = [
                'function main(x)',
                '%MAIN Entry point.',
                'z = localHelper(x);',
                'end',
                '',
                'function z = localHelper(a)',
                '%LOCALHELPER Does the real work.',
                'z = a;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'localHelper')
            assert.ok(info != null, 'local functions are exactly the case MATLAB cannot serve')
            assert.equal(info.summary, 'Does the real work.')
            assert.equal(info.signature, 'z = localHelper(a)')
        })

        it('should not attribute a later function\'s arguments block to an earlier function', () => {
            const src = [
                'function first(x)',
                'y = 1;',
                'end',
                'function second(z)',
                'arguments',
                '    z single',
                'end',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'first')
            assert.deepEqual(info?.argumentDeclarations, [],
                'the scope scan must stop at the next function declaration')
        })

        it('should handle a classdef', () => {
            const src = [
                'classdef MyClass < handle',
                '%MYCLASS Summary line for the class.',
                '    properties',
                '        Count',
                '    end',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'MyClass')
            assert.equal(info?.kind, 'classdef')
            assert.equal(info?.summary, 'Summary line for the class.')
        })

        it('should return null for a symbol not in the document', () => {
            assert.equal(buildOfflineSymbolInfo(AFTER_STYLE, 'somethingElse'), null)
        })
    })
})
