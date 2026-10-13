#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Swaps out the kernel routines that cite Numerical Recipes, whose license is not open source. In the unpacked
# kernel at $1, each one's body becomes a call to our version in cpp/routines.cpp (declared in cpp/sx_routines.h),
# the smos_Pythag macro becomes hypot, and SmIntegrator.cpp goes, for cpp/integrator.cpp. fetch-smlib.sh runs this
# once, after unpacking, and with --check before each use, which fails unless every one of them is swapped out.
# The list is the full inventory: no other kernel code cites Numerical Recipes or uses its routines.
set -eu
check=0
if [ "$1" = --check ]; then check=1; shift; fi
src="$1/source/SMLib/src"

# file, function, its new body
routines='NL_Math.cpp|N_SolveQuadraticEq|return sx_N_SolveQuadraticEq(a, b, c, r1, r2, n);
NL_Math.cpp|N_SingleValueDecomposeSolve|return sx_N_SingleValueDecomposeSolve(U, W, V, me, nu, rhs, type, esvf, sol);
NL_Math.cpp|N_RealMatrixSingleValueDecompose|return sx_N_RealMatrixSingleValueDecompose(A, W, V, m, n);
NL_Math.cpp|N_FuncFindMinima|sx_N_FuncFindMinima(xa, xb, xc, fb, f, xtol, ftol, xmin, fmin);
NL_Math.cpp|M_TridiagonalSystem|return sx_M_TridiagonalSystem(a, b, c, Q, n, P);
NL_Math.cpp|M_CorneredTridiagonalSystem|return sx_M_CorneredTridiagonalSystem(a, b, c, alpha, beta, Q, n, P);
SmMatrix.cpp|SmMatrix::EigenSystemJacobiSolver|return sx_SmMatrix_EigenSystemJacobiSolver(*this, rEigenValues, rEigenVecs, rIterCnt);
SmMatrix.cpp|SmMatrix::SVDecompose|return sx_SmMatrix_SVDecompose(*this, rW, rV);
SmMatrix.cpp|SmMatrix::SolveWithSVDMatrices|return sx_SmMatrix_SolveWithSVDMatrices(*this, crRightHandSide, rW, crV, rSolutionVector, dSVDTol, bAdjSinglularValues);
SmMatrix.cpp|SmMatrix::LUDecompose|return sx_SmMatrix_LUDecompose(*this, plIndx);
SmMatrix.cpp|SmMatrix::SolveWithLUMatrix|return sx_SmMatrix_SolveWithLUMatrix(*this, laIndx, crRightHandSide, rSolutionVector);'

h="$1/source/SMLib/inc/SmMath.h"
if [ "$check" = 1 ]; then
  bad=0
  # each definition's body is our call alone, on its first line
  echo "$routines" | { while IFS='|' read -r file name body; do
    n=$(grep -cF "{ $body }" "$src/$file" || true)
    [ "$n" = 1 ] || { echo "swap-routines: $name is not swapped in $src/$file" >&2; bad=1; }
  done; exit $bad; } || bad=1
  [ ! -e "$src/SmIntegrator.cpp" ] || { echo "swap-routines: $src/SmIntegrator.cpp is still there" >&2; bad=1; }
  grep -q '^#define[ \t]*smos_Pythag(a,b)[ \t]*hypot((a),(b))$' "$h" || { echo "swap-routines: smos_Pythag is not hypot" >&2; bad=1; }
  exit $bad
fi

echo "$routines" | while IFS='|' read -r file name body; do
  f="$src/$file"
  # our declarations, after the precompiled header every kernel file starts with
  if ! grep -q '#include "sx_routines.h"' "$f"; then
    awk '{ print } /^#include "StdAfx.h"/ && !done { print "#include \"sx_routines.h\""; done = 1 }
      END { if (!done) { print "swap-routines: no StdAfx.h include" > "/dev/stderr"; exit 1 } }' "$f" > "$f.tmp"
    mv "$f.tmp" "$f"
  fi
  # the definition starts at column 0 and is not a declaration; its body runs from the first brace to the one that
  # closes it, read past comments, strings and character literals
  awk -v name="$name" -v body="$body" -v q="'" '
    function scan(line,    out, i, c, n) {
      out = ""
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (state == 3) { out = out c; continue }
        if (incomment) {
          if (c == "*" && substr(line, i + 1, 1) == "/") { incomment = 0; i++; if (state == 1) out = out "*/"; continue }
          if (state == 1) out = out c
          continue
        }
        if (quote != "") {
          if (c == "\\") { if (state == 1) out = out substr(line, i, 2); i++; continue }
          if (c == quote) quote = ""
          if (state == 1) out = out c
          continue
        }
        if (c == "/" && substr(line, i + 1, 1) == "/") { if (state == 1) out = out substr(line, i); break }
        if (c == "/" && substr(line, i + 1, 1) == "*") { incomment = 1; if (state == 1) out = out "/*"; i++; continue }
        if (c == "\"" || c == q) { quote = c; if (state == 1) out = out c; continue }
        if (state == 1) {
          if (c == "{") { out = out "{ " body " }"; state = 2; depth = 1; continue }
          out = out c
          continue
        }
        if (c == "{") depth++
        if (c == "}" && --depth == 0) state = 3
      }
      return out
    }
    BEGIN { state = 0; pat = "^[A-Za-z].*[ *]" name "[ \t]*(\\(|//|$)" }
    state == 0 && $0 ~ pat && $0 !~ /;[ \t]*$/ { state = 1; found++ }
    state == 0 || state == 4 { print; next }
    {
      was = state
      line = scan($0)
      if (was == 1 || state == 3) print line
      if (state == 3) state = 4
    }
    END {
      if (found != 1 || state != 4) { printf "swap-routines: %s: found %d definitions, state %d\n", name, found, state > "/dev/stderr"; exit 1 }
    }
  ' "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
done

# hypot in place of the three line macro, which only the swapped SVD used
awk '
  /^#define[ \t]+smos_Pythag\(/ { print "#define          smos_Pythag(a,b)    hypot((a),(b))"; skip = 1; swapped++; if ($0 !~ /\\[ \t]*$/) skip = 0; next }
  skip { if ($0 !~ /\\[ \t]*$/) skip = 0; next }
  { print }
  END { if (swapped != 1) { print "swap-routines: smos_Pythag: found " swapped > "/dev/stderr"; exit 1 } }
' "$h" > "$h.tmp"
mv "$h.tmp" "$h"

# all of SmIntegrator.cpp cites it; cpp/integrator.cpp defines the classes SmIntegrator.h declares instead
rm "$src/SmIntegrator.cpp"
