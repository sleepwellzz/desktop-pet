@echo off
rem Keep this file ASCII-only: cmd reads .bat as GBK, Chinese text breaks the syntax.
rem Manual acceptance helper: feed one business status to the running pet.
rem Usage:  double-click it and press a number, OR  feed-status.bat running
setlocal
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\nodejs"

rem Allow a non-interactive run (used by automation): set NOPAUSE=1
if not "%~1"=="" (
  set "S=%~1"
  goto :send
)

:menu
echo ==========================================================
echo   desktop-pet : manual acceptance - feed one status
echo ==========================================================
echo.
echo   Start the pet FIRST (double-click the other .bat file),
echo   then come back here and press a number.
echo.
echo   1  running        pet runs on the spot
echo   2  ready          waves once, then review  (one-shot + landing)
echo   3  blocked        lies down (failed)
echo   4  needs-input    stands and waits        (starts STICKY)
echo   5  running again  pet MUST KEEP waiting   [sticky check]
echo   6  idle           back to idle
echo   7  clear          remove the session (pet goes idle)
echo   L  list the status file
echo   Q  quit
echo.
set "S="
set "CH="
set /p "CH=Choose 1-7 / L / Q then press Enter: "
if "%CH%"=="1" set "S=running"
if "%CH%"=="2" set "S=ready"
if "%CH%"=="3" set "S=blocked"
if "%CH%"=="4" set "S=needs-input"
if "%CH%"=="5" set "S=running"
if "%CH%"=="6" set "S=idle"
if "%CH%"=="7" set "S=clear"
if /i "%CH%"=="L" goto :list
if /i "%CH%"=="Q" exit /b 0
if not defined S (
  echo Unknown choice.
  if not "%NOPAUSE%"=="1" pause
  exit /b 2
)

:send
echo.
if /i "%S%"=="clear" (
  echo Clearing the session ...
  node "tools\pet-hook.mjs" --clear --title=none
) else (
  echo Sending status "%S%" ...
  node "tools\pet-hook.mjs" %S% --title=manual-acceptance
)
echo.
echo Current status file:
node "tools\pet-hook.mjs" --list
echo.
echo Look at the pet now. This window can stay open; close it when done.
if not "%NOPAUSE%"=="1" pause
exit /b 0

:list
node "tools\pet-hook.mjs" --list
if not "%NOPAUSE%"=="1" pause
exit /b 0
