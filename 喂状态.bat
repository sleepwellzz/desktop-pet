@echo off
rem Keep this file ASCII-only: cmd reads .bat as GBK, Chinese text breaks the syntax.
rem Manual acceptance helper: feed one business status to the running pet.
rem Interactive: double-click, then press numbers in a loop (window stays open until Q).
rem Non-interactive: "feed-status.bat running"
setlocal
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\nodejs"

if not "%~1"=="" goto :oneshot

echo ==========================================================
echo   desktop-pet : manual acceptance - feed one status
echo ==========================================================
echo.
echo   Start the pet FIRST (double-click the other .bat file).
echo   Then press a number here, look at the pet, press the next one.
echo   This window stays open until you press Q.
echo.
echo   Row numbers below refer to the sprite sheet. To see what every
echo   row actually looks like, open: docs\status-reference.png
echo.
echo   Steps 1-7 write ONE session, named "default".
echo   Steps 8-9 write a SECOND session. That is the only way to make
echo   the "+1" badge appear: the badge counts sessions OTHER than
echo   the one the pet is currently showing, so a single session can
echo   never produce it.
echo.

:menu
echo ----------------------------------------------------------
echo   1  running        row 7 : party hat + birthday cake pose
echo                            ^(this pack drew a BIRTHDAY here, not running^)
echo   2  ready          row 3 : waves once, then stops on row 8 ^(chef^)
echo   3  blocked        row 5 : lies down
echo   4  needs-input    row 6 : sits and waits  ^(sticky starts^)
echo   5  running again  pet MUST KEEP WAITING on row 6   [sticky check]
echo   6  idle           row 0 : sits idle
echo   7  clear          remove session "default" ^(back to idle^)
echo   8  session B run  second session appears -^> badge turns into +1
echo   9  session B clr  removes session B -^> badge goes away
echo   L  list           show the status file
echo   Q  quit
echo.
set "CH="
set /p "CH=Press 1-9 / L / Q then Enter (Enter alone = quit): "
echo.
rem Empty input means either a bare Enter or stdin already at EOF. Quit instead of
rem re-prompting: on EOF a re-prompt loop spins forever and pegs a CPU core.
if "%CH%"=="" goto :done
call :dispatch "%CH%"
if defined QUIT goto :done
goto :menu

:dispatch
set "S="
set "SESS="
set "TITLE=manual-acceptance"
if /i "%~1"=="L" goto :dlist
if /i "%~1"=="Q" goto :dquit
if "%~1"=="1" set "S=running"
if "%~1"=="2" set "S=ready"
if "%~1"=="3" set "S=blocked"
if "%~1"=="4" set "S=needs-input"
if "%~1"=="5" set "S=running"
if "%~1"=="6" set "S=idle"
if "%~1"=="7" set "S=clear"
rem One statement per line on purpose: "if cond cmd1 & cmd2" lets the "&" escape
rem the if-scope, and an undefined label aborts the script with a bogus exit code.
if "%~1"=="8" set "S=running"
if "%~1"=="8" set "SESS=b"
if "%~1"=="8" set "TITLE=session-b"
if "%~1"=="9" set "S=clear"
if "%~1"=="9" set "SESS=b"
if "%~1"=="9" set "TITLE=session-b"
if not defined S (
  echo Unknown choice, try again.
  exit /b 0
)
set "ARGS="
if defined SESS set "ARGS=--session=%SESS%"
if /i "%S%"=="clear" (
  echo Clearing session %ARGS% ...
  node "tools\pet-hook.mjs" --clear %ARGS% --title=%TITLE%
) else (
  echo Sending status "%S%" to %ARGS% ...
  node "tools\pet-hook.mjs" %S% %ARGS% --title=%TITLE%
)
echo.
if "%~1"=="5" echo NOTE: the pet must KEEP WAITING on row 6. This step should NOT show a "push" line below.
if "%~1"=="8" echo NOTE: the bubble above the pet should now carry a "+1" badge.
if "%~1"=="9" echo NOTE: the "+1" badge should be gone.
echo Current status file:
node "tools\pet-hook.mjs" --list
echo.
echo Now look at the pet, then press the next number.
exit /b 0

:dlist
node "tools\pet-hook.mjs" --list
echo.
exit /b 0

:dquit
set "QUIT=1"
exit /b 0

rem Every exit path lands here: Q, a bare Enter, or EOF on stdin.
:done
echo Bye. To quit the pet, close the pet's own window.
endlocal
exit /b 0

:oneshot
if /i "%~1"=="clear" (
  node "tools\pet-hook.mjs" --clear --title=manual-acceptance
) else (
  node "tools\pet-hook.mjs" %~1 --title=manual-acceptance
)
endlocal
exit /b %errorlevel%
