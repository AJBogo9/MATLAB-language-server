// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import { EventEmitter } from 'events'
import sinon from 'sinon'

import ConfigurationManager, { ConnectionTiming } from '../../src/lifecycle/ConfigurationManager'
import LifecycleNotificationHelper from '../../src/lifecycle/LifecycleNotificationHelper'
import MatlabLifecycleManager from '../../src/lifecycle/MatlabLifecycleManager'
import { ConnectionAttempt, ConnectionState } from '../../src/lifecycle/MatlabSession'
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

interface PendingLaunch {
    attempt: ConnectionAttempt
    resolve: (session: unknown) => void
    reject: (reason: Error) => void
}

/**
 * The server disconnects from MATLAB when it shuts down. A disconnect while MATLAB was
 * launching did nothing, since the manager held no session until MATLAB connected, so MATLAB
 * kept running after the server exited.
 */
describe('MatlabLifecycleManager disconnected while MATLAB connects', () => {
    let launches: PendingLaunch[]
    let attaches: PendingLaunch[]
    let attach: sinon.SinonStub
    let matlabUrl: string
    let notify: sinon.SinonStub

    const pendingIn = (list: PendingLaunch[]) => async (attempt: ConnectionAttempt) => await new Promise((resolve, reject) => {
        list.push({ attempt, resolve, reject })
    })

    beforeEach(() => {
        launches = []
        attaches = []
        // The module functions behind these cannot be stubbed under tsx, so the methods that call them are
        sinon.stub(MatlabLifecycleManager.prototype as any, 'launchMatlab').callsFake(pendingIn(launches) as any)
        attach = sinon.stub(MatlabLifecycleManager.prototype as any, 'attachToMatlab').callsFake(((url: string, attempt: ConnectionAttempt) => pendingIn(attaches)(attempt)) as any)
        sinon.stub(ConfigurationManager, 'getConfiguration').resolves({ matlabConnectionTiming: ConnectionTiming.OnStart } as any)
        matlabUrl = ''
        sinon.stub(ConfigurationManager, 'getArgument').callsFake(() => matlabUrl)
        notify = sinon.stub(LifecycleNotificationHelper, 'notifyConnectionStatusChange')
    })

    afterEach(() => {
        sinon.restore()
    })

    function recordEvents (manager: MatlabLifecycleManager): string[] {
        const events: string[] = []
        manager.eventEmitter.on('connected', () => events.push('connected'))
        manager.eventEmitter.on('disconnected', () => events.push('disconnected'))
        return events
    }

    /** Starts a connection; resolves to 'connected' or to the rejection's message */
    function connect (manager: MatlabLifecycleManager): Promise<string> {
        return manager.connectToMatlab().then(() => 'connected', (err: Error) => err.message)
    }

    it('should shut down the session of a launch under way, and report nothing connected', async () => {
        const manager = new MatlabLifecycleManager()
        const events = recordEvents(manager)
        const outcome = connect(manager)
        const session = fakeSession()
        launches[0].attempt.setSession(session)

        manager.disconnectFromMatlab()

        sinon.assert.calledOnce(session.shutdown)
        assert.strictEqual(manager.isMatlabConnected(), false)
        assert.strictEqual(await manager.getMatlabConnection(), null)
        // The session reports its own disconnect
        sinon.assert.notCalled(notify)

        launches[0].reject(new Error('MATLAB process terminated unexpectedly'))

        assert.strictEqual(await outcome, 'MATLAB was disconnected before it connected')
        assert.deepStrictEqual(events, [])
        assert.strictEqual(manager.isMatlabConnected(), false)
        assert.strictEqual(manager.getMatlabRelease(), null)
    })

    it('should shut down a session that connects after the disconnect instead of installing it', async () => {
        const manager = new MatlabLifecycleManager()
        const events = recordEvents(manager)
        const outcome = connect(manager)

        manager.disconnectFromMatlab()
        const session = fakeSession()
        launches[0].resolve(session)

        assert.strictEqual(await outcome, 'MATLAB was disconnected before it connected')
        sinon.assert.calledOnce(session.shutdown)
        assert.deepStrictEqual(events, [])
        assert.strictEqual(manager.isMatlabConnected(), false)
        assert.strictEqual(await manager.getMatlabConnection(), null)
        assert.strictEqual(manager.getMatlabRelease(), null)
    })

    it('should report the disconnect itself for a launch that has no session yet', () => {
        const manager = new MatlabLifecycleManager()
        void connect(manager)

        manager.disconnectFromMatlab()

        assert.strictEqual(launches[0].attempt.isStopped(), true)
        sinon.assert.calledOnceWithExactly(notify, ConnectionState.DISCONNECTED)
    })

    it('should do nothing more on a second disconnect after a launch was stopped', () => {
        const withSession = new MatlabLifecycleManager()
        void connect(withSession)
        const session = fakeSession()
        launches[0].attempt.setSession(session)
        withSession.disconnectFromMatlab()
        withSession.disconnectFromMatlab()

        const withoutSession = new MatlabLifecycleManager()
        void connect(withoutSession)
        withoutSession.disconnectFromMatlab()
        withoutSession.disconnectFromMatlab()

        sinon.assert.calledOnce(session.shutdown)
        sinon.assert.calledOnce(notify)
    })

    it('should shut down a session handed to a launch that was already stopped', () => {
        const manager = new MatlabLifecycleManager()
        void connect(manager)
        manager.disconnectFromMatlab()

        const session = fakeSession()
        launches[0].attempt.setSession(session)

        sinon.assert.calledOnce(session.shutdown)
    })

    it('should give features waiting for the launch no connection, even when MATLAB connects later', async () => {
        const manager = new MatlabLifecycleManager()
        void connect(manager)
        const waitingForConnection = manager.getMatlabConnection()
        const waitingForSession = connect(manager)
        assert.strictEqual(launches.length, 1)

        manager.disconnectFromMatlab()
        launches[0].resolve(fakeSession())

        assert.strictEqual(await waitingForConnection, null)
        assert.strictEqual(await waitingForSession, 'MATLAB was disconnected before it connected')
    })

    it('should let a new launch start after a disconnect, undisturbed by the stopped one', async () => {
        const manager = new MatlabLifecycleManager()
        const events = recordEvents(manager)
        const first = connect(manager)
        manager.disconnectFromMatlab()
        const second = connect(manager)
        assert.strictEqual(launches.length, 2)

        const stale = fakeSession()
        launches[0].resolve(stale)
        assert.strictEqual(await first, 'MATLAB was disconnected before it connected')
        assert.strictEqual(manager.isMatlabConnected(), true, 'the second launch is still under way')

        const session = fakeSession()
        launches[1].resolve(session)

        assert.strictEqual(await second, 'connected')
        assert.deepStrictEqual(events, ['connected'])
        assert.deepStrictEqual(await manager.getMatlabConnection(), { name: 'fake connection' })
        sinon.assert.calledOnce(stale.shutdown)
        sinon.assert.notCalled(session.shutdown)
    })

    it('should pass on a launch failure that no disconnect caused', async () => {
        const manager = new MatlabLifecycleManager()
        const outcome = connect(manager)

        launches[0].reject(new Error('Failed to launch local MATLAB'))

        assert.strictEqual(await outcome, 'Failed to launch local MATLAB')
        assert.strictEqual(manager.isMatlabConnected(), false)
        sinon.assert.notCalled(notify)
    })

    it('should connect and disconnect as before when MATLAB connects first', async () => {
        const manager = new MatlabLifecycleManager()
        const events = recordEvents(manager)
        const outcome = connect(manager)
        assert.strictEqual(manager.isMatlabConnected(), true)
        const session = fakeSession()
        launches[0].attempt.setSession(session)
        launches[0].resolve(session)

        assert.strictEqual(await outcome, 'connected')
        assert.deepStrictEqual(events, ['connected'])
        assert.strictEqual(manager.isMatlabConnected(), true)
        assert.deepStrictEqual(await manager.getMatlabConnection(), { name: 'fake connection' })
        assert.strictEqual(manager.getMatlabRelease(), 'R2026a')

        manager.disconnectFromMatlab()

        sinon.assert.calledOnce(session.shutdown)
        assert.deepStrictEqual(events, ['connected', 'disconnected'])
        assert.strictEqual(manager.isMatlabConnected(), false)
        assert.strictEqual(launches[0].attempt.isStopped(), false)
        sinon.assert.notCalled(notify)
    })

    it('should forget a connected session that shuts down by itself, as before', async () => {
        const manager = new MatlabLifecycleManager()
        const events = recordEvents(manager)
        const outcome = connect(manager)
        const session = fakeSession()
        launches[0].resolve(session)
        await outcome

        session.eventEmitter.emit('shutdown')

        assert.deepStrictEqual(events, ['connected', 'disconnected'])
        assert.strictEqual(manager.isMatlabConnected(), false)
    })

    it('should stop an attach through matlabUrl the same way, through its session', async () => {
        matlabUrl = 'https://127.0.0.1:31515'
        const manager = new MatlabLifecycleManager()
        const outcome = connect(manager)
        assert.strictEqual(launches.length, 0)
        sinon.assert.calledOnceWithMatch(attach, matlabUrl)
        const session = fakeSession()
        attaches[0].attempt.setSession(session)

        manager.disconnectFromMatlab()
        attaches[0].resolve(session)

        sinon.assert.calledOnce(session.shutdown)
        assert.strictEqual(await outcome, 'MATLAB was disconnected before it connected')
        assert.strictEqual(manager.isMatlabConnected(), false)
    })

    it('should launch nothing in an untrusted workspace, leaving a disconnect nothing to stop', async () => {
        const untrusted = new WorkspaceTrust()
        untrusted.initialize({ workspaceTrusted: false })
        const manager = new MatlabLifecycleManager(untrusted)

        assert.match(await connect(manager), /untrusted workspace/)
        manager.disconnectFromMatlab()

        assert.strictEqual(launches.length, 0)
        sinon.assert.notCalled(notify)
    })
})
