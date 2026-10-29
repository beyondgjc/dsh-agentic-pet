@echo off
rem Sync sources and build outputs from the dsh monorepo (dev upstream) into
rem this release repo. Run AFTER `pnpm run build` (root, for the plugin lib)
rem and `pnpm --filter @deepseek-ai/dsh-pet run build` (carrier lib + renderer).
rem
rem Deliberately NOT synced (independently maintained here):
rem   tsdown.config.ts   - points at ./vendor/typert-plugin/ in this repo
rem   tsconfig.json      - archival mirror without monorepo references
rem   carrier-src/package.json - mirrored for reference, never installed here
rem   README.* - the release-repo home page is written here; the
rem     monorepo copy stays a package-pointer.
rem Skipped by nature: node_modules, *.tgz, carrier/assets (media lives in
rem dsh-pet-assets), tsc intermediates.

set MONO=%~dp0..\..\dsh\deepseek-harness
set HERE=%~dp0..

rem ── plugin sources ────────────────────────────────────────────────────────
robocopy "%MONO%\packages\bundle\pet-app\src" "%HERE%\src" /MIR /NFL /NDL /NJH /NJS
robocopy "%MONO%\packages\bundle\pet-app\client" "%HERE%\client" /MIR /NFL /NDL /NJH /NJS
robocopy "%MONO%\packages\bundle\pet-app\tests" "%HERE%\tests" /MIR /NFL /NDL /NJH /NJS
copy /y "%MONO%\packages\bundle\pet-app\cordis.patch.yml" "%HERE%\cordis.patch.yml" >nul
copy /y "%MONO%\packages\bundle\pet-app\package.json" "%HERE%\package.json" >nul
node -e "const fs=require('fs');const f=process.cwd()+'/package.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));j.devDependencies['@deepseek-ai/cordis']='^4.0.5';j.devDependencies.vitest=j.devDependencies.vitest||'^4.1.11';fs.writeFileSync(f,JSON.stringify(j,null,2)+'
')"

rem ── plugin build outputs ──────────────────────────────────────────────────
rem whole lib/ tree /MIR: dual tsdown entries emit index.js + tools.js + a
rem hashed shared chunk; presets/ carries the pet preset declaration.
robocopy "%MONO%\packages\bundle\pet-app\lib" "%HERE%\lib" /MIR /NFL /NDL /NJH /NJS
robocopy "%MONO%\packages\bundle\pet-app\presets" "%HERE%\presets" /MIR /NFL /NDL /NJH /NJS
robocopy "%MONO%\packages\bundle\pet-app\lib\types" "%HERE%\lib\types" /MIR /NFL /NDL /NJH /NJS

rem ── carrier build outputs (release artifacts) ────────────────────────────
robocopy "%MONO%\packages\bundle\pet-app\carrier\lib" "%HERE%\carrier\lib" /MIR /NFL /NDL /NJH /NJS
robocopy "%MONO%\packages\bundle\pet-app\carrier\dist-renderer" "%HERE%\carrier\dist-renderer" /MIR /NFL /NDL /NJH /NJS
copy /y "%MONO%\packages\bundle\pet-app\carrier\package.json" "%HERE%\carrier\package.json" >nul
')"

rem ── carrier sources (mirror) ──────────────────────────────────────────────
robocopy "%MONO%\apps\pet\src" "%HERE%\carrier-src\src" /MIR /NFL /NDL /NJH /NJS
robocopy "%MONO%\apps\pet\scripts" "%HERE%\carrier-src\scripts" /MIR /NFL /NDL /NJH /NJS
copy /y "%MONO%\apps\pet\vite.config.ts" "%HERE%\carrier-src\vite.config.ts" >nul
copy /y "%MONO%\apps\pet\tsconfig.json" "%HERE%\carrier-src\tsconfig.json" >nul
copy /y "%MONO%\apps\pet\tsconfig.renderer.json" "%HERE%\carrier-src\tsconfig.renderer.json" >nul
copy /y "%MONO%\apps\pet\package.json" "%HERE%\carrier-src\package.json" >nul

echo sync complete: sources and outputs mirrored from the monorepo.
