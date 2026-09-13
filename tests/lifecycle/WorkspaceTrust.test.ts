// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import WorkspaceTrust from '../../src/lifecycle/WorkspaceTrust'

describe('WorkspaceTrust', () => {
    it('should trust a client that sends no initialization options', () => {
        const trust = new WorkspaceTrust()
        trust.initialize(undefined)

        assert.strictEqual(trust.isTrusted(), true, 'an editor with no notion of trust must keep MATLAB')
    })

    it('should trust a client whose options do not mention trust', () => {
        const trust = new WorkspaceTrust()
        trust.initialize({ someOtherOption: 1 })

        assert.strictEqual(trust.isTrusted(), true)
    })

    it('should be untrusted when the client says workspaceTrusted is false', () => {
        const trust = new WorkspaceTrust()
        trust.initialize({ workspaceTrusted: false })

        assert.strictEqual(trust.isTrusted(), false)
    })

    it('should be trusted when the client says workspaceTrusted is true', () => {
        const trust = new WorkspaceTrust()
        trust.initialize({ workspaceTrusted: false })
        trust.initialize({ workspaceTrusted: true })

        assert.strictEqual(trust.isTrusted(), true)
    })

    it('should read only a boolean false as untrusted', () => {
        const trust = new WorkspaceTrust()
        trust.initialize({ workspaceTrusted: 'false' })

        assert.strictEqual(trust.isTrusted(), true)
    })

    it('should become trusted, and report it once, when trust is granted', () => {
        const trust = new WorkspaceTrust()
        trust.initialize({ workspaceTrusted: false })
        const listener = sinon.spy()
        trust.onGranted(listener)

        trust.grant()
        trust.grant()

        assert.strictEqual(trust.isTrusted(), true)
        sinon.assert.calledOnce(listener)
    })

    it('should report no grant for a workspace that was already trusted', () => {
        const trust = new WorkspaceTrust()
        trust.initialize({ workspaceTrusted: true })
        const listener = sinon.spy()
        trust.onGranted(listener)

        trust.grant()

        sinon.assert.notCalled(listener)
    })
})
