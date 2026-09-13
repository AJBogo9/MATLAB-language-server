function publishParsedFiles (filePaths, analysisLimit, responseChannel)
    % PUBLISHPARSEDFILES Publishes that the crawl started, then parses each file and
    % publishes its data, or the error that stopped it, together with its path. The
    % message for the last file sets isDone.
    %
    % The started message lets the language server time the crawl from when a worker
    % picked it up rather than from when it was queued. A file that cannot be read or
    % parsed is reported and skipped, so it does not end the crawl for the files
    % after it. Kept separate from parseInfoFromFiles so that tests can run it
    % without a pool.

    % Copyright 2026 Andreas Bogossian

    matlabls.internal.CommunicationManager.publish(responseChannel, struct('isStarted', true));

    for n = 1:numel(filePaths)
        filePath = char(filePaths(n));

        msg = struct('filePath', filePath);
        try
            msg.codeData = matlabls.handlers.indexing.parseInfoFromDocument(fileread(filePath), filePath, analysisLimit);
        catch ME
            msg.error = ME.message;
        end
        msg.isDone = (n == numel(filePaths));

        matlabls.internal.CommunicationManager.publish(responseChannel, msg);
    end
end
