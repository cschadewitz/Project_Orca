@echo off
rem ORCA's command line from a Windows desktop install (#1207): the same bundled CLI the
rem app runs as its daemon, run by the app's own ORCA.exe as a plain Node. The installer puts
rem this directory (resources\bin under the install directory) on the user PATH (build\installer.nsh).
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\ORCA.exe" "%~dp0..\daemon\orca-daemon.mjs" %*
endlocal & exit /b %ERRORLEVEL%
