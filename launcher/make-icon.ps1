# Génère relais.ico (16 à 256 px) : carré sombre arrondi avec les trois points des IA.
param([string]$Out = "$PSScriptRoot\relais.ico")
Add-Type -AssemblyName System.Drawing

function New-Png([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [Math]::Max(2, [int]($size * 0.24))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 18, 18, 20))), $path)
  $colors = @([System.Drawing.Color]::FromArgb(255, 224, 122, 79), [System.Drawing.Color]::FromArgb(255, 34, 176, 131), [System.Drawing.Color]::FromArgb(255, 236, 235, 230))
  $dot = $size * 0.2
  $gap = $size * 0.07
  $x = ($size - (3 * $dot + 2 * $gap)) / 2
  $y = ($size - $dot) / 2
  for ($i = 0; $i -lt 3; $i++) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $colors[$i]), [single]($x + $i * ($dot + $gap)), [single]$y, [single]$dot, [single]$dot)
  }
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) { ,(New-Png $s) }
$fs = [System.IO.File]::Create($Out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$pngs[$i].Length); $w.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Close()
"Icône créée : $Out"
