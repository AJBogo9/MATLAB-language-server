function parseInfoFromFiles (filePaths, analysisLimit, responseChannel)
    % PARSEINFOFROMFILES Parses the given MATLAB files on the background pool and
    % publishes one message per file over the response channel.
    %
    % The language server walks the workspace itself, without following symbolic
    % links, and sends the file list. All files are parsed in a single future, so
    % the MATLAB thread is free again as soon as it is queued. The future may wait
    % for a free worker, and publishes that it started before its first file. If it
    % fails or is cancelled, before or during the crawl, publishCrawlFailure says so
    % over the same channel, so the language server does not wait for files that
    % never come.

    % Copyright 2026 Andreas Bogossian

    future = parfeval(backgroundPool, @matlabls.handlers.indexing.publishParsedFiles, 0, filePaths, analysisLimit, responseChannel);
    % With PassFuture the callback also runs for a future that failed or was cancelled
    afterAll(future, @(finished) matlabls.handlers.indexing.publishCrawlFailure(finished, responseChannel), 0, 'PassFuture', true);
end
