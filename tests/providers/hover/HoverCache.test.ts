// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import HoverCache from '../../../src/providers/hover/HoverCache'

describe('HoverCache', () => {
    it('should store and retrieve by key', () => {
        const cache = new HoverCache<string>(4)
        cache.set('a', 'alpha')
        assert.equal(cache.get('a'), 'alpha')
    })

    it('should return undefined for a missing key', () => {
        assert.equal(new HoverCache<string>(4).get('nope'), undefined)
    })

    it('should evict the least recently used entry past the cap', () => {
        const cache = new HoverCache<string>(2)
        cache.set('a', 'alpha')
        cache.set('b', 'beta')
        cache.set('c', 'gamma')

        assert.equal(cache.has('a'), false, 'a was least recently used and should be evicted')
        assert.equal(cache.get('b'), 'beta')
        assert.equal(cache.get('c'), 'gamma')
        assert.equal(cache.size, 2)
    })

    it('should treat a read as a use, protecting the entry from eviction', () => {
        const cache = new HoverCache<string>(2)
        cache.set('a', 'alpha')
        cache.set('b', 'beta')
        cache.get('a')       // a is now the most recently used
        cache.set('c', 'gamma')

        assert.equal(cache.has('a'), true, 'a was read and should have survived')
        assert.equal(cache.has('b'), false)
    })

    it('should not grow when overwriting an existing key', () => {
        const cache = new HoverCache<string>(2)
        cache.set('a', 'alpha')
        cache.set('a', 'alpha2')
        assert.equal(cache.size, 1)
        assert.equal(cache.get('a'), 'alpha2')
    })

    it('should clear every entry', () => {
        const cache = new HoverCache<string>(4)
        cache.set('a', 'alpha')
        cache.clear()
        assert.equal(cache.size, 0)
    })

    it('should key on release so a reconnect to a different MATLAB misses', () => {
        const a = HoverCache.keyFor('plot', 'R2025b')
        const b = HoverCache.keyFor('plot', 'R2026a')
        assert.notEqual(a, b, 'help text and doc URLs differ between releases')
    })

    it('should invalidate only matching keys', () => {
        const cache = new HoverCache<string>(8)
        cache.set(HoverCache.keyFor('myFunc', 'R2026a'), 'one')
        cache.set(HoverCache.keyFor('plot', 'R2026a'), 'two')
        cache.invalidateMatching('myFunc')

        assert.equal(cache.has(HoverCache.keyFor('myFunc', 'R2026a')), false)
        assert.equal(cache.has(HoverCache.keyFor('plot', 'R2026a')), true)
    })
})
