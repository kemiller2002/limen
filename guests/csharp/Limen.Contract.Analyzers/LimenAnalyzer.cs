using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Limen.Contract.Analyzers;

/// <summary>
/// The C# compiler cannot prove a switch over a closed record hierarchy
/// exhaustive, so a `default`/`_` arm that silently accepts a future variant
/// always compiles. Generated Limen unions and enums carry [ClosedUnion] and a
/// generated Match whose parameters are one handler per variant; these rules
/// make Match the only way to branch on them, and close the untyped escape
/// hatches the contract exists to remove.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class LimenAnalyzer : DiagnosticAnalyzer
{
    public static readonly DiagnosticDescriptor SwitchOnClosedUnion = new(
        "LIMEN001",
        "Branch on a Limen contract union with its generated Match",
        "'{0}' is a closed Limen contract type; a switch over it compiles even when a variant is missing. Use {0}.Match(…) so a new variant is a compile error.",
        "Limen.Contract",
        DiagnosticSeverity.Error,
        isEnabledByDefault: true);

    public static readonly DiagnosticDescriptor DynamicEscapeHatch = new(
        "LIMEN002",
        "No untyped escape hatch at the Limen boundary",
        "'{0}' is an untyped escape hatch; Limen messages are generated closed types. Decode with the generated Codec and handle the typed value.",
        "Limen.Contract",
        DiagnosticSeverity.Error,
        isEnabledByDefault: true);

    public static readonly DiagnosticDescriptor WirePlumbing = new(
        "LIMEN003",
        "Generated wire plumbing is not an application API",
        "'{0}' is generated wire plumbing. Use the generated Codec.Parse…/Serialize… and typed values instead.",
        "Limen.Contract",
        DiagnosticSeverity.Error,
        isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(SwitchOnClosedUnion, DynamicEscapeHatch, WirePlumbing);

    public override void Initialize(AnalysisContext context)
    {
        // Generated code is exempt: it is checked by contract:check, and the
        // generated Match itself is the one place a switch is correct.
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeSwitchStatement, SyntaxKind.SwitchStatement);
        context.RegisterSyntaxNodeAction(AnalyzeSwitchExpression, SyntaxKind.SwitchExpression);
        context.RegisterSyntaxNodeAction(AnalyzeDynamic, SyntaxKind.IdentifierName);
        context.RegisterSyntaxNodeAction(AnalyzeGeneric, SyntaxKind.GenericName);
        context.RegisterSyntaxNodeAction(AnalyzeMemberAccess, SyntaxKind.SimpleMemberAccessExpression);
    }

    private static bool IsClosedUnion(ITypeSymbol? type) =>
        type is not null && (type.GetAttributes().Any(IsClosedUnionAttribute) || (type.BaseType is { } baseType && baseType.GetAttributes().Any(IsClosedUnionAttribute)));

    private static bool IsClosedUnionAttribute(AttributeData attribute) =>
        attribute.AttributeClass is { Name: "ClosedUnionAttribute" } symbol && symbol.ContainingNamespace.ToDisplayString() == "Limen.Contract";

    private static void Report(SyntaxNodeAnalysisContext context, DiagnosticDescriptor descriptor, Location location, string subject) =>
        context.ReportDiagnostic(Diagnostic.Create(descriptor, location, subject));

    private static void AnalyzeSwitchStatement(SyntaxNodeAnalysisContext context)
    {
        var node = (SwitchStatementSyntax)context.Node;
        var type = context.SemanticModel.GetTypeInfo(node.Expression, context.CancellationToken).Type;
        if (IsClosedUnion(type)) Report(context, SwitchOnClosedUnion, node.Expression.GetLocation(), type!.ToDisplayString());
    }

    private static void AnalyzeSwitchExpression(SyntaxNodeAnalysisContext context)
    {
        var node = (SwitchExpressionSyntax)context.Node;
        var type = context.SemanticModel.GetTypeInfo(node.GoverningExpression, context.CancellationToken).Type;
        if (IsClosedUnion(type)) Report(context, SwitchOnClosedUnion, node.GoverningExpression.GetLocation(), type!.ToDisplayString());
    }

    private static void AnalyzeDynamic(SyntaxNodeAnalysisContext context)
    {
        var node = (IdentifierNameSyntax)context.Node;
        if (node.Identifier.Text != "dynamic") return;
        if (context.SemanticModel.GetTypeInfo(node, context.CancellationToken).Type is { TypeKind: TypeKind.Dynamic })
        {
            Report(context, DynamicEscapeHatch, node.GetLocation(), "dynamic");
        }
    }

    // Dictionary<string, object> and friends: a map from names to untyped values.
    private static void AnalyzeGeneric(SyntaxNodeAnalysisContext context)
    {
        var node = (GenericNameSyntax)context.Node;
        if (context.SemanticModel.GetTypeInfo(node, context.CancellationToken).Type is not INamedTypeSymbol { TypeArguments.Length: 2 } type) return;
        var isDictionary = type.AllInterfaces.Concat(new[] { type.OriginalDefinition }).Any(candidate => candidate.OriginalDefinition.ToDisplayString() is "System.Collections.Generic.IDictionary<TKey, TValue>" or "System.Collections.Generic.IReadOnlyDictionary<TKey, TValue>");
        var value = type.TypeArguments[1];
        if (isDictionary && (value.SpecialType == SpecialType.System_Object || value.TypeKind == TypeKind.Dynamic))
        {
            Report(context, DynamicEscapeHatch, node.GetLocation(), type.ToDisplayString());
        }
    }

    private static void AnalyzeMemberAccess(SyntaxNodeAnalysisContext context)
    {
        var node = (MemberAccessExpressionSyntax)context.Node;
        if (context.SemanticModel.GetSymbolInfo(node.Expression, context.CancellationToken).Symbol is not INamedTypeSymbol type) return;
        var qualified = type.ToDisplayString();
        if (qualified is "Limen.Contract.Wire" || (type.Name == "Conformance" && qualified.StartsWith("Limen.Contract.", System.StringComparison.Ordinal)))
        {
            Report(context, WirePlumbing, node.GetLocation(), qualified + "." + node.Name.Identifier.Text);
        }
    }
}
