classdef FutureWithoutPassFuture < handle
    % FUTUREWITHOUTPASSFUTURE A finished future whose afterAll rejects the PassFuture
    % option with the error R2026a raises for an option afterAll does not know.

    % Copyright 2026 Andreas Bogossian

    properties
        State = 'finished'
        Error = []
    end

    methods
        function afterAll (~, varargin)
            error('MATLAB:InputParser:UnmatchedParameter', '''PassFuture'' is not a recognized parameter. For a list of valid name-value pair arguments, see the documentation for this function.');
        end

        function cancel (~)
        end
    end
end
