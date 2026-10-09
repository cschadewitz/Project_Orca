/* Local fixed-size Node-API boundary. No wall clock, subprocess, files or network. */
#include <node_api.h>
#include <stdint.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
typedef LONG (WINAPI *query_system_information)(ULONG, void *, ULONG, ULONG *);
typedef void (WINAPI *query_interrupt_time_precise)(ULONGLONG *);
typedef struct {
  GUID identifier;
  ULONG firmware;
  ULONGLONG flags;
} boot_environment;
#endif

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
#elif defined(_WIN32)
  /* Kernel boot GUID, not a wall/process-derived surrogate. Unknown OS layouts refuse. */
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  HMODULE kernel = GetModuleHandleW(L"kernelbase.dll");
  query_system_information query = NULL;
  query_interrupt_time_precise ticks = NULL;
  FARPROC query_address = ntdll ? GetProcAddress(ntdll, "NtQuerySystemInformation") : NULL;
  FARPROC ticks_address = kernel ? GetProcAddress(kernel, "QueryInterruptTimePrecise") : NULL;
  memcpy(&query, &query_address, sizeof(query));
  memcpy(&ticks, &ticks_address, sizeof(ticks));
  boot_environment boot = {0};
  ULONG returned = 0;
  ULONGLONG elapsed = 0;
  if (!query || !ticks || query(90, &boot, (ULONG)sizeof(boot), &returned) < 0 ||
      returned < sizeof(GUID) + sizeof(ULONG) || returned > sizeof(boot)) return unavailable(env);
  static const GUID zero = {0};
  if (!memcmp(&zero, &boot.identifier, sizeof(zero))) return unavailable(env);
  ticks(&elapsed);
  uint64_t milliseconds = elapsed / 10000;
  if (milliseconds > UINT64_C(9007199254740991)) return unavailable(env);
  char identity[37];
  const GUID *id = &boot.identifier;
  if (snprintf(identity, sizeof(identity), "%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
      (unsigned long)id->Data1, id->Data2, id->Data3, id->Data4[0], id->Data4[1],
      id->Data4[2], id->Data4[3], id->Data4[4], id->Data4[5], id->Data4[6], id->Data4[7]) != 36) return unavailable(env);
  napi_value reading, boot_id, elapsed_value;
  if (napi_create_object(env, &reading) != napi_ok ||
      napi_create_string_utf8(env, identity, 36, &boot_id) != napi_ok ||
      napi_create_double(env, (double)milliseconds, &elapsed_value) != napi_ok ||
      napi_set_named_property(env, reading, "bootId", boot_id) != napi_ok ||
      napi_set_named_property(env, reading, "elapsedMs", elapsed_value) != napi_ok) return unavailable(env);
  return reading;
#else
  /* Linux is a conformance fixture, not a shipping clock target. */
  return unavailable(env);
#endif
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value abi, platform, inclusive, read;
#ifdef __APPLE__
  const char *name = "darwin";
  const int supported = 1;
#elif defined(_WIN32)
  const char *name = "win32";
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
