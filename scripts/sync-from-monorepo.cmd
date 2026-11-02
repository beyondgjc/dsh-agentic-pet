@echo off
setlocal EnableExtensions
rem Sync sources and build outputs from the dsh monorepo (dev upstream) into
rem this release repo. Run AFTER `pnpm run build` (root, for the plugin lib)
rem and `pnpm --filter @deepseek-ai/dsh-pet run build` (carrier lib + renderer).
rem
rem Every path derives from %~dp0, so the caller's working directory is
rem irrelevant -- this script has no cwd dependency. (The previous inline
rem `node -e` read process.cwd(), so it patched whatever package.json the
rem caller happened to be standing in, and had been failing with a syntax
rem error since a broken edit while cmd carried on regardless.)
rem
rem ASCII only: cmd reads this file in the OEM code page, where a UTF-8
rem multi-byte sequence can swallow the following CR and split a comment
rem into bogus commands.
rem
rem Deliberately NOT synced (independently maintained here):
rem   package.json `version` - the release version is owned by THIS repo;
rem     sync-package-json.mjs mirrors every other field and keeps it.
rem   tsdown.config.ts   - points at ./vendor/typert-plugin/ in this repo
rem   tsconfig.json      - archival mirror without monorepo references
rem   carrier-src/package.json - mirrored for reference, never installed here
rem   README.* - the release-repo home page is written here; the
rem     monorepo copy stays a package-pointer.
rem Skipped by nature: node_modules, *.tgz, carrier/assets (media lives in
rem dsh-pet-assets), tsc intermediates.

set "MONO=%~dp0..\..\dsh\deepseek-harness"
set "HERE=%~dp0.."
set "UPSTREAM=%MONO%\packages\bundle\pet-app"
set "CARRIER_UPSTREAM=%MONO%\apps\pet"

if not exist "%UPSTREAM%\package.json" (
  echo sync: monorepo package not found at "%UPSTREAM%"
  echo sync: expected the dsh checkout at "%MONO%"
  exit /b 1
)
if not exist "%HERE%\package.json" (
  echo sync: release package.json not found at "%HERE%\package.json"
  exit /b 1
)

rem -- plugin sources --------------------------------------------------------
call :mirror "%UPSTREAM%\src" "%HERE%\src" || exit /b 1
call :mirror "%UPSTREAM%\client" "%HERE%\client" || exit /b 1
call :mirror "%UPSTREAM%\tests" "%HERE%\tests" || exit /b 1
call :copyfile "%UPSTREAM%\cordis.patch.yml" "%HERE%\cordis.patch.yml" || exit /b 1
node "%~dp0sync-package-json.mjs" "%UPSTREAM%\package.json" "%HERE%\package.json" || exit /b 1

rem -- plugin build outputs -------------------------------------------------
rem whole lib/ tree /MIR: dual tsdown entries emit index.js + tools.js + a
rem hashed shared chunk. tsdown runs with clean:false, so a rebuild of changed
rem sources can leave the PREVIOUS chunk next to the new one -- the /MIR below
rem is what removes it here.
call :mirror "%UPSTREAM%\lib" "%HERE%\lib" || exit /b 1
call :mirror "%UPSTREAM%\presets" "%HERE%\presets" || exit /b 1

rem -- carrier build outputs (release artifacts) ----------------------------
call :mirror "%UPSTREAM%\carrier\lib" "%HERE%\carrier\lib" || exit /b 1
call :mirror "%UPSTREAM%\carrier\dist-renderer" "%HERE%\carrier\dist-renderer" || exit /b 1
call :copyfile "%UPSTREAM%\carrier\package.json" "%HERE%\carrier\package.json" || exit /b 1

rem -- carrier sources (mirror) ---------------------------------------------
call :mirror "%CARRIER_UPSTREAM%\src" "%HERE%\carrier-src\src" || exit /b 1
call :mirror "%CARRIER_UPSTREAM%\scripts" "%HERE%\carrier-src\scripts" || exit /b 1
call :copyfile "%CARRIER_UPSTREAM%\vite.config.ts" "%HERE%\carrier-src\vite.config.ts" || exit /b 1
call :copyfile "%CARRIER_UPSTREAM%\tsconfig.json" "%HERE%\carrier-src\tsconfig.json" || exit /b 1
call :copyfile "%CARRIER_UPSTREAM%\tsconfig.renderer.json" "%HERE%\carrier-src\tsconfig.renderer.json" || exit /b 1
call :copyfile "%CARRIER_UPSTREAM%\package.json" "%HERE%\carrier-src\package.json" || exit /b 1

echo sync complete: sources and outputs mirrored from the monorepo.
exit /b 0

:mirror
robocopy "%~1" "%~2" /MIR /NFL /NDL /NJH /NJS
rem robocopy: 0-7 are success codes, 8 and up are failures.
if errorlevel 8 (
  echo sync: robocopy failed for "%~1"
  exit /b 1
)
exit /b 0

rem One file, failing loud (a bare `copy` reports and carries on).
:copyfile
copy /y "%~1" "%~2" >nul
if errorlevel 1 (
  echo sync: copy failed for "%~1"
  exit /b 1
)
exit /b 0
