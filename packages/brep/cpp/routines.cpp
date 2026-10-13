// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Our versions of the kernel routines that cite Numerical Recipes, written from the published algorithms:
//   SVD                  one-sided Jacobi (Hestenes 1958; Golub and Van Loan, Matrix Computations)
//   SVD solve            x = V diag(1/w) U^T b with small w dropped, the pseudo-inverse
//   symmetric eigen      cyclic Jacobi (Golub and Van Loan)
//   tridiagonal          elimination without pivoting, the Thomas algorithm
//   cornered tridiagonal the Sherman-Morrison formula on the tridiagonal solve
//   1-D minimum          Brent, Algorithms for Minimization without Derivatives (1973)
//   quadratic            q = -(b + sgn(b) sqrt(b^2 - 4ac)) / 2, roots q/a and c/q, which avoids cancellation
//   LU                   Gaussian elimination with scaled partial pivoting (Golub and Van Loan), then forward and
//                        back substitution
// Each keeps the kernel routine's contract (its documented arguments, return codes and tolerances).
#include "StdAfx.h"

#include "sx_routines.h"

#include <NL_Globals.h>

#include <algorithm>
#include <cmath>
#include <numeric>
#include <vector>

namespace {

const double kEps = 2.220446049250313e-16;

// a = U diag(w) V^T for a row-major m x n matrix, m >= n; a becomes U. Columns of U with w = 0 are filled in
// to keep U orthonormal.
bool svd(int m, int n, std::vector<double>& a, std::vector<double>& w, std::vector<double>& v)
{
    if (m < n || n < 1) return false;
    v.assign(size_t(n) * n, 0.0);
    for (int i = 0; i < n; i++) v[size_t(i) * n + i] = 1.0;
    auto at = [&](int i, int j) -> double& { return a[size_t(i) * n + j]; };
    bool rotated = true;
    for (int sweep = 0; rotated; sweep++) {
        if (sweep == 80) return false;
        rotated = false;
        for (int p = 0; p < n - 1; p++) {
            for (int q = p + 1; q < n; q++) {
                double alpha = 0, beta = 0, gamma = 0;
                for (int i = 0; i < m; i++) {
                    alpha += at(i, p) * at(i, p);
                    beta += at(i, q) * at(i, q);
                    gamma += at(i, p) * at(i, q);
                }
                if (gamma == 0.0 || std::fabs(gamma) <= kEps * std::sqrt(alpha * beta)) continue;
                rotated = true;
                double zeta = (beta - alpha) / (2.0 * gamma);
                double t = (zeta >= 0 ? 1.0 : -1.0) / (std::fabs(zeta) + std::sqrt(1.0 + zeta * zeta));
                double c = 1.0 / std::sqrt(1.0 + t * t), s = c * t;
                for (int i = 0; i < m; i++) {
                    double x = at(i, p), y = at(i, q);
                    at(i, p) = c * x - s * y;
                    at(i, q) = s * x + c * y;
                }
                for (int i = 0; i < n; i++) {
                    double x = v[size_t(i) * n + p], y = v[size_t(i) * n + q];
                    v[size_t(i) * n + p] = c * x - s * y;
                    v[size_t(i) * n + q] = s * x + c * y;
                }
            }
        }
    }
    w.assign(n, 0.0);
    std::vector<bool> filled(n, false);
    for (int j = 0; j < n; j++) {
        double norm = 0;
        for (int i = 0; i < m; i++) norm += at(i, j) * at(i, j);
        w[j] = std::sqrt(norm);
        if (w[j] > 0) {
            for (int i = 0; i < m; i++) at(i, j) /= w[j];
            filled[j] = true;
        }
    }
    // an empty column: the first unit vector that stays independent of the others after Gram-Schmidt
    for (int j = 0; j < n; j++) {
        if (filled[j]) continue;
        for (int e = 0; e < m; e++) {
            std::vector<double> u(m, 0.0);
            u[e] = 1.0;
            for (int k = 0; k < n; k++) {
                if (!filled[k]) continue;
                double d = 0;
                for (int i = 0; i < m; i++) d += u[i] * at(i, k);
                for (int i = 0; i < m; i++) u[i] -= d * at(i, k);
            }
            double norm = 0;
            for (double x : u) norm += x * x;
            norm = std::sqrt(norm);
            if (norm < 0.5) continue;
            for (int i = 0; i < m; i++) at(i, j) = u[i] / norm;
            filled[j] = true;
            break;
        }
    }
    return true;
}

// x = V diag(1/w) U^T b for one right hand side, b read with a stride; zero w terms are left out
void svd_solve(int m, int n, const std::vector<double>& u, const std::vector<double>& w, const std::vector<double>& v,
               const std::vector<double>& b, std::vector<double>& x)
{
    std::vector<double> t(n, 0.0);
    for (int j = 0; j < n; j++) {
        if (w[j] == 0.0) continue;
        double s = 0;
        for (int i = 0; i < m; i++) s += u[size_t(i) * n + j] * b[i];
        t[j] = s / w[j];
    }
    x.assign(n, 0.0);
    for (int k = 0; k < n; k++) {
        double s = 0;
        for (int j = 0; j < n; j++) s += v[size_t(k) * n + j] * t[j];
        x[k] = s;
    }
}

void drop_small(double* w, int n, double relative)
{
    double top = 0;
    for (int j = 0; j < n; j++) top = std::max(top, w[j]);
    for (int j = 0; j < n; j++)
        if (w[j] < relative * top) w[j] = 0.0;
}

// eigenvalues ascending, eigenvectors as the columns of vecs; a is row-major n x n and symmetric
bool sym_eigen(int n, std::vector<double> a, std::vector<double>& vals, std::vector<double>& vecs, unsigned long& rotations)
{
    std::vector<double> v(size_t(n) * n, 0.0);
    for (int i = 0; i < n; i++) v[size_t(i) * n + i] = 1.0;
    auto at = [&](int i, int j) -> double& { return a[size_t(i) * n + j]; };
    double total = 0;
    for (double x : a) total += x * x;
    rotations = 0;
    for (int sweep = 0;; sweep++) {
        double off = 0;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++)
                if (i != j) off += at(i, j) * at(i, j);
        if (off <= kEps * kEps * total || off == 0.0) break;
        if (sweep == 60) return false;
        for (int p = 0; p < n - 1; p++) {
            for (int q = p + 1; q < n; q++) {
                if (at(p, q) == 0.0) continue;
                double tau = (at(q, q) - at(p, p)) / (2.0 * at(p, q));
                double t = (tau >= 0 ? 1.0 : -1.0) / (std::fabs(tau) + std::sqrt(1.0 + tau * tau));
                double c = 1.0 / std::sqrt(1.0 + t * t), s = t * c;
                // A = J^T A J with J the rotation in the (p, q) plane
                for (int k = 0; k < n; k++) {
                    double x = at(k, p), y = at(k, q);
                    at(k, p) = c * x - s * y;
                    at(k, q) = s * x + c * y;
                }
                for (int k = 0; k < n; k++) {
                    double x = at(p, k), y = at(q, k);
                    at(p, k) = c * x - s * y;
                    at(q, k) = s * x + c * y;
                }
                for (int k = 0; k < n; k++) {
                    double x = v[size_t(k) * n + p], y = v[size_t(k) * n + q];
                    v[size_t(k) * n + p] = c * x - s * y;
                    v[size_t(k) * n + q] = s * x + c * y;
                }
                rotations++;
            }
        }
    }
    std::vector<int> order(n);
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&](int x, int y) { return at(x, x) < at(y, y); });
    vals.resize(n);
    vecs.assign(size_t(n) * n, 0.0);
    for (int j = 0; j < n; j++) {
        vals[j] = at(order[j], order[j]);
        for (int i = 0; i < n; i++) vecs[size_t(i) * n + j] = v[size_t(i) * n + order[j]];
    }
    return true;
}

