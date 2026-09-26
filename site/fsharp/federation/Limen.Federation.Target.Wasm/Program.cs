using System.Runtime.InteropServices.JavaScript;

return;

public partial class LimenFederationTargetWasm
{
    [JSExport]
    internal static string Manifest() =>
        Limen.Federation.Target.Engine.TargetModule.manifestJson();

    [JSExport]
    internal static string Initialize(string contextJson)
    {
        Limen.Federation.Target.Engine.TargetModule.initialize(contextJson);
        return "{}";
    }

    [JSExport]
    internal static string Restore(string snapshotJson)
    {
        Limen.Federation.Target.Engine.TargetModule.restore(snapshotJson);
        return "{}";
    }

    [JSExport]
    internal static string Activate()
    {
        Limen.Federation.Target.Engine.TargetModule.activate();
        return "{}";
    }

    [JSExport]
    internal static string Dispatch(string envelopeJson) =>
        Limen.Federation.Target.Engine.TargetModule.dispatch(envelopeJson);

    [JSExport]
    internal static string Suspend()
    {
        Limen.Federation.Target.Engine.TargetModule.suspend();
        return "{}";
    }

    [JSExport]
    internal static string Snapshot() =>
        Limen.Federation.Target.Engine.TargetModule.snapshotJson();

    [JSExport]
    internal static string Unload()
    {
        Limen.Federation.Target.Engine.TargetModule.unload();
        return "{}";
    }
}
