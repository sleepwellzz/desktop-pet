@echo off
rem Keep this file ASCII-only: cmd reads .bat as GBK, Chinese text breaks the syntax.
rem Also always call npm.cmd (with extension) -- call "npm" fails on Windows.
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\nodejs"

echo ==========================================
echo  desktop-pet : build and start
echo ==========================================
echo.
echo [1/2] building TypeScript...
call npm.cmd run build
if errorlevel 1 goto :fail

echo.
echo [2/2] starting the pet (bottom-right corner).
echo       Close this window to quit the pet.
echo.
call npm.cmd start

echo.
echo Pet exited.
pause
exit /b 0

:fail
echo.
echo BUILD FAILED - send the message above to Buddy.
pause
exit /b 1
