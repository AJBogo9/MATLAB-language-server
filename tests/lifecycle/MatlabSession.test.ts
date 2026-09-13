// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import sinon from 'sinon'

import ClientConnection from '../../src/ClientConnection'
import Licensing from '../../src/licensing'
import Logger from '../../src/logging/Logger'
import ClientCapabilitiesManager from '../../src/lifecycle/ClientCapabilitiesManager'
import ConfigurationManager from '../../src/lifecycle/ConfigurationManager'
import LifecycleNotificationHelper from '../../src/lifecycle/LifecycleNotificationHelper'
import MatlabCommunicationManager from '../../src/lifecycle/MatlabCommunicationManager'
import MatlabLifecycleManager from '../../src/lifecycle/MatlabLifecycleManager'
import { ConnectionAttempt, connectToMatlab, launchNewMatlab, LocalMatlabSession, RemoteMatlabSession } from '../../src/lifecycle/MatlabSession'
import getMockConnection from '../mocks/Connection.mock'

// No process can have this pid, so nothing real is signalled even if a stub is bypassed
const IMPOSSIBLE_PID = 1073741000

/**
 * @param pid The launcher's pid, or null for a launcher that never started
 */
function fakeLauncher (pid: number | null = IMPOSSIBLE_PID): any {
    const launcher: any = new EventEmitter()
    launcher.pid = pid ?? undefined
    launcher.exitCode = null
    launcher.signalCode = null
    launcher.kill = sinon.stub().returns(true)
    launcher.stderr = new EventEmitter()
    return launcher
}

function fakeConnection (): any {
    return {
        close: sinon.stub(),
        setLifecycleListener: sinon.stub(),
        initialize: sinon.stub().resolves()
    }
}

/**
 * A launch or attach driven by the test the way the lifecycle manager drives one
 */
class TestAttempt implements ConnectionAttempt {
    stopped = false
    session: any = null

    isStopped (): boolean {
        return this.stopped
    }

    setSession (session: any): void {
        this.session = session
    }

    // What a disconnect does
    stop (): void {
        this.stopped = true
        this.session?.shutdown()
    }
}