// b[i] on the diagonal, a[i] left of it and c[i] right of it in row i; one right hand side per point coordinate
bool tridiagonal(const double* a, const double* b, const double* c, int n, std::vector<double> q[3], std::vector<double> p[3])
{
    if (n < 1) return false;
    std::vector<double> cc(n);
    for (int k = 0; k < 3; k++) p[k].assign(n, 0.0);
    double den = b[0];
    if (den == 0.0) return false;
    cc[0] = c[0] / den;
    for (int k = 0; k < 3; k++) p[k][0] = q[k][0] / den;
    for (int i = 1; i < n; i++) {
        den = b[i] - a[i] * cc[i - 1];
        if (den == 0.0) return false;
        cc[i] = i < n - 1 ? c[i] / den : 0.0;
        for (int k = 0; k < 3; k++) p[k][i] = (q[k][i] - a[i] * p[k][i - 1]) / den;
    }
    for (int i = n - 2; i >= 0; i--)
        for (int k = 0; k < 3; k++) p[k][i] -= cc[i] * p[k][i + 1];
    return true;
}

void split(const NL_POINT* pts, int n, std::vector<double> out[3])
{
    for (int k = 0; k < 3; k++) out[k].resize(n);
    for (int i = 0; i < n; i++) {
        out[0][i] = pts[i].x;
        out[1][i] = pts[i].y;
        out[2][i] = pts[i].z;
    }
}

