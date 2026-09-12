/* eslint-disable */
// Generated file. Do not edit by hand.
//
// Regenerate with:
//   matlab -batch "addpath('<repo>/server/build'); genOperatorHelp('/tmp/ops.json')"
//   node build/genOperatorHelp.js /tmp/ops.json
//
// MATLAB's `help` works on keywords and operators, not just functions. Measured
// on R2026a: help('end') 611 chars, help('.*') 880, help('\\') 918,
// help('~=') 1069, help('parfor') 1089, help('arguments') 921.
//
// Baking that into the server buys hover for every keyword and operator with no
// symbol resolution, no index, no variable-vs-function classification and no
// MATLAB round trip. It is therefore the one part of hover that works during the
// measured ~5.2 s cold start and while MATLAB is down entirely.
//
// Note that iskeyword() omits the context-sensitive block keywords (arguments,
// properties, methods, events, enumeration, import), which are among the most
// common things a MATLAB author hovers, so the generator adds them explicitly.
//
// Captured from MATLAB R2026a Update 5.

export interface OperatorHelpEntry {
    /** The operator or keyword itself, e.g. ".*" or "parfor". */
    topic: string
    /** True for language keywords, false for operators and punctuation. */
    isKeyword: boolean
    /** MATLAB's own help text, banner and openExample lines stripped. */
    text: string
}

