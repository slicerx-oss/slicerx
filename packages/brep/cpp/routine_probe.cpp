// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Test-only (the routine-probe feature): runs the routines swap-routines.sh replaces, and kernel code that calls
// them, on fixed inputs. Values come back in a form that does not depend on choices the math leaves open (sorted
// singular values, vectors with their largest entry positive), so tests/routines.rs can hold them against the
// values the kernel's original routines gave (tests/routines.golden.json). Names starting "check." are residuals
// that must be near zero, whichever routines ran; names starting "accuracy." are errors against the exact value,
// as a fraction of the accuracy asked for, where adaptive routines may rightly take different steps.
#include "json.h"

#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmBrep.h>
#include <SmIntegrator.h>
#include <SmMatrix.h>
#include <nurbs.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

using sxj::Value;

namespace {

Value out = Value::object();

void put(const std::string& name, const std::vector<double>& v)
{
    Value a = Value::array();
    for (double d : v) a.push(d);
    out.set(name, a);
}

// a vector up to sign: its largest entry made positive
std::vector<double> signless(std::vector<double> v)
{
    size_t k = 0;
    for (size_t i = 1; i < v.size(); i++)
        if (std::fabs(v[i]) > std::fabs(v[k]) + 1e-12) k = i;
    if (!v.empty() && v[k] < 0)
        for (double& d : v) d = -d;
    return v;
}

// deterministic entries in [-1, 1)
struct Lcg {
    unsigned long long s;
    double next()
    {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return double(s >> 11) / double(1ULL << 52) - 1.0;
    }
};

struct Rows {
    std::vector<double> store;
    std::vector<double*> rows;
    Rows(int r, int c) : store(size_t(r) * c, 0.0), rows(r)
    {
        for (int i = 0; i < r; i++) rows[i] = &store[size_t(i) * c];
    }
    double** p() { return rows.data(); }
};

std::vector<std::vector<double>> cases()
{
    // row-major, first two entries are the size
    std::vector<std::vector<double>> c;
    c.push_back({4, 3, 1, 2, 3, 4, 5, 6, 7, 8, 10, 2, 1, 0});
    c.push_back({4, 3, 1, 2, 3, 4, 5, 9, 7, 8, 15, 2, 1, 3}); // third column = first + second
    c.push_back({3, 3, 2, 0, 0, 0, 1e-3, 0, 0, 0, 1});
    c.push_back({6, 2, 1, 1, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6});
    Lcg g{7};
    std::vector<double> r{5, 5};
    for (int i = 0; i < 25; i++) r.push_back(g.next());
    c.push_back(r);
    return c;
}

void svd_cases()
{
    auto all = cases();
    for (size_t k = 0; k < all.size(); k++) {
        const auto& c = all[k];
        int m = int(c[0]), n = int(c[1]);
        std::string tag = std::to_string(k);
        // NLib form: highest indices
        Rows A(m, n), V(n, n);
        for (int i = 0; i < m * n; i++) A.p()[i / n][i % n] = c[2 + i];
        std::vector<double> W(n);
        int flag = N_RealMatrixSingleValueDecompose(A.p(), W.data(), V.p(), m - 1, n - 1);
        put("svd.nl." + tag + ".flag", {double(flag)});
        double rec = 0, ortho = 0;
        for (int i = 0; i < m; i++)
            for (int j = 0; j < n; j++) {
                double s = 0;
                for (int l = 0; l < n; l++) s += A.p()[i][l] * W[l] * V.p()[j][l];
                rec = std::max(rec, std::fabs(s - c[2 + i * n + j]));
            }
        for (int p = 0; p < n; p++)
            for (int q = 0; q < n; q++) {
                double s = 0, t = 0;
                for (int i = 0; i < m; i++) s += A.p()[i][p] * A.p()[i][q];
                for (int i = 0; i < n; i++) t += V.p()[i][p] * V.p()[i][q];
                ortho = std::max({ortho, std::fabs(s - (p == q)), std::fabs(t - (p == q))});
            }
        put("check.svd.nl." + tag + ".reconstruct", {rec});
        put("check.svd.nl." + tag + ".orthonormal", {ortho});
        std::vector<double> sorted(W);
        std::sort(sorted.rbegin(), sorted.rend());
        put("svd.nl." + tag + ".w", sorted);

        // least squares through the decomposition, singular values edited by the routine
        std::vector<double> rhs(m), x(n);
        for (int i = 0; i < m; i++) rhs[i] = 1.0 + i * 0.5 - (i % 2) * 0.25;
        flag = N_SingleValueDecomposeSolve(A.p(), W.data(), V.p(), m - 1, n - 1, rhs.data(), NL_RVALUE, NL_YES, x.data());
        put("svdsolve.nl." + tag + ".flag", {double(flag)});
        put("svdsolve.nl." + tag + ".x", x);
        std::vector<NL_POINT> pts(m);
        for (int i = 0; i < m; i++) pts[i] = {rhs[i], 2.0 - i, 0.5 * i * i};
        std::vector<NL_CPOINT> sol(n);
        N_SingleValueDecomposeSolve(A.p(), W.data(), V.p(), m - 1, n - 1, pts.data(), NL_EPOINT, NL_YES, sol.data());
        for (int j = 0; j < n; j++)
            put("svdsolve.nl." + tag + ".point." + std::to_string(j), {sol[j].x, sol[j].y, sol[j].z, sol[j].w});

        // the same through SmMatrix
        SmMatrix S(m, n), SV(n, n);
        for (int i = 0; i < m * n; i++) S.SetAt(i / n, i % n, c[2 + i]);
        SmTArray<double> SW;
        put("svd.sm." + tag + ".status", {double(S.SVDecompose(SW, SV))});
        std::vector<double> sw(SW.GetSize());
        for (size_t i = 0; i < sw.size(); i++) sw[i] = SW[ULONG(i)];
        std::sort(sw.rbegin(), sw.rend());
        put("svd.sm." + tag + ".w", sw);
        SmTArray<double> b, sx;
        b.SetSize(m);
        sx.SetSize(m);
        for (int i = 0; i < m; i++) b[i] = rhs[i];
        put("svdsolve.sm." + tag + ".status", {double(S.SolveWithSVDMatrices(b, SW, SV, sx))});
        std::vector<double> xs(m);
        for (int i = 0; i < m; i++) xs[i] = sx[i];
        put("svdsolve.sm." + tag + ".x", xs);
    }
    // where small singular values stop counting
    for (double ratio : {5e-8, 9e-8, 3e-7}) {
        Rows A(3, 3), V(3, 3);
        A.p()[0][0] = 2;
        A.p()[1][1] = 2 * ratio;
        A.p()[2][2] = 1;
        std::vector<double> W(3), r{1, 1, 1}, x(3);
        N_RealMatrixSingleValueDecompose(A.p(), W.data(), V.p(), 2, 2);
        N_SingleValueDecomposeSolve(A.p(), W.data(), V.p(), 2, 2, r.data(), NL_RVALUE, NL_YES, x.data());
        put("svdsolve.nl.limit." + std::to_string(ratio), x);
        for (double tol : {6e-8, 1e-6})
            for (int adjust : {0, 1}) {
                SmMatrix S(3, 3), SV(3, 3);
                S.Clear();
                S.SetAt(0, 0, 2);
                S.SetAt(1, 1, 2 * ratio);
                S.SetAt(2, 2, 1);
                SmTArray<double> SW, b, sx;
                S.SVDecompose(SW, SV);
                b.SetSize(3);
                sx.SetSize(3);
                b[0] = b[1] = b[2] = 1;
                int st = S.SolveWithSVDMatrices(b, SW, SV, sx, tol, adjust ? TRUE : FALSE);
                put("svdsolve.sm.limit." + std::to_string(ratio) + "." + std::to_string(tol) + "." + std::to_string(adjust),
                    {double(st), sx[0], sx[1], sx[2]});
            }
    }
    // wrong sizes and shapes
    {
        Rows A(2, 3), V(3, 3);
        std::vector<double> W(3);
        put("svd.nl.wide.flag", {double(N_RealMatrixSingleValueDecompose(A.p(), W.data(), V.p(), 1, 2))});
        SmMatrix S(2, 3), SV(3, 3);
        S.Clear();
        SmTArray<double> SW;
        put("svd.sm.wide.status", {double(S.SVDecompose(SW, SV))});
    }
}

void eigen_cases()
{
    std::vector<std::vector<double>> all{{3, 4, 1, 2, 1, 3, 0.5, 2, 0.5, 5},
                                         {4, 2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2},
                                         {3, 1, 0, 0, 0, 7, 0, 0, 0, 3}};
    for (size_t k = 0; k < all.size(); k++) {
        const auto& c = all[k];
        int n = int(c[0]);
        SmMatrix S(n, n), E(n, n);
        for (int i = 0; i < n * n; i++) S.SetAt(i / n, i % n, c[1 + i]);
        SmTArray<double> e;
        ULONG it = 0;
        std::string tag = "eigen." + std::to_string(k);
        put(tag + ".status", {double(S.EigenSystemJacobiSolver(e, E, it))});
        std::vector<double> vals(n);
        for (int i = 0; i < n; i++) vals[i] = e[i];
        put(tag + ".values", vals);
        for (int j = 0; j < n; j++) {
            std::vector<double> col(n);
            for (int i = 0; i < n; i++) col[i] = E[i][j];
            put(tag + ".vector." + std::to_string(j), signless(col));
        }
        double restored = 0;
        for (int i = 0; i < n * n; i++) restored = std::max(restored, std::fabs(S.GetAt(i / n, i % n) - c[1 + i]));
        put("check." + tag + ".restored", {restored});
    }
    SmMatrix N(2, 2), E(2, 2);
    N.SetAt(0, 0, 1);
    N.SetAt(0, 1, 2);
    N.SetAt(1, 0, 3);
    N.SetAt(1, 1, 4);
    SmTArray<double> e;
    ULONG it = 0;
    put("eigen.nonsymmetric.status", {double(N.EigenSystemJacobiSolver(e, E, it))});
    // the 3x3 path the kernel itself uses
    SmMatrix T(3, 3);
    double t[9] = {4, 1, 2, 1, 3, 0.5, 2, 0.5, 5};
    for (int i = 0; i < 9; i++) T.SetAt(i / 3, i % 3, t[i]);
    ULONG count = 0;
    double ev[3];
    SmVector3d vecs[3];
    put("eigen3x3.status", {double(T.Compute3x3EigenVectors(count, ev, vecs))});
    put("eigen3x3.values", {ev[0], ev[1], ev[2]});
    for (int j = 0; j < 3; j++) put("eigen3x3.vector." + std::to_string(j), signless({vecs[j].x, vecs[j].y, vecs[j].z}));
}

double residual_tri(const double* a, const double* b, const double* c, double alpha, double beta, bool corner,
                    const std::vector<NL_POINT>& Q, const std::vector<NL_POINT>& P)
{
    int n = int(Q.size());
    double worst = 0;
    for (int k = 0; k < 3; k++) {
        auto g = [&](const NL_POINT& p) { return k == 0 ? p.x : k == 1 ? p.y : p.z; };
        for (int i = 0; i < n; i++) {
            double r = b[i] * g(P[i]) - g(Q[i]);
            if (i > 0) r += a[i] * g(P[i - 1]);
            if (i < n - 1) r += c[i] * g(P[i + 1]);
            if (corner && i == 0) r += beta * g(P[n - 1]);
            if (corner && i == n - 1) r += alpha * g(P[0]);
            worst = std::max(worst, std::fabs(r));
        }
    }
    return worst;
}

void tridiagonal_cases()
{
    const int n = 6;
    double a[n] = {0, 1, 2, 3, 1.5, 2.5}, b[n] = {10, 11, 12, 13, 14, 15}, c[n] = {4, 5, 6, 2, 0.9, 0};
    std::vector<NL_POINT> Q(n), P(n);
    for (int i = 0; i < n; i++) Q[i] = {1.0 + i, 0.5 * i * i, 2.0 - i};
    for (int m : {1, 2, n}) {
        std::vector<NL_POINT> q(Q.begin(), Q.begin() + m), p(m);
        int flag = M_TridiagonalSystem(a, b, c, q.data(), m, p.data());
        std::vector<double> flat{double(flag)};
        for (auto& x : p) flat.insert(flat.end(), {x.x, x.y, x.z});
        put("tridiagonal." + std::to_string(m), flat);
        put("check.tridiagonal." + std::to_string(m) + ".residual", {residual_tri(a, b, c, 0, 0, false, q, p)});
    }
    double zero[n] = {0, 11, 12, 13, 14, 15};
    put("tridiagonal.zero-pivot.flag", {double(M_TridiagonalSystem(a, zero, c, Q.data(), n, P.data()))});
    for (int m : {3, 4, n}) {
        std::vector<NL_POINT> q(Q.begin(), Q.begin() + m), p(m);
        int flag = M_CorneredTridiagonalSystem(a, b, c, 0.5, 0.25, q.data(), m, p.data());
        std::vector<double> flat{double(flag)};
        for (auto& x : p) flat.insert(flat.end(), {x.x, x.y, x.z});
        put("cornered." + std::to_string(m), flat);
        put("check.cornered." + std::to_string(m) + ".residual", {residual_tri(a, b, c, 0.5, 0.25, true, q, p)});
    }
    put("cornered.2.flag", {double(M_CorneredTridiagonalSystem(a, b, c, 0.5, 0.25, Q.data(), 2, P.data()))});
}

double g_shift = 0.3;
double bowl(double x) { return (x - g_shift) * (x - g_shift) + 2.0; }
double wave(double x) { return std::cos(x); }
double quartic(double x) { return std::pow(x - 1.25, 4) + 0.1 * x; }

void minimum_cases()
{
    double x = 0, f = 0;
    N_FuncFindMinima(0.0, 0.5, 2.0, bowl(0.5), bowl, 3e-8, 0.0, &x, &f);
    put("minimum.bowl", {x, f});
    N_FuncFindMinima(2.0, 3.0, 4.0, wave(3.0), wave, 3e-8, -2.0, &x, &f);
    put("minimum.wave", {x, f});
    N_FuncFindMinima(2.0, 3.0, 4.0, wave(3.0), wave, 3e-8, 0.0, &x, &f);
    put("minimum.wave.ftol", {x, f});
    N_FuncFindMinima(0.0, 1.0, 3.0, quartic(1.0), quartic, 1e-6, -1.0, &x, &f);
    put("minimum.quartic", {x, f});
}

void quadratic_cases()
{
    double cs[][3] = {{1, -3, 2}, {1, 2, 1}, {1, 0, 1}, {0, 2, -4}, {0, 0, 1}, {0, 0, 0}, {1e-9, 1, -1}, {1e-13, 1, -1},
                      {1e-12, 1, -1}, {1, -2, 1 + 1e-10}, {1, -2, 1 - 1e-10}, {1, -2, 1 + 2e-9}, {1, -2, 1 + 3e-9},
                      {1, -2, 1 - 2.4e-9}, {1, -2, 1 - 2.6e-9}, {1e4, -2e4, 1e4 * (1 + 1e-10)}, {2, 4, -6}, {-1, 0, 4},
                      {1, 1e8, 1}, {3, 0, 0}, {1e-8, 1, 1}};
    int k = 0;
    for (auto& q : cs) {
        double r1 = 0, r2 = 0;
        NL_INTEGER n = 0;
        int flag = N_SolveQuadraticEq(q[0], q[1], q[2], &r1, &r2, &n);
        std::vector<double> v{double(flag), double(n)};
        if (n > 0) v.insert(v.end(), {r1, r2});
        put("quadratic." + std::to_string(k++), v);
    }
}

void fit_cases()
{
    std::vector<NL_POINT> P;
    Lcg g{11};
    for (int i = 0; i < 12; i++) {
        double u = g.next() * 5, v = g.next() * 5;
        P.push_back({u, v, 0.3 * u - 0.2 * v + 1.5 + 1e-3 * g.next()});
    }
    double a = 0, b = 0, c = 0, d = 0;
    put("plane.flag", {double(N_FitPlanePts(P.data(), NL_INDEX(P.size() - 1), &a, &b, &c, &d))});
    std::vector<double> plane = signless({a, b, c});
    double s = plane[0] * a + plane[1] * b + plane[2] * c > 0 ? 1.0 : -1.0;
    plane.push_back(s * d);
    put("plane", plane);
    std::vector<NL_POINT> L;
    for (int i = 0; i < 10; i++) {
        double t = i * 0.7 - 2;
        L.push_back({1 + 2 * t + 1e-3 * g.next(), -1 + 0.5 * t + 1e-3 * g.next(), 3 - t + 1e-3 * g.next()});
    }
    NL_POINT q;
    NL_VECTOR v;
    put("line.flag", {double(N_LineFit3dPts(L.data(), NL_INDEX(L.size() - 1), &q, &v))});
    put("line.direction", signless({v.x, v.y, v.z}));
    // the point on the line nearest the origin, which does not depend on where along it the fit put q
    double len = std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z), dot = (q.x * v.x + q.y * v.y + q.z * v.z) / (len * len);
    put("line.nearest", {q.x - dot * v.x, q.y - dot * v.y, q.z - dot * v.z});
    Rows R(3, 3), RI(3, 3);
    double r[9] = {4, 1, 2, 1, 3, 0.5, 2, 0.5, 5};
    for (int i = 0; i < 9; i++) R.p()[i / 3][i % 3] = r[i];
    int flag = N_Real2dArrayInverseSVD(R.p(), 2, RI.p());
    put("inverse", {double(flag), RI.p()[0][0], RI.p()[0][1], RI.p()[0][2], RI.p()[1][0], RI.p()[1][1], RI.p()[1][2],
                    RI.p()[2][0], RI.p()[2][1], RI.p()[2][2]});
}

