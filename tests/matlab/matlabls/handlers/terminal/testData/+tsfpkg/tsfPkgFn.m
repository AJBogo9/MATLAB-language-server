function tsfPkgFn
    % Errors in a nested function inside a local function

    % Copyright 2026 Andreas Bogossian

    host();
end

function host
    child();

    function child
        error('tsf:test', 'nested failure');
    end
end
