#ifndef ORCA_DIAGNOSTICS_CLOCK_MATH_H
#define ORCA_DIAGNOSTICS_CLOCK_MATH_H

#include <stdint.h>

/* 96-bit intermediate: never wrap uint64 ticks * uint32 timebase numerator. */
static int orca_clock_milliseconds(uint64_t ticks, uint32_t numerator,
                                   uint32_t denominator, uint64_t *milliseconds) {
  if (numerator == 0 || denominator == 0 || milliseconds == 0) return 0;
  const unsigned __int128 nanos = (unsigned __int128)ticks * numerator;
  const unsigned __int128 divisor = (unsigned __int128)denominator * 1000000;
  const unsigned __int128 result = nanos / divisor;
  if (result > UINT64_C(9007199254740991)) return 0;
  *milliseconds = (uint64_t)result;
  return 1;
}

#endif
