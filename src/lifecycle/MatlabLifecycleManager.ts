// Copyright 2022 - 2024 The MathWorks, Inc.

import { EventEmitter } from 'events'

import ConfigurationManager, { Argument, ConnectionTiming } from './ConfigurationManager'
import { MatlabConnection } from './MatlabCommunicationManager'
import LifecycleNotificationHelper from './LifecycleNotificationHelper'
import MatlabSession, { ConnectionAttempt, ConnectionState, launchNewMatlab, connectToMatlab } from './MatlabSession'
import WorkspaceTrust from './WorkspaceTrust'

export default class MatlabLifecycleManager {
    eventEmitter = new EventEmitter()

    private matlabSession: MatlabSession | null = null
    private connectionPromise: Promise<MatlabSession> | null = null
    // The launch or attach under way, which a disconnect stops
    private pendingConnection: PendingConnection | null = null

    /**
     * @param workspaceTrust Whether the workspace is trusted. A client that gives no trust
     * state, such as another editor, is trusted.
     */
    constructor (private readonly workspaceTrust: WorkspaceTrust = new WorkspaceTrust()) {}

    /**
     * Gets the current connection to MATLAB.
     *
     * @param startMatlab If no existing MATLAB connection exists, this determines whether
     * a new connection should be established. If true, this will attempt to establish a
     * new connection. If false, it will not and will return null.
     *
     * @returns The MATLAB connection object, or null if no connection exists.
     */
    async getMatlabConnection (startMatlab: boolean = false): Promise<MatlabConnection | null> {
        // If MATLAB is already connected, return the current connection
        if (this.matlabSession != null) {
            return this.matlabSession.getConnection()
        }

        // If MATLAB is actively connecting, wait for the connection to be established
        if (this.connectionPromise != null) {
            const connectionPromise = this.connectionPromise;
            return await new Promise<MatlabConnection | null>(resolve => {
                connectionPromise.then(matlabSession => {
                    resolve(matlabSession.getConnection())
                }).catch(() => {
                    resolve(null)
                })
            })
        }

        // No connection currently established or establishing. Attempt to connect to MATLAB if desired.
        const matlabConnectionTiming = (await ConfigurationManager.getConfiguration()).matlabConnectionTiming
        const shouldStartMatlab = startMatlab && matlabConnectionTiming !== ConnectionTiming.Never
        if (shouldStartMatlab) {
            try {
                const matlabSession = await this.connectToMatlab()
                return matlabSession.getConnection()
            } catch (err) {
                return null
            }
        } else {
            return null
        }
    }

    /**
     * Attempt to connect to MATLAB. This will not create a second connection to MATLAB
     * if a session already exists.
     *
     * @returns The active MATLAB session
     */
    async connectToMatlab (): Promise<MatlabSession> {
        // MATLAB runs code from the workspace folders as it starts, so every launch and
        // attach waits for the user to trust them
        if (!this.workspaceTrust.isTrusted()) {
            throw new Error('MATLAB does not start in an untrusted workspace')
        }

        // If MATLAB is already connected, do not try to connect again
        if (this.matlabSession != null) {
            return this.matlabSession
        }

        // If MATLAB is actively connecting, wait and return that session
        if (this.connectionPromise != null) {
            const connectionPromise = this.connectionPromise;
            // MATLAB is actively connecting
            return await new Promise<MatlabSession>((resolve, reject) => {
                connectionPromise.then(matlabSession => {
                    resolve(matlabSession)
                }).catch(reason => {
                    reject(reason)
                })
            })
        }

        // Start a new session
        if (shouldConnectToRemoteMatlab()) {
            return await this.connectToRemoteMatlab()
        } else {
            return await this.connectToLocalMatlab()
        }
    }

    /**
     * Terminate the current MATLAB session, or stop the launch or attach under way.
     *
     * Emits a 'disconnected' event when a connected session ends. A launch or attach that
     * is stopped emits none, as it never emitted 'connected'.
     */
    disconnectFromMatlab (): void {
        if (this.pendingConnection != null) {
            this.pendingConnection.stop()
            this.pendingConnection = null
            this.connectionPromise = null
            return
        }

        if (this.matlabSession == null) {
            return
        }

        this.matlabSession.shutdown()
        this.matlabSession = null

        this.eventEmitter.emit('disconnected')
    }

