function status = parseInfoFromDocumentAsync (code, filePath, analysisLimit, responseChannel, requestId)
    % PARSEINFOFROMDOCUMENTASYNC Parses the given code on the background pool and
    % publishes the result over the response channel.
    %
    % A large file takes up to about 2 seconds to parse. On the MATLAB thread that
    % holds up every other request, including completions and the command window,
    % after each pause in typing.
    %
    % Returns 1 if the parse was queued, 0 if background parsing is unavailable in
    % this MATLAB, or 2 if the pool is busy. For 0 and 2 the caller parses on the
    % MATLAB thread instead. Doubles, because the MVM has no logical type.

    % Copyright 2026 Andreas Bogossian

    status = 0;
    try
        pool = backgroundPool;
        if pool.NumWorkers < 2
            % With one worker the parse would wait behind a whole workspace crawl
            return
        end
        % R2021b's pool has no FevalQueue, so a parse is queued without checking for a queue
        if isprop(pool, 'FevalQueue') && ~isempty(pool.FevalQueue.QueuedFutures)
            status = 2;
            return
        end
        parfeval(pool, @parseAndPublish, 0, code, filePath, analysisLimit, responseChannel, requestId);
        status = 1;
    catch
        status = 0;
    end
end

function parseAndPublish (code, filePath, analysisLimit, responseChannel, requestId)
    msg = matlabls.handlers.indexing.buildParseResponse(code, filePath, analysisLimit, requestId);
    matlabls.internal.CommunicationManager.publish(responseChannel, msg);
end
