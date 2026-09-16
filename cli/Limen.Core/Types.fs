/// The Limen lifecycle domain.
///
/// Every type here describes *what is true* or *what is intended*, never how it
/// is carried out. Reading the filesystem produces a `RepositorySnapshot`;
/// deciding what should change produces a `Plan`; only `Execute` touches disk.
/// Keeping those three apart is what makes `--dry-run` honest rather than a
/// second code path that might disagree with the real one.
module Limen.Core.Types

/// Who is allowed to change a managed file, and under what rule.
///
/// This is the single most important classification in the tool: it decides
/// whether an upgrade may rewrite a file, regenerate it, leave it alone, or
/// stop and ask. A file's ownership is recorded in the manifest at install
/// time, so a later CLI version cannot silently reinterpret it.
type Ownership =
    /// Controlled by Limen. Replaced when the tool's copy changes.
    | ToolOwned
    /// Derived from authoritative inputs. Safe to regenerate at any time.
    | Generated
    /// Controlled by the repository. Never overwritten automatically.
    | UserOwned
    /// Written by the tool, then expected to be edited. Changes require an
    /// explicit migration; a local edit blocks a blind rewrite.
    | Shared

module Ownership =

    let toString =
        function
        | ToolOwned -> "tool-owned"
        | Generated -> "generated"
        | UserOwned -> "user-owned"
        | Shared -> "shared"

    let parse =
        function
        | "tool-owned" -> Some ToolOwned
        | "generated" -> Some Generated
        | "user-owned" -> Some UserOwned
        | "shared" -> Some Shared
        | _ -> None

/// How a managed file came to be at its path.
///
/// Without this, the hash alone is ambiguous: a file that differs from the
/// tool's canonical copy might be a customization to protect or a stale copy to
/// update, and guessing wrong either destroys work or freezes a repository on
/// an old version. The sibling ROS installer records the same distinction.
type Disposition =
    /// The tool created this file. It may be updated when the tool's copy
    /// changes, provided the user has not edited it since.
    | InstalledByTool
    /// The file was already there when Limen arrived. The tool adopted it and
    /// will never overwrite it.
    | PreservedExisting

module Disposition =

    let toString =
        function
        | InstalledByTool -> "installed"
        | PreservedExisting -> "preserved-existing"

    let parse =
        function
        | "installed" -> Some InstalledByTool
        | "preserved-existing" -> Some PreservedExisting
        | _ -> None

/// One file Limen manages, as recorded in the manifest.
///
/// The hash is of the content at the moment it was recorded. A later mismatch
/// means a human edited it, which is information the upgrade planner needs —
/// not an error in itself.
type ManagedArtifact =
    { Path: string
      Ownership: Ownership
      Disposition: Disposition
      Sha256: string }

/// The installation record: `.echelon/limen.json`.
///
/// Presence of files is never the source of truth. This is.
type Manifest =
    { SchemaVersion: int
      Tool: string
      Package: string
      InstalledVersion: string
      ConfigurationVersion: int
      ManagedArtifacts: ManagedArtifact list }

/// Which directories hold which side of the Limen boundary.
///
/// `Engine` paths own application meaning and must not reach for the browser.
/// `Kernel` paths are the only places allowed to touch it.
type BoundaryConfig =
    { Engine: string list
      Kernel: string list }

/// The user-owned configuration: `limen.config.json`.
type Configuration =
    { ConfigurationVersion: int
      Boundary: BoundaryConfig }

/// Everything that can be wrong with an installation.
///
/// Each case carries what a human needs to fix it. `doctor` turns these into
/// explanations; `verify` only counts them.
type InstallationProblem =
    | ManifestMissing
    | ManifestUnreadable of detail: string
    | ManifestSchemaUnsupported of found: int * supported: int
    | ConfigurationMissing of path: string
    | ConfigurationUnreadable of path: string * detail: string
    | ConfigurationVersionUnsupported of found: int * supported: int
    | ManagedArtifactMissing of path: string
    | ManagedArtifactModified of path: string
    | BoundaryViolation of path: string * reason: string
    | ConfiguredPathMissing of path: string
    /// Reported by `verify --strict` only: the installation is healthy but
    /// older than the CLI running against it.
    | InstalledVersionOutdated of installed: string * available: string

