@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || (echo ERROR: Cannot open the source folder. & exit /b 1)
if not exist "package.json" goto :missing
if not exist "package-lock.json" goto :missing
if not exist "prisma\schema.prisma" goto :missing
if not exist "prisma\migrations\0_init\migration.sql" goto :missing
where node.exe >nul 2>&1 || goto :nodeerror
where npm.cmd >nul 2>&1 || goto :nodeerror
node -e "if(process.versions.node.split('.')[0]!=='24'||process.arch!=='x64')process.exit(1)" || goto :nodeerror
rem This value is used only for dependency installation and client generation.
rem Neither command runs migrations or connects the application to a database.
set "DATABASE_URL=file:./unused-generation.db"
echo Installing locked dependencies. Internet is required.
call npm.cmd ci
if errorlevel 1 goto :failed
echo Generating Prisma client.
call npm.cmd run db:generate
if errorlevel 1 goto :failed
echo Setup finished. Remote features are not automatically enabled.
popd
exit /b 0
:missing
echo ERROR: Source files or migrations are missing. Extract the complete source ZIP.
popd
exit /b 1
:nodeerror
echo ERROR: Node.js 24 x64 and npm are required. Restart CMD after installing them.
popd
exit /b 1
:failed
echo ERROR: Setup failed. Read the errors above; no database or lockfile was deleted.
popd
exit /b 1
