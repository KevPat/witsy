@echo off
rem Witsy CLI launcher for cmd.exe (bin/witsy is the macOS and Linux one, witsy.ps1 the PowerShell one).
rem
rem It runs cli.js on the app binary started as Node.js (ELECTRON_RUN_AS_NODE=1), or on the Node.js
rem of the computer (18 or later, found through the PATH only) when the "runtime" file next to cli.js
rem says "node" (a build made with WITSY_CLI_RUNTIME=node, see build/cli_runtime.ts).
rem
rem Where cli.js and the app binary are, from the folder of this file (D), first match wins:
rem   1. D\app-X.Y.Z\ : the launcher copied by the app next to its Squirrel versions (the folder on the
rem      PATH). The highest X.Y.Z, compared as numbers, of the folders named exactly app-<n>.<n>.<n>
rem      that contain Witsy.exe and resources\cli\cli.js. cli = app-X.Y.Z\resources\cli\cli.js,
rem      app = app-X.Y.Z\Witsy.exe
rem   2. D\..\cli.js : the launcher inside an app (D = <app>\resources\cli\bin, zip install) or inside
rem      a CLI build of the repository (D = <repo>\dist\cli\bin). app = D\..\..\..\Witsy.exe, else
rem      D\..\..\..\node_modules\electron\dist\electron.exe
rem   3. D\..\dist\cli\cli.js : the launcher of the repository (D = <repo>\bin), after npm run build:cli.
rem      app = D\..\node_modules\electron\dist\electron.exe
rem Nothing is ever looked for in, or run from, the current folder.
rem
rem Arguments are passed on as typed (%%* is expanded once and not again: ! and %% survive, there is no
rem delayed expansion). Like every .cmd, an unquoted & | < > or ^ in an argument is read by cmd.exe
rem itself: put such an argument in double quotes. The exit code is the one of the CLI.
rem This file must keep CRLF line ends (.gitattributes): cmd.exe misreads labels without them.

setlocal EnableExtensions DisableDelayedExpansion

set "WITSY_DIR=%~dp0"
set "WITSY_CLI="
set "WITSY_APP="
set "WITSY_BEST="
set "WITSY_BEST_KEY="
set "WITSY_TRIED1="
set "WITSY_TRIED2="

rem 1. Squirrel: the app-* folders next to this file. Only names made of digits and dots after
rem "app-" reach the call, so the call cannot see a ^ or a %% of a folder name.
for /d %%D in ("%WITSY_DIR%app-*") do if exist "%%~fD\Witsy.exe" if exist "%%~fD\resources\cli\cli.js" (
  for /f "tokens=1,2 delims=0123456789." %%x in ("%%~nxD") do if "%%x"=="app-" if "%%y"=="" (
    for /f "tokens=1-5 delims=.-" %%a in ("%%~nxD") do if /i "%%~nxD"=="app-%%b.%%c.%%d" if "%%e"=="" call :consider %%~nxD %%b %%c %%d
  )
)
if not defined WITSY_BEST goto :not_squirrel
set "WITSY_CLI=%WITSY_DIR%%WITSY_BEST%\resources\cli\cli.js"
set "WITSY_APP=%WITSY_DIR%%WITSY_BEST%\Witsy.exe"
goto :found
:not_squirrel

rem 2. inside an app (zip install) or a CLI build of the repository
if not exist "%WITSY_DIR%..\cli.js" goto :not_packaged
for %%F in ("%WITSY_DIR%..\cli.js") do set "WITSY_CLI=%%~fF"
for %%F in ("%WITSY_DIR%..\..\..\Witsy.exe") do set "WITSY_TRIED1=%%~fF"
for %%F in ("%WITSY_DIR%..\..\..\node_modules\electron\dist\electron.exe") do set "WITSY_TRIED2=%%~fF"
if exist "%WITSY_TRIED1%" set "WITSY_APP=%WITSY_TRIED1%"
if defined WITSY_APP goto :found
if exist "%WITSY_TRIED2%" set "WITSY_APP=%WITSY_TRIED2%"
goto :found
:not_packaged

rem 3. the launcher of the repository
if not exist "%WITSY_DIR%..\dist\cli\cli.js" goto :not_found
for %%F in ("%WITSY_DIR%..\dist\cli\cli.js") do set "WITSY_CLI=%%~fF"
for %%F in ("%WITSY_DIR%..\node_modules\electron\dist\electron.exe") do set "WITSY_TRIED1=%%~fF"
if exist "%WITSY_TRIED1%" set "WITSY_APP=%WITSY_TRIED1%"
goto :found

:found
for %%F in ("%WITSY_CLI%") do set "WITSY_CLI_DIR=%%~dpF"

rem Which Node.js runs the CLI was decided when the app was built:
rem - "electron", or no file: the app binary, as a Node.js runtime
rem - "node": the Node.js of this computer. The app binary cannot be used: it no longer
rem   accepts to run as Node.js (the RunAsNode fuse is off), for any program or user
set "WITSY_RUNTIME=electron"
if not exist "%WITSY_CLI_DIR%runtime" goto :runtime_read
set "WITSY_RUNTIME="
for /f "usebackq delims=" %%R in ("%WITSY_CLI_DIR%runtime") do (
  set "WITSY_RUNTIME=%%R"
  goto :runtime_trim
)
:runtime_trim
if not defined WITSY_RUNTIME goto :runtime_read
rem spaces and tabs are not part of the name
for /f "tokens=1-8" %%a in ("%WITSY_RUNTIME%") do set "WITSY_RUNTIME=%%a%%b%%c%%d%%e%%f%%g%%h"
:runtime_read
if "%WITSY_RUNTIME%"=="node" goto :run_node

