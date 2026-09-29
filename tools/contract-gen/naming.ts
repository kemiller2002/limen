// How contract names become identifiers in each language. One set of rules,
// applied by every emitter, so "invalid-response" is InvalidResponse in F#, C#
// and Rust alike and "GET" is Get everywhere.

const pieces = (wire: string): readonly string[] => wire.split(/[^A-Za-z0-9]+/).filter((piece) => piece.length > 0);

// An all-caps piece ("GET") is treated as a word, not an acronym to preserve;
// otherwise Rust's naming lints reject it and languages would disagree.
const word = (piece: string): string =>
  /^[A-Z0-9]+$/.test(piece) && piece.length > 1
    ? piece.charAt(0) + piece.slice(1).toLowerCase()
    : piece.charAt(0).toUpperCase() + piece.slice(1);

export const pascal = (wire: string): string => pieces(wire).map(word).join("");

export const camel = (wire: string): string => {
  const name = pascal(wire);
  return name.charAt(0).toLowerCase() + name.slice(1);
};

export const snake = (wire: string): string =>
  pascal(wire).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();

// "limen.fixture.echo" → ["Limen", "Fixture", "Echo"]
export const unitSegments = (unit: string): readonly string[] => unit.split(".").map(pascal);

const RUST_KEYWORDS = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
  "move", "mut", "pub", "ref", "return", "self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "async",
  "await", "dyn", "abstract", "become", "box", "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try",
]);

export const rustField = (wire: string): string => {
  const name = snake(wire);
  return RUST_KEYWORDS.has(name) ? `r#${name}` : name;
};

// Characters that must be escaped inside a double-quoted string literal in
// F#, C# and Rust alike (contract names and fingerprints are ASCII).
export const quoted = (text: string): string => JSON.stringify(text);
