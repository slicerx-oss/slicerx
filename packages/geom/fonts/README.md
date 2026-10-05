# Fonts

`HankenGrotesk-SemiBold-latin.ttf` is the default outline font for text solids
(`text.mesh`, the shape tool's text, and `text.polygons` with `font: "sans"`).
It is Hanken Grotesk SemiBold by The Hanken Grotesk Project Authors
(https://github.com/marcologous/hanken-grotesk), under the SIL Open Font
License 1.1 (OFL.txt). It is a subset: Basic Latin, Latin-1, a few
punctuation marks, arrows and math signs, with hinting removed and
only the kerning feature kept. Hanken Grotesk declares no Reserved Font Name, so the subset keeps
its name.

Rebuild with fontTools:

    pyftsubset HankenGrotesk-SemiBold.ttf \
      --unicodes="U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2022,U+2026,U+20AC,U+2122,U+2190-2193,U+2212,U+2264,U+2265,U+00B1" \
      --no-hinting --layout-features='kern' --drop-tables+=GSUB,STAT,gasp,prep \
      --name-IDs='*' --output-file=HankenGrotesk-SemiBold-latin.ttf
