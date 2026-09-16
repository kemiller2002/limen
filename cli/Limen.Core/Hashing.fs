/// Content hashing.
///
/// Hashes are how the tool tells "this file is as I wrote it" from "a human
/// changed it". That distinction decides whether an upgrade may rewrite a file,
/// so it must not be sensitive to things a human did not actually change —
/// notably line endings, which git rewrites on Windows checkouts.
module Limen.Core.Hashing

open System
open System.Security.Cryptography
open System.Text

/// Normalize line endings before hashing.
///
/// Without this, a repository cloned with `core.autocrlf=true` would report
/// every tool-owned file as locally modified and block its own upgrade.
let normalizeContent (content: string) =
    content.Replace("\r\n", "\n").Replace("\r", "\n")

let sha256OfString (content: string) =
    let bytes = Encoding.UTF8.GetBytes(normalizeContent content)
    Convert.ToHexString(SHA256.HashData bytes).ToLowerInvariant()
