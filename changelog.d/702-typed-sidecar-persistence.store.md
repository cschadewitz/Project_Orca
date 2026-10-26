An inactive, explicitly versioned permission-sidecar v2 schema retains the legacy
agent map and adds reviewed typed rule records at the existing sidecar path. Normal
operation remains on v1: typed persistence has no production registration, and no
existing sidecar is migrated, repaired or converted by this feature.

Future explicit opt-in requires durable managed enrollment and an accepted compatible
writer/runtime floor. Enrolled workspaces must refuse incompatible binaries and
managed update, rollback, root restoration, retarget and enrollment reset until those
paths have separate reviewed support. Unknown or damaged typed state stays closed;
legacy fallback cannot restore standing authority. Refs #702/#699.