const ENTRIES: OperatorHelpEntry[] = [
    { topic: "enumeration", isKeyword: true, text: "enumeration - Class enumeration members and names\n\n    Syntax\n      enumeration ClassName\n      enumeration(obj)\n      m = enumeration(___)\n      [m,s] = enumeration(___)\n\n    Input Arguments\n      ClassName - Enumeration class name\n        character vector | string\n      obj - Instance of enumeration class\n        object\n\n    Output Arguments\n      m - Enumeration members\n        column vector\n      s - Enumeration member names\n        cell array" },
    { topic: "persistent", isKeyword: true, text: " persistent - Define persistent variable\n\n    Syntax\n      persistent var1 ... varN" },
    { topic: "properties", isKeyword: true, text: "properties - Class property names\n\n    Syntax\n      properties(ClassName)\n      properties(obj)\n      p = properties(___)\n\n    Input Arguments\n      ClassName - Name of the class\n        character vector | string scalar\n      obj - MATLAB object\n        object\n\n    Output Arguments\n      p - Property names\n        cell array" },
    { topic: "arguments", isKeyword: true, text: "arguments - Declare function argument validation\n\n    Syntax\n      Input Argument Blocks\n        arguments ... end\n        arguments (Repeating) ... end\n\n      Output Argument Blocks\n        arguments (Output) ... end\n        arguments (Output,Repeating) ... end" },
    { topic: "otherwise", isKeyword: true, text: " otherwise - Execute one of several groups of statements\n\n    Syntax\n      switch switch_expression, case case_expression, end" },
    { topic: "classdef", isKeyword: true, text: " classdef - Class definition keywords\n\n    Syntax\n      classdef ... end" },
    { topic: "continue", isKeyword: true, text: " continue - Pass control to next iteration of for or while loop\n\n    Syntax\n      continue" },
    { topic: "function", isKeyword: true, text: " function - Declare function name, inputs, and outputs\n\n    Syntax\n      function [y1,...,yN] = myfun(x1,...,xM)" },
    { topic: "methods", isKeyword: true, text: "methods - Class method names\n\n    Syntax\n      methods ClassName\n      methods(obj)\n      methods(___,'-full')\n      m = methods(___)\n\n    Input Arguments\n      ClassName - Class name\n        character vector | string scalar\n      '-full' - Display full description\n        '-full'\n\n    Output Arguments\n      m - Method names\n        cell array" },
    { topic: "elseif", isKeyword: true, text: " elseif - Execute statements if condition is true\n\n    Syntax\n      if expression, statements, end" },
    { topic: "events", isKeyword: true, text: "events - Event names\n\n    Syntax\n      events(ClassName)\n      events(obj)\n      e = events(___)\n\n    Input Arguments\n      ClassName - Class name\n        character vector | string scalar\n      obj - Object\n        MATLAB object\n\n    Output Arguments\n      e - Event names\n        cell array" },
    { topic: "global", isKeyword: true, text: "GLOBAL Define global variable.\n    GLOBAL X Y Z defines X, Y, and Z as global in scope.\n \n    Ordinarily, each MATLAB function has its\n    own local variables, which are separate from those of other functions,\n    and from those of the base workspace.  However, if several functions, \n    and possibly the base workspace, all declare a particular name as \n    GLOBAL, then they all share a single copy of that variable.  Any \n    assignment to that variable, in any function, is available to all the \n    other functions declaring it GLOBAL.\n \n    If the global variable doesn't exist the first time you issue\n    the GLOBAL statement, it will be initialized to the empty matrix.\n \n    If a variable with the same name as the global variable already exists\n    in the current workspace, MATLAB issues a warning and changes the\n    value of that variable to match the global.\n \n    Stylistically, global variables often have long names with all\n    capital letters, but this is not required.\n \n    See also CLEAR, CLEARVARS, WHO, PERSISTENT." },
    { topic: "import", isKeyword: true, text: "import - Add namespace, class, or functions to current import list\n\n    Syntax\n      import Namespace.ClassName\n      import Namespace.FunctionName\n      import Namespace.ClassName.staticMethodName\n      import Namespace.*\n\n      import\n      L = import\n\n    Input Arguments\n      Namespace - Namespace identifier\n        string | character vector\n      ClassName - Name of class\n        string | character vector\n      FunctionName - Name of namespace function\n        string | character vector\n      staticMethodName - Name of static method\n        string | character vector\n\n    Output Arguments\n      L - Import list\n        cell array of character vectors" },
    { topic: "parfor", isKeyword: true, text: " parfor - Parallel for-loop\n\n    Syntax\n      parfor loopVar = initVal:endVal; statements; end\n      parfor loopVar = initVal:step:endVal; statements;end\n\n      parfor(loopVar = initVal:endVal); statements; end\n      parfor(loopVar = initVal:step:endVal); statements; end\n      parfor(___,M); statements; end\n\n    Input Arguments\n      loopVar - Loop index\n        integer\n      initVal - Initial value of loop index\n        integer\n      endVal - Final value of loop index\n        integer\n      step - Step size of loop index\n        1 | -1\n      statements - Loop body\n        text\n      M - Maximum number of workers running in parallel\n        number of workers in the parallel pool (default) |\n        nonnegative integer" },
    { topic: "return", isKeyword: true, text: " return - Return control to invoking script or function\n\n    Syntax\n      return" },
    { topic: "switch", isKeyword: true, text: " switch - Execute one of several groups of statements\n\n    Syntax\n      switch switch_expression, case case_expression, end" },
    { topic: "break", isKeyword: true, text: " break - Terminate execution of for or while loop\n\n    Syntax\n      break" },
    { topic: "catch", isKeyword: true, text: " catch - Execute statements and catch resulting errors\n\n    Syntax\n      try statements, catch statements end" },
    { topic: "while", isKeyword: true, text: " while - while loop to repeat when condition is true\n\n    Syntax\n      while expression, statements, end" },
    { topic: "case", isKeyword: true, text: " case - Execute one of several groups of statements\n\n    Syntax\n      switch switch_expression, case case_expression, end" },
    { topic: "else", isKeyword: true, text: " else - Execute statements if condition is true\n\n    Syntax\n      if expression, statements, end" },
    { topic: "spmd", isKeyword: true, text: "spmd is an undocumented builtin function." },
    { topic: "...", isKeyword: false, text: " ... Line continuation\n\n    Syntax\n      ..." },
    { topic: "end", isKeyword: true, text: " end - Terminate block of code or indicate last array index\n\n    Syntax\n      end\n      end\n      end" },
    { topic: "for", isKeyword: true, text: " for - for loop to repeat specified number of times\n\n    Syntax\n      for index = values, statements, end" },
    { topic: "try", isKeyword: true, text: " try - Execute statements and catch resulting errors\n\n    Syntax\n      try statements, catch statements end" },
    { topic: ".'", isKeyword: false, text: ".' Transpose vector or matrix\n\n    Syntax\n      B = A.'\n      B = transpose(A)\n\n    Input Arguments\n      A - Input array\n        vector | matrix" },
    { topic: ".*", isKeyword: false, text: ".* Multiplication\n\n    Syntax\n      C = A.*B\n      C = times(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "./", isKeyword: false, text: "./ Right array division\n\n    Syntax\n      x = A./B\n      x = rdivide(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: ".\\", isKeyword: false, text: ".\\ Left array division\n\n    Syntax\n      x = B.\\A\n      x = ldivide(B,A)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: ".^", isKeyword: false, text: ".^ Element-wise power\n\n    Syntax\n      C = A.^B\n      C = power(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "()", isKeyword: false, text: " () Command grouping, indexing\n\n    Syntax\n      ()" },
    { topic: "[]", isKeyword: false, text: " [] Array creation and concatenation, element deletion, argument assignment\n\n    Syntax\n      []" },
    { topic: "{}", isKeyword: false, text: " {} Cell array creation, indexing\n\n    Syntax\n      {}" },
    { topic: "&&", isKeyword: false, text: "&& Logical AND with short-circuiting\n\n    Syntax\n      expr1 && expr2\n\n    Input Arguments\n      expr1 - Logical expressions\n        logical scalars\n      expr2 - Logical expressions\n        logical scalars" },
    { topic: "<=", isKeyword: false, text: "<= Determine less than or equal to\n\n    Syntax\n      A <= B\n      le(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "==", isKeyword: false, text: "== Determine equality\n\n    Syntax\n      A == B\n      eq(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: ">=", isKeyword: false, text: ">= Determine greater than or equal to\n\n    Syntax\n      A >= B\n      ge(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "||", isKeyword: false, text: "|| Logical OR with short-circuiting\n\n    Syntax\n      expr1 || expr2\n\n    Input Arguments\n      expr1 - Logical expressions\n        logical scalars\n      expr2 - Logical expressions\n        logical scalars" },
    { topic: "~=", isKeyword: false, text: "~= Determine inequality\n\n    Syntax\n      A ~= B\n      ne(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "if", isKeyword: true, text: " if - Execute statements if condition is true\n\n    Syntax\n      if expression, statements, end" },
    { topic: "-", isKeyword: false, text: "- Subtraction\n\n    Syntax\n      C = A - B\n      C = minus(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: ":", isKeyword: false, text: ": Vector creation, array subscripting, and for-loop iteration\n    The colon is one of the most useful operators in MATLAB.\n\n    Syntax\n      x = j:k\n      x = j:i:k\n      x = colon(j,k)\n      x = colon(j,i,k)\n      A(:,n)\n      A(m,:)\n      A(:)\n      A(j:k)\n\n    Input Arguments\n      j - Starting vector value\n        scalar\n      k - Ending vector value\n        scalar\n      i - Increment between vector elements\n        1 (default) | scalar\n\n    Output Arguments\n      x - Regularly-spaced vector\n        row vector" },
    { topic: ".", isKeyword: false, text: " . Decimal point, element-wise operations, indexing\n\n    Syntax\n      ." },
    { topic: "'", isKeyword: false, text: "' Complex conjugate transpose\n\n    Syntax\n      B = A'\n      B = ctranspose(A)\n\n    Input Arguments\n      A - Input array\n        vector | matrix" },
    { topic: "@", isKeyword: false, text: " @ Create anonymous functions and function handles, call superclass methods\n\n    Syntax\n      @" },
    { topic: "*", isKeyword: false, text: "* Matrix multiplication\n\n    Syntax\n      C = A*B\n      C = mtimes(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices\n      B - Operands\n        scalars | vectors | matrices\n\n    Output Arguments\n      C - Product\n        scalar | vector | matrix" },
    { topic: "/", isKeyword: false, text: "/ Solve systems of linear equations xA = B for x\n\n    Syntax\n      x = B/A\n      x = mrdivide(B,A)\n\n    Input Arguments\n      A - Operands\n        vectors | full matrices | sparse matrices\n      B - Operands\n        vectors | full matrices | sparse matrices\n\n    Output Arguments\n      x - Solution\n        vector | full matrix | sparse matrix" },
    { topic: "\\", isKeyword: false, text: "\\ Solve systems of linear equations Ax = B for x\n\n    Syntax\n      x = A\\B\n      x = mldivide(A,B)\n\n    Input Arguments\n      A - Operands\n        vectors | full matrices | sparse matrices\n      B - Operands\n        vectors | full matrices | sparse matrices\n\n    Output Arguments\n      x - Solution\n        vector | full matrix | sparse matrix" },
    { topic: "&", isKeyword: false, text: "& Find logical AND\n\n    Syntax\n      A & B\n      and(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "^", isKeyword: false, text: "^ Matrix power\n\n    Syntax\n      C = A^B\n      C = mpower(A,B)\n\n    Input Arguments\n      A - Operands\n        scalar | matrix\n      B - Operands\n        scalar | matrix" },
    { topic: "+", isKeyword: false, text: "+ Add numbers, append strings\n\n    Syntax\n      C = A + B\n      C = plus(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "<", isKeyword: false, text: "< Determine less than\n\n    Syntax\n      A < B\n      lt(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "=", isKeyword: false, text: " = Variable creation and indexed assignment\n\n    Syntax\n      B = A\n      B(i,j,...) = A" },
    { topic: ">", isKeyword: false, text: "> Determine greater than\n\n    Syntax\n      A > B\n      gt(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "|", isKeyword: false, text: "| Find logical OR\n\n    Syntax\n      A | B\n      or(A,B)\n\n    Input Arguments\n      A - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables\n      B - Operands\n        scalars | vectors | matrices | multidimensional arrays | tables |\n        timetables" },
    { topic: "~", isKeyword: false, text: "~ Find logical NOT\n\n    Syntax\n      ~A\n      not(A)\n\n    Input Arguments\n      A - Input array\n        scalar | vector | matrix | multidimensional array | table |\n        timetable" }
]

const BY_TOPIC = new Map<string, OperatorHelpEntry>(ENTRIES.map(e => [e.topic, e]))

/**
 * Operators sorted longest-first, so a scan finds ".*" before "*" and "..."
 * before ".".
 */
const OPERATORS_LONGEST_FIRST: string[] = ENTRIES
    .filter(e => !e.isKeyword)
    .map(e => e.topic)
    .sort((a, b) => b.length - a.length)

/**
 * Looks up help for an exact keyword or operator.
 *
 * @param topic The keyword or operator
 * @returns The entry, or null if the topic is not a known keyword or operator
 */
export function getOperatorHelp (topic: string): OperatorHelpEntry | null {
    return BY_TOPIC.get(topic) ?? null
}

/**
 * Finds the operator token straddling a character position in a line.
 *
 * Only punctuation operators are considered; keywords are words and are found by
 * the identifier scan instead. Longest match wins, so `a .* b` with the cursor
 * on the `*` resolves to ".*" rather than "*".
 *
 * @param lineText The full text of the line
 * @param character The 0-based character offset in that line
 * @returns The matched operator and its half-open [start, end) range, or null
 */
export function findOperatorAtPosition (
    lineText: string, character: number
): { topic: string, start: number, end: number } | null {
    for (const op of OPERATORS_LONGEST_FIRST) {
        // A cursor at index i should match an operator occupying
        // [i - len + 1, i + len].
        const searchStart = Math.max(0, character - op.length + 1)
        const searchEnd = Math.min(lineText.length, character + op.length)
        const window = lineText.slice(searchStart, searchEnd)
        let idx = window.indexOf(op)
        while (idx !== -1) {
            const start = searchStart + idx
            const end = start + op.length
            if (start <= character && character < end) {
                return { topic: op, start, end }
            }
            idx = window.indexOf(op, idx + 1)
        }
    }
    return null
}

/** Every keyword and operator with bundled help. Exposed for tests. */
export function getAllTopics (): string[] {
    return ENTRIES.map(e => e.topic)
}