rem the app binary, as Node.js
if not defined WITSY_APP goto :no_app
rem one line: the paths are expanded before the variables of this file are removed from the
rem environment the CLI gets, and ELECTRON_RUN_AS_NODE only exists inside setlocal
set "ELECTRON_RUN_AS_NODE=1"
call :clean & "%WITSY_APP%" --no-deprecation "%WITSY_CLI%" %*
exit /b %ERRORLEVEL%

:run_node
rem The PATH only: %%~$PATH: does not look in the current folder, which "where" and a bare "node" do.
set "WITSY_NODE="
for %%I in (node.exe) do set "WITSY_NODE=%%~$PATH:I"
if not defined WITSY_NODE goto :no_node
rem an entry of the PATH such as "." or an empty one can still point at the current folder
set "WITSY_CWD=%CD%"
if not "%WITSY_CWD:~-1%"=="\" set "WITSY_CWD=%WITSY_CWD%\"
for %%I in ("%WITSY_NODE%") do if /i "%%~dpI"=="%WITSY_CWD%" goto :node_in_cwd

rem The command line of for /f does not start with a double quote (cmd /c would remove it) and
rem the path of node is read from the environment by that cmd: nothing in it is parsed.
set "WITSY_NODE_MAJOR="
for /f "delims=" %%V in ('2^>nul "%%WITSY_NODE%%" -p "process.versions.node.split('.')[0]"') do if not defined WITSY_NODE_MAJOR set "WITSY_NODE_MAJOR=%%V"
if not defined WITSY_NODE_MAJOR goto :old_node
for /f "delims=0123456789" %%X in ("%WITSY_NODE_MAJOR%") do goto :old_node
rem more than 4 digits, or 0 followed by digits (read as octal by if), is not a Node.js version
if not "%WITSY_NODE_MAJOR:~4%"=="" goto :old_node
if "%WITSY_NODE_MAJOR:~0,1%"=="0" goto :old_node
if %WITSY_NODE_MAJOR% LSS 18 goto :old_node

call :clean & "%WITSY_NODE%" --no-deprecation "%WITSY_CLI%" %*
exit /b %ERRORLEVEL%

rem the variables of this file, which the CLI does not need (and only them)
:clean
for %%V in (DIR CLI CLI_DIR APP BEST BEST_KEY KEY K1 K2 K3 TRIED1 TRIED2 RUNTIME NODE CWD NODE_MAJOR) do set "WITSY_%%V="
exit /b 0

rem Squirrel: keep the highest version. %1 is the folder name, %2 %3 %4 its numbers.
:consider
set "WITSY_K1=000000000%~2"
set "WITSY_K2=000000000%~3"
set "WITSY_K3=000000000%~4"
set "WITSY_KEY=v%WITSY_K1:~-9%.%WITSY_K2:~-9%.%WITSY_K3:~-9%"
if not defined WITSY_BEST_KEY goto :consider_take
if "%WITSY_KEY%" GTR "%WITSY_BEST_KEY%" goto :consider_take
exit /b 0
:consider_take
set "WITSY_BEST=%~1"
set "WITSY_BEST_KEY=%WITSY_KEY%"
exit /b 0

rem The messages print paths with delayed expansion: a value expanded that way is not parsed by
rem cmd.exe, whatever & ^ ( ) or %% it contains.

:not_found
setlocal EnableDelayedExpansion
>&2 echo Witsy CLI: cannot find the Witsy CLI ^(cli.js^). Looked for:
>&2 echo   !WITSY_DIR!app-X.Y.Z\resources\cli\cli.js ^(with app-X.Y.Z\Witsy.exe^)
>&2 echo   !WITSY_DIR!..\cli.js
>&2 echo   !WITSY_DIR!..\dist\cli\cli.js
>&2 echo Reinstall Witsy, or run npm run build:cli in a copy of the repository.
exit /b 1

:no_app
setlocal EnableDelayedExpansion
>&2 echo Witsy CLI: found !WITSY_CLI! but not the Witsy app to run it. Looked for:
>&2 echo   !WITSY_TRIED1!
if defined WITSY_TRIED2 >&2 echo   !WITSY_TRIED2!
>&2 echo Reinstall Witsy, or run npm install in the repository.
exit /b 1

:no_node
>&2 echo Witsy CLI requires Node.js 18 or later, and no 'node' was found in your PATH.
>&2 echo Install Node.js ^(https://nodejs.org^) and try again.
exit /b 1

:node_in_cwd
setlocal EnableDelayedExpansion
>&2 echo Witsy CLI: the node.exe found through your PATH is in the current folder ^(!WITSY_NODE!^) and is not run.
>&2 echo Run witsy from another folder, or remove the entry of your PATH that points to the current folder.
exit /b 1

:old_node
set "WITSY_NODE_VERSION="
for /f "delims=" %%V in ('2^>nul "%%WITSY_NODE%%" --version') do if not defined WITSY_NODE_VERSION set "WITSY_NODE_VERSION=%%V"
if not defined WITSY_NODE_VERSION set "WITSY_NODE_VERSION=not a working Node.js"
setlocal EnableDelayedExpansion
>&2 echo Witsy CLI requires Node.js 18 or later: '!WITSY_NODE!' is !WITSY_NODE_VERSION!.
>&2 echo Install a recent Node.js ^(https://nodejs.org^) and try again.
exit /b 1
