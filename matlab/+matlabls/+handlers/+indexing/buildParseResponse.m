function msg = buildParseResponse (code, filePath, analysisLimit, requestId)
    % BUILDPARSERESPONSE Parses the given code and packages the result, or the
    % error, together with the ID of the request it answers.
    %
    % Kept separate from parseInfoFromDocumentAsync so that tests can run it on a
    % worker and read the result, which a published message does not allow.

    % Copyright 2026 Andreas Bogossian

    msg.requestId = requestId;
    try
        msg.codeData = matlabls.handlers.indexing.parseInfoFromDocument(code, filePath, analysisLimit);
    catch ME
        msg.error = ME.message;
    end
end
