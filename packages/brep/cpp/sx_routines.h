// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Our own versions of the kernel routines that cite Numerical Recipes. scripts/swap-routines.sh makes each
// kernel body call the matching function here, with the kernel's own signature and contract; routines.cpp has them.
#pragma once
#include <nurbs.h>
#include <SmMatrix.h>

NL_FLAG sx_N_SolveQuadraticEq(NL_REAL a, NL_REAL b, NL_REAL c, NL_REAL* r1, NL_REAL* r2, NL_INTEGER* n);
NL_FLAG sx_N_RealMatrixSingleValueDecompose(NL_REAL** A, NL_REAL* W, NL_REAL** V, NL_INDEX m, NL_INDEX n);
NL_FLAG sx_N_SingleValueDecomposeSolve(NL_REAL** U, NL_REAL* W, NL_REAL** V, NL_INDEX me, NL_INDEX nu, NL_VOID* rhs,
                                       NL_FLAG type, NL_FLAG esvf, NL_VOID* sol);
NL_VOID sx_N_FuncFindMinima(NL_REAL xa, NL_REAL xb, NL_REAL xc, NL_REAL fb, NL_REAL (*f)(NL_REAL), NL_REAL xtol,
                            NL_REAL ftol, NL_REAL* xmin, NL_REAL* fmin);
NL_FLAG sx_M_TridiagonalSystem(NL_REAL* a, NL_REAL* b, NL_REAL* c, NL_POINT* Q, NL_INDEX n, NL_POINT* P);
NL_FLAG sx_M_CorneredTridiagonalSystem(NL_REAL* a, NL_REAL* b, NL_REAL* c, NL_REAL alpha, NL_REAL beta, NL_POINT* Q,
                                       NL_INDEX n, NL_POINT* P);
SmStatus sx_SmMatrix_EigenSystemJacobiSolver(SmMatrix& A, SmTArray<double>& values, SmMatrix& vectors, ULONG& rotations);
SmStatus sx_SmMatrix_SVDecompose(SmMatrix& A, SmTArray<double>& W, SmMatrix& V);
SmStatus sx_SmMatrix_SolveWithSVDMatrices(const SmMatrix& U, const SmTArray<double>& rhs, SmTArray<double>& W,
                                          const SmMatrix& V, SmTArray<double>& x, double tol, SmBoolean adjust);
SmStatus sx_SmMatrix_LUDecompose(SmMatrix& A, ULONG* piv);
SmStatus sx_SmMatrix_SolveWithLUMatrix(const SmMatrix& LU, const ULONG* piv, const SmTArray<double>& b,
                                       SmTArray<double>& x);
