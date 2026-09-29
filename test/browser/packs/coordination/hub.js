// The SharedWorker relay the host serves for channels opened with via: "hub".
import { serveHub } from "../../../../dist/capabilities/coordination/hub.js";

serveHub(self);