// a box and a cylinder through a transform with a reflection, the way a mirror would go
void transform_cases()
{
    double mirror[4][4] = {{-1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {10, 0, 0, 1}};
    double skewed[4][4] = {{1, 0.2, 0, 0}, {0, -1, 0, 0}, {0, 0, 2, 0}, {0, 0, 0, 1}};
    int k = 0;
    for (auto* m : {mirror, skewed}) {
        for (int shape = 0; shape < 2; shape++) {
            SmBrep* b = nullptr;
            if (shape == 0) SmApiCreateBox(SmVector3d(1, 2, 3), 4, 5, 6, b);
            else SmApiCreateCylinder(SmVector3d(0, 0, 0), 2, 5, b);
            std::string tag = "transform." + std::to_string(k) + "." + std::to_string(shape);
            int st = b ? int(b->Transform(m, TRUE)) : -1;
            SmBoolean man = FALSE;
            double vol = 0;
            SmPoint3d lo, hi;
            if (b) {
                SmApiBrepIsManifoldSolid(b, man);
                SmApiBrepComputeVolume(b, 1e-6, vol);
                SmApiBrepBoundingBox(b, TRUE, lo, hi);
            }
            put(tag, {double(st), double(man), std::fabs(vol), lo.x, lo.y, lo.z, hi.x, hi.y, hi.z});
            delete b;
        }
        k++;
    }
}


// LU on a square matrix, then the solves that use it: LUDecompose and SolveWithLUMatrix directly, and through
// SolveLinearSystem and Invert
void lu_case(const std::string& tag, int n, const std::vector<double>& a)
{
    SmMatrix m(n, n);
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++) m.SetAt(i, j, a[size_t(i) * n + j]);
    SmMatrix lu(m);
    std::vector<ULONG> idx(n + 1, 0);
    SmStatus st = lu.LUDecompose(idx.data());
    std::vector<double> v{double(st)};
    if (st != SM_ERR) {
        for (int i = 0; i < n; i++) v.push_back(double(idx[i]));
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++) v.push_back(lu.GetAt(i, j));
    }
    put("lu." + tag, v);
    SmTArray<double> b;
    b.SetSize(n);
    for (int i = 0; i < n; i++) b[i] = i + 1.5;
    if (st != SM_ERR) {
        SmTArray<double> x;
        x.SetSize(n);
        v = {double(lu.SolveWithLUMatrix(idx.data(), b, x))};
        for (int i = 0; i < n; i++) v.push_back(x[i]);
        put("lu." + tag + ".solve", v);
        SmTArray<double> c(b);
        v = {double(lu.SolveWithLUMatrix(idx.data(), c, c))};
        for (int i = 0; i < n; i++) v.push_back(c[i]);
        put("lu." + tag + ".alias", v);
    }
    SmTArray<double> x;
    v = {double(m.SolveLinearSystem(b, x))};
    if (v[0] != SM_ERR)
        for (int i = 0; i < n; i++) v.push_back(x[i]);
    put("lu." + tag + ".system", v);
    SmMatrix inv(m);
    v = {double(inv.Invert())};
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++) v.push_back(inv.GetAt(i, j));
    put("lu." + tag + ".invert", v);
}

