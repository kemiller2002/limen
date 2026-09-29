// The synthetic engine inside a dedicated worker, behind the package's worker host.
import { serveEngine } from "../../../dist/hosts/worker-engine.js";
import { createSyntheticEngine } from "./engine.js";

serveEngine(self, createSyntheticEngine);
