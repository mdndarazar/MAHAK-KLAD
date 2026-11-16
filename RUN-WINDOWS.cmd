@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || (echo ERROR: Cannot open the source folder. & exit /b 1)
if not exist "package.json" goto :missing
if not exist "package-lock.json" goto :missing
if not exist "prisma\migrations\0_init\migration.sql" goto :missing
if not exist "node_modules\.bin\electron-vite.cmd" goto :missingdeps
where node.exe >nul 2>&1 || goto :nodeerror
where npm.cmd >nul 2>&1 || goto :nodeerror
node -e "if(process.versions.node.split('.')[0]!=='24'||process.arch!=='x64')process.exit(1)" || goto :nodeerror
rem An overridden database URL can differ from the migration and backup paths.
rem Refuse it rather than silently touching two different databases.
if defined DATABASE_URL goto :databaseconfig
if exist ".env" goto :databaseconfig
if exist ".env.local" goto :databaseconfig
if exist ".env.development" goto :databaseconfig
if exist ".env.development.local" goto :databaseconfig
if exist "prisma\.env" goto :databaseconfig
echo WARNING: This starts the desktop app using its existing user-data folder.
echo The app may apply migrations or update existing data. This is NOT an isolated test.
echo First make a backup from inside the installed app and close the other instance.
choice /c YN /n /m "Have you backed up and want to continue? [Y/N] "
if errorlevel 2 goto :cancelled
if errorlevel 1 goto :confirmed
goto :cancelled
:confirmed
call npm.cmd run dev
if errorlevel 1 goto :failed
popd
exit /b 0
:cancelled
echo Start cancelled. No application was started.
popd
exit /b 1
:databaseconfig
echo ERROR: DATABASE_URL or a local environment file exists. Startup was stopped to avoid different database paths.
echo Do not delete any data or configuration. Ask for help before proceeding.
popd
exit /b 1
:missing
echo ERROR: Source files or migrations are missing. Extract the complete source ZIP.
popd
exit /b 1
:missingdeps
echo ERROR: Dependencies are missing. Run SETUP-WINDOWS.cmd first.
popd
exit /b 1
:nodeerror
echo ERROR: Node.js 24 x64 and npm are required. Restart CMD after installing them.
popd
exit /b 1
:failed
echo ERROR: The application did not start successfully. Read the errors above.
popd
exit /b 1