void lu_cases()
{
    // pivoting, ties (the last row wins), rows and pivots at the SM_EFF_ZERO threshold, singular matrices
    lu_case("pivot", 2, {1, 2, 3, 4});
    lu_case("rowscale", 2, {2, 1000, 1, 1});
    lu_case("three", 3, {2, 1, 1, 4, -6, 0, -2, 7, 2});
    lu_case("four", 4, {0, 2, 0, 1, 2, 2, 3, 2, 4, -3, 0, 1, 6, 1, -6, -5});
    lu_case("tie", 2, {2, 1, 2, 1.5});
    lu_case("tie3", 3, {1, 0, 0, 1, 0, 0, 1, 1, 1});
    lu_case("scalechoice", 3, {1, 1, 1, 1, 1.001, 100, 1, 2, 0});
    lu_case("neg", 3, {-3, 1, -1, 2, -4, 1, 1, -1, -5});
    lu_case("zerocol", 2, {0, 1, 0, 2});
    lu_case("rank1", 2, {1, 2, 2, 4});
    lu_case("rank2", 3, {1, 2, 3, 4, 5, 6, 7, 8, 9});
    lu_case("negpivot", 3, {1, 1, 5, 1, 1 + 1e-14, 0, 0, 0, 1});
    std::pair<const char*, double> pivots[] = {{"at", 1e-12},       {"below", std::nextafter(1e-12, 0.0)},
                                               {"negat", -1e-12},   {"negbelow", std::nextafter(-1e-12, 0.0)},
                                               {"tiny", 1e-14},     {"negtiny", -1e-14},
                                               {"zero", 0.0}};
    for (auto& p : pivots) lu_case(std::string("pivot.") + p.first, 3, {1, 0, 0, 0, p.second, 1, 0, 0, 1});
    for (int k : {2, 6, 10, 14, 16}) {
        double e = std::pow(10.0, -k);
        lu_case("near" + std::to_string(k), 2, {1, 1, 1, 1 + e});
        lu_case("nearbig" + std::to_string(k), 2, {1e6, 1e6, 1e6, 1e6 * (1 + e)});
    }
    lu_case("zerorow", 2, {1, 2, 0, 0});
    lu_case("rowmax", 2, {1, 2, 1e-12, 0.5e-12});
    lu_case("rowbelow", 2, {1, 2, std::nextafter(1e-12, 0.0), 0});
    lu_case("one", 1, {5});
    lu_case("onezero", 1, {0});
    Lcg g{13};
    for (int k = 0; k < 30; k++) {
        int n = 1 + k % 8;
        std::vector<double> a(size_t(n) * n);
        for (int i = 0; i < n; i++) {
            double scale = std::pow(10.0, std::floor(g.next() * 6));
            for (int j = 0; j < n; j++) a[size_t(i) * n + j] = scale * g.next();
        }
        lu_case("random" + std::to_string(k), n, a);
    }
    SmMatrix wide(2, 3);
    ULONG idx[4];
    put("lu.wide", {double(wide.LUDecompose(idx))});
}

