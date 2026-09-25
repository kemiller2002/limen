using System.Runtime.InteropServices.JavaScript;

return;

public partial class LimenFederationSourceWasm
{
    [JSExport]
    internal static string Manifest() =>
        Limen.Federation.Source.Engine.SourceModule.manifestJson();

    [JSExport]
    internal static string Initialize(string contextJson)
    {
        Limen.Federation.Source.Engine.SourceModule.initialize(contextJson);
        return "{}";
    }

    [JSExport]
    internal static string Restore(string snapshotJson)
    {
        Limen.Federation.Source.Engine.SourceModule.restore(snapshotJson);
        return "{}";
    }

    [JSExport]
    internal static string Activate()
    {
        Limen.Federation.Source.Engine.SourceModule.activate();
        return "{}";
    }

    [JSExport]
    internal static string Dispatch(string envelopeJson) =>
        Limen.Federation.Source.Engine.SourceModule.dispatch(envelopeJson);

    [JSExport]
    internal static string Suspend()
    {
        Limen.Federation.Source.Engine.SourceModule.suspend();
        return "{}";
    }

    [JSExport]
    internal static string Snapshot() =>
        Limen.Federation.Source.Engine.SourceModule.snapshotJson();

    [JSExport]
    internal static string Unload()
    {
        Limen.Federation.Source.Engine.SourceModule.unload();
        return "{}";
    }

    [JSExport]
    internal static string BeginTransition() =>
        Limen.Federation.Source.Engine.SourceModule.beginTransition();
}