void join(std::vector<double> in[3], int n, NL_POINT* pts)
{
    for (int i = 0; i < n; i++) {
        pts[i].x = in[0][i];
        pts[i].y = in[1][i];
        pts[i].z = in[2][i];
    }
}

} // namespace

NL_FLAG sx_N_SolveQuadraticEq(NL_REAL a, NL_REAL b, NL_REAL c, NL_REAL* r1, NL_REAL* r2, NL_INTEGER* n)
{
    // a below the coefficient tolerance: the linear equation b x + c = 0
    if (std::fabs(a) < NL_ZCTL) {
        if (std::fabs(b) < NL_ZCTL) {
            *n = 0;
            return NL_NO;
        }
        *r1 = *r2 = -c / b;
        *n = 1;
        return NL_NO;
    }
    double d = b * b - 4.0 * a * c;
    // a discriminant within the tolerance of zero: one double root
    if (std::fabs(d) <= NL_ZDTL) {
        *r1 = *r2 = -b / (2.0 * a);
        *n = 1;
        return NL_NO;
    }
    if (d < 0) {
        *n = 0;
        return NL_NO;
    }
    double q = -0.5 * (b + (b >= 0 ? 1.0 : -1.0) * std::sqrt(d));
    double x1 = q / a, x2 = c / q;
    *r1 = std::min(x1, x2);
    *r2 = std::max(x1, x2);
    *n = 2;
    return NL_NO;
}

NL_FLAG sx_N_RealMatrixSingleValueDecompose(NL_REAL** A, NL_REAL* W, NL_REAL** V, NL_INDEX m, NL_INDEX n)
{
    // m and n are the highest row and column index
    if (n < 0 || m < n) return NL_YES;
    int rows = int(m + 1), cols = int(n + 1);
    std::vector<double> a(size_t(rows) * cols), w, v;
    for (int i = 0; i < rows; i++)
        for (int j = 0; j < cols; j++) a[size_t(i) * cols + j] = A[i][j];
    if (!svd(rows, cols, a, w, v)) return NL_YES;
    for (int i = 0; i < rows; i++)
        for (int j = 0; j < cols; j++) A[i][j] = a[size_t(i) * cols + j];
    for (int j = 0; j < cols; j++) {
        W[j] = w[j];
        for (int i = 0; i < cols; i++) V[i][j] = v[size_t(i) * cols + j];
    }
    return NL_NO;
}

