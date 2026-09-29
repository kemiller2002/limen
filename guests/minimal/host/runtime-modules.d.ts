// The .NET runtime loaders are fetched at run time from the published engine
// directories; to the type checker they are untyped modules, narrowed by
// DotnetWasmTransport before use.
declare module "*/_framework/dotnet.js" {
  const runtime: unknown;
  export default runtime;
}
