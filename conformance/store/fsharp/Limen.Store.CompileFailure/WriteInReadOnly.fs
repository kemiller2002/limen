module WriteInReadOnly

open Limen.Store

type Entry = { Id: string }

let entry : Codec<Entry> =
    Codec.record (fun e -> Codec.fields [ Codec.field "id" Codec.string e.Id ]) (fun fields -> Codec.required "id" Codec.string fields |> Result.map (fun id -> { Id = id }))

// A put is Op<ReadWrite>; a readonly transaction takes Op<ReadOnly>. This
// line is the point of the fixture: it must not compile.
let wrong = Transaction.readOnly "db" [ Op.get "entries" (Key.Text "a"); Op.put "entries" entry { Id = "a" } ]
