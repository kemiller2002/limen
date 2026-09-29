// The restricted handwritten-TypeScript subset (kemiller2002/limen#54),
// checked with the TypeScript compiler API rather than text matching, so a
// rule sees syntax and types — not words in comments.
//
// TypeScript here is browser mechanism: decode a legal request, call a browser
// API, classify what happened, encode a legal outcome. Every rule below closes
// an escape hatch through which it could become something else.

import ts from "typescript";
import { matches } from "./layers.ts";

export type Rule =
  | "any-type"
  | "suppression-directive"
  | "script-execution"
  | "html-injection-sink"
  | "double-assertion"
  | "assertion-bypasses-decoder"
  | "duplicate-protocol-type"
  | "untyped-capability-dispatch"
  | "dynamic-dispatch"
  | "non-exhaustive-union"
  | "browser-object-in-message";

export type Finding = { readonly rule: Rule; readonly path: string; readonly line: number; readonly detail: string };

export type BoundaryConfig = {
  readonly files: readonly string[];
  readonly expectErrorAllowed: readonly string[];
  readonly sanctioned: readonly { readonly path: string; readonly rule: Rule; readonly reason: string }[];
  readonly knownDebt: readonly { readonly path: string; readonly rule: Rule; readonly count: number; readonly workItem: string; readonly reason: string }[];
  readonly protocolTypeNames: readonly string[];
  // Registered contract-gen outputs. Only these are treated as generated: the
  // marker comment alone proves nothing, and pasting it into a handwritten
  // file must not exempt that file.
  readonly generatedPaths: readonly string[];
};

export const REMEDIES: Readonly<Record<Rule, string>> = {
  "any-type": "Use `unknown` and narrow it, or the generated contract type.",
  "suppression-directive": "Fix the type error. @ts-expect-error is allowed only in designated negative-test fixtures.",
  "script-execution": "Limen never executes strings as code. Express the behavior as data the engine projects or an effect the kernel performs.",
  "html-injection-sink": "Bind text with textContent (data-text) and attributes with data-bind-*; never assign HTML.",
  "double-assertion": "`as unknown as T` bypasses the type system. Decode with the generated decoder, or narrow with a type guard.",
  "assertion-bypasses-decoder": "Parsed JSON is untrusted: pass it through the generated decoder (./contract) instead of asserting its type.",
  "duplicate-protocol-type": "Import the generated contract type; never redeclare a wire shape by hand.",
  "untyped-capability-dispatch": "Capability requests are closed generated unions decoded by defineCapability, not string operations or untyped payloads.",
  "dynamic-dispatch": "Call a named function or switch exhaustively over a generated union; a computed member call is an untyped escape hatch.",
  "non-exhaustive-union": "Handle every variant, or end the switch with `default: return assertNever(value)` so a new variant is a compile error.",
  "browser-object-in-message": "A capability's result and facts are serializable contract values. Send a serialized value or an opaque handle id, never a DOM node, File, stream or other browser object.",
};

const isAssertion = (node: ts.Node): node is ts.AsExpression | ts.TypeAssertion => ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node;

const isConstAssertion = (node: ts.AsExpression | ts.TypeAssertion): boolean =>
  ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "const";

const isUnknownType = (type: ts.TypeNode): boolean => type.kind === ts.SyntaxKind.UnknownKeyword;

const isJsonParse = (node: ts.Expression): boolean =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
  && node.expression.expression.text === "JSON" && node.expression.name.text === "parse";

const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment", "srcdoc"]);
const UNTYPED_PAYLOAD_NAMES = new Set(["payload", "request", "fact", "result"]);

const isUntypedPayload = (type: ts.TypeNode | undefined): boolean =>
  type !== undefined && (type.kind === ts.SyntaxKind.UnknownKeyword || type.kind === ts.SyntaxKind.ObjectKeyword
    || (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && ["Record", "Object"].includes(type.typeName.text)));

// A switch over a union of literals is exhaustive when every literal has a
// case, or when its default hands the value to a function taking `never`.
const exhaustivenessProblem = (checker: ts.TypeChecker, node: ts.SwitchStatement): string | undefined => {
  const type = checker.getTypeAtLocation(node.expression);
  const members = type.isUnion() ? type.types : [type];
  const literals = members.filter((member) => member.isStringLiteral() || member.isNumberLiteral() || (member.flags & ts.TypeFlags.BooleanLiteral) !== 0);
  if (literals.length === 0 || literals.length !== members.length || members.length < 2) return undefined;
  const clauses = node.caseBlock.clauses;
  const defaultClause = clauses.find(ts.isDefaultClause);
  if (defaultClause !== undefined) {
    const handsToNever = (candidate: ts.Node): boolean =>
      (ts.isCallExpression(candidate) && (() => {
        const signature = checker.getResolvedSignature(candidate);
        const parameter = signature?.getParameters()[0];
        return parameter !== undefined && (checker.getTypeOfSymbolAtLocation(parameter, candidate).flags & ts.TypeFlags.Never) !== 0;
      })()) || ts.forEachChild(candidate, handsToNever) === true;
    return handsToNever(defaultClause) ? undefined : "its default branch accepts any future variant silently instead of passing the value to a `never`-typed function";
  }
  const covered = new Set(clauses.flatMap((clause) => (ts.isCaseClause(clause) ? [checker.typeToString(checker.getTypeAtLocation(clause.expression))] : [])));
  const missing = literals.map((literal) => checker.typeToString(literal)).filter((name) => !covered.has(name));
  return missing.length === 0 ? undefined : `no case for ${missing.join(", ")}`;
};

