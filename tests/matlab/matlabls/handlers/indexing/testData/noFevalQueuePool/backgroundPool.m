function pool = backgroundPool
    % BACKGROUNDPOOL Stands in for the background pool of R2021b, which has no
    % FevalQueue property yet.

    % Copyright 2026 Andreas Bogossian

    pool = struct('NumWorkers', 4);
end
