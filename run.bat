@echo off
setlocal EnableExtensions
title Site Scraper
pushd "%~dp0"

rem Usage: run.bat [url] [options]   (options are passed to the scraper)

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "GREEN=%ESC%[92m"
set "RED=%ESC%[91m"
set "CYAN=%ESC%[96m"
set "GRAY=%ESC%[90m"
set "RESET=%ESC%[0m"
set "RC=0"

rem ---- detect runtimes --------------------------------------------------
rem "python" may be the Microsoft Store stub, so test by running it, not with "where".
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (python --version >nul 2>&1 && set "PY=python")
if defined PY for /f "tokens=2" %%v in ('%PY% --version 2^>^&1') do set "PYVER=%%v"

set "NODEVER="
for /f %%v in ('node --version 2^>nul') do set "NODEVER=%%v"

set "DEFAULT="
if defined NODEVER set "DEFAULT=2"
if defined PY set "DEFAULT=1"

if defined PY (set "PY_STATUS=%GREEN%installed, Python %PYVER%%RESET%") else (set "PY_STATUS=%RED%not installed%RESET%")
if defined NODEVER (set "NODE_STATUS=%GREEN%installed, Node.js %NODEVER%%RESET%") else (set "NODE_STATUS=%RED%not installed%RESET%")
set "PY_TAG="
set "NODE_TAG="
if "%DEFAULT%"=="1" set "PY_TAG=  %GREEN%(recommended)%RESET%"
if "%DEFAULT%"=="2" set "NODE_TAG=  %GREEN%(recommended)%RESET%"

rem ---- menu --------------------------------------------------------------
echo.
echo   %CYAN%Site Scraper%RESET%
echo   %GRAY%Crawl every page of a website and save it to scraped_site\%RESET%
echo.
echo   [1] Python    %PY_STATUS%%PY_TAG%
echo   [2] Node.js   %NODE_STATUS%%NODE_TAG%
echo.

if not defined DEFAULT (
    echo   %RED%Neither Python nor Node.js was found.%RESET%
    echo   Install one of them, then run this file again:
    echo     Python:  https://www.python.org/downloads/
    echo     Node.js: https://nodejs.org/
    set "RC=1"
    goto end
)

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
if not defined PY (
    echo   %RED%Python is not installed.%RESET% Get it from https://www.python.org/downloads/
    goto ask
)
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
if not exist "node\node_modules\cheerio" (
    echo.
    echo   %CYAN%Installing Node.js dependencies...%RESET%
    call npm --prefix node install
    if errorlevel 1 goto deps_failed
)
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
