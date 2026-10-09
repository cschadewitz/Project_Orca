{
  'targets': [{
    'target_name': 'first_run_windows',
    'sources': [],
    'defines': ['NAPI_VERSION=8'],
    'conditions': [['OS=="win"', {
      'sources': ['first-run-windows.c', 'windows-delay-load.c'],
      'win_delay_load_hook': 'false',
      'defines': ['_CRT_SECURE_NO_WARNINGS'],
      'libraries!': ['-l"<(node_lib_file)"'],
      'libraries': ['<(node_root_dir)/<(target_arch)/node.lib', 'advapi32.lib', 'delayimp.lib'],
      'msvs_settings': { 'VCCLCompilerTool': {
        'AdditionalOptions!': ['-std:c++20', '/Zc:__cplusplus'],
        'AdditionalOptions': ['/std:c11'], 'WarningLevel': 4, 'WarnAsError': 'true'
      }, 'VCLinkerTool': { 'DelayLoadDLLs': ['node.exe'], 'AdditionalOptions': ['/ignore:4199'] } }
    }], ['OS!="win"', { 'type': 'none' }]]
  }, {
    'target_name': 'diagnostics_clock',
    'sources': ['clock.c'],
    'defines': ['NAPI_VERSION=8'],
    'cflags': ['-std=c11', '-Wall', '-Wextra', '-Werror'],
    'xcode_settings': {
      'GCC_C_LANGUAGE_STANDARD': 'c11',
      'WARNING_CFLAGS': ['-Wall', '-Wextra', '-Werror']
    },
    'conditions': [['OS=="win"', {
      'win_delay_load_hook': 'false',
      'defines': ['_CRT_SECURE_NO_WARNINGS'],
      'sources': ['windows-delay-load.c'],
      'libraries!': ['-l"<(node_lib_file)"'],
      'libraries': ['<(node_root_dir)/<(target_arch)/node.lib', 'delayimp.lib'],
      'msvs_settings': { 'VCCLCompilerTool': {
        'AdditionalOptions!': ['-std:c++20', '/Zc:__cplusplus'],
        'AdditionalOptions': ['/std:c11'], 'WarningLevel': 4, 'WarnAsError': 'true'
      }, 'VCLinkerTool': { 'DelayLoadDLLs': ['node.exe'], 'AdditionalOptions': ['/ignore:4199'] } }
    }]]
  }, {
    'target_name': 'diagnostics_storage',
    'sources': ['storage.c'],
    'defines': ['NAPI_VERSION=8'],
    'cflags': ['-std=c11', '-Wall', '-Wextra', '-Werror'],
    'xcode_settings': {
      'GCC_C_LANGUAGE_STANDARD': 'c11',
      'WARNING_CFLAGS': ['-Wall', '-Wextra', '-Werror']
    },
    'conditions': [['OS=="win"', {
      'sources!': ['storage.c'],
      'win_delay_load_hook': 'false',
      'defines': ['_CRT_SECURE_NO_WARNINGS'],
      'sources': ['storage-windows.c', 'keys-windows.c', 'windows-delay-load.c'],
      'libraries!': ['-l"<(node_lib_file)"'],
      'libraries': ['<(node_root_dir)/<(target_arch)/node.lib', 'advapi32.lib', 'crypt32.lib', 'delayimp.lib'],
      'msvs_settings': { 'VCCLCompilerTool': {
        'AdditionalOptions!': ['-std:c++20', '/Zc:__cplusplus'],
        'AdditionalOptions': ['/std:c11'], 'WarningLevel': 4, 'WarnAsError': 'true'
      }, 'VCLinkerTool': { 'DelayLoadDLLs': ['node.exe'], 'AdditionalOptions': ['/ignore:4199'] } }
    }]]
  }]
}
