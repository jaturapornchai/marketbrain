Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
rootDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = rootDir
sh.Run "cmd /c node deploy\run-all.mjs >> .data\marketbrain.log 2>&1", 0, False