NL_FLAG sx_N_SingleValueDecomposeSolve(NL_REAL** U, NL_REAL* W, NL_REAL** V, NL_INDEX me, NL_INDEX nu, NL_VOID* rhs,
                                       NL_FLAG type, NL_FLAG esvf, NL_VOID* sol)
{
    if (nu < 0 || me < nu) return NL_YES;
    if (type != NL_EPOINT && type != NL_HPOINT && type != NL_RVALUE) return NL_YES;
    int rows = int(me + 1), cols = int(nu + 1);
    // singular values under 6e-8 of the largest count as zero, the kernel's working limit
    if (esvf == NL_YES) drop_small(W, cols, 6.e-8);
    std::vector<double> u(size_t(rows) * cols), v(size_t(cols) * cols), w(W, W + cols);
    for (int i = 0; i < rows; i++)
        for (int j = 0; j < cols; j++) u[size_t(i) * cols + j] = U[i][j];
    for (int i = 0; i < cols; i++)
        for (int j = 0; j < cols; j++) v[size_t(i) * cols + j] = V[i][j];
    int parts = type == NL_RVALUE ? 1 : type == NL_EPOINT ? 3 : 4;
    std::vector<double> b(rows), x;
    for (int k = 0; k < parts; k++) {
        for (int i = 0; i < rows; i++) {
            if (type == NL_RVALUE) b[i] = static_cast<NL_REAL*>(rhs)[i];
            else if (type == NL_EPOINT) {
                const NL_POINT& p = static_cast<NL_POINT*>(rhs)[i];
                b[i] = k == 0 ? p.x : k == 1 ? p.y : p.z;
            } else {
                const NL_CPOINT& p = static_cast<NL_CPOINT*>(rhs)[i];
                b[i] = k == 0 ? p.x : k == 1 ? p.y : k == 2 ? p.z : p.w;
            }
        }
        svd_solve(rows, cols, u, w, v, b, x);
        for (int j = 0; j < cols; j++) {
            if (type == NL_RVALUE) {
                static_cast<NL_REAL*>(sol)[j] = x[j];
                continue;
            }
            NL_CPOINT& s = static_cast<NL_CPOINT*>(sol)[j];
            (k == 0 ? s.x : k == 1 ? s.y : k == 2 ? s.z : s.w) = x[j];
            if (type == NL_EPOINT && k == 0) s.w = NL_NOW;
        }
    }
    return NL_NO;
}

NL_VOID sx_N_FuncFindMinima(NL_REAL xa, NL_REAL xb, NL_REAL xc, NL_REAL fb, NL_REAL (*f)(NL_REAL), NL_REAL xtol,
                            NL_REAL ftol, NL_REAL* xmin, NL_REAL* fmin)
{
    const double golden = 0.3819660112501051; // (3 - sqrt 5) / 2
    double a = std::min(xa, xc), b = std::max(xa, xc);
    double x = xb, w = xb, v = xb, fx = fb, fw = fb, fv = fb;
    double d = 0, e = 0;
    for (int iter = 0; iter < 100; iter++) {
        double xm = 0.5 * (a + b);
        double tol1 = xtol * std::fabs(x) + 1.0e-10, tol2 = 2.0 * tol1;
        if (std::fabs(x - xm) <= tol2 - 0.5 * (b - a)) break;
        bool step_golden = true;
        if (std::fabs(e) > tol1) {
            // a parabola through x, w and v
            double r = (x - w) * (fx - fv);
            double q = (x - v) * (fx - fw);
            double p = (x - v) * q - (x - w) * r;
            q = 2.0 * (q - r);
            if (q > 0) p = -p;
            q = std::fabs(q);
            double last = e;
            e = d;
            if (std::fabs(p) < std::fabs(0.5 * q * last) && p > q * (a - x) && p < q * (b - x)) {
                d = p / q;
                double u = x + d;
                if (u - a < tol2 || b - u < tol2) d = std::copysign(tol1, xm - x);
                step_golden = false;
            }
        }
        if (step_golden) {
            e = x >= xm ? a - x : b - x;
            d = golden * e;
        }
        double u = std::fabs(d) >= tol1 ? x + d : x + std::copysign(tol1, d);
        double fu = f(u);
        // a value at or under ftol ends the search there
        if (fu <= ftol) {
            *xmin = u;
            *fmin = fu;
            return;
        }
        if (fu <= fx) {
            (u >= x ? a : b) = x;
            v = w;
            fv = fw;
            w = x;
            fw = fx;
            x = u;
            fx = fu;
        } else {
            (u < x ? a : b) = u;
            if (fu <= fw || w == x) {
                v = w;
                fv = fw;
                w = u;
                fw = fu;
            } else if (fu <= fv || v == x || v == w) {
                v = u;
                fv = fu;
            }
        }
    }
    *xmin = x;
    *fmin = fx;
}

NL_FLAG sx_M_TridiagonalSystem(NL_REAL* a, NL_REAL* b, NL_REAL* c, NL_POINT* Q, NL_INDEX n, NL_POINT* P)
{
    std::vector<double> q[3], p[3];
    split(Q, int(n), q);
    if (!tridiagonal(a, b, c, int(n), q, p)) return NL_YES;
    join(p, int(n), P);
    return NL_NO;
}

