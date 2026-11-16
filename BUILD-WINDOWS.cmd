@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || (echo ERROR: Cannot open the source folder. & exit /b 1)
if not exist "package.json" goto :missing
if not exist "package-lock.json" goto :missing
if not exist "prisma\schema.prisma" goto :missing
if not exist "prisma\migrations\0_init\migration.sql" goto :missing
if not exist "node_modules\.bin\electron-vite.cmd" goto :missingdeps
where node.exe >nul 2>&1 || goto :nodeerror
where npm.cmd >nul 2>&1 || goto :nodeerror
node -e "if(process.versions.node.split('.')[0]!=='24'||process.arch!=='x64')process.exit(1)" || goto :nodeerror
rem Used for code generation only. Do not run migrations here.
set "DATABASE_URL=file:./unused-generation.db"
echo Checking types before building the Windows installer.
call npm.cmd run typecheck
if errorlevel 1 goto :failed
echo Building the x64 installer. Internet may be required.
call npm.cmd run dist:win -- --publish never
if errorlevel 1 goto :failed
echo Build completed. Check the dist folder for the installer.
popd
exit /b 0
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
echo ERROR: Validation or build failed. Read the errors above.
popd
exit /b 1
