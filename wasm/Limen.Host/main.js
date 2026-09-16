// Required by the .NET wasm SDK as the module's own entry script. The Limen
// site does not use it — site/app/wasm-transport.ts loads the runtime itself,
// so that loading is part of EngineTransport.start() where the kernel already
// handles its failure.
