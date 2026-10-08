{
  'targets': [{
    'target_name': 'diagnostics_clock',
    'sources': ['clock.c'],
    'defines': ['NAPI_VERSION=8'],
    'cflags': ['-std=c11', '-Wall', '-Wextra', '-Werror'],
    'xcode_settings': {
      'GCC_C_LANGUAGE_STANDARD': 'c11',
      'WARNING_CFLAGS': ['-Wall', '-Wextra', '-Werror']
    }
  }]
}