NL_FLAG sx_M_CorneredTridiagonalSystem(NL_REAL* a, NL_REAL* b, NL_REAL* c, NL_REAL alpha, NL_REAL beta, NL_POINT* Q,
                                       NL_INDEX n, NL_POINT* P)
{
    // beta is the top right corner and alpha the bottom left. The matrix is T + u v^T with T tridiagonal,
    // u = (g, 0, ..., 0, alpha) and v = (1, 0, ..., 0, beta / g); solve T y = Q and T z = u, then
    // P = y - z (v.y) / (1 + v.z)
    int m = int(n);
    if (m < 3) return NL_YES;
    double g = -b[0];
    if (g == 0.0) g = 1.0;
    std::vector<double> bb(b, b + m);
    bb[0] = b[0] - g;
    bb[m - 1] = b[m - 1] - alpha * beta / g;
    std::vector<double> q[3], y[3], uq[3], z[3];
    split(Q, m, q);
    if (!tridiagonal(a, bb.data(), c, m, q, y)) return NL_YES;
    for (int k = 0; k < 3; k++) uq[k].assign(m, 0.0);
    uq[0][0] = g;
    uq[0][m - 1] = alpha;
    if (!tridiagonal(a, bb.data(), c, m, uq, z)) return NL_YES;
    double den = 1.0 + z[0][0] + beta * z[0][m - 1] / g;
    if (den == 0.0) return NL_YES;
    for (int k = 0; k < 3; k++) {
        double factor = (y[k][0] + beta * y[k][m - 1] / g) / den;
        for (int i = 0; i < m; i++) y[k][i] -= factor * z[0][i];
    }
    join(y, m, P);
    return NL_NO;
}

SmStatus sx_SmMatrix_EigenSystemJacobiSolver(SmMatrix& A, SmTArray<double>& values, SmMatrix& vectors, ULONG& rotations)
{
    if (!A.IsSymmetric()) return SM_ERR;
    int n = int(A.GetNumRows());
    std::vector<double> a(size_t(n) * n), vals, vecs;
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++) a[size_t(i) * n + j] = A.GetAt(i, j);
    unsigned long count = 0;
    if (!sym_eigen(n, a, vals, vecs, count)) return SM_ERR;
    values.SetSize(n);
    vectors.SetSize(n, n);
    for (int j = 0; j < n; j++) {
        values[j] = vals[j];
        for (int i = 0; i < n; i++) vectors.SetAt(i, j, vecs[size_t(i) * n + j]);
    }
    rotations = ULONG(count);
    return SM_SUCCESS;
}

SmStatus sx_SmMatrix_SVDecompose(SmMatrix& A, SmTArray<double>& W, SmMatrix& V)
{
    int m = int(A.GetNumRows()), n = int(A.GetNumColumns());
    if (m < n || n < 1) return SM_ERR;
    std::vector<double> a(size_t(m) * n), w, v;
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++) a[size_t(i) * n + j] = A.GetAt(i, j);
    if (!svd(m, n, a, w, v)) return SM_ERR;
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++) A.SetAt(i, j, a[size_t(i) * n + j]);
    W.SetSize(n);
    V.SetSize(n, n);
    for (int j = 0; j < n; j++) {
        W[j] = w[j];
        for (int i = 0; i < n; i++) V.SetAt(i, j, v[size_t(i) * n + j]);
    }
    return SM_SUCCESS;
}