// what an accuracy case gives when the routine fails
const double kFailed = 1e300;

struct Quad : SmIntegFuncEvalObj {
    std::function<double(double)> f;
    SmStatus Evaluate(double t, double& r) const override
    {
        r = f(t);
        return SM_SUCCESS;
    }
};

// exposes the steps the kernel keeps protected
struct Steps : SmIntegrator {
    using SmIntegrator::SmIntegrator;
    SmStatus trapezoid(double a, double b, ULONG n, double& r) { return Trapazoid(a, b, n, r); }
};

// y' for a system with the kernel's arrays, which run from 1: quadratures, decay and an oscillator
struct System : SmODEIntegFuncEvalObj {
    int kind;
    explicit System(int k) : kind(k) {}
    SmStatus Evaluate(double x, SmTArray<double>& y, SmTArray<double>& d) const override
    {
        if (kind == 0) d[1] = std::cos(x), d[2] = x * x;
        else if (kind == 1) d[1] = -2 * y[1], d[2] = y[1];
        else if (kind == 2) d[1] = y[2], d[2] = -y[1];
        else d[1] = std::cos(x), d[2] = std::cos(40 * x);
        return SM_SUCCESS;
    }
};

double off(double got, double exact)
{
    return std::fabs(got - exact) / std::max(std::fabs(exact), 1e-300);
}

