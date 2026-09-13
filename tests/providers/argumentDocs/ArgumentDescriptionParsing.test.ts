// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import { ArgumentDeclaration, parseArgumentsBlocks } from '../../../src/providers/hover/ArgumentsBlockParser'
import { renderDescription } from '../../../src/providers/argumentDocs/ArgumentDescriptionMarkdown'

/**
 * The convention for documenting an argument, since no MATLAB API reads one: the comment on
 * the declaration line, the comment lines directly above it, or both. Verified on R2026a that
 * help() and getSignatures return nothing from an arguments block.
 */
describe('argument descriptions from arguments block comments', () => {
    const parse = (lines: string[]): ArgumentDeclaration[] => parseArgumentsBlocks(lines, 0, lines.length)
    const texts = (declaration: ArgumentDeclaration | undefined): string[] | undefined =>
        declaration?.description?.map(line => line.text)
    const named = (declarations: ArgumentDeclaration[], name: string): ArgumentDeclaration | undefined =>
        declarations.find(d => d.name === name)
    /** Wraps declaration lines in a function and a plain arguments block. */
    const block = (...body: string[]): string[] => ['function f(varargin)', 'arguments', ...body, 'end', 'end']

    const DOCDEMO = [
        'function y = docdemo(x, factor, opts)',
        '    %DOCDEMO Scale a signal.',
        '    %   Y = DOCDEMO(X, FACTOR) multiplies X by FACTOR.',
        '    arguments',
        '        x (:,1) double           % the input signal',
        '        % the scale factor, applied to every sample',
        '        factor (1,1) double = 2',
        '        opts.Method (1,1) string = "lin"   % interpolation method',
        '        opts.Tol (1,1) double = 1e-6',
        '    end',
        '    y = x * factor;',
        'end'
    ]

    it('should read the trailing comment on a declaration line', () => {
        const declarations = parse(DOCDEMO)
        assert.deepStrictEqual(texts(named(declarations, 'x')), ['the input signal'])
        assert.deepStrictEqual(texts(named(declarations, 'opts.Method')), ['interpolation method'])
        assert.strictEqual(named(declarations, 'opts.Tol')?.description, undefined,
            'an undocumented field has no description, not an empty one')
    })

    it('should read the comment lines directly above a declaration', () => {
        assert.deepStrictEqual(texts(named(parse(DOCDEMO), 'factor')), ['the scale factor, applied to every sample'])
    })

    it('should find the comment after a percent sign inside a default', () => {
        const declarations = parse(block(
            '    opts.Label (1,1) string = "100% done"   % shown under the bar',
            "    c char = '50%'  % percent",
            "    t double = [1 2]'   % transposed"
        ))
        assert.deepStrictEqual(texts(named(declarations, 'opts.Label')), ['shown under the bar'])
        assert.strictEqual(named(declarations, 'opts.Label')?.defaultValue, '"100% done"')
        assert.deepStrictEqual(texts(named(declarations, 'c')), ['percent'])
        assert.deepStrictEqual(texts(named(declarations, 't')), ['transposed'])
    })

    it('should not give a group heading to the first of several commented fields', () => {
        const declarations = parse(block(
            '    % Solver options',
            '    opts.Method string = "lin"  % interpolation method',
            '    opts.Tol double = 1  % tolerance'
        ))
        assert.deepStrictEqual(texts(named(declarations, 'opts.Method')), ['interpolation method'])
        assert.deepStrictEqual(texts(named(declarations, 'opts.Tol')), ['tolerance'])

        const continued = parse(block(
            '    % Solver options',
            '    opts.Method string {mustBeMember(opts.Method, ...  % interpolation method',
            '        ["lin", "cubic"])} = "lin"',
            '    opts.Tol double = 1  % tolerance'
        ))
        assert.deepStrictEqual(texts(named(continued, 'opts.Method')), ['interpolation method'],
            'the next declaration follows the last line of a continued one')
    })

    it('should keep an explanation above a declaration that also carries a unit', () => {
        const declarations = parse(block(
            '    % initial velocity, measured at launch',
            '    v0 (1,1) double  % m/s'
        ))
        assert.deepStrictEqual(texts(named(declarations, 'v0')), ['initial velocity, measured at launch', '', 'm/s'])
    })

    it('should combine the two when the next declaration has no comment of its own', () => {
        const declarations = parse(block(
            '    % Solver options',
            '    opts.Method string = "lin"  % interpolation method',
            '    opts.Tol double = 1'
        ))
        assert.deepStrictEqual(texts(named(declarations, 'opts.Method')), ['Solver options', '', 'interpolation method'])
    })

    it('should combine the two when a comment line separates the next declaration', () => {
        const declarations = parse(block(
            '    % initial velocity',
            '    v0 double  % m/s',
            '    % launch angle',
            '    theta double  % rad'
        ))
        assert.deepStrictEqual(texts(named(declarations, 'v0')), ['initial velocity', '', 'm/s'])
        assert.deepStrictEqual(texts(named(declarations, 'theta')), ['launch angle', '', 'rad'])
    })

    it('should keep an explanation above a declaration that directly follows another', () => {
        const declarations = parse(block(
            '    x (:,1) double       % samples',
            '    % Sampling frequency. Must match the recording device.',
            '    fs (1,1) double      % Hz',
            '    opts.Window double = 256  % window length'
        ))
        assert.deepStrictEqual(texts(named(declarations, 'fs')), ['Sampling frequency. Must match the recording device.', '', 'Hz'])
        assert.deepStrictEqual(texts(named(declarations, 'x')), ['samples'])
    })

    it('should take a comment set apart by a blank line or a section title as a heading', () => {
        for (const separator of ['', '    %% Solver']) {
            const declarations = parse(block(
                '    x (:,1) double  % samples',
                separator,
                '    % Solver options',
                '    opts.Method string = "lin"  % interpolation method',
                '    opts.Tol double = 1  % tolerance'
            ))
            assert.deepStrictEqual(texts(named(declarations, 'opts.Method')), ['interpolation method'], JSON.stringify(separator))
        }
    })

    it('should not take the spacing after a trailing comment marker for an example', () => {
        const v0 = named(parse(block('    % initial velocity, measured at launch', '    v0 (1,1) double  %  m/s')), 'v0')
        assert.deepStrictEqual(texts(v0), ['initial velocity, measured at launch', '', 'm/s'])
        assert.strictEqual(renderDescription(v0?.description ?? []), 'initial velocity, measured at launch\n\nm/s')
    })

    it('should not reach across a blank line', () => {
        assert.strictEqual(named(parse(block('    % orphan', '', '    x double')), 'x')?.description, undefined)
    })

    it('should not take a comment on the arguments line', () => {
        const lines = ['function f(x)', 'arguments % inputs', '    x double', 'end', 'end']
        assert.strictEqual(named(parse(lines), 'x')?.description, undefined)
    })

    it('should not take a commented-out declaration as a description', () => {
        for (const code of [
            '% y (1,1) double',
            '% y (1,:)',
            '% tol double',
            '% opts.Mode {mustBeText}',
            '% fig matlab.ui.Figure',
            '% d dictionary = dictionary()',
            '% label string = "a"',
            '% x (:,1) double   % the input signal',
            '% x double {mustBeFinite} % finite'
        ]) {
            const declarations = parse(block('    ' + code, '    x2 double'))
            assert.strictEqual(named(declarations, 'x2')?.description, undefined, code)
        }
    })

    it('should stop at a commented-out declaration', () => {
        const declarations = parse(block('    % the y value', '    % y (1,1) double', '    x double'))
        assert.strictEqual(named(declarations, 'x')?.description, undefined)
    })

    it('should keep descriptions that only resemble a declaration', () => {
        for (const prose of [
            'samples (N x 1)',
            'gain factor',
            'x = 5 is typical',
            'origin (0,0) of the axes',
            '1-based index into the samples',
            // Two words ending in a class name that is also a noun
            'pulse duration',
            'options struct',
            'lookup table',
            'label string',
            'start datetime',
            'the table',
            'delimiter char',
            'd dictionary',
            'unit gain = 1 by default'
        ]) {
            const declarations = parse(block('    % ' + prose, '    x double'))
            assert.deepStrictEqual(texts(named(declarations, 'x')), [prose])
        }
    })

    it('should not cut a description at a line that ends in a class name', () => {
        const declarations = parse(block('    % Options struct', '    % with fields Tol and MaxIter', '    opts struct'))
        assert.deepStrictEqual(texts(named(declarations, 'opts')), ['Options struct', 'with fields Tol and MaxIter'])
    })

    it('should keep the indentation of a description over several lines', () => {
        const x = named(parse(block('    % first line', '    %   more detail', '    x double')), 'x')
        assert.deepStrictEqual(texts(x), ['first line', '  more detail'])
        assert.deepStrictEqual(x?.description?.map(line => line.indent), [1, 3])
    })

    it('should drop blank comment lines at the edges of a description and spaces after its lines', () => {
        const x = named(parse(block('    %', '    % the x   ', '    %', '    x double')), 'x')
        assert.deepStrictEqual(texts(x), ['the x'])
    })

    it('should not take the trailing comment of the previous declaration', () => {
        const declarations = parse(block('    x double % first', '    y double'))
        assert.strictEqual(named(declarations, 'y')?.description, undefined)
    })

    it('should describe Output and Repeating arguments the same way', () => {
        const declarations = parse([
            'function varargout = f(a, b)',
            'arguments (Repeating)',
            '    % one pair',
            '    b double',
            'end',
            'arguments (Output)',
            '    varargout double % result',
            'end',
            'end'
        ])
        assert.deepStrictEqual(texts(named(declarations, 'b')), ['one pair'])
        assert.strictEqual(named(declarations, 'b')?.kind, 'repeating')
        assert.deepStrictEqual(texts(named(declarations, 'varargout')), ['result'])
        assert.strictEqual(named(declarations, 'varargout')?.kind, 'output')
    })

    it('should skip a block comment inside an arguments block, including an end in it', () => {
        const declarations = parse([
            'function f(x)',
            'arguments',
            '    %{',
            '    y (1,1) double',
            '    end',
            '    %}',
            '    x double % real',
            'end',
            'end'
        ])
        assert.deepStrictEqual(declarations.map(d => d.name), ['x'])
        assert.deepStrictEqual(texts(declarations[0]), ['real'])
    })

    it('should not take a block comment above a declaration', () => {
        const declarations = parse(block('    % heading', '    %{', '    note', '    %}', '    x double'))
        assert.strictEqual(named(declarations, 'x')?.description, undefined)
    })

    it('should not take a section title', () => {
        assert.strictEqual(named(parse(block('    %% Options', '    opts.A double')), 'opts.A')?.description, undefined)
        assert.deepStrictEqual(texts(named(parse(block('    %% Options', '    % the A field', '    opts.A double')), 'opts.A')),
            ['the A field'])
    })

    it('should fall back to the lines above when the trailing comment is blank', () => {
        assert.deepStrictEqual(texts(named(parse(block('    % the x', '    x double %')), 'x')), ['the x'])
    })

    it('should read a comment on every line of a continued declaration', () => {
        const x = named(parse(block(
            '    x (1,1) double {mustBeFinite, ... % must be finite',
            '        mustBeReal} = 3  % and real'
        )), 'x')
        assert.deepStrictEqual(texts(x), ['must be finite', 'and real'])
        assert.ok((x?.validators ?? '').includes('mustBeReal'), 'validators still parse across the continuation')
        assert.strictEqual(x?.defaultValue, '3')
    })

    it('should ignore Code Analyzer pragmas', () => {
        assert.strictEqual(named(parse(block('    x double %#ok<INUSA>')), 'x')?.description, undefined)
        assert.deepStrictEqual(texts(named(parse(block('    x double % the x %#ok<INUSA>')), 'x')), ['the x'])
        assert.strictEqual(named(parse(block('    % the x', '    %#ok<INUSA>', '    x double')), 'x')?.description, undefined,
            'a pragma line ends the run above')
    })
})