// The names of browser runtime types reachable from a message type: any object
// type declared in a DOM or web-worker lib file.
const browserObjectIn = (checker: ts.TypeChecker, type: ts.Type, seen: ReadonlySet<ts.Type>, depth: number): readonly string[] => {
  if (seen.has(type) || depth > 8) return [];
  const next = new Set([...seen, type]);
  if (type.isUnionOrIntersection()) return type.types.flatMap((member) => browserObjectIn(checker, member, next, depth + 1));
  const declarations = (type.getSymbol() ?? type.aliasSymbol)?.getDeclarations() ?? [];
  if (declarations.some((declaration) => /lib\.(dom|webworker)[\w.]*\.d\.ts$/.test(declaration.getSourceFile().fileName))) return [checker.typeToString(type)];
  const typeArguments = checker.getTypeArguments(type as ts.TypeReference) ?? [];
  const properties = (type.flags & ts.TypeFlags.Object) !== 0 ? checker.getPropertiesOfType(type) : [];
  const anyDeclaration = declarations[0];
  return [
    ...typeArguments.flatMap((argument) => browserObjectIn(checker, argument, next, depth + 1)),
    ...(anyDeclaration === undefined && properties.length === 0 ? [] : properties.flatMap((property) => {
      const location = property.valueDeclaration ?? anyDeclaration;
      return location === undefined ? [] : browserObjectIn(checker, checker.getTypeOfSymbolAtLocation(property, location), next, depth + 1);
    })),
  ];
};

const findingsIn = (source: ts.SourceFile, checker: ts.TypeChecker, path: string, config: BoundaryConfig): readonly Finding[] => {
  const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const finding = (rule: Rule, node: ts.Node, detail: string): Finding => ({ rule, path, line: at(node), detail });
  const when = (condition: boolean, make: () => Finding): readonly Finding[] => (condition ? [make()] : []);

  // Directives live in comments, so they are found in the raw text.
  const text = source.getFullText();
  const directives = Array.from(text.matchAll(/@ts-(ignore|nocheck|expect-error)\b/g))
    .filter((match) => !(match[1] === "expect-error" && config.expectErrorAllowed.some((glob) => matches(glob, path))))
    .map((match): Finding => ({ rule: "suppression-directive", path, line: text.slice(0, match.index).split("\n").length, detail: `@ts-${match[1]}` }));

  const calls = (node: ts.Node): readonly Finding[] => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return [];
    // Look through `!` and parentheses: `handlers[name]!(…)` is still a computed call.
    const callee = unwrap(node.expression);
    const first = node.arguments?.[0];
    return [
      ...when(ts.isIdentifier(callee) && (callee.text === "eval" || callee.text === "Function"), () => finding("script-execution", node, `${callee.getText(source)}(…)`)),
      ...when(ts.isIdentifier(callee) && ["setTimeout", "setInterval"].includes(callee.text) && first !== undefined
        && (ts.isStringLiteral(first) || ts.isTemplateExpression(first) || ts.isNoSubstitutionTemplateLiteral(first)), () => finding("script-execution", node, `${callee.getText(source)} with a string body`)),
      ...when(ts.isCallExpression(node) && ts.isElementAccessExpression(callee) && !ts.isStringLiteralLike(callee.argumentExpression) && !ts.isNumericLiteral(callee.argumentExpression),
        () => finding("dynamic-dispatch", node, "call through a computed member")),
    ];
  };

  const sinks = (node: ts.Node): readonly Finding[] => [
    ...when(ts.isPropertyAccessExpression(node) && HTML_SINKS.has(node.name.text), () => finding("html-injection-sink", node, `.${(node as ts.PropertyAccessExpression).name.text}`)),
    ...when(ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "document" && ["write", "writeln"].includes(node.name.text),
      () => finding("html-injection-sink", node, node.getText(source))),
  ];

  const assertions = (node: ts.Node): readonly Finding[] => {
    if (!isAssertion(node) || isConstAssertion(node)) return [];
    const inner = unwrap(node.expression);
    return [
      ...when(isAssertion(inner) && !isConstAssertion(inner), () => finding("double-assertion", node, "an assertion of an assertion")),
      ...when(isJsonParse(inner) && !isUnknownType(node.type), () => finding("assertion-bypasses-decoder", node, `JSON.parse(…) asserted as ${node.type.getText(source)}`)),
    ];
  };

  const declarations = (node: ts.Node): readonly Finding[] => [
    ...when((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && config.protocolTypeNames.includes(node.name.text),
      () => finding("duplicate-protocol-type", node, `declares ${(node as ts.TypeAliasDeclaration).name.text}, which the contract generates`)),
    ...((ts.isPropertySignature(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)
      ? [
        ...when(node.name.text === "operation" && node.type?.kind === ts.SyntaxKind.StringKeyword, () => finding("untyped-capability-dispatch", node, "`operation: string`")),
        ...when(UNTYPED_PAYLOAD_NAMES.has(node.name.text) && isUntypedPayload(node.type), () => finding("untyped-capability-dispatch", node, `\`${node.name.getText(source)}\` typed ${node.type?.getText(source) ?? "?"}`)),
      ]
      : []),
  ];

  const switches = (node: ts.Node): readonly Finding[] => {
    if (!ts.isSwitchStatement(node)) return [];
    const problem = exhaustivenessProblem(checker, node);
    return when(problem !== undefined, () => finding("non-exhaustive-union", node, `switch (${node.expression.getText(source)}): ${problem ?? ""}`));
  };

  // defineCapability({ execute, activate }): the awaited result of execute and
  // the fact type of activate's emitFact must be free of browser objects.
  const messages = (node: ts.Node): readonly Finding[] => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "defineCapability") return [];
    const definition = node.arguments[0];
    if (definition === undefined || !ts.isObjectLiteralExpression(definition)) return [];
    const property = (name: string): ts.Node | undefined => definition.properties.find((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name);
    const execute = property("execute");
    const executeType = execute === undefined ? undefined : checker.getTypeAtLocation(execute);
    const returned = executeType?.getCallSignatures()[0]?.getReturnType();
    const result = returned === undefined ? undefined : checker.getAwaitedType(returned) ?? returned;
    // activate(host) — the fact type is emitFact's parameter.
    const activate = property("activate");
    const host = activate === undefined ? undefined : checker.getTypeAtLocation(activate).getCallSignatures()[0]?.getParameters()[0];
    const hostType = host === undefined || activate === undefined ? undefined : checker.getTypeOfSymbolAtLocation(host, activate);
    const emitFact = hostType?.getProperty("emitFact");
    const emitFactType = emitFact === undefined || activate === undefined ? undefined : checker.getTypeOfSymbolAtLocation(emitFact, activate);
    const factSymbol = emitFactType?.getCallSignatures()[0]?.getParameters()[0];
    const fact = factSymbol === undefined || activate === undefined ? undefined : checker.getTypeOfSymbolAtLocation(factSymbol, activate);
    const offending = [result, fact].flatMap((type) => (type === undefined ? [] : browserObjectIn(checker, type, new Set(), 0)));
    return offending.map((name) => finding("browser-object-in-message", node, `a capability message carries the browser object ${name}`));
  };

  const collect = (node: ts.Node): readonly Finding[] => [
    ...when(node.kind === ts.SyntaxKind.AnyKeyword, () => finding("any-type", node, "`any` type")),
    ...calls(node),
    ...sinks(node),
    ...assertions(node),
    ...declarations(node),
    ...switches(node),
    ...messages(node),
    ...node.getChildren(source).flatMap(collect),
  ];

  return [...directives, ...collect(source)];
};

