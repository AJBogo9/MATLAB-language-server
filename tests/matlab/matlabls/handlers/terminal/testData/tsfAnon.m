function tsfAnon
    % Errors inside an anonymous function

    % Copyright 2026 Andreas Bogossian

    f = @(z) z(5);
    f(1);
end