SmStatus sx_SmMatrix_SolveWithSVDMatrices(const SmMatrix& U, const SmTArray<double>& rhs, SmTArray<double>& W,
                                          const SmMatrix& V, SmTArray<double>& x, double tol, SmBoolean adjust)
{
    int m = int(U.GetNumRows()), n = int(U.GetNumColumns());
    // the solution has room for m values, as the kernel's callers size it; the last m - n are zero
    if (m < n || n < 1 || int(rhs.GetSize()) != m || int(x.GetSize()) != m || int(W.GetSize()) != n ||
        int(V.GetNumRows()) != n || int(V.GetNumColumns()) != n)
        return SM_ERR;
    std::vector<double> w(n);
    for (int j = 0; j < n; j++) w[j] = W[j];
    if (adjust) {
        drop_small(w.data(), n, tol);
        for (int j = 0; j < n; j++) W[j] = w[j];
    }
    std::vector<double> u(size_t(m) * n), v(size_t(n) * n), b(m), out;
    for (int i = 0; i < m; i++) {
        b[i] = rhs[i];
        for (int j = 0; j < n; j++) u[size_t(i) * n + j] = U.GetAt(i, j);
    }
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++) v[size_t(i) * n + j] = V.GetAt(i, j);
    svd_solve(m, n, u, w, v, b, out);
    for (int i = 0; i < m; i++) x[i] = i < n ? out[i] : 0.0;
    return SM_SUCCESS;
}

// PA = LU in place, L unit lower; piv[k] is the row swapped into row k at step k. The pivot is the largest entry
// relative to its row's largest original entry, the last one on a tie. A row below SM_EFF_ZERO is an error; a
// pivot below it becomes +-SM_EFF_ZERO (negative unless it was positive) and the result is a warning.
SmStatus sx_SmMatrix_LUDecompose(SmMatrix& A, ULONG* piv)
{
    int n = int(A.GetNumRows());
    if (n != int(A.GetNumColumns())) return SM_ERR_INVALID_INPUT;
    std::vector<double> a(size_t(n) * n), scale(n);
    auto at = [&](int i, int j) -> double& { return a[size_t(i) * n + j]; };
    for (int i = 0; i < n; i++) {
        double big = 0;
        for (int j = 0; j < n; j++) big = std::max(big, std::fabs(at(i, j) = A.GetAt(i, j)));
        if (big < SM_EFF_ZERO) return SM_ERR;
        scale[i] = 1.0 / big;
    }
    SmStatus status = SM_SUCCESS;
    for (int k = 0; k < n; k++) {
        int p = k;
        double best = -1;
        for (int i = k; i < n; i++) {
            double v = scale[i] * std::fabs(at(i, k));
            if (v >= best) best = v, p = i;
        }
        if (p != k) {
            for (int j = 0; j < n; j++) std::swap(at(p, j), at(k, j));
            std::swap(scale[p], scale[k]);
        }
        piv[k] = ULONG(p);
        if (std::fabs(at(k, k)) < SM_EFF_ZERO) {
            at(k, k) = at(k, k) > 0 ? SM_EFF_ZERO : -SM_EFF_ZERO;
            status = SM_ERR_WARNING;
        }
        for (int i = k + 1; i < n; i++) {
            double l = at(i, k) /= at(k, k);
            for (int j = k + 1; j < n; j++) at(i, j) -= l * at(k, j);
        }
    }
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++) A.SetAt(i, j, at(i, j));
    return status;
}

// x from LU x = P b; b and x may be the same array. x keeps any entries past n.
SmStatus sx_SmMatrix_SolveWithLUMatrix(const SmMatrix& LU, const ULONG* piv, const SmTArray<double>& b,
                                       SmTArray<double>& x)
{
    int n = int(LU.GetNumRows());
    if (n != int(LU.GetNumColumns()) || int(b.GetSize()) != n) return SM_ERR_INVALID_INPUT;
    std::vector<double> y(n);
    for (int i = 0; i < n; i++) y[i] = b[i];
    for (int k = 0; k < n; k++) {
        if (piv[k] >= ULONG(n)) return SM_ERR_INVALID_INPUT;
        std::swap(y[k], y[piv[k]]);
    }
    for (int i = 1; i < n; i++)
        for (int j = 0; j < i; j++) y[i] -= LU.GetAt(i, j) * y[j];
    for (int i = n - 1; i >= 0; i--) {
        double d = LU.GetAt(i, i);
        if (std::fabs(d) < SM_EFF_ZERO) return SM_ERR;
        for (int j = i + 1; j < n; j++) y[i] -= LU.GetAt(i, j) * y[j];
        y[i] /= d;
    }
    if (int(x.GetSize()) < n) x.SetSize(n);
    for (int i = 0; i < n; i++) x[i] = y[i];
    return SM_SUCCESS;
}
