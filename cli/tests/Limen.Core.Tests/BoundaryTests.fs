module Limen.Core.Tests.BoundaryTests

open Xunit
open Limen.Core
open Limen.Core.Types

let private engine path content = Boundary.checkFile true path content
let private kernel path content = Boundary.checkFile false path content

[<Fact>]
let ``engine code that reaches for the DOM is a violation`` () =
    let problems = engine "src/engine/leak.ts" "export const f = () => document.title;"
    Assert.NotEmpty problems

[<Fact>]
let ``kernel code that reaches for the DOM is allowed`` () =
    // This is the whole point: the kernel is the one place that may.
    let problems = kernel "src/kernel/bridge.ts" "export const f = () => document.title;"
    Assert.Empty problems

[<Theory>]
[<InlineData("document")>]
[<InlineData("window")>]
[<InlineData("localStorage")>]
[<InlineData("sessionStorage")>]
let ``every forbidden browser capability is caught in engine code`` (token: string) =
    let problems = engine "src/engine/a.ts" (sprintf "const x = %s;" token)
    Assert.NotEmpty problems

[<Fact>]
let ``fetch is caught when called`` () =
    Assert.NotEmpty(engine "src/engine/a.ts" "const x = fetch(\"/y\");")

[<Theory>]
[<InlineData("history.pushState(null, \"\", \"/x\")")>]
[<InlineData("history.replaceState(null, \"\", \"/x\")")>]
[<InlineData("history.back()")>]
[<InlineData("location.href")>]
[<InlineData("location.assign(\"/x\")")>]
[<InlineData("location.pathname")>]
let ``engine code that drives the browser's history or URL is a violation`` (expression: string) =
    // The engine decides where the application is; it must ask for a Navigate
    // effect rather than moving the browser itself. Doing it directly is the
    // split-brain that capability exists to prevent.
    Assert.NotEmpty(engine "src/engine/a.ts" (sprintf "const x = %s;" expression))

[<Fact>]
let ``an engine reading Initialize's location is not a violation`` () =
    // `location` as an identifier is legitimate on the engine side: it is how
    // the opening URL arrives. Only the browser APIs are banned, which is why
    // the tokens are qualified rather than bare words.
    let source =
        "export const start = (message: Init) => screenFor(message.location);"
    Assert.Empty(engine "src/engine/a.ts" source)

[<Theory>]
[<InlineData("navigator.clipboard.writeText(\"x\")")>]
[<InlineData("document.execCommand(\"copy\")")>]
let ``engine code that reaches the clipboard is a violation`` (expression: string) =
    // The engine decides what to copy; asking the browser to do it is an
    // effect, so that a refusal becomes a modelled outcome instead of a
    // swallowed exception.
    Assert.NotEmpty(engine "src/engine/a.ts" (sprintf "const x = %s;" expression))

[<Fact>]
let ``an engine that merely says the word clipboard is not a violation`` () =
    // User-facing text is the engine's job. Only the API is banned.
    let source = "export const message = fun () -> reason;"
    Assert.Empty(engine "src/engine/a.ts" source)

[<Fact>]
let ``kernel code that drives history is allowed`` () =
    Assert.Empty(kernel "src/kernel/bridge.ts" "const x = history.pushState(null, \"\", \"/x\");")

[<Fact>]
let ``a comment mentioning the browser is not a violation`` () =
    // The legacy TypeScript checker fails this. A comment cannot reach the DOM,
    // and flagging prose trains people to ignore the tool.
    let problems =
        engine "src/engine/a.ts" "// the engine never touches document or window\nexport const f = (n: number) => n;"

    Assert.Empty problems

[<Fact>]
let ``a string literal mentioning the browser is not a violation`` () =
    Assert.Empty(engine "src/engine/a.ts" "export const label = \"document\";")

[<Fact>]
let ``a block comment mentioning the browser is not a violation`` () =
    Assert.Empty(engine "src/engine/a.ts" "/* uses no window at all */\nexport const f = (n: number) => n;")

[<Fact>]
let ``a word that merely contains a forbidden token is not a violation`` () =
    Assert.Empty(engine "src/engine/a.ts" "const documentation = 1; const windowWidth = 2;")

[<Fact>]
let ``the any escape hatch is caught in engine code`` () =
    Assert.NotEmpty(engine "src/engine/a.ts" "export const f = (x: any) => x;")

[<Fact>]
let ``a property named any is still caught but ordinary prose is not`` () =
    Assert.Empty(engine "src/engine/a.ts" "// callers may pass any number\nexport const f = (n: number) => n;")

[<Fact>]
let ``eval is an escape hatch on both sides of the boundary`` () =
    Assert.NotEmpty(kernel "src/kernel/a.ts" "const f = () => eval(\"1\");")
    Assert.NotEmpty(engine "src/engine/a.ts" "const f = () => eval(\"1\");")

[<Fact>]
let ``non-source files are not scanned`` () =
    Assert.Empty(engine "src/engine/notes.md" "document window any eval(")

[<Fact>]
let ``an escaped quote does not let a string swallow the rest of the file`` () =
    // If the scanner mishandled `\"`, the closing quote would be missed and the
    // real violation after it would be hidden inside a phantom string.
    let source = "const label = \"a\\\"b\";\nconst x = document.title;"
    Assert.NotEmpty(engine "src/engine/a.ts" source)

[<Fact>]
let ``violations name the file they came from`` () =
    match engine "src/engine/leak.ts" "const x = document;" with
    | [ BoundaryViolation (path, _) ] -> Assert.Equal("src/engine/leak.ts", path)
    | other -> failwithf "expected one violation naming the file, got %A" other