type InstalledVersion = InstalledVersion of string
type AvailableVersion = AvailableVersion of string

/// The lifecycle state of the capability in one repository.
///
/// These four cases are mutually exclusive by construction, so "installed but
/// also broken" cannot be written down.
type InstallationState =
    | NotInstalled
    | Installed of InstalledVersion
    | UpgradeRequired of InstalledVersion * AvailableVersion
    | Invalid of InstallationProblem list

/// A change the tool intends to make. Nothing here has happened yet.
type PlannedChange =
    | CreateDirectory of path: string
    | CreateFile of path: string * content: string * ownership: Ownership
    | UpdateManagedFile of path: string * content: string * ownership: Ownership
    | UpdateConfiguration of path: string * content: string
    | RegisterIntegration of description: string * path: string * content: string
    | RunMigration of fromVersion: int * toVersion: int
    | WriteManifest of manifest: Manifest

module PlannedChange =

    /// The repository-relative path a change touches, for reporting and for
    /// path-safety validation.
    let path =
        function
        | CreateDirectory p -> p
        | CreateFile (p, _, _) -> p
        | UpdateManagedFile (p, _, _) -> p
        | UpdateConfiguration (p, _) -> p
        | RegisterIntegration (_, p, _) -> p
        | RunMigration _ -> ""
        | WriteManifest _ -> Paths.manifest

    let describe =
        function
        | CreateDirectory p -> sprintf "create directory %s" p
        | CreateFile (p, _, o) -> sprintf "create %s (%s)" p (Ownership.toString o)
        | UpdateManagedFile (p, _, o) -> sprintf "update %s (%s)" p (Ownership.toString o)
        | UpdateConfiguration (p, _) -> sprintf "update configuration %s" p
        | RegisterIntegration (d, p, _) -> sprintf "register integration %s (%s)" d p
        | RunMigration (f, t) -> sprintf "run migration %d -> %d" f t
        | WriteManifest m -> sprintf "write installation manifest (version %s)" m.InstalledVersion

/// A reason the tool will not proceed.
///
/// A conflict is not a failure of the run — it is the tool refusing to destroy
/// something it does not own. Every conflict names the file and what to do.
type Conflict =
    { Path: string
      Reason: string
      Remedy: string }

/// The full intent of an `init` or `upgrade`, calculated before anything runs.
///
/// A plan with conflicts is never executed.
type Plan =
    { Changes: PlannedChange list
      Conflicts: Conflict list }

module Plan =
    let empty = { Changes = []; Conflicts = [] }
    let isExecutable plan = List.isEmpty plan.Conflicts
    let isNoOp plan = List.isEmpty plan.Changes && List.isEmpty plan.Conflicts

/// How serious a `doctor` finding is. Not every deviation is an error.
///
/// Qualified access is required because an unqualified `Error` case would
/// shadow `Result.Error` everywhere this module is opened, which silently turns
/// parse failures into severity values.
[<RequireQualifiedAccess>]
type Severity =
    | Error
    | Warning
    | Information

module Severity =
    let toString =
        function
        | Severity.Error -> "error"
        | Severity.Warning -> "warning"
        | Severity.Information -> "information"

/// One `doctor` finding: what is wrong, why, and how to fix it.
type Diagnosis =
    { Severity: Severity
      Code: string
      Title: string
      Detail: string
      Remedy: string option }

/// The result of `verify`: a yes/no plus every reason it was no.
type VerificationResult =
    { Ok: bool
      Strict: bool
      Problems: InstallationProblem list }

/// What `status` reports. Read-only by construction — there is no way to build
/// one of these that also changes the repository.
type StatusReport =
    { Tool: string
      Package: string
      CliVersion: string
      State: InstallationState
      ConfigurationVersion: int option
      ManagedArtifactCount: int
      Verification: VerificationResult option }
