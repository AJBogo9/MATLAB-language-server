function future = parfeval (~, fcn, ~, varargin)
    % PARFEVAL Runs the function at once, on the MATLAB thread, and returns a future
    % whose afterAll rejects PassFuture, as a release without that option would.

    % Copyright 2026 Andreas Bogossian

    fcn(varargin{:});
    future = FutureWithoutPassFuture();
end
