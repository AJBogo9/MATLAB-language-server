// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import { parseArgumentsBlocks } from '../../../src/providers/hover/ArgumentsBlockParser'
import { renderArgumentDescriptions, renderDescription } from '../../../src/providers/argumentDocs/ArgumentDescriptionMarkdown'

/**
 * The exact layout lives only here, so a different choice after the owner sees it rewrites one
 * file. The hover tests assert only where the descriptions sit.
 */
describe('ArgumentDescriptionMarkdown', () => {
    const describeBlock = (...body: string[]): string => {
        const lines = ['function f(varargin)', 'arguments', ...body, 'end', 'end']
        return renderArgumentDescriptions(parseArgumentsBlocks(lines, 0, lines.length))
    }

    it('should give each described argument a paragraph, in source order', () => {
        assert.strictEqual(describeBlock(
            '    x (:,1) double           % the input signal',
            '    % the scale factor, applied to every sample',
            '    factor (1,1) double = 2',
            '    opts.Method (1,1) string = "lin"   % interpolation method',
            '    opts.Tol (1,1) double = 1e-6'
        ), '`x`  ·  the input signal\n\n' +
            '`factor`  ·  the scale factor, applied to every sample\n\n' +
            '`opts.Method`  ·  interpolation method')
    })

    it('should render nothing when no argument is described', () => {
        assert.strictEqual(describeBlock('    x double', '    y double'), '')
    })

    it('should escape markdown in a one-line description', () => {
        assert.strictEqual(describeBlock('    k double  % scales by *k* [m]'), '`k`  ·  scales by \\*k\\* \\[m\\]')
    })

    it('should not start a one-line description with the spaces it was indented by', () => {
        // Four spaces at the start of a signature help documentation would open a code block
        assert.strictEqual(renderDescription([{ text: '    value', preformatted: false, indent: 5 }]), 'value')
    })

    it('should never fence a one-line description that reads like a list', () => {
        assert.strictEqual(describeBlock('    x double  % x - the input  column'), '`x`  ·  x - the input  column')
    })

    it('should keep an example in a description over several lines preformatted', () => {
        assert.strictEqual(describeBlock('    % the factor. Example:', '    %     factor = 3', '    factor double'),
            '`factor`  ·  the factor. Example:\n\n```text\nfactor = 3\n```')
    })

    it('should put the name on its own line above a description that opens with a fence', () => {
        assert.strictEqual(describeBlock('    % - one', '    % - two', '    x double'), '`x`\n\n```text\n- one\n- two\n```')
    })

    it('should render an explanation and a unit as two paragraphs', () => {
        assert.strictEqual(describeBlock('    % initial velocity, measured at launch', '    v0 (1,1) double  % m/s'),
            '`v0`  ·  initial velocity, measured at launch\n\nm/s')
    })
})
