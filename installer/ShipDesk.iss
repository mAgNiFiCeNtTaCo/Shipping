; Ship Desk for Windows: the installer (Inno Setup 6). Built by tools/build_installer.py, which puts Ship Desk,
; its own copy of Python, the icon, the guide and the licence notices in build\stage and runs:
;   ISCC.exe /DAppVersion=1.0.0 /DStage=<build\stage> installer\ShipDesk.iss   ->  dist\ShipDesk-Setup-1.0.0.exe
;
; Installs for the current Windows user only (no admin): %LOCALAPPDATA%\Programs\Ship Desk. Setup asks where Ship
; Desk keeps its files (default Documents\Ship Desk) and writes that to {app}\install.json for serve.py.
; Uninstalling removes Ship Desk's Windows entries only when they point at this copy, and asks before deleting the
; files it made.
; Silent install: ShipDesk-Setup-1.0.0.exe /VERYSILENT /DATADIR="<files folder>" /TASKS="autostart,desktopicon"

#define AppName "Ship Desk"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef Stage
  #define Stage "..\build\stage"
#endif
#define Pyw "{app}\python\pythonw.exe"
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"

[Setup]
AppId={{DCB21337-BAB7-4D0E-8DC3-AB9337DB42BB}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Ship Desk
AppComments=Labels, packing slips, a shipping plan and the mark-shipped file for TCGplayer orders. Runs on this PC.
DefaultDirName={autopf}\Ship Desk
DefaultGroupName=Ship Desk
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=ShipDesk-Setup-{#AppVersion}
SetupIconFile={#Stage}\shipdesk.ico
UninstallDisplayIcon={app}\shipdesk.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Put a Ship Desk icon on the desktop"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start Ship Desk in the background when I sign in to Windows (it can be changed later at the top of the Ship Desk page)"; GroupDescription: "Starting:"
Name: "phonesetup"; Description: "Help me set up phone photos and label scanning when setup finishes (installs Tailscale, free)"; GroupDescription: "Phone:"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Ship Desk"; Filename: "{#Pyw}"; Parameters: """{app}\serve.py"""; WorkingDir: "{app}"; IconFilename: "{app}\shipdesk.ico"; Comment: "Open Ship Desk (starts it if it's off)"
Name: "{group}\Turn off Ship Desk"; Filename: "{#Pyw}"; Parameters: """{app}\serve.py"" --stop"; WorkingDir: "{app}"; IconFilename: "{app}\shipdesk.ico"; Comment: "Stop Ship Desk running in the background"
Name: "{group}\Ship Desk files"; Filename: "{code:GetDataDir}"; Comment: "The labels, slips, photos and other files Ship Desk made"
Name: "{group}\Ship Desk guide"; Filename: "{app}\Ship Desk guide.html"
Name: "{autodesktop}\Ship Desk"; Filename: "{#Pyw}"; Parameters: """{app}\serve.py"""; WorkingDir: "{app}"; IconFilename: "{app}\shipdesk.ico"; Comment: "Open Ship Desk"; Tasks: desktopicon

[Registry]
; The same entry Ship Desk's own "Start with Windows" box writes (serve.py launcher_command()).
Root: HKCU; Subkey: "{#RunKey}"; ValueType: string; ValueName: "Ship Desk"; ValueData: """{#Pyw}"" ""{app}\serve.py"" --no-browser"; Tasks: autostart

[Run]
Filename: "{#Pyw}"; Parameters: """{app}\serve.py"""; WorkingDir: "{app}"; Description: "Open Ship Desk now"; Flags: postinstall nowait skipifsilent; Tasks: not phonesetup
Filename: "{#Pyw}"; Parameters: """{app}\serve.py"" --open phone"; WorkingDir: "{app}"; Description: "Open Ship Desk and set up the phone now"; Flags: postinstall nowait skipifsilent; Tasks: phonesetup
Filename: "{app}\Ship Desk guide.html"; Description: "Read the Ship Desk guide"; Flags: postinstall shellexec nowait skipifsilent unchecked

[UninstallDelete]
Type: files; Name: "{app}\install.json"
Type: filesandordirs; Name: "{app}\__pycache__"

[Code]
var
  DataPage: TInputDirWizardPage;

procedure InitializeWizard;
begin
  DataPage := CreateInputDirPage(wpSelectDir,
    'Where should Ship Desk keep your files?',
    'Labels, packing slips, TCGplayer import files, phone photos and the History copy.',
    'Ship Desk saves the files it makes into this folder (not into Downloads). Pick a folder you can find and that ' +
    'your backups include. Then click Next.', False, '');
  DataPage.Add('');
  DataPage.Values[0] := GetPreviousData('DataDir', ExpandConstant('{userdocs}\Ship Desk'));
  { ShipDesk-Setup.exe /DATADIR="D:\Shipping files" sets it from the command line (silent installs, tests). }
  if ExpandConstant('{param:DATADIR}') <> '' then
    DataPage.Values[0] := ExpandConstant('{param:DATADIR}');
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'DataDir', DataPage.Values[0]);
end;

function GetDataDir(Param: String): String;
begin
  Result := DataPage.Values[0];
end;

function JsonText(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := '"' + S + '"';
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo,
  MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := MemoDirInfo + NewLine + NewLine + 'Your files:' + NewLine + Space + DataPage.Values[0];
  if MemoTasksInfo <> '' then
    Result := Result + NewLine + NewLine + MemoTasksInfo;
end;

{ An update: turn off the Ship Desk that's running from this folder first, so its files can be replaced. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\python\python.exe')) and FileExists(ExpandConstant('{app}\serve.py')) then
    Exec(ExpandConstant('{app}\python\python.exe'), '"' + ExpandConstant('{app}\serve.py') + '" --stop',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    ForceDirectories(DataPage.Values[0]);
    SaveStringToFile(ExpandConstant('{app}\install.json'),
      '{"dataDir": ' + JsonText(DataPage.Values[0]) + ', "version": "{#AppVersion}"}' + #13#10, False);
  end;
end;

{ Read where this copy kept its files (install.json) for the question at the end of uninstalling. }
function InstalledDataDir: String;
var
  S: AnsiString;
  P, Q: Integer;
begin
  Result := '';
  if LoadStringFromFile(ExpandConstant('{app}\install.json'), S) then
  begin
    P := Pos('"dataDir": "', S);
    if P > 0 then
    begin
      S := Copy(S, P + 12, Length(S));
      Q := Pos('", "', S);
      if Q > 0 then
      begin
        Result := Copy(S, 1, Q - 1);
        StringChangeEx(Result, '\\', '\', True);
        StringChangeEx(Result, '\"', '"', True);
      end;
    end;
  end;
end;

function PointsHere(Value: String): Boolean;
begin
  Result := Pos(Lowercase(ExpandConstant('{app}\')), Lowercase(Value)) > 0;
end;

var
  UninstallDataDir: String;

{ Delete only what Ship Desk itself makes in the files folder (someone may have picked a folder with other things in it). }
procedure DeleteShipDeskFiles(Dir: String);
var
  Folders: TArrayOfString;
  I: Integer;
begin
  SetArrayLength(Folders, 8);
  Folders[0] := 'Labels'; Folders[1] := 'Packing slips'; Folders[2] := 'TCGplayer import files'; Folders[3] := 'Pirate Ship';
  Folders[4] := 'History'; Folders[5] := 'Proof packs'; Folders[6] := 'Photos'; Folders[7] := 'Phone';
  for I := 0 to GetArrayLength(Folders) - 1 do
    DelTree(AddBackslash(Dir) + Folders[I], True, True, True);
  DeleteFile(AddBackslash(Dir) + 'backup.json');
  DeleteFile(AddBackslash(Dir) + 'update.json');
  DeleteFile(AddBackslash(Dir) + 'ship-desk.log');
  DeleteFile(AddBackslash(Dir) + 'ship-desk.log.old');
  RemoveDir(Dir); { only goes when nothing else is left in it }
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Value: String;
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    UninstallDataDir := InstalledDataDir;
    { Turn this copy off (another copy of Ship Desk on this PC is left running). }
    if FileExists(ExpandConstant('{app}\python\python.exe')) then
      Exec(ExpandConstant('{app}\python\python.exe'), '"' + ExpandConstant('{app}\serve.py') + '" --stop',
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
    { Ship Desk's Windows entries, only when they start this copy. }
    if RegQueryStringValue(HKCU, '{#RunKey}', 'Ship Desk', Value) and PointsHere(Value) then
      RegDeleteValue(HKCU, '{#RunKey}', 'Ship Desk');
    if RegQueryStringValue(HKCU, 'Software\Classes\shipdesk\shell\open\command', '', Value) and PointsHere(Value) then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\shipdesk');
  end;
  if (CurUninstallStep = usPostUninstall) and (UninstallDataDir <> '') and DirExists(UninstallDataDir) and not UninstallSilent then
  begin
    if MsgBox('Ship Desk is removed.' + #13#10 + #13#10 +
      'Also delete the files it made (labels, packing slips, import files, phone photos, the History copy)?' + #13#10 +
      UninstallDataDir + #13#10 + #13#10 + 'Click No to keep them.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DeleteShipDeskFiles(UninstallDataDir);
  end;
end;