export type Outcome = {
  readonly findings: readonly Finding[];
  // Debt entries whose count no longer matches: fewer means the debt was paid
  // and the entry must shrink (the ratchet only tightens); more is a violation.
  readonly staleDebt: readonly { readonly path: string; readonly rule: Rule; readonly declared: number; readonly actual: number }[];
};

export const checkProgram = (program: ts.Program, rootDirectory: string, config: BoundaryConfig): Outcome => {
  const checker = program.getTypeChecker();
  const relativePath = (fileName: string): string => fileName.startsWith(`${rootDirectory}/`) ? fileName.slice(rootDirectory.length + 1) : fileName;
  const all = program.getSourceFiles()
    .map((source) => ({ source, path: relativePath(source.fileName) }))
    .filter(({ path }) => config.files.some((glob) => matches(glob, path)) && !config.generatedPaths.includes(path))
    .flatMap(({ source, path }) => findingsIn(source, checker, path, config))
    .filter((finding) => !config.sanctioned.some((entry) => entry.path === finding.path && entry.rule === finding.rule));
  const debtKey = (path: string, rule: Rule): string => `${path}\u0000${rule}`;
  const counts = all.reduce((map, finding) => map.set(debtKey(finding.path, finding.rule), (map.get(debtKey(finding.path, finding.rule)) ?? 0) + 1), new Map<string, number>());
  const staleDebt = config.knownDebt
    .map((entry) => ({ path: entry.path, rule: entry.rule, declared: entry.count, actual: counts.get(debtKey(entry.path, entry.rule)) ?? 0 }))
    .filter((entry) => entry.actual !== entry.declared);
  const covered = new Set(config.knownDebt.filter((entry) => (counts.get(debtKey(entry.path, entry.rule)) ?? 0) === entry.count).map((entry) => debtKey(entry.path, entry.rule)));
  return { findings: all.filter((finding) => !covered.has(debtKey(finding.path, finding.rule))), staleDebt };
};

export const describeFinding = (finding: Finding): string =>
  `[${finding.rule}] ${finding.path}:${finding.line}: ${finding.detail}\n    → ${REMEDIES[finding.rule]}`;
