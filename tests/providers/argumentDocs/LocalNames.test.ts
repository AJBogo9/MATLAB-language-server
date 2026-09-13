// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import { isLocalName } from '../../../src/providers/argumentDocs/LocalNames'

describe('LocalNames', () => {
    const local = (line: string, name: string): boolean => isLocalName(['x0 = 1;', line], name)

    it('should see an assignment target', () => {
        assert.strictEqual(local('model = fitlm(X, y);', 'model'), true)
        assert.strictEqual(local('model = fitlm(X, y);', 'fitlm'), false, 'the right-hand side is not assigned')
        assert.strictEqual(local('y = x;', 'x'), false)
    })

    it('should see every target of a multiple assignment', () => {
        assert.strictEqual(local('[a, model] = f();', 'model'), true)
        assert.strictEqual(local('[a, model] = f();', 'a'), true)
        assert.strictEqual(local('[a, model] = f();', 'f'), false)
    })

    it('should see an assignment after another statement on the line', () => {
        assert.strictEqual(local('a = 1; model = 2', 'model'), true)
        assert.strictEqual(local('a = 1, model = 2', 'model'), true)
        assert.strictEqual(local('y = model; z = 2', 'model'), false, 'the right-hand side of an earlier statement')
    })

    it('should see a loop variable', () => {
        assert.strictEqual(local('for model = 1:3', 'model'), true)
    })

    it('should see the parameters and outputs of a declared function', () => {
        assert.strictEqual(local('function y = docdemo(x, factor, opts)', 'factor'), true)
        assert.strictEqual(local('function [a, model] = f(x)', 'model'), true)
    })

    it('should see the parameters of an anonymous function', () => {
        assert.strictEqual(local('g = @(model) model + 1;', 'model'), true)
        assert.strictEqual(local('g = @(x, model) x;', 'model'), true)
        assert.strictEqual(local('g = @() model + 1;', 'model'), false, 'a name the body uses is not a parameter')
    })

    it('should see global and persistent variables and the identifier of a catch', () => {
        assert.strictEqual(local('global model', 'model'), true)
        assert.strictEqual(local('persistent cache model', 'model'), true)
        assert.strictEqual(local('catch model', 'model'), true)
        assert.strictEqual(local('x = 1; global model', 'model'), true)
        assert.strictEqual(local('global cache; disp(model)', 'model'), false, 'the declaration ends with its statement')
        assert.strictEqual(local('globals(model)', 'model'), false, 'a call to a function named like the keyword')
    })

    it('should not take a comparison for an assignment', () => {
        for (const comparison of ['if model == x, end', 'if model ~= x, end', 'if model <= x, end', 'if model >= x, end']) {
            assert.strictEqual(local(comparison, 'model'), false, comparison)
        }
    })

    it('should not take a name-value argument for an assignment', () => {
        assert.strictEqual(local('plot(x, LineWidth=2)', 'LineWidth'), false)
    })

    it('should not take a field for the variable', () => {
        assert.strictEqual(local('s.model = 1;', 'model'), false)
        assert.strictEqual(local('s.model = 1;', 's'), true)
    })

    it('should match whole names only', () => {
        assert.strictEqual(local('models = 1;', 'model'), false)
        assert.strictEqual(local('mymodel = 1;', 'model'), false)
    })

    it('should ignore comments and strings', () => {
        assert.strictEqual(local('% model = 3', 'model'), false)
        assert.strictEqual(local("label = 'model = 3';", 'model'), false)
    })
})
