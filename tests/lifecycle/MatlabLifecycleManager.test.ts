// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import { EventEmitter } from 'events'
import sinon from 'sinon'

import ConfigurationManager, { ConnectionTiming } from '../../src/lifecycle/ConfigurationManager'
import MatlabLifecycleManager from '../../src/lifecycle/MatlabLifecycleManager'
import WorkspaceTrust from '../../src/lifecycle/WorkspaceTrust'

function fakeSession (): any {
    return {
        eventEmitter: new EventEmitter(),
        getConnection: () => ({ name: 'fake connection' }),
        getMatlabRelease: () => 'R2026a',
        shutdown: sinon.stub()
    }
}

/**
 * MATLAB starts in the first workspace folder with every folder on its path, so it runs
 * that folder's startup.m and any file there that shadows a function it calls. Every
 * launch and attach goes through connectToMatlab, which must refuse both until the
 * workspace is trusted.
 */
describe('MatlabLifecycleManager and workspace trust', () => {
    let launch: sinon.SinonStub
    let attach: sinon.SinonStub
    let matlabUrl: string
    let untrusted: WorkspaceTrust

    beforeEach(() => {
        // The module functions behind these cannot be stubbed under tsx, so the methods that call them are
        launch = sinon.stub(MatlabLifecycleManager.prototype as any, 'connectToLocalMatlab').callsFake(async () => fakeSession())
        attach = sinon.stub(MatlabLifecycleManager.prototype as any, 'connectToRemoteMatlab').callsFake(async () => fakeSession())
        sinon.stub(ConfigurationManager, 'getConfiguration').resolves({ matlabConnectionTiming: ConnectionTiming.OnStart } as any)
        matlabUrl = ''
        sinon.stub(ConfigurationManager, 'getArgument').callsFake(() => matlabUrl)

        untrusted = new WorkspaceTrust()
        untrusted.initialize({ workspaceTrusted: false })
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should refuse to launch MATLAB in an untrusted workspace', async () => {
        const manager = new MatlabLifecycleManager(untrusted)

        await assert.rejects(manager.connectToMatlab())

        sinon.assert.notCalled(launch)
        assert.strictEqual(manager.isMatlabConnected(), false)
    })

    it('should refuse to attach to MATLAB through matlabUrl in an untrusted workspace', async () => {
        matlabUrl = 'https://127.0.0.1:31515'
        const manager = new MatlabLifecycleManager(untrusted)

        await assert.rejects(manager.connectToMatlab())

        sinon.assert.notCalled(attach)
        sinon.assert.notCalled(launch)
    })

    it('should give a feature that asks for MATLAB no connection, and launch nothing', async () => {
        const manager = new MatlabLifecycleManager(untrusted)

        assert.strictEqual(await manager.getMatlabConnection(true), null)

        sinon.assert.notCalled(launch)
    })

    it('should launch MATLAB once trust is granted after a refusal', async () => {
        const manager = new MatlabLifecycleManager(untrusted)
        await assert.rejects(manager.connectToMatlab())

        untrusted.grant()
        await manager.connectToMatlab()

        sinon.assert.calledOnce(launch)
    })

    it('should attach through matlabUrl once trust is granted', async () => {
        matlabUrl = 'https://127.0.0.1:31515'
        const manager = new MatlabLifecycleManager(untrusted)

        untrusted.grant()
        await manager.connectToMatlab()

        sinon.assert.calledOnce(attach)
        sinon.assert.notCalled(launch)
    })

    it('should launch MATLAB when no trust state was given', async () => {
        const manager = new MatlabLifecycleManager()

        await manager.connectToMatlab()

        sinon.assert.calledOnce(launch)
    })
})
