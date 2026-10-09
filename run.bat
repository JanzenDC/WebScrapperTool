@echo off
setlocal EnableExtensions
title Site Scraper
pushd "%~dp0"

rem Usage: run.bat [url] [options]   (options are passed to the scraper)

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "GREEN=%ESC%[92m"
set "RED=%ESC%[91m"
set "YELLOW=%ESC%[93m"
set "CYAN=%ESC%[96m"
set "GRAY=%ESC%[90m"
set "RESET=%ESC%[0m"
set "RC=0"

rem Python offered for install when it's missing (winget first, python.org installer as fallback)
set "PY_WINGET_ID=Python.Python.3.13"
set "PY_FALLBACK_VERSION=3.13.7"

rem ---- detect runtimes --------------------------------------------------
call :find_python
if defined PY call :python_version

set "NODEVER="
for /f %%v in ('node --version 2^>nul') do set "NODEVER=%%v"

rem ---- make sure the Node.js modules are installed ------------------------
set "NODE_DEPS_OK="
if defined NODEVER call :ensure_node_modules

set "DEFAULT=1"
if not defined PY if defined NODEVER set "DEFAULT=2"

if defined PY (set "PY_STATUS=%GREEN%installed, Python %PYVER%%RESET%") else (set "PY_STATUS=%RED%not installed%RESET%  %GRAY%choose 1 to download and install it%RESET%")
if defined NODEVER (set "NODE_STATUS=%GREEN%installed, Node.js %NODEVER%%RESET%") else (set "NODE_STATUS=%RED%not installed%RESET%")
if defined NODEVER if not defined NODE_DEPS_OK set "NODE_STATUS=%NODE_STATUS%  %RED%modules missing%RESET%"
set "PY_TAG="
set "NODE_TAG="
if "%DEFAULT%"=="1" if defined PY set "PY_TAG=  %GREEN%(recommended)%RESET%"
if "%DEFAULT%"=="2" set "NODE_TAG=  %GREEN%(recommended)%RESET%"

rem ---- menu --------------------------------------------------------------
echo.
echo   %CYAN%Site Scraper%RESET%
echo   %GRAY%Crawl every page of a website and save it to scraped_site\%RESET%
echo.
echo   [1] Python    %PY_STATUS%%PY_TAG%
echo   [2] Node.js   %NODE_STATUS%%NODE_TAG%
echo.

:ask
set "CHOICE="
set /p "CHOICE=  Choose 1 or 2, Q to quit [Enter = %DEFAULT%]: "
if not defined CHOICE set "CHOICE=%DEFAULT%"
if /i "%CHOICE%"=="q" goto end
if "%CHOICE%"=="1" goto run_python
if "%CHOICE%"=="2" goto run_node
echo   %RED%Invalid choice.%RESET%
goto ask

rem ---- python ------------------------------------------------------------
:run_python
if not defined PY call :install_python
if not defined PY goto ask
%PY% -c "import requests, bs4" >nul 2>&1
if errorlevel 1 (
    echo.
    echo   %CYAN%Installing Python dependencies...%RESET%
    %PY% -m pip install -r python\requirements.txt
    if errorlevel 1 goto deps_failed
)
echo.
%PY% python\site_scraper.py %*
set "RC=%errorlevel%"
goto end

rem ---- node --------------------------------------------------------------
:run_node
if not defined NODEVER (
    echo   %RED%Node.js is not installed.%RESET% Get it from https://nodejs.org/
    goto ask
)
if not defined NODE_DEPS_OK call :ensure_node_modules
if not defined NODE_DEPS_OK goto deps_failed
echo.
node node\site_scraper.js %*
set "RC=%errorlevel%"
goto end

:deps_failed
echo   %RED%Installing dependencies failed. See the messages above.%RESET%
set "RC=1"

:end
echo.
popd
pause
exit /b %RC%

rem ---- subroutines -------------------------------------------------------
:find_python
rem Sets PY to a working Python 3 command, or leaves it empty.
rem "python" may be the Microsoft Store stub, so test by running it, not with "where".
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if defined PY exit /b 0
python --version >nul 2>&1 && set "PY=python"
if defined PY exit /b 0
rem A Python installed while this window is open isn't on its PATH yet, so check the default per-user location.
for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%~d\python.exe" set PY="%%~d\python.exe"
exit /b 0

:python_version
%PY% --version > "%TEMP%\site_scraper_pyver.txt" 2>&1
set /p PYVER=<"%TEMP%\site_scraper_pyver.txt"
del "%TEMP%\site_scraper_pyver.txt" >nul 2>&1
set "PYVER=%PYVER:Python =%"
exit /b 0

:install_python
echo.
echo   %YELLOW%Python is not installed.%RESET%
set "ANSWER="
set /p "ANSWER=  Download and install Python 3.13 now? [Y/n]: "
if /i "%ANSWER%"=="n" exit /b 1
if /i "%ANSWER%"=="no" exit /b 1

where winget >nul 2>&1
if errorlevel 1 goto install_python_direct
echo.
echo   %CYAN%Installing Python with winget...%RESET%
winget install --exact --id %PY_WINGET_ID% --scope user --silent --accept-package-agreements --accept-source-agreements
call :find_python
if defined PY goto install_python_done
echo   %YELLOW%winget did not finish the install. Trying the python.org installer instead.%RESET%

:install_python_direct
set "PY_ARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PY_ARCH=arm64"
set "PY_INSTALLER=python-%PY_FALLBACK_VERSION%-%PY_ARCH%.exe"
echo.
echo   %CYAN%Downloading %PY_INSTALLER% from python.org...%RESET%
curl -L --fail --progress-bar -o "%TEMP%\%PY_INSTALLER%" "https://www.python.org/ftp/python/%PY_FALLBACK_VERSION%/%PY_INSTALLER%"
if errorlevel 1 goto install_python_failed
echo   %CYAN%Installing Python %PY_FALLBACK_VERSION%. This can take a minute...%RESET%
"%TEMP%\%PY_INSTALLER%" /quiet InstallAllUsers=0 InstallLauncherAllUsers=0 Include_launcher=1 PrependPath=1 Include_test=0
del "%TEMP%\%PY_INSTALLER%" >nul 2>&1
call :find_python
if not defined PY goto install_python_failed

:install_python_done
call :python_version
echo   %GREEN%Python %PYVER% installed.%RESET%
exit /b 0

:install_python_failed
echo   %RED%Python could not be installed automatically.%RESET%
echo   Install it from https://www.python.org/downloads/ and run this file again.
exit /b 1

:ensure_node_modules
rem Sets NODE_DEPS_OK when every dependency in node\package.json is installed.
set "NODE_DEPS_OK="
call :node_deps_present
if defined NODE_DEPS_OK exit /b 0
echo.
echo   %CYAN%Node.js modules are missing. Running npm install...%RESET%
call npm --prefix node install
if errorlevel 1 (
    echo   %RED%npm install failed. See the messages above.%RESET%
    exit /b 1
)
call :node_deps_present
if defined NODE_DEPS_OK (
    echo   %GREEN%Node.js modules installed.%RESET%
) else (
    echo   %RED%npm install finished but some modules are still missing.%RESET%
)
exit /b 0

:node_deps_present
set "NODE_DEPS_OK="
node -e "const p=require('./node/package.json');const fs=require('fs');process.exit(Object.keys(p.dependencies||{}).every(d=>fs.existsSync('node/node_modules/'+d+'/package.json'))?0:1)" >nul 2>&1
if not errorlevel 1 set "NODE_DEPS_OK=1"
exit /b 0
