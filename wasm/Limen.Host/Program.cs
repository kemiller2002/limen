namespace Limen.Host;

/// <summary>
/// The wasm module needs an entry point; the engine needs no start-up work.
/// Everything happens through <see cref="Interop.Dispatch"/>.
/// </summary>
public static class Program
{
    public static void Main() { }
}