void integrator_cases()
{
    struct F {
        const char* name;
        std::function<double(double)> f;
        double a, b, exact;
    };
    std::vector<F> fs{{"exp", [](double x) { return std::exp(x); }, 0, 1, std::exp(1.0) - 1},
                      {"x4", [](double x) { return x * x * x * x; }, 0, 2, 32.0 / 5},
                      {"sin", [](double x) { return std::sin(x); }, 0, M_PI, 2},
                      {"runge", [](double x) { return 1 / (1 + x * x); }, -5, 5, 2 * std::atan(5.0)},
                      {"reversed", [](double x) { return std::exp(x); }, 1, 0, 1 - std::exp(1.0)},
                      {"large", [](double x) { return 1e6 * std::cos(x); }, 0, 1, 1e6 * std::sin(1.0)}};
    for (auto& c : fs)
        for (double eps : {1e-6, 1e-9}) {
            Quad q;
            q.f = c.f;
            SmIntegrator in(q);
            double r = 0;
            SmStatus st = in.IntegrateIt(c.a, c.b, SM_IA_ROMBERG, eps, r);
            put(std::string("accuracy.integrate.") + c.name + "." + std::to_string(int(-std::log10(eps))),
                {st == SM_SUCCESS ? off(r, c.exact) / eps : kFailed});
        }
    {
        Quad q;
        q.f = [](double x) { return std::exp(x); };
        Steps in(q);
        std::vector<double> v;
        for (ULONG k = 1; k <= 6; k++) {
            double r = 0;
            in.trapezoid(0, 1, k, r);
            v.push_back(r);
        }
        put("trapezoid", v);
        double xa[7] = {-10, 0, 1, 2, 3, 4, 50}, ya[7] = {-99, 1, 3, 2, 5, 4, 77};
        for (ULONG n = 1; n <= 5; n++)
            for (double x : {1.5, 2.7, -0.5, 3.0}) {
                double y = 0, dy = 0;
                SmStatus st = in.PolynomialInterpolation(xa, ya, n, x, y, dy);
                put("interpolate." + std::to_string(n) + "." + std::to_string(int(x * 10)), {double(st), y});
            }
    }
    // the driver; a scale of 1e300 leaves a value out of the error control
    struct O {
        const char* name;
        int kind;
        double x1, x2, h1, y1, y2, s1, s2, exact1, exact2;
    };
    std::vector<O> os{{"quadrature", 0, 0, 2, 1, 0, 0, 1, 1, std::sin(2.0), 8.0 / 3},
                      {"reversed", 0, 2, 0, 1, 0, 0, 1, 1, -std::sin(2.0), -8.0 / 3},
                      {"decay", 1, 0, 3, 0.5, 1, 0, 1, 1, std::exp(-6.0), (1 - std::exp(-6.0)) / 2},
                      {"oscillator", 2, 0, 10, 0.1, 1, 0, 1, 1, std::cos(10.0), -std::sin(10.0)},
                      {"second", 3, 0, 3, 1, 0, 0, 1e300, 1, std::sin(3.0), std::sin(120.0) / 40}};
    for (auto& c : os)
        for (double eps : {1e-6, 1e-9}) {
            System sys(c.kind);
            SmODEIntegrator in(sys);
            SmTArray<double> y, sc;
            y.SetSize(2);
            sc.SetSize(2);
            y[0] = c.y1, y[1] = c.y2, sc[0] = c.s1, sc[1] = c.s2;
            ULONG ok = 0, bad = 0;
            SmStatus st = in.RungeKuttaODEIntegrate(y, c.x1, c.x2, eps, c.h1, 0, ok, bad, &sc);
            // (the kernel's original starts from zero whatever ystart holds, so it fails decay and oscillator)
            std::vector<double> v;
            if (c.s1 < 1e300) v.push_back(st == SM_SUCCESS ? std::fabs(y[0] - c.exact1) / eps : kFailed);
            v.push_back(st == SM_SUCCESS ? std::fabs(y[1] - c.exact2) / eps : kFailed);
            put(std::string("accuracy.ode.") + c.name + "." + std::to_string(int(-std::log10(eps))), v);
        }
    // single steps on the oscillator from (1, 0.5), whose exact solution turns the point through the angle
    System sys(2);
    SmODEIntegrator in(sys);
    {
        // the original sizes its work arrays in the driver
        SmTArray<double> y0;
        y0.SetSize(2);
        ULONG a = 0, b = 0;
        in.RungeKuttaODEIntegrate(y0, 0, 1, 1e-6, 0.5, 0, a, b, nullptr);
    }
    SmTArray<double> y, d, o, e;
    y.SetSize(3), d.SetSize(3), o.SetSize(3), e.SetSize(3);
    y[0] = 0, y[1] = 1, y[2] = 0.5;
    sys.Evaluate(0.3, y, d);
    in.RungeKuttaAdvance(y, d, 0.3, 0.2, o);
    put("ode.rk4", {o[1], o[2]});
    in.RungeKuttaCashKarpAdvance(y, d, 0.3, 0.2, o, e);
    put("ode.cashkarp", {o[1], o[2], e[1], e[2]});
    for (ULONG ns : {1u, 2u, 4u, 7u}) {
        SmStatus st = in.ModifiedMidpointStep(y, d, 0.3, 0.2, ns, o);
        put("ode.midpoint." + std::to_string(ns), {double(st), o[1], o[2]});
    }
    auto turned = [](double t, double& a, double& b) {
        a = std::cos(t) + 0.5 * std::sin(t), b = -std::sin(t) + 0.5 * std::cos(t);
    };
    for (double eps : {1e-3, 1e-8}) {
        SmTArray<double> sc;
        sc.SetSize(3);
        sc[1] = sc[2] = 1;
        for (int bs = 0; bs < 2; bs++) {
            SmTArray<double> yy(y);
            double x = 0.3, hd = 0, hn = 0, a, b;
            SmStatus st = bs ? in.BulirschStoerStep(yy, d, x, 0.5, eps, sc, hd, hn)
                             : in.RungeKutta5thOrderStep(yy, d, x, 0.5, eps, sc, hd, hn);
            turned(x - 0.3, a, b);
            put(std::string("accuracy.ode.") + (bs ? "extrapolation." : "step.") + std::to_string(int(-std::log10(eps))),
                {st == SM_SUCCESS && hd > 0 && std::fabs(x - 0.3 - hd) < 1e-15 && hn > 0
                     ? std::max(std::fabs(yy[1] - a), std::fabs(yy[2] - b)) / eps
                     : kFailed});
        }
    }
}

