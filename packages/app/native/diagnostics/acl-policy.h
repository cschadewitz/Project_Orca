/* Which rights an untrusted account may hold on a folder in a selection's ancestry (#1217).
 * Pure and portable, so the policy itself is under test on every platform (acl-policy-test.c). */
#ifndef ORCA_ACL_POLICY
#define ORCA_ACL_POLICY
#include <stdint.h>

/* Windows access-mask bits, by value, so this compiles without <windows.h>. */
#define ORCA_DELETE 0x00010000u
#define ORCA_WRITE_DAC 0x00040000u
#define ORCA_WRITE_OWNER 0x00080000u
#define ORCA_GENERIC_ALL 0x10000000u
#define ORCA_GENERIC_WRITE 0x40000000u
#define ORCA_FILE_DELETE_CHILD 0x00000040u
#define ORCA_FILE_WRITE_ATTRIBUTES 0x00000100u
#define ORCA_FILE_WRITE_EA 0x00000010u

/* Below the root: anything that could rename, delete, re-permission or re-own a folder in the chain. */
#define ORCA_ANCESTRY_REFUSED_RIGHTS (ORCA_GENERIC_ALL | ORCA_GENERIC_WRITE | ORCA_DELETE | ORCA_WRITE_DAC | \
  ORCA_WRITE_OWNER | ORCA_FILE_DELETE_CHILD | ORCA_FILE_WRITE_ATTRIBUTES | ORCA_FILE_WRITE_EA)
/* A volume root cannot be renamed or deleted, and replacing one of its children needs DELETE on that child
   (checked on the child itself) or FILE_DELETE_CHILD here. Windows gives a data drive's root
   "Authenticated Users: Modify" by default, so at the root only, write, delete and attribute rights are
   tolerated; rights that reach children or the root's own security are still refused. */
#define ORCA_ROOT_REFUSED_RIGHTS (ORCA_GENERIC_ALL | ORCA_WRITE_DAC | ORCA_WRITE_OWNER | ORCA_FILE_DELETE_CHILD)

/* 1 when an untrusted account holding `mask` on this folder makes the selection unsafe. */
static inline int orca_untrusted_rights_refused(uint32_t mask, int volume_root) {
  return (mask & (volume_root ? ORCA_ROOT_REFUSED_RIGHTS : ORCA_ANCESTRY_REFUSED_RIGHTS)) != 0;
}

#if defined(_WIN32) && defined(DELETE)
/* The by-value bits must be Windows' own. */
_Static_assert(ORCA_DELETE == DELETE && ORCA_WRITE_DAC == WRITE_DAC && ORCA_WRITE_OWNER == WRITE_OWNER &&
  ORCA_GENERIC_ALL == GENERIC_ALL && ORCA_GENERIC_WRITE == GENERIC_WRITE && ORCA_FILE_DELETE_CHILD == FILE_DELETE_CHILD &&
  ORCA_FILE_WRITE_ATTRIBUTES == FILE_WRITE_ATTRIBUTES && ORCA_FILE_WRITE_EA == FILE_WRITE_EA, "Windows access-mask values");
#endif
#endif
