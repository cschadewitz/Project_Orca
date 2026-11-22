Windows can now carry a store forward to a new format. The backup is written as one ZIP archive
into a backup slot file (`format-backups/store-backup-1.zip` or `-2.zip`) that already existed
before Windows last started, rewritten in place and flushed before the format marker is created,
so a power loss can never keep the new marker without its backup. Every Windows start creates
the two slots if they are missing; a carryover that finds none old enough refuses (`UNDURABLE`)
with nothing copied and asks for a Windows restart. Restore a backup with Explorer's
"Extract all" or `Expand-Archive`.
