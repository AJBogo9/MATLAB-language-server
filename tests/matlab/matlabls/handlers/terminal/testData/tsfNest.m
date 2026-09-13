function tsfNest
    % Errors in a nested function of the main function

    % Copyright 2026 Andreas Bogossian

    kid();

    function kid
        error('tsf:test', 'nested failure');
    end
end
