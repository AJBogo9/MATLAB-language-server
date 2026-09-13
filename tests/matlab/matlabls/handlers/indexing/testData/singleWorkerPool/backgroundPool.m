function pool = backgroundPool
    % BACKGROUNDPOOL Stands in for a background pool with a single worker.

    % Copyright 2026 Andreas Bogossian

    pool = struct('NumWorkers', 1, 'FevalQueue', struct('QueuedFutures', []));
end
