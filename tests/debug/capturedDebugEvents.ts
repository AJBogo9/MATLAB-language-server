// Copyright 2026 Andreas Bogossian
// Captured from MATLAB R2026a over the MVM wire on 2026-09-13 (item10 .lane/dap-traffic-1.jsonl and -2.jsonl, fevalResponse notifications in .lane/harness-1.txt and -2.txt). dbclearAll is what dbclear all sends and dbclearIdentifier what clearing one identifier sends (dap-traffic-1.jsonl lines 293 to 295 and 312). exitSessionStillActive is the only synthetic payload: MATLAB was never seen sending it.

const captured = {
    stops: {
        fileBreak: [
            { DebugNestLevel: 2, Filespec: '/tmp/dapHarness-3WUXDp/bpScript.m', IdOfChangedIIP: '0x3b690x1fed1a', IsAtEndOfFunction: false, LineNumber: 2, Source: { Filename: '/tmp/dapHarness-3WUXDp/bpScript.m', LineNumber: 2, Type: 'FileBreak' }, WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false },
            { DebugNestLevel: 1, Filespec: '/tmp/dapHarness-3WUXDp/bpScript.m', IdOfChangedIIP: '0x3b690x1fed1a', IsAtEndOfFunction: false, LineNumber: 2, Source: { Filename: '/tmp/dapHarness-3WUXDp/bpScript.m', LineNumber: 2, Type: 'FileBreak' }, Stack: [{ File: '/tmp/dapHarness-3WUXDp/bpScript.m', Function: 'bpScript', Line: 2 }], WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false }
        ],
        error: [
            { DebugNestLevel: 2, Filespec: '/tmp/dapHarness-3WUXDp/errFn.m', IdOfChangedIIP: '0x3c2f0x1fed1a', IsAtEndOfFunction: false, LineNumber: 3, Source: { Condition: 'error', Message: 'Boom 1', Type: 'GlobalBreak' }, WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false },
            { DebugNestLevel: 1, Filespec: '/tmp/dapHarness-3WUXDp/errFn.m', IdOfChangedIIP: '0x3c2f0x1fed1a', IsAtEndOfFunction: false, LineNumber: 3, Source: { Condition: 'error', Message: 'Boom 1', Type: 'GlobalBreak' }, Stack: [{ File: '/tmp/dapHarness-3WUXDp/errFn.m', Function: 'errFn', Line: 3 }], WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false }
        ],
        caughtError: [
            { DebugNestLevel: 2, Filespec: '/tmp/dapHarness-3WUXDp/caughtFn.m', IdOfChangedIIP: '0x3da20x1fed1a', IsAtEndOfFunction: false, LineNumber: 3, Source: { Condition: 'caught error', Message: 'inner', Type: 'GlobalBreak' }, WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false },
            { DebugNestLevel: 1, Filespec: '/tmp/dapHarness-3WUXDp/caughtFn.m', IdOfChangedIIP: '0x3da20x1fed1a', IsAtEndOfFunction: false, LineNumber: 3, Source: { Condition: 'caught error', Message: 'inner', Type: 'GlobalBreak' }, Stack: [{ File: '/tmp/dapHarness-3WUXDp/caughtFn.m', Function: 'caughtFn', Line: 3 }], WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false }
        ],
        warning: [
            { DebugNestLevel: 2, Filespec: '/tmp/dapHarness-3WUXDp/warnFn.m', IdOfChangedIIP: '0x3e6b0x1fed1a', IsAtEndOfFunction: false, LineNumber: 2, Source: { Condition: 'warning', Message: 'careful', Type: 'GlobalBreak' }, WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false },
            { DebugNestLevel: 1, Filespec: '/tmp/dapHarness-3WUXDp/warnFn.m', IdOfChangedIIP: '0x3e6b0x1fed1a', IsAtEndOfFunction: false, LineNumber: 2, Source: { Condition: 'warning', Message: 'careful', Type: 'GlobalBreak' }, Stack: [{ File: '/tmp/dapHarness-3WUXDp/warnFn.m', Function: 'warnFn', Line: 2 }], WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false }
        ],
        naninf: [
            { DebugNestLevel: 2, Filespec: '/tmp/dapHarness-3WUXDp/nanFn.m', IdOfChangedIIP: '0x3f0f0x1fed1a', IsAtEndOfFunction: false, LineNumber: 2, Source: { Condition: 'naninf', Type: 'GlobalBreak' }, WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false },
            { DebugNestLevel: 1, Filespec: '/tmp/dapHarness-3WUXDp/nanFn.m', IdOfChangedIIP: '0x3f0f0x1fed1a', IsAtEndOfFunction: false, LineNumber: 2, Source: { Condition: 'naninf', Type: 'GlobalBreak' }, Stack: [{ File: '/tmp/dapHarness-3WUXDp/nanFn.m', Function: 'nanFn', Line: 2 }], WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false }
        ],
        step: [
            { DebugNestLevel: 1, Filespec: '/tmp/dapHarness2-dFYSyf/warnFn2.m', IdOfChangedIIP: '0x3b8c0x2045f9', IsAtEndOfFunction: false, LineNumber: 3, Source: { Type: 'OtherBreak' }, Stack: [{ File: '/tmp/dapHarness2-dFYSyf/warnFn2.m', Function: 'warnFn2', Line: 3 }], WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::EnterDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'ENTERED', suppressDebugOutput: false, wasCreatedInProcess: false }
        ]
    },
    continueExecution: { RequestId: '0x3b8c0x2045f9', filterTags: ['::MathWorks::ExecutionEvents::ContinueExecutionEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], wasCreatedInProcess: false },
    exitSession: { DebugNestLevel: 2, IdOfChangedIIP: '0x3b690x1fed1a', IsDebuggerActive: false, WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::ExitDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'EXITED', wasCreatedInProcess: false },
    exitSessionStillActive: { DebugNestLevel: 2, IdOfChangedIIP: '0x3b690x1fed1a', IsDebuggerActive: true, WhichLoop: 'DEBUG_PROMPT', filterTags: ['::MathWorks::ExecutionEvents::ExitDebuggerEvent', 'cmddistributor::DebugLoopEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], state: 'EXITED', wasCreatedInProcess: false },
    lasterrAtError: { requestID: '9tovgs6fw', result: ['Error using errFn (line 3)\nBoom 1', 'harness:boom'] },
    lasterrAtCaughtError: { requestID: 'cgjx277nl', result: ['Debug commands only allowed when stopped in debug mode.', 'MATLAB:dbOnlyInDebugMode'] },
    lastwarnAtWarning: { requestID: '6iy72jsle', result: ['careful', 'harness:warn'] },
    dbstopResult: { requestID: 'fxsrfvmoa', result: [] },
    badIdentifier: { error: { functionName: 'dbstop', id: 'MATLAB:badopt', msg: 'Unknown command option.', status: 'inRUNTIME_ERROR' }, requestID: 'pk48zrsy7' },
    dbclearAll: [
        { RequestId: '0x400c0x1fed1a', filterTags: ['::MathWorks::ExecutionEvents::DeleteProgramWideBreakpointEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], messageIdentifier: 'all', programWideTag: 2, wasCreatedInProcess: false },
        { RequestId: '0x400c0x1fed1a', filterTags: ['::MathWorks::ExecutionEvents::DeleteProgramWideBreakpointEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], messageIdentifier: 'all', programWideTag: 1, wasCreatedInProcess: false },
        { RequestId: '0x400c0x1fed1a', filterTags: ['::MathWorks::ExecutionEvents::DeleteProgramWideBreakpointEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], messageIdentifier: 'all', programWideTag: 0, wasCreatedInProcess: false }
    ],
    dbclearIdentifier: { RequestId: '0x40540x1fed1a', filterTags: ['::MathWorks::ExecutionEvents::DeleteProgramWideBreakpointEvent', 'foundation::msg_svc::eventmgr::BaseEvent'], messageIdentifier: 'other:id', programWideTag: 0, wasCreatedInProcess: false }
}

export default captured
