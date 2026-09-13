function cancelCrawl (responseChannel)
    % CANCELCRAWL Cancels the workspace crawl that publishes over the response
    % channel, whether it waits for a worker or runs, and forgets it. Does nothing
    % for a crawl that is not recorded or has finished.
    %
    % The language server calls this when it gives a crawl up while MATLAB is still
    % there, so that the crawl does not keep a pool worker busy publishing to a
    % channel nobody listens to. A cancelled crawl runs no catch block, so only the
    % afterAll callback reports it, to a language server that no longer listens.

    % Copyright 2026 Andreas Bogossian

    future = matlabls.handlers.indexing.crawlFutures('take', responseChannel);
    if ~isempty(future)
        cancel(future);
    end
end
