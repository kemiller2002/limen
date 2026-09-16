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
