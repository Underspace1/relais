# Génère relais.ico (16 à 256 px) : le monogramme « R » de Relais.
# Un seul trait (le relais) relie les trois IA : Claude (orange), ChatGPT (vert), Grok (clair).
# Même dessin que public/favicon.svg, sur une grille de 64 × 64.
param([string]$Out = "$PSScriptRoot\relais.ico")
Add-Type -AssemblyName System.Drawing

function C([int]$r, [int]$g, [int]$b) { [System.Drawing.Color]::FromArgb(255, $r, $g, $b) }

function New-Png([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 64.0
  $g.ScaleTransform([single]$k, [single]$k)

  # Fond : carré arrondi sombre, léger dégradé vertical
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 30
  $bg.AddArc(0, 0, $r, $r, 180, 90); $bg.AddArc(64 - $r, 0, $r, $r, 270, 90)
  $bg.AddArc(64 - $r, 64 - $r, $r, $r, 0, 90); $bg.AddArc(0, 64 - $r, $r, $r, 90, 90)
  $bg.CloseFigure()
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new(0, 64)), (C 37 36 34), (C 14 14 16)
  $g.FillPath($bgBrush, $bg)

  $g.TranslateTransform(-0.5, -1.5)
  # Le trait du « R » : jambage, boucle, puis la jambe vers le troisième point
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddLine(21, 49, 21, 22.5)
  $p.AddBezier(21, 22.5, 21, 18.2, 23.2, 16, 27.5, 16)
  $p.AddLine(27.5, 16, 32.5, 16)
  $p.AddArc(21.5, 16, 22, 22, 270, 180)
  $p.AddLine(32.5, 38, 27, 38)
  $p.AddLine(27, 38, 44, 49)
  $ink = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(20, 50)), ([System.Drawing.PointF]::new(44, 18)), (C 224 122 79), (C 127 217 184)
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend 4
  $blend.Colors = @((C 224 122 79), (C 224 122 79), (C 34 176 131), (C 127 217 184))
  $blend.Positions = @([single]0, [single]0.25, [single]0.75, [single]1)
  $ink.InterpolationColors = $blend
  $pen = New-Object System.Drawing.Pen $ink, 4.8
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawPath($pen, $p)

  # Les trois IA
  $ring = New-Object System.Drawing.Pen (C 23 23 22), 2
  foreach ($n in @(@(21, 49, (C 224 122 79)), @(43.5, 27, (C 34 176 131)), @(44, 49, (C 236 235 230)))) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $n[2]), [single]($n[0] - 4.6), [single]($n[1] - 4.6), [single]9.2, [single]9.2)
    $g.DrawEllipse($ring, [single]($n[0] - 4.6), [single]($n[1] - 4.6), [single]9.2, [single]9.2)
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
