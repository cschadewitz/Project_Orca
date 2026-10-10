/* Exercises the production arithmetic only; no synthetic platform API proof. */
#include <assert.h>
#include <stdio.h>
#include "../../native/diagnostics/clock-math.h"

int main(void) {
  uint64_t result = 42;
  assert(orca_clock_milliseconds(0, 1, 1, &result) && result == 0);
  assert(orca_clock_milliseconds(999999, 1, 1, &result) && result == 0);
  assert(orca_clock_milliseconds(1000000, 1, 1, &result) && result == 1);
  assert(orca_clock_milliseconds(1000000, 125, 3, &result) && result == 41);
  assert(orca_clock_milliseconds(UINT64_MAX, UINT32_MAX, UINT32_MAX, &result) && result == UINT64_C(18446744073709));
  assert(orca_clock_milliseconds(UINT64_C(9007199254740991000), 1000, 1, &result) && result == UINT64_C(9007199254740991));
  result = 42;
  assert(!orca_clock_milliseconds(UINT64_C(9007199254740992000), 1000, 1, &result) && result == 42);
  assert(!orca_clock_milliseconds(UINT64_MAX, UINT32_MAX, 1, &result));
  assert(!orca_clock_milliseconds(1, 0, 1, &result));
  assert(!orca_clock_milliseconds(1, 1, 0, &result));
  assert(!orca_clock_milliseconds(1, 1, 1, NULL));
  puts("clock arithmetic passed");
  return 0;
}
