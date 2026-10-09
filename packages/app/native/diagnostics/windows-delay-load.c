/* Resolve Node-API imports in Electron's current host; never load another executable. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>
#include <string.h>
static FARPROC WINAPI host_executable(unsigned event, PDelayLoadInfo info) {
  if(event!=dliNotePreLoadLibrary || _stricmp(info->szDll,"node.exe"))return NULL;
  HMODULE module=GetModuleHandleW(NULL);
  FARPROC result=NULL;
  _Static_assert(sizeof(result)==sizeof(module),"Windows_handle_width");
  memcpy(&result,&module,sizeof(result));
  return result;
}
/* Current MSVC delayimp.h declares the hook const; GNU's header is writable. */
#ifdef _MSC_VER
const PfnDliHook __pfnDliNotifyHook2=host_executable;
#else
PfnDliHook __pfnDliNotifyHook2=host_executable;
#endif
#endif
