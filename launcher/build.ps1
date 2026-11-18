# Compile Relais.exe (à la racine du dossier relais) avec le compilateur C# fourni avec Windows.
# Usage : powershell -ExecutionPolicy Bypass -File launcher\build.ps1
param([string]$Out = (Join-Path (Split-Path $PSScriptRoot -Parent) 'Relais.exe'))

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "Compilateur C# (.NET Framework 4) introuvable." }

$lib = Join-Path $PSScriptRoot 'lib'
$ico = Join-Path $PSScriptRoot 'relais.ico'
if (-not (Test-Path $ico)) { & (Join-Path $PSScriptRoot 'make-icon.ps1') -Out $ico | Out-Null }

& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$Out" "/win32icon:$ico" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  "/r:$lib\Microsoft.Web.WebView2.Core.dll" "/r:$lib\Microsoft.Web.WebView2.WinForms.dll" `
  (Join-Path $PSScriptRoot 'Relais.cs')
if ($LASTEXITCODE -ne 0) { throw "Échec de la compilation." }
"Relais.exe créé : $Out"
