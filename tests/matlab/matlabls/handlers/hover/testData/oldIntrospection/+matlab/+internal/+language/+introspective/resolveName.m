function resolved = resolveName (~)
    % RESOLVENAME Stands in for the pre-R2024a name, and calls every name a
    % resolved builtin, which the name the tests ask about is not.

    % Copyright 2026 Andreas Bogossian

    resolved = struct('isResolved', true, 'isBuiltin', true);
end
