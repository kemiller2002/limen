# Negative fixtures: the restricted TypeScript subset

Every file here except `clean.ts` deliberately breaks one rule of
`architecture/typescript-boundary.json`, and `test/typescript-boundary.test.ts`
asserts the checker rejects it with that rule. They are never compiled by any
tsconfig and never imported by application code. `allowed/` is the one place
`@ts-expect-error` is permitted — for negative tests that need it.
