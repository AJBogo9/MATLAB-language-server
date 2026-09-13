function pool = backgroundPool
    % BACKGROUNDPOOL Stands in for the background pool of a release whose afterAll
    % has no PassFuture option.

    % Copyright 2026 Andreas Bogossian

    pool = struct('NumWorkers', 2, 'FevalQueue', struct('QueuedFutures', []));
end
