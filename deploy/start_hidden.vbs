' Persistent background launcher for MarketBrain (https://marketbrain.bcsmethai.com)
' Rotates .data\marketbrain.log at 5 MB and runs deploy\run-all.mjs with no console window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
rootDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = rootDir
dataDir = rootDir & "\.data"
If Not fso.FolderExists(dataDir) Then fso.CreateFolder(dataDir)
logPath = dataDir & "\marketbrain.log"
oldPath = dataDir & "\marketbrain.old.log"

For i = 1 To 5
    If fso.FileExists(logPath) Then
        If fso.GetFile(logPath).Size > 5242880 Then
            On Error Resume Next
            If fso.FileExists(oldPath) Then fso.DeleteFile oldPath, True
            fso.MoveFile logPath, oldPath
            On Error GoTo 0
        End If
    End If
    sh.Run "cmd /c node deploy\run-all.mjs >> .data\marketbrain.log 2>&1", 0, True
    WScript.Sleep 15000
Next