async function waitFor (condition: () => boolean, what: string): Promise<void> {
    const end = Date.now() + 1500
    while (!condition()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`)
        }
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

describe('LocalMatlabSession shutdown', () => {
    let killTree: sinon.SinonStub
    let launcher: any
    let connection: any
    let session: LocalMatlabSession

    beforeEach(() => {
        ClientConnection._setConnection(getMockConnection())
        killTree = sinon.stub()
        launcher = fakeLauncher()
        connection = fakeConnection()
        session = new LocalMatlabSession(killTree)
        session.initialize(connection, launcher)
    })

    afterEach(() => {
        sinon.restore()
        ClientConnection._clearConnection()
    })

    it('should kill the whole process tree of a MATLAB that has not connected', () => {
        session.shutdown()

        sinon.assert.calledOnceWithExactly(killTree, IMPOSSIBLE_PID)
        sinon.assert.calledOnce(connection.close)
    })

    it('should only send SIGTERM to the launcher of a connected MATLAB, as before', async () => {
        await session.startConnection(31515, '/tmp/cert.pem', IMPOSSIBLE_PID + 1, 'R2026a')

        session.shutdown()

        sinon.assert.notCalled(killTree)
        sinon.assert.calledOnceWithExactly(launcher.kill, 'SIGTERM')
        sinon.assert.calledOnce(connection.close)
    })

    it('should kill the process tree of a MATLAB whose connection failed to come up', async () => {
        connection.initialize = sinon.stub().rejects(new Error('handshake failed'))
        await assert.rejects(session.startConnection(31515, '/tmp/cert.pem', IMPOSSIBLE_PID + 1, 'R2026a'))

        session.shutdown()

        sinon.assert.calledOnceWithExactly(killTree, IMPOSSIBLE_PID)
    })

    it('should not kill by the pid of a launcher that has exited or was killed', () => {
        launcher.exitCode = 1
        session.shutdown()

        const other = fakeLauncher()
        other.signalCode = 'SIGKILL'
        const otherSession = new LocalMatlabSession(killTree)
        otherSession.initialize(fakeConnection(), other)
        otherSession.shutdown()

        sinon.assert.notCalled(killTree)
    })

    it('should not kill a launcher that never started', () => {
        const unstarted = new LocalMatlabSession(killTree)
        unstarted.initialize(fakeConnection(), fakeLauncher(null))

        unstarted.shutdown()

        sinon.assert.notCalled(killTree)
    })

    it('should shut down only once', () => {
        session.shutdown()
        session.shutdown()

        sinon.assert.calledOnce(killTree)
    })
})

describe('RemoteMatlabSession shutdown', () => {
    afterEach(() => {
        ClientConnection._clearConnection()
    })

    it('should only close the connection to a MATLAB that the server did not start', () => {
        ClientConnection._setConnection(getMockConnection())
        const connection = fakeConnection()
        const session = new RemoteMatlabSession()
        session.initialize(connection)

        session.shutdown()

        sinon.assert.calledOnce(connection.close)
    })
})

/**
 * A disconnect can come at any point of a launch: before its session exists, while the
 * launch is prepared, after MATLAB was spawned, or while MATLAB connects.
 */
describe('launchNewMatlab stopped by a disconnect', () => {
    const outFile = path.join(Logger.logDir, 'matlabls_conn.json')
    let mockConnection: any
    let getConfiguration: sinon.SinonStub
    let spawn: sinon.SinonStub
    let launcher: any
    let connection: any
    let savedLicensing: unknown
    let spawned = false
    const launches: Array<Promise<unknown>> = []

    function launch (attempt: ConnectionAttempt): Promise<unknown> {
        const launching = launchNewMatlab(new MatlabLifecycleManager(), attempt)
        launches.push(launching.catch(() => {}))
        return launching
    }

    const sentMethods = (): string[] => mockConnection.sendNotification.getCalls().map((call: sinon.SinonSpyCall) => call.args[0])
    const connectionStatuses = (): string[] => mockConnection.sendNotification.getCalls()
        .filter((call: sinon.SinonSpyCall) => call.args[0] === 'matlab/connection/update/server')
        .map((call: sinon.SinonSpyCall) => call.args[1].connectionStatus)

    function writeStartupFile (): void {
        fs.writeFileSync(outFile, JSON.stringify({ pid: IMPOSSIBLE_PID + 1, port: 31515, release: 'R2026a', certFile: '/tmp/cert.pem', sessionKey: 'key' }))
    }

    beforeEach(() => {
        mockConnection = getMockConnection()
        ClientConnection._setConnection(mockConnection)
        getConfiguration = sinon.stub(ConfigurationManager, 'getConfiguration').resolves({ installPath: '/opt/fake/MATLAB', signIn: false } as any)
        sinon.stub(ConfigurationManager, 'getArgument').returns(undefined as any)
        sinon.stub(ClientCapabilitiesManager, 'hasWorkspaceFolders').returns(false)
        savedLicensing = (Licensing as any).instance
        ;(Licensing as any).instance = { isNLMLicensing: () => false }

        // A launcher with no pid, so that the real process tree kill has nothing to kill
        launcher = fakeLauncher(null)
        connection = fakeConnection()
        spawned = false
        spawn = sinon.stub(MatlabCommunicationManager, 'launchNewMatlab').callsFake(() => {
            spawned = true
            return { matlabProcess: launcher, matlabConnection: connection }
        })
        LifecycleNotificationHelper.didMatlabLaunchFail = false
    })

    afterEach(async () => {
        // An error from the launcher closes the startup file watcher of any launch still waiting
        if (spawned) {
            launcher.emit('error', new Error('test cleanup'))
        }
        await Promise.all(launches.splice(0))
        sinon.restore()
        ;(Licensing as any).instance = savedLicensing
        ClientConnection._clearConnection()
        LifecycleNotificationHelper.didMatlabLaunchFail = false
        fs.rmSync(outFile, { force: true })
    })

    it('should spawn no MATLAB for a launch stopped before its session existed', async () => {
        const attempt = new TestAttempt()
        attempt.stopped = true

        await assert.rejects(launch(attempt), /stopped before MATLAB started/)

        sinon.assert.notCalled(spawn)
        assert.strictEqual(attempt.session, null)
    })

    it('should hand the session to the attempt before MATLAB is spawned', async () => {
        const attempt = new TestAttempt()
        let sessionAtSpawn: unknown = null
        spawn.callsFake(() => {
            spawned = true
            sessionAtSpawn = attempt.session
            return { matlabProcess: launcher, matlabConnection: connection }
        })

        void launch(attempt)
        await waitFor(() => spawned, 'the spawn')

        assert.ok(sessionAtSpawn instanceof LocalMatlabSession)
    })

    it('should spawn no MATLAB when the disconnect comes while the launch is prepared', async () => {
        const attempt = new TestAttempt()
        // The launch command reads the configuration a second time
        getConfiguration.onSecondCall().callsFake(async () => {
            attempt.stop()
            return { installPath: '/opt/fake/MATLAB', signIn: false }
        })

        await assert.rejects(launch(attempt), /stopped before MATLAB started/)

        sinon.assert.notCalled(spawn)
        assert.ok(attempt.session instanceof LocalMatlabSession)
    })

    it('should not report a failed launch for a launcher error after the disconnect', async () => {
        const attempt = new TestAttempt()
        const launching = launch(attempt)
        await waitFor(() => spawned, 'the spawn')

        attempt.stop()
        launcher.emit('error', new Error('kill EPERM'))

        await assert.rejects(launching, /Error from MATLAB child process/)
        assert.strictEqual(LifecycleNotificationHelper.didMatlabLaunchFail, false)
        assert.ok(!sentMethods().includes('matlab/launchfailed'), JSON.stringify(sentMethods()))
    })

    it('should still report a failed launch for a launcher error without a disconnect', async () => {
        const launching = launch(new TestAttempt())
        await waitFor(() => spawned, 'the spawn')

        launcher.emit('error', new Error('spawn ENOENT'))

        await assert.rejects(launching, /Error from MATLAB child process/)
        assert.strictEqual(LifecycleNotificationHelper.didMatlabLaunchFail, true)
        assert.ok(sentMethods().includes('matlab/launchfailed'))
    })

    it('should not connect when MATLAB writes its startup file after the disconnect', async () => {
        const attempt = new TestAttempt()
        const launching = launch(attempt)
        await waitFor(() => spawned, 'the spawn')

        attempt.stop()
        writeStartupFile()

        await assert.rejects(launching, /stopped before MATLAB connected/)
        sinon.assert.notCalled(connection.initialize)
        assert.ok(!connectionStatuses().includes('connected'))
        await waitFor(() => !fs.existsSync(outFile), 'the startup file to be removed')
    })

    it('should not report connected when MATLAB connects after the disconnect', async () => {
        const attempt = new TestAttempt()
        let finishHandshake: () => void = () => {}
        connection.initialize = sinon.stub().callsFake(async () => await new Promise<void>(resolve => { finishHandshake = resolve }))
        const launching = launch(attempt)
        await waitFor(() => spawned, 'the spawn')
        writeStartupFile()
        await waitFor(() => connection.initialize.called, 'the handshake')

        attempt.stop()
        finishHandshake()

        await assert.rejects(launching, /stopped before MATLAB connected/)
        assert.deepStrictEqual(connectionStatuses(), ['connecting', 'disconnected'])
    })

    it('should report connected when MATLAB connects without a disconnect', async () => {
        const attempt = new TestAttempt()
        const launching = launch(attempt)
        await waitFor(() => spawned, 'the spawn')

        writeStartupFile()

        assert.strictEqual(await launching, attempt.session)
        assert.deepStrictEqual(connectionStatuses(), ['connecting', 'connected'])
    })
})

describe('connectToMatlab stopped by a disconnect', () => {
    let deliver: (connection: any) => void
    let connect: sinon.SinonStub

    beforeEach(() => {
        ClientConnection._setConnection(getMockConnection())
        connect = sinon.stub(MatlabCommunicationManager, 'connectToExistingMatlab').callsFake(async () => await new Promise(resolve => { deliver = resolve }))
    })

    afterEach(() => {
        sinon.restore()
        ClientConnection._clearConnection()
    })

    it('should close a connection that arrives after the disconnect, and not start it', async () => {
        const attempt = new TestAttempt()
        const attaching = connectToMatlab('https://127.0.0.1:31515', attempt)
        assert.ok(attempt.session instanceof RemoteMatlabSession)
        await waitFor(() => connect.called, 'the attach')

        attempt.stop()
        const connection = fakeConnection()
        deliver(connection)

        await assert.rejects(attaching, /attach to MATLAB was stopped/)
        sinon.assert.calledOnce(connection.close)
        sinon.assert.notCalled(connection.initialize)
    })

    it('should start the connection of an attach that was not stopped', async () => {
        const attempt = new TestAttempt()
        const attaching = connectToMatlab('https://127.0.0.1:31515', attempt)
        await waitFor(() => connect.called, 'the attach')

        const connection = fakeConnection()
        deliver(connection)

        assert.strictEqual(await attaching, attempt.session)
        sinon.assert.calledOnce(connection.initialize)
        sinon.assert.notCalled(connection.close)
    })
})
