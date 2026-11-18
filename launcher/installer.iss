; Installateur Windows de Relais (Inno Setup 6).
; Compilé automatiquement par GitHub Actions (.github/workflows/release.yml).
; Installation par utilisateur, sans droits administrateur : Relais écrit ses données
; (connexions, conversations, outils) dans son propre dossier, qui doit rester modifiable.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\Relais"
#endif

[Setup]
AppId={{6E1C2B7A-3F5D-4C8E-9A41-52E0B1D7C9A3}
AppName=Relais
AppVersion={#AppVersion}
AppVerName=Relais {#AppVersion}
AppPublisher=Relais
AppPublisherURL=https://github.com/Underspace1/relais
AppSupportURL=https://github.com/Underspace1/relais/issues
DefaultDirName={localappdata}\Programs\Relais
DefaultGroupName=Relais
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\dist
OutputBaseFilename=Relais-Setup
SetupIconFile=relais.ico
UninstallDisplayIcon={app}\Relais.exe
UninstallDisplayName=Relais
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le Bureau"; GroupDescription: "Raccourcis :"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2

[Icons]
Name: "{autoprograms}\Relais"; Filename: "{app}\Relais.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Relais"; Filename: "{app}\Relais.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; WebView2 (le moteur d'affichage d'Edge) est déjà présent sur Windows 11 ; on l'installe s'il manque.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installation de Microsoft Edge WebView2…"; Check: NeedsWebView2; Flags: waituntilterminated
Filename: "{app}\Relais.exe"; Description: "Lancer Relais"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Arrête Relais (et son serveur) avant la désinstallation
Filename: "{sys}\taskkill.exe"; Parameters: "/IM Relais.exe /T /F"; Flags: runhidden; RunOnceId: "StopRelais"

[UninstallDelete]
; Les outils téléchargés sont supprimés ; tes données (data\) sont conservées sauf si tu supprimes le dossier.
Type: filesandordirs; Name: "{app}\tools"

[Code]
function WebView2Installed(): Boolean;
var
  V: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

function NeedsWebView2(): Boolean;
begin
  Result := not WebView2Installed();
end;
