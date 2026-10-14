// Validates the emitted evidence against the canonical schema, copied verbatim
// from kemiller2002/visual-engineering@8da8fbc
// framework/contracts/ui-conformance.schema.json (standardVersion 1.0.0).
// Exit 1 on a schema violation or when any surface or action is "fail".
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const read = path => JSON.parse(readFileSync(path, "utf8"));
const evidencePath = process.argv[2] ?? new URL("./test-results/evidence.json", import.meta.url);
const schema = read(new URL("./ui-conformance.schema.json", import.meta.url));
const evidence = read(evidencePath);

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const schemaErrors = validate(evidence) ? [] : validate.errors.map(error => `${error.instancePath || "/"} ${error.message}`);
const failing = evidence.surfaces.flatMap(surface => [
  ...(surface.status === "fail" ? [`surface ${surface.id}`] : []),
  ...surface.actions.filter(action => action.status === "fail").map(action => `action ${surface.id}/${action.id}`)
]);

schemaErrors.forEach(message => console.error(`schema: ${message}`));
failing.forEach(message => console.error(`FAIL: ${message}`));
console.log(`evidence.json: ${schemaErrors.length === 0 ? "valid" : "INVALID"} against ui-conformance.schema.json; ${evidence.surfaces.length} surfaces, ${failing.length} failing items`);
process.exitCode = schemaErrors.length > 0 || failing.length > 0 ? 1 : 0;