    /**
     * Determine if MATLAB is connected.
     *
     * @returns True if there is an active MATLAB session, false otherwise
     */
    isMatlabConnected (): boolean {
        return this.matlabSession != null || this.connectionPromise != null
    }

    /**
     * Gets the release of the currently connected MATLAB.
     *
     * @returns The MATLAB release (e.g. "R2023b") of the active session, or null if unknown
     */
    getMatlabRelease (): string | null {
        return this.matlabSession == null ? null : this.matlabSession.getMatlabRelease()
    }

    /**
     * Starts a new session with a locally installed MATLAB instance.
     *
     * @returns The new MATLAB session
     */
    private async connectToLocalMatlab (): Promise<MatlabSession> {
        const attempt = new PendingConnection()
        return await this.trackConnection(attempt, this.launchMatlab(attempt))
    }

    /**
     * Starts a new session with a MATLAB instance over a URL.
     *
     * @returns The new MATLAB session
     */
    private async connectToRemoteMatlab (): Promise<MatlabSession> {
        const url = ConfigurationManager.getArgument(Argument.MatlabUrl)
        const attempt = new PendingConnection()
        return await this.trackConnection(attempt, this.attachToMatlab(url, attempt))
    }

    /**
     * Launches a local MATLAB. Tests replace this method.
     */
    private async launchMatlab (attempt: ConnectionAttempt): Promise<MatlabSession> {
        return await launchNewMatlab(this, attempt)
    }

    /**
     * Attaches to the MATLAB at the given URL. Tests replace this method.
     */
    private async attachToMatlab (url: string, attempt: ConnectionAttempt): Promise<MatlabSession> {
        return await connectToMatlab(url, attempt)
    }

    /**
     * Makes a launch or attach the one under way, and installs its session once it connects.
     *
     * @param attempt The launch or attach
     * @param connecting Resolves to its session once MATLAB connects
     * @returns The session, or a rejection if the attempt failed or a disconnect stopped it
     */
    private trackConnection (attempt: PendingConnection, connecting: Promise<MatlabSession>): Promise<MatlabSession> {
        const connection = this.installWhenConnected(attempt, connecting)
        this.pendingConnection = attempt
        // Features waiting for MATLAB wait for this, so they never get a session that was stopped
        this.connectionPromise = connection
        return connection
    }

    private async installWhenConnected (attempt: PendingConnection, connecting: Promise<MatlabSession>): Promise<MatlabSession> {
        let matlabSession: MatlabSession
        try {
            matlabSession = await connecting
        } catch (reason) {
            throw attempt.isStopped() ? stoppedError() : reason
        } finally {
            // A disconnect may have replaced the attempt with a newer one, which must stay tracked
            if (this.pendingConnection === attempt) {
                this.pendingConnection = null
                this.connectionPromise = null
            }
        }

        if (attempt.isStopped()) {
            // MATLAB connected after the disconnect, so the session ends instead of being installed
            matlabSession.shutdown()
            throw stoppedError()
        }

        this.matlabSession = matlabSession
        this.matlabSession.eventEmitter.on('shutdown', () => {
            this.matlabSession = null
            this.eventEmitter.emit('disconnected')
        })
        this.eventEmitter.emit('connected')
        return matlabSession
    }
}

/**
 * A launch or attach under way. Stopping it shuts its session down, now or as soon as the
 * session exists.
 */
class PendingConnection implements ConnectionAttempt {
    private session: MatlabSession | null = null
    private stopped = false

    isStopped (): boolean {
        return this.stopped
    }

    setSession (session: MatlabSession): void {
        this.session = session
        if (this.stopped) {
            session.shutdown()
        }
    }

    stop (): void {
        this.stopped = true
        if (this.session != null) {
            // The session reports that it disconnected
            this.session.shutdown()
        } else {
            // The launch reported that it is connecting, but has no session to report the end
            LifecycleNotificationHelper.notifyConnectionStatusChange(ConnectionState.DISCONNECTED)
        }
    }
}

function stoppedError (): Error {
    return new Error('MATLAB was disconnected before it connected')
}

/**
 * Whether or not the language server should attempt to connect to an existing
 * MATLAB instance.
 *
 * @returns True if the language server should attempt to connect to an
 * already-running instance of MATLAB. False otherwise.
 */
function shouldConnectToRemoteMatlab (): boolean {
    // Assume we should connect to existing MATLAB if the matlabUrl startup flag has been provided
    return Boolean(ConfigurationManager.getArgument(Argument.MatlabUrl))
}
