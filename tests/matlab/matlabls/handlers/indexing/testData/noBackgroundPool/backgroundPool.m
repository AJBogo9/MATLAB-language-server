function pool = backgroundPool %#ok<STOUT>
    % BACKGROUNDPOOL Stands in for a MATLAB without a background pool.

    % Copyright 2026 Andreas Bogossian

    error('matlabls:test:noBackgroundPool', 'No background pool in this test.');
end
