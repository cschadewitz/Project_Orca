/* Test-only: the ancestry ACL mask policy (#1217). Not shipped.
 * Compile: cc -std=c11 -O2 -Wall -Wextra -Werror acl-policy-test.c -o <temporary helper>
 * Prints one line per case and exits non-zero when any case disagrees with the policy. */
#include <stdio.h>
#include "acl-policy.h"

/* The stock "Modify" grant Windows puts on a data drive's root for Authenticated Users. */
#define MODIFY 0x001301bfu
#define READ_EXECUTE 0x001200a9u
#define FILE_ALL_ACCESS 0x001f01ffu
#define ADD_SUBDIRECTORY 0x00000004u

static int failures = 0;
static void expect(const char *name, uint32_t mask, int volume_root, int refused) {
  int actual = orca_untrusted_rights_refused(mask, volume_root);
  printf("%s %s %s\n", actual == refused ? "ok" : "FAIL", volume_root ? "root" : "below", name);
  if (actual != refused) ++failures;
}

int main(void) {
  /* The volume root: the stock grant and its parts are tolerated. */
  expect("modify", MODIFY, 1, 0);
  expect("delete", ORCA_DELETE, 1, 0);
  expect("generic-write", ORCA_GENERIC_WRITE, 1, 0);
  expect("write-attributes", ORCA_FILE_WRITE_ATTRIBUTES, 1, 0);
  expect("write-ea", ORCA_FILE_WRITE_EA, 1, 0);
  expect("read-execute", READ_EXECUTE, 1, 0);
  /* Rights that alter the root's security or delete its children are still refused at the root. */
  expect("delete-child", ORCA_FILE_DELETE_CHILD, 1, 1);
  expect("modify+delete-child", MODIFY | ORCA_FILE_DELETE_CHILD, 1, 1);
  expect("write-dac", ORCA_WRITE_DAC, 1, 1);
  expect("write-owner", ORCA_WRITE_OWNER, 1, 1);
  expect("generic-all", ORCA_GENERIC_ALL, 1, 1);
  expect("full-control", FILE_ALL_ACCESS, 1, 1);
  /* Below the root the rule is unchanged: any mutation right refuses; reading and creating do not. */
  expect("modify", MODIFY, 0, 1);
  expect("delete", ORCA_DELETE, 0, 1);
  expect("generic-write", ORCA_GENERIC_WRITE, 0, 1);
  expect("write-attributes", ORCA_FILE_WRITE_ATTRIBUTES, 0, 1);
  expect("write-ea", ORCA_FILE_WRITE_EA, 0, 1);
  expect("delete-child", ORCA_FILE_DELETE_CHILD, 0, 1);
  expect("write-dac", ORCA_WRITE_DAC, 0, 1);
  expect("write-owner", ORCA_WRITE_OWNER, 0, 1);
  expect("generic-all", ORCA_GENERIC_ALL, 0, 1);
  expect("full-control", FILE_ALL_ACCESS, 0, 1);
  expect("read-execute", READ_EXECUTE, 0, 0);
  expect("add-subdirectory", ADD_SUBDIRECTORY, 0, 0);
  return failures ? 1 : 0;
}