// volumes and areas, which the kernel integrates with the Runge-Kutta driver
void property_cases()
{
    struct S {
        const char* name;
        int shape;
        double volume, area;
    };
    for (S c : {S{"sphere", 0, 36 * M_PI, 36 * M_PI}, S{"cone", 1, 7 * M_PI, M_PI * (5 + 3 * std::sqrt(10.0))},
                S{"torus", 2, 10 * M_PI * M_PI, 20 * M_PI * M_PI}, S{"cylinder", 3, 20 * M_PI, 28 * M_PI}}) {
        SmBrep* b = nullptr;
        if (c.shape == 0) SmApiCreateSphere(SmVector3d(1, 2, 3), 3, b);
        else if (c.shape == 1) SmApiCreateCone(SmVector3d(0, 0, 0), 2, 1, 3, b);
        else if (c.shape == 2) SmApiCreateTorus(SmVector3d(0, 0, 0), 5, 1, b);
        else SmApiCreateCylinder(SmVector3d(0, 0, 0), 2, 5, b);
        for (double eps : {1e-4, 1e-6, 1e-8}) {
            double vol = 0;
            bool ok = b && SmApiBrepComputeVolume(b, eps, vol) == SM_SUCCESS;
            put(std::string("accuracy.volume.") + c.name + "." + std::to_string(int(-std::log10(eps))),
                {ok ? off(std::fabs(vol), c.volume) / eps : kFailed});
        }
        double area = 0;
        bool ok = b && SmApiBrepComputeArea(b, 1e-4, area) == SM_SUCCESS;
        put(std::string("accuracy.area.") + c.name, {ok ? off(area, c.area) / 1e-4 : kFailed});
        delete b;
    }
}

} // namespace

extern "C" char* sx_brep_routine_probe()
{
    SmApiGetOrCreateContext();
    out = Value::object();
    svd_cases();
    eigen_cases();
    tridiagonal_cases();
    minimum_cases();
    quadratic_cases();
    fit_cases();
    transform_cases();
    lu_cases();
    integrator_cases();
    property_cases();
    std::string s = sxj::dump(out);
    char* text = static_cast<char*>(std::malloc(s.size() + 1));
    if (text) std::memcpy(text, s.c_str(), s.size() + 1);
    return text;
}
