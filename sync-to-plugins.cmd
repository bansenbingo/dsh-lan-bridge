@echo off
setlocal
rem Sync the source in this workspace into the plugin folder that DSH loads.
set "SRC=%~dp0"
set "DST=%USERPROFILE%\.dsh\plugins\dsh-lan-bridge"

if not exist "%DST%" mkdir "%DST%"

robocopy "%SRC%." "%DST%" /E /XD .git dist /XF .gitignore .gitattributes sync-to-plugins.cmd /NFL /NDL /NJH /NJS /NP
if errorlevel 8 (
  echo [FAILED] robocopy errorlevel %errorlevel%
  exit /b 1
)

echo [OK] synced to %DST%
echo Restart DSH to take effect.
