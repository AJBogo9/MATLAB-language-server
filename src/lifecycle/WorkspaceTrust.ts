// Copyright 2026 Andreas Bogossian

import { EventEmitter } from 'events'

/**
 * Whether the client trusts the workspace. MATLAB starts in the first workspace folder,
 * with every folder on its path, so it runs that folder's startup.m and any file there
 * that shadows a function it calls. It must not start or attach before the user trusts
 * the workspace; features that need no MATLAB keep working.
 *
 * The client gives the state in its initialization options and sends a notification when
 * the user grants trust. A client that says nothing, such as another editor, is trusted,
 * since it has no notion of trust. As in VS Code, trust is never taken back while the
 * server runs.
 */
export default class WorkspaceTrust {
    private trusted = true
    private readonly eventEmitter = new EventEmitter()

    /**
     * @param initializationOptions The options of the initialize request. Only a
     * workspaceTrusted of false marks the workspace untrusted.
     */
    initialize (initializationOptions: unknown): void {
        this.trusted = !(
            typeof initializationOptions === 'object' &&
            initializationOptions !== null &&
            (initializationOptions as { workspaceTrusted?: unknown }).workspaceTrusted === false
        )
    }

    isTrusted (): boolean {
        return this.trusted
    }

    /**
     * Records that the user trusted the workspace, and tells the listeners if it was not
     * trusted before.
     */
    grant (): void {
        if (this.trusted) {
            return
        }
        this.trusted = true
        this.eventEmitter.emit('granted')
    }

    onGranted (listener: () => void): void {
        this.eventEmitter.on('granted', listener)
    }
}
