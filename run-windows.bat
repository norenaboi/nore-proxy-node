@echo off
echo Setting up Nore Proxy...

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js is not installed. Please install Node.js from https://nodejs.org/
    echo After installation, run this script again.
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
    echo Node.js is already installed: %NODE_VERSION%
)

REM Check if npm is installed
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo npm is not installed. Please install Node.js from https://nodejs.org/
    echo npm is included with the Node.js installer.
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('npm -v') do set NPM_VERSION=%%i
    echo npm is already installed: %NPM_VERSION%
)

REM Get the directory where the script is located
cd /d "%~dp0"

REM Install dependencies if node_modules doesn't exist
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

REM Start the application
echo Starting Nore Proxy...
call npm run start

exit /b 0
