/* Local fixed-size Node-API boundary. No wall clock, subprocess, files or network. */
#include <node_api.h>
#include <stdint.h>
#include <string.h>

#ifdef __APPLE__
#include <mach/mach_time.h>
#include <sys/sysctl.h>
#include "clock-math.h"
#endif

static napi_value unavailable(napi_env env) {
  napi_value value;
  if (napi_get_undefined(env, &value) != napi_ok) return NULL;
  return value;
}

static napi_value read_clock(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef __APPLE__
  char boot[37] = {0};
  size_t length = sizeof(boot);
  mach_timebase_info_data_t scale;
  uint64_t milliseconds;
  if (sysctlbyname("kern.bootsessionuuid", boot, &length, NULL, 0) != 0 ||
      length != sizeof(boot) || boot[36] != '\0' || strlen(boot) != 36 ||
      mach_timebase_info(&scale) != KERN_SUCCESS ||
      !orca_clock_milliseconds(mach_continuous_time(), scale.numer,
                              scale.denom, &milliseconds))
    return unavailable(env);
  napi_value reading, boot_id, elapsed;
  if (napi_create_object(env, &reading) != napi_ok ||
      napi_create_string_utf8(env, boot, 36, &boot_id) != napi_ok ||
      napi_create_double(env, (double)milliseconds, &elapsed) != napi_ok ||
      napi_set_named_property(env, reading, "bootId", boot_id) != napi_ok ||
      napi_set_named_property(env, reading, "elapsedMs", elapsed) != napi_ok)
    return unavailable(env);
  return reading;
#else
  /* Windows identity/suspend proof is pending. Linux is not a shipping target. */
  return unavailable(env);
#endif
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value abi, platform, inclusive, read;
#ifdef __APPLE__
  const char *name = "darwin";
  const int supported = 1;
#else
  const char *name = "unsupported";
  const int supported = 0;
#endif
  if (napi_create_uint32(env, 1, &abi) != napi_ok ||
      napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &platform) != napi_ok ||
      napi_get_boolean(env, supported, &inclusive) != napi_ok ||
      napi_create_function(env, "read", NAPI_AUTO_LENGTH, read_clock, NULL, &read) != napi_ok ||
      napi_set_named_property(env, exports, "abi", abi) != napi_ok ||
      napi_set_named_property(env, exports, "platform", platform) != napi_ok ||
      napi_set_named_property(env, exports, "suspendInclusive", inclusive) != napi_ok ||
      napi_set_named_property(env, exports, "read", read) != napi_ok ||
      napi_object_freeze(env, exports) != napi_ok)
    return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
