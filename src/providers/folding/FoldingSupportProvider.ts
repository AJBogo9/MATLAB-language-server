// Copyright 2024-2025 The MathWorks, Inc.

import { FoldingRangeParams, TextDocuments, FoldingRange } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import MatlabLifecycleManager from '../../lifecycle/MatlabLifecycleManager'
import MVM from '../../mvm/impl/MVM'
import { computeFoldingRanges } from './OfflineFoldingScanner'

class FoldingSupportProvider {
    // Folding no longer asks MATLAB, so it works while MATLAB starts, is down, or cannot parse
    // the file. The constructor keeps its signature for server.ts.
    constructor (private readonly matlabLifecycleManager: MatlabLifecycleManager, private readonly mvm: MVM) {}

    async handleFoldingRangeRequest (params: FoldingRangeParams, documentManager: TextDocuments<TextDocument>): Promise<FoldingRange[] | null> {
        const docToFold = documentManager.get(params.textDocument.uri)
        if (docToFold == null) {
            return null
        }

        const foldingRanges = computeFoldingRanges(docToFold.getText())

        // null, unlike an empty list, lets VS Code fall back to folding by indentation
        return foldingRanges.length > 0 ? foldingRanges : null
    }
}

export default FoldingSupportProvider
