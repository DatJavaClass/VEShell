# Builds a multi-resolution, PNG-framed .ico (16..256) from a source icon.
# Dependency-free: uses .NET System.Drawing only.
# $Source defaults to the in-repo copy (build/icon-source.ico) for reproducible
# regeneration; pass a different path to rebuild from another source icon.
param(
    [string]$Source = "$PSScriptRoot\icon-source.ico",
    [string]$OutIco = "$PSScriptRoot\icon.ico"
)

Add-Type -AssemblyName System.Drawing

# Load the source as a bitmap (largest available frame).
$srcIcon = New-Object System.Drawing.Icon($Source, 256, 256)
$srcBmp  = $srcIcon.ToBitmap()

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngFrames = @()

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($srcBmp, (New-Object System.Drawing.Rectangle(0, 0, $s, $s)))
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngFrames += ,@{ Size = $s; Bytes = $ms.ToArray() }
    $ms.Dispose()
    $bmp.Dispose()
}

$srcBmp.Dispose()
$srcIcon.Dispose()

# Assemble the ICO container.
$out = New-Object System.IO.MemoryStream
$bw  = New-Object System.IO.BinaryWriter($out)

# ICONDIR
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type = icon
$bw.Write([UInt16]$pngFrames.Count)  # image count

# Offset where image data begins (after dir + entries)
$offset = 6 + (16 * $pngFrames.Count)

foreach ($f in $pngFrames) {
    $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }   # 0 == 256 in ICO spec
    $bw.Write([Byte]$dim)            # width
    $bw.Write([Byte]$dim)            # height
    $bw.Write([Byte]0)              # color count
    $bw.Write([Byte]0)             # reserved
    $bw.Write([UInt16]1)            # planes
    $bw.Write([UInt16]32)          # bit count
    $bw.Write([UInt32]$f.Bytes.Length)  # bytes in resource
    $bw.Write([UInt32]$offset)          # image offset
    $offset += $f.Bytes.Length
}

foreach ($f in $pngFrames) {
    $bw.Write($f.Bytes)
}

$bw.Flush()
[System.IO.File]::WriteAllBytes($OutIco, $out.ToArray())
$bw.Dispose()
$out.Dispose()

Write-Output "Wrote $OutIco ($([System.IO.File]::ReadAllBytes($OutIco).Length) bytes, sizes: $($sizes -join ','))"
